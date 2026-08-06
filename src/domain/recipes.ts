/**
 * Egyptian recipe staging registry â€” Step 3.
 *
 * Schema + validation for the curated Egyptian recipe registry
 * (`data/staging/recipes.json`), the deterministic stable-ID generator, the
 * manual-review decision recorder, and the gate that decides which staged
 * recipes may enter the verified MVP dataset.
 *
 * Hard rules (mirror DATA_SOURCE_POLICY.md / MVP_REQUIREMENTS.md):
 *  - Automation NEVER sets a `verified` status. Only a human review decision
 *    recorded through `applyReviewDecision` (reviewer identity + strict ISO
 *    review date + documented evidence references + rationale) can produce
 *    `verified`.
 *  - Evidence references are validated against the source manifest
 *    (`data/manifest/sources.json`): an ID must exist, must have purpose
 *    `egyptian_recipe_cultural_evidence`, and its `applicableTo` scope must
 *    match the recipe's normalized title / aliases. Guideline / unknown /
 *    wrong-dish / blank-after-trim IDs are rejected; direct URLs are accepted
 *    only as valid HTTP(S) URLs and require a non-empty rationale describing
 *    the evidence path.
 *  - Provenance + license approvals come from the manifest, never from hand
 *    written registry fields. A record is eligible only when its source record
 *    is approved and its license approval is backed by the manifest.
 *  - A reviewed record's source row is fingerprinted; when the raw source row
 *    changes or disappears after review, the record is routed back to review
 *    with an explicit stale/source-drift reason (historical timeline kept).
 *  - Malformed registry objects produce validation issues (never runtime
 *    exceptions), and structurally invalid records are never eligible.
 *  - No fabricated values: any field without source data is `null` (or an
 *    explicit "not assessed" status), never an invented zero/default.
 */

import { createHash } from "node:crypto";

import { detectMojibake, normalizeTerm } from "../audit/text.js";
import { containsAtTokenBoundary, isValidIsoDate } from "../audit/egyptian-evidence.js";
import {
  CULTURAL_EVIDENCE_PURPOSE,
  isLicenseApprovedByManifest,
  isSourceRecordApproved,
  isValidHttpUrlString,
  sourceRecordForSourceId,
  type Manifest,
} from "./manifest.js";

/** Version of the staging registry schema / record shape. */
export const STAGING_SCHEMA_VERSION = "2.0";
export const RECIPE_ID_PREFIX = "EGR-";

/** Pattern for a valid SHA-256 hex digest (exactly 64 lowercase hex chars). */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Returns true when `value` is a valid SHA-256 hex string (64 lowercase hex chars). */
export function isSha256Hex(value: string): boolean {
  return SHA256_HEX_RE.test(value);
}

export type RecipeVerificationStatus = "needs_review" | "verified" | "rejected";
export type RecipeReviewDecision = "unreviewed" | "verified" | "rejected";
export type RecipeLicenseStatus = "not_assessed" | "pending" | "approved" | "rejected";

export const RECIPE_VERIFICATION_STATUSES: readonly RecipeVerificationStatus[] = [
  "needs_review",
  "verified",
  "rejected",
];
export const RECIPE_REVIEW_DECISIONS: readonly RecipeReviewDecision[] = ["unreviewed", "verified", "rejected"];
export const RECIPE_LICENSE_STATUSES: readonly RecipeLicenseStatus[] = [
  "not_assessed",
  "pending",
  "approved",
  "rejected",
];

/** Recipe names: Arabic / English / Egyptian plus aliases. Missing -> null, never invented. */
export interface RecipeNames {
  ar: string | null;
  en: string | null;
  eg: string | null;
  aliases: string[];
}

/** Servings / final cooked weight. Missing -> null, never invented zero. */
export interface RecipeYield {
  servings: number | null;
  finalCookedWeightG: number | null;
}

/** Provenance of the staged record. `sourceId`/`sourceFile` are mandatory. */
export interface RecipeSourceRef {
  sourceId: string;
  sourceFile: string;
  sourceRow: number | null;
  sourceVersion: string | null;
  accessDate: string | null;
  url: string | null;
  sourceRowCount?: number;
}

