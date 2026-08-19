/**
 * Part A — Claude as an advisory NLU classifier.
 *
 * The classifier returns labels and candidate entity strings only. It never
 * receives nutrition data, never computes anything, and its output never
 * decides what the user sees in Step 17b: `nlu-arbitration.ts` always prefers
 * the rule-based result. Candidate entities are inert strings until
 * `entity-validation.ts` resolves them against real data.
 */

import { z } from "zod";
import { GRADUATION_INTENTS, type GraduationIntentName } from "./claude-config.js";
import type { ClaudeCallResult, ClaudeMessagesClient, ClaudeToolDefinition } from "./claude-client.js";

/** Strict schema for the classifier's structured output (A1). */
export const ClaudeClassificationSchema = z.object({
  intent: z.enum(GRADUATION_INTENTS),
  confidence: z.number().min(0).max(1),
  entities: z.object({
    recipe_or_ingredient_name: z.string().trim().min(1).max(120).nullable(),
    meal_category: z.enum(["breakfast", "lunch", "dinner"]).nullable(),
    calorie_ceiling: z.number().finite().nullable(),
    calorie_ceiling_mode: z.enum(["total", "per_meal"]).nullable(),
    exclusions: z.array(z.string().trim().min(1).max(120)).max(20),
    comparison_targets: z.array(z.string().trim().min(1).max(120)).max(10),
  }).strict(),
  /**
   * Resolution of a bare conversational reference onto one recipe id from the
   * closed candidate list supplied in the prompt. Any value outside that list is
   * rejected by the caller, so this cannot introduce a new dish.
   */
  referenced_recipe_id: z.string().trim().max(40).nullable().default(null),
  raw_reasoning_note: z.string().max(400),
}).strict();

export type ClaudeClassification = z.infer<typeof ClaudeClassificationSchema>;

export type ClassifierOutcome =
  | { ok: true; classification: ClaudeClassification; model: string; latencyMs: number }
  | { ok: false; failureReason: ClassifierFailureReason; detail: string; model: string; latencyMs: number };

export type ClassifierFailureReason =
  | "not_configured"
  | "timeout"
  | "transport_error"
  | "http_error"
  | "malformed_response"
  | "tool_output_missing"
  | "empty_text"
  | "schema_validation_failed";

const CLASSIFIER_TOOL: ClaudeToolDefinition = {
  name: "report_nutrition_intent",
  description:
    "Report the single best intent label and the candidate entity strings mentioned by the user. "
    + "Report only what the user literally asked for. Never compute a nutritional value and never invent a dish, ingredient or number.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["intent", "confidence", "entities", "referenced_recipe_id", "raw_reasoning_note"],
    properties: {
      intent: { type: "string", enum: [...GRADUATION_INTENTS], description: "The single best matching intent." },
      confidence: { type: "number", minimum: 0, maximum: 1, description: "Calibrated confidence in the chosen intent." },
      entities: {
        type: "object",
        additionalProperties: false,
        required: ["recipe_or_ingredient_name", "meal_category", "calorie_ceiling", "calorie_ceiling_mode", "exclusions", "comparison_targets"],
        properties: {
          recipe_or_ingredient_name: { type: ["string", "null"], description: "Dish or ingredient named by the user, copied verbatim. Null when absent." },
          meal_category: { type: ["string", "null"], enum: ["breakfast", "lunch", "dinner", null], description: "Meal slot named by the user. Null when absent." },
          calorie_ceiling: { type: ["number", "null"], description: "Calorie number the user supplied. Never a number you calculated. Null when absent." },
          calorie_ceiling_mode: { type: ["string", "null"], enum: ["total", "per_meal", null], description: "Whether the user's calorie number is a daily total or per meal." },
          exclusions: { type: "array", items: { type: "string" }, description: "Ingredients the user asked to exclude, copied verbatim." },
          comparison_targets: { type: "array", items: { type: "string" }, description: "Dishes the user asked to compare, copied verbatim." },
        },
      },
      raw_reasoning_note: { type: "string", maxLength: 400, description: "One short sentence of reasoning, for engineering logs only. Never shown to a user." },
      referenced_recipe_id: {
        type: ["string", "null"],
        description:
          "If the user refers to a dish without naming it (\"the recipe\", \"that dish\", \"it\", \"\u0627\u0644\u0648\u0635\u0641\u0629\", \"\u0627\u0644\u0637\u0628\u0642\"), "
          + "return the matching recipe_id from the Candidate recipes list in the prompt, copied exactly. "
          + "Return null when the user named a dish explicitly, when no reference is made, or when the list is empty. "
          + "Never invent an id and never return an id that is absent from that list.",
      },
    },
  },
};

