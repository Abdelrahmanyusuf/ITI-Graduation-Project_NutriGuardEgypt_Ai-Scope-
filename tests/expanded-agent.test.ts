import assert from "node:assert/strict";
import test from "node:test";
import type { RecipeNutritionResult } from "../src/domain/nutrition.js";
import {
  InMemoryAlternativeRuleRepository,
  NutriGuardExpandedAgent,
  RuleBasedExpandedAgentPlanner,
  type ExpandedAgentPlanner,
} from "../src/agent/expanded-agent.js";
import { ingestRetrievalCorpus, type RetrievalCorpus } from "../src/retrieval/ingestion.js";
import type { EmbeddingProvider } from "../src/retrieval/types.js";
import { InMemoryVectorStore } from "../src/retrieval/vector-store.js";
import { InMemoryGuidelineRuleRepository, NutriGuardTools } from "../src/tools/nutriguard-tools.js";

class KeywordEmbeddingProvider implements EmbeddingProvider {
  public readonly modelId = "SYNTHETIC-STEP13-MODEL";
  public async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => /كشري|koshari/iu.test(text) ? [1, 0, 0] : /ملوخية|molokhia/iu.test(text) ? [0, 1, 0] : [0, 0, 1]);
  }
}

const corpus: RetrievalCorpus = {
  schemaVersion: "1.0",
  corpusId: "SYNTHETIC-STEP13-CORPUS",
  documents: [
    {
      id: "DOC-KOSHARI", kind: "recipe", title: "كشري اصطناعي", text: "وصفة كشري اصطناعية للاختبار", language: "ar-EG",
      status: "approved", licenseStatus: "approved", egyptianVerificationStatus: "verified",
      sourceId: "SRC-RECIPE", versionId: "SYNTH-V1", sourceTitle: "SYNTHETIC TEST ONLY", sourceUrl: "https://example.test/koshari",
      sourceAccessedAt: "2026-08-09", sourceLocator: "synthetic koshari", metadata: { recipeId: "RECIPE-KOSHARI" },
    },
    {
      id: "DOC-MOLOKHIA", kind: "recipe", title: "ملوخية اصطناعية", text: "وصفة ملوخية اصطناعية للاختبار", language: "ar-EG",
      status: "approved", licenseStatus: "approved", egyptianVerificationStatus: "verified",
      sourceId: "SRC-RECIPE", versionId: "SYNTH-V1", sourceTitle: "SYNTHETIC TEST ONLY", sourceUrl: "https://example.test/molokhia",
      sourceAccessedAt: "2026-08-09", sourceLocator: "synthetic molokhia", metadata: { recipeId: "RECIPE-MOLOKHIA" },
    },
    {
      id: "DOC-PYRAMID", kind: "guideline", title: "هرم غذائي اصطناعي", text: "نص إرشادي اصطناعي: التنوع بين مجموعات الطعام مهم.", language: "ar-EG",
      status: "approved", licenseStatus: "approved",
      sourceId: "SRC-GUIDE", versionId: "SYNTH-V1", sourceTitle: "SYNTHETIC TEST ONLY", sourceUrl: "https://example.test/pyramid",
      sourceAccessedAt: "2026-08-09", sourceLocator: "synthetic pyramid passage", metadata: { chunkId: "CHUNK-PYRAMID" },
    },
  ],
};

function resultFor(recipeId: string): RecipeNutritionResult {
  const koshari = recipeId === "RECIPE-KOSHARI";
  const nutrient = (amount: number | null, unit: "kcal" | "g" | "mg") => ({ amount, knownSubtotal: amount ?? 0, unit, decimals: unit === "g" ? 1 : 0 });
  const nutrients = {
    calories: nutrient(koshari ? 600 : 300, "kcal"), protein: nutrient(koshari ? 20 : 25, "g"),
    carbohydrate: nutrient(koshari ? 100 : 20, "g"), total_fat: nutrient(koshari ? 18 : 8, "g"),
    saturated_fat: nutrient(null, "g"), fiber: nutrient(koshari ? 12 : 9, "g"), sugar: nutrient(null, "g"),
    sodium: nutrient(koshari ? 700 : 400, "mg"),
  };
  const makeBasis = (basis: "full_recipe" | "per_serving" | "per_100g") => ({ basis, basisStatus: "available" as const, reason: null, divisor: 1, weightG: 100, nutrients });
  return {
    recipeId, calculationStatus: "complete", requestedBases: ["full_recipe", "per_serving", "per_100g"],
    servingCount: 1, finalFoodWeightG: 100, servingWeightG: 100,
    bases: { full_recipe: makeBasis("full_recipe"), per_serving: makeBasis("per_serving"), per_100g: makeBasis("per_100g") },
    missingIngredients: [], assumptions: [], coverage: {} as RecipeNutritionResult["coverage"],
    provenance: [{ sourceId: "SRC-NUTRITION", versionId: "SYNTH-V1", roles: ["nutrition"] }], trace: [], blockers: [],
    roundingPolicy: {} as RecipeNutritionResult["roundingPolicy"],
  };
}

