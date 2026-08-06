/**
 * Egyptian recipe staging pipeline (Step 3).
 *
 * Usage: node --import tsx src/scripts/stage-recipes.ts [--root <dir>]
 *
 * Reads the read-only raw recipe CSV and the curated source manifest
 * (`data/manifest/sources.json`) and produces the curated Egyptian recipe
 * registry (`data/staging/recipes.json`):
 *   - rows carrying explicit Egyptian-scope evidence -> staged as `needs_review`;
 *   - rows clearly non-Egyptian (declared non-Egyptian cuisines, no Egyptian
 *     signal) -> staged as `rejected` with recorded evidence;
 *   - rows with no Egyptian evidence and no decidable classification -> excluded
 *     from the Egyptian registry (never silently treated as Egyptian).
 * Plus a current availability report (`data/reports/recipe-verification-report.*`).
 *
 * Provenance + license state is derived from the source manifest, never
 * hand-written: eligible records must be backed by an approved source record and
 * approved license metadata in `data/manifest/sources.json`. Every imported row is
 * fingerprinted; a human review is bound to that fingerprint and later re-imports
 * route the record back to review when its source row changed or disappeared
 * (source drift), preserving the historical timeline.
 *
 * The pipeline NEVER writes under `data/raw/`, NEVER fabricates values (missing
 * fields stay null / "not assessed"), and NEVER marks anything `verified` â€” only a
 * human review decision (see docs/MANUAL_REVIEW_WORKFLOW.md) may.
 *
 * The previous-step general-purpose global recipe dump
 * (`data/processed/cleaned_recipes.json`) is explicitly ignored and reported.
 *
 * Exits non-zero when the registry is invalid or no recipe is eligible.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDelimited, parseListField } from "../audit/csv.js";
import { classifyRecipe, type ClassificationResult, type RecipeInput } from "../audit/egyptian-evidence.js";
import { decodeText, detectMojibake, normalizeTerm } from "../audit/text.js";
import { stableJson } from "../audit/report.js";
import {
  culturalEvidenceRecords,
  isLicenseApprovedByManifest,
  isSourceRecordApproved,
  parseManifest,
  sourceRecordForSourceId,
  type Manifest,
} from "../domain/manifest.js";
import {
  RECIPE_VERIFICATION_STATUSES,
  STAGING_SCHEMA_VERSION,
  computeRowFingerprint,
  generateStableRecipeId,
  isEligibleForVerifiedDataset,
  isSha256Hex,
  validateStagingRegistry,
  type RecipeReviewTrace,
  type RecipeVerificationStatus,
  type StagedRecipe,
} from "../domain/recipes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const TOOL_NAME = "nutriguard-egypt-recipe-staging";

/** General-purpose global recipe dump that must NEVER be treated as Egyptian. */
const IGNORED_GLOBAL_RECIPE_FILES = ["data/processed/cleaned_recipes.json"];

export interface IgnoredGlobalRecipeFile {
  file: string;
  exists: boolean;
}

export interface ImportStat {
  rowsTotal: number;
  stagedNeedsReview: number;
  stagedRejectedNonEgyptian: number;
  excludedMalformedOrInvalid: number;
  excludedNoEgyptianEvidence: number;
  carriedOverFromRegistry: number;
  sourceDriftRoutedToReview: number;
}

export interface RecordEligibility {
  recipeId: string;
  originalTitle: string | null;
  status: RecipeVerificationStatus;
  eligible: boolean;
  blockers: string[];
}

export interface VerifiedRecipeReport {
  schemaVersion: string;
  tool: string;
  recipeSource: string | null;
  importStats: ImportStat;
  registryCounts: Record<RecipeVerificationStatus, number>;
  /** Records passing the verified-MVP gate. */
  eligibleForVerifiedDataset: number;
  verifiedRecipes: Array<{
    recipeId: string;
    originalTitle: string | null;
    reviewerId: string | null;
    reviewDate: string | null;
  }>;
  /** Per-record eligibility blockers (truthful, record-specific). */
  recordBlockers: RecordEligibility[];
  blockers: string[];
  validationIssues: Array<{ recipeId: string; issues: string[] }>;
  duplicateIds: string[];
  ignoredGlobalRecipeFiles: IgnoredGlobalRecipeFile[];
}

