/**
 * Minimal RFC-4180-style CSV parser (Node built-ins only).
 * Handles quoted fields, escaped quotes (""), commas and newlines inside
 * quotes, and CRLF/LF line endings. Reports unterminated quotes as errors.
 */

export interface CsvParseResult {
  rows: string[][];
  errors: string[];
  delimiter: string;
}

/** Parse delimited text (comma by default, tab for tab-delimited CSVs). */
export function parseDelimited(text: string, delimiter: string): CsvParseResult {
  const rows: string[][] = [];
  const errors: string[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
    } else if (c === '"') {
      inQuotes = true;
      i += 1;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
      i += 1;
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (c === "\r" && text[i + 1] === "\n") i += 2;
      else i += 1;
    } else {
      field += c;
      i += 1;
    }
  }

  if (inQuotes) {
    errors.push("unterminated quoted field (file does not end cleanly)");
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonBlank = rows.filter((r) => !(r.length === 1 && r[0].trim() === "") && !(r.length === 0));
  return { rows: nonBlank, errors, delimiter };
}

export function parseCsv(text: string): CsvParseResult {
  return parseDelimited(text, ",");
}

/** Parse a field that is a JSON-array-like list (e.g. `["a", "b"]`), with a tolerant fallback. */
export function parseListField(raw: string): string[] | null {
  const t = raw.trim();
  if (t === "") return null;
  try {
    const value: unknown = JSON.parse(t);
    if (Array.isArray(value)) {
      const strings = value.map((x) => String(x).trim()).filter((x) => x !== "");
      return strings.length > 0 ? strings : null;
    }
  } catch {
    // fall through to tolerant parsing
  }
  const inner = t.replace(/^\[/, "").replace(/\]$/, "");
  if (inner.includes('","')) {
    const parts = inner
      .split(/","/)
      .map((s) => s.replace(/^"|"$/g, "").trim())
      .filter((s) => s !== "");
    if (parts.length >= 1) return parts;
  }
  const plain = inner
    .split(",")
    .map((s) => s.replace(/^"|"$/g, "").trim())
    .filter((s) => s !== "");
  if (plain.length >= 1) return plain;
  return null;
}
