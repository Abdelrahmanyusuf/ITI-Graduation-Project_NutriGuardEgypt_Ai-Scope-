import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGraduationRetrievalCorpus,
  calculateUnifiedDemoNutrition,
  loadUnifiedEgyptianDemoDataset,
  resolveDemoQuestionRecipe,
  toRecipeNutritionResult,
} from "../src/demo/unified-egyptian-dataset.js";
import { buildGraduationDemoAgent } from "../src/runtime/graduation-demo-agent.js";

const dataset = await loadUnifiedEgyptianDemoDataset();

test("graduation dataset validates the complete candidate corpus without production approval", () => {
  assert.equal(dataset.recipes.length, 215);
  assert.equal(Object.keys(dataset.ingredientNutrition).length, 169);
  assert.equal(dataset.questions.length, 80);
  assert.ok(dataset.recipes.every((recipe) => recipe.status === "needs_review"));
  const corpus = buildGraduationRetrievalCorpus(dataset);
  assert.equal(corpus.documents.length, 218);
  assert.equal(corpus.documents.filter((document) => document.kind === "recipe").length, 215);
  assert.ok(corpus.documents.every((document) => document.metadata.demoOnly === true));
  assert.ok(corpus.documents.every((document) => document.metadata.reviewStatus === "needs_review"));
});

test("fried recipes exclude bulk frying oil and add only the declared absorbed fraction", () => {
  const recipe = dataset.recipes.find((candidate) => candidate.recipe_id === "EGY-RCP-003");
  assert.ok(recipe);
  const result = calculateUnifiedDemoNutrition(dataset, recipe);
  assert.equal(result.excludedFryingOilG, 200);
  assert.equal(result.absorbedFryingOilG, 30);
  assert.equal(result.totals.kcal, 1284.9);
  assert.equal(result.totals.fat, 44.2);
  assert.ok((result.totals.kcal ?? Infinity) < 3570, "the previous double-counted total must not return");
  assert.ok(result.assumptions.includes("frying_oil_counted_only_at_declared_absorption_fraction"));
});

test("missing nutrient reference values remain null rather than becoming zero", () => {
  const recipe = dataset.recipes.find((candidate) => candidate.ingredients.some((ingredient) => ingredient.ingredient === "kahk_essence"));
  assert.ok(recipe);
  const calculated = calculateUnifiedDemoNutrition(dataset, recipe);
  assert.equal(calculated.totals.kcal, null);
  assert.equal(calculated.totals.sodium, null);
  assert.equal(toRecipeNutritionResult(dataset, recipe).calculationStatus, "partial");
});

test("synthetic RAG questions resolve deterministically and generic questions remain unbound", () => {
  const resolved = dataset.questions.map((question) => resolveDemoQuestionRecipe(dataset, question.expected_recipe));
  assert.ok(resolved.filter(Boolean).length >= 54);
  assert.ok(dataset.questions.filter((question) => question.expected_recipe === "Various").every((question) => resolveDemoQuestionRecipe(dataset, question.expected_recipe) === null));
  assert.equal(resolveDemoQuestionRecipe(dataset, "Egyptian Koshari"), "EGY-RCP-001");
  assert.equal(resolveDemoQuestionRecipe(dataset, "Colocasia"), "EGY-RCP-031");
});

test("graduation demo serves real candidate recipes with explicit demo-only labeling", async () => {
  const agent = await buildGraduationDemoAgent("test");
  const nutrition = await agent.invoke({ message: "الصوديوم في الكشري لكل 100 جرام", language: "ar-EG" });
  assert.equal(nutrition.status, "ok");
  assert.equal(nutrition.data?.recipeId, "EGY-RCP-001");
  assert.equal(nutrition.data?.demoOnly, true);
  assert.match(nutrition.message, /مشروع التخرج/);
  const method = await agent.invoke({ message: "طريقة عمل الطعمية", language: "ar-EG" });
  assert.equal(method.status, "ok");
  assert.equal(method.data?.demoOnly, true);
  assert.match(JSON.stringify(method.data), /EGY-RCP-003|طعمية/u);
});

test("graduation demo cannot run in production mode", async () => {
  await assert.rejects(() => buildGraduationDemoAgent("production" as never), /forbidden outside development\/test/);
});
