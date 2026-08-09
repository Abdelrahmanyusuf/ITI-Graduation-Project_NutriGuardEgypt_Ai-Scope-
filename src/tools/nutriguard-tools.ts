import type { NutrientCode, RecipeNutritionResult, ServingRequest } from "../domain/nutrition.js";
import type { EmbeddingProvider, RetrievalSearchHit, VectorStore } from "../retrieval/types.js";

export const NUTRIGUARD_TOOL_NAMES = [
  "search_recipes",
  "search_guidelines",
  "calculate_nutrition",
  "compare_with_guideline",
] as const;

export type NutriGuardToolName = (typeof NUTRIGUARD_TOOL_NAMES)[number];

export interface ToolError {
  code: string;
  message: string;
}

export type ToolResult<T> =
  | { ok: true; data: T; errors: []; provenance: Array<{ sourceId: string; versionId: string; title: string | null; url: string | null; accessedAt: string | null; locator: string | null }> }
  | { ok: false; data: null; errors: ToolError[]; provenance: [] };

export interface GuidelineRule {
  id: string;
  documentId: string;
  chunkId: string;
  metric: NutrientCode;
  operator: "maximum" | "minimum" | "range" | "target";
  minimum: number | null;
  maximum: number | null;
  target: number | null;
  unit: "kcal" | "g" | "mg";
  basis: "per_day" | "per_serving" | "per_recipe" | "per_100g";
  population: string;
  status: "approved" | "pending" | "rejected";
  licenseStatus: "approved" | "pending" | "rejected";
  sourceId: string;
  versionId: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceAccessedAt: string;
  sourceLocator: string;
}

export interface GuidelineRuleRepository {
  listByMetric(metric: NutrientCode): Promise<GuidelineRule[]>;
}

export class InMemoryGuidelineRuleRepository implements GuidelineRuleRepository {
  public constructor(private readonly rules: readonly GuidelineRule[]) {}

  public async listByMetric(metric: NutrientCode): Promise<GuidelineRule[]> {
    return this.rules.filter((rule) => rule.metric === metric).map((rule) => structuredClone(rule));
  }
}

export interface NutriGuardToolDependencies {
  embeddingProvider: EmbeddingProvider;
  vectorStore: VectorStore;
  corpusId: string;
  calculateNutrition: (recipeId: string, servingRequest: ServingRequest) => Promise<RecipeNutritionResult>;
  guidelineRules: GuidelineRuleRepository;
}

export interface SearchToolInput {
  query: string;
  limit?: number;
  minScore?: number;
}

export interface SearchToolOutput {
  query: string;
  hits: RetrievalSearchHit[];
}

export interface CalculateNutritionToolInput {
  recipeId: string;
  servingRequest: ServingRequest;
}

export interface CompareWithGuidelineInput {
  nutrient: NutrientCode;
  amount: number;
  unit: "kcal" | "g" | "mg";
  basis: "per_day" | "per_serving" | "per_recipe" | "per_100g";
  ruleId?: string;
}

export interface GuidelineComparison {
  ruleId: string;
  nutrient: NutrientCode;
  amount: number;
  unit: "kcal" | "g" | "mg";
  basis: CompareWithGuidelineInput["basis"];
  relation: "within_limit" | "above_maximum" | "below_minimum" | "meets_target" | "differs_from_target";
  rule: Pick<GuidelineRule, "operator" | "minimum" | "maximum" | "target" | "population" | "documentId" | "chunkId">;
  safetyNote: "general_guidance_only_not_medical_advice";
}

const NUTRIENT_SET = new Set<NutrientCode>([
  "calories", "protein", "carbohydrate", "total_fat", "saturated_fat", "fiber", "sugar", "sodium",
]);

