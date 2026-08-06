/**
 * Recipe CSV scanner (tab-delimited, RFC-4180-style quoting).
 */

import { parseDelimited, parseListField } from "./csv.js";
import { ColumnAnalyzer } from "./columns.js";
import {
  classifyRecipe,
  type CulturalEvidenceRecord,
  type RecipeInput,
} from "./egyptian-evidence.js";
import { decodeText, detectMojibake, detectNoise, normalizeTerm } from "./text.js";
import type {
  DuplicateGroup,
  FieldDistribution,
  IngredientQueueRecord,
  RecipeClassRecord,
  RowEvidence,
  SourceAudit,
} from "./types.js";

const NUMERIC_COLUMNS = new Set([
  "num_ingredients",
  "num_steps",
  "fast_hits",
  "slow_hits",
  "medium_hits",
  "est_prep_time_min",
  "est_cook_time_min",
  "healthiness_score",
  "egy_ingredient_coverage",
]);

const IMPLAUSIBLE_ZERO_COLUMNS = new Set([
  "num_ingredients",
  "num_steps",
  "est_prep_time_min",
  "est_cook_time_min",
]);

const QUANTITY_RE =
  /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?|[\u00BC-\u00BE\u2150-\u215E])/;

const UNIT_TOKENS = new Set([
  "cup", "cups", "tablespoon", "tablespoons", "tbsp", "tablespoonful",
  "teaspoon", "teaspoons", "tsp", "pound", "pounds", "lb", "lbs", "ounce",
  "ounces", "oz", "g", "gram", "grams", "kg", "kilogram", "kilograms",
  "ml", "milliliter", "milliliters", "liter", "liters", "clove", "cloves",
  "slice", "slices", "pinch", "can", "package", "bunch", "stalk", "head",
  "piece", "pieces", "stick", "sprig", "sprigs", "dash", "handful", "quart",
  "pint", "jar", "wedge", "wedges", "sheet", "sheets", "bar", "loaf",
  "bottle", "drop", "drops", "smidgen",
]);

const OPTIONAL_MARKERS = /\b(optional|not required|as needed|to taste|taste)\b/i;

/**
 * Union a unit word written with digits, e.g. "1/2" split into halves. Not needed;
 * keeps token matching simple. Recognised-unit tokens are compared at token
 * boundaries (Unicode-aware), never via substring `includes()`.
 */
