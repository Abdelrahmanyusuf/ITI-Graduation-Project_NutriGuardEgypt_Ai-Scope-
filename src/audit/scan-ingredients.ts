/**
 * Ingredient/reference CSV scanner (comma-delimited, quoted first field).
 */

import { parseCsv } from "./csv.js";
import { ColumnAnalyzer } from "./columns.js";
import { decodeText, detectMojibake, detectNoise, normalizeTerm } from "./text.js";
import type {
  DuplicateGroup,
  NutritionCellEvidence,
  NutritionColumnAudit,
  RowEvidence,
  SourceAudit,
} from "./types.js";

/** Headers that are NOT nutrition cells (identity / classification metadata). */
const NON_NUTRIENT_HEADERS = new Set([
  "food",
  "main_category",
  "subcategory",
  "prep_state",
  "unnamed_21",
]);

/** Normalized name (units removed) for column matching, e.g. `ENERGY (Kcal)` -> `energy`. */
export function columnName(col: string): string {
  return col
    .toLowerCase()
    .replace(/\(.*\)/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const NUMERIC_COLUMNS = new Set([
  "calories", "calories_kcal", "energy_kcal", "energy", "protein", "protein_g",
  "carbs", "carbs_g", "carbohydrate", "fat", "fat_g", "fiber", "sodium",
  "sodium_mg", "sugar", "serving_size", "serving_size_g",
]);

const IMPLAUSIBLE_ZERO_COLUMNS = new Set([
  "calories", "calories_kcal", "energy_kcal", "energy", "protein", "protein_g",
  "carbs", "carbohydrate", "fat", "fat_g",
]);

const TRACE_MARKER_RE = /^(t|tr|tr\.|trace|traces)$/i;
const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const ZERO_RE = /^[+-]?0+(?:\.0+)?$/;

/** Classify a single nutrition cell value. Missing cells are blank/whitespace.
 * This is the ONE canonical classifier for every nutrition summary. */
export function classifyNutritionCell(raw: string, column: string, row: number): NutritionCellEvidence | "missing" {
  const v = raw.trim();
  if (v === "") return "missing";
  if (TRACE_MARKER_RE.test(v)) {
    return {
      row,
      column,
      raw: v,
      classification: "recognized_trace_marker",
      note: "recognized trace-marker token (e.g. T/tr/trace); not coerced to numeric 0 or ignored",
    };
  }
  if (NUMERIC_RE.test(v)) {
    if (ZERO_RE.test(v)) {
      return { row, column, raw: v, classification: "explicit_zero", note: "explicit zero value" };
    }
    return { row, column, raw: v, classification: "valid_numeric" };
  }
  return {
    row,
    column,
    raw: v,
    classification: "invalid",
    note: "unparseable nutrition value; classified as invalid, not silently ignored",
  };
}

export interface IngredientScanOptions {
  relativePath: string;
  bytes: Uint8Array;
}

/** Build the reference vocabulary of normalized FOOD names from the ingredient CSV. */
export function buildIngredientVocabulary(bytes: Uint8Array): { vocabulary: Set<string>; terms: string[] } {
  const enc = decodeText(bytes);
  const parsed = parseCsv(enc.text);
  const headers = (parsed.rows[0] ?? []).map((h) => h.trim());
  const cFood = headers.indexOf("FOOD");
  const vocabulary = new Set<string>();
  if (cFood < 0) return { vocabulary, terms: [] };
  for (const row of parsed.rows.slice(1)) {
    const key = normalizeTerm((row[cFood] ?? "").trim());
    if (key !== "") vocabulary.add(key);
  }
  return { vocabulary, terms: [...vocabulary].sort() };
}

export function scanIngredients(options: IngredientScanOptions): SourceAudit {
  const { relativePath, bytes } = options;
  const enc = decodeText(bytes);
  const parsed = parseCsv(enc.text);

  const structuralErrors: string[] = [];
  for (const e of parsed.errors) structuralErrors.push(e);
  if (!enc.validUtf8) structuralErrors.push("file is not valid UTF-8");

  const headers = (parsed.rows[0] ?? []).map((h) => h.trim());
  const headerIndex = new Map(headers.map((h, i) => [h, i]));
  const data = parsed.rows.slice(1);

  if (data.length === 0) {
    structuralErrors.push("no data rows found");
  }

  const analyzer = new ColumnAnalyzer(headers);
  const idx = (name: string): number => headerIndex.get(name) ?? -1;
  const cFood = idx("FOOD");
  const cPrep = idx("prep_state");

  const duplicateByFood = new Map<string, number[]>();
  const suspiciousZeros: RowEvidence[] = [];
  const foodStateCounts = new Map<string, number>();
  const foodKeys = new Set<string>();
  let prepStateRows = 0;

  // Nutrition cell classification for all nutrient (non-FOOD, non-metadata) headers.
  const nutrientHeaders = headers.filter((h) => !NON_NUTRIENT_HEADERS.has(columnName(h)));
  const nutritionCells = new Map<string, NutritionCellEvidence[]>();

  data.forEach((row, i) => {
    analyzer.add(row);
    const lineNumber = i + 2;
    const malformed = row.length !== headers.length;
    if (malformed) structuralErrors.push(`row ${lineNumber}: expected ${headers.length} fields, found ${row.length}`);

    const food = (row[cFood] ?? "").trim();
    const key = normalizeTerm(food);
    if (key !== "") {
      const bucket = duplicateByFood.get(key) ?? [];
      bucket.push(lineNumber);
      duplicateByFood.set(key, bucket);
      foodKeys.add(key);
    }

    const prep = (row[cPrep] ?? "").trim();
    if (prep !== "") {
      prepStateRows += 1;
      foodStateCounts.set(prep, (foodStateCounts.get(prep) ?? 0) + 1);
    }

    for (const col of headers) {
      const ci = headerIndex.get(col) ?? -1;
      if (ci < 0 || !NUMERIC_COLUMNS.has(columnName(col))) continue;
      const raw = (row[ci] ?? "").trim();
      if (raw === "") continue;
      if (!NUMERIC_RE.test(raw)) {
        // invalid values are reported through the canonical nutrition-cell
        // classifier below (source-level invalidNumerics == sum of columns' invalid)
        continue;
      }
      if (ZERO_RE.test(raw) && IMPLAUSIBLE_ZERO_COLUMNS.has(columnName(col))) {
        suspiciousZeros.push({
          row: lineNumber,
          column: col,
          raw,
          note: "zero is implausible for this column (possible missing->0 coercion)",
        });
      }
    }

    // Nutrition cell classification for all nutrient (non-FOOD, non-metadata) headers.
    for (const col of nutrientHeaders) {
      const ci = headerIndex.get(col) ?? -1;
      if (ci < 0) continue;
      const result = classifyNutritionCell(row[ci] ?? "", col, lineNumber);
      if (result !== "missing") {
        const bucket = nutritionCells.get(col) ?? [];
        bucket.push(result);
        nutritionCells.set(col, bucket);
      }
    }
  });

  const nutritionColumns: NutritionColumnAudit[] = nutrientHeaders.map((col) => {
    const evidence = nutritionCells.get(col) ?? [];
    let validNumeric = 0;
    let explicitZero = 0;
    let recognizedTraceMarkers = 0;
    let invalid = 0;
    for (const e of evidence) {
      if (e.classification === "valid_numeric") validNumeric += 1;
      else if (e.classification === "explicit_zero") explicitZero += 1;
      else if (e.classification === "recognized_trace_marker") recognizedTraceMarkers += 1;
      else invalid += 1;
    }
    const presentCount = validNumeric + explicitZero + recognizedTraceMarkers + invalid;
    return {
      column: col,
      present: presentCount,
      missing: data.length - presentCount,
      validNumeric,
      explicitZero,
      recognizedTraceMarkers,
      invalid,
      evidence: evidence.slice(0, 25),
    };
  });

  const duplicateGroups: DuplicateGroup[] = [];
  for (const [key, rows] of duplicateByFood) {
    if (rows.length > 1) duplicateGroups.push({ key, count: rows.length, rows: [...rows].sort((a, b) => a - b) });
  }
  duplicateGroups.sort((a, b) => a.key.localeCompare(b.key));
  const duplicateRowCount = duplicateGroups.reduce((s, g) => s + g.count - 1, 0);

  const foodStateTokens = [...foodStateCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  const mojibake = detectMojibake(enc.text);
  const noise = detectNoise(enc.text);
  const finalColumns = analyzer.finish(NUMERIC_COLUMNS);

  // Source-level invalid numerics MUST equal the sum of nutrition.columns[].invalid.
  // The same canonical classifier is used everywhere; trace markers are never invalid.
  let sourceInvalid = 0;
  const sourceInvalidEvidence: RowEvidence[] = [];
  for (const col of nutritionColumns) {
    sourceInvalid += col.invalid;
    for (const e of col.evidence) {
      if (e.classification === "invalid") {
        sourceInvalidEvidence.push({ row: e.row, column: e.column, raw: e.raw });
      }
    }
  }
  // Keep the per-column `columns[].invalidNumerics` consistent with the canonical
  // nutrition classifier for nutrient headers (so T/tr/trace is never invalid).
  const canonicalInvalidByHeader = new Map(
    nutritionColumns.map((c) => [c.column, c.invalid])
  );
  for (const c of finalColumns) {
    const canonical = canonicalInvalidByHeader.get(c.name);
    if (canonical !== undefined) c.invalidNumerics = canonical;
  }

  const foodKeysSorted = [...foodKeys].sort();

  return {
    kind: "ingredients",
    relativePath,
    format: "CSV (comma-delimited, quoted fields)",
    encoding: enc.encoding,
    bytes: bytes.length,
    docCount: data.length,
    columnCount: headers.length,
    columns: finalColumns,
    duplicates: { byKey: "normalized FOOD name", groups: duplicateGroups, duplicateRowCount },
    invalidNumerics: { count: sourceInvalid, evidence: sourceInvalidEvidence.slice(0, 25) },
    suspiciousZeros: { count: suspiciousZeros.length, evidence: suspiciousZeros.slice(0, 25) },
    zeroVsMissingConflation: {
      detected: finalColumns.some((c) => c.notes.some((n) => n.includes("conflation"))),
      columns: finalColumns.filter((c) => c.notes.some((n) => n.includes("conflation"))).map((c) => c.name),
    },
    leadingQuantityHeuristic: null,
    recognizedUnitHeuristic: null,
    canonicalQuantityParsingCoverage: null,
    canonicalIngredientLineMappingCoverage: null,
    servingYieldCoverage: null,
    foodStateCoverage: {
      numerator: prepStateRows,
      denominator: data.length,
      rate: data.length > 0 ? prepStateRows / data.length : null,
      note: "rows with a prep_state value; distinct values: " + foodStateTokens.join(", "),
    },
    uniqueIngredientTerms: {
      count: foodKeys.size,
      topTerms: foodKeysSorted.slice(0, 20),
    },
    exactIngredientMatch: null,
    ambiguousMatches: [],
    egyptianScopeEvidence: {
      fieldNames: ["FOOD", "prep_state"],
      note: "reference ingredient list; Egyptian scope, if any, is not encoded in this file",
    },
    guidelineCoverage: null,
    ocrOrExtractionNoise: noise,
    nutrition: { columns: nutritionColumns },
    licensing: {
      hasLicenseFields: false,
      candidateFields: [],
      note: "no license/provenance columns present in the ingredient source",
    },
    mojibake,
    encodingIssues: enc.validUtf8 ? [] : ["file is not valid UTF-8"],
    structuralErrors,
  };
}
