/**
 * Text, encoding, and mojibake helpers for the read-only data audit.
 * Node built-ins only; deterministic.
 */

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

export interface EncodingResult {
  encoding: string;
  validUtf8: boolean;
  bom: boolean;
  text: string;
}

/** Normalize an ingredient term for comparison: lowercase, drop punctuation, collapse whitespace. */
export function normalizeTerm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Decode bytes as UTF-8 (BOM-aware); fall back to Latin-1 when not valid UTF-8. */
export function decodeText(bytes: Uint8Array): EncodingResult {
  const bom =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let validUtf8 = true;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    validUtf8 = false;
    text = new TextDecoder("latin1").decode(bytes);
  }
  if (bom && text.startsWith("\uFEFF")) {
    text = text.slice(1);
  }
  return {
    encoding: validUtf8 ? (bom ? "utf-8-bom" : "utf-8") : "latin1 (invalid utf-8)",
    validUtf8,
    bom,
    text,
  };
}

function isLatin1OfArabic(text: string): { ok: boolean; example: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(text, "latin1").toString("utf8");
  } catch {
    return { ok: false, example: "" };
  }
  const arabic = decoded.match(/[\u0600-\u06FF]/g);
  if (arabic && arabic.length >= 3) {
    return { ok: true, example: arabic.slice(0, 5).join("") };
  }
  return { ok: false, example: "" };
}

function sampleAround(text: string, needle: string): string {
  const idx = text.indexOf(needle);
  if (idx < 0) return "";
  const start = Math.max(0, idx - 12);
  const end = Math.min(text.length, idx + needle.length + 12);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** Detect common mojibake / double-encoding symptoms in decoded text. */
export function detectMojibake(text: string): MojibakeReport {
  const kinds: string[] = [];
  const examples: string[] = [];

  if (text.includes("\uFFFD")) {
    kinds.push("replacement_char_uFFFD");
    const ex = sampleAround(text, "\uFFFD");
    if (ex) examples.push(ex);
  }

  const latin1 = isLatin1OfArabic(text);
  if (latin1.ok) {
    kinds.push("latin1_read_as_utf8_of_arabic");
    examples.push(`latin1->utf8 decodes to Arabic e.g. ${latin1.example}`);
  }

  const latin1Seq = text.match(/[ÃÂ][\u0080-\u00BF]|Ø§Ù|ÙŠ|Ù‡|Øª|Ù…/g);
  if (latin1Seq && latin1Seq.length > 0) {
    kinds.push("latin1_mojibake_sequences");
    if (examples.length < 4) {
      examples.push(`sequences e.g. ${latin1Seq.slice(0, 4).join(", ")}`);
    }
  }

  const mojibakeOther = text.match(/â€|Ã©|Ã¨|Ã¢|Ã±|Â§|Â£/g);
  if (mojibakeOther && mojibakeOther.length > 0 && !kinds.includes("latin1_mojibake_sequences")) {
    kinds.push("latin1_mojibake_sequences");
    if (examples.length < 4) examples.push(`other sequences e.g. ${mojibakeOther.slice(0, 4).join(", ")}`);
  }

  return { detected: kinds.length > 0, kinds, examples: [...new Set(examples)].slice(0, 10) };
}

/** Heuristic OCR / extraction noise detection (evidence only). */
export function detectNoise(text: string): NoiseReport {
  const kinds: string[] = [];
  const samples: string[] = [];

  const controlChars = [
    0x0000, 0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x0008,
    0x000b, 0x000c, 0x000e, 0x000f, 0x0010, 0x0011, 0x0012, 0x0013, 0x0014,
    0x0015, 0x0016, 0x0017, 0x0018, 0x0019, 0x001a, 0x001b, 0x001c, 0x001d,
    0x001e, 0x001f, 0x007f,
  ];
  const controlSet = new Set(controlChars);
  let control = 0;
  for (const ch of text) {
    if (controlSet.has(ch.codePointAt(0) ?? 0)) control += 1;
  }
  if (control > 0) {
    kinds.push("control_characters");
    samples.push(`${control} control character(s) present`);
  }

  const repeated = text.match(/(!|\?|\.){4,}/g);
  if (repeated && repeated.length > 0) {
    kinds.push("repeated_punctuation");
    samples.push(`e.g. ${repeated.slice(0, 3).join(", ")}`);
  }

  const longTokens = text
    .split(/\s+/)
    .filter((t) => t.length > 120)
    .slice(0, 3);
  if (longTokens.length > 0) {
    kinds.push("overlong_tokens");
    samples.push(`${longTokens.length} token(s) longer than 120 chars (possible concatenation)`);
  }

  const nonBreaking = (text.match(/\u00A0/g) || []).length;
  if (nonBreaking > 0) {
    kinds.push("nonbreaking_spaces");
    samples.push(`${nonBreaking} U+00A0 non-breaking space(s)`);
  }

  return { detected: kinds.length > 0, kinds, samples: samples.slice(0, 6) };
}
