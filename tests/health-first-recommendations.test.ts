import assert from "node:assert/strict";
import test from "node:test";
import { loadUnifiedEgyptianDemoDataset, calculateUnifiedDemoNutrition } from "../src/demo/unified-egyptian-dataset.js";
import {
  assessNutritionBalance,
  calculatePortionForCalories,
  diversifyHealthRanked,
  rankHealthFirst,
  RECOMMENDATION_POLICY_VERSION,
} from "../src/recommendation/health-first.js";
import { buildGraduationDemoAgent, type GraduationConversationContext } from "../src/runtime/graduation-demo-agent.js";
import { auditRegionalRecipeSource } from "../src/scripts/audit-regional-recipes.js";

const dataset = await loadUnifiedEgyptianDemoDataset();

test("verified per-100g nutrition converts a 300-kcal Koshary request to reconciling grams and macros", () => {
  const recipe = dataset.recipes.find((candidate) => candidate.recipe_id === "EGY-RCP-001");
  assert.ok(recipe);
  const calculation = calculateUnifiedDemoNutrition(dataset, recipe);
  const portion = calculatePortionForCalories(calculation, 300, recipe.servings);
  assert.ok(portion);
  assert.equal(portion.portionGrams, 137);
  assert.equal(portion.basis, "verified_per_100g");
  assert.ok(Math.abs((portion.nutrition.kcal ?? 0) - 300) < 1);
  assert.equal(portion.servingFraction > 0 && portion.servingFraction < 1, true);
});

test("calorie-target Agent output includes the calculated gram portion for the named verified recipe", async () => {
  const agent = await buildGraduationDemoAgent("test", null);
  const response = await agent.invoke({ message: "عاوز 300 سعر حراري كشري", language: "ar-EG" });
  assert.equal(response.status, "ok");
  assert.equal(response.data?.recommendationType, "calorie_target");
  assert.equal(response.data?.recipeId, "EGY-RCP-001");
  assert.equal(response.data?.portionGrams, 137);
  assert.equal(response.data?.portionBasis, "verified_per_100g");
  assert.match(response.message, /137 جرام/u);
});

test("daily plan exposes grams and scaled nutrition for every meal and reconciles to the target", async () => {
  const agent = await buildGraduationDemoAgent("test", null);
  const response = await agent.invoke({ message: "جهزلي 3 وجبات اليوم 1800 سعر", language: "ar-EG" });
  assert.equal(response.status, "ok");
  const meals = response.data?.meals as Array<{ portionGrams: number; servingFraction: number; portionNutrition: { kcal: number }; nutritionBalanceScore: number }>;
  assert.equal(meals.length, 3);
  assert.ok(meals.every((meal) => meal.portionGrams > 0 && meal.servingFraction > 0));
  assert.ok(meals.every((meal) => Number.isFinite(meal.nutritionBalanceScore)));
  assert.ok(Math.abs(meals.reduce((sum, meal) => sum + meal.portionNutrition.kcal, 0) - 1800) < 3);
  assert.match(response.message, /جرام/u);
});

test("health-first policy is deterministic, penalizes frying, and diversifies cooking methods", () => {
  const fried = dataset.recipes.find((recipe) => recipe.oil_absorption_applied);
  const notFried = dataset.recipes.find((recipe) => !recipe.oil_absorption_applied && recipe.category === fried?.category);
  assert.ok(fried && notFried);
  const friedAssessment = assessNutritionBalance(fried, calculateUnifiedDemoNutrition(dataset, fried));
  assert.equal(friedAssessment.fried, true);
  const nonFriedEquivalent = { ...fried, oil_absorption_applied: false, ingredients: fried.ingredients.map((ingredient) => ({ ...ingredient, state: ingredient.state === "frying" ? "cooked" : ingredient.state })) };
  const withoutFryingPenalty = assessNutritionBalance(nonFriedEquivalent, calculateUnifiedDemoNutrition(dataset, fried));
  assert.equal(withoutFryingPenalty.score, friedAssessment.score + 10);
  const entries = dataset.recipes.slice(0, 40).map((recipe) => {
    const calculation = calculateUnifiedDemoNutrition(dataset, recipe);
    return { recipe, calculation, assessment: assessNutritionBalance(recipe, calculation) };
  });
  const first = diversifyHealthRanked(rankHealthFirst(entries), 3);
  const second = diversifyHealthRanked(rankHealthFirst(entries), 3);
  assert.deepEqual(first.map((entry) => entry.recipe.recipe_id), second.map((entry) => entry.recipe.recipe_id));
  assert.equal(new Set(first.map((entry) => entry.recipe.cooking_method)).size, first.length);
  assert.ok(first.every((entry) => entry.assessment.policyVersion === RECOMMENDATION_POLICY_VERSION));
});

test("repeated category recommendations use conversation memory to rotate away from recent recipes", async () => {
  const agent = await buildGraduationDemoAgent("test", null);
  const first = await agent.invoke({ message: "عاوز وجبة فطار", language: "ar-EG" });
  const firstIds = (first.data?.recommendations as Array<{ recipeId: string }>).map((item) => item.recipeId);
  const second = await agent.invoke({ message: "عاوز وجبة فطار تانية", language: "ar-EG", context: first.data?.conversationContext as GraduationConversationContext });
  const secondIds = (second.data?.recommendations as Array<{ recipeId: string }>).map((item) => item.recipeId);
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(firstIds.some((id) => secondIds.includes(id)), false);
});

test("all 215 verified recipes expose a positive cooked serving weight", () => {
  assert.equal(dataset.recipes.length, 215);
  for (const recipe of dataset.recipes) {
    const calculation = calculateUnifiedDemoNutrition(dataset, recipe);
    assert.ok(calculation.finalWeightG / recipe.servings > 0, recipe.recipe_id);
  }
});

test("regional source remains gated when nutrition, provenance, and cuisine evidence are not trustworthy", async () => {
  const audit = await auditRegionalRecipeSource();
  assert.equal(audit.rowsTotal, 1468);
  assert.equal(audit.hasRequiredNutritionColumns, false);
  assert.equal(audit.hasPerRecordProvenanceColumn, false);
  assert.ok(audit.middleEasternAndContradictoryRows > 1000);
  assert.equal(audit.eligibleForTrustedRecommendations, 0);
  assert.equal(audit.decision, "blocked_pending_nutrition_provenance_and_human_review");
});
