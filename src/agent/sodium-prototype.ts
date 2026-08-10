import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import type { RecipeNutritionResult } from "../domain/nutrition.js";
import type { NutriGuardToolset, SearchToolOutput, ToolResult } from "../tools/nutriguard-tools.js";
import { classifySafetyFlags, type SafetyFlag } from "./safety.js";
import { NUTRIGUARD_SYSTEM_PROMPT, NUTRIGUARD_SYSTEM_PROMPT_VERSION } from "./system-prompt.js";

export type AgentLanguage = "ar-EG" | "ar" | "en";
export type SodiumBasis = "full_recipe" | "per_serving" | "per_100g";

const PlanSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("recipe_sodium"),
    recipeQuery: z.string().trim().min(1).max(200),
    basis: z.enum(["full_recipe", "per_serving", "per_100g"]),
  }).strict(),
  z.object({ intent: z.literal("unsupported") }).strict(),
]);

export type SodiumScenarioPlan = z.infer<typeof PlanSchema>;

export interface SodiumScenarioPlanner {
  plan(input: { systemPrompt: string; promptVersion: string; userMessage: string; language: AgentLanguage }): Promise<unknown>;
}

export class RuleBasedSodiumScenarioPlanner implements SodiumScenarioPlanner {
  public async plan(input: { systemPrompt: string; promptVersion: string; userMessage: string; language: AgentLanguage }): Promise<unknown> {
    if (!input.systemPrompt.includes("calculate_nutrition") || input.promptVersion !== NUTRIGUARD_SYSTEM_PROMPT_VERSION) {
      return { intent: "unsupported" };
    }
    const text = input.userMessage.normalize("NFKC").trim();
    if (!/(?:صوديوم|sodium)/iu.test(text)) return { intent: "unsupported" };
    const basis: SodiumBasis = /(?:100\s*(?:جم|جرام)|100\s*g)/iu.test(text)
      ? "per_100g"
      : /(?:للحصة|في الحصة|per\s+serving)/iu.test(text)
        ? "per_serving"
        : "full_recipe";
    const recipeQuery = text
      .replace(/(?:عايز|عاوزه|عاوزة|احسبلي|احسب|كام|ايه|إيه|what is|calculate|tell me)/giu, " ")
      .replace(/(?:الصوديوم|صوديوم|sodium)/giu, " ")
      .replace(/(?:في|بتاع|بتاعة|لـ|of|in|for|الوصفة|وصفة|recipe)/giu, " ")
      .replace(/(?:لكل|في)?\s*100\s*(?:جم|جرام|g)|للحصة|per\s+serving/giu, " ")
      .replace(/[؟?،,]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return recipeQuery === "" ? { intent: "unsupported" } : { intent: "recipe_sodium", recipeQuery, basis };
  }
}

export interface AgentToolTrace {
  tool: "search_recipes" | "calculate_nutrition";
  ok: boolean;
  code: string | null;
}

export interface SodiumAgentFacts {
  recipeId: string;
  basis: SodiumBasis;
  sodiumMg: number;
  calculationStatus: "partial" | "complete";
}

export interface AgentProvenance {
  sourceId: string;
  versionId: string;
  title: string | null;
  url: string | null;
  accessedAt: string | null;
  locator: string | null;
}

export interface SodiumAgentResponse {
  status: "ok" | "no_result" | "clarification" | "refused" | "unsupported" | "emergency";
  primaryIntent: "recipe_nutrition" | "medical_safety_request" | "unsupported_request";
  language: AgentLanguage;
  safetyFlags: SafetyFlag[];
  message: string;
  facts: SodiumAgentFacts | null;
  provenance: AgentProvenance[];
  toolTrace: AgentToolTrace[];
  promptVersion: string;
}

const ResponseSchema = z.object({
  status: z.enum(["ok", "no_result", "clarification", "refused", "unsupported", "emergency"]),
  primaryIntent: z.enum(["recipe_nutrition", "medical_safety_request", "unsupported_request"]),
  language: z.enum(["ar-EG", "ar", "en"]),
  safetyFlags: z.array(z.enum(["emergency", "medical_advice_request", "vulnerable_population_personalization", "allergen_safety_guarantee", "religious_compliance_guarantee"])),
  message: z.string().trim().min(1),
  facts: z.object({
    recipeId: z.string().trim().min(1),
    basis: z.enum(["full_recipe", "per_serving", "per_100g"]),
    sodiumMg: z.number().finite().nonnegative(),
    calculationStatus: z.enum(["partial", "complete"]),
  }).strict().nullable(),
  provenance: z.array(z.object({
    sourceId: z.string().trim().min(1),
    versionId: z.string().trim().min(1),
    title: z.string().nullable(),
    url: z.string().nullable(),
    accessedAt: z.string().nullable(),
    locator: z.string().nullable(),
  }).strict()),
  toolTrace: z.array(z.object({
    tool: z.enum(["search_recipes", "calculate_nutrition"]),
    ok: z.boolean(),
    code: z.string().nullable(),
  }).strict()),
  promptVersion: z.literal(NUTRIGUARD_SYSTEM_PROMPT_VERSION),
}).strict();

type SearchResult = ToolResult<SearchToolOutput>;
type NutritionResult = ToolResult<RecipeNutritionResult>;

const AgentState = new StateSchema({
  userMessage: z.string(),
  language: z.enum(["ar-EG", "ar", "en"]),
  safetyFlags: z.array(z.string()).default([]),
  route: z.enum(["pending", "emergency", "medical", "religious", "unsupported", "search", "clarification", "calculate", "no_result", "success"]).default("pending"),
  plan: z.custom<SodiumScenarioPlan>().nullable().default(null),
  recipeId: z.string().nullable().default(null),
  searchResult: z.custom<SearchResult>().nullable().default(null),
  nutritionResult: z.custom<NutritionResult>().nullable().default(null),
  toolTrace: z.array(z.custom<AgentToolTrace>()).default([]),
  response: z.custom<SodiumAgentResponse>().nullable().default(null),
});

type GraphState = typeof AgentState.State;

function firstErrorCode<T>(result: ToolResult<T>): string | null {
  return result.ok ? null : result.errors[0]?.code ?? "unknown_error";
}

function localized(language: AgentLanguage, ar: string, en: string): string {
  return language === "en" ? en : ar;
}

function fixedResponse(state: GraphState): SodiumAgentResponse {
  const common: Pick<SodiumAgentResponse, "language" | "safetyFlags" | "facts" | "provenance" | "toolTrace" | "promptVersion"> = {
    language: state.language,
    safetyFlags: state.safetyFlags as SafetyFlag[],
    facts: null,
    provenance: [],
    toolTrace: state.toolTrace,
    promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
  };
  if (state.route === "emergency") return {
    ...common,
    status: "emergency",
    primaryIntent: "medical_safety_request",
    message: localized(state.language, "لو فيه خطر فوري أو صعوبة تنفس أو فقدان وعي، اتصل بخدمات الطوارئ المحلية حالاً. مقدرش أقدم علاج طارئ.", "If there is immediate danger, breathing difficulty, or loss of consciousness, contact local emergency services now. I cannot provide emergency treatment."),
  };
  if (state.route === "medical") return {
    ...common,
    status: "refused",
    primaryIntent: "medical_safety_request",
    message: localized(state.language, "مقدرش أقدم تشخيص أو علاج أو نظام شخصي لحالة صحية. اتكلم مع طبيب أو أخصائي تغذية مرخص.", "I cannot provide diagnosis, treatment, or a personalized diet for a health condition. Please consult a licensed clinician or dietitian."),
  };
  if (state.route === "religious") return {
    ...common,
    status: "unsupported",
    primaryIntent: "unsupported_request",
    message: localized(state.language, "مقدرش أضمن إن وصفة حلال أو كوشير. أقدر أعرض بس البيانات المكتوبة في المصدر من غير ضمان.", "I cannot guarantee that a recipe is halal or kosher. I can only report source-declared metadata without guaranteeing it."),
  };
  if (state.route === "clarification") return {
    ...common,
    status: "clarification",
    primaryIntent: "recipe_nutrition",
    message: localized(state.language, "لقيت أكتر من وصفة محتملة. وضّح اسم الوصفة أكتر علشان ما اختارش بالتخمين.", "I found more than one possible recipe. Please clarify the recipe name so I do not guess."),
  };
  if (state.route === "no_result") return {
    ...common,
    status: "no_result",
    primaryIntent: "recipe_nutrition",
    message: localized(state.language, "معنديش معلومة موثوقة كفاية عن ده دلوقتي.", "I do not have enough verified information about that right now."),
  };
  return {
    ...common,
    status: "unsupported",
    primaryIntent: "unsupported_request",
    message: localized(state.language, "النسخة التجريبية دي بتدعم حالياً حساب صوديوم وصفة مصرية متحقق منها بس.", "This prototype currently supports only sodium calculation for one verified Egyptian recipe."),
  };
}

export class NutriGuardSodiumPrototypeAgent {
  private readonly graph;

