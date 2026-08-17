import assert from "node:assert/strict";
import test from "node:test";
import { loadUnifiedEgyptianDemoDataset } from "../src/demo/unified-egyptian-dataset.js";
import { buildGraduationDemoAgent } from "../src/runtime/graduation-demo-agent.js";

const dataset = await loadUnifiedEgyptianDemoDataset();
const agent = await buildGraduationDemoAgent("test", null);

interface IngredientGrams { ingredient: string; displayName: string; grams: number }

function assertCompleteIngredientGrams(recipeId: string, ingredients: IngredientGrams[] | undefined): void {
  const recipe = dataset.recipes.find((candidate) => candidate.recipe_id === recipeId);
  assert.ok(recipe, `unknown test recipe ${recipeId}`);
  assert.ok(Array.isArray(ingredients), `${recipeId} must expose ingredients`);
  assert.equal(ingredients.length, recipe.ingredients.length, `${recipeId} must expose every ingredient`);
  assert.ok(ingredients.every((item) => item.ingredient.length > 0 && item.displayName.length > 0 && Number.isFinite(item.grams) && item.grams > 0), `${recipeId} must expose every ingredient in positive grams`);
}

test("English meal counts one through ten and numeric 3 resolve to the requested count", async () => {
  const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  for (const [index, word] of words.entries()) {
    const count = index + 1;
    const response = await agent.invoke({ message: `Plan ${word} meals for ${count * 400} kcal`, language: "en" });
    assert.equal(response.status, "ok", word);
    assert.equal(response.data?.mealCount, count, word);
  }
  const numeric = await agent.invoke({ message: "Suggest 3 meals for me today using 1800 kcal", language: "en" });
  assert.equal(numeric.status, "ok");
  assert.equal(numeric.data?.mealCount, 3);
});

test("English meal planning accepts polite, uppercase, punctuated, and couple phrasing", async () => {
  for (const [message, expectedCount, calories] of [
    ["Could you PLEASE plan THREE meals for me today, using 1,800 calories?", 3, 1800],
    ["I need 3 meals today. My daily target is 1800 kcal.", 3, 1800],
    ["Prepare a couple of meals for 800 calories.", 2, 800],
    ["Please prepare one meal for 400 kcal!", 1, 400],
  ] as const) {
    const response = await agent.invoke({ message, language: "en" });
    assert.equal(response.status, "ok", message);
    assert.equal(response.data?.mealCount, expectedCount, message);
    assert.equal(response.data?.targetCaloriesKcal, calories, message);
  }
});

test("ambiguous ranges, vague counts, and likely English number typos require clarification", async () => {
  for (const message of [
    "Plan 2 or 3 meals for 1800 kcal",
    "Plan 2-3 meals for 1800 kcal",
    "Plan two or three meals for 1800 kcal",
    "Plan a few meals for 1800 kcal",
    "Plan several meals for 1800 kcal",
    "Plan tree meals for 1800 kcal",
    "Plan thre meals for 1800 kcal",
    "Plan eigth meals for 1800 kcal",
  ]) {
    const response = await agent.invoke({ message, language: "en" });
    assert.equal(response.status, "clarification", message);
    assert.equal(response.data?.requiredInput, "meal_count_between_1_and_10", message);
  }
});

test("English number words outside a meal-count phrase do not accidentally start a meal plan", async () => {
  for (const message of [
    "How many calories are in one apple?",
    "Compare one recipe with another",
    "I ate two bananas",
  ]) {
    const response = await agent.invoke({ message, language: "en" });
    assert.notEqual(response.data?.intent, "meal_plan", message);
  }
});

test("English meal plans reject missing or unsafe calorie bounds without guessing", async () => {
  const missing = await agent.invoke({ message: "Please plan three meals for today", language: "en" });
  assert.equal(missing.status, "clarification");
  assert.equal(missing.data?.requiredInput, "daily_calorie_target");

  for (const message of ["Plan three meals for 250 kcal", "Plan three meals for 6000 calories"]) {
    const response = await agent.invoke({ message, language: "en" });
    assert.equal(response.status, "clarification", message);
    assert.equal(response.data?.requiredInput, "daily_calorie_target_between_300_and_5000", message);
  }
});