const UNIT_TOKEN_RE = (() => {
  const sorted = [...UNIT_TOKENS].sort((a, b) => b.length - a.length);
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])(${sorted.map(escapeRegExp).join("|")})(?:$|[^\\p{L}\\p{N}_])`, "iu");
})();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the line is an optional / not-required garnish (excluded from canonical metrics). */
function isOptionalLine(line: string): boolean {
  return OPTIONAL_MARKERS.test(line.toLowerCase());
}

function hasQuantity(line: string): boolean {
  return QUANTITY_RE.test(line.trim());
}

function hasUnit(line: string): boolean {
  const lower = line.toLowerCase();
  return UNIT_TOKEN_RE.test(lower);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) dp[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[n];
}

export interface RecipeScanOptions {
  relativePath: string;
  bytes: Uint8Array;
  vocabulary: ReadonlySet<string>;
  /** Egyptian-recipe cultural-evidence records from the audit source manifest
   * (purpose = `egyptian_recipe_cultural_evidence`, scoped per dish). Only
   * these records may resolve a C-3 claim (C-3). */
  culturalEvidence?: ReadonlyArray<CulturalEvidenceRecord>;
}

export interface RecipeScanResult {
  audit: SourceAudit;
  classificationRecords: RecipeClassRecord[];
  ingredientQueue: IngredientQueueRecord[];
  termCounts: Map<string, number>;
}

export function scanRecipes(options: RecipeScanOptions): RecipeScanResult {
  const { relativePath, bytes, vocabulary } = options;
  const enc = decodeText(bytes);
  const parsed = parseDelimited(enc.text, "\t");

  const structuralErrors: string[] = [];
  for (const e of parsed.errors) structuralErrors.push(e);
  if (!enc.validUtf8) {
    structuralErrors.push("file is not valid UTF-8 (decoded as Latin-1 for analysis)");
  }

  const headers = (parsed.rows[0] ?? []).map((h) => h.trim());
  const headerIndex = new Map(headers.map((h, i) => [h, i]));
  const data = parsed.rows.slice(1);

  const analyzer = new ColumnAnalyzer(headers);
  const idx = (name: string): number => headerIndex.get(name) ?? -1;

  const cTitle = idx("recipe_title");
  const cDescription = idx("description");
  const cCategory = idx("category");
  const cSubcategory = idx("subcategory");
  const cIngredients = idx("ingredients");
  const cIngredientsCanonical = idx("ingredients_canonical");
  const cCuisine = idx("cuisine_list");
  const cMain = idx("main_ingredient");
  const cDirections = idx("directions");
  // Optional provenance columns (C-1/C-3 candidate requirements). Absent
  // columns yield empty strings, so candidate classification degrades to 0
  // when the source does not carry a provenance record / evidence link.
  const cSourceId = idx("source_id");
  const cSourceVersion = idx("source_version");
  const cAccessDate = idx("access_date");
  const cCultureEvidence = idx("culture_evidence_link");

  const duplicateByTitle = new Map<string, number[]>();
  const invalidNumerics: RowEvidence[] = [];
  const suspiciousZeros: RowEvidence[] = [];
  const classificationRecords: RecipeClassRecord[] = [];
  const ingredientQueue: IngredientQueueRecord[] = [];
  const termCounts = new Map<string, number>();
  const seenTermsForQueue = new Set<string>();

  let quantityOk = 0;
  let quantityTotal = 0;
  let unitOk = 0;
  let unitTotal = 0;

  const cEgyCoverage = idx("egy_ingredient_coverage");
  const cuisineValues = new Map<string, number>();
  const egyCoverageValues = new Map<string, number>();
  let cuisinePresent = 0;
  let egyCoveragePresent = 0;

  data.forEach((row, i) => {
    analyzer.add(row);
    const lineNumber = i + 2; // 1-based, header is row 1
    const malformed = row.length !== headers.length;
    if (malformed) {
      structuralErrors.push(
        `row ${lineNumber}: expected ${headers.length} fields, found ${row.length}`
      );
    }

    const title = (row[cTitle] ?? "").trim();
    const titleKey = normalizeTerm(title);
    if (titleKey !== "") {
      const bucket = duplicateByTitle.get(titleKey) ?? [];
      bucket.push(lineNumber);
      duplicateByTitle.set(titleKey, bucket);
    }

    const ingredientsRaw = row[cIngredients] ?? "";
    const canonicalRaw = row[cIngredientsCanonical] ?? "";
    const ingredientLines = parseListField(ingredientsRaw) ?? [];
    const canonicalTerms = parseListField(canonicalRaw) ?? ingredientLines;

    // Quantity / unit coverage on the raw ingredient lines.
    // Optional / "to taste" / not-required lines are excluded from canonical metrics.
    for (const line of ingredientLines) {
      if (isOptionalLine(line)) continue;
      quantityTotal += 1;
      unitTotal += 1;
      if (hasQuantity(line)) quantityOk += 1;
      if (hasUnit(line)) unitOk += 1;
    }

    // Unique normalized ingredient terms (canonical preferred).
    const uniqueTermSet = new Set<string>();
    for (const term of canonicalTerms) {
      const norm = normalizeTerm(term);
      if (norm === "") continue;
      uniqueTermSet.add(norm);
      termCounts.set(norm, (termCounts.get(norm) ?? 0) + 1);
      if (!seenTermsForQueue.has(norm)) {
        seenTermsForQueue.add(norm);
        ingredientQueue.push({
          row: lineNumber,
          term: norm,
          matched: vocabulary.has(norm),
          matchedTerm: vocabulary.has(norm) ? norm : undefined,
          reason: vocabulary.has(norm)
            ? "exact match in reference vocabulary"
            : "no exact match in reference vocabulary",
        });
      }
    }

    // Numeric / zero checks.
    for (const col of headers) {
      const ci = headerIndex.get(col) ?? -1;
      if (ci < 0 || !NUMERIC_COLUMNS.has(col)) continue;
      const raw = (row[ci] ?? "").trim();
      if (raw === "") continue;
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
        invalidNumerics.push({ row: lineNumber, column: col, raw });
      } else if (/^[+-]?0+(?:\.0+)?$/.test(raw)) {
        if (IMPLAUSIBLE_ZERO_COLUMNS.has(col)) {
          suspiciousZeros.push({
            row: lineNumber,
            column: col,
            raw,
            note: "zero is implausible for this column (possible missing->0 coercion)",
          });
        }
      }
    }

    // Classification.
    // C-2 instructions: `directions` uses the source's list-field format
    // (JSON-array style, same as `ingredients`), so empty arrays, empty/only
    // whitespace strings and arrays of only-whitespace entries fail C-2.
    const directionsList = parseListField(row[cDirections] ?? "") ?? [];
    const input: RecipeInput = {
      row: lineNumber,
      title,
      description: row[cDescription] ?? "",
      category: row[cCategory] ?? "",
      subcategory: row[cSubcategory] ?? "",
      cuisineList: parseListField(row[cCuisine] ?? "") ?? [],
      mainIngredient: row[cMain] ?? "",
      ingredientTerms: [...uniqueTermSet],
      mojibakeInTitle: detectMojibake(title).detected,
      malformed,
      missingTitle: title === "",
      missingIngredients: canonicalTerms.length === 0 && ingredientLines.length === 0,
      hasInstructions: directionsList.length > 0,
      fileIsValidUtf8: enc.validUtf8,
      sourceId: (row[cSourceId] ?? "").trim(),
      sourceVersion: (row[cSourceVersion] ?? "").trim(),
      accessDate: (row[cAccessDate] ?? "").trim(),
      cultureEvidenceLink: (row[cCultureEvidence] ?? "").trim(),
      culturalEvidence: options.culturalEvidence ?? [],
    };
    const result = classifyRecipe(input);
    classificationRecords.push({
      row: lineNumber,
      title,
      classification: result.classification,
      reviewRequired: result.classification === "candidate" || result.classification === "needs_review",
      reasons: result.reasons,
      signals: result.signals,
      broadTags: result.broadTags,
      humanVerification: {
        status: "unreviewed",
        reviewerId: null,
        reviewDate: null,
        cultureEvidence: [],
        note: "human review required for any Egyptian verification; automated logic never self-verifies",
      },
    });

    // Field distributions for discriminative-scope analysis.
    const cuisineField = parseListField(row[cCuisine] ?? "");
    if (cuisineField && cuisineField.length > 0) {
      cuisinePresent += 1;
      const key = [...cuisineField].sort().join("|").toLowerCase();
      cuisineValues.set(key, (cuisineValues.get(key) ?? 0) + 1);
    }
    const egyCoverageRaw = (row[cEgyCoverage] ?? "").trim();
    if (egyCoverageRaw !== "") {
      egyCoveragePresent += 1;
      egyCoverageValues.set(egyCoverageRaw, (egyCoverageValues.get(egyCoverageRaw) ?? 0) + 1);
    }
  });

  // Duplicates.
  const duplicateGroups: DuplicateGroup[] = [];
  for (const [key, rows] of duplicateByTitle) {
    if (rows.length > 1) {
      duplicateGroups.push({ key, count: rows.length, rows: [...rows].sort((a, b) => a - b) });
    }
  }
  duplicateGroups.sort((a, b) => a.key.localeCompare(b.key));
  const duplicateRowCount = duplicateGroups.reduce((s, g) => s + g.count - 1, 0);

  // Exact match + ambiguous candidates over unique terms.
  const uniqueTerms = [...termCounts.keys()].sort();
  const ambiguousMatches: Array<{ term: string; candidates: string[] }> = [];
  for (const term of uniqueTerms) {
    if (vocabulary.has(term)) continue;
    const candidates = new Set<string>();
    for (const v of vocabulary) {
      if (v.length < 3 || term.length < 3) continue;
      if (term.includes(v) || v.includes(term)) candidates.add(v);
      else if (Math.abs(term.length - v.length) <= 1 && levenshtein(term, v) <= 1) candidates.add(v);
    }
    if (candidates.size > 0) {
      ambiguousMatches.push({
        term,
        candidates: [...candidates].sort().slice(0, 5),
      });
    }
  }
  ambiguousMatches.sort((a, b) => a.term.localeCompare(b.term)).slice(0, 40);

  const denominator = uniqueTerms.length;
  const matched = [...termCounts.keys()].filter((t) => vocabulary.has(t)).length;
  const topTerms = [...termCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([t]) => t);

  const mojibake = detectMojibake(enc.text);
  const noise = detectNoise(enc.text);

  const makeDistribution = (
    field: string,
    values: Map<string, number>,
    present: number
  ): FieldDistribution => {
    const total = data.length;
    const cardinality = values.size;
    const note =
      cardinality === 0
        ? "field absent or empty across all rows; not discriminative"
        : cardinality === 1
          ? "constant (single distinct value); non-discriminative for Egyptian scope"
          : `${cardinality} distinct value(s) across ${present}/${total} present rows`;
    return {
      field,
      cardinality,
      constant: cardinality === 1,
      present,
      missing: total - present,
      note,
    };
  };
  const cuisineDistribution = makeDistribution("cuisine_list", cuisineValues, cuisinePresent);
  const egyCoverageDistribution = makeDistribution("egy_ingredient_coverage", egyCoverageValues, egyCoveragePresent);

  const auditSource: SourceAudit = {
    kind: "recipes",
    relativePath,
    format: "CSV (tab-delimited, quoted fields)",
    encoding: enc.encoding,
    bytes: bytes.length,
    docCount: data.length,
    columnCount: headers.length,
    columns: analyzer.finish(NUMERIC_COLUMNS),
    duplicates: { byKey: "normalized recipe_title", groups: duplicateGroups, duplicateRowCount },
    invalidNumerics: { count: invalidNumerics.length, evidence: invalidNumerics.slice(0, 25) },
    suspiciousZeros: { count: suspiciousZeros.length, evidence: suspiciousZeros.slice(0, 25) },
    zeroVsMissingConflation: {
      detected: analyzer
        .finish(NUMERIC_COLUMNS)
        .some((c) => c.notes.some((n) => n.includes("conflation"))),
      columns: analyzer
        .finish(NUMERIC_COLUMNS)
        .filter((c) => c.notes.some((n) => n.includes("conflation")))
        .map((c) => c.name),
    },
    leadingQuantityHeuristic: {
      numerator: quantityOk,
      denominator: quantityTotal,
      rate: quantityTotal > 0 ? quantityOk / quantityTotal : null,
      note: "HEURISTIC: ingredient lines with a leading quantity token (number or fraction) over total non-optional ingredient lines; NOT canonical quantity parsing",
    },
    recognizedUnitHeuristic: {
      numerator: unitOk,
      denominator: unitTotal,
      rate: unitTotal > 0 ? unitOk / unitTotal : null,
      note: "HEURISTIC: ingredient lines containing a recognized unit token over total non-optional ingredient lines; NOT canonical unit recognition",
    },
    canonicalQuantityParsingCoverage: {
      numerator: 0,
      denominator: 0,
      rate: null,
      note: "unknown — no approved canonical quantity-parsing rule set exists yet",
    },
    canonicalIngredientLineMappingCoverage: {
      numerator: 0,
      denominator: 0,
      rate: null,
      note: "unknown — no approved canonical ingredient-line mapping rule set exists yet",
    },
    servingYieldCoverage: {
      numerator: 0,
      denominator: data.length,
      rate: null,
      note: "no serving or yield column present in the recipe source; per-basis serving/yield unavailable (unknown, not a measured 0)",
    },
    foodStateCoverage: {
      numerator: 0,
      denominator: data.length,
      rate: null,
      note: "no raw/cooked food-state column present in the recipe source (unavailable)",
    },
    uniqueIngredientTerms: { count: uniqueTerms.length, topTerms },
    exactIngredientMatch: {
      numerator: matched,
      denominator,
      rate: denominator > 0 ? matched / denominator : null,
    },
    ambiguousMatches: ambiguousMatches.slice(0, 40),
    egyptianScopeEvidence: {
      fieldNames: ["cuisine_list", "main_ingredient", "egy_ingredient_coverage", "category", "subcategory", "description"],
      note: "only explicit Egyptian signals count; broad regional tags (Middle Eastern/Mediterranean) are NOT Egyptian evidence",
    },
    cuisineField: cuisineDistribution,
    egyIngredientCoverageField: egyCoverageDistribution,
    guidelineCoverage: null,
    ocrOrExtractionNoise: noise,
    nutrition: null,
    licensing: {
      hasLicenseFields: false,
      candidateFields: [],
      note: "no license/provenance columns present in the recipe source",
    },
    mojibake,
    encodingIssues: enc.validUtf8 ? [] : ["file is not valid UTF-8"],
    structuralErrors,
  };

  // Deduplicate ingredient queue across recipes (first occurrence row retained).
  const seen = new Set<string>();
  const queueDedup: IngredientQueueRecord[] = [];
  for (const r of ingredientQueue) {
    if (seen.has(r.term)) continue;
    seen.add(r.term);
    queueDedup.push(r);
  }
  queueDedup.sort((a, b) => a.term.localeCompare(b.term));

  return {
    audit: auditSource,
    classificationRecords: classificationRecords.sort((a, b) => a.row - b.row),
    ingredientQueue: queueDedup,
    termCounts,
  };
}
