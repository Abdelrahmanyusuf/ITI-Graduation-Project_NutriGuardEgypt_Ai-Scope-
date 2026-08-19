/**
 * Step 17b — orchestration for the narrowly-scoped Claude layer.
 *
 * Holds the two Claude stages, the configuration, the observability store and
 * the safety pre-screen. The agent calls into this module; this module never
 * calls back into the agent's routing, never computes a value, and never
 * decides what the user sees except by supplying prose that has already
 * cleared the grounding validator.
 */

import { classifyRequestIntegrity } from "../agent/request-integrity.js";
import { classifySafetyFlags } from "../agent/safety.js";
import type { StructuredLogger } from "../observability/logger.js";
import { ClaudeIntentClassifier, type ClassifierContextSummary, type ClassifierOutcome } from "./claude-classifier.js";
import {
  claudeClientFromEnv,
  type ClaudeMessagesClient,
} from "./claude-client.js";
import {
  formatterIntentDecision,
  loadClaudeLayerConfig,
  type ClaudeLayerConfig,
} from "./claude-config.js";
import {
  buildFormatterFacts,
  ClaudeResponseFormatter,
  type FormatterFacts,
  type FormatterOutcome,
} from "./claude-formatter.js";
import { validateClaudeEntities, type AgentEntityResolvers, type EntityValidationReport } from "./entity-validation.js";
import { validateGrounding, type GroundingResult } from "./grounding-validator.js";
import {
  arbitrateNlu,
  arbitrationLogFields,
  type NluArbitration,
  type RuleBasedClassification,
} from "./nlu-arbitration.js";
import { ClaudeObservabilityStore, type ClaudeRequestTrace, type FormatterRoute } from "./observability.js";

export interface GroundingFailureRecord {
  intent: string;
  model: string;
  failureCodes: string[];
  violationTokens: string[];
  /** Claude's rejected text, complete and untruncated. */
  rejectedOutput: string;
  /** The exact structured facts supplied for this response, untruncated. */
  structuredInput: Record<string, unknown>;
}

export interface ClaudeLayerDependencies {
  config?: ClaudeLayerConfig;
  classifierClient?: ClaudeMessagesClient | null;
  formatterClient?: ClaudeMessagesClient | null;
  store?: ClaudeObservabilityStore;
  logger?: StructuredLogger | null;
  /**
   * Full-fidelity sink for B2d review. The project's structured logger
   * truncates long strings, so grounding failures are also handed here intact.
   */
  onGroundingFailure?: (record: GroundingFailureRecord) => void;
}

export interface SafetyPreScreen {
  /** True when the request belongs to the fixed, rule-based safety path. */
  safetyRouted: boolean;
  reason: string | null;
}

export interface ClassificationStageResult {
  arbitration: NluArbitration;
  entityReport: EntityValidationReport | null;
  latencyMs: number | null;
}

export interface FormatterStageResult {
  route: FormatterRoute;
  /** Non-null only when grounding validation passed. */
  text: string | null;
  model: string | null;
  failureReason: string | null;
  grounding: GroundingResult | null;
  formatterLatencyMs: number | null;
  groundingLatencyMs: number | null;
  /** Retained for the failure log when validation rejected the output. */
  rejectedOutput: string | null;
  rejectedFacts: FormatterFacts | null;
}

/**
 * Determine whether a message belongs to the fixed safety path.
 *
 * Invariant I4 requires medical_safety, emergency routing and
 * diagnosis/medication refusals to remain entirely Claude-free. That
 * requirement outranks Part A2's "run both classifiers on every message", so
 * this screen runs first and suppresses every Claude call when it trips.
 */
export function safetyPreScreen(message: string, ruleBasedIntent: string): SafetyPreScreen {
  if (ruleBasedIntent === "medical_safety") return { safetyRouted: true, reason: "rule_based_intent_medical_safety" };
  const safetyFlags = classifySafetyFlags(message);
  if (safetyFlags.length > 0) return { safetyRouted: true, reason: `safety_flag_${safetyFlags[0]}` };
  const integrityFlags = classifyRequestIntegrity(message);
  if (integrityFlags.length > 0) return { safetyRouted: true, reason: `integrity_flag_${integrityFlags[0]}` };
  return { safetyRouted: false, reason: null };
}

export class ClaudeLayer {
  public readonly config: ClaudeLayerConfig;
  public readonly store: ClaudeObservabilityStore;
  private readonly classifier: ClaudeIntentClassifier | null;
  private readonly formatter: ClaudeResponseFormatter | null;
  private readonly logger: StructuredLogger | null;
  private readonly onGroundingFailure: ((record: GroundingFailureRecord) => void) | null;

