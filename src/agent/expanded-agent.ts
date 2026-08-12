import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import type { NutrientCode, NutritionBasis, RecipeNutritionResult } from "../domain/nutrition.js";
import type { NutriGuardToolset, ToolResult } from "../tools/nutriguard-tools.js";
import { classifySafetyFlags, type SafetyFlag } from "./safety.js";
import { classifyRequestIntegrity, type RequestIntegrityFlag } from "./request-integrity.js";
import { RuleBasedSodiumScenarioPlanner, type AgentLanguage } from "./sodium-prototype.js";
import { NUTRIGUARD_SYSTEM_PROMPT, NUTRIGUARD_SYSTEM_PROMPT_VERSION } from "./system-prompt.js";

const SUPPORTED_NUTRIENTS: NutrientCode[] = [
  "calories", "protein", "carbohydrate", "total_fat", "saturated_fat", "fiber", "sugar", "sodium",
];

const ExpandedPlanSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("recipe_sodium"), recipeQuery: z.string().trim().min(1).max(200), basis: z.enum(["full_recipe", "per_serving", "per_100g"]) }).strict(),
  z.object({ intent: z.literal("compare_recipes"), firstQuery: z.string().trim().min(1).max(200), secondQuery: z.string().trim().min(1).max(200), basis: z.enum(["per_serving", "per_100g"]) }).strict(),
  z.object({ intent: z.literal("lighter_recipe"), recipeQuery: z.string().trim().min(1).max(200), ruleId: z.string().trim().min(1).optional() }).strict(),
  z.object({ intent: z.literal("general_guidance"), topic: z.string().trim().min(1).max(300) }).strict(),
  z.object({ intent: z.literal("unsupported") }).strict(),
]);

export type ExpandedAgentPlan = z.infer<typeof ExpandedPlanSchema>;

export interface ExpandedAgentPlanner {
  plan(input: { systemPrompt: string; promptVersion: string; userMessage: string; language: AgentLanguage }): Promise<unknown>;
}

export class RuleBasedExpandedAgentPlanner implements ExpandedAgentPlanner {
  private readonly sodiumPlanner = new RuleBasedSodiumScenarioPlanner();

  public async plan(input: { systemPrompt: string; promptVersion: string; userMessage: string; language: AgentLanguage }): Promise<unknown> {
    const text = input.userMessage.normalize("NFKC").trim();
    if (/(?:هرم\s*(?:الغذائي|غذائي|الغذاء|الأكل|الاكل)|food\s+pyramid)/iu.test(text)) {
      return { intent: "general_guidance", topic: text };
    }
    if (/(?:اخترع|تخمين|تقريبي|guess|estimate)/iu.test(text)) return { intent: "unsupported" };
    const comparison = text.match(/(?:قارن|مقارنة)\s+(?:بين\s+)?(.+?)\s+و(?:ال)?(.+?)(?:\s+(?:لكل|في)\s*100\s*(?:جم|جرام)|\s+للحصة)?$/iu)
      ?? text.match(/مين\s+[اأإآ]قل\s+[^:؟?]*[:：]?\s*(.+?)\s+ولا\s+(.+?)[؟?]?$/iu)
      ?? text.match(/فرق\s+.+?\s+بين\s+(.+?)\s+و(?:ال)?(.+?)[؟?]?$/iu)
      ?? text.match(/(.+?)\s+ضد\s+(.+?)(?:\s+في\s+.+)?$/iu)
      ?? text.match(/compare\s+(.+?)\s+(?:and|vs\.?|versus)\s+(.+?)(?:\s+per\s+(100\s*g|serving))?$/iu);
    if (comparison) {
      const firstQuery = comparison[1]?.trim() ?? "";
      const secondQuery = comparison[2]?.trim() ?? "";
      const basis = /(?:للحصة|per\s+serving)/iu.test(text) ? "per_serving" : "per_100g";
      if (firstQuery && secondQuery) return { intent: "compare_recipes", firstQuery, secondQuery, basis };
    }
    const lighter = text.match(/(?:بديل\s+(?:اخف|أخف|صحي)|وصفة\s+اخف|وصفة\s+أخف)\s+(?:لـ|ل|من|بدل)\s*(.+)$/iu)
      ?? text.match(/(?:بديل|وصفة\s+(?:اخف|أخف))[^؟?]{0,30}(?:لـ|ل|من|بدل)\s*(.+?)[؟?]?$/iu)
      ?? text.match(/(?:healthier|lighter)\s+alternative\s+(?:to|for)\s+(.+)$/iu);
    if (lighter?.[1]?.trim()) return { intent: "lighter_recipe", recipeQuery: lighter[1].trim() };
    return this.sodiumPlanner.plan(input);
  }
}

