/**
 * Step 7 — deterministic recipe nutrition calculator.
 *
 * Arithmetic is application code only. Every accepted mapping, conversion,
 * nutrient profile, yield and retention factor is source/version traceable.
 * Missing data remains null and downgrades the result; it is never guessed.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildIndex,
  parseIngredientDictionary,
  parseReviewedMappings,
  parseReviewRegistry,
  resolveIngredient,
  type FoodState,
  type IngredientResolution,
} from "./ingredients.js";
import {
  convertIngredientAmount,
  parseUnitConversionRegistry,
  type AppliedFactorTrace,
  type QuantityConversionResult,
} from "./quantities.js";

export const NUTRITION_SNAPSHOT_SCHEMA_VERSION = "1.0";
export const NUTRITION_REGISTRY_SCHEMA_VERSION = "1.0";

export const NUTRIENT_CODES = [
  "calories",
  "protein",
  "carbohydrate",
  "total_fat",
  "saturated_fat",
  "fiber",
  "sugar",
  "sodium",
] as const;

export type NutrientCode = (typeof NUTRIENT_CODES)[number];
export type NutritionBasis = "full_recipe" | "per_serving" | "per_100g";
export type NutritionCalculationStatus = "unavailable" | "partial" | "complete";
export type BasisStatus = "available" | "unavailable";

export const REQUIRED_NUTRIENTS: readonly NutrientCode[] = [
  "calories",
  "protein",
  "carbohydrate",
  "total_fat",
  "fiber",
  "sodium",
];

export const OPTIONAL_NUTRIENTS: readonly NutrientCode[] = ["saturated_fat", "sugar"];

const NUTRIENT_META: Readonly<Record<NutrientCode, { unit: "kcal" | "g" | "mg"; decimals: number }>> = {
  calories: { unit: "kcal", decimals: 0 },
  protein: { unit: "g", decimals: 1 },
  carbohydrate: { unit: "g", decimals: 1 },
  total_fat: { unit: "g", decimals: 1 },
  saturated_fat: { unit: "g", decimals: 1 },
  fiber: { unit: "g", decimals: 1 },
  sugar: { unit: "g", decimals: 1 },
  sodium: { unit: "mg", decimals: 0 },
};

export interface StructuredRecipeIngredient {
  originalText: string;
  required: boolean;
  /** State after a sourced cooking transition; null means no transition requested. */
  targetFoodState: FoodState | null;
  /** Request a sourced as-purchased -> edible-portion adjustment. */
  applyEdiblePortion: boolean;
}

export interface StructuredNutritionRecipe {
  recipeId: string;
  verificationStatus: "verified" | "needs_review" | "rejected";
  ingredients: StructuredRecipeIngredient[];
  servings: number | null;
  finalFoodWeightG: number | null;
  sourceId: string;
  versionId: string;
}

export interface ServingRequest {
  /** Bases default to all three. full_recipe is always included. */
  bases?: readonly NutritionBasis[];
  /** Explicit request override; must be finite and > 0. */
  servingCount?: number | null;
  /** Explicit sourced/request weight override; must be finite and > 0. */
  finalFoodWeightG?: number | null;
}

export interface NutritionSourceRecord {
  sourceId: string;
  versionId: string;
  title: string;
  url: string;
  status: "approved" | "unapproved" | "rejected";
  licenseStatus: "approved" | "pending" | "rejected";
  syntheticTestOnly: boolean;
}

export interface NutrientProfile {
  id: string;
  ingredientKey: string;
  foodState: FoodState | null;
  basis: "per_100g" | "per_edible_100g";
  nutrients: Record<NutrientCode, number | null>;
  sourceId: string;
  versionId: string;
  originalContext: string;
  status: "approved" | "unapproved" | "rejected";
}

export interface NutrientRetentionFactor {
  id: string;
  ingredientKey: string | null;
  nutrient: NutrientCode;
  foodStateFrom: FoodState;
  foodStateTo: FoodState;
  factor: number;
  sourceId: string;
  versionId: string;
  originalValue: string;
  originalContext: string;
  status: "approved" | "unapproved" | "rejected";
}

export interface ParsedNutritionRegistry {
  sources: Map<string, NutritionSourceRecord>;
  profiles: NutrientProfile[];
  retentionFactors: NutrientRetentionFactor[];
  issues: string[];
}

export interface NutritionCalculationSnapshot {
  schemaVersion: "1.0";
  recipes: StructuredNutritionRecipe[];
  ingredientDictionary: unknown;
  reviewedMappings: unknown;
  reviewRegistry: unknown;
  unitConversionRegistry: unknown;
  nutritionRegistry: unknown;
}

export interface LoadedNutritionCalculationData {
  recipe: StructuredNutritionRecipe;
  ingredientDictionary: unknown;
  reviewedMappings: unknown;
  reviewRegistry: unknown;
  unitConversionRegistry: unknown;
  nutritionRegistry: unknown;
  allowSyntheticTestData: boolean;
}

export interface NutritionCalculationRepository {
  load(recipeId: string): Promise<LoadedNutritionCalculationData | null>;
}

class NutritionCalculationDataError extends Error {
  public constructor(public readonly blockers: string[]) {
    super(blockers.join(", "));
    this.name = "NutritionCalculationDataError";
  }
}

export interface ResultProvenance {
  sourceId: string;
  versionId: string;
  roles: string[];
}

export interface AssumptionRecord {
  code: string;
  message: string;
  ingredientIndex: number | null;
}

export interface MissingIngredientRecord {
  ingredientIndex: number;
  originalText: string;
  required: boolean;
  codes: string[];
}

export interface NutrientOutputValue {
  amount: number | null;
  knownSubtotal: number;
  unit: "kcal" | "g" | "mg";
  decimals: number;
}

export interface NutritionBasisResult {
  basis: NutritionBasis;
  basisStatus: BasisStatus;
  reason: string | null;
  divisor: number | null;
  weightG: number | null;
  nutrients: Record<NutrientCode, NutrientOutputValue>;
}

