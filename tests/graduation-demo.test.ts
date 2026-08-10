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

test("graduation demo returns useful recipe methods and meal suggestions instead of a generic disclaimer", async () => {
  const agent = await buildGraduationDemoAgent("test");
  const koshary = await agent.invoke({ message: "ما طريقة عمل الكشري المصري؟", language: "ar-EG" });
  assert.equal(koshary.status, "ok");
  assert.match(koshary.message, /المكونات/);
  assert.match(koshary.message, /طريقة التحضير/);
  assert.match(koshary.message, /أرز أبيض|عدس بني/);
  assert.equal((koshary.data?.recipe as { recipeId?: string } | undefined)?.recipeId, "EGY-RCP-001");

  const arabicBreakfast = await agent.invoke({ message: "عاوز وجبة فطار", language: "ar-EG" });
  assert.equal(arabicBreakfast.status, "ok");
  assert.match(arabicBreakfast.message, /فول مدمس/);
  assert.match(arabicBreakfast.message, /طعمية/);

  const englishBreakfast = await agent.invoke({ message: "I want a breakfast meal", language: "ar-EG" });
  assert.equal(englishBreakfast.status, "ok");
  assert.equal(englishBreakfast.language, "en");
  assert.match(englishBreakfast.message, /Ful Medames/);
  assert.match(englishBreakfast.message, /Ta'ameya/);
  assert.doesNotMatch(englishBreakfast.message, /Graduation-demo results from the unreviewed/);
});

test("graduation demo calculates recipe and supplied-ingredient calories and gives general advice", async () => {
  const agent = await buildGraduationDemoAgent("test");

  const recipeCalories = await agent.invoke({ message: "كام سعر حراري في الكشري؟", language: "ar-EG" });
  assert.equal(recipeCalories.status, "ok");
  assert.equal(recipeCalories.primaryIntent, "recipe_nutrition");
  assert.equal(recipeCalories.data?.recipeId, "EGY-RCP-001");
  assert.equal(typeof recipeCalories.data?.caloriesPerServingKcal, "number");
  assert.match(recipeCalories.message, /للحصة/);
  assert.match(recipeCalories.message, /لكل 100 جرام/);

  const ingredients = await agent.invoke({ message: "احسب سعرات 150 جرام رز + 100 جرام صدور فراخ + 10 جرام زيت زيتون", language: "ar-EG" });
  assert.equal(ingredients.status, "ok");
  assert.equal(ingredients.data?.calculationType, "ingredient_weights");
  assert.equal((ingredients.data?.ingredients as unknown[]).length, 3);
  assert.equal(typeof ingredients.data?.totalCaloriesKcal, "number");
  assert.ok((ingredients.data?.totalCaloriesKcal as number) > 0);
  assert.match(ingredients.message, /إجمالي السعرات المحسوبة/);

  const englishIngredients = await agent.invoke({ message: "Calculate calories for 150 g rice and 100 g chicken breast", language: "ar-EG" });
  assert.equal(englishIngredients.status, "ok");
  assert.equal(englishIngredients.language, "en");
  assert.match(englishIngredients.message, /Total calculated calories/);

  const missingWeights = await agent.invoke({ message: "احسب سعرات رز وفراخ", language: "ar-EG" });
  assert.equal(missingWeights.status, "clarification");
  assert.match(missingWeights.message, /وزنه بالجرام/);

  const advice = await agent.invoke({ message: "اديني نصائح لأكل صحي", language: "ar-EG" });
  assert.equal(advice.status, "ok");
  assert.equal(advice.data?.adviceType, "general_non_medical");
  assert.match(advice.message, /حجم الحصة/);
});

test("graduation router returns one matched answer for the six supported information intents", async () => {
  const agent = await buildGraduationDemoAgent("test");

  const recipe = await agent.invoke({ message: "عايز وصفة فول", language: "ar-EG" });
  assert.equal(recipe.status, "ok");
  assert.equal((recipe.data?.recipe as { recipeId?: string } | undefined)?.recipeId, "EGY-RCP-002");
  assert.match(recipe.message, /فول مدمس/);
  assert.doesNotMatch(recipe.message, /شاي كشري|Yellow Lentil Koshary/u);

  const nutrition = await agent.invoke({ message: "كام سعرة في طبق الكشري؟", language: "ar-EG" });
  assert.equal(nutrition.status, "ok");
  assert.equal(nutrition.data?.intent, "recipe_nutrition");
  assert.equal(nutrition.data?.recipeId, "EGY-RCP-001");
  assert.match(nutrition.message, /الوصفة كاملة/);
  assert.match(nutrition.message, /للحصة الواحدة/);
  assert.match(nutrition.message, /لكل 100 جرام/);
  assert.match(nutrition.message, /بروتين/);
  assert.match(nutrition.message, /صوديوم/);

  const ingredient = await agent.invoke({ message: "احسب سعرات 150 جرام رز + 100 جرام صدور فراخ", language: "ar-EG" });
  assert.equal(ingredient.status, "ok");
  assert.equal(ingredient.data?.calculationType, "ingredient_weights");

  const comparison = await agent.invoke({ message: "الفول ولا الكشري أقل صوديوم؟", language: "ar-EG" });
  assert.equal(comparison.status, "ok");
  assert.equal(comparison.data?.intent, "compare_recipes");
  assert.equal(comparison.data?.nutrient, "sodium");
  assert.match(comparison.message, /فول مدمس/);
  assert.match(comparison.message, /كشري/);

  const guideline = await agent.invoke({ message: "ما توصيات منظمة الصحة العالمية عن الصوديوم؟", language: "ar-EG" });
  assert.equal(guideline.status, "ok");
  assert.equal(guideline.data?.intent, "general_guideline");
  assert.equal(guideline.evidenceDocumentIds.length, 1);

  const unsupported = await agent.invoke({ message: "ما حالة الطقس غدًا؟", language: "ar-EG" });
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.data?.intent, "unsupported");
  assert.equal(unsupported.evidenceDocumentIds.length, 0);
});

