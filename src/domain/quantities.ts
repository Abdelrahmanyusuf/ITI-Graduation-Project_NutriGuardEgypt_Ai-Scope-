/**
 * Step 6 — deterministic quantity, unit, household-measure and yield handling.
 *
 * The module deliberately separates parsing from conversion. Parsing never
 * invents a unit, except for an explicit size qualifier such as "1 medium
 * onion", where the count unit is marked as inferred. Gram conversion is
 * allowed only for mass units or a sourced ingredient+unit+state record.
 */

import { containsArabic, FOOD_STATES, normalizeArabic, type FoodState } from "./ingredients.js";

export const UNIT_REGISTRY_SCHEMA_VERSION = "1.0";

export const UNIT_CODES = [
  "g",
  "kg",
  "ml",
  "l",
  "teaspoon",
  "tablespoon",
  "cup",
  "piece",
  "clove",
] as const;

export type UnitCode = (typeof UNIT_CODES)[number];
export type UnitDimension = "mass" | "volume" | "count";
export type FactorUncertainty = "exact" | "approximate" | "range";
export type SizeQualifier = "small" | "medium" | "large";
export type MeasureVariant = "standard" | "egyptian_household";

export interface NumericInterval {
  min: number;
  max: number;
}

export interface ConversionSource {
  id: string;
  versionId: string;
  title: string;
  url: string;
  accessDate: string;
}

export interface UnitDefinition {
  code: UnitCode;
  dimension: UnitDimension;
  baseUnit: "g" | "ml" | "piece";
  factorToBase: number | null;
  uncertainty: FactorUncertainty;
  sourceId: string;
  aliasesEn: string[];
  aliasesAr: string[];
  aliasesEg: string[];
}

export interface IngredientMeasureConversion {
  id: string;
  ingredientKey: string;
  fromUnit: UnitCode;
  foodState: FoodState | null;
  qualifier: SizeQualifier | null;
  measureVariant: MeasureVariant;
  gramsPerUnit: number;
  ediblePortionBasis: "edible" | "as_purchased";
  uncertainty: FactorUncertainty;
  sourceId: string;
  sourceLocator: string;
  originalValue: string;
  originalContext: string;
}

export interface EdiblePortionFactor {
  id: string;
  ingredientKey: string;
  foodState: FoodState | null;
  factorMin: number;
  factorMax: number;
  uncertainty: FactorUncertainty;
  sourceId: string;
  sourceLocator: string;
  originalValue: string;
  originalContext: string;
}

export interface CookingYieldFactor {
  id: string;
  ingredientKey: string;
  foodStateFrom: FoodState;
  foodStateTo: FoodState;
  factorMin: number;
  factorMax: number;
  uncertainty: FactorUncertainty;
  sourceId: string;
  sourceLocator: string;
  originalValue: string;
  originalContext: string;
}

export interface ParsedUnitConversionRegistry {
  sources: Map<string, ConversionSource>;
  units: Map<UnitCode, UnitDefinition>;
  aliasIndex: Map<string, UnitCode>;
  aliasVariantIndex: Map<string, MeasureVariant>;
  ingredientConversions: IngredientMeasureConversion[];
  ediblePortionFactors: EdiblePortionFactor[];
  cookingYieldFactors: CookingYieldFactor[];
  issues: string[];
}

export type QuantityKind = "exact" | "range" | "qualitative" | "missing" | "invalid";

export interface ParsedQuantity {
  original: string | null;
  kind: QuantityKind;
  value: NumericInterval | null;
  reason: string | null;
}

export type IngredientAmountParseStatus = "parsed" | "partial" | "unsupported" | "invalid";

export interface ParsedIngredientAmount {
  original: string;
  originalQuantity: string | null;
  originalUnit: string | null;
  ingredientText: string;
  quantity: ParsedQuantity;
  normalizedUnit: UnitCode | null;
  measureVariant: MeasureVariant | null;
  qualifier: SizeQualifier | null;
  unitInferred: boolean;
  status: IngredientAmountParseStatus;
  reasonCodes: string[];
}

export type ConversionStatus = "converted" | "partial" | "unsupported" | "invalid";

export interface QuantityConversionResult {
  status: ConversionStatus;
  method: "standard_mass" | "ingredient_measure" | "none";
  original: string;
  originalQuantity: string | null;
  originalUnit: string | null;
  ingredientText: string;
  ingredientKey: string | null;
  foodState: FoodState | null;
  targetFoodState: FoodState | null;
  quantity: NumericInterval | null;
  normalizedUnit: UnitCode | null;
  measureVariant: MeasureVariant | null;
  baseUnit: "g" | "ml" | "piece" | null;
  baseAmount: NumericInterval | null;
  grams: NumericInterval | null;
  edibleGrams: NumericInterval | null;
  yieldAdjustedGrams: NumericInterval | null;
  uncertainty: FactorUncertainty | null;
  conversionId: string | null;
  provenance: ConversionSource[];
  appliedFactors: AppliedFactorTrace[];
  reasonCodes: string[];
}

export interface AppliedFactorTrace {
  id: string;
  kind: "unit_normalization" | "ingredient_measure" | "edible_portion" | "cooking_yield";
  factor: NumericInterval;
  uncertainty: FactorUncertainty;
  source: ConversionSource;
  sourceLocator: string;
  originalValue: string;
  originalContext: string;
}

interface RawRegistryContainer {
  schemaVersion?: unknown;
  sources?: unknown;
  units?: unknown;
  ingredientConversions?: unknown;
  ediblePortionFactors?: unknown;
  cookingYieldFactors?: unknown;
}

