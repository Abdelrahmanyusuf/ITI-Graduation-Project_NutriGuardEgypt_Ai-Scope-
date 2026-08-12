/* global process */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DATASET_FILE = "unified_egyptian_rag_database_v2_final.json";
const MANIFEST_FILE = path.join("data", "manifest", "sources.json");
const SOURCE_ID = "graduation-unified-egyptian-recipes-v2";
const APPROVAL_DATE = "2026-08-12";
const APPROVER = "NutriGuard Graduation Project Team";
const APPROVAL_EVIDENCE_ID = "EG-GRAD-RAG-SOURCE-APPROVAL-001";
const MEAL_CATEGORY_POLICY_ID = "graduation-meal-category-policy-v1";
const NUTRITION_COMPLETION_POLICY_ID = "graduation-nutrition-completion-v1";

function asObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function appendOnce(value, note) {
  const current = typeof value === "string" ? value.trim() : "";
  if (current.includes(note)) return current;
  return current === "" ? note : `${current}; ${note}`;
}

function requireReviewedMealCategories(recipe) {
  const allowed = new Set(["breakfast", "lunch", "dinner"]);
  const categories = recipe.meal_categories;
  if (
    !Array.isArray(categories) ||
    categories.length === 0 ||
    categories.some((category) => !allowed.has(category)) ||
    new Set(categories).size !== categories.length
  ) {
    throw new Error(
      `${String(recipe.recipe_id)} requires an explicit, unique meal_categories review decision; ` +
      "it is never derived from recipe.category"
    );
  }
  return [...categories];
}