export interface StagingRunResult {
  report: VerifiedRecipeReport;
  registryPath: string;
  registry: StagedRecipe[];
  valid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Migrate a legacy registry record (schema v1.0) to v2.0 shape, filling in
 * any missing required fields with safe defaults. Called before validation so
 * that an old registry does not fail on missing-field issues.
 *
 * Rules:
 * - `sourceFingerprint`: filled from `importedFingerprint` if available (i.e.
 *   the record's raw row was found in the current import), otherwise left as ""
 *   (a sentinel that will fail validation and trigger the correct error message).
 * - `timeline[*].evidenceIds`: added as `[]` for any pipeline entry that lacks it.
 * - `review.snapshotFingerprint` / `review.staleReason`: defaulted to null.
 * - `source.sourceRowCount`: defaulted to undefined (absent is fine).
 * - `original`: left as-is (must be an object per schema; if absent it will fail
 *   validation with a meaningful message).
 * - All human-curated values (decision, reviewerId, reviewDate, evidenceIds,
 *   rationale, snapshotFingerprint set by human, full timeline) are PRESERVED.
 */
function migrateRecord(r: Record<string, unknown>, importedFingerprint: string | null): StagedRecipe {
  const raw = r as Partial<StagedRecipe> & Record<string, unknown>;

  // ---- review block ----
  const rawReview = isRecord(raw.review) ? (raw.review as Record<string, unknown>) : {};
  const rawTimeline: unknown[] = Array.isArray(rawReview.timeline) ? (rawReview.timeline as unknown[]) : [];

  // Ensure each pipeline timeline entry has evidenceIds: [].
  const migratedTimeline: RecipeReviewTrace[] = rawTimeline.map((entry) => {
    if (!isRecord(entry)) return entry as RecipeReviewTrace;
    const e = entry as Record<string, unknown>;
    if (!Array.isArray(e.evidenceIds)) {
      return { ...e, evidenceIds: [] } as unknown as RecipeReviewTrace;
    }
    return e as unknown as RecipeReviewTrace;
  });

  const review: StagedRecipe["review"] = {
    decision: (rawReview.decision as StagedRecipe["review"]["decision"]) ?? "unreviewed",
    reviewerId: (rawReview.reviewerId as string | null) ?? null,
    reviewDate: (rawReview.reviewDate as string | null) ?? null,
    evidenceIds: Array.isArray(rawReview.evidenceIds) ? (rawReview.evidenceIds as string[]) : [],
    rationale: (rawReview.rationale as string | null) ?? null,
    autoRejected: typeof rawReview.autoRejected === "boolean" ? rawReview.autoRejected : false,
    snapshotFingerprint:
      typeof rawReview.snapshotFingerprint === "string" ? rawReview.snapshotFingerprint : null,
    staleReason: typeof rawReview.staleReason === "string" ? rawReview.staleReason : null,
    timeline: migratedTimeline.length > 0
      ? migratedTimeline
      : [{ at: null, actor: "pipeline", action: "migrated_from_legacy", status: "needs_review" as const, note: "migrated from legacy registry (schema v1.0)", evidenceIds: [] }],
  };

  // ---- source block ----
  const rawSource = isRecord(raw.source) ? (raw.source as Record<string, unknown>) : {};
  const source: StagedRecipe["source"] = {
    sourceId: typeof rawSource.sourceId === "string" ? rawSource.sourceId : "",
    sourceFile: typeof rawSource.sourceFile === "string" ? rawSource.sourceFile : "",
    sourceRow: typeof rawSource.sourceRow === "number" ? rawSource.sourceRow : null,
    sourceVersion: typeof rawSource.sourceVersion === "string" ? rawSource.sourceVersion : null,
    accessDate: typeof rawSource.accessDate === "string" ? rawSource.accessDate : null,
    url: typeof rawSource.url === "string" ? rawSource.url : null,
    sourceRowCount: typeof rawSource.sourceRowCount === "number" ? rawSource.sourceRowCount : undefined,
  };

  // ---- names block ----
  const rawNames = isRecord(raw.names) ? (raw.names as Record<string, unknown>) : {};
  const names: StagedRecipe["names"] = {
    ar: typeof rawNames.ar === "string" ? rawNames.ar : null,
    en: typeof rawNames.en === "string" ? rawNames.en : null,
    eg: typeof rawNames.eg === "string" ? rawNames.eg : null,
    aliases: Array.isArray(rawNames.aliases) ? (rawNames.aliases as string[]) : [],
  };

  // ---- sourceFingerprint ----
  // Prefer the existing value if it is a valid SHA-256; otherwise use the
  // freshly computed fingerprint from the current import (if available), so the
  // migrated record passes the fingerprint-format validation.
  const existingFp = typeof raw.sourceFingerprint === "string" ? raw.sourceFingerprint : "";
  const sourceFingerprint =
    isSha256Hex(existingFp) ? existingFp
    : importedFingerprint !== null ? importedFingerprint
    : existingFp; // keep (empty/invalid) so validation reports the right message

  return {
    recipeId: typeof raw.recipeId === "string" ? raw.recipeId : "",
    names,
    category: typeof raw.category === "string" ? raw.category : null,
    subcategory: typeof raw.subcategory === "string" ? raw.subcategory : null,
    region: typeof raw.region === "string" ? raw.region : null,
    yield: isRecord(raw.yield)
      ? { servings: (raw.yield as Record<string, unknown>).servings as number | null ?? null, finalCookedWeightG: (raw.yield as Record<string, unknown>).finalCookedWeightG as number | null ?? null }
      : { servings: null, finalCookedWeightG: null },
    source,
    license: isRecord(raw.license) ? (raw.license as StagedRecipe["license"]) : { status: "not_assessed", id: null, url: null, note: null },
    verificationStatus: (raw.verificationStatus as StagedRecipe["verificationStatus"]) ?? "needs_review",
    review,
    version: STAGING_SCHEMA_VERSION,
    original: isRecord(raw.original) ? (raw.original as Record<string, unknown>) : (raw.original as unknown as Record<string, unknown>),
    originalTitle: typeof raw.originalTitle === "string" ? raw.originalTitle : null,
    notes: Array.isArray(raw.notes) ? (raw.notes as string[]) : [],
    sourceFingerprint,
  };
}

/** Load and parse the source manifest; missing/malformed manifest is a hard error. */
async function loadSourceManifest(root: string): Promise<Manifest> {
  const manifestPath = path.join(root, "data", "manifest", "sources.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`source manifest ${path.relative(root, manifestPath)} is missing (required for provenance/license/evidence validation)`);
    }
    throw err;
  }
  const manifest = parseManifest(raw);
  // Malformed cultural evidence (no applicableTo scope) is a hard error.
  for (const ev of manifest.evidenceReferences) {
    if (ev.purpose.trim().toLowerCase() === "egyptian_recipe_cultural_evidence" && ev.applicableTo.length === 0) {
      throw new Error(`manifest evidence id "${ev.id}" (egyptian_recipe_cultural_evidence) needs a non-empty applicableTo list`);
    }
  }
  return manifest;
}

/** Discover the raw recipe CSV under `data/raw/`. */
async function findRecipeCsv(rawRoot: string): Promise<string | null> {
  let list: string[];
  try {
    list = await fs.readdir(rawRoot);
  } catch {
    return null;
  }
  const f = list.find((n) => n.toLowerCase().includes("recipes") && n.toLowerCase().endsWith(".csv"));
  return f ? path.join(rawRoot, f) : null;
}

/** Load the registry array; `null` when the file's content is malformed (never throws on content). */
async function loadRegistry(root: string): Promise<StagedRecipe[] | null> {
  const registryPath = path.join(root, "data", "staging", "recipes.json");
  let raw: string;
  try {
    raw = await fs.readFile(registryPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as StagedRecipe[];
  } catch {
    return null;
  }
}

/** Build the classifier input for one raw row (provenance fields absent -> C-1/C-3 fail). */
function buildRecipeInputFromRow(
  row: string[],
  headers: string[],
  lineNumber: number,
  fileIsValidUtf8: boolean,
  manifest: Manifest
): RecipeInput {
  const idx = (name: string): number => headers.indexOf(name);
  const title = (row[idx("recipe_title")] ?? "").trim();
  const canonicalRaw = row[idx("ingredients_canonical")] ?? "";
  const canonicalTerms = parseListField(canonicalRaw) ?? [];
  const ingredientLines = parseListField(row[idx("ingredients")] ?? "") ?? [];
  const directionsList = parseListField(row[idx("directions")] ?? "") ?? [];
  const ingredientTermSet = new Set<string>();
  for (const term of canonicalTerms) {
    const norm = normalizeTerm(term);
    if (norm !== "") ingredientTermSet.add(norm);
  }
  return {
    row: lineNumber,
    title,
    description: row[idx("description")] ?? "",
    category: row[idx("category")] ?? "",
    subcategory: row[idx("subcategory")] ?? "",
    cuisineList: parseListField(row[idx("cuisine_list")] ?? "") ?? [],
    mainIngredient: row[idx("main_ingredient")] ?? "",
    ingredientTerms: [...ingredientTermSet],
    mojibakeInTitle: detectMojibake(title).detected,
    malformed: false,
    missingTitle: title === "",
    missingIngredients: canonicalTerms.length === 0 && ingredientLines.length === 0,
    hasInstructions: directionsList.length > 0,
    fileIsValidUtf8,
    sourceId: "",
    sourceVersion: "",
    accessDate: "",
    cultureEvidenceLink: "",
    culturalEvidence: culturalEvidenceRecords(manifest),
  };
}

/** Preserve the original row verbatim (header -> raw value). */
function buildOriginal(headers: string[], row: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < headers.length; i += 1) out[headers[i]] = row[i] ?? "";
  return out;
}

/** Derive the record's provenance + license state from the manifest (never invented). */
function provenanceFromManifest(
  relPath: string,
  manifest: Manifest
): {
  sourceId: string;
  sourceVersion: string | null;
  accessDate: string | null;
  url: string | null;
  license: { status: StagedRecipe["license"]["status"]; id: string | null; url: string | null; note: string | null };
} {
  const record = sourceRecordForSourceId(manifest, relPath, relPath);
  let sourceVersion: string | null = null;
  let accessDate: string | null = null;
  let url: string | null = null;
  if (record) {
    sourceVersion = record.sourceVersion;
    url = record.sourceUrl;
    accessDate = record.accessDate;
  }
  const sourceId = record ? (record.sourceId ?? relPath) : relPath;

  let status: StagedRecipe["license"]["status"];
  let id: string | null = null;
  let licenseUrl: string | null = null;
  let note: string | null;
  if (record === null) {
    status = "not_assessed";
    note = "no license/provenance record for this source in data/manifest/sources.json; license not assessed";
  } else if (isLicenseApprovedByManifest(record)) {
    status = "approved";
    id = record.sourceId ?? record.file;
    licenseUrl = record.licenseUrl;
    note = `license "${record.license}" approved in data/manifest/sources.json (${record.licenseReviewedBy}, ${record.licenseReviewDate})`;
  } else {
    status = "pending";
    id = record.sourceId ?? record.file;
    licenseUrl = record.licenseUrl;
    note = "license record present in data/manifest/sources.json but not approved (requires license identity/url + license review approval metadata)";
  }
  return { sourceId, sourceVersion, accessDate, url, license: { status, id, url: licenseUrl, note } };
}

function baseRecord(
  row: string[],
  headers: string[],
  lineNumber: number,
  relPath: string,
  title: string,
  fingerprint: string,
  manifest: Manifest,
  sourceRowCount?: number
): StagedRecipe {
  const catIdx = headers.indexOf("category");
  const subIdx = headers.indexOf("subcategory");
  const prov = provenanceFromManifest(relPath, manifest);
  return {
    recipeId: generateStableRecipeId(relPath, lineNumber, title),
    names: { ar: null, en: title, eg: null, aliases: [] },
    category: (row[catIdx] ?? "").trim() || null,
    subcategory: (row[subIdx] ?? "").trim() || null,
    region: null,
    yield: { servings: null, finalCookedWeightG: null },
    source: {
      sourceId: prov.sourceId,
      sourceFile: relPath,
      sourceRow: lineNumber,
      sourceVersion: prov.sourceVersion,
      accessDate: prov.accessDate,
      url: prov.url,
      sourceRowCount,
    },
    license: prov.license,
    verificationStatus: "needs_review",
    review: {
      decision: "unreviewed",
      reviewerId: null,
      reviewDate: null,
      evidenceIds: [],
      rationale: null,
      autoRejected: false,
      timeline: [],
      snapshotFingerprint: null,
      staleReason: null,
    },
    version: STAGING_SCHEMA_VERSION,
    original: buildOriginal(headers, row),
    originalTitle: title,
    notes: ["automated import from raw source; original row preserved verbatim"],
    sourceFingerprint: fingerprint,
  };
}

/** Import a row with explicit Egyptian-scope evidence as `needs_review`. */
function buildPendingRecord(
  row: string[],
  headers: string[],
  lineNumber: number,
  relPath: string,
  fingerprint: string,
  manifest: Manifest,
  result: ClassificationResult,
  sourceRowCount: number
): StagedRecipe {
  const title = (row[headers.indexOf("recipe_title")] ?? "").trim();
  const rec = baseRecord(row, headers, lineNumber, relPath, title, fingerprint, manifest, sourceRowCount);
  rec.review.timeline = [
    {
      at: null,
      actor: "pipeline",
      action: "imported_as_needs_review",
      status: "needs_review",
      note: `Egyptian-scope evidence: ${result.signals.join("; ")}`,
      evidenceIds: [],
    },
  ];
  rec.notes.push(`classification: ${result.reasons.join("; ")}`);
  return rec;
}

/** Import a clearly non-Egyptian row (declared non-Egyptian cuisines, no signals) as `rejected`. */
function buildAutoRejectedRecord(
  row: string[],
  headers: string[],
  lineNumber: number,
  relPath: string,
  fingerprint: string,
  manifest: Manifest,
  result: ClassificationResult,
  declaredCuisines: string[],
  sourceRowCount: number
): StagedRecipe {
  const title = (row[headers.indexOf("recipe_title")] ?? "").trim();
  const rec = baseRecord(row, headers, lineNumber, relPath, title, fingerprint, manifest, sourceRowCount);
  rec.verificationStatus = "rejected";
  rec.review = {
    decision: "rejected",
    reviewerId: null,
    reviewDate: null,
    evidenceIds: [],
    rationale: null,
    autoRejected: true,
    timeline: [
      {
        at: null,
        actor: "pipeline",
        action: "import_rejected_non_egyptian",
        status: "rejected",
        note: `declared non-Egyptian cuisines: ${declaredCuisines.join(", ")} | ${result.reasons.join("; ")}`,
        evidenceIds: [],
      },
    ],
    snapshotFingerprint: null,
    staleReason: null,
  };
  rec.notes.push(
    "automated import-time rejection on declared non-Egyptian cuisine evidence (no human verdict; requires confirmation)",
    `classification: ${result.reasons.join("; ")}`
  );
  return rec;
}

/**
 * Route a record whose reviewed source row changed/disappeared back to review.
 * When a new imported row is available (`newOriginal` + `newFingerprint`),
 * the record's machine-owned fields are updated to the new snapshot so that a
 * subsequent human re-review binds to the new fingerprint.
 */
function routeBackToReview(
  rec: StagedRecipe,
  reason: string,
  newOriginal?: Record<string, unknown>,
  newFingerprint?: string,
  newProv?: ReturnType<typeof provenanceFromManifest>,
): void {
  rec.verificationStatus = "needs_review";
  rec.review = {
    decision: "unreviewed",
    reviewerId: null,
    reviewDate: null,
    evidenceIds: [],
    rationale: null,
    autoRejected: false,
    snapshotFingerprint: rec.review.snapshotFingerprint, // preserve old reviewed fingerprint in timeline
    staleReason: reason,
    timeline: [
      ...rec.review.timeline,
      {
        at: null,
        actor: "pipeline",
        action: "source_drift_detected",
        status: "needs_review",
        note: reason,
        evidenceIds: [],
      },
    ],
  };
  rec.notes = [...(rec.notes ?? []), `source drift: ${reason}`];

  // Update machine-owned fields to the new snapshot (if available).
  if (newOriginal !== undefined) {
    rec.original = newOriginal;
  }
  if (newFingerprint !== undefined && newFingerprint !== "") {
    rec.sourceFingerprint = newFingerprint;
    // After drift is applied and the old snapshotFingerprint is recorded in the
    // timeline above, clear snapshotFingerprint so the next human re-review
    // binds to the NEW fingerprint via applyReviewDecision.
    rec.review.snapshotFingerprint = null;
  }
  if (newProv !== undefined) {
    rec.source.sourceId = newProv.sourceId;
    rec.source.sourceVersion = newProv.sourceVersion;
    rec.source.accessDate = newProv.accessDate;
    rec.source.url = newProv.url;
    rec.license = newProv.license;
  }
}

function renderStagingReportMarkdown(report: VerifiedRecipeReport): string {
  const lines: string[] = [];
  lines.push(`# Recipe Verification Report`);
  lines.push(``);
  lines.push(`- Tool: ${report.tool}`);
  lines.push(`- Schema version: ${report.schemaVersion}`);
  lines.push(`- Recipe source: ${report.recipeSource ?? "n/a (no raw recipe CSV found)"}`);
  lines.push(``);

  lines.push(`## Import statistics`);
  lines.push(``);
  lines.push(`- Rows in source: ${report.importStats.rowsTotal}`);
  lines.push(`- Imported as \`needs_review\` (Egyptian-scope evidence): ${report.importStats.stagedNeedsReview}`);
  lines.push(`- Imported as \`rejected\` (clear non-Egyptian evidence): ${report.importStats.stagedRejectedNonEgyptian}`);
  lines.push(`- Excluded â€” malformed/invalid rows: ${report.importStats.excludedMalformedOrInvalid}`);
  lines.push(`- Excluded â€” no Egyptian evidence & not classifiable non-Egyptian: ${report.importStats.excludedNoEgyptianEvidence}`);
  lines.push(`- Preserved from existing registry (reviews kept): ${report.importStats.carriedOverFromRegistry}`);
  lines.push(`- Routed back to review (source drift): ${report.importStats.sourceDriftRoutedToReview}`);
  lines.push(``);

  lines.push(`## Registry status`);
  lines.push(``);
  lines.push(`- needs_review: ${report.registryCounts.needs_review}`);
  lines.push(`- verified: ${report.registryCounts.verified}`);
  lines.push(`- rejected: ${report.registryCounts.rejected}`);
  lines.push(`- Eligible for the verified MVP dataset: **${report.eligibleForVerifiedDataset}**`);
  lines.push(``);

  lines.push(`## Verified recipes available for the MVP`);
  lines.push(``);
  if (report.verifiedRecipes.length === 0) {
    lines.push(`**None.** No recipe is available for the verified MVP dataset.`);
    lines.push(`Nothing is fabricated to reach a target.`);
  } else {
    for (const v of report.verifiedRecipes) {
      lines.push(`- \`${v.recipeId}\` ${v.originalTitle ?? "n/a"} â€” reviewed by ${v.reviewerId} on ${v.reviewDate}`);
    }
  }
  lines.push(``);

  lines.push(`## Blockers`);
  lines.push(``);
  for (const b of report.blockers) lines.push(`- ${b}`);
  lines.push(``);

  const nonEligible = report.recordBlockers.filter((r) => !r.eligible);
  if (nonEligible.length > 0) {
    lines.push(`## Per-record eligibility blockers`);
    lines.push(``);
    for (const r of nonEligible) {
      lines.push(`- \`${r.recipeId}\` (${r.originalTitle ?? "n/a"}, ${r.status}):`);
      for (const b of r.blockers) lines.push(`  - ${b}`);
    }
    lines.push(``);
  }

  if (report.validationIssues.length > 0 || report.duplicateIds.length > 0) {
    lines.push(`## Validation issues`);
    lines.push(``);
    for (const d of report.duplicateIds) lines.push(`- duplicate recipeId: ${d}`);
    for (const x of report.validationIssues) lines.push(`- ${x.recipeId}: ${x.issues.join("; ")}`);
    lines.push(``);
  }

  lines.push(`## Ignored global recipe files`);
  lines.push(``);
  for (const g of report.ignoredGlobalRecipeFiles) {
    lines.push(
      `- \`${g.file}\` ${g.exists ? "(exists â€” ignored)" : "(not present)"} â€” general-purpose dump, never treated as Egyptian`
    );
  }
  lines.push(``);
  return lines.join("\n");
}

export function stageRecipes(root = PROJECT_ROOT): Promise<StagingRunResult> {
  return runStageRecipes(root);
}

async function runStageRecipes(root: string): Promise<StagingRunResult> {
  const rawRoot = path.join(root, "data", "raw");
  const rel = (p: string) => path.relative(root, p).replaceAll("\\", "/");

  const ignored: IgnoredGlobalRecipeFile[] = [];
  for (const file of IGNORED_GLOBAL_RECIPE_FILES) {
    let exists = false;
    try {
      await fs.access(path.join(root, file));
      exists = true;
    } catch {
      // not present â€” still reported as ignored
    }
    ignored.push({ file, exists });
  }

  const importStats: ImportStat = {
    rowsTotal: 0,
    stagedNeedsReview: 0,
    stagedRejectedNonEgyptian: 0,
    excludedMalformedOrInvalid: 0,
    excludedNoEgyptianEvidence: 0,
    carriedOverFromRegistry: 0,
    sourceDriftRoutedToReview: 0,
  };

  const manifest = await loadSourceManifest(root);
  const recipeFile = await findRecipeCsv(rawRoot);
  const recipeSource = recipeFile ? rel(recipeFile) : null;

  const existing = await loadRegistry(root);
  const cannotMerge = existing === null;
  const safeExisting = cannotMerge ? [] : (existing as StagedRecipe[]);

  const seenCounts = new Map<string, number>();
  for (const r of safeExisting) {
    if (!isRecord(r) || typeof r.recipeId !== "string") continue;
    seenCounts.set(r.recipeId, (seenCounts.get(r.recipeId) ?? 0) + 1);
  }
  const registryDuplicateIds = [...seenCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort();

  // Merge: existing records (including malformed entries, preserved for validation)
  // win over re-imported rows of the same ID so human reviews are never overwritten.
  // First pass: collect all imported row data keyed by stable recipeId so that
  // migration and provenance-reconciliation can reference the current raw row.
  const registry: StagedRecipe[] = [];
  const presentIds = new Set<string>();

  // Map from recipeId -> { fingerprint, original, row, headers, lineNumber }
  const importedRowData = new Map<string, {
    fingerprint: string;
    original: Record<string, unknown>;
    prov: ReturnType<typeof provenanceFromManifest>;
    sourceRowCount: number;
  }>();
  const importedIds = new Set<string>();
  const rowFingerprints = new Map<string, string>();
  const headersForBlocker: string[] = [];
  // Pending staged records from the CSV import (to be added after existing records,
  // so existing human-reviewed records always win the merge).
  const pendingStaged: StagedRecipe[] = [];

  if (recipeFile) {
    const buf = await fs.readFile(recipeFile);
    const enc = decodeText(buf);
    const parsed = parseDelimited(enc.text, "\t");
    const headers = (parsed.rows[0] ?? []).map((h) => h.trim());
    headersForBlocker.push(...headers);
    importStats.rowsTotal = Math.max(0, parsed.rows.length - 1);

    for (let i = 0; i < importStats.rowsTotal; i += 1) {
      const row = parsed.rows[i + 1];
      const lineNumber = i + 2;
      const malformed = row.length !== headers.length;
      const input: RecipeInput = { ...buildRecipeInputFromRow(row, headers, lineNumber, enc.validUtf8, manifest), malformed };
      const result = classifyRecipe(input);

      if (malformed || result.classification === "rejected") {
        importStats.excludedMalformedOrInvalid += 1;
        continue;
      }

      const fingerprint = computeRowFingerprint(recipeSource ?? "?", lineNumber, headers, row);
      rowFingerprints.set(`${recipeSource ?? "?"}|${lineNumber}`, fingerprint);
      const title = (row[headers.indexOf("recipe_title")] ?? "").trim();
      const stableId = generateStableRecipeId(recipeSource ?? "?", lineNumber, title);
      const prov = provenanceFromManifest(recipeSource ?? "?", manifest);
      importedRowData.set(stableId, {
        fingerprint,
        original: buildOriginal(headers, row),
        prov,
        sourceRowCount: importStats.rowsTotal,
      });

      if (result.classification === "not_egyptian") {
        const declaredCuisines = input.cuisineList.map((c) => c.toLowerCase().trim());
        const rec = buildAutoRejectedRecord(row, headers, lineNumber, recipeSource ?? "?", fingerprint, manifest, result, declaredCuisines, importStats.rowsTotal);
        importedIds.add(rec.recipeId);
        pendingStaged.push(rec);
        importStats.stagedRejectedNonEgyptian += 1;
        continue;
      }

      if (result.signals.length > 0) {
        const rec = buildPendingRecord(row, headers, lineNumber, recipeSource ?? "?", fingerprint, manifest, result, importStats.rowsTotal);
        importedIds.add(rec.recipeId);
        pendingStaged.push(rec);
        importStats.stagedNeedsReview += 1;
        continue;
      }

      // No Egyptian evidence and no clear non-Egyptian classification: excluded.
      importStats.excludedNoEgyptianEvidence += 1;
    }
  }

  // Existing records FIRST (including malformed entries, preserved for validation)
  // win over re-imported rows of the same ID so human reviews are never
  // overwritten. Provenance/license fields are reconciled from the current
  // manifest (Step 2), and legacy schema shape is migrated before validation.
  for (const r of safeExisting) {
    if (!isRecord(r)) {
      // Preserve malformed entries so they show up in validation issues.
      registry.push(r as unknown as StagedRecipe);
      continue;
    }
    const recipeId = typeof r.recipeId === "string" ? r.recipeId : "";
    presentIds.add(recipeId);

    // Migrate: fill in missing v2.0 fields from the current imported row (if available).
    const imported = importedRowData.get(recipeId) ?? null;
    const migrated = migrateRecord(r, imported?.fingerprint ?? null);

    // Reconcile machine-owned provenance + license from the current manifest.
    if (migrated.source.sourceFile && migrated.source.sourceFile === recipeSource) {
      const prov = imported?.prov ?? provenanceFromManifest(migrated.source.sourceFile, manifest);
      migrated.source.sourceId = prov.sourceId;
      migrated.source.sourceVersion = prov.sourceVersion;
      migrated.source.accessDate = prov.accessDate;
      migrated.source.url = prov.url;
      migrated.license = prov.license;
      if (imported) {
        migrated.source.sourceRowCount = imported.sourceRowCount;
      }
    }

    registry.push(migrated);
  }

  // Now add freshly imported rows that don't already exist in the registry (brand-new
  // entries only; existing-reviewed entries already carried over above).
  for (const rec of pendingStaged) {
    if (presentIds.has(rec.recipeId)) continue;
    presentIds.add(rec.recipeId);
    registry.push(rec);
  }

  importStats.carriedOverFromRegistry = safeExisting.filter(
    (r) => isRecord(r) && typeof r.recipeId === "string" && !importedIds.has(r.recipeId as string)
  ).length;

  // ---- Source-drift protection: compare every REVIEWED record's stored snapshot
  // fingerprint with the current raw row (or its disappearance).
  for (const rec of registry) {
    if (!isRecord(rec) || !rec.review) continue;
    const rev = rec.review as StagedRecipe["review"];
    if (rev.staleReason !== null && rev.staleReason !== undefined) continue; // already routed
    const snapshot = typeof rev.snapshotFingerprint === "string" ? rev.snapshotFingerprint : null;
    if (snapshot === null || snapshot === "") continue; // not reviewed yet
    const rawRow =
      rec.source &&
      typeof rec.source.sourceFile === "string" &&
      rec.source.sourceFile === recipeSource &&
      typeof rec.source.sourceRow === "number" &&
      rec.source.sourceRow >= 1;
    if (!rawRow) continue; // curated records have no live raw row
    const key = `${recipeSource}|${rec.source.sourceRow}`;
    const current = rowFingerprints.get(key);
    const originalRowCount = typeof rec.source.sourceRowCount === "number" ? rec.source.sourceRowCount : importStats.rowsTotal;
    const rowsDeleted = importStats.rowsTotal < originalRowCount;
    // Check if the snapshot fingerprint exists anywhere in the current rows
    const snapshotFoundElsewhere = [...rowFingerprints.values()].includes(snapshot);
    // New row data for updating machine fields after drift (when the row changed in-place).
    const newRowData = current !== undefined ? importedRowData.get(rec.recipeId) : undefined;
    if (current === undefined) {
      // Row position no longer exists in current file
      routeBackToReview(rec, "source row deleted from the raw source after review (orphaned record); re-review required");
      importStats.sourceDriftRoutedToReview += 1;
    } else if (current !== snapshot) {
      // Row at position exists but content differs
      let reason: string;
      if (rowsDeleted) {
        reason = "source row deleted from the raw source after review (orphaned record); re-review required";
      } else if (snapshotFoundElsewhere) {
        reason = "source row changed after review (canonical fingerprint mismatch); re-review required";
      } else {
        // Same row count, snapshot not found elsewhere -> modified in place
        reason = "source row changed after review (canonical fingerprint mismatch); re-review required";
      }
      routeBackToReview(
        rec,
        reason,
        newRowData?.original,
        newRowData?.fingerprint,
        newRowData?.prov,
      );
      importStats.sourceDriftRoutedToReview += 1;
    }
  }

  registry.sort((a, b) => {
    const ka = isRecord(a) && typeof a.recipeId === "string" ? a.recipeId : "~";
    const kb = isRecord(b) && typeof b.recipeId === "string" ? b.recipeId : "~";
    return ka.localeCompare(kb);
  });

  let validation = validateStagingRegistry(registry, manifest);
  if (cannotMerge) {
    validation = {
      duplicateIds: validation.duplicateIds,
      issues: [
        {
          recipeId: "(registry)",
          issues: ["staging registry file could not be parsed (malformed JSON / not an array); existing records are not recoverable"],
        },
        ...validation.issues,
      ],
      valid: false,
    };
  }
  const duplicateIds = [...new Set([...validation.duplicateIds, ...registryDuplicateIds])].sort();
  const valid = validation.issues.length === 0 && duplicateIds.length === 0;

  const counts: Record<RecipeVerificationStatus, number> = { needs_review: 0, verified: 0, rejected: 0 };
  const verifiedRecipes: VerifiedRecipeReport["verifiedRecipes"] = [];
  const recordBlockers: RecordEligibility[] = [];
  let eligible = 0;
  for (const r of registry) {
    if (!isRecord(r)) continue;
    const st = r.verificationStatus as RecipeVerificationStatus;
    if (RECIPE_VERIFICATION_STATUSES.includes(st)) counts[st] += 1;
    const g = isEligibleForVerifiedDataset(r, manifest);
    recordBlockers.push({
      recipeId: r.recipeId,
      originalTitle: r.originalTitle,
      status: st,
      eligible: g.eligible,
      blockers: g.blockers,
    });
    if (g.eligible) {
      eligible += 1;
      verifiedRecipes.push({
        recipeId: r.recipeId,
        originalTitle: r.originalTitle,
        reviewerId: r.review.reviewerId,
        reviewDate: r.review.reviewDate,
      });
    }
  }

  // Derived, manifest-truthful blockers (never unconditional).
  const blockers: string[] = [];
  if (eligible === 0) {
    blockers.push("0 verified recipes available â€” the MVP verified-recipe target is not met and is not being fabricated.");
  }
  if (recipeFile === null) {
    blockers.push("No raw recipe CSV found under data/raw â€” the staging registry cannot be seeded from a source.");
  } else {
    const sourceRecord = sourceRecordForSourceId(manifest, recipeSource, recipeSource);
    if (sourceRecord === null) {
      blockers.push(`Recipe source "${recipeSource}" has no source record in data/manifest/sources.json â€” provenance/license coverage is incomplete (records stay pending/not_assessed).`);
    } else {
      if (!isSourceRecordApproved(sourceRecord)) {
        blockers.push(`Source record "${sourceRecord.sourceId ?? sourceRecord.file}" is not provenance-approved in data/manifest/sources.json (requires review_status=approved + reviewer + strict ISO review_date).`);
      }
      if (!isLicenseApprovedByManifest(sourceRecord)) {
        blockers.push(`License for "${sourceRecord.sourceId ?? sourceRecord.file}" is not approved in data/manifest/sources.json (requires license identity + http(s) license_url + license approval metadata).`);
      }
    }
  }
  if (counts.verified === 0 && counts.needs_review > 0) {
    blockers.push(
      "Every imported recipe is unreviewed (needs_review). Verification requires a human review decision: reviewerId + strict ISO reviewDate + evidence that resolves against data/manifest/sources.json (docs/MANUAL_REVIEW_WORKFLOW.md)."
    );
  }
  if (headersForBlocker.length > 0) {
    const h = new Set(headersForBlocker.map((x) => x.trim().toLowerCase()));
    const missing: string[] = [];
    if (!h.has("names_ar") && !h.has("arabic_name") && !h.has("name_ar")) missing.push("Arabic names");
    if (!h.has("region_ar") && !h.has("region")) missing.push("region");
    if (!h.has("servings") && !h.has("servings_yield") && !h.has("yield_mv")) missing.push("servings");
    if (!h.has("cooked_weight_g") && !h.has("final_cooked_weight_g") && !h.has("final_cooked_weight")) missing.push("final-cooked-weight");
    if (missing.length > 0) {
      blockers.push(`Columns absent from the raw source and stored as null (never fabricated; must be curated by reviewers): ${missing.join(", ")}.`);
    }
  }

  const report: VerifiedRecipeReport = {
    schemaVersion: STAGING_SCHEMA_VERSION,
    tool: TOOL_NAME,
    recipeSource,
    importStats,
    registryCounts: counts,
    eligibleForVerifiedDataset: eligible,
    verifiedRecipes,
    recordBlockers,
    blockers,
    validationIssues: validation.issues,
    duplicateIds,
    ignoredGlobalRecipeFiles: ignored,
  };

  const registryPath = path.join(root, "data", "staging", "recipes.json");
  const reportsDir = path.join(root, "data", "reports");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });
  if (!cannotMerge) {
    await fs.writeFile(registryPath, stableJson(registry), "utf8");
  }
  await fs.writeFile(path.join(reportsDir, "recipe-verification-report.json"), stableJson(report), "utf8");
  await fs.writeFile(path.join(reportsDir, "recipe-verification-report.md"), renderStagingReportMarkdown(report), "utf8");

  return { report, registryPath, registry, valid };
}

async function main(): Promise<void> {
  let root = PROJECT_ROOT;
  const args = process.argv.slice(2);
  const rootArg = args.indexOf("--root");
  if (rootArg !== -1 && args[rootArg + 1]) root = path.resolve(args[rootArg + 1]);

  try {
    const result = await stageRecipes(root);
    const r = result.report;
    console.log(
      `recipe staging: ${r.registryCounts.needs_review} needs_review, ${r.registryCounts.verified} verified, ` +
        `${r.registryCounts.rejected} rejected; ${r.eligibleForVerifiedDataset} eligible for the verified MVP`
    );
    if (!result.valid) {
      console.error("ERROR: staged recipe registry is invalid (duplicate IDs, malformed records, missing sources, unverifiable records); exiting non-zero");
      process.exitCode = 1;
    } else if (r.eligibleForVerifiedDataset === 0) {
      console.error("BLOCKER: no verified recipes available (nothing fabricated; see data/reports/recipe-verification-report.md)");
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`recipe staging failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  void main();
}