/** License/redistribution status of the record's source. */
export interface RecordLicense {
  status: RecipeLicenseStatus;
  id: string | null;
  url: string | null;
  note: string | null;
}

/**
 * One append-only entry in the record's history (import, review decision, ...).
 * `at` is a strict ISO date for human actions and `null` for deterministic
 * pipeline actions. Human decision events also preserve the evidence IDs used
 * for that decision.
 */
export interface RecipeReviewTrace {
  at: string | null;
  actor: string;
  action: string;
  status: RecipeVerificationStatus;
  note: string;
  /** Evidence IDs referenced by THIS event (trimmed). Human_verified requires non-empty. */
  evidenceIds: string[];
}

export interface StagedRecipeReview {
  decision: RecipeReviewDecision;
  reviewerId: string | null;
  reviewDate: string | null;
  /** Documented evidence references (validated against the manifest). */
  evidenceIds: string[];
  rationale: string | null;
  /** True when the record was rejected by the import pipeline on non-Egyptian
   * evidence (not a human verdict); reviewer fields then stay null. */
  autoRejected: boolean;
  timeline: RecipeReviewTrace[];
  /**
   * Deterministic fingerprint of the source row that was actually reviewed
   * (the reviewed snapshot). Set by `applyReviewDecision`; null before any
   * human decision. Used to detect later source drift.
   */
  snapshotFingerprint: string | null;
  /**
   * Non-null when the reviewed source row changed / disappeared after review,
   * routing the record back to needs_review. Blocks eligibility.
   */
  staleReason: string | null;
}

/** A staged recipe in the curated Egyptian registry (`data/staging/recipes.json`). */
export interface StagedRecipe {
  recipeId: string;
  names: RecipeNames;
  category: string | null;
  subcategory: string | null;
  region: string | null;
  yield: RecipeYield;
  source: RecipeSourceRef;
  license: RecordLicense;
  verificationStatus: RecipeVerificationStatus;
  review: StagedRecipeReview;
  /** Record schema version. */
  version: string;
  /** Original source row preserved verbatim (header -> raw value). */
  original: Record<string, unknown>;
  originalTitle: string | null;
  /** Evidence / derivation notes recorded by the pipeline or reviewers. */
  notes: string[];
  /**
   * Deterministic fingerprint of the canonical imported source row that this
   * record was built / reviewed from. Always set by the pipeline.
   */
  sourceFingerprint: string | null;
}

const RECIPE_ID_RE = /^EGR-[0-9A-F]{16}$/;

/**
 * Deterministic stable recipe ID derived from the source identity: the source
 * file (relative path), the row number inside it, and the normalized title.
 * Stable across runs and machine-independent; never random.
 */
export function generateStableRecipeId(sourceFile: string, sourceRow: number | null, title: string): string {
  const key = `${sourceFile}|${sourceRow ?? "?"}|${normalizeTerm(title)}`;
  const digest = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16).toUpperCase();
  return `${RECIPE_ID_PREFIX}${digest}`;
}

/** Columns that define the "canonical" source row identity for drift detection. */
const CANONICAL_FINGERPRINT_COLUMNS = [
  "recipe_title",
  "description",
  "category",
  "subcategory",
  "cuisine_list",
  "main_ingredient",
  "ingredients",
  "ingredients_canonical",
  "directions",
] as const;

/**
 * Deterministic fingerprint of a canonical imported source row. Only canonical
 * columns are hashed so cosmetic edits to other columns do not trigger a false
 * source-drift flag.
 */
