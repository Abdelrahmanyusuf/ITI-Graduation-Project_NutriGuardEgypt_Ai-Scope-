import assert from "node:assert/strict";
import test from "node:test";
import type { RecipeNutritionResult } from "../src/domain/nutrition.js";
import { ingestRetrievalCorpus, type RetrievalCorpus } from "../src/retrieval/ingestion.js";
import type { EmbeddingProvider } from "../src/retrieval/types.js";
import { InMemoryVectorStore } from "../src/retrieval/vector-store.js";
import { InMemoryGuidelineRuleRepository, NutriGuardTools, type GuidelineRule } from "../src/tools/nutriguard-tools.js";

class ToolEmbeddingProvider implements EmbeddingProvider {
  public readonly modelId = "SYNTHETIC-TOOL-MODEL";
  public async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => text.includes("sodium") || text.includes("صوديوم") ? [0, 1] : [1, 0]);
  }
}

const corpus: RetrievalCorpus = {
  schemaVersion: "1.0",
  corpusId: "SYNTHETIC-TOOLS",
  documents: [
    {
      id: "TEST-RECIPE", kind: "recipe", title: "Synthetic Egyptian recipe", text: "Fictional koshari search content", language: "en",
      status: "approved", licenseStatus: "approved", egyptianVerificationStatus: "verified",
      sourceId: "TEST-RECIPE-SOURCE", versionId: "TEST-V1", sourceTitle: "SYNTHETIC TEST ONLY", sourceUrl: "https://example.test/recipe",
      sourceAccessedAt: "2026-08-09", sourceLocator: "synthetic recipe fixture",
      metadata: { recipeId: "TEST-RECIPE" },
    },
    {
      id: "TEST-GUIDELINE", kind: "guideline", title: "Synthetic sodium guideline", text: "Fictional sodium prose", language: "en",
      status: "approved", licenseStatus: "approved",
      sourceId: "TEST-GUIDE-SOURCE", versionId: "TEST-V1", sourceTitle: "SYNTHETIC TEST ONLY", sourceUrl: "https://example.test/guideline",
      sourceAccessedAt: "2026-08-09", sourceLocator: "synthetic guideline fixture",
      metadata: { documentId: "TEST-DOC", chunkId: "TEST-CHUNK" },
    },
  ],
};

const sodiumRule: GuidelineRule = {
  id: "TEST-RULE-SODIUM-MAX",
  documentId: "TEST-DOC",
  chunkId: "TEST-CHUNK",
  metric: "sodium",
  operator: "maximum",
  minimum: null,
  maximum: 2000,
  target: null,
  unit: "mg",
  basis: "per_day",
  population: "synthetic general adult test population",
  status: "approved",
  licenseStatus: "approved",
  sourceId: "TEST-GUIDE-SOURCE",
  versionId: "TEST-V1",
  sourceTitle: "SYNTHETIC TEST ONLY",
  sourceUrl: "https://example.test/guideline",
  sourceAccessedAt: "2026-08-09",
  sourceLocator: "synthetic guideline rule",
};

function syntheticNutritionResult(status: "partial" | "unavailable" = "partial"): RecipeNutritionResult {
  return {
    recipeId: "TEST-RECIPE",
    calculationStatus: status,
    requestedBases: ["full_recipe"],
    servingCount: null,
    finalFoodWeightG: null,
    servingWeightG: null,
    bases: {
      full_recipe: { basis: "full_recipe", basisStatus: "available", reason: null, divisor: 1, weightG: null, nutrients: {} as RecipeNutritionResult["bases"]["full_recipe"]["nutrients"] },
      per_serving: { basis: "per_serving", basisStatus: "unavailable", reason: "missing_serving_count", divisor: null, weightG: null, nutrients: {} as RecipeNutritionResult["bases"]["per_serving"]["nutrients"] },
      per_100g: { basis: "per_100g", basisStatus: "unavailable", reason: "missing_yield_weight", divisor: null, weightG: null, nutrients: {} as RecipeNutritionResult["bases"]["per_100g"]["nutrients"] },
    },
    missingIngredients: [],
    assumptions: [],
    coverage: {} as RecipeNutritionResult["coverage"],
    provenance: [{ sourceId: "TEST-NUTRITION-SOURCE", versionId: "TEST-V1", roles: ["recipe"] }],
    trace: [],
    blockers: status === "unavailable" ? ["synthetic unavailable"] : [],
    roundingPolicy: {} as RecipeNutritionResult["roundingPolicy"],
  };
}

