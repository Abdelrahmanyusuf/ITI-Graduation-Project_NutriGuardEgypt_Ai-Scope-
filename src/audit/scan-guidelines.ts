/**
 * Guidelines PDF scanner.
 *
 * Uses the in-repo minimal PDF parser (`pdf.ts`) to report page count, and
 * derives WHO identity / title / visible date ONLY from actual extracted
 * content or an explicit provenance record passed in options. Nothing WHO is
 * hardcoded: if the extracted text does not contain valid WHO evidence and no
 * explicit provenance record is supplied, the source stays unidentified
 * (`provenanceStatus = unknown`, `visibleSource = null`).
 *
 * Notes are generated only from findings actually detected in the file; the
 * extraction note always agrees with the `extractionAvailable` field.
 */

import { parsePdf } from "./pdf.js";
import { detectNoise, normalizeTerm } from "./text.js";
import type { GuidelineCoverage, SourceAudit } from "./types.js";

export interface GuidelineScanOptions {
  relativePath: string;
  bytes: Uint8Array;
  /** Explicit provenance record (e.g. from a curated manifest). Not guessed. */
  provenance?: { source?: string; title?: string; date?: string };
}

/** WHO-signalling phrases detected verbatim in extracted content. */
const WHO_CONTENT_PATTERNS: RegExp[] = [
  /\bworld health organization\b/i,
  /\bworld health organisation\b/i,
  /\bworld health[-\s]day\b/i,
  /\bWHO\b/,
];

/** Detect WHO evidence from actual extracted text. Returns matched signals. */
function detectWhoFromContent(text: string): string[] {
  const hits: string[] = [];
  for (const p of WHO_CONTENT_PATTERNS) {
    const m = p.exec(text);
    if (m) hits.push(m[0]);
  }
  return hits;
}

const DATE_RE =
  /\b\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i;

/** Match a visible date (day month year or month year) from extracted content. */
function findDate(text: string): string | null {
  const m = DATE_RE.exec(text);
  return m ? m[0] : null;
}

/** Common short words that may legitimately be capitalized inside a title (never treated as OCR noise). */
const SHORT_SAFE = new Set([
  "the", "and", "an", "are", "but", "was", "had", "has", "you", "your", "can",
  "her", "his", "how", "its", "may", "new", "now", "old", "our", "out", "per",
  "she", "too", "two", "who", "why", "yet", "one", "any", "few", "off", "see",
  "let", "get", "put", "day", "way", "man", "men", "boy", "ask", "run", "big",
  "own", "far", "low", "top", "did", "say", "got", "use", "try", "add", "cut",
  "mix", "oil", "egg",
]);

/**
 * True when a Title-case token is itself a garbled fragment of the WHO name
 * "World Health Organization" (e.g. "health", "wey"/"viyanization" for
 * "organization"). The clean tokens "world"/"health"/"organization" themselves
 * are NOT fragments — a verbatim clean phrase is handled separately.
 */
function isOrgNameFragment(token: string): boolean {
  const t = normalizeTerm(token);
  if (t === "organization" || t === "organisation" || t === "world" || t === "health") return false;
  return t.startsWith("org") || t.endsWith("nization") || t.endsWith("zation");
}

/** A very short token (2-3 chars) that is not a common word — likely OCR junk such as "wey"/"rid". */
function isUnsafeShort(token: string): boolean {
  const t = normalizeTerm(token);
  return t.length >= 2 && t.length <= 3 && !SHORT_SAFE.has(t);
}

interface TitleAndGarble {
  title: string | null;
  garbledRegion: string | null;
}

/**
 * Split the content immediately preceding a visible date into its clean suffix
 * (the document title, e.g. "Healthy diet") and the OCR-garbled region that
 * precedes it (e.g. "Donate rid Health wey viyanization"), when present. The
 * pre-date words are scanned right-to-left: clean words (not org-name fragments,
 * not unsafe short words) form the title; everything before them is the garbled
 * region. Nothing is derived when there is no date-anchored content.
 */
function deriveTitleAndGarble(text: string): TitleAndGarble {
  const dateM = DATE_RE.exec(text);
  if (!dateM) return { title: null, garbledRegion: null };
  const before = text.slice(0, dateM.index);
  const tokens = before.match(/[^\s]+/g) ?? [];
  if (tokens.length === 0) return { title: null, garbledRegion: null };

  let firstClean = tokens.length;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (isOrgNameFragment(tokens[i]) || isUnsafeShort(tokens[i])) break;
    firstClean = i;
  }
  if (firstClean >= tokens.length) return { title: null, garbledRegion: before.trim() };

  const title = tokens.slice(firstClean).join(" ").trim();
  const garbled = tokens.slice(0, firstClean).join(" ").trim();
  return {
    title: title === "" ? null : title,
    garbledRegion: garbled === "" ? null : garbled,
  };
}

/** True when a garbled region actually contains an org-name fragment or unsafe short token. */
function containsOrgSignal(region: string): boolean {
  return region.split(/\s+/).some((t) => isOrgNameFragment(t) || isUnsafeShort(t));
}