export function computeRowFingerprint(sourceFile: string, sourceRow: number, headers: string[], row: string[]): string {
  const cols: Record<string, string> = {};
  for (const name of CANONICAL_FINGERPRINT_COLUMNS) {
    const i = headers.indexOf(name);
    cols[name] = (i === -1 ? "" : (row[i] ?? "")).trim();
  }
  const key = JSON.stringify({ sourceFile, sourceRow, cols });
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function isBlank(value: string): boolean {
  return value.trim() === "";
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function trimmedEvidenceIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((v): v is string => typeof v === "string").map((s) => s.trim()).filter((s) => s !== "");
}

function sameStringSet(a: string[], b: string[]): boolean {
  const as = [...a.map((s) => s.trim()).filter((s) => s !== "")].sort();
  const bs = [...b.map((s) => s.trim()).filter((s) => s !== "")].sort();
  return as.length === bs.length && as.every((s, i) => s === bs[i]);
}

/** The evidence scope the recipe contributes: normalized title(s) + documented aliases. */
function recipeEvidenceTexts(recipe: StagedRecipe): string[] {
  const texts: string[] = [];
  for (const t of [recipe.originalTitle, recipe.names?.en, recipe.names?.ar, recipe.names?.eg]) {
    if (typeof t === "string" && t.trim() !== "") texts.push(t);
  }
  if (Array.isArray(recipe.names?.aliases)) {
    texts.push(...recipe.names.aliases.filter((a): a is string => typeof a === "string"));
  }
  return texts.map(normalizeTerm).filter((s) => s !== "");
}

/** True when at least one `applicableTo` scope matches the recipe's title/aliases at token boundaries. */
export function evidenceScopeMatches(recipe: StagedRecipe, applicableTo: string[]): boolean {
  const texts = recipeEvidenceTexts(recipe);
  if (texts.length === 0) return false;
  for (const scope of applicableTo) {
    const norm = normalizeTerm(scope);
    if (norm === "") continue;
    for (const text of texts) {
      if (containsAtTokenBoundary(text, norm)) return true;
    }
  }
  return false;
}

/**
 * Shared evidence-reference check used by `applyReviewDecision`,
 * `validateStagedRecipe`, and the eligibility gate (consistent rules).
 * Valid when: a valid http(s) URL, or the ID of a manifest record whose purpose
 * is `egyptian_recipe_cultural_evidence` and whose `applicableTo` scope matches
 * the recipe's normalized title / aliases. Guideline-provenance, wrong-dish,
 * unknown, malformed, and blank-after-trim IDs are rejected.
 */
export function checkEvidenceReference(
  recipe: StagedRecipe,
  value: string,
  manifest: Manifest
): { valid: boolean; reason: string | null } {
  const trimmed = value.trim();
  if (trimmed === "") return { valid: false, reason: "evidence reference is blank after trimming" };
  // Detect URL-like patterns (any scheme) and enforce http(s) only
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    if (/^https?:\/\//i.test(trimmed)) {
      if (isValidHttpUrlString(trimmed)) return { valid: true, reason: null };
      return { valid: false, reason: "evidence URL is not a valid http(s) URL" };
    }
    return { valid: false, reason: "evidence URL is not a valid http(s) URL" };
  }
  const key = trimmed.toLowerCase();
  const rec = manifest.evidenceReferences.find((e) => e.id.trim().toLowerCase() === key);
  if (!rec) return { valid: false, reason: "evidence id not found in data/manifest/sources.json" };
  if (rec.purpose.trim().toLowerCase() !== CULTURAL_EVIDENCE_PURPOSE) {
    return { valid: false, reason: `evidence id is not cultural evidence (purpose="${rec.purpose}")` };
  }
  if (!Array.isArray(rec.applicableTo) || rec.applicableTo.length === 0) {
    return { valid: false, reason: "evidence record has no applicableTo scope" };
  }
  if (!evidenceScopeMatches(recipe, rec.applicableTo)) {
    return { valid: false, reason: "cultural evidence not applicable to this recipe (scope mismatch)" };
  }
  return { valid: true, reason: null };
}

/** Latest human decision event in the timeline (newest `human_*` entry), or null. */
export function latestHumanEvent(review: StagedRecipeReview): RecipeReviewTrace | null {
  if (!Array.isArray(review?.timeline)) return null;
  for (let i = review.timeline.length - 1; i >= 0; i -= 1) {
    const t = review.timeline[i];
    if (asRecord(t) !== null && typeof (t as RecipeReviewTrace).action === "string") {
      if ((t as RecipeReviewTrace).action.startsWith("human_")) return t as RecipeReviewTrace;
    }
  }
  return null;
}