const STRICT_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isStrictIsoDate(value: string): boolean {
  if (!STRICT_ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, field: string): string {
  return typeof record[field] === "string" ? (record[field] as string).trim() : "";
}

function nullableStringField(record: Record<string, unknown>, field: string): string | null {
  if (record[field] === null || record[field] === undefined) return null;
  return typeof record[field] === "string" ? (record[field] as string).trim() : "";
}

function positiveNumber(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function stringArray(record: Record<string, unknown>, field: string): string[] | null {
  const value = record[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) return null;
  return value.map((item) => (item as string).trim());
}

function isUnitCode(value: string): value is UnitCode {
  return (UNIT_CODES as readonly string[]).includes(value);
}

function isFoodState(value: string): value is FoodState {
  return (FOOD_STATES as readonly string[]).includes(value);
}

function isUncertainty(value: string): value is FactorUncertainty {
  return value === "exact" || value === "approximate" || value === "range";
}

function isQualifier(value: string): value is SizeQualifier {
  return value === "small" || value === "medium" || value === "large";
}

function isMeasureVariant(value: string): value is MeasureVariant {
  return value === "standard" || value === "egyptian_household";
}

/** Normalize a unit/qualifier alias without changing the preserved original. */
export function normalizeUnitAlias(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (containsArabic(normalized)) return normalizeArabic(normalized);
  return normalized.toLowerCase().replace(/[.,]+$/g, "");
}

/** Parse and validate the sourced unit/conversion registry. Invalid factors are excluded. */
export function parseUnitConversionRegistry(
  raw: unknown,
  knownIngredientKeys?: ReadonlySet<string>
): ParsedUnitConversionRegistry {
  const sources = new Map<string, ConversionSource>();
  const units = new Map<UnitCode, UnitDefinition>();
  const aliasIndex = new Map<string, UnitCode>();
  const aliasVariantIndex = new Map<string, MeasureVariant>();
  const ingredientConversions: IngredientMeasureConversion[] = [];
  const ediblePortionFactors: EdiblePortionFactor[] = [];
  const cookingYieldFactors: CookingYieldFactor[] = [];
  const issues: string[] = [];
  const container = asRecord(raw) as RawRegistryContainer | null;
  if (!container) {
    issues.push("unit conversion registry must be an object");
    return { sources, units, aliasIndex, aliasVariantIndex, ingredientConversions, ediblePortionFactors, cookingYieldFactors, issues };
  }
  if (container.schemaVersion !== UNIT_REGISTRY_SCHEMA_VERSION) {
    issues.push(`unit conversion registry schemaVersion must be ${UNIT_REGISTRY_SCHEMA_VERSION}`);
  }

  if (!Array.isArray(container.sources)) {
    issues.push("unit conversion registry sources must be an array");
  } else {
    const sourceIdCounts = new Map<string, number>();
    for (const value of container.sources) {
      const rec = asRecord(value);
      const id = rec ? stringField(rec, "id") : "";
      if (id !== "") sourceIdCounts.set(id, (sourceIdCounts.get(id) ?? 0) + 1);
    }
    for (let i = 0; i < container.sources.length; i += 1) {
      const rec = asRecord(container.sources[i]);
      const label = `source ${i}`;
      if (!rec) {
        issues.push(`${label}: must be an object`);
        continue;
      }
      const id = stringField(rec, "id");
      const versionId = stringField(rec, "versionId");
      const title = stringField(rec, "title");
      const url = stringField(rec, "url");
      const accessDate = stringField(rec, "accessDate");
      if (id === "" || versionId === "" || title === "" || url === "" || !isStrictIsoDate(accessDate)) {
        issues.push(`${label}: id/versionId/title/url and a strict ISO accessDate are required`);
        continue;
      }
      if ((sourceIdCounts.get(id) ?? 0) > 1) {
        issues.push(`${label}: duplicate source id "${id}"`);
        continue;
      }
      sources.set(id, { id, versionId, title, url, accessDate });
    }
  }

  if (!Array.isArray(container.units)) {
    issues.push("unit conversion registry units must be an array");
  } else {
    const unitCodeCounts = new Map<string, number>();
    for (const value of container.units) {
      const rec = asRecord(value);
      const code = rec ? stringField(rec, "code") : "";
      if (code !== "") unitCodeCounts.set(code, (unitCodeCounts.get(code) ?? 0) + 1);
    }
    for (let i = 0; i < container.units.length; i += 1) {
      const rec = asRecord(container.units[i]);
      const label = `unit ${i}`;
      if (!rec) {
        issues.push(`${label}: must be an object`);
        continue;
      }
      const codeRaw = stringField(rec, "code");
      const dimension = stringField(rec, "dimension");
      const baseUnit = stringField(rec, "baseUnit");
      const uncertaintyRaw = stringField(rec, "uncertainty");
      const sourceId = stringField(rec, "sourceId");
      const factorValue = rec.factorToBase;
      const factorToBase = factorValue === null
        ? null
        : typeof factorValue === "number" && Number.isFinite(factorValue) && factorValue > 0
          ? factorValue
          : undefined;
      const aliasesEn = stringArray(rec, "aliasesEn");
      const aliasesAr = stringArray(rec, "aliasesAr");
      const aliasesEg = stringArray(rec, "aliasesEg");
      let ok = true;
      if (!isUnitCode(codeRaw)) {
        issues.push(`${label}: unsupported code "${codeRaw}"`);
        ok = false;
      }
      if (dimension !== "mass" && dimension !== "volume" && dimension !== "count") {
        issues.push(`${label}: dimension must be mass, volume, or count`);
        ok = false;
      }
      if (baseUnit !== "g" && baseUnit !== "ml" && baseUnit !== "piece") {
        issues.push(`${label}: baseUnit must be g, ml, or piece`);
        ok = false;
      }
      if (isUnitCode(codeRaw)) {
        const expectedDimension: UnitDimension =
          codeRaw === "g" || codeRaw === "kg"
            ? "mass"
            : codeRaw === "piece" || codeRaw === "clove"
              ? "count"
              : "volume";
        const expectedBase = expectedDimension === "mass" ? "g" : expectedDimension === "volume" ? "ml" : "piece";
        if (dimension !== expectedDimension || baseUnit !== expectedBase) {
          issues.push(`${label}: ${codeRaw} must be ${expectedDimension} with baseUnit ${expectedBase}`);
          ok = false;
        }
        if (codeRaw === "clove" ? factorToBase !== null : factorToBase === null) {
          issues.push(`${label}: ${codeRaw} has an invalid factorToBase nullability`);
          ok = false;
        }
      }
      if (factorToBase === undefined) {
        issues.push(`${label}: factorToBase must be positive or null`);
        ok = false;
      }
      if (!isUncertainty(uncertaintyRaw)) {
        issues.push(`${label}: uncertainty must be exact, approximate, or range`);
        ok = false;
      }
      if (!sources.has(sourceId)) {
        issues.push(`${label}: sourceId "${sourceId}" is unknown`);
        ok = false;
      }
      if (!aliasesEn || !aliasesAr || !aliasesEg) {
        issues.push(`${label}: aliasesEn/aliasesAr/aliasesEg must be arrays of non-empty strings`);
        ok = false;
      }
      if ((unitCodeCounts.get(codeRaw) ?? 0) > 1) {
        issues.push(`${label}: duplicate unit code "${codeRaw}"`);
        ok = false;
      }
      if (!ok || !isUnitCode(codeRaw) || !isUncertainty(uncertaintyRaw) || !aliasesEn || !aliasesAr || !aliasesEg) continue;
      units.set(codeRaw, {
        code: codeRaw,
        dimension: dimension as UnitDimension,
        baseUnit: baseUnit as "g" | "ml" | "piece",
        factorToBase: factorToBase ?? null,
        uncertainty: uncertaintyRaw,
        sourceId,
        aliasesEn,
        aliasesAr,
        aliasesEg,
      });
    }
  }

  for (const requiredCode of UNIT_CODES) {
    if (!units.has(requiredCode)) issues.push(`required unit "${requiredCode}" is missing`);
  }

  const aliasCandidates = new Map<string, Set<UnitCode>>();
  const variantCandidates = new Map<string, Set<MeasureVariant>>();
  for (const unit of units.values()) {
    const aliases: Array<{ alias: string; variant: MeasureVariant }> = [
      { alias: unit.code, variant: "standard" },
      ...unit.aliasesEn.map((alias) => ({ alias, variant: "standard" as const })),
      ...unit.aliasesAr.map((alias) => ({ alias, variant: "standard" as const })),
      ...unit.aliasesEg.map((alias) => ({
        alias,
        variant: unit.dimension === "volume" ? "egyptian_household" as const : "standard" as const,
      })),
    ];
    for (const { alias, variant } of aliases) {
      const normalized = normalizeUnitAlias(alias);
      if (normalized === "") continue;
      const codes = aliasCandidates.get(normalized) ?? new Set<UnitCode>();
      codes.add(unit.code);
      aliasCandidates.set(normalized, codes);
      const variants = variantCandidates.get(normalized) ?? new Set<MeasureVariant>();
      variants.add(variant);
      variantCandidates.set(normalized, variants);
    }
  }
  for (const [alias, codes] of aliasCandidates) {
    if (codes.size !== 1) {
      issues.push(`unit alias "${alias}" maps to multiple units: ${[...codes].sort().join(", ")}`);
      continue;
    }
    const variants = variantCandidates.get(alias) ?? new Set<MeasureVariant>();
    if (variants.size !== 1) {
      issues.push(`unit alias "${alias}" maps to multiple measure variants: ${[...variants].sort().join(", ")}`);
      continue;
    }
    aliasIndex.set(alias, [...codes][0]);
    aliasVariantIndex.set(alias, [...variants][0]);
  }

  const factorIdCounts = new Map<string, number>();
  for (const collection of [container.ingredientConversions, container.ediblePortionFactors, container.cookingYieldFactors]) {
    if (!Array.isArray(collection)) continue;
    for (const value of collection) {
      const rec = asRecord(value);
      const id = rec ? stringField(rec, "id") : "";
      if (id !== "") factorIdCounts.set(id, (factorIdCounts.get(id) ?? 0) + 1);
    }
  }
  const seenConversionKeys = new Set<string>();
  if (!Array.isArray(container.ingredientConversions)) {
    issues.push("ingredientConversions must be an array");
  } else {
    for (let i = 0; i < container.ingredientConversions.length; i += 1) {
      const rec = asRecord(container.ingredientConversions[i]);
      const label = `ingredient conversion ${i}`;
      if (!rec) {
        issues.push(`${label}: must be an object`);
        continue;
      }
      const id = stringField(rec, "id");
      const ingredientKey = stringField(rec, "ingredientKey");
      const fromUnitRaw = stringField(rec, "fromUnit");
      const foodStateRaw = nullableStringField(rec, "foodState");
      const qualifierRaw = nullableStringField(rec, "qualifier");
      const measureVariantRaw = stringField(rec, "measureVariant");
      const gramsPerUnit = positiveNumber(rec, "gramsPerUnit");
      const ediblePortionBasis = stringField(rec, "ediblePortionBasis");
      const uncertaintyRaw = stringField(rec, "uncertainty");
      const sourceId = stringField(rec, "sourceId");
      const sourceLocator = stringField(rec, "sourceLocator");
      const originalValue = stringField(rec, "originalValue");
      const originalContext = stringField(rec, "originalContext");
      let ok = true;
      if (id === "" || (factorIdCounts.get(id) ?? 0) !== 1) {
        issues.push(`${label}: id is required and must be unique`);
        ok = false;
      }
      if (ingredientKey === "" || (knownIngredientKeys && !knownIngredientKeys.has(ingredientKey))) {
        issues.push(`${label}: ingredientKey "${ingredientKey}" is unknown`);
        ok = false;
      }
      if (!isUnitCode(fromUnitRaw) || !units.has(fromUnitRaw)) {
        issues.push(`${label}: fromUnit "${fromUnitRaw}" is unknown`);
        ok = false;
      }
      if (foodStateRaw !== null && !isFoodState(foodStateRaw)) {
        issues.push(`${label}: invalid foodState "${foodStateRaw}"`);
        ok = false;
      }
      if (qualifierRaw !== null && !isQualifier(qualifierRaw)) {
        issues.push(`${label}: invalid qualifier "${qualifierRaw}"`);
        ok = false;
      }
      if (!isMeasureVariant(measureVariantRaw)) {
        issues.push(`${label}: measureVariant must be standard or egyptian_household`);
        ok = false;
      }
      if (gramsPerUnit === null) {
        issues.push(`${label}: gramsPerUnit must be positive`);
        ok = false;
      }
      if (ediblePortionBasis !== "edible" && ediblePortionBasis !== "as_purchased") {
        issues.push(`${label}: ediblePortionBasis must be edible or as_purchased`);
        ok = false;
      }
      if (!isUncertainty(uncertaintyRaw)) {
        issues.push(`${label}: invalid uncertainty`);
        ok = false;
      }
      if (!sources.has(sourceId) || sourceLocator === "" || originalValue === "" || originalContext === "") {
        issues.push(`${label}: complete source provenance is required`);
        ok = false;
      }
      const conversionKey = `${ingredientKey}|${fromUnitRaw}|${foodStateRaw ?? ""}|${qualifierRaw ?? ""}|${measureVariantRaw}`;
      if (seenConversionKeys.has(conversionKey)) {
        issues.push(`${label}: duplicate conversion identity "${conversionKey}"`);
        ok = false;
      }
      if (!ok || !isUnitCode(fromUnitRaw) || gramsPerUnit === null || !isUncertainty(uncertaintyRaw) || !isMeasureVariant(measureVariantRaw)) continue;
      seenConversionKeys.add(conversionKey);
      ingredientConversions.push({
        id,
        ingredientKey,
        fromUnit: fromUnitRaw,
        foodState: foodStateRaw as FoodState | null,
        qualifier: qualifierRaw as SizeQualifier | null,
        measureVariant: measureVariantRaw,
        gramsPerUnit,
        ediblePortionBasis: ediblePortionBasis as "edible" | "as_purchased",
        uncertainty: uncertaintyRaw,
        sourceId,
        sourceLocator,
        originalValue,
        originalContext,
      });
    }
  }

  parseAdjustmentFactors(
    container.ediblePortionFactors,
    "edible portion factor",
    sources,
    knownIngredientKeys,
    factorIdCounts,
    issues,
    (record) => ediblePortionFactors.push(record)
  );
  parseYieldFactors(
    container.cookingYieldFactors,
    sources,
    knownIngredientKeys,
    factorIdCounts,
    issues,
    (record) => cookingYieldFactors.push(record)
  );

  return { sources, units, aliasIndex, aliasVariantIndex, ingredientConversions, ediblePortionFactors, cookingYieldFactors, issues };
}

function parseAdjustmentFactors(
  raw: unknown,
  labelPrefix: string,
  sources: ReadonlyMap<string, ConversionSource>,
  knownIngredientKeys: ReadonlySet<string> | undefined,
  factorIdCounts: ReadonlyMap<string, number>,
  issues: string[],
  accept: (record: EdiblePortionFactor) => void
): void {
  if (!Array.isArray(raw)) {
    issues.push("ediblePortionFactors must be an array");
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const rec = asRecord(raw[i]);
    const label = `${labelPrefix} ${i}`;
    if (!rec) {
      issues.push(`${label}: must be an object`);
      continue;
    }
    const common = parseFactorCommon(rec, label, sources, knownIngredientKeys, factorIdCounts, issues);
    const stateRaw = nullableStringField(rec, "foodState");
    if (stateRaw !== null && !isFoodState(stateRaw)) {
      issues.push(`${label}: invalid foodState "${stateRaw}"`);
      continue;
    }
    if (!common) continue;
    if (common.factorMax > 1) {
      issues.push(`${label}: edible-portion factors cannot exceed 1`);
      continue;
    }
    const identity = `${common.ingredientKey}|${stateRaw ?? ""}`;
    if (seen.has(identity)) {
      issues.push(`${label}: duplicate factor identity "${identity}"`);
      continue;
    }
    seen.add(identity);
    accept({ ...common, foodState: stateRaw as FoodState | null });
  }
}

function parseYieldFactors(
  raw: unknown,
  sources: ReadonlyMap<string, ConversionSource>,
  knownIngredientKeys: ReadonlySet<string> | undefined,
  factorIdCounts: ReadonlyMap<string, number>,
  issues: string[],
  accept: (record: CookingYieldFactor) => void
): void {
  if (!Array.isArray(raw)) {
    issues.push("cookingYieldFactors must be an array");
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const rec = asRecord(raw[i]);
    const label = `cooking yield factor ${i}`;
    if (!rec) {
      issues.push(`${label}: must be an object`);
      continue;
    }
    const common = parseFactorCommon(rec, label, sources, knownIngredientKeys, factorIdCounts, issues);
    const fromRaw = stringField(rec, "foodStateFrom");
    const toRaw = stringField(rec, "foodStateTo");
    if (!isFoodState(fromRaw) || !isFoodState(toRaw) || fromRaw === toRaw) {
      issues.push(`${label}: distinct valid foodStateFrom and foodStateTo are required`);
      continue;
    }
    if (!common) continue;
    const identity = `${common.ingredientKey}|${fromRaw}|${toRaw}`;
    if (seen.has(identity)) {
      issues.push(`${label}: duplicate yield identity "${identity}"`);
      continue;
    }
    seen.add(identity);
    accept({ ...common, foodStateFrom: fromRaw, foodStateTo: toRaw });
  }
}

function parseFactorCommon(
  rec: Record<string, unknown>,
  label: string,
  sources: ReadonlyMap<string, ConversionSource>,
  knownIngredientKeys: ReadonlySet<string> | undefined,
  factorIdCounts: ReadonlyMap<string, number>,
  issues: string[]
): Omit<EdiblePortionFactor, "foodState"> | null {
  const id = stringField(rec, "id");
  const ingredientKey = stringField(rec, "ingredientKey");
  const factorMin = positiveNumber(rec, "factorMin");
  const factorMax = positiveNumber(rec, "factorMax");
  const uncertaintyRaw = stringField(rec, "uncertainty");
  const sourceId = stringField(rec, "sourceId");
  const sourceLocator = stringField(rec, "sourceLocator");
  const originalValue = stringField(rec, "originalValue");
  const originalContext = stringField(rec, "originalContext");
  let ok = true;
  if (id === "" || (factorIdCounts.get(id) ?? 0) !== 1 || ingredientKey === "" || (knownIngredientKeys && !knownIngredientKeys.has(ingredientKey))) {
    issues.push(`${label}: unique id and known ingredientKey are required`);
    ok = false;
  }
  if (factorMin === null || factorMax === null || factorMin > factorMax) {
    issues.push(`${label}: factorMin/factorMax must be positive and ordered`);
    ok = false;
  }
  if (!isUncertainty(uncertaintyRaw)) {
    issues.push(`${label}: invalid uncertainty`);
    ok = false;
  }
  if (!sources.has(sourceId) || sourceLocator === "" || originalValue === "" || originalContext === "") {
    issues.push(`${label}: complete source provenance is required`);
    ok = false;
  }
  if (!ok || factorMin === null || factorMax === null || !isUncertainty(uncertaintyRaw)) return null;
  return {
    id,
    ingredientKey,
    factorMin,
    factorMax,
    uncertainty: uncertaintyRaw,
    sourceId,
    sourceLocator,
    originalValue,
    originalContext,
  };
}

const ARABIC_DIGITS: Readonly<Record<string, string>> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

const VULGAR_FRACTIONS: Readonly<Record<string, number>> = {
  "¼": 1 / 4,
  "½": 1 / 2,
  "¾": 3 / 4,
  "⅐": 1 / 7,
  "⅑": 1 / 9,
  "⅒": 1 / 10,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅕": 1 / 5,
  "⅖": 2 / 5,
  "⅗": 3 / 5,
  "⅘": 4 / 5,
  "⅙": 1 / 6,
  "⅚": 5 / 6,
  "⅛": 1 / 8,
  "⅜": 3 / 8,
  "⅝": 5 / 8,
  "⅞": 7 / 8,
};

const DIGIT_CLASS = "0-9٠-٩۰-۹";
const VULGAR_CLASS = "¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";
const ATOM_PATTERN = `(?:[${DIGIT_CLASS}]+\\s+[${DIGIT_CLASS}]+\\s*\\/\\s*[${DIGIT_CLASS}]+|[${DIGIT_CLASS}]+\\s*[${VULGAR_CLASS}]|[${VULGAR_CLASS}]|[${DIGIT_CLASS}]+\\s*\\/\\s*[${DIGIT_CLASS}]+|[${DIGIT_CLASS}]+(?:[.٫][${DIGIT_CLASS}]+)?)`;
const HYPHENATED_MIXED_RE = new RegExp(`^[${DIGIT_CLASS}]+-[${DIGIT_CLASS}]+\\s*\\/\\s*[${DIGIT_CLASS}]+(?=\\s|$)`, "u");
const RANGE_PREFIX_RE = new RegExp(`^(${ATOM_PATTERN})\\s*(?:-|–|—|to|إلى|الى)\\s*(${ATOM_PATTERN})(?=\\s|$)`, "iu");
const SINGLE_PREFIX_RE = new RegExp(`^(${ATOM_PATTERN})(?=\\s|$)`, "u");

function normalizeDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => ARABIC_DIGITS[digit] ?? digit).replaceAll("٫", ".");
}