const CLASSIFIER_SYSTEM_PROMPT = [
  "You are the intent classifier for NutriGuard, a deterministic Egyptian-food nutrition assistant.",
  "",
  "Your ONLY job is to label the user's request and copy out the entity strings they mentioned.",
  "",
  "Absolute rules:",
  "- Never perform arithmetic. Never produce a nutritional value. Never estimate a quantity.",
  "- Never invent a dish, ingredient, recipe, guideline or number. Copy entity names verbatim from the user's message; if the user did not name something, report null or an empty array.",
  "- The only numbers you may report are calorie figures the user typed themselves.",
  "- You do not answer the user. Another deterministic system computes every fact and writes the reply.",
  "",
  "Intent definitions:",
  "- find_recipe: wants a recipe, its ingredients or method, or a dish recommendation.",
  "- recipe_nutrition: wants nutrition values for a named dish.",
  "- ingredient_nutrition: wants nutrition values for raw ingredients, usually with weights in grams.",
  "- compare_recipes: wants two dishes compared on a nutrient.",
  "- general_guideline: wants general dietary guidance, a WHO recommendation, or non-absolute context about whether a dish fits a diet.",
  "- lighter_modification: wants a dish made lighter, or an ingredient reduced or excluded.",
  "- medical_safety: describes a medical condition, medication, diagnosis, pregnancy, or an emergency.",
  "- unsupported: anything outside Egyptian food and nutrition, or a request the system cannot verify.",
  "",
  "Call the report_nutrition_intent tool exactly once.",
].join("\n");

export interface ReferenceCandidate {
  recipeId: string;
  displayName: string;
}

export interface ClassifierContextSummary {
  /**
   * Bounded, structural summary of the short-term session context. Contains
   * intent labels and identifiers only — never nutrition numbers.
   */
  lastIntent: string | null;
  activeRecipeId: string | null;
  turnCount: number | null;
  pendingOperation: string | null;
  /**
   * Closed list of recipes the deterministic session memory already recorded.
   * A conversational reference may only be resolved to a member of this list.
   */
  referenceCandidates?: ReferenceCandidate[];
}

export interface ClassifierInput {
  message: string;
  language: "ar-EG" | "ar" | "en";
  context: ClassifierContextSummary | null;
}

function renderUserContent(input: ClassifierInput): string {
  const lines = [`Answer language: ${input.language}`];
  if (input.context) {
    lines.push(
      "Short-term session context (structural labels only, no nutrition data):",
      `- previous intent: ${input.context.lastIntent ?? "none"}`,
      `- active recipe id: ${input.context.activeRecipeId ?? "none"}`,
      `- turn number: ${input.context.turnCount ?? "unknown"}`,
      `- pending operation awaiting confirmation: ${input.context.pendingOperation ?? "none"}`,
    );
    const candidates = input.context.referenceCandidates ?? [];
    lines.push(
      "",
      "Candidate recipes already discussed in this session. A bare reference such as",
      "\"the recipe\" may be resolved ONLY to one of these ids, copied exactly:",
      candidates.length > 0
        ? candidates.map((candidate) => `- ${candidate.recipeId} = ${candidate.displayName}`).join("\n")
        : "- (none; referenced_recipe_id must be null)",
    );
  } else {
    lines.push("Short-term session context: none (new session).", "", "Candidate recipes: none; referenced_recipe_id must be null.");
  }
  lines.push("", "User message:", input.message);
  return lines.join("\n");
}

function failureReason(result: Extract<ClaudeCallResult<unknown>, { ok: false }>): ClassifierFailureReason {
  return result.reason;
}

/** Advisory Claude classifier. Any failure is reported, never thrown. */
export class ClaudeIntentClassifier {
  public constructor(private readonly client: ClaudeMessagesClient) {}

  public get model(): string {
    return this.client.model;
  }

  public async classify(input: ClassifierInput): Promise<ClassifierOutcome> {
    const result = await this.client.callStructured({
      system: CLASSIFIER_SYSTEM_PROMPT,
      userContent: renderUserContent(input),
      tool: CLASSIFIER_TOOL,
    });
    if (!result.ok) {
      return { ok: false, failureReason: failureReason(result), detail: result.detail, model: result.model, latencyMs: result.latencyMs };
    }
    const parsed = ClaudeClassificationSchema.safeParse(result.value);
    if (!parsed.success) {
      return {
        ok: false,
        failureReason: "schema_validation_failed",
        detail: parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "root"}:${issue.code}`).join("|"),
        model: result.model,
        latencyMs: result.latencyMs,
      };
    }
    return { ok: true, classification: parsed.data, model: result.model, latencyMs: result.latencyMs };
  }
}

/** Convenience type guard used by the arbitration and reporting layers. */
export function isSupportedIntentName(value: string): value is GraduationIntentName {
  return (GRADUATION_INTENTS as readonly string[]).includes(value);
}