test("Arabic and Arabic-Indic meal counts share the same plan behavior", async () => {
  for (const message of [
    "اقترح 3 وجبات اليوم 1800 سعر",
    "اقترح ٣ وجبات اليوم ١٨٠٠ سعر",
    "اقترح ثلاث وجبات اليوم 1800 سعر",
    "اقترح ثلاثة وجبات اليوم 1800 سعر",
    "اقترح تلاتة وجبات اليوم 1800 سعر",
  ]) {
    const response = await agent.invoke({ message, language: "ar-EG" });
    assert.equal(response.status, "ok", message);
    assert.equal(response.data?.mealCount, 3, message);
  }
});

test("invalid numeric and word meal counts are rejected explicitly rather than silently becoming three", async () => {
  for (const [message, language] of [
    ["Plan 0 meals for 1800 kcal", "en"],
    ["Plan -1 meals for 1800 kcal", "en"],
    ["Plan 3.5 meals for 1800 kcal", "en"],
    ["Plan eleven meals for 1800 kcal", "en"],
    ["اقترح ١١ وجبة اليوم ١٨٠٠ سعر", "ar-EG"],
    ["اقترح صفر وجبات اليوم ١٨٠٠ سعر", "ar-EG"],
  ] as const) {
    const response = await agent.invoke({ message, language });
    assert.equal(response.status, "clarification", message);
    assert.equal(response.data?.requiredInput, "meal_count_between_1_and_10", message);
  }
});

test("Arabic singular and dual meal-count phrasing is understood", async () => {
  for (const [message, expected] of [["خطط وجبة واحدة 400 سعر", 1], ["خطط وجبتين 800 سعر", 2]] as const) {
    const response = await agent.invoke({ message, language: "ar-EG" });
    assert.equal(response.status, "ok", message);
    assert.equal(response.data?.mealCount, expected, message);
  }
});

test("any/أي/اي Egyptian meal requests return one deterministic verified option with every ingredient in grams", async () => {
  for (const [message, language] of [
    ["Suggest any Egyptian meal", "en"],
    ["Recommend me any Egyptian food", "en"],
    ["اقترح أي وجبة مصرية", "ar-EG"],
    ["اقترح اي وجبة مصرية", "ar-EG"],
    ["رشحلي أي أكل مصري", "ar-EG"],
  ] as const) {
    const response = await agent.invoke({ message, language });
    assert.equal(response.status, "ok", message);
    assert.equal(response.data?.recommendationType, "any_egyptian_meal", message);
    const recommendations = response.data?.recommendations as Array<{ recipeId: string; ingredients: IngredientGrams[] }>;
    assert.equal(recommendations.length, 1, message);
    assertCompleteIngredientGrams(recommendations[0]!.recipeId, recommendations[0]!.ingredients);
    assert.match(response.message, language === "en" ? /Ingredient input weights/u : /أوزان المكونات/u);
  }
});

test("natural English any-meal variants use the same verified health-first route", async () => {
  for (const message of [
    "Could you recommend a meal?",
    "Please give me some Egyptian food",
    "Surprise me with an Egyptian dish",
    "Pick something Egyptian to eat",
    "Any Egyptian meal is fine",
    "Whatever Egyptian recipe is okay",
  ]) {
    const response = await agent.invoke({ message, language: "en" });
    assert.equal(response.status, "ok", message);
    assert.equal(response.data?.recommendationType, "any_egyptian_meal", message);
    const recommendations = response.data?.recommendations as Array<{ recipeId: string; ingredients: IngredientGrams[] }>;
    assert.equal(recommendations.length, 1, message);
    assertCompleteIngredientGrams(recommendations[0]!.recipeId, recommendations[0]!.ingredients);
  }
});

