/**
 * Part B2 — grounding validator.
 *
 * This module is the enforcement point for invariants I1, I2 and I5. It runs
 * on every Claude-formatted response BEFORE the user can see it and answers
 * one question: is every number and every named entity in this prose traceable
 * to the structured facts the deterministic pipeline computed?
 *
 * This is ordinary validation code — regex extraction and set membership. It
 * contains no model call and makes no judgement about meaning.
 *
 * On any failure the caller must discard Claude's text and emit the existing
 * deterministic template instead.
 */

import { DISPLAY_ROUNDING_TOLERANCE } from "./claude-config.js";

export type GroundingFailureCode =
  | "untraceable_number"
  | "untraceable_entity"
  | "empty_output"
  | "output_too_long";

export interface GroundingViolation {
  code: GroundingFailureCode;
  /** The offending token, kept for the failure log. */
  token: string;
  detail: string;
}

export interface GroundingResult {
  passed: boolean;
  violations: GroundingViolation[];
  /** Numbers found in Claude's prose, after digit normalization. */
  extractedNumbers: number[];
  /** Numbers derived from the structured facts. */
  allowedNumbers: number[];
  entityTermsFound: string[];
}

export interface GroundingInput {
  /** Claude's candidate user-facing text. */
  text: string;
  /** The exact structured facts handed to Claude for this response. */
  facts: unknown;
  /**
   * The deterministic template text for this same response.
   *
   * This is the pipeline's own output, so anything it already states is by
   * construction traceable. Including it closes a class of false positives:
   * the structured payload stores ingredient *keys* (`rice_white_raw`) while the
   * template renders Arabic display names (`أرز أبيض`), so without this the
   * validator rejected a recipe's own ingredients. It cannot weaken the check,
   * because a fabricated dish or number is absent from this text too.
   */
  referenceText?: string;
  /**
   * Entity names the response is permitted to mention, drawn from the facts
   * (recipe names, ingredient display names, guideline titles).
   */
  allowedEntityNames: readonly string[];
  /**
   * Dataset-wide entity vocabulary. A term from this list that appears in the
   * output while absent from `allowedEntityNames` is a fabricated reference.
   */
  knownEntityVocabulary: readonly string[];
  toleranceAbsolute?: number;
  maxOutputLength?: number;
}

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/** Convert Arabic-Indic digits and the Arabic decimal separator to ASCII. */
export function normalizeDigits(value: string): string {
  return value
    .replace(/[٠-٩۰-۹]/gu, (digit) => {
      const arabicIndex = ARABIC_INDIC.indexOf(digit);
      return String(arabicIndex >= 0 ? arabicIndex : EASTERN_ARABIC_INDIC.indexOf(digit));
    })
    .replace(/٫/gu, ".")
    .replace(/٬/gu, ",");
}

/**
 * Normalization for entity comparison. Mirrors the agent's own lookup
 * normalization — including definite-article stripping — so a name matches
 * here exactly when it would match there. Without the article stripping,
 * prose such as "الملوخية" would evade detection of the bare term "ملوخية".
 */
