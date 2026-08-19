/**
 * Part A2/A3 — dual-run comparison and decision policy.
 *
 * Both rule-based classifiers keep running on every eligible message and the
 * rule-based graduation intent always decides what happens next for the user.
 * Claude is being evaluated here, not trusted: its label is recorded for
 * offline analysis and surfaced in the debug panel, and nothing else.
 *
 * Every outcome is logged with an explicit route label — there is no silent
 * path through this module.
 */

import type { ClassifierFailureReason, ClassifierOutcome, ClaudeClassification } from "./claude-classifier.js";
import type { GraduationIntentName } from "./claude-config.js";

export type NluRoute =
  | "rule_based_only"
  | "rule_based_and_claude_agreement"
  | "rule_based_and_claude_disagreement"
  | "claude_classifier_failed";

export interface RuleBasedClassification {
  /** The 8-intent label from `classifyGraduationIntent`. Authoritative. */
  graduationIntent: GraduationIntentName;
  /**
   * The coarser 5-outcome label from `RuleBasedExpandedAgentPlanner`, recorded
   * separately for observability. It is NOT comparable one-to-one with the
   * eight graduation intents and never participates in the agreement rate.
   */
  expandedPlannerIntent: string | null;
}

export interface NluArbitration {
  route: NluRoute;
  /** The label the rest of the pipeline uses. Always the rule-based one. */
  effectiveIntent: GraduationIntentName;
  ruleBased: RuleBasedClassification;
  claude: ClaudeClassification | null;
  claudeModel: string | null;
  claudeLatencyMs: number | null;
  claudeFailureReason: ClassifierFailureReason | null;
  claudeFailureDetail: string | null;
  agreed: boolean | null;
}

export interface NluArbitrationLogFields {
  event: "nutriguard_nlu_arbitration";
  route: NluRoute;
  ruleBasedIntent: string;
  expandedPlannerIntent: string;
  claudeIntent: string;
  claudeConfidence: number | null;
  claudeModel: string;
  claudeLatencyMs: number | null;
  claudeFailureReason: string;
  claudeFailureDetail: string;
  /**
   * Claude's full JSON, required by A3 for later offline analysis of
   * disagreements. It contains intent labels plus entity strings the user
   * typed; it is emitted only on disagreement.
   */
  claudeFullOutput: string;
}

/**
 * Extract the plan intent from `RuleBasedExpandedAgentPlanner.plan()`, whose
 * declared return type is `unknown`.
 */
export function expandedPlannerIntentOf(plan: unknown): string | null {
  if (typeof plan !== "object" || plan === null) return null;
  const intent = (plan as { intent?: unknown }).intent;
  return typeof intent === "string" && intent.trim() !== "" ? intent : null;
}

/**
 * Apply the A3 decision policy.
 *
 * Agreement, disagreement and failure all resolve to the same effective
 * intent — the rule-based one — so Claude cannot change user-visible routing
 * in this step. Only the recorded route label differs.
 */
export function arbitrateNlu(ruleBased: RuleBasedClassification, outcome: ClassifierOutcome | null): NluArbitration {
  const base = {
    effectiveIntent: ruleBased.graduationIntent,
    ruleBased,
  } as const;
  if (outcome === null) {
    return {
      ...base,
      route: "rule_based_only",
      claude: null,
      claudeModel: null,
      claudeLatencyMs: null,
      claudeFailureReason: null,
      claudeFailureDetail: null,
      agreed: null,
    };
  }
  if (!outcome.ok) {
    return {
      ...base,
      route: "claude_classifier_failed",
      claude: null,
      claudeModel: outcome.model,
      claudeLatencyMs: outcome.latencyMs,
      claudeFailureReason: outcome.failureReason,
      claudeFailureDetail: outcome.detail,
      agreed: null,
    };
  }
  const agreed = outcome.classification.intent === ruleBased.graduationIntent;
  return {
    ...base,
    route: agreed ? "rule_based_and_claude_agreement" : "rule_based_and_claude_disagreement",
    claude: outcome.classification,
    claudeModel: outcome.model,
    claudeLatencyMs: outcome.latencyMs,
    claudeFailureReason: null,
    claudeFailureDetail: null,
    agreed,
  };
}

/**
 * Build the log payload for one arbitration.
 *
 * The raw user message is never included. Claude's full JSON is attached only
 * for disagreements, which is exactly what A3 requires for offline analysis.
 */
export function arbitrationLogFields(arbitration: NluArbitration): NluArbitrationLogFields {
  return {
    event: "nutriguard_nlu_arbitration",
    route: arbitration.route,
    ruleBasedIntent: arbitration.ruleBased.graduationIntent,
    expandedPlannerIntent: arbitration.ruleBased.expandedPlannerIntent ?? "none",
    claudeIntent: arbitration.claude?.intent ?? "none",
    claudeConfidence: arbitration.claude?.confidence ?? null,
    claudeModel: arbitration.claudeModel ?? "none",
    claudeLatencyMs: arbitration.claudeLatencyMs,
    claudeFailureReason: arbitration.claudeFailureReason ?? "none",
    claudeFailureDetail: arbitration.claudeFailureDetail ?? "none",
    claudeFullOutput: arbitration.route === "rule_based_and_claude_disagreement" && arbitration.claude
      ? JSON.stringify(arbitration.claude)
      : "none",
  };
}
