import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  InMemoryNutritionCalculationRepository,
  JsonNutritionCalculationRepository,
  NutritionCalculator,
  calculateRecipeNutrition,
  parseNutritionRegistry,
  type NutritionCalculationSnapshot,
  type StructuredNutritionRecipe,
} from "../src/domain/nutrition.js";

const DICTIONARY_FILE = "data/dictionary/ingredients.json";
const UNIT_REGISTRY_FILE = "data/dictionary/unit-conversions.json";
const GOLDEN_REGISTRY_FILE = "tests/fixtures/nutrition/golden-registry.json";

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as unknown;
}

function approvedDictionary(): Array<Record<string, unknown>> {
  const dictionary = structuredClone(readJson(DICTIONARY_FILE)) as Array<Record<string, unknown>>;
  for (const entry of dictionary) {
    entry.provenance = {
      version: "synthetic-step7-dictionary-v1",
      reviewer: "Step 7 golden test",
      reviewDate: "2026-08-09",
      source: "tests/fixtures/nutrition/golden-registry.json",
      status: "approved",
    };
    if (entry.key === "rice" || entry.key === "onion" || entry.key === "garlic" || entry.key === "egg") {
      entry.foodState = "raw";
    }
  }
  return dictionary;
}

function unitRegistryWithSyntheticAdjustments(): Record<string, unknown> {
  const registry = structuredClone(readJson(UNIT_REGISTRY_FILE)) as Record<string, unknown>;
  registry.ediblePortionFactors = [
    {
      id: "synthetic-rice-edible-portion",
      ingredientKey: "rice",
      foodState: "raw",
      factorMin: 0.9,
      factorMax: 0.9,
      uncertainty: "approximate",
      sourceId: "usda-nutritive-value-2002",
      sourceLocator: "synthetic Step 7 test fixture",
      originalValue: "90%",
      originalContext: "Synthetic test-only edible-portion factor; not production data.",
    },
  ];
  registry.cookingYieldFactors = [
    {
      id: "synthetic-rice-raw-cooked-yield",
      ingredientKey: "rice",
      foodStateFrom: "raw",
      foodStateTo: "cooked",
      factorMin: 0.8,
      factorMax: 0.8,
      uncertainty: "approximate",
      sourceId: "usda-nutritive-value-2002",
      sourceLocator: "synthetic Step 7 test fixture",
      originalValue: "80%",
      originalContext: "Synthetic test-only cooking-yield factor; not production data.",
    },
  ];
  return registry;
}

function recipe(
  recipeId: string,
  ingredients: StructuredNutritionRecipe["ingredients"],
  overrides: Partial<StructuredNutritionRecipe> = {}
): StructuredNutritionRecipe {
  return {
    recipeId,
    verificationStatus: "verified",
    ingredients,
    servings: 2,
    finalFoodWeightG: null,
    sourceId: "synthetic-recipe-source",
    versionId: "synthetic-recipe-v1",
    ...overrides,
  };
}

function line(
  originalText: string,
  options: Partial<StructuredNutritionRecipe["ingredients"][number]> = {}
): StructuredNutritionRecipe["ingredients"][number] {
  return {
    originalText,
    required: true,
    targetFoodState: null,
    applyEdiblePortion: false,
    ...options,
  };
}

function calculator(
  recipes: StructuredNutritionRecipe[],
  allowSyntheticTestData = true,
  unitConversionRegistry: unknown = unitRegistryWithSyntheticAdjustments()
): NutritionCalculator {
  return new NutritionCalculator(new InMemoryNutritionCalculationRepository({
    recipes,
    ingredientDictionary: approvedDictionary(),
    reviewedMappings: [],
    reviewRegistry: { records: [] },
    unitConversionRegistry,
    nutritionRegistry: readJson(GOLDEN_REGISTRY_FILE),
    allowSyntheticTestData,
  }));
}

function calculationSnapshot(recipes: StructuredNutritionRecipe[]): NutritionCalculationSnapshot {
  return {
    schemaVersion: "1.0",
    recipes,
    ingredientDictionary: approvedDictionary(),
    reviewedMappings: [],
    reviewRegistry: { records: [] },
    unitConversionRegistry: unitRegistryWithSyntheticAdjustments(),
    nutritionRegistry: readJson(GOLDEN_REGISTRY_FILE),
  };
}

test("public calculateRecipeNutrition operation fails closed when no verified snapshot exists", async () => {
  const result = await calculateRecipeNutrition("missing-production-recipe", {});
  assert.equal(result.calculationStatus, "unavailable");
  assert.ok(result.blockers.includes("recipe_not_found"));
  assert.equal(result.trace.length, 0);
});

