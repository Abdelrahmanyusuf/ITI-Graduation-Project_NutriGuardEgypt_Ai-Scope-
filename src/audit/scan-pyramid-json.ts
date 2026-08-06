/**
 * Food pyramid JSON scanner.
 * Validates required fields/types, missing values, duplicate category keys,
 * encoding noise, and provenance gaps.
 */

import type { SourceAudit } from "./types.js";

export interface PyramidJsonScanOptions {
  relativePath: string;
  bytes: Uint8Array;
}

/** Required top-level/entry fields for a nutrition-guidance pyramid source. */
const REQUIRED_ENTRY_FIELDS = [
  "layer",
  "category",
  "recommended_servings",
  "description",
];

export function scanPyramidJson(options: PyramidJsonScanOptions): SourceAudit {
  const { relativePath, bytes } = options;
  const structuralErrors: string[] = [];
  const encodingIssues: string[] = [];
  let validUtf8 = true;

  let text = "";
  try {
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const start = bom ? 3 : 0;
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(start));
  } catch {
    validUtf8 = false;
    encodingIssues.push("invalid UTF-8 (decoded with replacement for analysis)");
    text = new TextDecoder("utf-8").decode(bytes);
  }

  const duplicateCategories: Array<{ key: string; count: number }> = [];
  const encodingNoise: string[] = [];
  let rows = 0;

  try {
    const parsed: unknown = JSON.parse(text);

    // Determine the entry list from the root, converting schema violations
    // (scalar root, invalid/non-array `layers`, non-object entries) into
    // structural errors rather than silently dropping them.
    let arr: unknown[];
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (parsed !== null && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      if ("layers" in rec) {
        if (Array.isArray(rec.layers)) {
          arr = rec.layers;
        } else {
          structuralErrors.push(`'layers' must be an array (found ${rec.layers === null ? "null" : typeof rec.layers})`);
          arr = [];
        }
      } else if ("category" in rec || "layer" in rec) {
        arr = [rec]; // legacy single-record root object
      } else {
        structuralErrors.push("root object has neither a 'layers' array nor a single record");
        arr = [];
      }
    } else {
      structuralErrors.push(
        `root must be an array or object (found ${parsed === null ? "null" : typeof parsed})`
      );
      arr = [];
    }

    const entries: Array<Record<string, unknown>> = [];
    for (const e of arr) {
      if (e !== null && typeof e === "object" && !Array.isArray(e)) {
        entries.push(e as Record<string, unknown>);
      } else {
        structuralErrors.push(
          `entry is not an object (found ${e === null ? "null" : Array.isArray(e) ? "array" : typeof e})`
        );
      }
    }
    rows = entries.length;

    const categoryKey = new Map<string, number>();
    for (const entry of entries) {
      for (const field of REQUIRED_ENTRY_FIELDS) {
        const has = Object.prototype.hasOwnProperty.call(entry, field);
        const v = entry[field];
        const isMissing = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
        if (!has) {
          structuralErrors.push(`entry missing required field '${field}'`);
        } else if (isMissing) {
          structuralErrors.push(`entry field '${field}' is empty/null`);
        } else if (typeof v !== "string" && typeof v !== "number") {
          structuralErrors.push(`entry field '${field}' has invalid type ${typeof v}`);
        }
        if (field === "category" && v !== undefined && v !== null) {
          const cat = String(v).trim();
          if (cat !== "") {
            categoryKey.set(cat, (categoryKey.get(cat) ?? 0) + 1);
            if (typeof v !== "string") {
              encodingNoise.push(`category value is not a string (type ${typeof v})`);
            }
          }
        }
      }
    }
    for (const [key, count] of categoryKey) {
      if (count > 1) {
        duplicateCategories.push({ key, count });
        structuralErrors.push(`duplicate category '${key}' appears ${count} times`);
      }
    }
    duplicateCategories.sort((a, b) => a.key.localeCompare(b.key));
  } catch (err) {
    structuralErrors.push("JSON parse failed: " + (err instanceof Error ? err.message : String(err)));
  }

  // Encoding-noise probes on the raw text.
  let control = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if ((c >= 0 && c <= 8) || (c >= 11 && c <= 12) || (c >= 14 && c <= 31)) control += 1;
  }
  if (control > 0) encodingNoise.push(`${control} control character(s)`);
  if (text.includes("\uFFFD")) encodingNoise.push("replacement character U+FFFD");
  if (/Ã[\u0080-\u009F]|â€|Ã©|Ã¨/.test(text)) encodingNoise.push("latin1 mojibake sequences");

  return {
    kind: "food_pyramid",
    relativePath,
    format: "JSON",
    encoding: validUtf8 ? "UTF-8" : "invalid UTF-8",
    bytes: bytes.length,
    docCount: rows,
    columnCount: 0,
    columns: [],
    duplicates: {
      byKey: "category (duplicate category keys across entries)",
      groups: duplicateCategories.map((g) => ({ key: g.key, count: g.count, rows: [] })),
      duplicateRowCount: duplicateCategories.reduce((s, g) => s + g.count - 1, 0),
    },
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
      fieldNames: ["layer", "category"],
      note: "the pyramid has a generic/unknown provenance; Egyptian/WHO endorsement not established",
    },
    guidelineCoverage: null,
    ocrOrExtractionNoise: {
      detected: encodingNoise.length > 0,
      kinds: encodingNoise,
      samples: encodingNoise.slice(0, 6),
    },
    nutrition: null,
    licensing: {
      hasLicenseFields: false,
      candidateFields: ["layer", "category", "description", "recommended_servings"],
      note: "no license field; pyramid provenance is unverified and not approved",
    },
    mojibake: { detected: encodingNoise.length > 0, kinds: encodingNoise, examples: encodingNoise.slice(0, 4) },
    encodingIssues,
    structuralErrors,
  };
}
