/**
 * Step 17b configuration for the narrowly-scoped Claude layer.
 *
 * The Claude layer has exactly two jobs and no others:
 *   1. advisory intent/entity classification that cross-checks the rule-based
 *      classifiers but never decides routing (Part A);
 *   2. phrasing of already-computed deterministic facts (Part B).
 *
 * It never performs arithmetic, never supplies a fact, and never holds
 * authority over a write action. Nothing in this file can grant those powers.
 */

/** Version of the Claude layer contract, reported in observability traces. */
export const CLAUDE_LAYER_VERSION = "17b.2.0";

/**
 * Time reserved inside the HTTP request budget for everything that is not a
 * Claude call: the deterministic calculation, retrieval (which may reach an
 * external embedding provider and vector store), grounding validation and
 * serialization.
 *
 * Stage timeouts are clamped so that the deterministic fallback always has room
 * to answer. Without this, a generous per-stage timeout silently exceeds the
 * server's request timeout and the user receives a 500 instead of the correct
 * deterministic answer.
 */
export const NON_LLM_TIME_RESERVE_MS = 5_000;

/** The eight rule-based intents produced by `classifyGraduationIntent`. */
export const GRADUATION_INTENTS = [
  "find_recipe",
  "recipe_nutrition",
  "ingredient_nutrition",
  "compare_recipes",
  "general_guideline",
  "lighter_modification",
  "unsupported",
  "medical_safety",
] as const;

export type GraduationIntentName = (typeof GRADUATION_INTENTS)[number];

/**
 * Intents whose user-facing copy may never be rephrased by Claude.
 *
 * `medical_safety` is hard-disabled by invariant I4: emergency routing and
 * diagnosis/medication refusal text stay fixed, reviewed and Claude-free. This
 * is not a default that configuration can flip — see `formatterIntentDecision`.
 */
export const FORMATTER_HARD_DISABLED_INTENTS: ReadonlySet<string> = new Set(["medical_safety"]);

/**
 * Intents whose underlying data is fully computed deterministically before any
 * formatting happens, and which are therefore eligible for Part B (B3).
 */
export const FORMATTER_ELIGIBLE_INTENTS = [
  "recipe_nutrition",
  "ingredient_nutrition",
  "compare_recipes",
  "lighter_modification",
  "find_recipe",
  "general_guideline",
  "meal_plan",
] as const;

export type FormatterIntentName = (typeof FORMATTER_ELIGIBLE_INTENTS)[number];

export type FormatterIntentDecision =
  | { allowed: true; reason: "enabled_by_config" }
  | { allowed: false; reason: "hard_disabled_medical_safety" | "intent_out_of_formatter_scope" | "disabled_by_config" };

/**
 * Documented display-rounding tolerance for the grounding validator.
 *
 * A number in Claude's prose is traceable when it lies within this absolute
 * distance of a number in the structured input. 0.05 is exactly the error
 * introduced by rounding to one decimal place, so `99.63 -> 99.6` passes while
 * a materially different value such as `99.6 -> 120` fails.
 */
export const DISPLAY_ROUNDING_TOLERANCE = 0.05;

export interface ClaudeLayerConfig {
  /** Part A: run the advisory Claude classifier alongside the rule-based ones. */
  classifierEnabled: boolean;
  /** Part B: allow Claude to rephrase already-computed deterministic facts. */
  formatterEnabled: boolean;
  /** Model identifier for the classifier stage. Required when enabled. */
  classifierModel: string | null;
  /** Model identifier for the formatter stage. Required when enabled. */
  formatterModel: string | null;
  classifierTimeoutMs: number;
  formatterTimeoutMs: number;
  /**
   * Total server-side budget for one request, mirroring the HTTP layer's
   * request timeout. Stage timeouts are clamped to fit inside it.
   */
  requestBudgetMs: number;
  /** True when the configured stage timeouts had to be reduced to fit. */
  stageTimeoutsClamped: boolean;
  /** The originally requested values, for an honest warning log. */
  requestedClassifierTimeoutMs: number;
  requestedFormatterTimeoutMs: number;
  /**
   * Part A extension: let the model resolve a bare conversational reference
   * ("show me the recipe's ingredients") to one recipe id drawn from a closed
   * candidate list the deterministic session memory already recorded.
   */
  referenceResolutionEnabled: boolean;
  /** Per-intent Part B switches. `medical_safety` is absent by construction. */
  formatterIntents: Readonly<Record<FormatterIntentName, boolean>>;
  /** Part C: expose the internal observability route. Never on by default. */
  debugPanelEnabled: boolean;
  /**
   * Part C2: separate, explicitly-scoped opt-in that allows raw user message
   * text into trace records. Off by default; only the A4 regression harness
   * turns it on.
   */
  rawMessageDebugOptIn: boolean;
  groundingToleranceAbsolute: number;
  /** Bounded number of trace records retained for the debug panel. */
  traceBufferSize: number;
}

function flag(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim();
  if (value === undefined || value === "") return fallback;
  if (/^(?:1|true|yes|on)$/iu.test(value)) return true;
  if (/^(?:0|false|no|off)$/iu.test(value)) return false;
  return fallback;
}