export interface ApprovedAlternativeRule {
  id: string;
  fromRecipeId: string;
  candidateRecipeId: string;
  candidateQuery: string;
  targetNutrient: "calories" | "total_fat" | "sodium";
  basis: "per_serving" | "per_100g";
  status: "approved" | "pending" | "rejected";
  licenseStatus: "approved" | "pending" | "rejected";
  sourceId: string;
  versionId: string;
  sourceTitle: string;
  sourceUrl: string;
}

export interface AlternativeRuleRepository {
  listForRecipe(recipeId: string): Promise<ApprovedAlternativeRule[]>;
}

export class InMemoryAlternativeRuleRepository implements AlternativeRuleRepository {
  public constructor(private readonly rules: readonly ApprovedAlternativeRule[]) {}
  public async listForRecipe(recipeId: string): Promise<ApprovedAlternativeRule[]> {
    return this.rules.filter((rule) => rule.fromRecipeId === recipeId).map((rule) => structuredClone(rule));
  }
}

export interface ExpandedToolTrace {
  tool: "search_recipes" | "search_guidelines" | "calculate_nutrition" | "search_recipes_by_meal_category" | "confirm_and_log_meal_selection";
  ok: boolean;
  code: string | null;
}

export interface ExpandedAgentProvenance {
  sourceId: string;
  versionId: string;
  title: string | null;
  url: string | null;
  accessedAt: string | null;
  locator: string | null;
}

export interface ExpandedAgentResponse {
  status: "ok" | "no_result" | "clarification" | "refused" | "unsupported" | "emergency";
  primaryIntent: "recipe_nutrition" | "compare_recipes" | "lighter_recipe" | "general_guidance" | "medical_safety_request" | "unsupported_request";
  language: AgentLanguage;
  safetyFlags: SafetyFlag[];
  integrityFlags: RequestIntegrityFlag[];
  message: string;
  data: Record<string, unknown> | null;
  evidenceDocumentIds: string[];
  provenance: ExpandedAgentProvenance[];
  toolTrace: ExpandedToolTrace[];
  promptVersion: string;
}

const ResponseSchema = z.object({
  status: z.enum(["ok", "no_result", "clarification", "refused", "unsupported", "emergency"]),
  primaryIntent: z.enum(["recipe_nutrition", "compare_recipes", "lighter_recipe", "general_guidance", "medical_safety_request", "unsupported_request"]),
  language: z.enum(["ar-EG", "ar", "en"]),
  safetyFlags: z.array(z.enum(["emergency", "medical_advice_request", "vulnerable_population_personalization", "allergen_safety_guarantee", "religious_compliance_guarantee"])),
  integrityFlags: z.array(z.enum(["prompt_injection", "untrusted_numeric_override", "unapproved_data_request"])),
  message: z.string().trim().min(1),
  data: z.record(z.string(), z.unknown()).nullable(),
  evidenceDocumentIds: z.array(z.string()),
  provenance: z.array(z.object({ sourceId: z.string().min(1), versionId: z.string().min(1), title: z.string().nullable(), url: z.string().nullable(), accessedAt: z.string().nullable(), locator: z.string().nullable() }).strict()),
  toolTrace: z.array(z.object({ tool: z.enum(["search_recipes", "search_guidelines", "calculate_nutrition", "search_recipes_by_meal_category", "confirm_and_log_meal_selection"]), ok: z.boolean(), code: z.string().nullable() }).strict()),
  promptVersion: z.literal(NUTRIGUARD_SYSTEM_PROMPT_VERSION),
}).strict();

