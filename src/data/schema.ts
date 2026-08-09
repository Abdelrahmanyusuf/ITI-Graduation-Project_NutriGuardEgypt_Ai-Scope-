/**
 * NutriGuard Step 4 — canonical DB schema definition.
 *
 * The single source of truth for table/column names, food states, and the
 * invariants the database enforces. Actual *verification* of the live schema
 * is done by real PostgreSQL integration checks (see `schemaVerify.ts`), which
 * query the database catalog — there is deliberately NO substring-based SQL
 * validator here.
 *
 * The strict invariants (mirrored in migrations/0001_init.up.sql):
 *   - Missing values are NULL, never an invented zero (no NOT NULL default on
 *     optional numerics; CHECKs reject only impossible negatives / ranges).
 *   - Provenance + version: numeric tables carry source_id + data_version_id,
 *     and the version is pinned to the row's own source via a composite FK
 *     against data_versions(source_id, id).
 *   - Food-state constrained to the supported states everywhere it appears,
 *     including cooking_yield_factors' food_state_from / food_state_to.
 *   - Review records reference stable, enforceable typed targets — never an
 *     orphanable polymorphic (reviewable_type, reviewable_key) pair.
 *   - Quantitative guidance lives in guideline_rules (structured numeric rows);
 *     explanatory text lives in guideline_chunks.
 */

export const FOOD_STATES = ["raw", "cooked", "boiled", "fried", "baked", "drained"] as const;
export type FoodState = (typeof FOOD_STATES)[number];

export const MASS_UNITS = ["g", "kg"] as const;
export const VOLUME_UNITS = ["ml", "l"] as const;
export const HOUSEHOLD_UNITS = ["teaspoon", "tablespoon", "cup", "piece"] as const;

/** Every table the project guarantees, by migration 0001. */
export const REQUIRED_TABLES = [
  "schema_migrations",
  "sources",
  "data_versions",
  "units",
  "unit_aliases",
  "ingredients",
  "ingredient_aliases",
  "recipes",
  "recipe_aliases",
  "recipe_ingredients",
  "nutrient_values",
  "ingredient_unit_conversions",
  "cooking_yield_factors",
  "nutrient_retention_factors",
  "guideline_documents",
  "guideline_chunks",
  "guideline_rules",
  "review_records",
] as const;

/**
 * Provenance / version columns that must exist on every numeric record table so
 * that "every important numerical record can reference a source and version".
 */
export const PROVENANCE_COLUMNS = ["source_id", "data_version_id"] as const;

/**
 * Tables that must expose provenance + version columns. Kept conservative: only
 * the tables that hold quantitative/claimed values need them.
 */
export const PROVENANCE_BEARING_TABLES = [
  "units",
  "ingredients",
  "recipes",
  "recipe_ingredients",
  "nutrient_values",
  "ingredient_unit_conversions",
  "cooking_yield_factors",
  "nutrient_retention_factors",
  "guideline_documents",
  "guideline_chunks",
  "guideline_rules",
] as const;

/**
 * Tables that must carry a food_state column (single column named food_state).
 */
export const FOOD_STATE_TABLES = [
  "ingredients",
  "recipes",
  "recipe_ingredients",
  "nutrient_values",
  "ingredient_unit_conversions",
] as const;

/**
 * Tables where the food state is expressed as a pair of constrained columns
 * (from/to states of a cooking transition).
 */
export const FOOD_STATE_PAIR_TABLES = ["cooking_yield_factors"] as const;

/** Columns that guideline_rules must declare (quantitative, not prose). */
export const GUIDELINE_RULE_COLUMNS = ["metric", "operator", "value", "unit"] as const;

/**
 * Columns that preserve the original source text/value next to normalized
 * machine values. Verbatim provenance of where a numeric came from.
 */
export const ORIGINAL_PRESERVING_TABLES: Record<string, string[]> = {
  ingredient_unit_conversions: ["original_value", "original_from_unit", "original_to_unit", "original_context"],
  cooking_yield_factors: ["original_yield", "original_context"],
  nutrient_retention_factors: ["original_retention", "original_context"],
  guideline_rules: ["original_value", "original_unit", "original_context"],
  nutrient_values: ["original_value"],
  recipe_ingredients: ["raw_quantity", "raw_unit"],
  recipes: ["original_title", "original_row"],
  ingredients: ["original_text"],
} as const;

/**
 * The typed, enforceable review targets. row must set EXACTLY ONE of these
 * (see review_records_exactly_one_target CHECK); each is a real FOREIGN KEY so
 * an orphan can never be recorded.
 */
export const REVIEW_TARGET_COLUMNS = [
  "source_id",
  "ingredient_id",
  "recipe_id",
  "guideline_document_id",
  "guideline_rule_id",
] as const;

/**
 * Numeric CHECK expectations, matched against the real pg_constraint
 * definitions (so a real database is required). Strictly positive where zero
 * is impossible (conversion factor, yield factor); `>= 0` only where a real
 * measured zero is valid (nutrients, retention, quantitative guideline
 * values). NULL is always allowed (missing ≠ zero).
 */
export const NUMERIC_CHECKS: Array<{ table: string; expression: string }> = [
  { table: "recipes", expression: "servings is null or servings > 0" },
  { table: "recipes", expression: "final_cooked_weight_g is null or final_cooked_weight_g > 0" },
  { table: "recipe_ingredients", expression: "quantity is null or quantity >= 0" },
  { table: "nutrient_values", expression: "amount is null or amount >= 0" },
  { table: "ingredient_unit_conversions", expression: "factor > 0" },
  { table: "ingredient_unit_conversions", expression: "from_unit_id <> to_unit_id" },
  { table: "cooking_yield_factors", expression: "yield_factor > 0" },
  { table: "cooking_yield_factors", expression: "food_state_from <> food_state_to" },
  { table: "nutrient_retention_factors", expression: "retention_factor >= 0 and retention_factor <= 1" },
  { table: "guideline_rules", expression: "value >= 0" },
  { table: "units", expression: "factor_to_base is null or factor_to_base > 0" },
] as const;