function boundedMs(raw: string | undefined, fallbackMs: number): number {
  const seconds = Number(raw?.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.round(Math.min(30, Math.max(0.25, seconds)) * 1_000);
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = Number(raw?.trim());
  if (!Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Reduce stage timeouts so that both Claude stages plus the reserved
 * deterministic time fit inside one request budget.
 *
 * Scaling is proportional, preserving the operator's relative weighting between
 * the two stages. A stage that times out falls back to the deterministic
 * result, which is always preferable to the request itself timing out.
 */
export function clampStageTimeouts(
  classifierMs: number,
  formatterMs: number,
  requestBudgetMs: number,
  reserveMs: number = NON_LLM_TIME_RESERVE_MS,
): { classifierTimeoutMs: number; formatterTimeoutMs: number; clamped: boolean } {
  const available = Math.max(500, requestBudgetMs - reserveMs);
  const requested = classifierMs + formatterMs;
  if (requested <= available) return { classifierTimeoutMs: classifierMs, formatterTimeoutMs: formatterMs, clamped: false };
  const factor = available / requested;
  return {
    classifierTimeoutMs: Math.max(250, Math.floor(classifierMs * factor)),
    formatterTimeoutMs: Math.max(250, Math.floor(formatterMs * factor)),
    clamped: true,
  };
}

/**
 * Read the Claude layer configuration from an environment map.
 *
 * Defaults are deliberately conservative: both stages are off unless a model
 * identifier is supplied, so a repository without Claude credentials behaves
 * exactly as it did before Step 17b.
 */
export function loadClaudeLayerConfig(env: Record<string, string | undefined> = process.env): ClaudeLayerConfig {
  const classifierModel = env.CLAUDE_CLASSIFIER_MODEL?.trim() || null;
  const formatterModel = env.CLAUDE_FORMATTER_MODEL?.trim() || null;
  const requestedClassifierTimeoutMs = boundedMs(env.CLAUDE_CLASSIFIER_TIMEOUT_SECONDS, 3_000);
  const requestedFormatterTimeoutMs = boundedMs(env.CLAUDE_FORMATTER_TIMEOUT_SECONDS, 6_000);
  const requestBudgetMs = boundedMs(env.REQUEST_TIMEOUT_SECONDS, 15_000);
  const clamped = clampStageTimeouts(requestedClassifierTimeoutMs, requestedFormatterTimeoutMs, requestBudgetMs);
  const classifierEnabled = flag(env.CLAUDE_CLASSIFIER_ENABLED, classifierModel !== null);
  return {
    classifierEnabled,
    formatterEnabled: flag(env.CLAUDE_FORMATTER_ENABLED, formatterModel !== null),
    classifierModel,
    formatterModel,
    classifierTimeoutMs: clamped.classifierTimeoutMs,
    formatterTimeoutMs: clamped.formatterTimeoutMs,
    requestBudgetMs,
    stageTimeoutsClamped: clamped.clamped,
    requestedClassifierTimeoutMs,
    requestedFormatterTimeoutMs,
    referenceResolutionEnabled: flag(env.CLAUDE_REFERENCE_RESOLUTION_ENABLED, classifierEnabled),
    formatterIntents: {
      recipe_nutrition: flag(env.CLAUDE_FORMATTER_RECIPE_NUTRITION, true),
      ingredient_nutrition: flag(env.CLAUDE_FORMATTER_INGREDIENT_NUTRITION, true),
      compare_recipes: flag(env.CLAUDE_FORMATTER_COMPARE_RECIPES, true),
      lighter_modification: flag(env.CLAUDE_FORMATTER_LIGHTER_MODIFICATION, true),
      find_recipe: flag(env.CLAUDE_FORMATTER_FIND_RECIPE, true),
      general_guideline: flag(env.CLAUDE_FORMATTER_GENERAL_GUIDELINE, true),
      meal_plan: flag(env.CLAUDE_FORMATTER_MEAL_PLAN, true),
    },
    debugPanelEnabled: flag(env.CLAUDE_DEBUG_PANEL_ENABLED, false),
    rawMessageDebugOptIn: flag(env.CLAUDE_DEBUG_RAW_MESSAGES, false),
    groundingToleranceAbsolute: DISPLAY_ROUNDING_TOLERANCE,
    traceBufferSize: boundedInteger(env.CLAUDE_DEBUG_TRACE_BUFFER, 50, 1, 500),
  };
}

/**
 * Decide whether Part B may run for one intent.
 *
 * `medical_safety` is rejected before configuration is consulted, so no
 * environment variable, config file, or future default can enable it.
 */
export function formatterIntentDecision(config: ClaudeLayerConfig, intent: string): FormatterIntentDecision {
  if (FORMATTER_HARD_DISABLED_INTENTS.has(intent)) return { allowed: false, reason: "hard_disabled_medical_safety" };
  if (!(FORMATTER_ELIGIBLE_INTENTS as readonly string[]).includes(intent)) {
    return { allowed: false, reason: "intent_out_of_formatter_scope" };
  }
  return config.formatterIntents[intent as FormatterIntentName]
    ? { allowed: true, reason: "enabled_by_config" }
    : { allowed: false, reason: "disabled_by_config" };
}