export interface IngredientNutrientTrace {
  nutrient: NutrientCode;
  profileAmountPer100g: number | null;
  profileBasis: "per_100g" | "per_edible_100g" | null;
  massUsedG: number | null;
  retentionFactor: number | null;
  /** Guarded-precision trace display; totals use an internal unrounded value. */
  traceContribution: number | null;
  outputContribution: number | null;
  sourceId: string | null;
  versionId: string | null;
  reason: string | null;
}

export interface IngredientCalculationTrace {
  ingredientIndex: number;
  originalText: string;
  required: boolean;
  resolution: {
    status: IngredientResolution["status"];
    stage: IngredientResolution["stage"];
    canonicalKey: string | null;
    foodState: FoodState | null;
    sourceId: string | null;
    versionId: string | null;
  };
  quantityConversion: QuantityConversionResult;
  nutritionFoodState: FoodState | null;
  nutrientProfileId: string | null;
  inputGrams: number | null;
  edibleGrams: number | null;
  finalGrams: number | null;
  retentionFactorIds: string[];
  nutrients: Record<NutrientCode, IngredientNutrientTrace>;
  omissions: string[];
}

export interface NutritionCoverageMetrics {
  ingredientCount: number;
  requiredIngredientCount: number;
  resolvedIngredientCount: number;
  gramConvertedIngredientCount: number;
  nutritionProfileIngredientCount: number;
  calculableIngredientCount: number;
  resolutionRate: number | null;
  gramConversionRate: number | null;
  nutritionProfileRate: number | null;
  knownFinalWeightG: number;
  nutritionCoveredWeightG: number;
  weightCoverageRate: number | null;
  weightDenominatorComplete: boolean;
  byNutrient: Record<NutrientCode, { coveredRequiredIngredients: number; requiredIngredients: number; rate: number | null }>;
}

export interface RecipeNutritionResult {
  recipeId: string;
  calculationStatus: NutritionCalculationStatus;
  requestedBases: NutritionBasis[];
  servingCount: number | null;
  finalFoodWeightG: number | null;
  servingWeightG: number | null;
  bases: Record<NutritionBasis, NutritionBasisResult>;
  missingIngredients: MissingIngredientRecord[];
  assumptions: AssumptionRecord[];
  coverage: NutritionCoverageMetrics;
  provenance: ResultProvenance[];
  trace: IngredientCalculationTrace[];
  blockers: string[];
  roundingPolicy: Record<NutrientCode, { unit: "kcal" | "g" | "mg"; decimals: number; stage: "output_only" }>;
}

