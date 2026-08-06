/**
 * Food pyramid image scanner (18 JPEGs).
 * Binary format verification: SOI marker `FF D8 FF` plus at least one valid
 * marker (any marker segment, not specifically APP0/E0), EOF/truncation check,
 * and SHA-256 hashing so the runner can detect duplicate images across all 18.
 */

import { createHash } from "node:crypto";
import type { SourceAudit } from "./types.js";

const SOI = [0xff, 0xd8, 0xff];

/** JPEG marker codes that are valid (any marker, incl. APPn, DQT, SOF, DHT, DRI, SOS). */
const VALID_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf,
  0xdb, 0xdd, 0xdf, 0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
  0xea, 0xeb, 0xec, 0xed, 0xee, 0xef, 0xfe, 0x01, 0xda,
]);

/** Standalone markers that carry no 2-byte segment length (TEM + restart markers). */
const STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

export interface PyramidImageScanOptions {
  relativePath: string;
  bytes: Uint8Array;
}

/**
 * Walk the JPEG marker segment structure after the SOI. Returns structural
 * error strings for malformed segment lengths, stray bytes, truncation, and
 * data after EOI. This rejects fake/tiny files such as `FF D8 FF E0 FF D9`
 * (whose "segment length" would overrun the file end).
 */
function walkJpegSegments(bytes: Uint8Array): string[] {
  const errors: string[] = [];
  const len = bytes.length;
  let i = 2; // immediately after SOI (FF D8 FF)
  while (i < len) {
    if (bytes[i] !== 0xff) {
      errors.push(`stray byte 0x${(bytes[i] ?? 0).toString(16).padStart(2, "0")} between JPEG markers at offset ${i}`);
      return errors;
    }
    while (i < len && bytes[i] === 0xff) i += 1; // skip fill bytes
    if (i >= len) {
      errors.push("marker code missing after fill bytes (truncated)");
      return errors;
    }
    const code = bytes[i];
    i += 1;
    if (code === 0xd9) {
      // EOI: end of image
      if (i !== len) errors.push(`${len - i} byte(s) of data after EOI marker`);
      return errors;
    }
    if (STANDALONE_MARKERS.has(code)) continue;
    if (code === 0xda) {
      // SOS: entropy-coded data follows; scan for EOI
      let eoi = -1;
      for (let j = i; j + 1 < len; j += 1) {
        if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) {
          eoi = j;
          break;
        }
      }
      if (eoi === -1) errors.push("SOS segment without EOI marker (truncated or corrupt)");
      else if (eoi + 2 !== len) errors.push(`${len - (eoi + 2)} byte(s) of data after EOI marker`);
      return errors;
    }
    if (i + 1 >= len) {
      errors.push(`truncated segment length header for marker 0x${code.toString(16).padStart(2, "0")}`);
      return errors;
    }
    const segLen = (bytes[i] << 8) | bytes[i + 1];
    if (segLen < 2) {
      errors.push(`invalid segment length ${segLen} for marker 0x${code.toString(16).padStart(2, "0")}`);
      return errors;
    }
    if (i + segLen > len) {
      errors.push(`marker 0x${code.toString(16).padStart(2, "0")} segment overruns file end (truncated or fake header)`);
      return errors;
    }
    i += segLen;
  }
  return errors;
}

export function scanPyramidImage(options: PyramidImageScanOptions): SourceAudit {
  const { relativePath, bytes } = options;
  const structuralErrors: string[] = [];

  const magicOk = bytes.length >= 3 && bytes[0] === SOI[0] && bytes[1] === SOI[1] && bytes[2] === SOI[2];
  if (!magicOk) structuralErrors.push("not a JPEG (missing FF D8 FF SOI)");
  if (bytes.length === 0) structuralErrors.push("empty file");

  // Marker immediately following SOI: bytes are FF D8 FF <code> <len>... The
  // first marker code sits at index 3 directly after the leading FF (index 2).
  if (magicOk && bytes.length >= 4) {
    if (!VALID_MARKERS.has(bytes[3])) {
      structuralErrors.push(
        `invalid marker segment after SOI (code 0x${(bytes[3] ?? 0).toString(16).padStart(2, "0")})`
      );
    }
  }

  if (magicOk) {
    structuralErrors.push(...walkJpegSegments(bytes));
  }

  // EOF / truncation: a well-formed JPEG ends with EOI marker FF D9.
  const len = bytes.length;
  if (len > 0 && !(bytes[len - 2] === 0xff && bytes[len - 1] === 0xd9)) {
    structuralErrors.push("file does not end with EOI marker FF D9 (possible truncation or corrupt tail)");
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");

  return {
    kind: "food_pyramid_images",
    relativePath,
    format: magicOk ? "JPEG (binary)" : "unknown",
    encoding: "binary",
    bytes: bytes.length,
    docCount: 1,
    columnCount: 0,
    columns: [],
    duplicates: { byKey: "sha256 (computed by runner across all 18 images)", groups: [], duplicateRowCount: 0 },
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
      note: "image content not OCR'd in this audit pass",
    },
    guidelineCoverage: null,
    ocrOrExtractionNoise: {
      detected: false,
      kinds: [],
      samples: [],
    },
    nutrition: null,
    provenance: {
      sha256,
      byteSize: bytes.length,
    },
    licensing: {
      hasLicenseFields: false,
      candidateFields: [],
      note: "no license metadata discoverable without EXIF/OCR",
    },
    mojibake: { detected: false, kinds: [], examples: [] },
    encodingIssues: ["file is binary; not evaluated as text"],
    structuralErrors,
  };
}