const State = new StateSchema({
  userMessage: z.string(),
  language: z.enum(["ar-EG", "ar", "en"]),
  safetyFlags: z.array(z.string()).default([]),
  integrityFlags: z.array(z.string()).default([]),
  route: z.enum(["pending", "execute", "blocked", "unsupported"]).default("pending"),
  plan: z.custom<ExpandedAgentPlan>().nullable().default(null),
  response: z.custom<ExpandedAgentResponse>().nullable().default(null),
});

type GraphState = typeof State.State;

function firstError<T>(result: ToolResult<T>): string | null {
  return result.ok ? null : result.errors[0]?.code ?? "unknown_error";
}

function local(language: AgentLanguage, ar: string, en: string): string {
  return language === "en" ? en : ar;
}

function baseResponse(state: GraphState, overrides: Partial<ExpandedAgentResponse>): ExpandedAgentResponse {
  return {
    status: "unsupported",
    primaryIntent: "unsupported_request",
    language: state.language,
    safetyFlags: state.safetyFlags as SafetyFlag[],
    integrityFlags: state.integrityFlags as RequestIntegrityFlag[],
    message: local(state.language, "الطلب ده مش متاح في النسخة الحالية.", "That request is not available in the current version."),
    data: null,
    evidenceDocumentIds: [],
    provenance: [],
    toolTrace: [],
    promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    ...overrides,
  };
}

interface ResolvedRecipe {
  recipeId: string;
  documentId: string;
  provenance: ExpandedAgentProvenance[];
  trace: ExpandedToolTrace;
}

type Resolution = { kind: "ok"; value: ResolvedRecipe } | { kind: "no_result" | "clarification"; trace: ExpandedToolTrace };

export class NutriGuardExpandedAgent {
  private readonly graph;

  public constructor(
    private readonly tools: NutriGuardToolset,
    private readonly alternativeRules: AlternativeRuleRepository = new InMemoryAlternativeRuleRepository([]),
    private readonly planner: ExpandedAgentPlanner = new RuleBasedExpandedAgentPlanner()
  ) {
    const safetyNode: typeof State.Node = (state) => {
      const flags = classifySafetyFlags(state.userMessage);
      const integrityFlags = classifyRequestIntegrity(state.userMessage);
      return { safetyFlags: flags, integrityFlags, route: flags.length > 0 || integrityFlags.length > 0 ? "blocked" : "pending" };
    };
    const planningNode: typeof State.Node = async (state) => {
      const raw = await this.planner.plan({ systemPrompt: NUTRIGUARD_SYSTEM_PROMPT, promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION, userMessage: state.userMessage, language: state.language });
      const parsed = ExpandedPlanSchema.safeParse(raw);
      return parsed.success && parsed.data.intent !== "unsupported"
        ? { plan: parsed.data, route: "execute" }
        : { plan: parsed.success ? parsed.data : null, route: "unsupported" };
    };
    const blockedNode: typeof State.Node = (state) => ({ response: this.blockedResponse(state) });
    const executeNode: typeof State.Node = async (state) => ({ response: await this.execute(state) });
    const unsupportedNode: typeof State.Node = (state) => ({ response: baseResponse(state, {}) });
    this.graph = new StateGraph(State)
      .addNode("safety", safetyNode)
      .addNode("planning", planningNode)
      .addNode("blocked_response", blockedNode)
      .addNode("execute_scenario", executeNode)
      .addNode("unsupported_response", unsupportedNode)
      .addEdge(START, "safety")
      .addConditionalEdges("safety", (state) => state.route === "blocked" ? "blocked_response" : "planning", ["blocked_response", "planning"])
      .addConditionalEdges("planning", (state) => state.route === "execute" ? "execute_scenario" : "unsupported_response", ["execute_scenario", "unsupported_response"])
      .addEdge("blocked_response", END)
      .addEdge("execute_scenario", END)
      .addEdge("unsupported_response", END)
      .compile({ name: "nutriguard_step13_expanded_agent" });
  }