interface RawNutritionRegistry {
  schemaVersion?: unknown;
  sources?: unknown;
  profiles?: unknown;
  retentionFactors?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function duplicateRecipeIds(recipes: readonly unknown[]): string[] {
  const counts = new Map<string, number>();
  for (const item of recipes) {
    const recipeId = asRecord(item)?.recipeId;
    if (typeof recipeId !== "string" || recipeId.trim() === "") continue;
    counts.set(recipeId, (counts.get(recipeId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([recipeId]) => recipeId)
    .sort((a, b) => a.localeCompare(b));
}

function stringField(record: Record<string, unknown>, field: string): string {
  return typeof record[field] === "string" ? (record[field] as string).trim() : "";
}

function nullableStringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value.trim() : "";
}

function isFoodState(value: string): value is FoodState {
  return value === "raw" || value === "cooked" || value === "boiled" || value === "fried" || value === "baked" || value === "drained";
}

function isNutrientCode(value: string): value is NutrientCode {
  return (NUTRIENT_CODES as readonly string[]).includes(value);
}

function isApprovedStatus(value: string): value is "approved" | "unapproved" | "rejected" {
  return value === "approved" || value === "unapproved" || value === "rejected";
}

/** Parse nutrition profiles/factors. Invalid or ambiguous records are excluded. */
export function parseNutritionRegistry(raw: unknown, knownIngredientKeys?: ReadonlySet<string>): ParsedNutritionRegistry {
  const sources = new Map<string, NutritionSourceRecord>();
  const profiles: NutrientProfile[] = [];
  const retentionFactors: NutrientRetentionFactor[] = [];
  const issues: string[] = [];
  const container = asRecord(raw) as RawNutritionRegistry | null;
  if (!container) return { sources, profiles, retentionFactors, issues: ["nutrition registry must be an object"] };
  if (container.schemaVersion !== NUTRITION_REGISTRY_SCHEMA_VERSION) {
    issues.push(`nutrition registry schemaVersion must be ${NUTRITION_REGISTRY_SCHEMA_VERSION}`);
  }

  const sourceIdCounts = new Map<string, number>();
  if (!Array.isArray(container.sources)) {
    issues.push("nutrition registry sources must be an array");
  } else {
    for (const item of container.sources) {
      const rec = asRecord(item);
      const id = rec ? stringField(rec, "sourceId") : "";
      if (id !== "") sourceIdCounts.set(id, (sourceIdCounts.get(id) ?? 0) + 1);
    }
    for (let index = 0; index < container.sources.length; index += 1) {
      const rec = asRecord(container.sources[index]);
      const label = `nutrition source ${index}`;
      if (!rec) {
        issues.push(`${label}: must be an object`);
        continue;
      }
      const sourceId = stringField(rec, "sourceId");
      const versionId = stringField(rec, "versionId");
      const title = stringField(rec, "title");
      const url = stringField(rec, "url");
      const status = stringField(rec, "status");
      const licenseStatus = stringField(rec, "licenseStatus");
      const syntheticTestOnly = rec.syntheticTestOnly === true;
      if (
        sourceId === "" || versionId === "" || title === "" || url === "" ||
        !isApprovedStatus(status) ||
        (licenseStatus !== "approved" && licenseStatus !== "pending" && licenseStatus !== "rejected") ||
        (sourceIdCounts.get(sourceId) ?? 0) !== 1
      ) {
        issues.push(`${label}: unique sourceId, versionId, title, url, status and licenseStatus are required`);
        continue;
      }
      sources.set(sourceId, {
        sourceId,
        versionId,
        title,
        url,
        status,
        licenseStatus,
        syntheticTestOnly,
      });
    }
  }

  const allFactorIds = new Map<string, number>();
  for (const collection of [container.profiles, container.retentionFactors]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      const rec = asRecord(item);
      const id = rec ? stringField(rec, "id") : "";
      if (id !== "") allFactorIds.set(id, (allFactorIds.get(id) ?? 0) + 1);
    }
  }

  const profileIdentities = new Set<string>();
  if (!Array.isArray(container.profiles)) {
    issues.push("nutrition registry profiles must be an array");
  } else {
    for (let index = 0; index < container.profiles.length; index += 1) {
      const rec = asRecord(container.profiles[index]);
      const label = `nutrient profile ${index}`;
      if (!rec) {
        issues.push(`${label}: must be an object`);
        continue;
      }
      const id = stringField(rec, "id");
      const ingredientKey = stringField(rec, "ingredientKey");
      const foodStateRaw = nullableStringField(rec, "foodState");
      const basis = stringField(rec, "basis");
      const sourceId = stringField(rec, "sourceId");
      const versionId = stringField(rec, "versionId");
      const originalContext = stringField(rec, "originalContext");
      const status = stringField(rec, "status");
      const nutrientsRaw = asRecord(rec.nutrients);
      const source = sources.get(sourceId);
      const identity = `${ingredientKey}|${foodStateRaw ?? ""}|${basis}`;
      let ok = true;
      if (id === "" || (allFactorIds.get(id) ?? 0) !== 1) {
        issues.push(`${label}: globally unique id is required`);
        ok = false;
      }
      if (ingredientKey === "" || (knownIngredientKeys && !knownIngredientKeys.has(ingredientKey))) {
        issues.push(`${label}: known ingredientKey is required`);
        ok = false;
      }
      if (foodStateRaw !== null && !isFoodState(foodStateRaw)) {
        issues.push(`${label}: invalid foodState`);
        ok = false;
      }
      if (basis !== "per_100g" && basis !== "per_edible_100g") {
        issues.push(`${label}: basis must be per_100g or per_edible_100g`);
        ok = false;
      }
      if (!source || source.versionId !== versionId || originalContext === "") {
        issues.push(`${label}: sourceId/versionId pair and originalContext are required`);
        ok = false;
      }
      if (!isApprovedStatus(status)) {
        issues.push(`${label}: invalid status`);
        ok = false;
      }
      if (!nutrientsRaw) {
        issues.push(`${label}: nutrients must be an object`);
        ok = false;
      }
      const nutrients = {} as Record<NutrientCode, number | null>;
      if (nutrientsRaw) {
        for (const code of NUTRIENT_CODES) {
          const amount = nutrientsRaw[code];
          if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) {
            issues.push(`${label}: nutrient ${code} must be null or a non-negative finite number`);
            ok = false;
          }
          nutrients[code] = amount === null || amount === undefined ? null : amount as number;
        }
      }
      if (profileIdentities.has(identity)) {
        issues.push(`${label}: duplicate profile identity "${identity}"`);
        ok = false;
      }
      if (!ok || !nutrientsRaw || !isApprovedStatus(status) || (foodStateRaw !== null && !isFoodState(foodStateRaw))) continue;
      profileIdentities.add(identity);
      profiles.push({
        id,
        ingredientKey,
        foodState: foodStateRaw as FoodState | null,
        basis: basis as "per_100g" | "per_edible_100g",
        nutrients,
        sourceId,
        versionId,
        originalContext,
        status,
      });
    }
  }

  const retentionIdentities = new Set<string>();
  if (!Array.isArray(container.retentionFactors)) {
    issues.push("nutrition registry retentionFactors must be an array");
  } else {
    for (let index = 0; index < container.retentionFactors.length; index += 1) {
      const rec = asRecord(container.retentionFactors[index]);
      const label = `retention factor ${index}`;
      if (!rec) {
        issues.push(`${label}: must be an object`);
        continue;
      }
      const id = stringField(rec, "id");
      const ingredientKeyRaw = nullableStringField(rec, "ingredientKey");
      const nutrientRaw = stringField(rec, "nutrient");
      const fromRaw = stringField(rec, "foodStateFrom");
      const toRaw = stringField(rec, "foodStateTo");
      const factor = rec.factor;
      const sourceId = stringField(rec, "sourceId");
      const versionId = stringField(rec, "versionId");
      const originalValue = stringField(rec, "originalValue");
      const originalContext = stringField(rec, "originalContext");
      const status = stringField(rec, "status");
      const source = sources.get(sourceId);
      const identity = `${ingredientKeyRaw ?? "*"}|${nutrientRaw}|${fromRaw}|${toRaw}`;
      let ok = true;
      if (id === "" || (allFactorIds.get(id) ?? 0) !== 1) {
        issues.push(`${label}: globally unique id is required`);
        ok = false;
      }
      if (ingredientKeyRaw !== null && (ingredientKeyRaw === "" || (knownIngredientKeys && !knownIngredientKeys.has(ingredientKeyRaw)))) {
        issues.push(`${label}: ingredientKey must be null or known`);
        ok = false;
      }
      if (!isNutrientCode(nutrientRaw) || !isFoodState(fromRaw) || !isFoodState(toRaw) || fromRaw === toRaw) {
        issues.push(`${label}: valid nutrient and distinct food states are required`);
        ok = false;
      }
      if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0 || factor > 1) {
        issues.push(`${label}: factor must be finite and within 0..1`);
        ok = false;
      }
      if (!source || source.versionId !== versionId || originalValue === "" || originalContext === "") {
        issues.push(`${label}: sourceId/versionId and original provenance fields are required`);
        ok = false;
      }
      if (!isApprovedStatus(status)) {
        issues.push(`${label}: invalid status`);
        ok = false;
      }
      if (retentionIdentities.has(identity)) {
        issues.push(`${label}: duplicate retention identity "${identity}"`);
        ok = false;
      }
      if (!ok || !isNutrientCode(nutrientRaw) || !isFoodState(fromRaw) || !isFoodState(toRaw) || typeof factor !== "number" || !isApprovedStatus(status)) continue;
      retentionIdentities.add(identity);
      retentionFactors.push({
        id,
        ingredientKey: ingredientKeyRaw,
        nutrient: nutrientRaw,
        foodStateFrom: fromRaw,
        foodStateTo: toRaw,
        factor,
        sourceId,
        versionId,
        originalValue,
        originalContext,
        status,
      });
    }
  }