  public constructor(
    private readonly tools: NutriGuardToolset,
    private readonly planner: SodiumScenarioPlanner = new RuleBasedSodiumScenarioPlanner()
  ) {
    const safetyNode: typeof AgentState.Node = (state) => {
      const flags = classifySafetyFlags(state.userMessage);
      const route = flags.includes("emergency")
        ? "emergency"
        : flags.some((flag) => flag === "medical_advice_request" || flag === "vulnerable_population_personalization" || flag === "allergen_safety_guarantee")
          ? "medical"
          : flags.includes("religious_compliance_guarantee")
            ? "religious"
            : "pending";
      return { safetyFlags: flags, route };
    };

    const plannerNode: typeof AgentState.Node = async (state) => {
      try {
        const rawPlan = await this.planner.plan({
          systemPrompt: NUTRIGUARD_SYSTEM_PROMPT,
          promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
          userMessage: state.userMessage,
          language: state.language,
        });
        const parsed = PlanSchema.safeParse(rawPlan);
        if (!parsed.success || parsed.data.intent === "unsupported") return { route: "unsupported", plan: parsed.success ? parsed.data : null };
        return { route: "search", plan: parsed.data };
      } catch {
        return { route: "unsupported", plan: null };
      }
    };

    const searchNode: typeof AgentState.Node = async (state) => {
      if (!state.plan || state.plan.intent !== "recipe_sodium") return { route: "unsupported" };
      const result = await this.tools.searchRecipes({ query: state.plan.recipeQuery, limit: 3 });
      const trace = [...state.toolTrace, { tool: "search_recipes", ok: result.ok, code: firstErrorCode(result) } satisfies AgentToolTrace];
      if (!result.ok || result.data.hits.length === 0) return { searchResult: result, toolTrace: trace, route: "no_result" };
      const recipeIds = [...new Set(result.data.hits.map((hit) => hit.document.metadata.recipeId).filter((id): id is string => typeof id === "string" && id.trim() !== ""))];
      if (recipeIds.length !== 1) return { searchResult: result, toolTrace: trace, route: "clarification" };
      return { searchResult: result, recipeId: recipeIds[0] ?? null, toolTrace: trace, route: "calculate" };
    };

    const calculateNode: typeof AgentState.Node = async (state) => {
      if (!state.recipeId || !state.plan || state.plan.intent !== "recipe_sodium") return { route: "no_result" };
      const result = await this.tools.calculateNutrition({ recipeId: state.recipeId, servingRequest: { bases: [state.plan.basis] } });
      const trace = [...state.toolTrace, { tool: "calculate_nutrition", ok: result.ok, code: firstErrorCode(result) } satisfies AgentToolTrace];
      if (!result.ok) return { nutritionResult: result, toolTrace: trace, route: "no_result" };
      const basis = result.data.bases[state.plan.basis];
      if (result.data.calculationStatus === "unavailable" || basis.basisStatus !== "available" || basis.nutrients.sodium.amount === null) {
        return { nutritionResult: result, toolTrace: trace, route: "no_result" };
      }
      return { nutritionResult: result, toolTrace: trace, route: "success" };
    };

    const responseNode: typeof AgentState.Node = (state) => {
      if (state.route !== "success" || !state.plan || state.plan.intent !== "recipe_sodium" || !state.recipeId || !state.nutritionResult?.ok) {
        return { response: fixedResponse(state) };
      }
      const sodium = state.nutritionResult.data.bases[state.plan.basis].nutrients.sodium;
      if (sodium.amount === null || state.nutritionResult.data.calculationStatus === "unavailable") {
        return { route: "no_result", response: fixedResponse({ ...state, route: "no_result" }) };
      }
      const basisLabelAr = state.plan.basis === "full_recipe" ? "إجمالي الوصفة" : state.plan.basis === "per_serving" ? "الحصة" : "كل 100 جم";
      const basisLabelEn = state.plan.basis === "full_recipe" ? "The full recipe" : state.plan.basis === "per_serving" ? "One serving" : "Each 100 g";
      const searchProvenance = state.searchResult?.ok ? state.searchResult.provenance : [];
      return {
        response: {
          status: "ok",
          primaryIntent: "recipe_nutrition",
          language: state.language,
          safetyFlags: state.safetyFlags as SafetyFlag[],
          message: localized(state.language, `${basisLabelAr} فيها ${sodium.amount} مجم صوديوم حسب الحساب الحتمي من البيانات المعتمدة. المعلومة عامة ومش نصيحة طبية.`, `${basisLabelEn} contains ${sodium.amount} mg sodium from the deterministic calculation over approved data. This is general information, not medical advice.`),
          facts: {
            recipeId: state.recipeId,
            basis: state.plan.basis,
            sodiumMg: sodium.amount,
            calculationStatus: state.nutritionResult.data.calculationStatus,
          },
          provenance: [...searchProvenance, ...state.nutritionResult.provenance],
          toolTrace: state.toolTrace,
          promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
        },
      };
    };

    this.graph = new StateGraph(AgentState)
      .addNode("safety", safetyNode)
      .addNode("planning", plannerNode)
      .addNode("search", searchNode)
      .addNode("calculate", calculateNode)
      .addNode("respond", responseNode)
      .addEdge(START, "safety")
      .addConditionalEdges("safety", (state) => state.route === "pending" ? "planning" : "respond", ["planning", "respond"])
      .addConditionalEdges("planning", (state) => state.route === "search" ? "search" : "respond", ["search", "respond"])
      .addConditionalEdges("search", (state) => state.route === "calculate" ? "calculate" : "respond", ["calculate", "respond"])
      .addEdge("calculate", "respond")
      .addEdge("respond", END)
      .compile({ name: "nutriguard_step12_sodium_prototype" });
  }

  public async invoke(input: { message: string; language?: AgentLanguage }): Promise<SodiumAgentResponse> {
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (message === "" || message.length > 2_000) throw new Error("agent message must contain 1–2000 characters");
    const language = input.language ?? "ar-EG";
    if (!(["ar-EG", "ar", "en"] as const).includes(language)) throw new Error("unsupported agent language");
    const state = await this.graph.invoke({ userMessage: message, language });
    if (!state.response) throw new Error("agent graph completed without a response");
    const validated = ResponseSchema.safeParse(state.response);
    if (!validated.success) throw new Error("agent graph produced an invalid response");
    return validated.data;
  }
}