function failure<T>(code: string, message: string): ToolResult<T> {
  return { ok: false, data: null, errors: [{ code, message }], provenance: [] };
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateSearchInput(input: SearchToolInput): ToolError[] {
  const errors: ToolError[] = [];
  if (typeof input.query !== "string" || input.query.trim() === "") errors.push({ code: "invalid_query", message: "query is required" });
  const limit = input.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) errors.push({ code: "invalid_limit", message: "limit must be an integer from 1 to 20" });
  if (input.minScore !== undefined && (!Number.isFinite(input.minScore) || input.minScore < -1 || input.minScore > 1)) {
    errors.push({ code: "invalid_min_score", message: "minScore must be between -1 and 1" });
  }
  return errors;
}

function validateApprovedRule(rule: GuidelineRule): string | null {
  if (rule.status !== "approved" || rule.licenseStatus !== "approved") return "guideline rule/source is not approved";
  if (!rule.sourceId.trim() || !rule.versionId.trim() || !rule.sourceTitle.trim() || !validHttpUrl(rule.sourceUrl) || !rule.sourceAccessedAt.trim() || !rule.sourceLocator.trim()) return "guideline rule provenance is incomplete";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rule.sourceAccessedAt) || Number.isNaN(Date.parse(`${rule.sourceAccessedAt}T00:00:00Z`))) return "guideline rule access date is invalid";
  if (!rule.id.trim() || !rule.documentId.trim() || !rule.chunkId.trim() || !rule.population.trim()) return "guideline rule identity/context is incomplete";
  if (rule.operator === "maximum" && (rule.maximum === null || rule.minimum !== null || rule.target !== null)) return "invalid maximum rule shape";
  if (rule.operator === "minimum" && (rule.minimum === null || rule.maximum !== null || rule.target !== null)) return "invalid minimum rule shape";
  if (rule.operator === "target" && (rule.target === null || rule.minimum !== null || rule.maximum !== null)) return "invalid target rule shape";
  if (rule.operator === "range" && (rule.minimum === null || rule.maximum === null || rule.minimum > rule.maximum || rule.target !== null)) return "invalid range rule shape";
  const values = [rule.minimum, rule.maximum, rule.target].filter((value): value is number => value !== null);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return "guideline rule contains an impossible numerical value";
  return null;
}

export class NutriGuardTools {
  public constructor(private readonly dependencies: NutriGuardToolDependencies) {
    if (dependencies.corpusId.trim() === "") throw new Error("tool corpusId is required");
  }

  private async search(kind: "recipe" | "guideline", input: SearchToolInput): Promise<ToolResult<SearchToolOutput>> {
    const errors = validateSearchInput(input);
    if (errors.length > 0) return { ok: false, data: null, errors, provenance: [] };
    try {
      const vectors = await this.dependencies.embeddingProvider.embed([input.query.trim()]);
      const vector = vectors[0];
      if (!vector) return failure("embedding_unavailable", "embedding provider returned no query vector");
      const hits = await this.dependencies.vectorStore.search(this.dependencies.corpusId, vector, {
        kind,
        limit: input.limit ?? 5,
        minScore: input.minScore,
      });
      return {
        ok: true,
        data: { query: input.query, hits },
        errors: [],
        provenance: hits.map((hit) => hit.provenance),
      };
    } catch (error) {
      return failure("retrieval_failed", error instanceof Error ? error.message : String(error));
    }
  }

  public async searchRecipes(input: SearchToolInput): Promise<ToolResult<SearchToolOutput>> {
    return this.search("recipe", input);
  }

  public async searchGuidelines(input: SearchToolInput): Promise<ToolResult<SearchToolOutput>> {
    return this.search("guideline", input);
  }

  public async calculateNutrition(input: CalculateNutritionToolInput): Promise<ToolResult<RecipeNutritionResult>> {
    if (typeof input.recipeId !== "string" || input.recipeId.trim() === "") return failure("invalid_recipe_id", "recipeId is required");
    if (!input.servingRequest || typeof input.servingRequest !== "object") {
      return failure("invalid_serving_request", "servingRequest is required");
    }
    try {
      const result = await this.dependencies.calculateNutrition(input.recipeId.trim(), input.servingRequest);
      if (result.calculationStatus === "unavailable") return failure("nutrition_unavailable", result.blockers.join("; ") || "nutrition is unavailable");
      return {
        ok: true,
        data: result,
        errors: [],
        provenance: result.provenance.map((entry) => ({
          sourceId: entry.sourceId,
          versionId: entry.versionId,
          title: null,
          url: null,
          accessedAt: null,
          locator: null,
        })),
      };
    } catch (error) {
      return failure("nutrition_failed", error instanceof Error ? error.message : String(error));
    }
  }