test("JSON repository calculates a valid snapshot and rejects duplicate recipe IDs", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "nutriguard-step7-"));
  const snapshotFile = join(temporaryRoot, "nutrition-calculator-snapshot.json");
  const target = recipe("json-snapshot", [line("100 g raw rice")], { finalFoodWeightG: 100 });
  const engine = new NutritionCalculator(new JsonNutritionCalculationRepository(snapshotFile, true));
  try {
    await writeFile(snapshotFile, `${JSON.stringify(calculationSnapshot([target]), null, 2)}\n`, "utf8");
    const validResult = await engine.calculateRecipeNutrition(target.recipeId, {});
    assert.equal(validResult.calculationStatus, "complete");
    assert.equal(validResult.bases.full_recipe.nutrients.calories.amount, 200);

    await writeFile(snapshotFile, `${JSON.stringify(calculationSnapshot([target, structuredClone(target)]), null, 2)}\n`, "utf8");
    const duplicateResult = await engine.calculateRecipeNutrition(target.recipeId, {});
    assert.equal(duplicateResult.calculationStatus, "unavailable");
    assert.ok(duplicateResult.blockers.includes(`duplicate_recipe_id:${target.recipeId}`));
    assert.equal(duplicateResult.trace.length, 0);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("in-memory repository rejects duplicate recipe IDs instead of choosing the first", async () => {
  const target = recipe("duplicate-in-memory", [line("100 g raw rice")], { finalFoodWeightG: 100 });
  const result = await calculator([target, structuredClone(target)]).calculateRecipeNutrition(target.recipeId, {});
  assert.equal(result.calculationStatus, "unavailable");
  assert.ok(result.blockers.includes(`duplicate_recipe_id:${target.recipeId}`));
  assert.equal(result.trace.length, 0);
});

test("nutrition registry validates source/version pairs and rejects negative values", () => {
  const raw = structuredClone(readJson(GOLDEN_REGISTRY_FILE)) as Record<string, unknown>;
  const profiles = raw.profiles as Array<Record<string, unknown>>;
  (profiles[0].nutrients as Record<string, unknown>).protein = -1;
  profiles[0].versionId = "wrong-version";
  const parsed = parseNutritionRegistry(raw, new Set(["rice", "honey", "white-sugar"]));
  assert.ok(parsed.issues.some((issue) => issue.includes("protein")));
  assert.ok(parsed.issues.some((issue) => issue.includes("sourceId/versionId")));
  assert.equal(parsed.profiles.some((profile) => profile.id === "synthetic-rice-raw-profile"), false);
});

test("simple exact recipe calculates full, serving and per-100-g bases", async () => {
  const target = recipe("simple-exact", [line("100 g raw rice")], { servings: 4, finalFoodWeightG: 100 });
  const result = await calculator([target]).calculateRecipeNutrition(target.recipeId, {});
  assert.equal(result.calculationStatus, "complete");
  assert.equal(result.bases.full_recipe.basisStatus, "available");
  assert.equal(result.bases.full_recipe.nutrients.calories.amount, 200);
  assert.equal(result.bases.full_recipe.nutrients.protein.amount, 10.3);
  assert.equal(result.bases.per_serving.nutrients.calories.amount, 50);
  assert.equal(result.bases.per_serving.nutrients.protein.amount, 2.6);
  assert.equal(result.bases.per_100g.nutrients.calories.amount, 200);
  assert.equal(result.servingWeightG, 25);
  assert.equal(result.coverage.resolutionRate, 1);
  assert.equal(result.coverage.gramConversionRate, 1);
  assert.equal(result.trace[0].inputGrams, 100);
});

test("mixed units use ingredient-specific factors and trace each contribution", async () => {
  const target = recipe("mixed-units", [line("1 cup raw rice"), line("2 tablespoons honey")], {
    servings: 2,
    finalFoodWeightG: 227,
  });
  const result = await calculator([target]).calculateRecipeNutrition(target.recipeId, {});
  assert.equal(result.calculationStatus, "complete");
  assert.equal(result.trace[0].finalGrams, 185);
  assert.equal(result.trace[1].finalGrams, 42);
  assert.equal(result.trace[0].quantityConversion.conversionId, "usda-rice-raw-cup-185g");
  assert.equal(result.trace[1].quantityConversion.conversionId, "usda-honey-tablespoon-21g");
  assert.equal(result.bases.full_recipe.nutrients.calories.amount, 496);
  assert.equal(result.bases.full_recipe.nutrients.protein.amount, 19.1);
  assert.equal(result.bases.full_recipe.nutrients.carbohydrate.amount, 105.5);
  assert.equal(result.bases.full_recipe.nutrients.sugar.amount, null);
  assert.equal(result.bases.full_recipe.nutrients.sugar.knownSubtotal, 31.5);
  assert.ok(result.provenance.some((item) => item.sourceId === "usda-nutritive-value-2002" && item.versionId === "usda-hgb72-2002"));
  assert.ok(result.provenance.some((item) => item.sourceId === "synthetic-step7-golden" && item.versionId === "synthetic-step7-golden-v1"));
});

test("missing optional ingredient returns partial and discloses the omission", async () => {
  const target = recipe("missing-optional", [
    line("100 g raw rice"),
    line("50 g mystery powder", { required: false }),
  ], { finalFoodWeightG: 100 });
  const result = await calculator([target]).calculateRecipeNutrition(target.recipeId, {});
  assert.equal(result.calculationStatus, "partial");
  assert.equal(result.bases.full_recipe.basisStatus, "available");
  assert.equal(result.bases.full_recipe.nutrients.calories.amount, 200);
  assert.equal(result.missingIngredients.length, 1);
  assert.equal(result.missingIngredients[0].required, false);
  assert.ok(result.assumptions.some((item) => item.code === "optional_ingredient_omitted"));
  assert.equal(result.coverage.weightDenominatorComplete, true);
  assert.equal(result.coverage.weightCoverageRate, 2 / 3);
});

test("unknown optional weight makes the objective weight denominator incomplete", async () => {
  const target = recipe("missing-optional-weight", [
    line("100 g raw rice"),
    line("mystery garnish", { required: false }),
  ], { finalFoodWeightG: 100 });
  const result = await calculator([target]).calculateRecipeNutrition(target.recipeId, {});
  assert.equal(result.calculationStatus, "partial");
  assert.equal(result.bases.full_recipe.basisStatus, "available");
  assert.equal(result.coverage.knownFinalWeightG, 100);
  assert.equal(result.coverage.weightDenominatorComplete, false);
  assert.equal(result.coverage.weightCoverageRate, null);
});

test("unknown required quantity makes every requested basis unavailable without fabricated grams", async () => {
  const target = recipe("unknown-quantity", [line("raw rice")], { finalFoodWeightG: 100 });
  const result = await calculator([target]).calculateRecipeNutrition(target.recipeId, {});
  assert.equal(result.calculationStatus, "unavailable");
  assert.equal(result.bases.full_recipe.basisStatus, "unavailable");
  assert.equal(result.trace[0].quantityConversion.grams, null);
  assert.equal(result.trace[0].finalGrams, null);
  assert.ok(result.missingIngredients[0].codes.includes("quantity_missing"));
});

test("raw/cooked mismatch never borrows a raw nutrient profile", async () => {
  const target = recipe("state-mismatch", [line("100 g cooked rice")], { finalFoodWeightG: 100 });
  const result = await calculator([target]).calculateRecipeNutrition(target.recipeId, {});
  assert.equal(result.calculationStatus, "partial");
  assert.equal(result.trace[0].resolution.foodState, "cooked");
  assert.equal(result.trace[0].nutrientProfileId, null);
  assert.equal(result.bases.full_recipe.nutrients.calories.amount, null);
  assert.equal(result.bases.full_recipe.nutrients.calories.knownSubtotal, 0);
  assert.ok(result.missingIngredients[0].codes.includes("nutrient_profile_missing_for_food_state"));
});

test("explicit serving request drives per-serving calculation and is disclosed", async () => {
  const target = recipe("serving-request", [line("100 g raw rice")], { servings: null, finalFoodWeightG: null });
  const result = await calculator([target]).calculateRecipeNutrition(target.recipeId, {
    servingCount: 5,
    finalFoodWeightG: 125,
  });
  assert.equal(result.bases.per_serving.nutrients.calories.amount, 40);
  assert.equal(result.bases.per_100g.nutrients.calories.amount, 160);
  assert.equal(result.servingWeightG, 25);
  assert.ok(result.assumptions.some((item) => item.code === "serving_count_from_request"));
  assert.ok(result.assumptions.some((item) => item.code === "final_weight_from_request"));
});

test("edible portion, cooking yield and nutrient retention are applied with a trace", async () => {
  const target = recipe("yield-retention", [line("100 g raw rice", {
    applyEdiblePortion: true,
    targetFoodState: "cooked",
  })], { servings: 2, finalFoodWeightG: 72 });
  const result = await calculator([target]).calculateRecipeNutrition(target.recipeId, {});
  assert.equal(result.calculationStatus, "complete");
  assert.equal(result.trace[0].inputGrams, 100);
  assert.equal(result.trace[0].edibleGrams, 90);
  assert.equal(result.trace[0].finalGrams, 72);
  assert.equal(result.trace[0].nutritionFoodState, "raw");
  assert.equal(result.trace[0].nutrients.calories.retentionFactor, 0.9);
  assert.equal(result.trace[0].nutrients.calories.traceContribution, 162);
  assert.equal(result.bases.full_recipe.nutrients.calories.amount, 162);
  assert.equal(result.bases.per_100g.nutrients.calories.amount, 225);
  assert.equal(result.trace[0].retentionFactorIds.length, 8);
  assert.ok(result.provenance.some((item) => item.roles.includes("nutrient_retention")));
});

test("requested edible portion fails closed when its sourced factor is absent", async () => {
  const target = recipe("missing-edible-factor", [line("100 g raw rice", {
    applyEdiblePortion: true,
  })], { finalFoodWeightG: 100 });
  const registry = unitRegistryWithSyntheticAdjustments();
  registry.ediblePortionFactors = [];
  const result = await calculator([target], true, registry).calculateRecipeNutrition(target.recipeId, {});
  assert.equal(result.calculationStatus, "unavailable");
  assert.equal(result.trace[0].inputGrams, 100);
  assert.equal(result.trace[0].edibleGrams, null);
  assert.equal(result.trace[0].finalGrams, null);
  assert.ok(result.missingIngredients[0].codes.includes("edible_portion_factor_missing"));
});

test("a target state equal to the resolved state needs no cooking-yield factor", async () => {
  const target = recipe("same-state", [line("100 g raw rice", {
    targetFoodState: "raw",
  })], { finalFoodWeightG: 100 });
  const result = await calculator([target]).calculateRecipeNutrition(target.recipeId, {});
  assert.equal(result.calculationStatus, "complete");
  assert.equal(result.trace[0].finalGrams, 100);
  assert.equal(result.trace[0].nutritionFoodState, "raw");
  assert.equal(result.trace[0].quantityConversion.yieldAdjustedGrams, null);
  assert.equal(result.bases.full_recipe.nutrients.calories.amount, 200);
});

test("zero nutrient values remain zero while missing values remain null", async () => {
  const target = recipe("zero-v-null", [line("100 g white sugar")], { finalFoodWeightG: 100 });
  const result = await calculator([target]).calculateRecipeNutrition(target.recipeId, {});
  assert.equal(result.calculationStatus, "complete");
  assert.equal(result.bases.full_recipe.nutrients.total_fat.amount, 0);
  assert.equal(result.bases.full_recipe.nutrients.sodium.amount, 0);
  assert.equal(result.bases.full_recipe.nutrients.saturated_fat.amount, null);
  assert.equal(result.bases.full_recipe.nutrients.saturated_fat.knownSubtotal, 0);
});

test("synthetic profiles fail closed unless the repository explicitly enables test data", async () => {
  const target = recipe("synthetic-gate", [line("100 g raw rice")], { finalFoodWeightG: 100 });
  const result = await calculator([target], false).calculateRecipeNutrition(target.recipeId, {});
  assert.equal(result.calculationStatus, "partial");
  assert.equal(result.bases.full_recipe.nutrients.calories.amount, null);
  assert.equal(result.trace[0].nutrientProfileId, null);
});

test("same input and versions return byte-identical repeatable results", async () => {
  const target = recipe("repeatable", [line("33 g raw rice")], { servings: 3, finalFoodWeightG: 33 });
  const engine = calculator([target]);
  const first = await engine.calculateRecipeNutrition(target.recipeId, {});
  const second = await engine.calculateRecipeNutrition(target.recipeId, {});
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("invalid runtime serving requests return explicit unavailable status", async () => {
  const target = recipe("bad-serving-request", [line("100 g raw rice")], { finalFoodWeightG: 100 });
  const result = await calculator([target]).calculateRecipeNutrition(
    target.recipeId,
    { bases: ["per_serving", "invalid"] } as unknown as Parameters<NutritionCalculator["calculateRecipeNutrition"]>[1]
  );
  assert.equal(result.calculationStatus, "unavailable");
  assert.ok(result.blockers.includes("serving_request_invalid_basis"));
});

test("rounding happens once at output while trace retains guarded precision", async () => {
  const target = recipe("rounding", [line("33 g raw rice")], { servings: 3, finalFoodWeightG: 33 });
  const result = await calculator([target]).calculateRecipeNutrition(target.recipeId, {});
  assert.equal(result.trace[0].nutrients.protein.traceContribution, 3.40989);
  assert.equal(result.trace[0].nutrients.protein.outputContribution, 3.4);
  assert.equal(result.bases.full_recipe.nutrients.protein.amount, 3.4);
  assert.equal(result.bases.per_serving.nutrients.protein.amount, 1.1);
  assert.deepEqual(result.roundingPolicy.protein, { unit: "g", decimals: 1, stage: "output_only" });
});