  private blockedResponse(state: GraphState): ExpandedAgentResponse {
    const flags = state.safetyFlags as SafetyFlag[];
    const integrityFlags = state.integrityFlags as RequestIntegrityFlag[];
    if (integrityFlags.length > 0) return baseResponse(state, { status: "unsupported", primaryIntent: "unsupported_request", message: local(state.language, "مقدرش أتجاهل قواعد النظام أو أستخدم أرقام وبيانات غير معتمدة. اكتب سؤالك عن الأكل المصري من غير تعليمات لتجاوز مصادر NutriGuard.", "I cannot bypass system rules or use unapproved data or user-supplied nutrition numbers. Ask about verified Egyptian food without override instructions.") });
    if (flags.includes("emergency")) return baseResponse(state, { status: "emergency", primaryIntent: "medical_safety_request", message: local(state.language, "لو فيه خطر فوري اتصل بخدمات الطوارئ المحلية حالاً. مقدرش أقدم علاج طارئ.", "If there is immediate danger, contact local emergency services now. I cannot provide emergency treatment.") });
    if (flags.some((flag) => flag !== "religious_compliance_guarantee")) return baseResponse(state, { status: "refused", primaryIntent: "medical_safety_request", message: local(state.language, "مقدرش أقدم تشخيص أو علاج أو نظام شخصي. راجع طبيب أو أخصائي تغذية مرخص.", "I cannot provide diagnosis, treatment, or a personalized diet. Consult a licensed clinician or dietitian.") });
    return baseResponse(state, { status: "unsupported", primaryIntent: "unsupported_request", message: local(state.language, "مقدرش أضمن إن وصفة حلال أو كوشير؛ أقدر أعرض بس بيانات المصدر من غير ضمان.", "I cannot guarantee halal or kosher compliance; I can only report source-declared metadata without a guarantee.") });
  }

  private async resolveRecipe(query: string): Promise<Resolution> {
    const result = await this.tools.searchRecipes({ query, limit: 3 });
    const trace = { tool: "search_recipes", ok: result.ok, code: firstError(result) } satisfies ExpandedToolTrace;
    if (!result.ok || result.data.hits.length === 0) return { kind: "no_result", trace };
    const bestScore = result.data.hits[0]?.score;
    if (bestScore === undefined || !Number.isFinite(bestScore) || bestScore <= 0) return { kind: "no_result", trace };
    const confidenceBand = result.data.hits.filter((hit) => bestScore - hit.score <= 0.02);
    const candidates = new Map<string, typeof result.data.hits[number]>();
    for (const hit of confidenceBand) {
      const recipeId = hit.document.metadata.recipeId;
      if (typeof recipeId === "string" && recipeId.trim()) candidates.set(recipeId, hit);
    }
    if (candidates.size !== 1) return { kind: "clarification", trace };
    const [recipeId, hit] = [...candidates.entries()][0] ?? [];
    if (!recipeId || !hit) return { kind: "no_result", trace };
    return { kind: "ok", value: { recipeId, documentId: hit.document.id, provenance: [hit.provenance], trace } };
  }

