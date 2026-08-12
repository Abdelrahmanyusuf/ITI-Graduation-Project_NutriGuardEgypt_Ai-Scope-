import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildGraduationRetrievalCorpus,
  calculateUnifiedDemoNutrition,
  loadUnifiedEgyptianDemoDataset,
  resolveDemoQuestionRecipe,
} from "../demo/unified-egyptian-dataset.js";
import { ingestRetrievalCorpus, ingestionEligibleCorpus } from "../retrieval/ingestion.js";
import { InMemoryVectorStore } from "../retrieval/vector-store.js";
import { GraduationDemoEmbeddingProvider } from "../runtime/graduation-demo-agent.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const dataset = await loadUnifiedEgyptianDemoDataset();
  const corpus = buildGraduationRetrievalCorpus(dataset);
  const output = path.resolve("data", "demo");
  await mkdir(output, { recursive: true });
  const nutrition = dataset.recipes.map((recipe) => ({
    recipeId: recipe.recipe_id,
    nameEn: recipe.name_en,
    nameAr: recipe.name_ar,
    reviewStatus: recipe.status,
    calculation: calculateUnifiedDemoNutrition(dataset, recipe),
  }));
  const resolvedQuestions = dataset.questions.map((question) => ({
    id: question.id,
    question: question.question,
    category: question.category,
    expectedOutcome: question.expected_outcome,
    expectedRecipeText: question.expected_recipe,
    relevantRecipeId: resolveDemoQuestionRecipe(dataset, question.expected_recipe),
    synthetic: question.consent_source === "synthetic_egyptian_dialect",
    reviewStatus: question.approval_reference,
  }));
  const evaluation = {
    schemaVersion: "1.0",
    title: "NutriGuard Egyptian graduation-demo retrieval evaluation",
    language: "ar-EG",
    synthetic: true,
    documents: corpus.documents.filter((document) => document.kind === "recipe").map((document) => ({ id: document.id, text: `${document.title}\n\n${document.text}` })),
    queries: resolvedQuestions.filter((question) => question.relevantRecipeId !== null).map((question) => ({ id: question.id, text: question.question, relevantDocumentIds: [`DEMO-${question.relevantRecipeId}`] })),
  };
  const provider = new GraduationDemoEmbeddingProvider();
  const store = new InMemoryVectorStore();
  await ingestRetrievalCorpus(ingestionEligibleCorpus(corpus), provider, store);
  let hitsAt1 = 0;
  let hitsAt3 = 0;
  let reciprocalRank = 0;
  for (const query of evaluation.queries) {
    const vector = (await provider.embed([query.text]))[0] ?? [];
    const hits = await store.search(corpus.corpusId, vector, { kind: "recipe", limit: 5 });
    const relevant = new Set(query.relevantDocumentIds);
    const rank = hits.findIndex((hit) => relevant.has(hit.document.id));
    if (rank === 0) hitsAt1 += 1;
    if (rank >= 0 && rank < 3) hitsAt3 += 1;
    if (rank >= 0) reciprocalRank += 1 / (rank + 1);
  }
  const evaluated = evaluation.queries.length;
  const retrievalEvaluation = {
    modelId: provider.modelId,
    synthetic: true,
    queryCount: evaluated,
    recallAt1: evaluated === 0 ? null : Number((hitsAt1 / evaluated).toFixed(4)),
    recallAt3: evaluated === 0 ? null : Number((hitsAt3 / evaluated).toFixed(4)),
    mrrAt5: evaluated === 0 ? null : Number((reciprocalRank / evaluated).toFixed(4)),
    productionModelSelectionAllowed: false,
  };
  const frying = nutrition.filter((item) => item.calculation.excludedFryingOilG > 0);
  const report = {
    schemaVersion: "1.0",
    datasetVersion: dataset.metadata.version,
    mode: "graduation_demo_only",
    reviewStatus: dataset.metadata.review_status,
    recipeCount: dataset.recipes.length,
    ingredientReferenceCount: Object.keys(dataset.ingredientNutrition).length,
    retrievalDocumentCount: corpus.documents.length,
    syntheticQuestionCount: dataset.questions.length,
    resolvedQuestionCount: resolvedQuestions.filter((question) => question.relevantRecipeId !== null).length,
    retrievalEvaluation,
    unresolvedQuestions: resolvedQuestions.filter((question) => question.relevantRecipeId === null).map((question) => ({ id: question.id, expectedRecipeText: question.expectedRecipeText })),
    friedRecipeCorrection: {
      correctedRecipeCount: frying.length,
      policy: "exclude bulk frying oil and add only declared fraction of that oil as absorbed",
      examples: frying.slice(0, 10).map((item) => ({ recipeId: item.recipeId, excludedFryingOilG: item.calculation.excludedFryingOilG, absorbedFryingOilG: item.calculation.absorbedFryingOilG, correctedKcal: item.calculation.totals.kcal })),
    },
    warnings: [
      "All recipes are verified for the NutriGuard graduation-project recipeSource and remain development/test only.",
      "Nutrition references and conversion factors are estimates until human review.",
      "The 80 questions are synthetic and cannot select a production embedding model.",
      "Production ingestion and release gates remain unchanged.",
    ],
  };
  const files: Array<[string, unknown]> = [
    ["retrieval-corpus.demo.json", corpus],
    ["nutrition-calculations.demo.json", nutrition],
    ["embedding-evaluation.synthetic.json", evaluation],
    ["questions-resolution.demo.json", resolvedQuestions],
    ["graduation-demo-report.json", report],
  ];
  for (const [name, value] of files) {
    const json = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(path.join(output, name), json, "utf8");
  }
  const contentHash = sha256(JSON.stringify({ corpus, nutrition, evaluation, resolvedQuestions, report }));
  console.log(`graduation demo prepared: recipes=${report.recipeCount}, documents=${report.retrievalDocumentCount}, questions=${report.resolvedQuestionCount}/${report.syntheticQuestionCount}, friedFixed=${frying.length}, hash=${contentHash}`);
}

await main().catch((error: unknown) => {
  console.error(`graduation demo preparation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