function roundStable(value: number): number {
  return Number(value.toFixed(9));
}

function parseSingleNumber(raw: string): number | null {
  let value = normalizeDigits(raw.trim());
  const vulgar = [...value].filter((char) => VULGAR_FRACTIONS[char] !== undefined);
  if (vulgar.length > 1) return null;
  if (vulgar.length === 1) {
    const char = vulgar[0];
    const fraction = VULGAR_FRACTIONS[char];
    const wholeText = value.replace(char, "").trim();
    if (wholeText === "") return fraction;
    if (!/^\d+$/.test(wholeText)) return null;
    return Number(wholeText) + fraction;
  }
  value = value.replace(/\s+/g, " ");
  const mixed = value.match(/^(\d+)(?:\s+|-)(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const denominator = Number(mixed[3]);
    if (denominator === 0) return null;
    return Number(mixed[1]) + Number(mixed[2]) / denominator;
  }
  const fraction = value.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    if (denominator === 0) return null;
    return Number(fraction[1]) / denominator;
  }
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Parse one complete quantity expression, including fractions and ranges. */
export function parseQuantityExpression(raw: string): ParsedQuantity {
  const original = raw;
  const trimmed = raw.trim();
  if (trimmed === "") return { original: null, kind: "missing", value: null, reason: "quantity_missing" };
  const hyphenatedMixed = trimmed.match(HYPHENATED_MIXED_RE)?.[0];
  if (hyphenatedMixed === trimmed) {
    const number = parseSingleNumber(trimmed);
    return number === null || number < 0
      ? { original, kind: "invalid", value: null, reason: "quantity_invalid" }
      : { original, kind: "exact", value: { min: roundStable(number), max: roundStable(number) }, reason: null };
  }
  const range = trimmed.match(RANGE_PREFIX_RE);
  if (range && range[0] === trimmed) {
    const min = parseSingleNumber(range[1]);
    const max = parseSingleNumber(range[2]);
    if (min === null || max === null || min < 0 || max < 0 || min > max) {
      return { original, kind: "invalid", value: null, reason: "quantity_range_invalid" };
    }
    return { original, kind: "range", value: { min: roundStable(min), max: roundStable(max) }, reason: null };
  }
  const number = parseSingleNumber(trimmed);
  if (number === null || number < 0) return { original, kind: "invalid", value: null, reason: "quantity_invalid" };
  return { original, kind: "exact", value: { min: roundStable(number), max: roundStable(number) }, reason: null };
}

const QUALIFIER_ALIASES: Readonly<Record<string, SizeQualifier>> = {
  small: "small",
  sm: "small",
  صغير: "small",
  صغيرة: "small",
  medium: "medium",
  med: "medium",
  متوسط: "medium",
  متوسطة: "medium",
  large: "large",
  lg: "large",
  كبير: "large",
  كبيرة: "large",
};

const QUALIFIER_INDEX: ReadonlyMap<string, SizeQualifier> = new Map(
  Object.entries(QUALIFIER_ALIASES).map(([alias, qualifier]) => [normalizeUnitAlias(alias), qualifier])
);

const QUALITATIVE_PATTERNS: ReadonlyArray<{ code: string; regex: RegExp }> = [
  { code: "quantity_to_taste", regex: /\bto\s+taste\b|حسب\s+الرغبة|حسب\s+الذوق|للتذوق/iu },
  { code: "quantity_as_needed", regex: /\bas\s+needed\b|حسب\s+الحاجة/iu },
  { code: "frying_oil_absorption_unknown", regex: /\b(?:oil\s+)?for\s+frying\b|زيت\s+للقلي|للقلي/iu },
];

function qualifierFromToken(token: string): SizeQualifier | null {
  return QUALIFIER_INDEX.get(normalizeUnitAlias(token)) ?? null;
}

function takeQuantityPrefix(value: string): { raw: string | null; rest: string; parsed: ParsedQuantity } {
  const trimmed = value.trim();
  const mixed = trimmed.match(HYPHENATED_MIXED_RE)?.[0];
  if (mixed) return { raw: mixed, rest: trimmed.slice(mixed.length).trim(), parsed: parseQuantityExpression(mixed) };
  const range = trimmed.match(RANGE_PREFIX_RE)?.[0];
  if (range) return { raw: range, rest: trimmed.slice(range.length).trim(), parsed: parseQuantityExpression(range) };
  const single = trimmed.match(SINGLE_PREFIX_RE)?.[0];
  if (single) return { raw: single, rest: trimmed.slice(single.length).trim(), parsed: parseQuantityExpression(single) };
  const looksNumeric = new RegExp(`^[${DIGIT_CLASS}${VULGAR_CLASS}]`, "u").test(trimmed);
  return {
    raw: null,
    rest: trimmed,
    parsed: looksNumeric
      ? { original: null, kind: "invalid", value: null, reason: "quantity_invalid" }
      : { original: null, kind: "missing", value: null, reason: "quantity_missing" },
  };
}

function matchUnitPrefix(
  text: string,
  registry: ParsedUnitConversionRegistry
): { original: string; code: UnitCode; variant: MeasureVariant; rest: string } | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const aliases = [...registry.aliasIndex.keys()].sort((a, b) => {
    const tokenDifference = b.split(" ").length - a.split(" ").length;
    return tokenDifference !== 0 ? tokenDifference : b.length - a.length;
  });
  for (const alias of aliases) {
    const count = alias.split(" ").length;
    if (words.length < count) continue;
    const candidate = words.slice(0, count).join(" ");
    if (normalizeUnitAlias(candidate) !== alias) continue;
    const code = registry.aliasIndex.get(alias);
    const variant = registry.aliasVariantIndex.get(alias);
    if (!code || !variant) continue;
    return { original: candidate, code, variant, rest: words.slice(count).join(" ") };
  }
  return null;
}

