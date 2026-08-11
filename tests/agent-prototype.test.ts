import assert from "node:assert/strict";
import test from "node:test";
import type { RecipeNutritionResult } from "../src/domain/nutrition.js";
import { InMemoryVectorStore } from "../src/retrieval/vector-store.js";
import { ingestRetrievalCorpus, type RetrievalCorpus } from "../src/retrieval/ingestion.js";
import type { EmbeddingProvider } from "../src/retrieval/types.js";
import {
  NutriGuardSodiumPrototypeAgent,
  type SodiumScenarioPlanner,
} from "../src/agent/sodium-prototype.js";
import { classifySafetyFlags } from "../src/agent/safety.js";
import { NUTRIGUARD_SYSTEM_PROMPT } from "../src/agent/system-prompt.js";
import { InMemoryGuidelineRuleRepository, NutriGuardTools } from "../src/tools/nutriguard-tools.js";

class ConstantEmbeddingProvider implements EmbeddingProvider {
  public readonly modelId = "SYNTHETIC-AGENT-TEST-MODEL";
  public async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map(() => [1, 0]);
  }
}

function corpus(recipeCount = 1): RetrievalCorpus {
  return {
    schemaVersion: "1.0",
    corpusId: "SYNTHETIC-AGENT-CORPUS",
    documents: Array.from({ length: recipeCount }, (_, index) => ({
      id: `SYNTHETIC-RECIPE-DOC-${index + 1}`,
      kind: "recipe" as const,
      title: index === 0 ? "كشري تجريبي" : "كشري تجريبي آخر",
      text: "نص اصطناعي لاختبار مسار الوكيل فقط",
      language: "ar-EG" as const,
      status: "approved" as const,
      licenseStatus: "approved" as const,
      egyptianVerificationStatus: "verified" as const,
      sourceId: "SYNTHETIC-AGENT-SOURCE",
      versionId: "SYNTHETIC-V1",
      sourceTitle: "SYNTHETIC TEST ONLY",
      sourceUrl: "https://example.test/agent-recipe",
      sourceAccessedAt: "2026-08-09",
      sourceLocator: `synthetic recipe ${index + 1}`,
      metadata: { recipeId: `SYNTHETIC-RECIPE-${index + 1}` },
    })),
  };
}

function nutritionResult(
  recipeId: string,
  options: { status?: "unavailable" | "partial" | "complete"; sodium?: number | null } = {}
): RecipeNutritionResult {
  const status = options.status ?? "complete";
  const sodium = options.sodium === undefined ? 640 : options.sodium;
  const nutrient = (amount: number | null, unit: "kcal" | "g" | "mg") => ({ amount, knownSubtotal: amount ?? 0, unit, decimals: unit === "mg" || unit === "kcal" ? 0 : 1 });
  const nutrients = {
    calories: nutrient(500, "kcal"),
    protein: nutrient(20, "g"),
    carbohydrate: nutrient(70, "g"),
    total_fat: nutrient(12, "g"),
    saturated_fat: nutrient(null, "g"),
    fiber: nutrient(8, "g"),
    sugar: nutrient(null, "g"),
    sodium: nutrient(sodium, "mg"),
  };
  const basis = (name: "full_recipe" | "per_serving" | "per_100g") => ({
    basis: name,
    basisStatus: status === "unavailable" ? "unavailable" as const : "available" as const,
    reason: status === "unavailable" ? "synthetic_unavailable" : null,
    divisor: status === "unavailable" ? null : 1,
    weightG: 500,
    nutrients,
  });
  return {
    recipeId,
    calculationStatus: status,
    requestedBases: ["full_recipe"],
    servingCount: 2,
    finalFoodWeightG: 500,
    servingWeightG: 250,
    bases: {
      full_recipe: basis("full_recipe"),
      per_serving: basis("per_serving"),
      per_100g: basis("per_100g"),
    },
    missingIngredients: [],
    assumptions: [],
    coverage: {} as RecipeNutritionResult["coverage"],
    provenance: [{ sourceId: "SYNTHETIC-NUTRITION-SOURCE", versionId: "SYNTHETIC-V1", roles: ["nutrition"] }],
    trace: [],
    blockers: status === "unavailable" ? ["synthetic unavailable"] : [],
    roundingPolicy: {} as RecipeNutritionResult["roundingPolicy"],
  };
}

async function toolsFor(
  recipeCount: number,
  calculate: (recipeId: string) => Promise<RecipeNutritionResult>
): Promise<NutriGuardTools> {
  const provider = new ConstantEmbeddingProvider();
  const store = new InMemoryVectorStore();
  if (recipeCount > 0) await ingestRetrievalCorpus(corpus(recipeCount), provider, store);
  return new NutriGuardTools({
    embeddingProvider: provider,
    vectorStore: store,
    corpusId: "SYNTHETIC-AGENT-CORPUS",
    calculateNutrition: async (recipeId) => calculate(recipeId),
    guidelineRules: new InMemoryGuidelineRuleRepository([]),
  });
}

test("Step 11 prompt defines Egyptian Arabic, deterministic numbers, safety, and no-result behavior", () => {
  assert.match(NUTRIGUARD_SYSTEM_PROMPT, /العامية المصرية/u);
  assert.match(NUTRIGUARD_SYSTEM_PROMPT, /ممنوع تحسب/u);
  assert.match(NUTRIGUARD_SYSTEM_PROMPT, /ما تشخّصش/u);
  assert.match(NUTRIGUARD_SYSTEM_PROMPT, /معنديش معلومة موثوقة كفاية/u);
  assert.match(NUTRIGUARD_SYSTEM_PROMPT, /search_recipes/u);
  assert.match(NUTRIGUARD_SYSTEM_PROMPT, /calculate_nutrition/u);
  assert.match(NUTRIGUARD_SYSTEM_PROMPT, /كل رسالة مستخدم صالحة/u);
  assert.match(NUTRIGUARD_SYSTEM_PROMPT, /نصوص RAG/u);
  assert.match(NUTRIGUARD_SYSTEM_PROMPT, /fallback المحلي/u);
  assert.match(NUTRIGUARD_SYSTEM_PROMPT, /candidate أو needs_review/u);
});

