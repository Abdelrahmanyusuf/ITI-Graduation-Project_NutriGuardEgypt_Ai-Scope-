/**
 * Curated source manifest (`data/manifest/sources.json`) — Step 3.
 *
 * Typed parsing of the audit source manifest that drives BOTH the read-only
 * audit provenance/evidence resolution and the recipe staging registry's
 * provenance + license approvals. Nothing here fabricates approval: the
 * pipeline only ever *reads* these records and derives state from them.
 *
 * Required semantics used by the recipe gate:
 *  - A cultural-evidence reference (purpose `egyptian_recipe_cultural_evidence`)
 *    is only valid when it exists, and its `applicableTo` scope matches the
 *    recipe's normalized title / documented aliases.
 *  - A source record is "approved" only when `review_status` is `approved`,
 *    `reviewed_by` is populated and `review_date` is a strict ISO date.
 *  - License approval is backed by documented license identity (`license`),
 *    a URL/pointer (`license_url`) and license-specific approval metadata
 *    (`license_review_status`, `license_reviewed_by`, `license_review_date`).
 *    A hand-written `license.status = "approved"` on a recipe is NOT enough.
 */

import { isValidIsoDate } from "../audit/egyptian-evidence.js";

export const CULTURAL_EVIDENCE_PURPOSE = "egyptian_recipe_cultural_evidence";

export interface ManifestEvidenceRecord {
  id: string;
  purpose: string;
  applicableTo: string[];
}

export interface ManifestSourceRecord {
  /** Relative path of the source file, e.g. `data/raw/Recipes For Eqyption Food.csv`. */
  file: string | null;
  sourceId: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  title: string | null;
  visibleDate: string | null;
  sourceVersion: string | null;
  accessDate: string | null;
  /** License identity / terms, e.g. "CC BY 4.0". */
  license: string | null;
  licenseUrl: string | null;
  /** Provenance record review status: "pending" | "approved" | "rejected". */
  reviewStatus: string | null;
  reviewedBy: string | null;
  reviewDate: string | null;
  /** License-specific approval metadata (distinct from the source review). */
  licenseReviewStatus: string | null;
  licenseReviewedBy: string | null;
  licenseReviewDate: string | null;
  evidenceIds: string[];
}

export interface Manifest {
  schemaVersion: string | null;
  sources: ManifestSourceRecord[];
  evidenceReferences: ManifestEvidenceRecord[];
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").map((s) => s.trim()).filter((s) => s !== "");
}

function parseEvidence(ref: unknown): ManifestEvidenceRecord | null {
  if (typeof ref !== "object" || ref === null) return null;
  const r = ref as Record<string, unknown>;
  const id = asTrimmedString(r.id);
  if (!id) return null;
  return {
    id,
    purpose: asTrimmedString(r.purpose) ?? "guideline_provenance",
    applicableTo: asStringArray(r.applicableTo),
  };
}

function parseSource(raw: unknown): ManifestSourceRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  return {
    file: asTrimmedString(s.file),
    sourceId: asTrimmedString(s.source_id),
    sourceName: asTrimmedString(s.source_name),
    sourceUrl: asTrimmedString(s.source_url),
    title: asTrimmedString(s.title),
    visibleDate: asTrimmedString(s.visible_date),
    sourceVersion: asTrimmedString(s.source_version),
    accessDate: asTrimmedString(s.access_date),
    license: asTrimmedString(s.license),
    licenseUrl: asTrimmedString(s.license_url),
    reviewStatus: asTrimmedString(s.review_status),
    reviewedBy: asTrimmedString(s.reviewed_by),
    reviewDate: asTrimmedString(s.review_date),
    licenseReviewStatus: asTrimmedString(s.license_review_status),
    licenseReviewedBy: asTrimmedString(s.license_reviewed_by),
    licenseReviewDate: asTrimmedString(s.license_review_date),
    evidenceIds: asStringArray(s.evidence_ids),
  };
}

/** Parse the manifest JSON. Malformed JSON or a non-object root is a hard error. */
export function parseManifest(raw: string): Manifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("source manifest data/manifest/sources.json is not valid JSON");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("source manifest data/manifest/sources.json must be a JSON object");
  }
  const root = decoded as Record<string, unknown>;
  return {
    schemaVersion: asTrimmedString(root.schemaVersion),
    sources: Array.isArray(root.sources) ? root.sources.map(parseSource).filter((s): s is ManifestSourceRecord => s !== null) : [],
    evidenceReferences: Array.isArray(root.evidenceReferences)
      ? root.evidenceReferences.map(parseEvidence).filter((e): e is ManifestEvidenceRecord => e !== null)
      : [],
  };
}

/** Cultural evidence records (purpose = egyptian_recipe_cultural_evidence) for the audit classifier. */
export function culturalEvidenceRecords(manifest: Manifest): ManifestEvidenceRecord[] {
  return manifest.evidenceReferences.filter((e) => e.purpose.trim().toLowerCase() === CULTURAL_EVIDENCE_PURPOSE);
}

/**
 * Find the source record for a staged recipe's provenance. Match by the
 * manifest `file` path (equal to `source.sourceId`/`source.sourceFile`) or by
 * `source_id` equal to `source.sourceId`.
 */
export function sourceRecordForSourceId(manifest: Manifest, sourceId: string | null, sourceFile: string | null): ManifestSourceRecord | null {
  const id = (sourceId ?? "").trim();
  const file = (sourceFile ?? "").trim();
  for (const s of manifest.sources) {
    if (s.sourceId && s.sourceId.trim() === id) return s;
    if (s.file && s.file.trim() === id) return s;
    if (s.file && file !== "" && s.file.trim() === file) return s;
  }
  return null;
}

/** A source record counts as provenance-approved. */
export function isSourceRecordApproved(record: ManifestSourceRecord): boolean {
  return (
    (record.reviewStatus ?? "").trim().toLowerCase() === "approved" &&
    (record.reviewedBy ?? "") !== "" &&
    isValidIsoDate(record.reviewDate ?? "")
  );
}

/** License approval is only considered when it is backed by the manifest. */
export function isLicenseApprovedByManifest(record: ManifestSourceRecord): boolean {
  return (
    (record.license ?? "") !== "" &&
    isValidHttpUrl(record.licenseUrl ?? "") &&
    (record.licenseReviewStatus ?? "").trim().toLowerCase() === "approved" &&
    (record.licenseReviewedBy ?? "") !== "" &&
    isValidIsoDate(record.licenseReviewDate ?? "")
  );
}

function isValidHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

export function isValidHttpUrlString(value: string): boolean {
  return isValidHttpUrl(value);
}