import type {
  DemoNutrition,
  DemoNutritionCalculation,
  UnifiedDemoRecipe,
} from "../demo/unified-egyptian-dataset.js";

export const RECOMMENDATION_POLICY_VERSION = "health-first-local-v1";

export interface CalculatedPortion {
  portionGrams: number;
  servingFraction: number;
  requestedCaloriesKcal: number;
  nutrition: DemoNutrition;
  basis: "verified_per_100g";
}

export interface NutritionBalanceAssessment {
  score: number;
  policyVersion: typeof RECOMMENDATION_POLICY_VERSION;
  proteinDensityGPer100Kcal: number | null;
  fiberDensityGPer100Kcal: number | null;
  sodiumDensityMgPer100Kcal: number | null;
  fatEnergyShare: number | null;
  fried: boolean;
}

export interface HealthRankedRecipe {
  recipe: UnifiedDemoRecipe;
  calculation: DemoNutritionCalculation;
  assessment: NutritionBalanceAssessment;
}

function round(value: number, decimals = 1): number {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function density(value: number | null, kcal: number): number | null {
  return value === null || kcal <= 0 ? null : value * 100 / kcal;
}

/**
 * Scales the verified per-100g snapshot to a requested energy amount.
 * The rounded gram amount is the source of truth for the returned macros,
 * so displayed grams and displayed nutrition always reconcile.
 */
export function calculatePortionForCalories(
  calculation: DemoNutritionCalculation,
  requestedCaloriesKcal: number,
  servingCount = 1,
  rounding: "nearest" | "floor" = "nearest",
): CalculatedPortion | null {
  const kcalPer100g = calculation.per100g.kcal;
  if (kcalPer100g === null || kcalPer100g <= 0 || !Number.isFinite(requestedCaloriesKcal) || requestedCaloriesKcal <= 0) return null;
  const rawGrams = requestedCaloriesKcal * 100 / kcalPer100g;
  const portionGrams = Math.max(1, rounding === "floor" ? Math.floor(rawGrams) : Math.round(rawGrams));
  const multiplier = portionGrams / 100;
  const nutrition = Object.fromEntries(Object.entries(calculation.per100g).map(([key, value]) => [
    key,
    value === null ? null : round(value * multiplier),
  ])) as DemoNutrition;
  const servingWeightG = calculation.finalWeightG <= 0 || servingCount <= 0 ? null : calculation.finalWeightG / servingCount;
  return {
    portionGrams,
    servingFraction: servingWeightG === null ? 1 : round(portionGrams / servingWeightG, 4),
    requestedCaloriesKcal,
    nutrition,
    basis: "verified_per_100g",
  };
}

/**
 * A deterministic comparison heuristic for this graduation project, not a
 * medical certification. It rewards protein/fiber density and penalizes high
 * sodium density, high fat-energy share, and recorded frying.
 */
export function assessNutritionBalance(
  recipe: UnifiedDemoRecipe,
  calculation: DemoNutritionCalculation,
): NutritionBalanceAssessment {
  const kcal = calculation.per100g.kcal;
  if (kcal === null || kcal <= 0) {
    return { score: 0, policyVersion: RECOMMENDATION_POLICY_VERSION, proteinDensityGPer100Kcal: null, fiberDensityGPer100Kcal: null, sodiumDensityMgPer100Kcal: null, fatEnergyShare: null, fried: false };
  }
  const proteinDensity = density(calculation.per100g.protein, kcal);
  const fiberDensity = density(calculation.per100g.fiber, kcal);
  const sodiumDensity = density(calculation.per100g.sodium, kcal);
  const fatEnergyShare = calculation.per100g.fat === null ? null : calculation.per100g.fat * 9 / kcal;
  const fried = recipe.oil_absorption_applied || recipe.ingredients.some((ingredient) => ingredient.state === "frying");

  let score = 50;
  if (proteinDensity !== null) score += Math.min(20, proteinDensity * 1.6);
  if (fiberDensity !== null) score += Math.min(20, fiberDensity * 3);
  if (sodiumDensity !== null) score -= Math.min(20, sodiumDensity / 40);
  if (fatEnergyShare !== null && fatEnergyShare > 0.35) score -= Math.min(15, (fatEnergyShare - 0.35) * 50);
  if (fried) score -= 10;

  return {
    score: round(Math.max(0, Math.min(100, score))),
    policyVersion: RECOMMENDATION_POLICY_VERSION,
    proteinDensityGPer100Kcal: proteinDensity === null ? null : round(proteinDensity),
    fiberDensityGPer100Kcal: fiberDensity === null ? null : round(fiberDensity),
    sodiumDensityMgPer100Kcal: sodiumDensity === null ? null : round(sodiumDensity),
    fatEnergyShare: fatEnergyShare === null ? null : round(fatEnergyShare, 3),
    fried,
  };
}

export function rankHealthFirst(entries: readonly HealthRankedRecipe[], recentRecipeIds: readonly string[] = []): HealthRankedRecipe[] {
  const recent = new Set(recentRecipeIds);
  return [...entries].sort((left, right) => {
    const recentDifference = Number(recent.has(left.recipe.recipe_id)) - Number(recent.has(right.recipe.recipe_id));
    return recentDifference
      || right.assessment.score - left.assessment.score
      || left.recipe.recipe_id.localeCompare(right.recipe.recipe_id);
  });
}

/** Selects distinct cooking methods first, then fills remaining slots by rank. */
export function diversifyHealthRanked(entries: readonly HealthRankedRecipe[], limit: number): HealthRankedRecipe[] {
  const selected: HealthRankedRecipe[] = [];
  const usedMethods = new Set<string>();
  for (const entry of entries) {
    if (selected.length >= limit) break;
    if (usedMethods.has(entry.recipe.cooking_method)) continue;
    selected.push(entry);
    usedMethods.add(entry.recipe.cooking_method);
  }
  for (const entry of entries) {
    if (selected.length >= limit) break;
    if (!selected.some((candidate) => candidate.recipe.recipe_id === entry.recipe.recipe_id)) selected.push(entry);
  }
  return selected;
}