/** Consensus: the latest human event must agree with the current record state. */
function checkHumanEventAgreement(recipe: StagedRecipe, review: StagedRecipeReview): string[] {
  const issues: string[] = [];
  const human = latestHumanEvent(review);
  if (human === null) {
    issues.push(`record is ${recipe.verificationStatus} but its timeline has no human decision event`);
    return issues;
  }
  if (human.at !== review.reviewDate) issues.push("latest human event date (at) does not match review.reviewDate");
  if (human.actor !== (review.reviewerId ?? "").trim()) issues.push("latest human event actor does not match review.reviewerId");
  if (human.status !== recipe.verificationStatus) issues.push("latest human event status does not match verificationStatus");
  if (human.note.trim() !== (review.rationale ?? "").trim()) issues.push("latest human event note does not match review.rationale");
  if (!sameStringSet(trimmedEvidenceIds(human.evidenceIds), trimmedEvidenceIds(review.evidenceIds))) {
    issues.push("latest human event evidence IDs do not match review.evidenceIds");
  }
  if (recipe.verificationStatus === "verified" && trimmedEvidenceIds(human.evidenceIds).length === 0) {
    issues.push("human_verified event must record the evidence IDs used");
  }
  return issues;
}

/**
 * Strict per-record validation. Always returns issue strings (never throws):
 * malformed registry objects produce validation issues, not runtime exceptions.
 * `manifest` is required so evidence + license/provenance rules are consistent
 * with `applyReviewDecision` and the eligibility gate.
 */
export function validateStagedRecipe(recipe: StagedRecipe, manifest: Manifest): string[] {
  try {
    return validateStagedRecipeInternal(recipe, manifest);
  } catch (err) {
    return [`malformed recipe record: ${err instanceof Error ? err.message : String(err)}`];
  }
}