test("specific constraints take precedence over the generic any-meal fallback", async () => {
  const calorie = await agent.invoke({ message: "Suggest any Egyptian meal around 500 kcal", language: "en" });
  assert.equal(calorie.status, "ok");
  assert.equal(calorie.data?.recommendationType, "calorie_target");
  assertCompleteIngredientGrams(String(calorie.data?.recipeId), calorie.data?.ingredients as IngredientGrams[]);

  const protein = await agent.invoke({ message: "Suggest any Egyptian meal high in protein", language: "en" });
  assert.equal(protein.status, "ok");
  assert.equal(protein.data?.recommendationType, "nutrition_ranked");
  assertCompleteIngredientGrams(String(protein.data?.recipeId), protein.data?.ingredients as IngredientGrams[]);

  const excluded = await agent.invoke({ message: "Suggest any Egyptian meal without milk", language: "en" });
  assert.equal(excluded.status, "ok");
  assert.equal(excluded.data?.recommendationType, "ingredient_exclusion");
  assertCompleteIngredientGrams(String(excluded.data?.recipeId), excluded.data?.ingredients as IngredientGrams[]);
});

test("category recommendations expose every ingredient in grams for every returned recipe", async () => {
  const response = await agent.invoke({ message: "Suggest an Egyptian breakfast", language: "en" });
  assert.equal(response.status, "ok");
  const recommendations = response.data?.recommendations as Array<{ recipeId: string; ingredients: IngredientGrams[] }>;
  assert.equal(recommendations.length, 3);
  for (const recommendation of recommendations) assertCompleteIngredientGrams(recommendation.recipeId, recommendation.ingredients);
});

test("every meal-plan recipe exposes all portion-scaled ingredient input weights", async () => {
  const response = await agent.invoke({ message: "Suggest three meals for me today using 1800 kcal", language: "en" });
  assert.equal(response.status, "ok");
  const meals = response.data?.meals as Array<{ recipeId: string; portionGrams: number; ingredients: IngredientGrams[]; ingredientWeightBasis: string }>;
  assert.equal(meals.length, 3);
  for (const meal of meals) {
    assert.ok(meal.portionGrams > 0);
    assert.equal(meal.ingredientWeightBasis, "input_grams_scaled_to_selected_portion");
    assertCompleteIngredientGrams(meal.recipeId, meal.ingredients);
  }
  assert.match(response.message, /Ingredient input grams for this portion/u);
});

test("exact recipe details and recipe nutrition expose every full-recipe ingredient in grams", async () => {
  const details = await agent.invoke({ message: "How do I make Koshary? Show the ingredients.", language: "en" });
  assert.equal(details.status, "ok");
  const recipe = details.data?.recipe as { recipeId: string; ingredients: IngredientGrams[]; ingredientWeightBasis: string };
  assert.equal(recipe.ingredientWeightBasis, "input_grams_for_full_recorded_recipe");
  assertCompleteIngredientGrams(recipe.recipeId, recipe.ingredients);
  assert.match(details.message, /Ingredient input weights for the full recorded recipe/u);

  const nutrition = await agent.invoke({ message: "How many calories are in Koshary?", language: "en" });
  assert.equal(nutrition.status, "ok");
  assert.equal(nutrition.data?.ingredientWeightBasis, "input_grams_for_full_recorded_recipe");
  assertCompleteIngredientGrams(String(nutrition.data?.recipeId), nutrition.data?.ingredients as IngredientGrams[]);
  assert.match(nutrition.message, /Ingredient input weights for the full recorded recipe/u);
});

test("all verified source recipes contain only positive canonical ingredient gram weights", () => {
  assert.equal(dataset.recipes.length, 215);
  for (const recipe of dataset.recipes) {
    assert.ok(recipe.ingredients.length > 0, `${recipe.recipe_id} has no ingredients`);
    assert.ok(recipe.ingredients.every((ingredient) => Number.isFinite(ingredient.grams) && ingredient.grams > 0), `${recipe.recipe_id} has a non-positive ingredient gram value`);
  }
});
