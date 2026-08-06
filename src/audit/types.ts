/**
 * Shared types for the read-only data audit.
 */

export type SourceKind =
  | "recipes"
  | "ingredients"
  | "food_pyramid"
  | "guidelines_pdf"
  | "food_pyramid_images";

export type RecipeReviewClass =
  | "candidate"
  | "needs_review"
  | "not_egyptian"
  | "rejected";

export interface RowEvidence {
  row: number;
  column: string;
  raw: string;
  note?: string;
}

export interface DuplicateGroup {
  key: string;
  count: number;
  rows: number[];
}

export interface RatioMetric {
  numerator: number;
  denominator: number;
  rate: number | null;
  note: string;
}

export interface MojibakeReport {
  detected: boolean;
  kinds: string[];
  examples: string[];
}

export interface NoiseReport {
  detected: boolean;
  kinds: string[];
  samples: string[];
}

export interface ColumnAudit {
  name: string;
  present: number;
  missing: number;
  distinct: number;
  inferredTypes: Record<string, number>;
  invalidNumerics: number;
  zeroValues: number;
  notes: string[];
}

export type NutritionCellClassification =
  | "missing"
  | "valid_numeric"
  | "explicit_zero"
  | "recognized_trace_marker"
  | "invalid";

export interface NutritionCellEvidence {
  row: number;
  column: string;
  raw: string;
  classification: Exclude<NutritionCellClassification, "missing">;
  note?: string;
}

export interface NutritionColumnAudit {
  column: string;
  present: number;
  missing: number;
  validNumeric: number;
  explicitZero: number;
  recognizedTraceMarkers: number;
  invalid: number;
  evidence: NutritionCellEvidence[];
}

/** Ranking/coverage of a categorical field used for discriminative-scope analysis. */
export interface FieldDistribution {
  field: string;
  cardinality: number; // distinct values
  constant: boolean; // single distinct value across present rows
  present: number;
  missing: number;
  note: string;
}

export interface SourceAudit {
  kind: SourceKind;
  relativePath: string;
  format: string;
  encoding: string;
  bytes: number;
  docCount: number;
  columnCount: number | null;
  columns: ColumnAudit[];
  duplicates: { byKey: string; groups: DuplicateGroup[]; duplicateRowCount: number };
  invalidNumerics: { count: number; evidence: RowEvidence[] };
  suspiciousZeros: { count: number; evidence: RowEvidence[] };
  zeroVsMissingConflation: { detected: boolean; columns: string[] };
  /**
   * Heuristic coverage of ingredient lines that begin with a leading quantity
   * token (number/fraction). This is a diagnostic heuristic, NOT canonical
   * quantity parsing (see `canonicalQuantityParsingCoverage`).
   */
  leadingQuantityHeuristic: RatioMetric | null;
  /**
   * Heuristic coverage of ingredient lines containing a recognized unit token.
   * This is a diagnostic heuristic, NOT canonical unit recognition (see
   * `canonicalIngredientLineMappingCoverage`).
   */
  recognizedUnitHeuristic: RatioMetric | null;
  /** Canonical quantity-parsing coverage; `unknown` (rate null) until an approved rule set exists. */
  canonicalQuantityParsingCoverage: RatioMetric | null;
  /** Canonical ingredient-line mapping coverage; `unknown` (rate null) until an approved rule set exists. */
  canonicalIngredientLineMappingCoverage: RatioMetric | null;
  servingYieldCoverage: RatioMetric | null;
  foodStateCoverage: RatioMetric | null;
  uniqueIngredientTerms: { count: number; topTerms: string[] };
  exactIngredientMatch: { numerator: number; denominator: number; rate: number | null } | null;
  ambiguousMatches: Array<{ term: string; candidates: string[] }>;
  egyptianScopeEvidence: { fieldNames: string[]; note: string };
  cuisineField?: FieldDistribution;
  egyIngredientCoverageField?: FieldDistribution;
  guidelineCoverage: GuidelineCoverage | null;
  ocrOrExtractionNoise: NoiseReport;
  nutrition: { columns: NutritionColumnAudit[] } | null;
  provenance?: {
    sha256: string;
    byteSize: number;
  };
  licensing: { hasLicenseFields: boolean; candidateFields: string[]; note: string };
  mojibake: MojibakeReport;
  encodingIssues: string[];
  structuralErrors: string[];
}

export interface GuidelineCoverage {
  pageCount: number | null;
  visibleSource: string | null;
  visibleTitle: string | null;
  visibleDate: string | null;
  extractionAvailable: "yes" | "no" | "not_assessed";
  provenanceStatus: "identified" | "unknown" | "not_assessed";
  ocrNoiseDetected: boolean;
  notes: string[];
}

export type HumanVerificationStatus = "unreviewed" | "verified_egyptian" | "rejected_as_not_egyptian";

export interface RecipeClassRecord {
  row: number;
  title: string;
  classification: RecipeReviewClass;
  reviewRequired: boolean;
  reasons: string[];
  signals: string[];
  /** Broad regional tags (Middle Eastern/Mediterranean/etc.); discounted, not positive evidence. */
  broadTags: string[];
  humanVerification: {
    status: HumanVerificationStatus;
    reviewerId: string | null;
    reviewDate: string | null;
    cultureEvidence: string[];
    note: string;
  };
}

export interface IngredientQueueRecord {
  row: number;
  term: string;
  matched: boolean;
  matchedTerm?: string;
  reason: string;
}

export interface IngredientMatchReport {
  claimedBaseline: string;
  recalculated: { numerator: number; denominator: number; rate: number | null };
  uniqueTerms: number;
}

/** The curated audit source manifest (`data/manifest/sources.json`) as loaded by the runner. */
export interface SourceManifestReport {
  relativePath: string;
  sha256: string;
  sources: Array<{
    file: string;
    sourceId: string;
    name: string;
    title: string | null;
    reviewStatus: string;
  }>;
}

export interface AuditReport {
  schemaVersion: string;
  tool: string;
  rawRoot: string;
  generatedAt?: never; // deliberate: no timestamps in deterministic output
  sources: SourceAudit[];
  recipeClassification: { counts: Record<RecipeReviewClass, number> };
  ingredientMatching: IngredientMatchReport;
  rawProvenance: {
    files: Array<{ relativePath: string; sha256: string; byteSize: number }>;
  };
  /** Curated provenance manifest (`data/manifest/sources.json`), when present. */
  sourceManifest: SourceManifestReport | null;
  /** Aggregated structural errors across all sources, incl. runner-level failures. */
  structuralErrors: string[];
  structurallyInvalid: boolean;
}