function validateStagedRecipeInternal(recipe: StagedRecipe, manifest: Manifest): string[] {
  const issues: string[] = [];

  if (!asRecord(recipe)) {
    issues.push("recipe record must be an object");
    return issues;
  }

  if (typeof recipe.recipeId !== "string" || !RECIPE_ID_RE.test(recipe.recipeId)) {
    issues.push(`recipeId "${String((recipe as unknown as Record<string, unknown>).recipeId)}" does not match ${RECIPE_ID_RE.toString()}`);
  }

  const names = asRecord(recipe.names) ?? {};
  for (const key of ["ar", "en", "eg"] as const) {
    const v = (names as Record<string, unknown>)[key];
    if (v !== null && v !== undefined) {
      if (typeof v !== "string") issues.push(`names.${key} must be a string or null`);
      else if (isBlank(v)) issues.push(`names.${key} must be non-empty when present`);
      else if (detectMojibake(v).detected) issues.push(`names.${key} contains mojibake/corrupted encoding`);
    }
  }
  if (!Array.isArray(names.aliases) || names.aliases.some((a) => typeof a !== "string" || isBlank(a))) {
    issues.push("names.aliases must be an array of non-empty strings");
  }

  for (const key of ["category", "subcategory", "region"] as const) {
    const v = (recipe as unknown as Record<string, unknown>)[key];
    if (v !== null && v !== undefined) {
      if (typeof v !== "string" || isBlank(v)) issues.push(`${key} must be a non-empty string or null`);
    }
  }

  const yieldRec = asRecord(recipe.yield) ?? {};
  for (const key of ["servings", "finalCookedWeightG"] as const) {
    const v = (yieldRec as Record<string, unknown>)[key];
    if (v !== null && v !== undefined && (typeof v !== "number" || !isPositiveFinite(v))) {
      issues.push(`yield.${key} must be a positive number or null (never 0)`);
    }
  }

  const source = asRecord(recipe.source) ?? {};
  if (!isNonBlankString(source.sourceId)) issues.push("missing source reference: source.sourceId is required");
  if (!isNonBlankString(source.sourceFile)) issues.push("missing source reference: source.sourceFile is required");
  if (source.sourceRow !== null && source.sourceRow !== undefined && (typeof source.sourceRow !== "number" || !Number.isInteger(source.sourceRow) || source.sourceRow < 1)) {
    issues.push("source.sourceRow must be a positive integer or null");
  }
  if (source.sourceVersion !== null && source.sourceVersion !== undefined && !isNonBlankString(source.sourceVersion)) {
    issues.push("source.sourceVersion must be a non-empty string or null");
  }
  if (source.accessDate !== null && source.accessDate !== undefined && !isValidIsoDate(String(source.accessDate))) {
    issues.push(`source.accessDate "${String(source.accessDate)}" is not a strict ISO date`);
  }
  if (source.url !== null && source.url !== undefined && !isNonBlankString(source.url)) {
    issues.push("source.url must be a non-empty string (pointer) or null");
  }

  const license = asRecord(recipe.license) ?? {};
  if (!RECIPE_LICENSE_STATUSES.includes(license.status as RecipeLicenseStatus)) {
    issues.push(`license.status "${String(license.status)}" is invalid`);
  }
  if (license.status === "approved") {
    // Approval must be backed by documented identity/terms + a URL/pointer plus
    // manifest approval metadata. A hand-written status is NOT sufficient.
    if (!isNonBlankString(license.id)) issues.push("license.status=approved requires a documented license identity (license.id)");
    if (!(typeof license.url === "string" && isValidHttpUrlString(license.url))) {
      issues.push("license.status=approved requires a documented license pointer (license.url http(s))");
    }
    const sourceRecord = sourceRecordForSourceId(manifest, recipe.source.sourceId, recipe.source.sourceFile);
    if (sourceRecord === null) {
      issues.push("license.status=approved is not backed by any source record in data/manifest/sources.json");
    } else if (!isLicenseApprovedByManifest(sourceRecord)) {
      issues.push("license.status=approved but the data/manifest/sources.json license review is not approved (identity/url/approval metadata)");
    }
  }

  if (!RECIPE_VERIFICATION_STATUSES.includes(recipe.verificationStatus)) {
    issues.push(`verificationStatus "${String(recipe.verificationStatus)}" is invalid`);
  }

  if (!isNonBlankString(recipe.version)) issues.push("recipe version is required");
  if (recipe.original === null || recipe.original === undefined) {
    issues.push("original source values are required (the imported row must be preserved as an object)");
  } else if (typeof recipe.original !== "object" || Array.isArray(recipe.original)) {
    issues.push("original source values must be preserved as an object");
  }

  if ((recipe.sourceFingerprint ?? "") === "") {
    issues.push("sourceFingerprint is required (the canonical source row snapshot)");
  } else if (!isNonBlankString(recipe.sourceFingerprint)) {
    issues.push("sourceFingerprint must be a non-empty string");
  }

  const review = asRecord(recipe.review) ?? {};
  if (!RECIPE_REVIEW_DECISIONS.includes(review.decision as RecipeReviewDecision)) {
    issues.push(`review.decision "${String(review.decision)}" is invalid`);
  }
  if (review.decision === "verified" && recipe.verificationStatus !== "verified") {
    issues.push("review.decision=verified requires verificationStatus=verified");
  }
  if (review.decision === "rejected" && recipe.verificationStatus !== "rejected") {
    issues.push("review.decision=rejected requires verificationStatus=rejected");
  }
  if (review.decision === "unreviewed" && recipe.verificationStatus !== "needs_review") {
    issues.push("review.decision=unreviewed requires verificationStatus=needs_review");
  }

  if (typeof review.autoRejected !== "boolean") issues.push("review.autoRejected must be a boolean");
  if (review.autoRejected === true && recipe.verificationStatus !== "rejected") {
    issues.push("review.autoRejected only applies to rejected records");
  }
  if (review.autoRejected === true && recipe.verificationStatus === "verified") {
    issues.push("verified records cannot be auto-rejected");
  }

  if (!Array.isArray(review.evidenceIds)) {
    issues.push("review.evidenceIds must be an array");
  } else if (review.evidenceIds.some((e) => !isNonBlankString(e))) {
    issues.push("review.evidenceIds must contain only non-blank strings (trim before checking)");
  }
  const trimmedEvidence = trimmedEvidenceIds(review.evidenceIds);

  if (review.rationale !== null && review.rationale !== undefined && !isNonBlankString(review.rationale)) {
    issues.push("review.rationale must be a non-empty string or null");
  }

  if (review.snapshotFingerprint !== null && review.snapshotFingerprint !== undefined && !isNonBlankString(review.snapshotFingerprint)) {
    issues.push("review.snapshotFingerprint must be a non-empty string or null");
  }
  if (review.staleReason !== null && review.staleReason !== undefined && !isNonBlankString(review.staleReason)) {
    issues.push("review.staleReason must be a non-empty string or null");
  }

  const hasSnapshotValue = review.snapshotFingerprint !== null && review.snapshotFingerprint !== undefined;

  const timeline = Array.isArray(review.timeline) ? review.timeline : null;
  let sawDriftEvent = false;
  if (timeline === null || timeline.length === 0) {
    issues.push("review.timeline must be a non-empty array of append-only events");
  } else {
    for (let i = 0; i < timeline.length; i += 1) {
      const t = timeline[i];
      const entry = asRecord(t);
      if (entry === null) {
        issues.push(`timeline[${i}] must be an object`);
        continue;
      }
      const ev = t as RecipeReviewTrace;
      const isHuman = typeof ev.action === "string" && ev.action.startsWith("human_");
      if (ev.at === null) {
        if (isHuman) issues.push(`timeline[${i}] human event must carry a strict ISO date`);
      } else if (typeof ev.at !== "string" || !isValidIsoDate(ev.at)) {
        issues.push(`timeline[${i}] has invalid at "${String(ev.at)}" (null or strict ISO date)`);
      } else if (!isHuman) {
        issues.push(`timeline[${i}] pipeline events must use at=null (deterministic output)`);
      }
      if (typeof ev.actor !== "string" || isBlank(ev.actor)) issues.push(`timeline[${i}] lacks actor`);
      if (typeof ev.action !== "string" || isBlank(ev.action)) issues.push(`timeline[${i}] lacks action`);
      if (!RECIPE_VERIFICATION_STATUSES.includes(ev.status)) issues.push(`timeline[${i}] has invalid status "${String(ev.status)}"`);
      if (typeof ev.note !== "string" || isBlank(ev.note)) issues.push(`timeline[${i}] note must be non-empty`);
      if (!Array.isArray(ev.evidenceIds) || ev.evidenceIds.some((e) => typeof e !== "string" || isBlank(e))) {
        issues.push(`timeline[${i}] evidenceIds must be an array of non-blank strings`);
      }
      if (isHuman && ev.action === "human_verified" && trimmedEvidenceIds(ev.evidenceIds).length === 0) {
        issues.push(`timeline[${i}] human_verified event must record the evidence IDs used`);
      }
      if (ev.action === "source_drift_detected") sawDriftEvent = true;
    }
  }

  // ---- status-specific rules (mirror applyReviewDecision + the gate).
  if (recipe.verificationStatus === "verified") {
    if (isBlank(String(review.reviewerId ?? ""))) issues.push("unverifiable: verified recipe lacks reviewerId (human reviewer identity)");
    if (!isValidIsoDate(String(review.reviewDate ?? ""))) issues.push("unverifiable: verified recipe lacks a strict ISO reviewDate");
    if (trimmedEvidence.length === 0) {
      issues.push("unverifiable: verified recipe lacks documented evidence references");
    } else {
      for (const ev of trimmedEvidence) {
        const chk = checkEvidenceReference(recipe, ev, manifest);
        if (!chk.valid) issues.push(`evidence "${ev}": ${chk.reason}`);
      }
      if (trimmedEvidence.some((e) => /^https?:\/\//i.test(e)) && (review.rationale === null || isBlank(String(review.rationale)))) {
        issues.push("unverifiable: URL evidence references require a non-empty rationale describing the evidence path");
      }
    }
    if (review.rationale === null || isBlank(String(review.rationale))) {
      issues.push("unverifiable: verified recipe requires a non-empty rationale/evidence description");
    }
    if (review.autoRejected === true) issues.push("unverifiable: verified record cannot be auto-rejected");
    if (!hasSnapshotValue) issues.push("unverifiable: reviewed record lacks the reviewed source snapshot (review.snapshotFingerprint)");
    if (isNonBlankString(review.staleReason)) issues.push("verified record is stale (source drift); eligibility blocked until re-reviewed");
    issues.push(...checkHumanEventAgreement(recipe, review as unknown as StagedRecipeReview));
  } else if (recipe.verificationStatus === "rejected") {
    if (review.autoRejected === true) {
      if (hasSnapshotValue) issues.push("auto-rejected record must not carry a reviewed snapshot");
      if (latestHumanEvent(review as unknown as StagedRecipeReview) !== null) {
        issues.push("auto-rejected record must not contain human decision events");
      }
    } else {
      if (isBlank(String(review.reviewerId ?? ""))) issues.push("rejected recipe (human verdict) lacks reviewerId");
      if (!isValidIsoDate(String(review.reviewDate ?? ""))) issues.push("rejected recipe (human verdict) lacks a strict ISO reviewDate");
      if (review.rationale === null || isBlank(String(review.rationale))) {
        issues.push("human rejection requires explicit non-empty rejection reasons (review.rationale)");
      }
      if (!hasSnapshotValue) issues.push("human-rejected record lacks the reviewed source snapshot (review.snapshotFingerprint)");
      issues.push(...checkHumanEventAgreement(recipe, review as unknown as StagedRecipeReview));
    }
  } else {
    // needs_review
    if (isNonBlankString(review.staleReason)) {
      if (review.decision !== "unreviewed") issues.push("stale record must be routed back to unreviewed (needs_review)");
      if (review.reviewerId !== null || review.reviewDate !== null || review.rationale !== null || trimmedEvidence.length !== 0) {
        issues.push("stale record must be routed back to review with cleared decision fields");
      }
      if (!sawDriftEvent) issues.push("stale record lacks the source_drift_detected timeline event");
    } else if (latestHumanEvent(review as unknown as StagedRecipeReview) !== null) {
      issues.push("needs_review record contains a human decision event without a matching verified/rejected status");
    }
  }

  return issues;
}

export interface RegistryValidation {
  duplicateIds: string[];
  issues: Array<{ recipeId: string; issues: string[] }>;
  valid: boolean;
}

/**
 * Registry-level validation: duplicates + per-record issues. Defensive: entries
 * that are not objects produce a validation issue instead of crashing.
 */
export function validateStagingRegistry(recipes: readonly unknown[], manifest: Manifest): RegistryValidation {
  const entries: Array<{ key: string; recipe: StagedRecipe | null }> = [];
  for (const raw of recipes) {
    const rec = asRecord(raw) ? (raw as StagedRecipe) : null;
    if (rec === null) {
      entries.push({ key: "(non-object)", recipe: null });
      continue;
    }
    entries.push({ key: rec.recipeId, recipe: rec });
  }

  const seen = new Map<string, number>();
  for (const e of entries) {
    if (e.recipe === null) continue;
    seen.set(e.recipe.recipeId, (seen.get(e.recipe.recipeId) ?? 0) + 1);
  }
  const duplicateIds = [...seen.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id)
    .sort();

  const issues: Array<{ recipeId: string; issues: string[] }> = [];
  for (const e of entries) {
    if (e.recipe === null) {
      issues.push({ recipeId: e.key, issues: ["malformed registry entry: not a recipe object"] });
    } else {
      const recIssues = validateStagedRecipe(e.recipe, manifest);
      if (recIssues.length > 0) issues.push({ recipeId: e.recipe.recipeId, issues: recIssues });
    }
  }
  return { duplicateIds, issues, valid: duplicateIds.length === 0 && issues.length === 0 };
}

export interface EligibilityResult {
  eligible: boolean;
  blockers: string[];
}

/**
 * The verified-MVP gate. Structural validity is a precondition â€” a record with
 * ANY validation issue is never eligible. Beyond that the gate requires:
 *  - human verification (reviewer + strict ISO date + evidence + rationale);
 *  - a reviewed source snapshot with no stale/source-drift flag;
 *  - complete provenance: sourceId + sourceVersion + strict ISO accessDate,
 *    backed by an approved source record in the manifest;
 *  - license approval backed by the manifest (identity/url + approval metadata).
 * Unreviewed/pending records are never eligible; automation cannot self-verify.
 */
export function isEligibleForVerifiedDataset(recipe: StagedRecipe, manifest: Manifest): EligibilityResult {
  const structural = validateStagedRecipe(recipe, manifest);
  if (structural.length > 0) {
    return { eligible: false, blockers: structural };
  }

  const blockers: string[] = [];
  if (recipe.verificationStatus !== "verified") {
    blockers.push("verificationStatus is not verified (automation never verifies)");
  } else {
    if (recipe.review.decision !== "verified") blockers.push("review decision is not verified");
    if (recipe.review.staleReason !== null && recipe.review.staleReason !== undefined) {
      blockers.push(`record is stale (source drift): ${recipe.review.staleReason}`);
    }

    const source = recipe.source;
    if (isBlank(source.sourceId)) blockers.push("missing sourceId");
    if (isBlank(source.sourceVersion ?? "")) blockers.push("missing sourceVersion (provenance incomplete)");
    if (!isValidIsoDate(String(source.accessDate ?? ""))) blockers.push("missing strict ISO accessDate (provenance)");

    const sourceRecord = sourceRecordForSourceId(manifest, source.sourceId, source.sourceFile);
    if (sourceRecord === null) {
      blockers.push("no source record in data/manifest/sources.json for this source (provenance review incomplete)");
    } else if (!isSourceRecordApproved(sourceRecord)) {
      blockers.push("source record is not provenance-approved in data/manifest/sources.json (needs review_status=approved + reviewer + ISO date)");
    }

    if (recipe.license.status !== "approved") {
      blockers.push(`license not approved (status=${recipe.license.status})`);
    } else if (sourceRecord === null || !isLicenseApprovedByManifest(sourceRecord)) {
      blockers.push("license approval is not backed by data/manifest/sources.json (approved license identity/url/approval metadata)");
    }
  }
  return { eligible: blockers.length === 0, blockers };
}

export interface ReviewDecisionInput {
  decision: "verified" | "rejected";
  reviewerId: string;
  reviewDate: string;
  evidenceIds: string[];
  rationale: string;
}

/**
 * Record a HUMAN review decision â€” the only way a record can become
 * `verified` programmatically. Applies the SAME evidence rules as validation
 * and the gate: evidence must resolve against the manifest (or a valid
 * http(s) URL), and every decision (including rejections) needs non-empty
 * rationale/rejection reasons. The reviewed row fingerprint is captured as
 * `review.snapshotFingerprint` (source-drift protection). The event is appended
 * to the timeline; nothing is overwritten or deleted.
 */
export function applyReviewDecision(
  recipe: StagedRecipe,
  input: ReviewDecisionInput,
  manifest: Manifest
): { ok: true; recipe: StagedRecipe } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (isBlank(input.reviewerId)) errors.push("reviewerId is required");
  if (!isValidIsoDate(input.reviewDate)) errors.push("reviewDate must be a strict ISO date (YYYY-MM-DD)");
  if (isBlank(input.rationale)) {
    errors.push(
      input.decision === "rejected"
        ? "rejection requires explicit non-empty rejection reasons"
        : "verification requires a non-empty rationale/evidence description"
    );
  }
  const cleanedEvidence = trimmedEvidenceIds(input.evidenceIds);
  if (input.decision === "verified") {
    if (cleanedEvidence.length === 0) {
      errors.push("verified decisions require documented evidence references");
    } else {
      for (const ev of cleanedEvidence) {
        const chk = checkEvidenceReference(recipe, ev, manifest);
        if (!chk.valid) errors.push(`evidence "${ev}": ${chk.reason}`);
      }
    }
  }
  if (!isNonBlankString(recipe.sourceFingerprint)) {
    errors.push("recipe has no sourceFingerprint; cannot bind the review to a reviewed source snapshot");
  }
  if (errors.length > 0) return { ok: false, errors };

  const trace: RecipeReviewTrace = {
    at: input.reviewDate,
    actor: input.reviewerId.trim(),
    action: input.decision === "verified" ? "human_verified" : "human_rejected",
    status: input.decision,
    note: input.rationale.trim(),
    evidenceIds: [...new Set(cleanedEvidence)],
  };
  return {
    ok: true,
    recipe: {
      ...recipe,
      verificationStatus: input.decision,
      review: {
        ...recipe.review,
        decision: input.decision,
        reviewerId: input.reviewerId.trim(),
        reviewDate: input.reviewDate,
        evidenceIds: [...new Set(cleanedEvidence)],
        rationale: input.rationale.trim(),
        autoRejected: false,
        snapshotFingerprint: recipe.sourceFingerprint,
        staleReason: null,
        timeline: [...recipe.review.timeline, trace],
      },
    },
  };
}