  public constructor(dependencies: ClaudeLayerDependencies = {}) {
    this.config = dependencies.config ?? loadClaudeLayerConfig();
    this.store = dependencies.store ?? new ClaudeObservabilityStore(this.config.traceBufferSize);
    this.logger = dependencies.logger ?? null;
    this.onGroundingFailure = dependencies.onGroundingFailure ?? null;
    const classifierClient = dependencies.classifierClient === undefined
      ? claudeClientFromEnv(this.config.classifierModel, this.config.classifierTimeoutMs)
      : dependencies.classifierClient;
    const formatterClient = dependencies.formatterClient === undefined
      ? claudeClientFromEnv(this.config.formatterModel, this.config.formatterTimeoutMs)
      : dependencies.formatterClient;
    this.classifier = this.config.classifierEnabled && classifierClient ? new ClaudeIntentClassifier(classifierClient) : null;
    this.formatter = this.config.formatterEnabled && formatterClient ? new ClaudeResponseFormatter(formatterClient) : null;
    // A stage timeout larger than the request budget would let the HTTP layer
    // time out before the deterministic fallback could answer, surfacing a 500
    // instead of a correct reply. The clamp prevents that; the warning makes the
    // misconfiguration visible instead of silently degrading the formatter.
    if (this.config.stageTimeoutsClamped && this.active) {
      this.log("warn", "nutriguard_claude_stage_timeouts_clamped", {
        requestBudgetMs: this.config.requestBudgetMs,
        requestedClassifierTimeoutMs: this.config.requestedClassifierTimeoutMs,
        requestedFormatterTimeoutMs: this.config.requestedFormatterTimeoutMs,
        effectiveClassifierTimeoutMs: this.config.classifierTimeoutMs,
        effectiveFormatterTimeoutMs: this.config.formatterTimeoutMs,
        reason: "configured stage timeouts exceeded the request budget minus the deterministic reserve",
      });
    }
  }

  /** True when at least one stage can actually run. */
  public get active(): boolean {
    return this.classifier !== null || this.formatter !== null;
  }

  /**
   * True when per-request traces should be captured.
   *
   * Enabling the debug panel is sufficient: the Part C retrieval reporting —
   * external embeddings, vector store, local fallback — is useful even when no
   * Claude credentials are configured, and closing that observability gap was
   * an explicit requirement.
   */
  public get tracingEnabled(): boolean {
    return this.active || this.config.debugPanelEnabled;
  }

  public get classifierActive(): boolean {
    return this.classifier !== null;
  }

  public get formatterActive(): boolean {
    return this.formatter !== null;
  }

  public get classifierModel(): string | null {
    return this.classifier?.model ?? null;
  }

  public get formatterModel(): string | null {
    return this.formatter?.model ?? null;
  }

  /**
   * Part A2/A3 — run the advisory classifier and arbitrate.
   *
   * The returned `arbitration.effectiveIntent` is always the rule-based label.
   */
  public async classificationStage(input: {
    message: string;
    language: "ar-EG" | "ar" | "en";
    context: ClassifierContextSummary | null;
    ruleBased: RuleBasedClassification;
    resolvers: AgentEntityResolvers;
  }): Promise<ClassificationStageResult> {
    if (!this.classifier) {
      const arbitration = arbitrateNlu(input.ruleBased, null);
      this.logArbitration(arbitration);
      return { arbitration, entityReport: null, latencyMs: null };
    }
    const outcome: ClassifierOutcome = await this.classifier.classify({
      message: input.message,
      language: input.language,
      context: input.context,
    });
    const arbitration = arbitrateNlu(input.ruleBased, outcome);
    this.logArbitration(arbitration);
    // A5: every Claude entity is independently resolved against real data
    // before anything downstream may consider it.
    const entityReport = arbitration.claude
      ? await validateClaudeEntities(arbitration.claude, input.resolvers)
      : null;
    if (entityReport) this.logEntityValidation(entityReport);
    return { arbitration, entityReport, latencyMs: outcome.latencyMs };
  }