async function buildTools(rules: readonly GuidelineRule[] = [sodiumRule]): Promise<NutriGuardTools> {
  const embeddingProvider = new ToolEmbeddingProvider();
  const vectorStore = new InMemoryVectorStore();
  await ingestRetrievalCorpus(corpus, embeddingProvider, vectorStore);
  return new NutriGuardTools({
    embeddingProvider,
    vectorStore,
    corpusId: corpus.corpusId,
    calculateNutrition: async () => syntheticNutritionResult(),
    guidelineRules: new InMemoryGuidelineRuleRepository(rules),
  });
}

test("Step 10 search_recipes returns only verified Egyptian recipe records", async () => {
  const tools = await buildTools();
  const result = await tools.searchRecipes({ query: "عايز كشري", limit: 5 });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data.hits.map((hit) => hit.document.id), ["TEST-RECIPE"]);
});

test("Step 10 search_guidelines returns cited approved guideline prose", async () => {
  const tools = await buildTools();
  const result = await tools.searchGuidelines({ query: "إرشادات الصوديوم" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.data.hits.map((hit) => hit.document.id), ["TEST-GUIDELINE"]);
    assert.equal(result.provenance[0]?.url, "https://example.test/guideline");
  }
});

test("Step 10 calculate_nutrition delegates to deterministic Step 7 and fails closed when unavailable", async () => {
  const tools = await buildTools();
  const available = await tools.calculateNutrition({ recipeId: "TEST-RECIPE", servingRequest: { bases: ["full_recipe"] } });
  assert.equal(available.ok, true);
  const unavailableTools = new NutriGuardTools({
    embeddingProvider: new ToolEmbeddingProvider(),
    vectorStore: new InMemoryVectorStore(),
    corpusId: "TEST",
    calculateNutrition: async () => syntheticNutritionResult("unavailable"),
    guidelineRules: new InMemoryGuidelineRuleRepository([sodiumRule]),
  });
  const unavailable = await unavailableTools.calculateNutrition({ recipeId: "TEST-RECIPE", servingRequest: {} });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.errors[0]?.code, "nutrition_unavailable");
});

test("Step 10 compare_with_guideline uses exact approved structured rules and returns no medical advice", async () => {
  const tools = await buildTools();
  const under = await tools.compareWithGuideline({ nutrient: "sodium", amount: 1500, unit: "mg", basis: "per_day" });
  assert.equal(under.ok, true);
  if (under.ok) {
    assert.equal(under.data.relation, "within_limit");
    assert.equal(under.data.safetyNote, "general_guidance_only_not_medical_advice");
    assert.equal(under.provenance[0]?.sourceId, "TEST-GUIDE-SOURCE");
  }
  const above = await tools.compareWithGuideline({ nutrient: "sodium", amount: 2500, unit: "mg", basis: "per_day" });
  assert.equal(above.ok, true);
  if (above.ok) assert.equal(above.data.relation, "above_maximum");
});

test("Step 10 compare_with_guideline rejects pending, mismatched, ambiguous and negative comparisons", async () => {
  const pendingTools = await buildTools([{ ...sodiumRule, status: "pending" }]);
  const pending = await pendingTools.compareWithGuideline({ nutrient: "sodium", amount: 1, unit: "mg", basis: "per_day" });
  assert.equal(pending.ok, false);
  const mismatch = await (await buildTools()).compareWithGuideline({ nutrient: "sodium", amount: 1, unit: "g", basis: "per_day" });
  assert.equal(mismatch.ok, false);
  const ambiguousTools = await buildTools([sodiumRule, { ...sodiumRule, id: "TEST-RULE-SECOND" }]);
  const ambiguous = await ambiguousTools.compareWithGuideline({ nutrient: "sodium", amount: 1, unit: "mg", basis: "per_day" });
  assert.equal(ambiguous.ok, false);
  const negative = await (await buildTools()).compareWithGuideline({ nutrient: "sodium", amount: -1, unit: "mg", basis: "per_day" });
  assert.equal(negative.ok, false);
});
