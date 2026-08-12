import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RecipeNutritionResult } from "../domain/nutrition.js";
import {
  isLicenseApprovedByManifest,
  isSourceRecordApproved,
  parseManifest,
  sourceRecordForSourceId,
} from "../domain/manifest.js";
import type { RetrievalCorpus } from "../retrieval/ingestion.js";
import type { MealCategory } from "../services/dashboard/dashboard-client.js";

const DEMO_DATASET_NAME = "unified_egyptian_rag_database_v2_final.json";
const DEMO_MANIFEST_NAME = path.join("data", "manifest", "sources.json");
export const GRADUATION_RECIPE_SOURCE_ID = "graduation-unified-egyptian-recipes-v2";
export const GRADUATION_DEMO_CORPUS_ID = "NUTRIGUARD-EGYPT-GRADUATION-DEMO-V2";
export const GRADUATION_DEMO_VERSION = "2.0-final-demo-normalized";

const NUTRIENTS = ["kcal", "protein", "fat", "carbs", "fiber", "sugar", "sodium"] as const;
type DemoNutrient = (typeof NUTRIENTS)[number];
type DemoNutrition = Record<DemoNutrient, number | null>;
type DemoRetention = Partial<Record<DemoNutrient, number>>;

interface DemoIngredient {
  ingredient: string;
  grams: number;
  state: string;
  quantity: number;
  unit: string;
}

type DemoRecipeReviewStatus = "needs_review" | "verified" | "rejected";

export interface UnifiedDemoRecipe {
  recipe_id: string;
  name_en: string;
  name_ar: string;
  alt_names: string[];
  category: string;
  meal_categories: MealCategory[];
  origin: string;
  servings: number;
  ingredients: DemoIngredient[];
  method_summary: string;
  cooking_method: string;
  oil_absorption_applied: boolean;
  oil_absorption_factor: number | null;
  final_yield_weight_grams: number;
  source_culinary: string;
  source_url: string;
  status: DemoRecipeReviewStatus;
  cultural_reviewer_id: string | null;
  cultural_review_date: string | null;
}

interface NutritionReference extends DemoNutrition {
  edible_portion_pct: number;
  cooking_yield_pct: number;
}

interface DemoGuideline {
  doc_id: string;
  title_en: string;
  title_ar: string;
  content_en: string;
  content_ar: string;
  key_numbers: Record<string, unknown>;
}

export interface UnifiedDemoQuestion {
  id: string;
  question: string;
  expected_recipe: string;
  expected_outcome: string;
  category: string;
  language: string;
  consent_source: string;
  approval_reference: string;
}

export interface UnifiedEgyptianDemoDataset {
  metadata: { version: string; created_date: string; review_status: string };
  recipes: UnifiedDemoRecipe[];
  ingredientNutrition: Record<string, NutritionReference>;
  retentionFactors: Record<string, DemoRetention>;
  guidelines: DemoGuideline[];
  questions: UnifiedDemoQuestion[];
  sourceApproval: { sourceStatus: "approved" | "pending"; licenseStatus: "approved" | "pending" };
}

