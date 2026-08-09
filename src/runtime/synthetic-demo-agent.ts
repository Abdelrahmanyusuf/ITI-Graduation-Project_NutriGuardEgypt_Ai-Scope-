import type { RecipeNutritionResult } from "../domain/nutrition.js";
import { InMemoryAlternativeRuleRepository, NutriGuardExpandedAgent } from "../agent/expanded-agent.js";
import { ingestRetrievalCorpus, type RetrievalCorpus } from "../retrieval/ingestion.js";
import type { EmbeddingProvider } from "../retrieval/types.js";
import { InMemoryVectorStore } from "../retrieval/vector-store.js";
import { InMemoryGuidelineRuleRepository, NutriGuardTools } from "../tools/nutriguard-tools.js";

class SyntheticDemoEmbeddingProvider implements EmbeddingProvider {
  public readonly modelId = "SYNTHETIC-DEMO-NOT-FOR-PRODUCTION";
  public async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => /كشري|koshari/iu.test(text) ? [1, 0, 0] : /ملوخية|molokhia/iu.test(text) ? [0, 1, 0] : /هرم|pyramid/iu.test(text) ? [0, 0, 1] : [0.01, 0.01, 0.01]);
  }
}

const corpus: RetrievalCorpus = {
  schemaVersion: "1.0",
  corpusId: "SYNTHETIC-DEMO-CORPUS-NOT-FOR-PRODUCTION",
  documents: [
    { id: "DOC-KOSHARI", kind: "recipe", title: "كشري اصطناعي", text: "وصفة كشري اصطناعية", language: "ar-EG", status: "approved", licenseStatus: "approved", egyptianVerificationStatus: "verified", sourceId: "SRC-RECIPE", versionId: "SYNTH-V1", sourceTitle: "SYNTHETIC TEST ONLY", sourceUrl: "https://example.test/koshari", sourceAccessedAt: "2026-08-09", sourceLocator: "synthetic koshari", metadata: { recipeId: "RECIPE-KOSHARI" } },
    { id: "DOC-MOLOKHIA", kind: "recipe", title: "ملوخية اصطناعية", text: "وصفة ملوخية اصطناعية", language: "ar-EG", status: "approved", licenseStatus: "approved", egyptianVerificationStatus: "verified", sourceId: "SRC-RECIPE", versionId: "SYNTH-V1", sourceTitle: "SYNTHETIC TEST ONLY", sourceUrl: "https://example.test/molokhia", sourceAccessedAt: "2026-08-09", sourceLocator: "synthetic molokhia", metadata: { recipeId: "RECIPE-MOLOKHIA" } },
    { id: "DOC-PYRAMID", kind: "guideline", title: "هرم غذائي اصطناعي", text: "نص إرشادي اصطناعي: التنوع بين مجموعات الطعام مهم.", language: "ar-EG", status: "approved", licenseStatus: "approved", sourceId: "SRC-GUIDE", versionId: "SYNTH-V1", sourceTitle: "SYNTHETIC TEST ONLY", sourceUrl: "https://example.test/pyramid", sourceAccessedAt: "2026-08-09", sourceLocator: "synthetic pyramid", metadata: { chunkId: "CHUNK-PYRAMID" } },
  ],
};

function syntheticNutrition(recipeId: string): RecipeNutritionResult {
  const first = recipeId === "RECIPE-KOSHARI";
  const nutrient = (amount: number | null, unit: "kcal" | "g" | "mg") => ({ amount, knownSubtotal: amount ?? 0, unit, decimals: unit === "g" ? 1 : 0 });
  const nutrients = {
    calories: nutrient(first ? 600 : 300, "kcal"), protein: nutrient(first ? 20 : 25, "g"), carbohydrate: nutrient(first ? 100 : 20, "g"),
    total_fat: nutrient(first ? 18 : 8, "g"), saturated_fat: nutrient(null, "g"), fiber: nutrient(first ? 12 : 9, "g"), sugar: nutrient(null, "g"), sodium: nutrient(first ? 700 : 400, "mg"),
  };
  const basis = (name: "full_recipe" | "per_serving" | "per_100g") => ({ basis: name, basisStatus: "available" as const, reason: null, divisor: 1, weightG: 100, nutrients });
  return { recipeId, calculationStatus: "complete", requestedBases: ["full_recipe", "per_serving", "per_100g"], servingCount: 1, finalFoodWeightG: 100, servingWeightG: 100, bases: { full_recipe: basis("full_recipe"), per_serving: basis("per_serving"), per_100g: basis("per_100g") }, missingIngredients: [], assumptions: [], coverage: {} as RecipeNutritionResult["coverage"], provenance: [{ sourceId: "SRC-NUTRITION", versionId: "SYNTH-V1", roles: ["nutrition"] }], trace: [], blockers: [], roundingPolicy: {} as RecipeNutritionResult["roundingPolicy"] };
}

export async function buildSyntheticDemoAgent(nodeEnv: "development" | "test"): Promise<NutriGuardExpandedAgent> {
  if (nodeEnv !== "development" && nodeEnv !== "test") throw new Error("synthetic demo agent is forbidden outside development/test");
  const embeddingProvider = new SyntheticDemoEmbeddingProvider();
  const vectorStore = new InMemoryVectorStore();
  await ingestRetrievalCorpus(corpus, embeddingProvider, vectorStore);
  const tools = new NutriGuardTools({ embeddingProvider, vectorStore, corpusId: corpus.corpusId, calculateNutrition: async (recipeId) => syntheticNutrition(recipeId), guidelineRules: new InMemoryGuidelineRuleRepository([]) });
  const rules = new InMemoryAlternativeRuleRepository([{ id: "RULE-LIGHTER-1", fromRecipeId: "RECIPE-KOSHARI", candidateRecipeId: "RECIPE-MOLOKHIA", candidateQuery: "ملوخية", targetNutrient: "calories", basis: "per_100g", status: "approved", licenseStatus: "approved", sourceId: "SRC-RULE", versionId: "SYNTH-V1", sourceTitle: "SYNTHETIC TEST ONLY", sourceUrl: "https://example.test/rule" }]);
  return new NutriGuardExpandedAgent(tools, rules);
}