  return { sources, profiles, retentionFactors, issues };
}

/** JSON snapshot loader used by the required public operation. */
export class JsonNutritionCalculationRepository implements NutritionCalculationRepository {
  public constructor(
    private readonly snapshotFile = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "data",
      "processed",
      "nutrition-calculator-snapshot.json"
    ),
    private readonly allowSyntheticTestData = false
  ) {}

  public async load(recipeId: string): Promise<LoadedNutritionCalculationData | null> {
    let raw: unknown;
    try {
      raw = JSON.parse((await fs.readFile(this.snapshotFile, "utf8")).replace(/^\uFEFF/, "")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const snapshot = asRecord(raw);
    if (!snapshot || snapshot.schemaVersion !== NUTRITION_SNAPSHOT_SCHEMA_VERSION || !Array.isArray(snapshot.recipes)) {
      throw new Error("nutrition calculator snapshot is structurally invalid");
    }
    const duplicates = duplicateRecipeIds(snapshot.recipes);
    if (duplicates.length > 0) {
      throw new NutritionCalculationDataError(
        duplicates.map((duplicateId) => `duplicate_recipe_id:${duplicateId}`)
      );
    }
    const recipe = snapshot.recipes.find((item) => asRecord(item)?.recipeId === recipeId) as StructuredNutritionRecipe | undefined;
    if (!recipe) return null;
    return {
      recipe,
      ingredientDictionary: snapshot.ingredientDictionary,
      reviewedMappings: snapshot.reviewedMappings,
      reviewRegistry: snapshot.reviewRegistry,
      unitConversionRegistry: snapshot.unitConversionRegistry,
      nutritionRegistry: snapshot.nutritionRegistry,
      allowSyntheticTestData: this.allowSyntheticTestData,
    };
  }
}

/** In-memory adapter for deterministic golden tests and controlled embedding. */
export class InMemoryNutritionCalculationRepository implements NutritionCalculationRepository {
  public constructor(private readonly data: Omit<LoadedNutritionCalculationData, "recipe"> & { recipes: StructuredNutritionRecipe[] }) {}

  public async load(recipeId: string): Promise<LoadedNutritionCalculationData | null> {
    const duplicates = duplicateRecipeIds(this.data.recipes);
    if (duplicates.length > 0) {
      throw new NutritionCalculationDataError(
        duplicates.map((duplicateId) => `duplicate_recipe_id:${duplicateId}`)
      );
    }
    const recipe = this.data.recipes.find((item) => item.recipeId === recipeId);
    if (!recipe) return null;
    return {
      recipe: structuredClone(recipe),
      ingredientDictionary: structuredClone(this.data.ingredientDictionary),
      reviewedMappings: structuredClone(this.data.reviewedMappings),
      reviewRegistry: structuredClone(this.data.reviewRegistry),
      unitConversionRegistry: structuredClone(this.data.unitConversionRegistry),
      nutritionRegistry: structuredClone(this.data.nutritionRegistry),
      allowSyntheticTestData: this.data.allowSyntheticTestData,
    };
  }
}

function validPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function roundOutput(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function roundTrace(value: number): number {
  return Number(value.toFixed(9));
}

function emptyNutrientOutput(): Record<NutrientCode, NutrientOutputValue> {
  return Object.fromEntries(NUTRIENT_CODES.map((code) => [code, {
    amount: null,
    knownSubtotal: 0,
    unit: NUTRIENT_META[code].unit,
    decimals: NUTRIENT_META[code].decimals,
  }])) as Record<NutrientCode, NutrientOutputValue>;
}

function emptyIngredientNutrients(): Record<NutrientCode, IngredientNutrientTrace> {
  return Object.fromEntries(NUTRIENT_CODES.map((code) => [code, {
    nutrient: code,
    profileAmountPer100g: null,
    profileBasis: null,
    massUsedG: null,
    retentionFactor: null,
    traceContribution: null,
    outputContribution: null,
    sourceId: null,
    versionId: null,
    reason: "not_calculated",
  }])) as Record<NutrientCode, IngredientNutrientTrace>;
}

function unavailableBasis(basis: NutritionBasis, reason: string): NutritionBasisResult {
  return { basis, basisStatus: "unavailable", reason, divisor: null, weightG: null, nutrients: emptyNutrientOutput() };
}

function emptyCoverage(): NutritionCoverageMetrics {
  return {
    ingredientCount: 0,
    requiredIngredientCount: 0,
    resolvedIngredientCount: 0,
    gramConvertedIngredientCount: 0,
    nutritionProfileIngredientCount: 0,
    calculableIngredientCount: 0,
    resolutionRate: null,
    gramConversionRate: null,
    nutritionProfileRate: null,
    knownFinalWeightG: 0,
    nutritionCoveredWeightG: 0,
    weightCoverageRate: null,
    weightDenominatorComplete: false,
    byNutrient: Object.fromEntries(NUTRIENT_CODES.map((code) => [code, {
      coveredRequiredIngredients: 0,
      requiredIngredients: 0,
      rate: null,
    }])) as NutritionCoverageMetrics["byNutrient"],
  };
}

function roundingPolicy(): RecipeNutritionResult["roundingPolicy"] {
  return Object.fromEntries(NUTRIENT_CODES.map((code) => [code, { ...NUTRIENT_META[code], stage: "output_only" as const }])) as RecipeNutritionResult["roundingPolicy"];
}

function unavailableResult(recipeId: string, blockers: string[]): RecipeNutritionResult {
  return {
    recipeId,
    calculationStatus: "unavailable",
    requestedBases: ["full_recipe", "per_serving", "per_100g"],
    servingCount: null,
    finalFoodWeightG: null,
    servingWeightG: null,
    bases: {
      full_recipe: unavailableBasis("full_recipe", blockers[0] ?? "calculation_unavailable"),
      per_serving: unavailableBasis("per_serving", blockers[0] ?? "calculation_unavailable"),
      per_100g: unavailableBasis("per_100g", blockers[0] ?? "calculation_unavailable"),
    },
    missingIngredients: [],
    assumptions: [],
    coverage: emptyCoverage(),
    provenance: [],
    trace: [],
    blockers,
    roundingPolicy: roundingPolicy(),
  };
}

function addProvenance(
  map: Map<string, ResultProvenance>,
  sourceId: string,
  versionId: string,
  role: string
): void {
  if (sourceId === "" || versionId === "") return;
  const key = `${sourceId}|${versionId}`;
  const current = map.get(key) ?? { sourceId, versionId, roles: [] };
  if (!current.roles.includes(role)) current.roles.push(role);
  current.roles.sort();
  map.set(key, current);
}

function addConversionProvenance(map: Map<string, ResultProvenance>, factors: readonly AppliedFactorTrace[]): void {
  for (const factor of factors) addProvenance(map, factor.source.id, factor.source.versionId, factor.kind);
}

function isUsableSource(source: NutritionSourceRecord | undefined, allowSynthetic: boolean): boolean {
  return Boolean(
    source &&
    source.status === "approved" &&
    source.licenseStatus === "approved" &&
    (!source.syntheticTestOnly || allowSynthetic)
  );
}

function usableProfile(
  profile: NutrientProfile,
  registry: ParsedNutritionRegistry,
  allowSynthetic: boolean
): boolean {
  return profile.status === "approved" && isUsableSource(registry.sources.get(profile.sourceId), allowSynthetic);
}

function usableRetention(
  factor: NutrientRetentionFactor,
  registry: ParsedNutritionRegistry,
  allowSynthetic: boolean
): boolean {
  return factor.status === "approved" && isUsableSource(registry.sources.get(factor.sourceId), allowSynthetic);
}

function requestedBases(request: ServingRequest): NutritionBasis[] | null {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  if (request.bases !== undefined && !Array.isArray(request.bases)) return null;
  const raw = request.bases ?? ["full_recipe", "per_serving", "per_100g"];
  const out = new Set<NutritionBasis>(["full_recipe"]);
  for (const value of raw) {
    if (value !== "full_recipe" && value !== "per_serving" && value !== "per_100g") return null;
    out.add(value);
  }
  return ["full_recipe", "per_serving", "per_100g"].filter((basis) => out.has(basis as NutritionBasis)) as NutritionBasis[];
}

function validateStructuredRecipe(recipe: StructuredNutritionRecipe, expectedRecipeId: string): string[] {
  const issues: string[] = [];
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) return ["structured_recipe_invalid"];
  if (typeof recipe.recipeId !== "string" || recipe.recipeId.trim() === "" || recipe.recipeId !== expectedRecipeId) {
    issues.push("structured_recipe_id_invalid");
  }
  if (recipe.verificationStatus !== "verified" && recipe.verificationStatus !== "needs_review" && recipe.verificationStatus !== "rejected") {
    issues.push("structured_recipe_verification_status_invalid");
  }
  if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
    issues.push("recipe_has_no_structured_ingredients");
  } else {
    for (let index = 0; index < recipe.ingredients.length; index += 1) {
      const ingredient = recipe.ingredients[index] as StructuredRecipeIngredient;
      if (!ingredient || typeof ingredient !== "object" || Array.isArray(ingredient)) {
        issues.push(`structured_ingredient_${index}_invalid`);
        continue;
      }
      if (typeof ingredient.originalText !== "string" || ingredient.originalText.trim() === "") {
        issues.push(`structured_ingredient_${index}_original_text_required`);
      }
      if (typeof ingredient.required !== "boolean") issues.push(`structured_ingredient_${index}_required_flag_invalid`);
      if (ingredient.targetFoodState !== null && !isFoodState(String(ingredient.targetFoodState))) {
        issues.push(`structured_ingredient_${index}_target_food_state_invalid`);
      }
      if (typeof ingredient.applyEdiblePortion !== "boolean") {
        issues.push(`structured_ingredient_${index}_edible_portion_flag_invalid`);
      }
    }
  }
  if (recipe.servings !== null && !validPositive(recipe.servings)) issues.push("structured_recipe_servings_invalid");
  if (recipe.finalFoodWeightG !== null && !validPositive(recipe.finalFoodWeightG)) issues.push("structured_recipe_final_weight_invalid");
  if (typeof recipe.sourceId !== "string" || recipe.sourceId.trim() === "") issues.push("recipe_source_id_missing");
  if (typeof recipe.versionId !== "string" || recipe.versionId.trim() === "") issues.push("recipe_version_id_missing");
  return issues;
}