export function normalizeEntityText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("ar-EG")
    .replace(/[\u064B-\u065F\u0670]/gu, "")
    .replace(/[آأإٱ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ة/gu, "ه")
    .replace(/ـ/gu, "")
    .replace(/([اوي])\1+/gu, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .map((token) => /^وال[\p{L}]{3,}$/u.test(token) ? token.slice(3)
      : /^(?:بال|كال)[\p{L}]{3,}$/u.test(token) ? token.slice(3)
      : /^لل[\p{L}]{3,}$/u.test(token) ? token.slice(2)
      : /^ال[\p{L}]{3,}$/u.test(token) ? token.slice(2)
      : token)
    .join(" ");
}

/** Extract every numeric token from prose, tolerating thousands separators. */
export function extractNumbers(text: string): number[] {
  const normalized = normalizeDigits(text);
  const numbers: number[] = [];
  for (const match of normalized.matchAll(/\d[\d,]*(?:\.\d+)?/gu)) {
    const cleaned = match[0].replace(/,/gu, "");
    const value = Number(cleaned);
    if (Number.isFinite(value)) numbers.push(value);
  }
  return numbers;
}

/** Recursively collect every number reachable in the structured facts. */
export function collectAllowedNumbers(facts: unknown, depth = 0): number[] {
  if (depth > 12) return [];
  if (typeof facts === "number") return Number.isFinite(facts) ? [facts] : [];
  if (typeof facts === "string") return extractNumbers(facts);
  if (Array.isArray(facts)) return facts.flatMap((entry) => collectAllowedNumbers(entry, depth + 1));
  if (typeof facts === "object" && facts !== null) {
    return Object.values(facts as Record<string, unknown>).flatMap((entry) => collectAllowedNumbers(entry, depth + 1));
  }
  return [];
}

/**
 * Expand the allowed set with the display forms the pipeline itself produces.
 *
 * Only lossless restatements of an already-permitted value are added: its
 * one-decimal and integer roundings. No new magnitude is ever introduced, so
 * this cannot let a fabricated figure through.
 */
function withDisplayRoundings(values: readonly number[]): number[] {
  const expanded = new Set<number>();
  for (const value of values) {
    expanded.add(value);
    expanded.add(Math.round(value * 10) / 10);
    expanded.add(Math.round(value));
  }
  return [...expanded];
}

function isTraceable(candidate: number, allowed: readonly number[], tolerance: number): boolean {
  return allowed.some((value) => Math.abs(value - candidate) <= tolerance);
}

/**
 * Validate one candidate Claude response against its structured facts.
 *
 * Returns `passed: false` with the offending tokens whenever the prose
 * contains a number or an entity reference that the facts do not support.
 */
export function validateGrounding(input: GroundingInput): GroundingResult {
  const tolerance = input.toleranceAbsolute ?? DISPLAY_ROUNDING_TOLERANCE;
  const maxOutputLength = input.maxOutputLength ?? 4_000;
  const violations: GroundingViolation[] = [];
  const text = input.text.trim();

  const allowedNumbers = withDisplayRoundings([
    ...collectAllowedNumbers(input.facts),
    ...extractNumbers(input.referenceText ?? ""),
  ]);
  const extractedNumbers = extractNumbers(text);

  if (!text) {
    violations.push({ code: "empty_output", token: "", detail: "formatter produced no text" });
    return { passed: false, violations, extractedNumbers, allowedNumbers, entityTermsFound: [] };
  }
  if (text.length > maxOutputLength) {
    violations.push({ code: "output_too_long", token: String(text.length), detail: `exceeds ${maxOutputLength} characters` });
  }

  for (const candidate of extractedNumbers) {
    if (!isTraceable(candidate, allowedNumbers, tolerance)) {
      violations.push({
        code: "untraceable_number",
        token: String(candidate),
        detail: `not present in the structured input within ±${tolerance}`,
      });
    }
  }

  const normalizedOutput = ` ${normalizeEntityText(text)} `;
  const normalizedReference = ` ${normalizeEntityText(input.referenceText ?? "")} `;
  const allowedTerms = new Set(input.allowedEntityNames.map(normalizeEntityText).filter((term) => term.length >= 2));
  const entityTermsFound: string[] = [];
  const seen = new Set<string>();
  for (const term of input.knownEntityVocabulary) {
    const normalizedTerm = normalizeEntityText(term);
    if (normalizedTerm.length < 3 || seen.has(normalizedTerm)) continue;
    seen.add(normalizedTerm);
    if (!normalizedOutput.includes(` ${normalizedTerm} `)) continue;
    entityTermsFound.push(normalizedTerm);
    if (allowedTerms.has(normalizedTerm)) continue;
    // Already stated by the deterministic answer, so it is traceable.
    if (normalizedReference.includes(` ${normalizedTerm} `)) continue;
    // A term may still be legitimate when it is a fragment of a permitted
    // multi-word name, e.g. "فول" inside the allowed "فول مدمس".
    const containedInAllowed = [...allowedTerms].some((allowed) => allowed.includes(normalizedTerm));
    if (containedInAllowed) continue;
    violations.push({
      code: "untraceable_entity",
      token: term,
      detail: "named entity is absent from the structured input",
    });
  }

  return { passed: violations.length === 0, violations, extractedNumbers, allowedNumbers, entityTermsFound };
}