/** Parse quantity, unit and ingredient text while preserving both raw fields. */
export function parseIngredientAmount(
  original: string,
  registry: ParsedUnitConversionRegistry
): ParsedIngredientAmount {
  const qualitative = QUALITATIVE_PATTERNS.find((pattern) => pattern.regex.test(original));
  const prefix = takeQuantityPrefix(original);
  if (prefix.parsed.kind === "invalid") {
    return {
      original,
      originalQuantity: prefix.raw,
      originalUnit: null,
      ingredientText: prefix.rest,
      quantity: prefix.parsed,
      normalizedUnit: null,
      measureVariant: null,
      qualifier: null,
      unitInferred: false,
      status: "invalid",
      reasonCodes: [prefix.parsed.reason ?? "quantity_invalid"],
    };
  }
  if (prefix.parsed.kind === "missing") {
    return {
      original,
      originalQuantity: null,
      originalUnit: null,
      ingredientText: prefix.rest,
      quantity: qualitative
        ? { original: null, kind: "qualitative", value: null, reason: qualitative.code }
        : prefix.parsed,
      normalizedUnit: null,
      measureVariant: null,
      qualifier: null,
      unitInferred: false,
      status: "unsupported",
      reasonCodes: [qualitative?.code ?? "quantity_missing"],
    };
  }

  let rest = prefix.rest;
  let qualifier: SizeQualifier | null = null;
  let normalizedUnit: UnitCode | null = null;
  let measureVariant: MeasureVariant | null = null;
  let originalUnit: string | null = null;
  let unitInferred = false;

  const firstToken = rest.split(/\s+/)[0] ?? "";
  const leadingQualifier = qualifierFromToken(firstToken);
  if (leadingQualifier) {
    qualifier = leadingQualifier;
    rest = rest.slice(firstToken.length).trim();
  }

  const unitMatch = matchUnitPrefix(rest, registry);
  if (unitMatch) {
    normalizedUnit = unitMatch.code;
    measureVariant = unitMatch.variant;
    originalUnit = unitMatch.original;
    rest = unitMatch.rest;
    const afterUnitToken = rest.split(/\s+/)[0] ?? "";
    const afterUnitQualifier = qualifierFromToken(afterUnitToken);
    if (!qualifier && afterUnitQualifier) {
      qualifier = afterUnitQualifier;
      rest = rest.slice(afterUnitToken.length).trim();
    }
  } else if (qualifier) {
    normalizedUnit = "piece";
    measureVariant = "standard";
    unitInferred = true;
  }

  const reasonCodes: string[] = [];
  if (!normalizedUnit) reasonCodes.push("unit_unsupported_or_missing");
  if (unitInferred) reasonCodes.push("piece_inferred_from_size_qualifier");
  if (rest === "") reasonCodes.push("ingredient_text_missing");
  const parsedResult: ParsedIngredientAmount = {
    original,
    originalQuantity: prefix.raw,
    originalUnit,
    ingredientText: rest,
    quantity: prefix.parsed,
    normalizedUnit,
    measureVariant,
    qualifier,
    unitInferred,
    status: normalizedUnit && rest !== "" ? "parsed" : "partial",
    reasonCodes,
  };
  if (!qualitative) return parsedResult;
  return {
    ...parsedResult,
    quantity: { original: prefix.raw, kind: "qualitative", value: null, reason: qualitative.code },
    status: "unsupported",
    reasonCodes: [qualitative.code, ...reasonCodes.filter((code) => code !== qualitative.code)],
  };
}

