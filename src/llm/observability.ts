/**
 * Part C — observability for the Claude layer and the retrieval path.
 *
 * Trace records carry structural and technical data only: route labels,
 * booleans, model identifiers, and stage timings. By default they contain no
 * raw user message and no answer text, matching the project's existing
 * "no raw question logging" practice (C2).
 *
 * Raw message capture exists solely for the A4 regression harness and is gated
 * behind a separate, explicitly-scoped opt-in that the debug panel never sets.
 */

import { CLAUDE_LAYER_VERSION } from "./claude-config.js";
import type { NluRoute } from "./nlu-arbitration.js";

export type FormatterRoute =
  | "formatter_disabled"
  | "formatter_hard_disabled_medical_safety"
  | "formatter_intent_out_of_scope"
  | "formatter_used_validation_passed"
  | "formatter_used_validation_failed_template_fallback"
  | "formatter_call_failed_template_fallback";

export type RetrievalRoute =
  | "not_invoked"
  | "local_only"
  | "remote_embeddings_and_vector_store"
  | "remote_attempted_local_fallback";

export interface StageLatencies {
  embeddingCallMs: number | null;
  vectorSearchMs: number | null;
  localFallbackSearchMs: number | null;
  claudeClassifierMs: number | null;
  deterministicCalculationMs: number | null;
  claudeFormatterMs: number | null;
  groundingValidationMs: number | null;
  totalMs: number | null;
}

export type ReferenceResolutionOutcome =
  | "not_proposed"
  | "resolved_deterministically"
  | "skipped_explicit_recipe_named"
  | "skipped_comparison_continuation"
  | "accepted"
  | "rejected_outside_candidate_set"
  | "rejected_unknown_recipe";

export interface ClaudeRequestTrace {
  traceId: string;
  layerVersion: string;
  /** Structural label only; never the message text. */
  language: "ar-EG" | "ar" | "en";
  safetyRouted: boolean;
  safetyRouteReason: string | null;
  nluRoute: NluRoute;
  ruleBasedIntent: string;
  expandedPlannerIntent: string | null;
  claudeIntent: string | null;
  claudeConfidence: number | null;
  claudeIntentAgreed: boolean | null;
  classifierModel: string | null;
  classifierFailureReason: string | null;
  entityCandidatesTotal: number;
  entityCandidatesAccepted: number;
  entityCandidatesRejected: number;
  /** How a bare conversational recipe reference was resolved, if at all. */
  referenceResolution: ReferenceResolutionOutcome;
  referenceResolvedRecipeId: string | null;
  formatterRoute: FormatterRoute;
  formatterModel: string | null;
  formatterFailureReason: string | null;
  groundingPassed: boolean | null;
  groundingFailureCodes: string[];
  groundingViolationTokens: string[];
  retrievalRoute: RetrievalRoute;
  geminiEmbeddingsCalled: boolean;
  qdrantReturnedResult: boolean | null;
  localFallbackSearchUsed: boolean;
  latencies: StageLatencies;
  /**
   * Present only when the separate raw-message opt-in is enabled. The debug
   * panel never enables it.
   */
  rawMessage?: string;
  /** Rejected formatter output, retained for review of grounding failures. */
  rejectedFormatterOutput?: string;
  /** Structured facts supplied to a rejected formatter call. */
  rejectedFormatterFacts?: string;
}

export function emptyStageLatencies(): StageLatencies {
  return {
    embeddingCallMs: null,
    vectorSearchMs: null,
    localFallbackSearchMs: null,
    claudeClassifierMs: null,
    deterministicCalculationMs: null,
    claudeFormatterMs: null,
    groundingValidationMs: null,
    totalMs: null,
  };
}

/** A bounded ring buffer of recent traces, for the internal debug route. */
export class ClaudeObservabilityStore {
  private readonly records: ClaudeRequestTrace[] = [];

  public constructor(private readonly capacity: number = 50) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("observability capacity must be a positive integer");
  }

  public record(trace: ClaudeRequestTrace): void {
    this.records.push(trace);
    while (this.records.length > this.capacity) this.records.shift();
  }

  /** Most recent first. */
  public list(limit = this.capacity): ClaudeRequestTrace[] {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), this.capacity);
    return this.records.slice(-bounded).reverse().map((record) => structuredClone(record));
  }

  public latest(): ClaudeRequestTrace | null {
    const record = this.records.at(-1);
    return record ? structuredClone(record) : null;
  }

  public size(): number {
    return this.records.length;
  }

  public clear(): void {
    this.records.length = 0;
  }
}

/**
 * Strip every field that must never leave the process through Part C.
 *
 * Applied by the debug route regardless of how a trace was recorded, so an
 * accidentally-enabled raw-message opt-in still cannot leak through the panel.
 * The full-fidelity grounding-failure payloads live in the dedicated failure
 * sink instead, which is where B2d review happens.
 */
export function redactTraceForDebugPanel(trace: ClaudeRequestTrace): ClaudeRequestTrace {
  const {
    rawMessage: _rawMessage,
    rejectedFormatterOutput: _rejectedFormatterOutput,
    rejectedFormatterFacts: _rejectedFormatterFacts,
    ...rest
  } = structuredClone(trace);
  void _rawMessage;
  void _rejectedFormatterOutput;
  void _rejectedFormatterFacts;
  return rest;
}

export function newTrace(input: {
  traceId: string;
  language: "ar-EG" | "ar" | "en";
  ruleBasedIntent: string;
}): ClaudeRequestTrace {
  return {
    traceId: input.traceId,
    layerVersion: CLAUDE_LAYER_VERSION,
    language: input.language,
    safetyRouted: false,
    safetyRouteReason: null,
    nluRoute: "rule_based_only",
    ruleBasedIntent: input.ruleBasedIntent,
    expandedPlannerIntent: null,
    claudeIntent: null,
    claudeConfidence: null,
    claudeIntentAgreed: null,
    classifierModel: null,
    classifierFailureReason: null,
    entityCandidatesTotal: 0,
    entityCandidatesAccepted: 0,
    entityCandidatesRejected: 0,
    referenceResolution: "not_proposed",
    referenceResolvedRecipeId: null,
    formatterRoute: "formatter_disabled",
    formatterModel: null,
    formatterFailureReason: null,
    groundingPassed: null,
    groundingFailureCodes: [],
    groundingViolationTokens: [],
    retrievalRoute: "not_invoked",
    geminiEmbeddingsCalled: false,
    qdrantReturnedResult: null,
    localFallbackSearchUsed: false,
    latencies: emptyStageLatencies(),
  };
}