  private async calculate(recipeId: string, basis: NutritionBasis): Promise<{ result: RecipeNutritionResult | null; trace: ExpandedToolTrace; provenance: ExpandedAgentProvenance[] }> {
    const tool = await this.tools.calculateNutrition({ recipeId, servingRequest: { bases: [basis] } });
    const trace = { tool: "calculate_nutrition", ok: tool.ok, code: firstError(tool) } satisfies ExpandedToolTrace;
    return tool.ok ? { result: tool.data, trace, provenance: tool.provenance } : { result: null, trace, provenance: [] };
  }

  private resolutionFailure(state: GraphState, resolution: Exclude<Resolution, { kind: "ok" }>, intent: ExpandedAgentResponse["primaryIntent"]): ExpandedAgentResponse {
    return baseResponse(state, {
      status: resolution.kind,
      primaryIntent: intent,
      message: resolution.kind === "clarification"
        ? local(state.language, "لقيت أكتر من وصفة محتملة؛ وضّح الاسم أكتر علشان ما اختارش بالتخمين.", "I found multiple recipes; clarify the name so I do not guess.")
        : local(state.language, "معنديش معلومة موثوقة كفاية عن ده دلوقتي.", "I do not have enough verified information about that right now."),
      toolTrace: [resolution.trace],
    });
  }

  private async execute(state: GraphState): Promise<ExpandedAgentResponse> {
    const plan = state.plan;
    if (!plan || plan.intent === "unsupported") return baseResponse(state, {});
    if (plan.intent === "general_guidance") return this.guidance(state, plan.topic);
    if (plan.intent === "compare_recipes") return this.compare(state, plan);
    if (plan.intent === "lighter_recipe") return this.alternative(state, plan);
    const resolution = await this.resolveRecipe(plan.recipeQuery);
    if (resolution.kind !== "ok") return this.resolutionFailure(state, resolution, "recipe_nutrition");
    const calculation = await this.calculate(resolution.value.recipeId, plan.basis);
    const sodium = calculation.result?.bases[plan.basis].nutrients.sodium.amount ?? null;
    if (!calculation.result || sodium === null || calculation.result.bases[plan.basis].basisStatus !== "available") return baseResponse(state, { status: "no_result", primaryIntent: "recipe_nutrition", message: local(state.language, "معنديش معلومة موثوقة كفاية عن الصوديوم دلوقتي.", "I do not have enough verified sodium information right now."), toolTrace: [resolution.value.trace, calculation.trace] });
    return baseResponse(state, {
      status: "ok", primaryIntent: "recipe_nutrition",
      message: local(state.language, `القيمة المعتمدة للصوديوم هي ${sodium} مجم على أساس ${plan.basis}. المعلومة عامة ومش نصيحة طبية.`, `Verified sodium is ${sodium} mg on the ${plan.basis} basis. This is general information, not medical advice.`),
      data: { recipeId: resolution.value.recipeId, basis: plan.basis, sodiumMg: sodium },
      evidenceDocumentIds: [resolution.value.documentId], provenance: [...resolution.value.provenance, ...calculation.provenance], toolTrace: [resolution.value.trace, calculation.trace],
    });
  }

  private async guidance(state: GraphState, topic: string): Promise<ExpandedAgentResponse> {
    const result = await this.tools.searchGuidelines({ query: topic, limit: 3 });
    const trace = { tool: "search_guidelines", ok: result.ok, code: firstError(result) } satisfies ExpandedToolTrace;
    if (!result.ok || result.data.hits.length === 0) return baseResponse(state, { status: "no_result", primaryIntent: "general_guidance", message: local(state.language, "معنديش إرشاد معتمد كفاية عن الموضوع ده دلوقتي.", "I do not have enough approved guidance on that topic right now."), toolTrace: [trace] });
    return baseResponse(state, {
      status: "ok", primaryIntent: "general_guidance",
      message: local(state.language, "دي نصوص الإرشاد المعتمدة المرتبطة بسؤالك زي ما هي من المصدر. المعلومات عامة ومش نصيحة طبية.", "These are the approved guidance passages related to your question, preserved from their sources. This is general information, not medical advice."),
      data: { passages: result.data.hits.map((hit) => ({ documentId: hit.document.id, title: hit.document.title, text: hit.document.text })) },
      evidenceDocumentIds: result.data.hits.map((hit) => hit.document.id), provenance: result.provenance, toolTrace: [trace],
    });
  }