export interface DemoNutritionCalculation {
  totals: DemoNutrition;
  perServing: DemoNutrition;
  per100g: DemoNutrition;
  finalWeightG: number;
  absorbedFryingOilG: number;
  excludedFryingOilG: number;
  assumptions: string[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function nonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
  return value;
}

function nullableNonNegative(value: unknown, label: string): number | null {
  return value === null ? null : nonNegative(value, label);
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a string array`);
  return value.map((item) => item.trim()).filter(Boolean);
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

function recipeReviewStatus(value: unknown, label: string): DemoRecipeReviewStatus {
  const status = string(value, label);
  if (status !== "needs_review" && status !== "verified" && status !== "rejected") {
    throw new Error(`${label} must be needs_review, verified or rejected`);
  }
  return status;
}

function nutrition(value: unknown, label: string): NutritionReference {
  const item = record(value, label);
  const parsed = {} as DemoNutrition;
  for (const nutrient of NUTRIENTS) parsed[nutrient] = nullableNonNegative(item[nutrient], `${label}.${nutrient}`);
  const edible = positive(item.edible_portion_pct, `${label}.edible_portion_pct`);
  const cookingYield = positive(item.cooking_yield_pct, `${label}.cooking_yield_pct`);
  if (edible > 100) throw new Error(`${label}.edible_portion_pct cannot exceed 100`);
  return { ...parsed, edible_portion_pct: edible, cooking_yield_pct: cookingYield };
}

function parseRecipe(value: unknown, index: number): UnifiedDemoRecipe {
  const item = record(value, `recipes[${index}]`);
  const ingredientsRaw = item.ingredients;
  if (!Array.isArray(ingredientsRaw) || ingredientsRaw.length === 0) throw new Error(`recipes[${index}].ingredients must be non-empty`);
  const ingredients = ingredientsRaw.map((raw, ingredientIndex) => {
    const ingredient = record(raw, `recipes[${index}].ingredients[${ingredientIndex}]`);
    return {
      ingredient: string(ingredient.ingredient, `recipes[${index}].ingredients[${ingredientIndex}].ingredient`),
      grams: positive(ingredient.grams, `recipes[${index}].ingredients[${ingredientIndex}].grams`),
      state: string(ingredient.state, `recipes[${index}].ingredients[${ingredientIndex}].state`),
      quantity: positive(ingredient.quantity, `recipes[${index}].ingredients[${ingredientIndex}].quantity`),
      unit: string(ingredient.unit, `recipes[${index}].ingredients[${ingredientIndex}].unit`),
    };
  });
  const recipeId = string(item.recipe_id, `recipes[${index}].recipe_id`);
  if (!/^EGY-RCP-\d{3}$/.test(recipeId)) throw new Error(`recipes[${index}].recipe_id has invalid format`);
  const oilApplied = item.oil_absorption_applied === true;
  const oilFactor = item.oil_absorption_factor === null ? null : positive(item.oil_absorption_factor, `recipes[${index}].oil_absorption_factor`);
  if (oilFactor !== null && oilFactor > 1) throw new Error(`recipes[${index}].oil_absorption_factor cannot exceed 1`);
  if (oilApplied && oilFactor === null) throw new Error(`recipes[${index}] applies oil absorption without a factor`);
  const mealCategories = strings(item.meal_categories, `recipes[${index}].meal_categories`);
  if (
    mealCategories.length === 0 ||
    mealCategories.some((category) => category !== "breakfast" && category !== "lunch" && category !== "dinner") ||
    new Set(mealCategories).size !== mealCategories.length
  ) {
    throw new Error(`recipes[${index}].meal_categories must contain unique breakfast/lunch/dinner review decisions`);
  }
  return {
    recipe_id: recipeId,
    name_en: string(item.name_en, `recipes[${index}].name_en`),
    name_ar: string(item.name_ar, `recipes[${index}].name_ar`),
    alt_names: strings(item.alt_names, `recipes[${index}].alt_names`),
    category: string(item.category, `recipes[${index}].category`),
    meal_categories: mealCategories as MealCategory[],
    origin: string(item.origin, `recipes[${index}].origin`),
    servings: positive(item.servings, `recipes[${index}].servings`),
    ingredients,
    method_summary: string(item.method_summary, `recipes[${index}].method_summary`),
    cooking_method: string(item.cooking_method, `recipes[${index}].cooking_method`),
    oil_absorption_applied: oilApplied,
    oil_absorption_factor: oilFactor,
    final_yield_weight_grams: positive(item.final_yield_weight_grams, `recipes[${index}].final_yield_weight_grams`),
    source_culinary: string(item.source_culinary, `recipes[${index}].source_culinary`),
    source_url: string(item.source_url, `recipes[${index}].source_url`),
    status: recipeReviewStatus(item.status, `recipes[${index}].status`),
    cultural_reviewer_id: nullableString(item.cultural_reviewer_id, `recipes[${index}].cultural_reviewer_id`),
    cultural_review_date: nullableString(item.cultural_review_date, `recipes[${index}].cultural_review_date`),
  };
}

export function parseUnifiedEgyptianDemoDataset(value: unknown): UnifiedEgyptianDemoDataset {
  const root = record(value, "dataset");
  const metadata = record(root.metadata, "metadata");
  if (!Array.isArray(root.recipes) || root.recipes.length === 0) throw new Error("recipes must be non-empty");
  const recipes = root.recipes.map(parseRecipe);
  const referenceRaw = record(root.ingredient_nutrition_reference, "ingredient_nutrition_reference");
  const ingredientNutrition = Object.fromEntries(Object.entries(referenceRaw).map(([key, ref]) => [key, nutrition(ref, `ingredient_nutrition_reference.${key}`)]));
  const retentionRaw = record(root.nutrient_retention_factors, "nutrient_retention_factors");
  const retentionFactors: Record<string, DemoRetention> = {};
  for (const [method, raw] of Object.entries(retentionRaw)) {
    const factors = record(raw, `nutrient_retention_factors.${method}`);
    retentionFactors[method] = Object.fromEntries(NUTRIENTS.filter((key) => factors[key] !== undefined).map((key) => {
      const factor = nonNegative(factors[key], `nutrient_retention_factors.${method}.${key}`);
      if (factor > 1) throw new Error(`nutrient_retention_factors.${method}.${key} cannot exceed 1`);
      return [key, factor];
    })) as DemoRetention;
  }
  const dietary = record(root.dietary_guidelines, "dietary_guidelines");
  if (!Array.isArray(dietary.rag_documents)) throw new Error("dietary_guidelines.rag_documents must be an array");
  const guidelines = dietary.rag_documents.map((raw, index) => {
    const item = record(raw, `dietary_guidelines.rag_documents[${index}]`);
    return {
      doc_id: string(item.doc_id, `dietary_guidelines.rag_documents[${index}].doc_id`),
      title_en: string(item.title_en, `dietary_guidelines.rag_documents[${index}].title_en`),
      title_ar: string(item.title_ar, `dietary_guidelines.rag_documents[${index}].title_ar`),
      content_en: string(item.content_en, `dietary_guidelines.rag_documents[${index}].content_en`),
      content_ar: string(item.content_ar, `dietary_guidelines.rag_documents[${index}].content_ar`),
      key_numbers: record(item.key_numbers, `dietary_guidelines.rag_documents[${index}].key_numbers`),
    };
  });
  if (!Array.isArray(root.rag_questions)) throw new Error("rag_questions must be an array");
  const questions = root.rag_questions.map((raw, index) => {
    const item = record(raw, `rag_questions[${index}]`);
    return {
      id: string(item.id, `rag_questions[${index}].id`), question: string(item.question, `rag_questions[${index}].question`),
      expected_recipe: string(item.expected_recipe, `rag_questions[${index}].expected_recipe`), expected_outcome: string(item.expected_outcome, `rag_questions[${index}].expected_outcome`),
      category: string(item.category, `rag_questions[${index}].category`), language: string(item.language, `rag_questions[${index}].language`),
      consent_source: string(item.consent_source, `rag_questions[${index}].consent_source`), approval_reference: string(item.approval_reference, `rag_questions[${index}].approval_reference`),
    };
  });
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const recipe of recipes) {
    if (ids.has(recipe.recipe_id)) throw new Error(`duplicate recipe id: ${recipe.recipe_id}`);
    ids.add(recipe.recipe_id);
    const name = normalizeName(recipe.name_en);
    if (names.has(name)) throw new Error(`duplicate recipe name: ${recipe.name_en}`);
    names.add(name);
    for (const ingredient of recipe.ingredients) if (!ingredientNutrition[ingredient.ingredient]) throw new Error(`${recipe.recipe_id} references unknown ingredient ${ingredient.ingredient}`);
  }
  return {
    metadata: { version: string(metadata.version, "metadata.version"), created_date: string(metadata.created_date, "metadata.created_date"), review_status: string(metadata.review_status, "metadata.review_status") },
    recipes, ingredientNutrition, retentionFactors, guidelines, questions,
    sourceApproval: { sourceStatus: "pending", licenseStatus: "pending" },
  };
}

export async function loadUnifiedEgyptianDemoDataset(
  file = process.env.NUTRIGUARD_DEMO_DATASET_PATH?.trim() || path.resolve(DEMO_DATASET_NAME),
  manifestFile = path.resolve(DEMO_MANIFEST_NAME),
): Promise<UnifiedEgyptianDemoDataset> {
  const [datasetRaw, manifestRaw] = await Promise.all([
    readFile(path.resolve(file), "utf8"),
    readFile(path.resolve(manifestFile), "utf8"),
  ]);
  const dataset = parseUnifiedEgyptianDemoDataset(JSON.parse(datasetRaw) as unknown);
  const sourceRecord = sourceRecordForSourceId(parseManifest(manifestRaw), GRADUATION_RECIPE_SOURCE_ID, DEMO_DATASET_NAME);
  return {
    ...dataset,
    sourceApproval: {
      sourceStatus: sourceRecord && isSourceRecordApproved(sourceRecord) ? "approved" : "pending",
      licenseStatus: sourceRecord && isLicenseApprovedByManifest(sourceRecord) ? "approved" : "pending",
    },
  };
}

function round(value: number, decimals = 1): number {
  const power = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * power) / power;
}

export function calculateUnifiedDemoNutrition(dataset: UnifiedEgyptianDemoDataset, recipe: UnifiedDemoRecipe): DemoNutritionCalculation {
  const knownTotals = Object.fromEntries(NUTRIENTS.map((key) => [key, 0])) as Record<DemoNutrient, number>;
  const missingNutrients = new Set<DemoNutrient>();
  let absorbedFryingOilG = 0;
  let excludedFryingOilG = 0;
  let correctedFriedWeightG = 0;
  for (const ingredient of recipe.ingredients) {
    const ref = dataset.ingredientNutrition[ingredient.ingredient];
    if (!ref) throw new Error(`${recipe.recipe_id} references missing nutrition ${ingredient.ingredient}`);
    let effectiveGrams = ingredient.grams * ref.edible_portion_pct / 100;
    if (recipe.oil_absorption_applied && ingredient.state === "frying") {
      excludedFryingOilG += effectiveGrams;
      effectiveGrams *= recipe.oil_absorption_factor ?? 0;
      absorbedFryingOilG += effectiveGrams;
    }
    correctedFriedWeightG += effectiveGrams * ref.cooking_yield_pct / 100;
    for (const nutrient of NUTRIENTS) {
      const value = ref[nutrient];
      if (value === null) missingNutrients.add(nutrient);
      else knownTotals[nutrient] += value * effectiveGrams / 100;
    }
  }
  const factors = dataset.retentionFactors[recipe.cooking_method] ?? {};
  const totals = Object.fromEntries(NUTRIENTS.map((nutrient) => [nutrient, missingNutrients.has(nutrient) ? null : round(knownTotals[nutrient] * (factors[nutrient] ?? 1))])) as DemoNutrition;
  const finalWeightG = round(recipe.oil_absorption_applied ? correctedFriedWeightG : recipe.final_yield_weight_grams);
  const perServing = Object.fromEntries(NUTRIENTS.map((key) => [key, totals[key] === null ? null : round(totals[key] / recipe.servings)])) as DemoNutrition;
  const per100g = Object.fromEntries(NUTRIENTS.map((key) => [key, totals[key] === null ? null : round(totals[key] * 100 / finalWeightG)])) as DemoNutrition;
  const assumptions = ["graduation_project_recipe_source_approved", "ingredient_reference_values_are_estimates"];
  if (excludedFryingOilG > 0) assumptions.push("frying_oil_counted_only_at_declared_absorption_fraction");
  return { totals, perServing, per100g, finalWeightG, absorbedFryingOilG: round(absorbedFryingOilG), excludedFryingOilG: round(excludedFryingOilG), assumptions };
}

function outputNutrients(values: DemoNutrition) {
  const nutrient = (amount: number | null, unit: "kcal" | "g" | "mg", decimals: number) => ({ amount, knownSubtotal: amount ?? 0, unit, decimals });
  return {
    calories: nutrient(values.kcal, "kcal", 0), protein: nutrient(values.protein, "g", 1), carbohydrate: nutrient(values.carbs, "g", 1),
    total_fat: nutrient(values.fat, "g", 1), saturated_fat: nutrient(null, "g", 1), fiber: nutrient(values.fiber, "g", 1),
    sugar: nutrient(values.sugar, "g", 1), sodium: nutrient(values.sodium, "mg", 0),
  };
}

export function toRecipeNutritionResult(dataset: UnifiedEgyptianDemoDataset, recipe: UnifiedDemoRecipe): RecipeNutritionResult {
  const calculation = calculateUnifiedDemoNutrition(dataset, recipe);
  const basis = (name: "full_recipe" | "per_serving" | "per_100g", values: DemoNutrition, weightG: number, divisor: number) => ({ basis: name, basisStatus: "available" as const, reason: null, divisor, weightG, nutrients: outputNutrients(values) });
  return {
    recipeId: recipe.recipe_id, calculationStatus: NUTRIENTS.some((nutrient) => calculation.totals[nutrient] === null) ? "partial" : "complete", requestedBases: ["full_recipe", "per_serving", "per_100g"], servingCount: recipe.servings,
    finalFoodWeightG: calculation.finalWeightG, servingWeightG: round(calculation.finalWeightG / recipe.servings),
    bases: {
      full_recipe: basis("full_recipe", calculation.totals, calculation.finalWeightG, 1),
      per_serving: basis("per_serving", calculation.perServing, round(calculation.finalWeightG / recipe.servings), recipe.servings),
      per_100g: basis("per_100g", calculation.per100g, 100, calculation.finalWeightG / 100),
    },
    missingIngredients: [], assumptions: calculation.assumptions.map((code) => ({ code, message: code.replaceAll("_", " "), ingredientIndex: null })),
    coverage: {
      ingredientCount: recipe.ingredients.length, requiredIngredientCount: recipe.ingredients.length, resolvedIngredientCount: recipe.ingredients.length,
      gramConvertedIngredientCount: recipe.ingredients.length, nutritionProfileIngredientCount: recipe.ingredients.length, calculableIngredientCount: recipe.ingredients.length,
      resolutionRate: 1, gramConversionRate: 1, nutritionProfileRate: 1, knownFinalWeightG: calculation.finalWeightG,
      nutritionCoveredWeightG: calculation.finalWeightG, weightCoverageRate: 1, weightDenominatorComplete: true,
      byNutrient: Object.fromEntries(["calories", "protein", "carbohydrate", "total_fat", "saturated_fat", "fiber", "sugar", "sodium"].map((key) => {
        const demoKey: DemoNutrient | null = key === "calories" ? "kcal" : key === "carbohydrate" ? "carbs" : key === "total_fat" ? "fat" : key === "saturated_fat" ? null : key as DemoNutrient;
        const covered = demoKey !== null && calculation.totals[demoKey] !== null;
        return [key, { coveredRequiredIngredients: covered ? recipe.ingredients.length : 0, requiredIngredients: recipe.ingredients.length, rate: covered ? 1 : 0 }];
      })) as RecipeNutritionResult["coverage"]["byNutrient"],
    },
    provenance: [{ sourceId: GRADUATION_RECIPE_SOURCE_ID, versionId: GRADUATION_DEMO_VERSION, roles: ["recipe_source", "graduation_project", "nutrition_estimate"] }], trace: [], blockers: [],
    roundingPolicy: {
      calories: { unit: "kcal", decimals: 0, stage: "output_only" }, protein: { unit: "g", decimals: 1, stage: "output_only" }, carbohydrate: { unit: "g", decimals: 1, stage: "output_only" },
      total_fat: { unit: "g", decimals: 1, stage: "output_only" }, saturated_fat: { unit: "g", decimals: 1, stage: "output_only" }, fiber: { unit: "g", decimals: 1, stage: "output_only" },
      sugar: { unit: "g", decimals: 1, stage: "output_only" }, sodium: { unit: "mg", decimals: 0, stage: "output_only" },
    },
  };
}

function correctedGuidelines(dataset: UnifiedEgyptianDemoDataset): Array<{ id: string; title: string; text: string; url: string }> {
  const map: Record<string, { url: string; title: string }> = {
    "WHO-SODIUM-2024": { url: "https://www.who.int/publications/i/item/9789241504836", title: "WHO Guideline: Sodium Intake for Adults and Children (2012)" },
    "WHO-SUGAR-2024": { url: "https://www.who.int/publications/i/item/9789241549028", title: "WHO Guideline: Sugars Intake for Adults and Children (2015)" },
    "WHO-FAT-2024": { url: "https://www.who.int/publications/i/item/9789240073630", title: "WHO Guideline: Saturated and Trans Fatty Acid Intake (2023)" },
  };
  const datasetGuidelines = dataset.guidelines.filter((item) => map[item.doc_id]).map((item) => ({ id: item.doc_id.replace("-2024", ""), title: map[item.doc_id]!.title, text: `${item.content_ar}\n\n${item.content_en}`, url: map[item.doc_id]!.url }));
  return [...datasetGuidelines, {
    id: "WHO-HEALTHY-DIET",
    title: "WHO Healthy Diet Fact Sheet",
    text: "منظمة الصحة العالمية لا تفرض شكلاً واحدًا للهرم الغذائي. وتصف النظام الصحي من خلال أربعة مبادئ: الكفاية، والتوازن، والاعتدال، والتنوع، مع الاعتماد على أغذية متنوعة قليلة التصنيع مثل الخضروات والفاكهة والبقول والحبوب الكاملة ومصادر البروتين قليلة الدهون، والحد من الصوديوم والسكريات الحرة والدهون غير الصحية.\n\nWHO describes healthy diets through adequacy, balance, moderation and diversity rather than one universal pyramid shape, emphasizing varied minimally processed foods and limiting sodium, free sugars and unhealthy fats.",
    url: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
  }];
}

export function buildGraduationRetrievalCorpus(dataset: UnifiedEgyptianDemoDataset): RetrievalCorpus {
  const recipeDocuments = dataset.recipes.map((recipe) => {
    const calculation = calculateUnifiedDemoNutrition(dataset, recipe);
    const ingredientText = recipe.ingredients.map((item) => `${item.quantity} ${item.unit} ${item.ingredient} (${item.grams} g, ${item.state})`).join("; ");
    const status = recipe.status === "rejected"
      ? "rejected" as const
      : recipe.status === "verified" && dataset.sourceApproval.sourceStatus === "approved"
        ? "approved" as const
        : "pending" as const;
    const hasCompletedCulturalReview = recipe.status === "verified"
      && recipe.cultural_reviewer_id !== null
      && recipe.cultural_review_date !== null;
    const egyptianVerificationStatus = recipe.status === "rejected"
      ? "rejected" as const
      : hasCompletedCulturalReview ? "verified" as const : "pending" as const;
    return {
      id: `DEMO-${recipe.recipe_id}`, kind: "recipe" as const, title: `${recipe.name_ar} | ${recipe.name_en}${recipe.alt_names.length > 0 ? ` | ${recipe.alt_names.join(" | ")}` : ""}`,
      text: [`وصفة معتمدة للاستخدام داخل مشروع تخرج NutriGuard.`, `الأسماء البديلة: ${recipe.alt_names.join(", ") || "—"}`, `المكونات: ${ingredientText}`, `الطريقة: ${recipe.method_summary}`, `تقدير الحصة: ${calculation.perServing.kcal} kcal، بروتين ${calculation.perServing.protein} g، دهون ${calculation.perServing.fat} g، كربوهيدرات ${calculation.perServing.carbs} g، صوديوم ${calculation.perServing.sodium} mg.`].join("\n"),
      language: "ar-EG" as const,
      status,
      licenseStatus: dataset.sourceApproval.licenseStatus,
      egyptianVerificationStatus,
      sourceId: GRADUATION_RECIPE_SOURCE_ID, versionId: GRADUATION_DEMO_VERSION, sourceTitle: "NutriGuard graduation-project approved recipeSource",
      sourceUrl: recipe.source_url, sourceAccessedAt: dataset.metadata.created_date, sourceLocator: recipe.recipe_id,
      metadata: { recipeId: recipe.recipe_id, demoOnly: true, reviewStatus: recipe.status, category: recipe.category, cookingMethod: recipe.cooking_method },
    };
  });
  const guidelineDocuments = correctedGuidelines(dataset).map((item) => ({
    id: `DEMO-${item.id}`, kind: "guideline" as const, title: item.title, text: item.text, language: "ar-EG" as const,
    status: "approved" as const, licenseStatus: "approved" as const, sourceId: "DEMO-WHO-GUIDANCE", versionId: GRADUATION_DEMO_VERSION,
    sourceTitle: "WHO guidance normalized for graduation demo", sourceUrl: item.url, sourceAccessedAt: dataset.metadata.created_date, sourceLocator: item.id,
    metadata: { demoOnly: true, reviewStatus: dataset.metadata.review_status, chunkId: item.id },
  }));
  return { schemaVersion: "1.0", corpusId: GRADUATION_DEMO_CORPUS_ID, documents: [...recipeDocuments, ...guidelineDocuments] };
}

export function normalizeName(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase("en").replace(/[’']/gu, "").replace(/\begyptian\b/gu, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

export function resolveDemoQuestionRecipe(dataset: UnifiedEgyptianDemoDataset, expectedRecipe: string): string | null {
  if (normalizeName(expectedRecipe) === "various") return null;
  const target = normalizeName(expectedRecipe);
  const reviewedDemoAliases: Record<string, string> = {
    "fattah with meat": "EGY-RCP-011",
    "stuffed pigeon with chicken": "EGY-RCP-005",
    "colocasia": "EGY-RCP-031",
  };
  if (reviewedDemoAliases[target]) return reviewedDemoAliases[target];
  const exact = dataset.recipes.filter((recipe) => [recipe.name_en, ...recipe.alt_names].some((name) => normalizeName(name) === target));
  if (exact.length === 1) return exact[0]!.recipe_id;
  const targetTokens = new Set(target.split(" ").filter((token) => token.length > 1));
  const scored = dataset.recipes.map((recipe) => {
    const aliases = [recipe.name_en, ...recipe.alt_names].map(normalizeName);
    const score = Math.max(...aliases.map((alias) => {
      const tokens = new Set(alias.split(" ").filter((token) => token.length > 1));
      const overlap = [...targetTokens].filter((token) => tokens.has(token)).length;
      return overlap / Math.max(targetTokens.size, tokens.size, 1);
    }));
    return { recipe, score };
  }).sort((a, b) => b.score - a.score || a.recipe.recipe_id.localeCompare(b.recipe.recipe_id));
  if ((scored[0]?.score ?? 0) < 0.5 || scored[0]?.score === scored[1]?.score) return null;
  return scored[0]!.recipe.recipe_id;
}