test("Step 11 safety classification preserves emergency and medical override precedence", () => {
  assert.deepEqual(classifySafetyFlags("مش قادر اتنفس وعايز صوديوم الكشري"), ["emergency"]);
  assert.ok(classifySafetyFlags("عندي سكر، آكل إيه؟").includes("medical_advice_request"));
  assert.ok(classifySafetyFlags("الوصفة دي آمنة 100% للحساسية؟").includes("allergen_safety_guarantee"));
  assert.ok(classifySafetyFlags("هل ده حلال مضمون 100%؟").includes("religious_compliance_guarantee"));
  assert.deepEqual(classifySafetyFlags("عايز أكل دايت مصري عادي"), [], "a general diet request is not automatically a medical condition");
});

test("Step 12 LangGraph prototype searches one verified recipe then reports only deterministic sodium", async () => {
  let calculatedRecipeId: string | null = null;
  const tools = await toolsFor(1, async (recipeId) => {
    calculatedRecipeId = recipeId;
    return nutritionResult(recipeId);
  });
  const response = await new NutriGuardSodiumPrototypeAgent(tools).invoke({ message: "احسبلي صوديوم وصفة الكشري" });
  assert.equal(response.status, "ok");
  assert.equal(response.facts?.sodiumMg, 640);
  assert.equal(response.facts?.recipeId, "SYNTHETIC-RECIPE-1");
  assert.equal(calculatedRecipeId, "SYNTHETIC-RECIPE-1");
  assert.deepEqual(response.toolTrace.map((entry) => entry.tool), ["search_recipes", "calculate_nutrition"]);
  assert.deepEqual(response.provenance.map((entry) => entry.sourceId), ["SYNTHETIC-AGENT-SOURCE", "SYNTHETIC-NUTRITION-SOURCE"]);
  assert.ok(!response.message.includes("undefined"));
});

test("Step 12 asks for clarification instead of guessing between recipe matches", async () => {
  let calculationCalls = 0;
  const tools = await toolsFor(2, async (recipeId) => {
    calculationCalls += 1;
    return nutritionResult(recipeId);
  });
  const response = await new NutriGuardSodiumPrototypeAgent(tools).invoke({ message: "صوديوم الكشري" });
  assert.equal(response.status, "clarification");
  assert.equal(calculationCalls, 0);
  assert.deepEqual(response.toolTrace.map((entry) => entry.tool), ["search_recipes"]);
});

test("Step 12 no-result and null sodium stay unknown and never become zero", async () => {
  const noRecipe = await new NutriGuardSodiumPrototypeAgent(await toolsFor(0, async (id) => nutritionResult(id))).invoke({ message: "صوديوم وصفة مش موجودة" });
  assert.equal(noRecipe.status, "no_result");
  const nullSodium = await new NutriGuardSodiumPrototypeAgent(await toolsFor(1, async (id) => nutritionResult(id, { status: "partial", sodium: null }))).invoke({ message: "صوديوم الكشري" });
  assert.equal(nullSodium.status, "no_result");
  assert.equal(nullSodium.facts, null);
  assert.ok(!nullSodium.message.includes("0 مجم"));
});

test("Step 12 safety routes before planner or tools and religious guarantees are non-medical refusals", async () => {
  let plannerCalls = 0;
  const planner: SodiumScenarioPlanner = { plan: async () => { plannerCalls += 1; return { intent: "recipe_sodium", recipeQuery: "كشري", basis: "full_recipe" }; } };
  const agent = new NutriGuardSodiumPrototypeAgent(await toolsFor(1, async (id) => nutritionResult(id)), planner);
  const emergency = await agent.invoke({ message: "مش قادر اتنفس وعندي سكر، احسب صوديوم الكشري" });
  assert.equal(emergency.status, "emergency");
  assert.ok(emergency.safetyFlags.includes("medical_advice_request"));
  assert.equal(plannerCalls, 0);
  assert.deepEqual(emergency.toolTrace, []);
  const religious = await agent.invoke({ message: "هل الكشري حلال مضمون 100%؟" });
  assert.equal(religious.primaryIntent, "unsupported_request");
  assert.ok(!religious.message.includes("طبيب"));
  const allergen = await agent.invoke({ message: "هل الكشري آمن 100% للحساسية؟" });
  assert.equal(allergen.primaryIntent, "medical_safety_request");
  assert.equal(allergen.status, "refused");
});

test("Step 12 rejects an out-of-scope planner action and invalid public input", async () => {
  const maliciousPlanner: SodiumScenarioPlanner = { plan: async () => ({ intent: "compare_recipes", sql: "DROP TABLE recipes" }) };
  const agent = new NutriGuardSodiumPrototypeAgent(await toolsFor(1, async (id) => nutritionResult(id)), maliciousPlanner);
  const response = await agent.invoke({ message: "قارن الوصفات" });
  assert.equal(response.status, "unsupported");
  assert.deepEqual(response.toolTrace, []);
  await assert.rejects(() => agent.invoke({ message: "" }), /1–2000/);
  await assert.rejects(() => agent.invoke({ message: "hello", language: "fr" as "en" }), /unsupported agent language/);
});