  private async compare(state: GraphState, plan: Extract<ExpandedAgentPlan, { intent: "compare_recipes" }>): Promise<ExpandedAgentResponse> {
    const first = await this.resolveRecipe(plan.firstQuery);
    if (first.kind !== "ok") return this.resolutionFailure(state, first, "compare_recipes");
    const second = await this.resolveRecipe(plan.secondQuery);
    if (second.kind !== "ok") return this.resolutionFailure(state, second, "compare_recipes");
    if (first.value.recipeId === second.value.recipeId) return baseResponse(state, { status: "clarification", primaryIntent: "compare_recipes", message: local(state.language, "لازم تختار وصفتين مختلفتين للمقارنة.", "Choose two different recipes to compare."), toolTrace: [first.value.trace, second.value.trace] });
    const [firstCalc, secondCalc] = await Promise.all([this.calculate(first.value.recipeId, plan.basis), this.calculate(second.value.recipeId, plan.basis)]);
    if (!firstCalc.result || !secondCalc.result || firstCalc.result.bases[plan.basis].basisStatus !== "available" || secondCalc.result.bases[plan.basis].basisStatus !== "available") return baseResponse(state, { status: "no_result", primaryIntent: "compare_recipes", message: local(state.language, "مفيش أساس مشترك متاح للمقارنة من البيانات المعتمدة.", "No shared approved basis is available for comparison."), toolTrace: [first.value.trace, second.value.trace, firstCalc.trace, secondCalc.trace] });
    const nutrients = Object.fromEntries(SUPPORTED_NUTRIENTS.map((nutrient) => {
      const a = firstCalc.result?.bases[plan.basis].nutrients[nutrient].amount ?? null;
      const b = secondCalc.result?.bases[plan.basis].nutrients[nutrient].amount ?? null;
      return [nutrient, { first: a, second: b, difference: a === null || b === null ? null : b - a, unit: firstCalc.result?.bases[plan.basis].nutrients[nutrient].unit ?? secondCalc.result?.bases[plan.basis].nutrients[nutrient].unit }];
    }));
    return baseResponse(state, { status: "ok", primaryIntent: "compare_recipes", message: local(state.language, `دي مقارنة حتمية على نفس الأساس: ${plan.basis}. القيم الناقصة فضلت غير معروفة.`, `This deterministic comparison uses the same ${plan.basis} basis. Missing values remain unknown.`), data: { basis: plan.basis, firstRecipeId: first.value.recipeId, secondRecipeId: second.value.recipeId, nutrients }, evidenceDocumentIds: [first.value.documentId, second.value.documentId], provenance: [...first.value.provenance, ...second.value.provenance, ...firstCalc.provenance, ...secondCalc.provenance], toolTrace: [first.value.trace, second.value.trace, firstCalc.trace, secondCalc.trace] });
  }