test("lower-calorie Koshary request uses one deterministic modification instead of raw RAG hits", async () => {
  const agent = await buildGraduationDemoAgent("test");
  const answer = await agent.invoke({ message: "عاوز اقلل السعرات الحراريه لوجبه الكشري", language: "ar-EG" });

  assert.equal(answer.status, "ok");
  assert.equal(answer.primaryIntent, "lighter_recipe");
  assert.equal(answer.data?.intent, "lighter_modification");
  assert.equal(answer.data?.recipeId, "EGY-RCP-001");
  assert.deepEqual(answer.data?.modification, { ingredient: "vegetable_oil", originalGrams: 60, proposedGrams: 30 });
  assert.match(answer.message, /قلّل الزيت النباتي المضاف من 60 جرام إلى 30 جرام/);
  assert.match(answer.message, /تنخفض الحصة/);
  assert.equal("passages" in (answer.data ?? {}), false);
  assert.equal(answer.evidenceDocumentIds.length, 1);
  assert.doesNotMatch(answer.message, /شاي كشري|Yellow Lentil Koshary/u);
});

test("medical requests retain the safety route and never enter recipe retrieval", async () => {
  const agent = await buildGraduationDemoAgent("test");
  const answer = await agent.invoke({ message: "شخص أغمي عليه ومش بيتنفس، أعمل إيه؟", language: "ar-EG" });
  assert.equal(answer.status, "emergency");
  assert.equal(answer.primaryIntent, "medical_safety_request");
  assert.ok(answer.safetyFlags.includes("emergency"));
  assert.equal(answer.evidenceDocumentIds.length, 0);
});

test("graduation demo cannot run in production mode", async () => {
  await assert.rejects(() => buildGraduationDemoAgent("production" as never), /forbidden outside development\/test/);
});