async function buildTools(): Promise<NutriGuardTools> {
  const provider = new KeywordEmbeddingProvider();
  const store = new InMemoryVectorStore();
  await ingestRetrievalCorpus(corpus, provider, store);
  return new NutriGuardTools({
    embeddingProvider: provider, vectorStore: store, corpusId: corpus.corpusId,
    calculateNutrition: async (recipeId) => resultFor(recipeId),
    guidelineRules: new InMemoryGuidelineRuleRepository([]),
  });
}

const planner = (value: unknown): ExpandedAgentPlanner => ({ plan: async () => value });

test("Step 13 compares two verified recipes on one shared deterministic basis", async () => {
  const agent = new NutriGuardExpandedAgent(await buildTools(), undefined, planner({ intent: "compare_recipes", firstQuery: "كشري", secondQuery: "ملوخية", basis: "per_100g" }));
  const response = await agent.invoke({ message: "قارن بين الكشري والملوخية لكل 100 جرام" });
  assert.equal(response.status, "ok");
  assert.equal(response.primaryIntent, "compare_recipes");
  const nutrients = response.data?.nutrients as Record<string, { first: number; second: number; difference: number }>;
  assert.deepEqual(nutrients.sodium, { first: 700, second: 400, difference: -300, unit: "mg" });
  assert.deepEqual(response.evidenceDocumentIds, ["DOC-KOSHARI", "DOC-MOLOKHIA"]);
  assert.equal(response.toolTrace.filter((entry) => entry.tool === "calculate_nutrition").length, 2);
});

test("Step 13 returns approved food-pyramid source text without inventing guidance", async () => {
  const agent = new NutriGuardExpandedAgent(await buildTools(), undefined, planner({ intent: "general_guidance", topic: "الهرم الغذائي" }));
  const response = await agent.invoke({ message: "فهمني الهرم الغذائي" });
  assert.equal(response.status, "ok");
  assert.equal(response.primaryIntent, "general_guidance");
  const passages = response.data?.passages as Array<{ documentId: string; text: string }>;
  assert.equal(passages[0]?.text, "نص إرشادي اصطناعي: التنوع بين مجموعات الطعام مهم.");
  assert.deepEqual(response.evidenceDocumentIds, ["DOC-PYRAMID"]);
  assert.equal(response.provenance[0]?.sourceId, "SRC-GUIDE");
});

test("Step 13 suggests a verified healthier alternative only through an approved rule and proven lower value", async () => {
  const rules = new InMemoryAlternativeRuleRepository([{
    id: "RULE-LIGHTER-1", fromRecipeId: "RECIPE-KOSHARI", candidateRecipeId: "RECIPE-MOLOKHIA", candidateQuery: "ملوخية",
    targetNutrient: "calories", basis: "per_100g", status: "approved", licenseStatus: "approved",
    sourceId: "SRC-RULE", versionId: "SYNTH-V1", sourceTitle: "SYNTHETIC TEST ONLY", sourceUrl: "https://example.test/rule",
  }]);
  const agent = new NutriGuardExpandedAgent(await buildTools(), rules, planner({ intent: "lighter_recipe", recipeQuery: "كشري" }));
  const response = await agent.invoke({ message: "اقترح بديل أخف للكشري" });
  assert.equal(response.status, "ok");
  assert.equal(response.primaryIntent, "lighter_recipe");
  assert.equal(response.data?.before, 600);
  assert.equal(response.data?.after, 300);
  assert.equal(response.data?.ruleId, "RULE-LIGHTER-1");
});

test("Step 13 refuses to invent a healthier alternative when no approved rule exists", async () => {
  const agent = new NutriGuardExpandedAgent(await buildTools(), new InMemoryAlternativeRuleRepository([]), planner({ intent: "lighter_recipe", recipeQuery: "كشري" }));
  const response = await agent.invoke({ message: "هات بديل صحي للكشري" });
  assert.equal(response.status, "no_result");
  assert.match(response.message, /مش هخترع/u);
  assert.equal(response.toolTrace.some((entry) => entry.tool === "calculate_nutrition"), false);
});

test("Step 13 default planner recognizes the three expanded scenario shapes", async () => {
  const subject = new RuleBasedExpandedAgentPlanner();
  const common = { systemPrompt: "calculate_nutrition", promptVersion: "1.2.0", language: "ar-EG" as const };
  assert.equal((await subject.plan({ ...common, userMessage: "قارن بين كشري وملوخية لكل 100 جرام" }) as { intent: string }).intent, "compare_recipes");
  assert.equal((await subject.plan({ ...common, userMessage: "اقترح بديل أخف للكشري" }) as { intent: string }).intent, "lighter_recipe");
  assert.equal((await subject.plan({ ...common, userMessage: "اشرحلي الهرم الغذائي" }) as { intent: string }).intent, "general_guidance");
});