export function scanGuidelines(options: GuidelineScanOptions): SourceAudit {
  const { relativePath, bytes, provenance } = options;

  const structuralErrors: string[] = [];
  const parsed = parsePdf(bytes);
  if (parsed.errors.length > 0) {
    structuralErrors.push(...parsed.errors.map((e) => `PDF parser: ${e}`));
  }

  const whoFromContent = detectWhoFromContent(parsed.text);
  const explicitSource = provenance?.source?.trim();

  // Provenance is "identified" ONLY when actual evidence exists (content match
  // or explicit provenance record); otherwise unknown (parseable) or
  // not_assessed (unparseable).
  let provenanceStatus: GuidelineCoverage["provenanceStatus"];
  let visibleSource: string | null = null;
  if (whoFromContent.length > 0 || explicitSource) {
    provenanceStatus = "identified";
    visibleSource =
      explicitSource ??
      `World Health Organization (content match: ${whoFromContent.join(", ")})`;
  } else if (parsed.pageCount !== null || parsed.text !== "") {
    provenanceStatus = "unknown";
  } else {
    provenanceStatus = "not_assessed";
  }

  // visibleTitle is derived from the extracted content (the clean Title-case
  // phrase immediately before the visible date), NOT from claiming WHO identity
  // merely because the PDF has text. A provenance record/licensed title/PDF Info
  // title are only fall-backs.
  const fromContent = deriveTitleAndGarble(parsed.text);
  const visibleTitle = fromContent.title ?? provenance?.title?.trim() ?? parsed.info.title ?? null;
  const visibleDate = provenance?.date?.trim() ?? findDate(parsed.text);

  const extractionAvailable =
    parsed.text !== ""
      ? "yes"
      : parsed.pageCount !== null
        ? "no"
        : "not_assessed";

  // OCR/extraction noise: generic detectors always run. The WHO-name corruption
  // detector runs ONLY when a WHO identity is claimed (content match or explicit
  // provenance record) but the clean name is NOT present verbatim — its samples
  // report the actual garbled region from the extracted content.
  const whoClaimed =
    whoFromContent.length > 0 ||
    (explicitSource ? /\bwho\b|world health/i.test(explicitSource) : false) ||
    (provenance?.title ? /\bwho\b|world health/i.test(provenance.title) : false);
  const corruptedRegion =
    whoClaimed && whoFromContent.length === 0
      ? fromContent.garbledRegion && containsOrgSignal(fromContent.garbledRegion)
        ? fromContent.garbledRegion
        : null
      : null;

  const noise = detectNoise(parsed.text);
  const repeated = parsed.text.match(/(\b\w{1,4}\b)\s+\1\b/g);
  const kinds = [...noise.kinds];
  const samples = [...noise.samples];
  if (repeated && repeated.length > 0) {
    kinds.push("ocr_duplicated_phrase");
    samples.push(`repeated short phrase (sample: ${repeated.slice(0, 2).join(", ")})`);
  }
  if (corruptedRegion !== null) {
    kinds.push("ocr_corrupted_organization_name");
    samples.push(
      `garbled org-name region: "${corruptedRegion}" (near-match of "World Health Organization")`
    );
  }

  const notes: string[] = [];
  if (parsed.errors.length === 0) {
    notes.push("page count derived from the PDF page tree (incl. compressed object streams)");
  }
  notes.push(
    extractionAvailable === "yes"
      ? "text extraction available for the OCR layer"
      : extractionAvailable === "no"
        ? "text layer present but no extractable text"
        : "text layer not assessable"
  );
  if (provenanceStatus === "identified") {
    notes.push(`provenance identified: ${visibleSource ?? "WHO"}`);
  } else if (provenanceStatus === "unknown") {
    notes.push("no actual WHO/provenance evidence found in extracted content; source not identified");
  }
  if (whoFromContent.length > 0) {
    notes.push(`WHO detected in extracted content via: ${whoFromContent.join(", ")}`);
  }
  if (corruptedRegion !== null) {
    notes.push(
      `OCR-corrupted organization name detected in extracted content: "${corruptedRegion}" (near-match of "World Health Organization")`
    );
  }

  const guidelineCoverage: GuidelineCoverage = {
    pageCount: parsed.pageCount,
    visibleSource,
    visibleTitle,
    visibleDate,
    extractionAvailable,
    provenanceStatus,
    ocrNoiseDetected: kinds.length > 0,
    notes,
  };

  return {
    kind: "guidelines_pdf",
    relativePath,
    format: parsed.errors.length === 0 ? "PDF (binary)" : "PDF (parse issues)",
    encoding: "binary",
    bytes: bytes.length,
    docCount: 1,
    columnCount: 0,
    columns: [],
    duplicates: { byKey: "n/a (single binary file)", groups: [], duplicateRowCount: 0 },
    invalidNumerics: { count: 0, evidence: [] },
    suspiciousZeros: { count: 0, evidence: [] },
    zeroVsMissingConflation: { detected: false, columns: [] },
    leadingQuantityHeuristic: null,
    recognizedUnitHeuristic: null,
    canonicalQuantityParsingCoverage: null,
    canonicalIngredientLineMappingCoverage: null,
    servingYieldCoverage: null,
    foodStateCoverage: null,
    uniqueIngredientTerms: { count: 0, topTerms: [] },
    exactIngredientMatch: null,
    ambiguousMatches: [],
    egyptianScopeEvidence: {
      fieldNames: [],
      note: "guideline content is general nutrition guidance; Egyptian-scope not applicable to this source",
    },
    guidelineCoverage,
    ocrOrExtractionNoise: {
      detected: kinds.length > 0,
      kinds,
      samples: samples.slice(0, 8),
    },
    nutrition: null,
    licensing: {
      hasLicenseFields: false,
      candidateFields: [],
      note: "license metadata not discoverable; license not assessed",
    },
    mojibake: { detected: false, kinds: [], examples: [] },
    encodingIssues: [],
    structuralErrors,
  };
}