  /**
   * Part B — rephrase an already-computed deterministic answer.
   *
   * Returns `text: null` for every rejection path, and the caller must then
   * emit the unchanged deterministic template.
   */
  public async formatterStage(input: {
    intent: string;
    language: "ar-EG" | "ar" | "en";
    deterministicText: string;
    data: Record<string, unknown> | null;
    knownEntityVocabulary: readonly string[];
  }): Promise<FormatterStageResult> {
    const empty: FormatterStageResult = {
      route: "formatter_disabled",
      text: null,
      model: null,
      failureReason: null,
      grounding: null,
      formatterLatencyMs: null,
      groundingLatencyMs: null,
      rejectedOutput: null,
      rejectedFacts: null,
    };
    const decision = formatterIntentDecision(this.config, input.intent);
    if (!decision.allowed) {
      return {
        ...empty,
        route: decision.reason === "hard_disabled_medical_safety"
          ? "formatter_hard_disabled_medical_safety"
          : decision.reason === "intent_out_of_formatter_scope"
            ? "formatter_intent_out_of_scope"
            : "formatter_disabled",
      };
    }
    if (!this.formatter || !input.data) return empty;

    const facts = buildFormatterFacts({
      intent: input.intent,
      language: input.language,
      deterministicText: input.deterministicText,
      data: input.data,
    });
    const outcome: FormatterOutcome = await this.formatter.format(facts);
    if (!outcome.ok) {
      this.log("warn", "nutriguard_claude_formatter_failed", {
        intent: input.intent,
        model: outcome.model,
        failureReason: outcome.failureReason,
        detail: outcome.detail,
        latencyMs: outcome.latencyMs,
      });
      return {
        ...empty,
        route: "formatter_call_failed_template_fallback",
        model: outcome.model,
        failureReason: outcome.failureReason,
        formatterLatencyMs: outcome.latencyMs,
      };
    }

    const groundingStartedAt = performance.now();
    const grounding = validateGrounding({
      text: outcome.text,
      facts: facts.values,
      referenceText: facts.deterministicText,
      allowedEntityNames: [...facts.allowedEntityNames, ...facts.listItemOrdinals.map(String)],
      knownEntityVocabulary: input.knownEntityVocabulary,
      toleranceAbsolute: this.config.groundingToleranceAbsolute,
    });
    const groundingLatencyMs = Math.round(performance.now() - groundingStartedAt);

    if (!grounding.passed) {
      // I5: unverifiable output must never reach the user. Both payloads are
      // preserved so a reviewer can see exactly what was rejected and why.
      const failureCodes = grounding.violations.map((violation) => violation.code);
      const violationTokens = grounding.violations.map((violation) => violation.token);
      this.onGroundingFailure?.({
        intent: input.intent,
        model: outcome.model,
        failureCodes,
        violationTokens,
        rejectedOutput: outcome.text,
        structuredInput: facts.values,
      });
      this.log("warn", "nutriguard_claude_grounding_rejected", {
        intent: input.intent,
        model: outcome.model,
        failureCodes: failureCodes.join(","),
        violationTokens: violationTokens.join("|"),
      });
      return {
        ...empty,
        route: "formatter_used_validation_failed_template_fallback",
        model: outcome.model,
        grounding,
        formatterLatencyMs: outcome.latencyMs,
        groundingLatencyMs,
        rejectedOutput: outcome.text,
        rejectedFacts: facts,
      };
    }

    this.log("info", "nutriguard_claude_grounding_passed", {
      intent: input.intent,
      model: outcome.model,
      numbersChecked: grounding.extractedNumbers.length,
      latencyMs: outcome.latencyMs,
    });
    return {
      ...empty,
      route: "formatter_used_validation_passed",
      text: outcome.text,
      model: outcome.model,
      grounding,
      formatterLatencyMs: outcome.latencyMs,
      groundingLatencyMs,
    };
  }

  public recordTrace(trace: ClaudeRequestTrace): void {
    this.store.record(trace);
    this.log("info", "nutriguard_claude_request_trace", {
      traceId: trace.traceId,
      nluRoute: trace.nluRoute,
      formatterRoute: trace.formatterRoute,
      ruleBasedIntent: trace.ruleBasedIntent,
      claudeIntent: trace.claudeIntent ?? "none",
      groundingPassed: trace.groundingPassed,
      retrievalRoute: trace.retrievalRoute,
      totalMs: trace.latencies.totalMs,
    });
  }

  private logArbitration(arbitration: NluArbitration): void {
    const fields = arbitrationLogFields(arbitration);
    const { event, ...rest } = fields;
    this.log(arbitration.route === "claude_classifier_failed" ? "warn" : "info", event, rest);
  }

  private logEntityValidation(report: EntityValidationReport): void {
    if (report.records.length === 0) return;
    this.log("info", "nutriguard_claude_entity_validation", {
      total: report.records.length,
      accepted: report.acceptedCount,
      rejected: report.rejectedCount,
      rejectedCandidates: report.records.filter((record) => !record.accepted).map((record) => record.candidate).join("|"),
    });
  }

  private log(level: "info" | "warn", event: string, fields: Record<string, string | number | boolean | null | undefined>): void {
    this.logger?.log(level, event, fields);
  }
}

export { buildFormatterFacts };