function scaleInterval(value: NumericInterval, factorMin: number, factorMax = factorMin): NumericInterval {
  return {
    min: roundStable(value.min * factorMin),
    max: roundStable(value.max * factorMax),
  };
}

function combineUncertainty(values: readonly (FactorUncertainty | null)[]): FactorUncertainty | null {
  const present = values.filter((value): value is FactorUncertainty => value !== null);
  if (present.length === 0) return null;
  if (present.includes("range")) return "range";
  if (present.includes("approximate")) return "approximate";
  return "exact";
}

function addSource(
  output: ConversionSource[],
  sourceId: string,
  registry: ParsedUnitConversionRegistry
): void {
  const source = registry.sources.get(sourceId);
  if (source && !output.some((item) => item.id === source.id)) output.push(source);
}

function addFactorTrace(
  output: AppliedFactorTrace[],
  trace: Omit<AppliedFactorTrace, "source"> & { sourceId: string },
  registry: ParsedUnitConversionRegistry
): void {
  const source = registry.sources.get(trace.sourceId);
  if (!source) return;
  output.push({
    id: trace.id,
    kind: trace.kind,
    factor: trace.factor,
    uncertainty: trace.uncertainty,
    source,
    sourceLocator: trace.sourceLocator,
    originalValue: trace.originalValue,
    originalContext: trace.originalContext,
  });
}