export class NutritionCalculator {
  public constructor(private readonly repository: NutritionCalculationRepository) {}

  public async calculateRecipeNutrition(recipeId: string, servingRequest: ServingRequest): Promise<RecipeNutritionResult> {
    const normalizedRecipeId = recipeId.trim();
    if (normalizedRecipeId === "") return unavailableResult(recipeId, ["recipe_id_required"]);
    const basesRequested = requestedBases(servingRequest);
    if (!basesRequested) return unavailableResult(normalizedRecipeId, ["serving_request_invalid_basis"]);
    if (servingRequest.servingCount !== undefined && servingRequest.servingCount !== null && !validPositive(servingRequest.servingCount)) {
      return unavailableResult(normalizedRecipeId, ["serving_request_invalid_count"]);
    }
    if (servingRequest.finalFoodWeightG !== undefined && servingRequest.finalFoodWeightG !== null && !validPositive(servingRequest.finalFoodWeightG)) {
      return unavailableResult(normalizedRecipeId, ["serving_request_invalid_final_weight"]);
    }

    let loaded: LoadedNutritionCalculationData | null;
    try {
      loaded = await this.repository.load(normalizedRecipeId);
    } catch (error) {
      if (error instanceof NutritionCalculationDataError) {
        return unavailableResult(normalizedRecipeId, error.blockers);
      }
      return unavailableResult(normalizedRecipeId, ["calculation_data_load_failed"]);
    }
    if (!loaded) return unavailableResult(normalizedRecipeId, ["recipe_not_found"]);
    const recipe = loaded.recipe;
    const structuredRecipeIssues = validateStructuredRecipe(recipe, normalizedRecipeId);
    if (structuredRecipeIssues.length > 0) return unavailableResult(normalizedRecipeId, structuredRecipeIssues);
    if (recipe.verificationStatus !== "verified") return unavailableResult(normalizedRecipeId, ["recipe_not_verified"]);

    const dictionary = parseIngredientDictionary(loaded.ingredientDictionary);
    const knownKeys = new Set(dictionary.entries.map((entry) => entry.key));
    const reviewRegistry = parseReviewRegistry(loaded.reviewRegistry);
    const reviewed = parseReviewedMappings(loaded.reviewedMappings, knownKeys, reviewRegistry);
    const unitRegistry = parseUnitConversionRegistry(loaded.unitConversionRegistry, knownKeys);
    const nutritionRegistry = parseNutritionRegistry(loaded.nutritionRegistry, knownKeys);
    const registryIssues = [
      ...dictionary.issues.map((issue) => `ingredient_dictionary:${issue}`),
      ...reviewRegistry.issues.map((issue) => `review_registry:${issue}`),
      ...reviewed.issues.map((issue) => `reviewed_mapping:${issue}`),
      ...unitRegistry.issues.map((issue) => `unit_registry:${issue}`),
      ...nutritionRegistry.issues.map((issue) => `nutrition_registry:${issue}`),
    ];
    if (registryIssues.length > 0) return unavailableResult(normalizedRecipeId, registryIssues);

    const index = buildIndex(dictionary.entries);
    const provenance = new Map<string, ResultProvenance>();
    addProvenance(provenance, recipe.sourceId, recipe.versionId, "recipe");
    const trace: IngredientCalculationTrace[] = [];
    const rawIngredientContributions: Array<Record<NutrientCode, number | null>> = [];
    const missingIngredients: MissingIngredientRecord[] = [];
    const assumptions: AssumptionRecord[] = [];
    const importantOmissions: string[] = [];
    const optionalNutrientMissing = new Set<NutrientCode>();

    let resolvedCount = 0;
    let gramConvertedCount = 0;
    let profileCount = 0;
    let calculableCount = 0;
    let knownFinalWeightG = 0;
    let nutritionCoveredWeightG = 0;
    const nutrientCoveredRequired = Object.fromEntries(NUTRIENT_CODES.map((code) => [code, 0])) as Record<NutrientCode, number>;

    for (let ingredientIndex = 0; ingredientIndex < recipe.ingredients.length; ingredientIndex += 1) {
      const ingredient = recipe.ingredients[ingredientIndex];
      const occurrence = { original: ingredient.originalText, recipeId: recipe.recipeId, sourceRow: 1, ingredientIndex };
      const resolution = resolveIngredient(ingredient.originalText, { index, reviewed: reviewed.mappings }, [occurrence]);
      const conversion = convertIngredientAmount(ingredient.originalText, {
        registry: unitRegistry,
        ingredientKey: resolution.status === "resolved" ? resolution.canonicalKey : null,
        foodState: resolution.status === "resolved" ? resolution.foodState : null,
        applyEdiblePortion: ingredient.applyEdiblePortion,
        targetFoodState: ingredient.targetFoodState,
      });
      const omissions: string[] = [];
      const nutrientTraces = emptyIngredientNutrients();
      const rawNutrientContributions = Object.fromEntries(
        NUTRIENT_CODES.map((code) => [code, null])
      ) as Record<NutrientCode, number | null>;
      let selectedProfile: NutrientProfile | null = null;
      let nutritionFoodState: FoodState | null = null;
      let inputGrams: number | null = null;
      let edibleGrams: number | null = null;
      let finalGrams: number | null = null;
      const retentionFactorIds: string[] = [];

      if (resolution.status !== "resolved" || !resolution.canonicalKey) {
        omissions.push(resolution.status === "ambiguous" ? "ingredient_ambiguous" : "ingredient_unresolved");
      } else {
        resolvedCount += 1;
        if (resolution.provenance) {
          addProvenance(provenance, resolution.provenance.source, resolution.provenance.version, "ingredient_mapping");
        }
      }

      if (conversion.grams) {
        inputGrams = conversion.grams.min === conversion.grams.max ? conversion.grams.min : null;
        if (inputGrams === null) omissions.push("ingredient_quantity_range_not_exact");
        else gramConvertedCount += 1;
      } else {
        omissions.push(...conversion.reasonCodes);
      }
      if (conversion.status !== "converted") omissions.push(...conversion.reasonCodes);
      if (conversion.edibleGrams && conversion.edibleGrams.min === conversion.edibleGrams.max) {
        edibleGrams = conversion.edibleGrams.min;
      } else if (!ingredient.applyEdiblePortion) {
        edibleGrams = inputGrams;
      } else if (conversion.edibleGrams) {
        omissions.push("edible_portion_range_not_exact");
      }
      const cookingTransitionRequested = ingredient.targetFoodState !== null &&
        ingredient.targetFoodState !== resolution.foodState;
      if (cookingTransitionRequested) {
        if (conversion.yieldAdjustedGrams && conversion.yieldAdjustedGrams.min === conversion.yieldAdjustedGrams.max) {
          finalGrams = conversion.yieldAdjustedGrams.min;
        } else if (conversion.yieldAdjustedGrams) {
          omissions.push("cooking_yield_range_not_exact");
        } else {
          omissions.push("cooking_yield_unavailable");
        }
      } else {
        finalGrams = ingredient.applyEdiblePortion ? edibleGrams : edibleGrams ?? inputGrams;
      }
      addConversionProvenance(provenance, conversion.appliedFactors);

      if (finalGrams !== null) knownFinalWeightG += finalGrams;
      const canonicalKey = resolution.canonicalKey;
      const sourceState = resolution.foodState;
      const targetState = ingredient.targetFoodState;
      const exactTargetProfiles = canonicalKey === null || targetState === null
        ? []
        : nutritionRegistry.profiles.filter((profile) =>
          profile.ingredientKey === canonicalKey &&
          profile.foodState === targetState &&
          usableProfile(profile, nutritionRegistry, loaded.allowSyntheticTestData)
        );
      const directProfiles = canonicalKey === null
        ? []
        : nutritionRegistry.profiles.filter((profile) =>
          profile.ingredientKey === canonicalKey &&
          profile.foodState === sourceState &&
          usableProfile(profile, nutritionRegistry, loaded.allowSyntheticTestData)
        );
      const profileCandidates = targetState !== null && exactTargetProfiles.length > 0 ? exactTargetProfiles : directProfiles;
      if (profileCandidates.length === 1) {
        selectedProfile = profileCandidates[0];
        nutritionFoodState = targetState !== null && exactTargetProfiles.length > 0 ? targetState : sourceState;
        profileCount += 1;
        addProvenance(provenance, selectedProfile.sourceId, selectedProfile.versionId, "nutrient_profile");
      } else {
        omissions.push(profileCandidates.length > 1 ? "nutrient_profile_ambiguous" : "nutrient_profile_missing_for_food_state");
      }

      if (selectedProfile && finalGrams !== null) {
        const usesTargetProfile = targetState !== null && nutritionFoodState === targetState;
        const profileMass = usesTargetProfile
          ? finalGrams
          : selectedProfile.basis === "per_edible_100g"
            ? edibleGrams
            : inputGrams;
        if (profileMass === null) {
          omissions.push("profile_basis_mass_unavailable");
        } else {
          for (const code of NUTRIENT_CODES) {
            const profileAmount = selectedProfile.nutrients[code];
            let retention: NutrientRetentionFactor | null = null;
            let retentionReason: string | null = null;
            const requiresRetention = targetState !== null && !usesTargetProfile;
            if (requiresRetention && canonicalKey && sourceState) {
              const retentionMatches = nutritionRegistry.retentionFactors.filter((factor) =>
                (factor.ingredientKey === null || factor.ingredientKey === canonicalKey) &&
                factor.nutrient === code &&
                factor.foodStateFrom === sourceState &&
                factor.foodStateTo === targetState &&
                usableRetention(factor, nutritionRegistry, loaded.allowSyntheticTestData)
              );
              if (retentionMatches.length === 1) retention = retentionMatches[0];
              else retentionReason = retentionMatches.length > 1 ? "retention_factor_ambiguous" : "retention_factor_missing";
            }
            const retentionValue = requiresRetention ? retention?.factor ?? null : 1;
            let reason: string | null = null;
            let contribution: number | null = null;
            if (profileAmount === null) reason = "nutrient_value_missing";
            else if (retentionValue === null) reason = retentionReason ?? "retention_factor_missing";
            else contribution = profileAmount * profileMass / 100 * retentionValue;
            rawNutrientContributions[code] = contribution;
            if (retention) {
              if (!retentionFactorIds.includes(retention.id)) retentionFactorIds.push(retention.id);
              addProvenance(provenance, retention.sourceId, retention.versionId, "nutrient_retention");
            }
            nutrientTraces[code] = {
              nutrient: code,
              profileAmountPer100g: profileAmount,
              profileBasis: selectedProfile.basis,
              massUsedG: profileMass,
              retentionFactor: retentionValue,
              traceContribution: contribution === null ? null : roundTrace(contribution),
              outputContribution: contribution === null ? null : roundOutput(contribution, NUTRIENT_META[code].decimals),
              sourceId: selectedProfile.sourceId,
              versionId: selectedProfile.versionId,
              reason,
            };
            if (contribution !== null) {
              if (ingredient.required) nutrientCoveredRequired[code] += 1;
            } else if ((REQUIRED_NUTRIENTS as readonly NutrientCode[]).includes(code)) {
              omissions.push(`${reason}:${code}`);
            } else {
              optionalNutrientMissing.add(code);
            }
          }
          const requiredNutrientsCalculable = REQUIRED_NUTRIENTS.every(
            (code) => rawNutrientContributions[code] !== null
          );
          if (requiredNutrientsCalculable) {
            calculableCount += 1;
            nutritionCoveredWeightG += finalGrams;
          }
        }
      }

      const uniqueOmissions = [...new Set(omissions)];
      if (uniqueOmissions.length > 0) {
        missingIngredients.push({
          ingredientIndex,
          originalText: ingredient.originalText,
          required: ingredient.required,
          codes: uniqueOmissions,
        });
        if (ingredient.required) importantOmissions.push(...uniqueOmissions);
        else assumptions.push({
          code: "optional_ingredient_omitted",
          message: `Optional ingredient ${ingredientIndex} was omitted from totals because required data was unavailable.`,
          ingredientIndex,
        });
      }
      trace.push({
        ingredientIndex,
        originalText: ingredient.originalText,
        required: ingredient.required,
        resolution: {
          status: resolution.status,
          stage: resolution.stage,
          canonicalKey: resolution.canonicalKey,
          foodState: resolution.foodState,
          sourceId: resolution.provenance?.source ?? null,
          versionId: resolution.provenance?.version ?? null,
        },
        quantityConversion: conversion,
        nutritionFoodState,
        nutrientProfileId: selectedProfile?.id ?? null,
        inputGrams,
        edibleGrams,
        finalGrams,
        retentionFactorIds: retentionFactorIds.sort(),
        nutrients: nutrientTraces,
        omissions: uniqueOmissions,
      });
      rawIngredientContributions.push(rawNutrientContributions);
    }

    const requiredIngredientCount = recipe.ingredients.filter((item) => item.required).length;
    const requiredWeightsComplete = trace.every((item) => !item.required || item.finalGrams !== null);
    const allIngredientWeightsComplete = trace.every((item) => item.finalGrams !== null);
    const fullKnownSubtotal = Object.fromEntries(NUTRIENT_CODES.map((code) => [
      code,
      rawIngredientContributions.reduce((sum, nutrients) => sum + (nutrients[code] ?? 0), 0),
    ])) as Record<NutrientCode, number>;
    const nutrientComplete = Object.fromEntries(NUTRIENT_CODES.map((code) => [
      code,
      rawIngredientContributions.every((nutrients, index) =>
        !trace[index].required || nutrients[code] !== null
      ),
    ])) as Record<NutrientCode, boolean>;

    const servingCount = servingRequest.servingCount ?? recipe.servings;
    const finalFoodWeightG = servingRequest.finalFoodWeightG ?? recipe.finalFoodWeightG;
    if (servingRequest.servingCount !== undefined && servingRequest.servingCount !== null) assumptions.push({
      code: "serving_count_from_request",
      message: "Serving count came from the explicit serving request.",
      ingredientIndex: null,
    });
    if (servingRequest.finalFoodWeightG !== undefined && servingRequest.finalFoodWeightG !== null) assumptions.push({
      code: "final_weight_from_request",
      message: "Final food weight came from the explicit serving request.",
      ingredientIndex: null,
    });

    const makeAvailableBasis = (basis: NutritionBasis, divisor: number, weightG: number | null): NutritionBasisResult => {
      const nutrients = emptyNutrientOutput();
      for (const code of NUTRIENT_CODES) {
        const scaledKnown = fullKnownSubtotal[code] / divisor;
        nutrients[code] = {
          amount: nutrientComplete[code] ? roundOutput(scaledKnown, NUTRIENT_META[code].decimals) : null,
          knownSubtotal: roundOutput(scaledKnown, NUTRIENT_META[code].decimals),
          unit: NUTRIENT_META[code].unit,
          decimals: NUTRIENT_META[code].decimals,
        };
      }
      return { basis, basisStatus: "available", reason: null, divisor, weightG, nutrients };
    };

    const full = requiredWeightsComplete
      ? makeAvailableBasis("full_recipe", 1, knownFinalWeightG)
      : unavailableBasis("full_recipe", "missing_required_ingredient_amount");
    const perServing = !basesRequested.includes("per_serving")
      ? unavailableBasis("per_serving", "basis_not_requested")
      : full.basisStatus !== "available"
        ? unavailableBasis("per_serving", "full_recipe_basis_unavailable")
        : !validPositive(servingCount)
          ? unavailableBasis("per_serving", "missing_serving_count")
          : makeAvailableBasis("per_serving", servingCount, validPositive(finalFoodWeightG) ? finalFoodWeightG / servingCount : null);
    const per100g = !basesRequested.includes("per_100g")
      ? unavailableBasis("per_100g", "basis_not_requested")
      : full.basisStatus !== "available"
        ? unavailableBasis("per_100g", "full_recipe_basis_unavailable")
        : !validPositive(finalFoodWeightG)
          ? unavailableBasis("per_100g", "missing_final_food_weight")
          : makeAvailableBasis("per_100g", finalFoodWeightG / 100, 100);
    const basisResults = { full_recipe: full, per_serving: perServing, per_100g: per100g };
    const availableRequestedBases = basesRequested.filter((basis) => basisResults[basis].basisStatus === "available");
    const unavailableRequestedBasis = basesRequested.some((basis) => basisResults[basis].basisStatus === "unavailable");
    const requiredNutrientsComplete = REQUIRED_NUTRIENTS.every((code) => nutrientComplete[code]);
    const calculationStatus: NutritionCalculationStatus = availableRequestedBases.length === 0
      ? "unavailable"
      : unavailableRequestedBasis || importantOmissions.length > 0 || !requiredNutrientsComplete || assumptions.some((item) => item.code === "optional_ingredient_omitted")
        ? "partial"
        : "complete";

    const coverage: NutritionCoverageMetrics = {
      ingredientCount: recipe.ingredients.length,
      requiredIngredientCount,
      resolvedIngredientCount: resolvedCount,
      gramConvertedIngredientCount: gramConvertedCount,
      nutritionProfileIngredientCount: profileCount,
      calculableIngredientCount: calculableCount,
      resolutionRate: recipe.ingredients.length > 0 ? resolvedCount / recipe.ingredients.length : null,
      gramConversionRate: recipe.ingredients.length > 0 ? gramConvertedCount / recipe.ingredients.length : null,
      nutritionProfileRate: recipe.ingredients.length > 0 ? profileCount / recipe.ingredients.length : null,
      knownFinalWeightG: roundTrace(knownFinalWeightG),
      nutritionCoveredWeightG: roundTrace(nutritionCoveredWeightG),
      weightCoverageRate: allIngredientWeightsComplete && knownFinalWeightG > 0
        ? nutritionCoveredWeightG / knownFinalWeightG
        : null,
      weightDenominatorComplete: allIngredientWeightsComplete,
      byNutrient: Object.fromEntries(NUTRIENT_CODES.map((code) => [code, {
        coveredRequiredIngredients: nutrientCoveredRequired[code],
        requiredIngredients: requiredIngredientCount,
        rate: requiredIngredientCount > 0 ? nutrientCoveredRequired[code] / requiredIngredientCount : null,
      }])) as NutritionCoverageMetrics["byNutrient"],
    };

    for (const code of optionalNutrientMissing) assumptions.push({
      code: `optional_nutrient_unknown:${code}`,
      message: `Optional nutrient ${code} is unknown and did not downgrade an otherwise complete result.`,
      ingredientIndex: null,
    });

    return {
      recipeId: normalizedRecipeId,
      calculationStatus,
      requestedBases: basesRequested,
      servingCount: validPositive(servingCount) ? servingCount : null,
      finalFoodWeightG: validPositive(finalFoodWeightG) ? finalFoodWeightG : null,
      servingWeightG: validPositive(servingCount) && validPositive(finalFoodWeightG)
        ? roundOutput(finalFoodWeightG / servingCount, 1)
        : null,
      bases: basisResults,
      missingIngredients,
      assumptions,
      coverage,
      provenance: [...provenance.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.versionId.localeCompare(b.versionId)),
      trace,
      blockers: [...new Set(importantOmissions)],
      roundingPolicy: roundingPolicy(),
    };
  }
}

const defaultCalculator = new NutritionCalculator(new JsonNutritionCalculationRepository());

/** Required Step 7 public operation. Uses the default verified snapshot loader. */
export async function calculateRecipeNutrition(
  recipeId: string,
  servingRequest: ServingRequest
): Promise<RecipeNutritionResult> {
  return defaultCalculator.calculateRecipeNutrition(recipeId, servingRequest);
}