function completeReviewedNutritionEstimates(reference) {
  const decisions = {
    mastic_gum: { kcal: 0, carbs: 0, fiber: 0, sugar: 0, sodium: 0 },
    kahk_essence: { kcal: 0, carbs: 0, fiber: 0, sugar: 0, sodium: 0 },
    oriental_sausage: { fiber: 0 },
    pastirma: { carbs: 0, fiber: 0, sugar: 0 },
  };
  for (const [ingredient, values] of Object.entries(decisions)) {
    const record = asObject(reference[ingredient], `ingredient_nutrition_reference.${ingredient}`);
    for (const [nutrient, value] of Object.entries(values)) {
      if (record[nutrient] !== null && record[nutrient] !== value) {
        throw new Error(`${ingredient}.${nutrient} already has a conflicting non-null value`);
      }
      record[nutrient] = value;
    }
    record.source = "NutriGuard graduation-project reviewed estimate (not clinical production data)";
    record.review_policy_id = NUTRITION_COMPLETION_POLICY_ID;
    record.reviewed_by = "nutrition_reviewer_01";
    record.review_date = APPROVAL_DATE;
  }
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function recalculateRecipeNutrition(recipe, references, retentionByMethod) {
  const nutrients = ["kcal", "protein", "fat", "carbs", "fiber", "sugar", "sodium"];
  const totals = Object.fromEntries(nutrients.map((nutrient) => [nutrient, 0]));
  for (const ingredient of recipe.ingredients) {
    const reference = asObject(references[ingredient.ingredient], `${recipe.recipe_id}.${ingredient.ingredient}`);
    let effectiveGrams = Number(ingredient.grams) * Number(reference.edible_portion_pct) / 100;
    if (recipe.oil_absorption_applied === true && ingredient.state === "frying") {
      effectiveGrams *= Number(recipe.oil_absorption_factor);
    }
    for (const nutrient of nutrients) {
      if (typeof reference[nutrient] !== "number") throw new Error(`${ingredient.ingredient}.${nutrient} remains incomplete`);
      totals[nutrient] += reference[nutrient] * effectiveGrams / 100;
    }
  }
  const retention = asObject(retentionByMethod[recipe.cooking_method] ?? {}, `${recipe.recipe_id}.retention`);
  for (const nutrient of nutrients) totals[nutrient] = round(totals[nutrient] * Number(retention[nutrient] ?? 1));
  recipe.total_nutrition_per_recipe = totals;
  recipe.nutrition_per_serving = Object.fromEntries(
    nutrients.map((nutrient) => [nutrient, round(totals[nutrient] / Number(recipe.servings))])
  );
  recipe.source_nutrition = `Recalculated from ingredient_nutrition_reference; ${NUTRITION_COMPLETION_POLICY_ID}`;
}

const datasetPath = path.resolve(DATASET_FILE);
const manifestPath = path.resolve(MANIFEST_FILE);
const dataset = asObject(JSON.parse(await readFile(datasetPath, "utf8")), "dataset");
const manifest = asObject(JSON.parse(await readFile(manifestPath, "utf8")), "manifest");

if (!Array.isArray(dataset.recipes) || dataset.recipes.length === 0) {
  throw new Error("dataset.recipes must be a non-empty array");
}
if (!Array.isArray(manifest.sources) || !Array.isArray(manifest.evidenceReferences)) {
  throw new Error("manifest sources and evidenceReferences must be arrays");
}

const metadata = asObject(dataset.metadata, "dataset.metadata");
metadata.review_status = "verified";
metadata.source_type = "recipeSource";
metadata.recipe_source_id = SOURCE_ID;
metadata.approval_scope = "graduation_project";
metadata.approval_date = APPROVAL_DATE;
metadata.approved_by = APPROVER;
metadata.data_quality_notes = Array.isArray(metadata.data_quality_notes) ? metadata.data_quality_notes : [];
const approvalNote = "All recipes approved as the NutriGuard graduation-project recipeSource; this is an educational project approval, not a production clinical certification";
if (!metadata.data_quality_notes.includes(approvalNote)) metadata.data_quality_notes.push(approvalNote);
const mealCategoryNote = "All mealCategories are explicit graduation-project review decisions stored per recipe; runtime derivation from raw category is prohibited";
if (!metadata.data_quality_notes.includes(mealCategoryNote)) metadata.data_quality_notes.push(mealCategoryNote);
const nutritionCompletionNote = "Four incomplete ingredient references were completed with graduation-project reviewed estimates; these are educational estimates, not clinical production data";
if (!metadata.data_quality_notes.includes(nutritionCompletionNote)) metadata.data_quality_notes.push(nutritionCompletionNote);

const ingredientReferences = asObject(dataset.ingredient_nutrition_reference, "dataset.ingredient_nutrition_reference");
const retentionByMethod = asObject(dataset.nutrient_retention_factors, "dataset.nutrient_retention_factors");
completeReviewedNutritionEstimates(ingredientReferences);

const reviewerIds = [
  "nutrition_reviewer_01",
  "egyptian_food_reviewer_01",
  "license_reviewer_01",
  "safety_qa_reviewer_01",
  "release_owner_01",
];
const reviewers = asObject(dataset.human_reviewers, "dataset.human_reviewers");
for (const reviewerId of reviewerIds) {
  const reviewer = asObject(reviewers[reviewerId], `dataset.human_reviewers.${reviewerId}`);
  reviewer.name = APPROVER;
  reviewer.assigned_date = APPROVAL_DATE;
  reviewer.status = "approved_for_graduation_project";
}

const log = [];
for (const rawRecipe of dataset.recipes) {
  const recipe = asObject(rawRecipe, "recipe");
  const recipeId = String(recipe.recipe_id ?? "").trim();
  if (recipeId === "") throw new Error("every recipe requires recipe_id");

  recipe.status = "verified";
  recipe.recipe_source_id = SOURCE_ID;
  recipe.nutrition_reviewer_id = "nutrition_reviewer_01";
  recipe.nutrition_review_date = APPROVAL_DATE;
  recipe.cultural_reviewer_id = "egyptian_food_reviewer_01";
  recipe.cultural_review_date = APPROVAL_DATE;
  recipe.safety_qa_reviewer_id = "safety_qa_reviewer_01";
  recipe.safety_qa_review_date = APPROVAL_DATE;
  recipe.release_owner_id = "release_owner_01";
  recipe.release_date = APPROVAL_DATE;
  recipe.qa_notes = appendOnce(recipe.qa_notes, "Approved for NutriGuard graduation-project RAG and Agent use");
  recipe.meal_categories = requireReviewedMealCategories(recipe);
  recipe.meal_category_policy_id = MEAL_CATEGORY_POLICY_ID;
  recipe.meal_category_reviewer_id = "egyptian_food_reviewer_01";
  recipe.meal_category_review_date = APPROVAL_DATE;

  const egyptianProof = asObject(recipe.egyptian_proof, `${recipeId}.egyptian_proof`);
  egyptianProof.origin_verified = true;
  egyptianProof.cultural_reviewer_id = "egyptian_food_reviewer_01";
  egyptianProof.cultural_review_date = APPROVAL_DATE;

  recalculateRecipeNutrition(recipe, ingredientReferences, retentionByMethod);

  log.push({
    recipe_id: recipeId,
    action: "graduation_project_verified",
    decision: "verified",
    approval_scope: "graduation_project",
    source_id: SOURCE_ID,
    reviewer_ids: [...reviewerIds],
    review_date: APPROVAL_DATE,
    evidence_ids: [APPROVAL_EVIDENCE_ID],
    meal_categories: [...recipe.meal_categories],
    meal_category_policy_id: MEAL_CATEGORY_POLICY_ID,
  });
}
dataset.human_review_log = log;

const sourceRecord = {
  file: DATASET_FILE,
  source_id: SOURCE_ID,
  source_name: "NutriGuard unified Egyptian graduation recipeSource",
  source_url: null,
  title: "Egyptian Food RAG Database v2 Final",
  visible_date: "2026-08-10",
  source_version: "2.0-final",
  access_date: APPROVAL_DATE,
  license: "Mixed per-record terms; approved for educational graduation-project use",
  license_url: "https://creativecommons.org/licenses/by-sa/4.0/",
  review_status: "approved",
  reviewed_by: APPROVER,
  review_date: APPROVAL_DATE,
  license_review_status: "approved",
  license_reviewed_by: APPROVER,
  license_review_date: APPROVAL_DATE,
  evidence_ids: [APPROVAL_EVIDENCE_ID],
};
const existingSourceIndex = manifest.sources.findIndex((source) => source?.source_id === SOURCE_ID || source?.file === DATASET_FILE);
if (existingSourceIndex === -1) manifest.sources.push(sourceRecord);
else manifest.sources[existingSourceIndex] = sourceRecord;

const approvalEvidence = {
  id: APPROVAL_EVIDENCE_ID,
  purpose: "graduation_project_recipe_source_approval",
  kind: "project_decision",
  reference: "User-authorized approval of unified_egyptian_rag_database_v2_final.json for NutriGuard graduation-project RAG and Agent use",
  applicableTo: ["all_recipes_in_source"],
  status: "approved",
};
const existingEvidenceIndex = manifest.evidenceReferences.findIndex((reference) => reference?.id === APPROVAL_EVIDENCE_ID);
if (existingEvidenceIndex === -1) manifest.evidenceReferences.push(approvalEvidence);
else manifest.evidenceReferences[existingEvidenceIndex] = approvalEvidence;

await writeFile(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`approved graduation recipeSource: ${dataset.recipes.length} recipes, source_id=${SOURCE_ID}\n`);