  public async compareWithGuideline(input: CompareWithGuidelineInput): Promise<ToolResult<GuidelineComparison>> {
    if (!NUTRIENT_SET.has(input.nutrient)) return failure("invalid_nutrient", "unsupported nutrient code");
    if (!Number.isFinite(input.amount) || input.amount < 0) return failure("invalid_amount", "amount must be a finite non-negative number");
    if (!(["kcal", "g", "mg"] as const).includes(input.unit)) return failure("invalid_unit", "unit must be kcal, g or mg");
    if (!(["per_day", "per_serving", "per_recipe", "per_100g"] as const).includes(input.basis)) return failure("invalid_basis", "unsupported comparison basis");
    const candidates = (await this.dependencies.guidelineRules.listByMetric(input.nutrient))
      .filter((rule) => rule.unit === input.unit && rule.basis === input.basis)
      .filter((rule) => input.ruleId === undefined || rule.id === input.ruleId)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (candidates.length === 0) return failure("guideline_unavailable", "no exact structured guideline rule matches the nutrient, unit and basis");
    const rules = input.ruleId === undefined
      ? candidates.filter((rule) => rule.status === "approved" && rule.licenseStatus === "approved")
      : candidates;
    if (rules.length === 0) return failure("guideline_unavailable", "no approved structured guideline rule matches the nutrient, unit and basis");
    if (rules.length > 1 && input.ruleId === undefined) return failure("guideline_ambiguous", "multiple approved guideline rules match; ruleId is required");
    const rule = rules[0];
    if (!rule) return failure("guideline_unavailable", "guideline rule is unavailable");
    const issue = validateApprovedRule(rule);
    if (issue) return failure("guideline_not_approved", issue);
    let relation: GuidelineComparison["relation"];
    if (rule.operator === "maximum") relation = input.amount <= (rule.maximum ?? -1) ? "within_limit" : "above_maximum";
    else if (rule.operator === "minimum") relation = input.amount >= (rule.minimum ?? Number.POSITIVE_INFINITY) ? "within_limit" : "below_minimum";
    else if (rule.operator === "range") relation = input.amount >= (rule.minimum ?? Number.POSITIVE_INFINITY) && input.amount <= (rule.maximum ?? -1) ? "within_limit" : input.amount < (rule.minimum ?? 0) ? "below_minimum" : "above_maximum";
    else relation = input.amount === rule.target ? "meets_target" : "differs_from_target";
    return {
      ok: true,
      data: {
        ruleId: rule.id,
        nutrient: input.nutrient,
        amount: input.amount,
        unit: input.unit,
        basis: input.basis,
        relation,
        rule: {
          operator: rule.operator,
          minimum: rule.minimum,
          maximum: rule.maximum,
          target: rule.target,
          population: rule.population,
          documentId: rule.documentId,
          chunkId: rule.chunkId,
        },
        safetyNote: "general_guidance_only_not_medical_advice",
      },
      errors: [],
      provenance: [{
        sourceId: rule.sourceId,
        versionId: rule.versionId,
        title: rule.sourceTitle,
        url: rule.sourceUrl,
        accessedAt: rule.sourceAccessedAt,
        locator: rule.sourceLocator,
      }],
    };
  }
}

export const NUTRIGUARD_TOOL_DEFINITIONS = [
  { name: "search_recipes", description: "Search only approved, human-verified Egyptian recipe text. Never returns calculated nutrition." },
  { name: "search_guidelines", description: "Search only approved active guideline prose with citations." },
  { name: "calculate_nutrition", description: "Run the deterministic Step 7 nutrition calculator for a verified recipe." },
  { name: "compare_with_guideline", description: "Compare a sourced numeric result with one exact approved structured guideline rule; no medical advice." },
] as const;