export interface ConvertIngredientAmountOptions {
  registry: ParsedUnitConversionRegistry;
  ingredientKey?: string | null;
  foodState?: FoodState | null;
  /** Request edible grams for as-purchased mass. Never assumed when absent. */
  applyEdiblePortion?: boolean;
  /** Request a sourced transition to another food state. */
  targetFoodState?: FoodState | null;
}

/** Convert a parsed ingredient amount to grams only when a sourced path exists. */
export function convertIngredientAmount(
  original: string,
  options: ConvertIngredientAmountOptions
): QuantityConversionResult {
  const parsed = parseIngredientAmount(original, options.registry);
  const ingredientKey = options.ingredientKey?.trim() || null;
  const foodState = options.foodState ?? null;
  const targetFoodState = options.targetFoodState ?? null;
  const provenance: ConversionSource[] = [];
  const appliedFactors: AppliedFactorTrace[] = [];
  const result: QuantityConversionResult = {
    status: parsed.status === "invalid" ? "invalid" : parsed.status === "unsupported" ? "unsupported" : "partial",
    method: "none",
    original,
    originalQuantity: parsed.originalQuantity,
    originalUnit: parsed.originalUnit,
    ingredientText: parsed.ingredientText,
    ingredientKey,
    foodState,
    targetFoodState,
    quantity: parsed.quantity.value,
    normalizedUnit: parsed.normalizedUnit,
    measureVariant: parsed.measureVariant,
    baseUnit: null,
    baseAmount: null,
    grams: null,
    edibleGrams: null,
    yieldAdjustedGrams: null,
    uncertainty: parsed.quantity.kind === "range" ? "range" : parsed.quantity.kind === "exact" ? "exact" : null,
    conversionId: null,
    provenance,
    appliedFactors,
    reasonCodes: [...parsed.reasonCodes],
  };
  if (options.registry.issues.length > 0) {
    result.status = "invalid";
    result.reasonCodes.push("unit_conversion_registry_invalid");
    return result;
  }
  if (!parsed.quantity.value || !parsed.normalizedUnit) return result;
  const unit = options.registry.units.get(parsed.normalizedUnit);
  if (!unit) {
    result.reasonCodes.push("normalized_unit_missing_from_registry");
    return result;
  }
  const standardMeasure = parsed.measureVariant === "standard";
  if (standardMeasure) {
    addSource(provenance, unit.sourceId, options.registry);
    result.baseUnit = unit.baseUnit;
  }
  if (standardMeasure && unit.factorToBase !== null) {
    result.baseAmount = scaleInterval(parsed.quantity.value, unit.factorToBase);
    addFactorTrace(
      appliedFactors,
      {
        id: `unit:${unit.code}`,
        kind: "unit_normalization",
        factor: { min: unit.factorToBase, max: unit.factorToBase },
        uncertainty: unit.uncertainty,
        sourceId: unit.sourceId,
        sourceLocator: `unit definition ${unit.code} → ${unit.baseUnit}`,
        originalValue: `1 ${unit.code} = ${unit.factorToBase} ${unit.baseUnit}`,
        originalContext: `${unit.dimension} unit normalization`,
      },
      options.registry
    );
  }
  if (standardMeasure) result.uncertainty = combineUncertainty([result.uncertainty, unit.uncertainty]);

  let conversion: IngredientMeasureConversion | null = null;
  if (unit.dimension === "mass" && result.baseUnit === "g" && result.baseAmount) {
    result.grams = result.baseAmount;
    result.method = "standard_mass";
  } else if (ingredientKey) {
    const matches = options.registry.ingredientConversions.filter(
      (record) =>
        record.ingredientKey === ingredientKey &&
        record.fromUnit === parsed.normalizedUnit &&
        record.foodState === foodState &&
        record.qualifier === parsed.qualifier &&
        record.measureVariant === parsed.measureVariant
    );
    if (matches.length === 1) {
      conversion = matches[0];
      result.grams = scaleInterval(parsed.quantity.value, conversion.gramsPerUnit);
      result.method = "ingredient_measure";
      result.conversionId = conversion.id;
      result.uncertainty = combineUncertainty([result.uncertainty, conversion.uncertainty]);
      addSource(provenance, conversion.sourceId, options.registry);
      addFactorTrace(
        appliedFactors,
        {
          id: conversion.id,
          kind: "ingredient_measure",
          factor: { min: conversion.gramsPerUnit, max: conversion.gramsPerUnit },
          uncertainty: conversion.uncertainty,
          sourceId: conversion.sourceId,
          sourceLocator: conversion.sourceLocator,
          originalValue: conversion.originalValue,
          originalContext: conversion.originalContext,
        },
        options.registry
      );
      if (conversion.ediblePortionBasis === "edible") result.edibleGrams = result.grams;
    } else if (matches.length > 1) {
      result.reasonCodes.push("ambiguous_conversion_factor");
      return result;
    }
  }

  if (!result.grams) {
    result.reasonCodes.push(
      parsed.measureVariant === "egyptian_household"
        ? "egyptian_household_conversion_missing"
        : ingredientKey
          ? "ingredient_specific_conversion_missing"
          : "ingredient_key_required_for_non_mass_conversion"
    );
    return result;
  }

  if (options.applyEdiblePortion && !result.edibleGrams) {
    const edibleMatches = options.registry.ediblePortionFactors.filter(
      (record) => record.ingredientKey === ingredientKey && record.foodState === foodState
    );
    if (edibleMatches.length !== 1) {
      result.status = "partial";
      result.reasonCodes.push(
        edibleMatches.length > 1 ? "ambiguous_edible_portion_factor" : "edible_portion_factor_missing"
      );
      return result;
    }
    const edible = edibleMatches[0];
    result.edibleGrams = scaleInterval(result.grams, edible.factorMin, edible.factorMax);
    result.uncertainty = combineUncertainty([result.uncertainty, edible.uncertainty]);
    addSource(provenance, edible.sourceId, options.registry);
    addFactorTrace(
      appliedFactors,
      {
        id: edible.id,
        kind: "edible_portion",
        factor: { min: edible.factorMin, max: edible.factorMax },
        uncertainty: edible.uncertainty,
        sourceId: edible.sourceId,
        sourceLocator: edible.sourceLocator,
        originalValue: edible.originalValue,
        originalContext: edible.originalContext,
      },
      options.registry
    );
  }

  if (targetFoodState !== null && targetFoodState !== foodState) {
    if (!ingredientKey || foodState === null) {
      result.status = "partial";
      result.reasonCodes.push("explicit_source_food_state_required_for_yield");
      return result;
    }
    const yields = options.registry.cookingYieldFactors.filter(
      (record) =>
        record.ingredientKey === ingredientKey &&
        record.foodStateFrom === foodState &&
        record.foodStateTo === targetFoodState
    );
    if (yields.length !== 1) {
      result.status = "partial";
      result.reasonCodes.push(yields.length > 1 ? "ambiguous_cooking_yield_factor" : "cooking_yield_factor_missing");
      return result;
    }
    const yieldFactor = yields[0];
    const starting = result.edibleGrams ?? result.grams;
    result.yieldAdjustedGrams = scaleInterval(starting, yieldFactor.factorMin, yieldFactor.factorMax);
    result.uncertainty = combineUncertainty([result.uncertainty, yieldFactor.uncertainty]);
    addSource(provenance, yieldFactor.sourceId, options.registry);
    addFactorTrace(
      appliedFactors,
      {
        id: yieldFactor.id,
        kind: "cooking_yield",
        factor: { min: yieldFactor.factorMin, max: yieldFactor.factorMax },
        uncertainty: yieldFactor.uncertainty,
        sourceId: yieldFactor.sourceId,
        sourceLocator: yieldFactor.sourceLocator,
        originalValue: yieldFactor.originalValue,
        originalContext: yieldFactor.originalContext,
      },
      options.registry
    );
  }

  result.status = "converted";
  if (parsed.unitInferred) result.reasonCodes.push("count_conversion_requires_explicit_size_source");
  return result;
}
