/**
 * Numeric helpers for the read-only data audit: distinguish empty (missing),
 * invalid (non-numeric), and explicit zero values.
 */

export function isNumeric(raw: string): boolean {
  const t = raw.trim();
  if (t === "") return false;
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t);
}

/** True when the raw cell is an explicit numeric zero like "0", "0.0", "-0", "0.00". */
export function isZeroValue(raw: string): boolean {
  const t = raw.trim();
  if (t === "") return false;
  return /^[+-]?0+(?:\.0+)?$/.test(t);
}

export interface NumericColumnAnalysis {
  present: number;
  missing: number;
  nonNumeric: number;
  zeros: number;
  nonZeroNumbers: number;
}

export function analyzeNumericColumn(cells: string[]): NumericColumnAnalysis {
  let present = 0;
  let missing = 0;
  let nonNumeric = 0;
  let zeros = 0;
  let nonZeroNumbers = 0;
  for (const raw of cells) {
    if (raw.trim() === "") {
      missing += 1;
      continue;
    }
    present += 1;
    if (isNumeric(raw)) {
      if (isZeroValue(raw)) zeros += 1;
      else nonZeroNumbers += 1;
    } else {
      nonNumeric += 1;
    }
  }
  return { present, missing, nonNumeric, zeros, nonZeroNumbers };
}