  private async alternative(state: GraphState, plan: Extract<ExpandedAgentPlan, { intent: "lighter_recipe" }>): Promise<ExpandedAgentResponse> {
    const original = await this.resolveRecipe(plan.recipeQuery);
    if (original.kind !== "ok") return this.resolutionFailure(state, original, "lighter_recipe");
    const candidates = (await this.alternativeRules.listForRecipe(original.value.recipeId))
      .filter((rule) => rule.status === "approved" && rule.licenseStatus === "approved")
      .filter((rule) => plan.ruleId === undefined || rule.id === plan.ruleId)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (candidates.length === 0) return baseResponse(state, { status: "no_result", primaryIntent: "lighter_recipe", message: local(state.language, "مفيش قاعدة بديل أخف معتمدة للوصفة دي؛ مش هخترع تعديل.", "There is no approved lighter-alternative rule for this recipe; I will not invent a modification."), evidenceDocumentIds: [original.value.documentId], provenance: original.value.provenance, toolTrace: [original.value.trace] });
    if (candidates.length > 1 && plan.ruleId === undefined) return baseResponse(state, { status: "clarification", primaryIntent: "lighter_recipe", message: local(state.language, "فيه أكتر من قاعدة بديل معتمدة؛ لازم تحدد القاعدة.", "More than one approved alternative rule exists; specify the rule."), toolTrace: [original.value.trace] });
    const rule = candidates[0];
    if (!rule) return baseResponse(state, { status: "no_result", primaryIntent: "lighter_recipe" });
    const candidate = await this.resolveRecipe(rule.candidateQuery);
    if (candidate.kind !== "ok") return this.resolutionFailure(state, candidate, "lighter_recipe");
    if (candidate.value.recipeId !== rule.candidateRecipeId) return baseResponse(state, { status: "no_result", primaryIntent: "lighter_recipe", message: local(state.language, "قاعدة البديل مش مرتبطة بنتيجة البحث الحالية، فتم إيقاف الاقتراح.", "The alternative rule does not match the current search result, so the suggestion was blocked."), toolTrace: [original.value.trace, candidate.value.trace] });
    const [originalCalc, candidateCalc] = await Promise.all([this.calculate(original.value.recipeId, rule.basis), this.calculate(candidate.value.recipeId, rule.basis)]);
    const before = originalCalc.result?.bases[rule.basis].nutrients[rule.targetNutrient].amount ?? null;
    const after = candidateCalc.result?.bases[rule.basis].nutrients[rule.targetNutrient].amount ?? null;
    if (before === null || after === null || after >= before) return baseResponse(state, { status: "no_result", primaryIntent: "lighter_recipe", message: local(state.language, "البيانات المعتمدة ما أثبتتش إن البديل أخف على المعيار المحدد.", "Approved data did not prove that the alternative is lighter on the specified metric."), toolTrace: [original.value.trace, candidate.value.trace, originalCalc.trace, candidateCalc.trace] });
    const ruleProvenance = { sourceId: rule.sourceId, versionId: rule.versionId, title: rule.sourceTitle, url: rule.sourceUrl, accessedAt: null, locator: rule.id };
    return baseResponse(state, { status: "ok", primaryIntent: "lighter_recipe", message: local(state.language, `البديل المعتمد أقل في ${rule.targetNutrient}: ${after} بدل ${before} على أساس ${rule.basis}. ده بديل وصفة متحقق منها، مش تعديل مخترع.`, `The approved alternative is lower in ${rule.targetNutrient}: ${after} instead of ${before} on a ${rule.basis} basis. It is a verified alternative recipe, not an invented modification.`), data: { ruleId: rule.id, originalRecipeId: original.value.recipeId, alternativeRecipeId: candidate.value.recipeId, targetNutrient: rule.targetNutrient, basis: rule.basis, before, after }, evidenceDocumentIds: [original.value.documentId, candidate.value.documentId], provenance: [...original.value.provenance, ...candidate.value.provenance, ...originalCalc.provenance, ...candidateCalc.provenance, ruleProvenance], toolTrace: [original.value.trace, candidate.value.trace, originalCalc.trace, candidateCalc.trace] });
  }

  public async invoke(input: { message: string; language?: AgentLanguage }): Promise<ExpandedAgentResponse> {
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!message || message.length > 2_000) throw new Error("agent message must contain 1–2000 characters");
    const language = input.language ?? "ar-EG";
    if (!(["ar-EG", "ar", "en"] as const).includes(language)) throw new Error("unsupported agent language");
    const state = await this.graph.invoke({ userMessage: message, language });
    const parsed = ResponseSchema.safeParse(state.response);
    if (!parsed.success) throw new Error("expanded agent produced an invalid response");
    return parsed.data;
  }
}
