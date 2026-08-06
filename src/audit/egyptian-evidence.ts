/**
 * Egyptian-scope evidence reference and recipe classification.
 *
 * IMPORTANT: this is an internal *evidence* reference for the read-only audit,
 * NOT an approved Egyptian dish registry and NOT a verification authority.
 *
 * Two non-negotiable rules:
 *  1. Broad regional tags (Middle Eastern / Mediterranean / Levantine / Arab /
 *     North African) are NOT Egyptian evidence. Only explicit Egyptian signals
 *     may feed classification.
 *  2. Automated logic can NEVER emit a verified status. At most a recipe is
 *     flagged `candidate` (strong signals) or `needs_review`. A human reviewer
 *     must independently decide `verified_egyptian` using documented cultural
 *     evidence, their identity and review date (see `humanVerification`).
 */

import { normalizeTerm } from "./text.js";
import { isBroadRegional, isExplicitEgypt } from "./compliance.js";
import type { RecipeReviewClass } from "./types.js";

/** Well-known Egyptian dishes / transliterations (evidence reference). */
const DISH_ALIASES = [
  "koshari", "kushari", "koshery", "kosheri", "koshary",
  "molokhia", "molokheya", "molokhiya", "melokhia", "mouloukhia", "mloukhiya",
  "ful medames", "foul medames", "ful medammes", "foul medammes", "ful", "foul",
  "taameya", "taamiya", "ta'miya", "falafel",
  "mahshi", "mahshy", "mashi", "mahshee",
  "hawawshi", "hawawshy",
  "fattah", "fatta", "fatteh", "fetteh",
  "fateer", "fiteer", "feteer meshaltet", "fatair",
  "shakshuka",
  "bamia", "bamiya", "bamya",
  "warak enab", "wara2 enab", "warak ainab",
  "kebab halla", "kebab hallah",
  "hamam mahshi",
  "roz bel laban", "roz bil laban", "roz belaban", "ruz bel laban",
  "om ali", "umm ali", "omali", "ummali", "omm ali",
  "mahalabiya", "muhallabia", "muhallabieh",
  "basbousa", "basboosa",
  "kunafa", "konafa", "knafeh", "knafa",
  "aish baladi", "eish baladi", "baladi bread", "aish masri", "eish masri",
  "shorbat adas", "shorbet adas",
  "sayadieh", "sayyadiya", "sayadeya",
  "moussaka", "musakaa",
  "koshary", "koshariy",
];

const DISH_NORM: Set<string> = new Set(DISH_ALIASES.map(normalizeTerm));

/** Egyptian staple main ingredients (evidence reference). */
const EG_MAIN_ALIASES = [
  "fava beans", "ful", "foul", "molokhia", "molokheya", "molokhiya",
  "koshari", "kushari", "taameya", "taamiya", "falafel",
  "okra", "bamia", "bamiya", "lentil", "lentils",
];

export const EG_MAIN_NORM: Set<string> = new Set(EG_MAIN_ALIASES.map(normalizeTerm));

/**
 * Cuisine labels that are clearly non-Egyptian (used only when no Egyptian signal exists).
 * NOTE: broad regional labels are intentionally excluded here — they are neither
 * Egyptian evidence nor proof of "not Egyptian", so they route to needs_review.
 */
const NON_EG_CUISINE = new Set([
  "american", "british", "english", "italian", "french", "german", "spanish",
  "mexican", "chinese", "japanese", "korean", "thai", "vietnamese", "indian",
  "caribbean", "brazilian", "cajun", "southern", "irish", "scottish",
  "portuguese", "russian",
]);

export interface RecipeInput {
  row: number;
  title: string;
  description: string;
  category: string;
  subcategory: string;
  cuisineList: string[];
  mainIngredient: string;
  ingredientTerms: string[];
  mojibakeInTitle: boolean;
  malformed: boolean;
  missingTitle: boolean;
  missingIngredients: boolean;
  /** C-2: non-empty instructions (directions/steps) present. */
  hasInstructions: boolean;
  /** C-2: the file decoded as valid UTF-8. */
  fileIsValidUtf8: boolean;
  /** C-1: source identifier. */
  sourceId: string;
  /** C-1: source version. */
  sourceVersion: string;
  /** C-1: access date / provenance record (must be a strict ISO date YYYY-MM-DD). */
  accessDate: string;
  /** C-3: linkable documented cultural-evidence claim. */
  cultureEvidenceLink: string;
  /** C-3: Egyptian-recipe cultural-evidence records registered in the audit
   * source manifest (purpose = `egyptian_recipe_cultural_evidence`). Only these
   * records may resolve a C-3 claim, and only when their applicability scope
   * matches the dish being classified. Guideline/nutrition/licensing/
   * source-provenance IDs are never eligible. */
  culturalEvidence?: ReadonlyArray<CulturalEvidenceRecord>;
}

export interface CulturalEvidenceRecord {
  /** Manifest evidence ID (e.g. `EG-KOSHARI-CULTURAL-001`). */
  id: string;
  /** Dish IDs / aliases / recipe/source IDs this evidence applies to. */
  applicableTo: string[];
}

export interface ClassificationResult {
  classification: RecipeReviewClass;
  reasons: string[];
  /** Positive Egyptian signals ONLY (broad regional tags excluded). */
  signals: string[];
  /** Broad regional tags (Middle Eastern/Mediterranean/etc.); never a positive signal. */
  broadTags: string[];
}

/** True when `term` occurs in `text` as a whole token / whole token phrase. */
export function containsAtTokenBoundary(text: string, term: string): boolean {
  const words = term.split(" ");
  if (words.length === 1) {
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?:$|[^\\p{L}\\p{N}])`, "u").test(text);
  }
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?:$|[^\\p{L}\\p{N}])`, "u").test(text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Longest dish alias that appears at token boundaries in `text` (or null). */
function findDishMatch(text: string, aliases: Iterable<string>): string | null {
  let best: string | null = null;
  for (const alias of aliases) {
    const norm = normalizeTerm(alias);
    if (norm === "") continue;
    if (containsAtTokenBoundary(text, norm)) {
      if (best === null || norm.length > best.length) best = norm;
    }
  }
  return best;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict ISO-8601 calendar date check: pattern AND a real calendar date
 * (e.g. 2026-02-30 and 2026-13-01 are rejected). Shared by the audit gates and
 * the recipe staging registry. */
export function isValidIsoDate(raw: string): boolean {
  if (!ISO_DATE_RE.test(raw)) return false;
  const [y, m, d] = raw.split("-").map((s) => Number(s));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

interface EvidenceResolution {
  linked: boolean;
  viaUrl: boolean;
  recordId?: string;
}

/** Case-insensitive evidence-ID key (trimmed). */
function evidenceKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Normalized text the recipe's identity contributes to evidence-scope matching:
 * title, main ingredient, ingredient terms, declared cuisines, the source_id,
 * and the matched dish alias (if any).
 */
function recipeScopeText(input: RecipeInput, dishHit: string | null): string {
  const parts = [
    input.title,
    input.mainIngredient,
    ...input.ingredientTerms,
    ...input.cuisineList,
    input.sourceId,
  ];
  if (dishHit) parts.push(dishHit);
  return parts.map(normalizeTerm).filter((s) => s !== "").join(" ");
}

/** True when the record's applicability scope covers `scopeText` (token-boundary, normalized). */
function recordAppliesTo(record: CulturalEvidenceRecord, scopeText: string): boolean {
  for (const scope of record.applicableTo) {
    const norm = normalizeTerm(scope);
    if (norm === "") continue;
    if (containsAtTokenBoundary(scopeText, norm)) return true;
  }
  return false;
}

/** C-3: a documented cultural-evidence claim is linkable when it is a valid
 * http(s) URL, or the ID of a manifest cultural-evidence record whose
 * applicability scope matches the dish being classified (case-insensitive ID
 * match). Guideline/nutrition/licensing/source-provenance IDs are never
 * eligible. Anything else (free text, empty, unsupported schemes,
 * out-of-scope IDs) is not linkable. */
function resolveEvidence(
  value: string,
  records: ReadonlyArray<CulturalEvidenceRecord>,
  input: RecipeInput,
  dishHit: string | null
): EvidenceResolution {
  if (value.trim() === "") return { linked: false, viaUrl: false };
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      const valid = (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
      return { linked: valid, viaUrl: true };
    } catch {
      return { linked: false, viaUrl: false };
    }
  }
  const key = evidenceKey(value);
  const scopeText = recipeScopeText(input, dishHit);
  for (const record of records) {
    if (evidenceKey(record.id) === key && recordAppliesTo(record, scopeText)) {
      return { linked: true, viaUrl: false, recordId: record.id };
    }
  }
  return { linked: false, viaUrl: false };
}

export function classifyRecipe(input: RecipeInput): ClassificationResult {
  const signals: string[] = [];
  const broadTags: string[] = [];

  if (input.malformed) {
    return { classification: "rejected", reasons: ["malformed row (column count mismatch)"], signals: [], broadTags: [] };
  }
  if (input.missingTitle) {
    return { classification: "rejected", reasons: ["empty recipe title"], signals: [], broadTags: [] };
  }
  if (input.missingIngredients) {
    return { classification: "rejected", reasons: ["no parseable ingredient list"], signals: [], broadTags: [] };
  }
  if (input.mojibakeInTitle) {
    return { classification: "rejected", reasons: ["mojibake detected in title"], signals: [], broadTags: [] };
  }

  const titleNorm = normalizeTerm(input.title);
  if (titleNorm === "") {
    return { classification: "rejected", reasons: ["title has no meaningful content"], signals: [], broadTags: [] };
  }

  // Dish aliases matched at token boundaries only (never substring), so a
  // short alias like "ful" cannot match inside "truthful"/"spoonful".
  const dishHit = findDishMatch(titleNorm, DISH_NORM) ?? findDishMatch(input.ingredientTerms.join(" "), DISH_NORM);
  if (dishHit) signals.push(`dish_name_match=${dishHit}`);

  const mainNorm = normalizeTerm(input.mainIngredient);
  const mainHit =
    findDishMatch(mainNorm, DISH_NORM) ??
    findDishMatch(mainNorm, EG_MAIN_NORM);
  if (mainHit) signals.push(`egyptian_main_ingredient=${input.mainIngredient}`);

  // Only explicit Egyptian cuisine labels count as positive signals. Broad
  // regional tags are recorded separately (`broadTags`) and never contribute
  // to the positive-signal total.
  const explicitCuisine = input.cuisineList.filter((c) => isExplicitEgypt(c));
  for (const c of input.cuisineList) {
    if (isBroadRegional(c) && !isExplicitEgypt(c)) broadTags.push(c);
  }
  if (explicitCuisine.length > 0) signals.push(`cuisine_explicit_egypt=[${explicitCuisine.join(", ")}]`);

  const egyptWord = /\b(egypt|egyptian|masri|masry|misri|masrya)\b/i.test(
    `${input.title} ${input.description} ${input.category} ${input.subcategory}`
  );
  if (egyptWord) signals.push("title_or_text_mentions_egypt");

  // C-1: source_id + source_version + access_date/provenance record.
  // access_date must be a strict ISO date (pattern + real calendar date).
  const c1 =
    input.sourceId.trim() !== "" &&
    input.sourceVersion.trim() !== "" &&
    isValidIsoDate(input.accessDate);
  // C-2: non-empty title, non-empty instructions, parseable ingredients, valid UTF-8.
  const c2 =
    !input.missingTitle &&
    input.hasInstructions &&
    !input.missingIngredients &&
    !input.mojibakeInTitle &&
    input.fileIsValidUtf8;
  // C-3: linkable documented cultural-evidence claim. A claim resolves as an
  // http(s) URL, or as the ID of a manifest cultural-evidence record (purpose =
  // egyptian_recipe_cultural_evidence) whose applicability scope matches the
  // dish being classified. Guideline/nutrition/licensing/source-provenance IDs
  // (e.g. the WHO healthy-diet factsheet) are NEVER eligible for C-3.
  const c3Resolution = resolveEvidence(input.cultureEvidenceLink, input.culturalEvidence ?? [], input, dishHit);
  const c3 = c3Resolution.linked;

  // A recipe is only `candidate` when ALL of C-1..C-3 hold AND it matches a
  // specific Egyptian dish by name with at least one other independent
  // Egyptian signal. A dish alias + a broad tag, or a single Egyptian
  // ingredient, is never enough. Automation cannot self-verify.
  const strong = signals.some((s) => s.startsWith("dish_name_match"));
  if (strong && signals.length >= 2 && c1 && c2 && c3) {
    return {
      classification: "candidate",
      reasons: [
        "strong Egyptian-specific signals (dish name plus at least one other)",
        "C-1..C-3 satisfied (source_id, source_version, access_date, instructions, valid UTF-8, documented cultural-evidence link)",
        "automated logic cannot self-verify; human review required for Egyptian verification",
      ],
      signals,
      broadTags,
    };
  }

  if (signals.length > 0) {
    const reasons = [
      "some Egyptian-scope signals present but insufficient or single-source",
    ];
    if (strong && signals.length >= 2 && !c1) reasons.push("C-1 not satisfied (missing/invalid source_id/source_version/access_date; access_date must be a strict ISO date YYYY-MM-DD)");
    if (strong && signals.length >= 2 && !c2) reasons.push("C-2 not satisfied (title/instructions/ingredients/UTF-8 requirement unmet)");
    if (strong && signals.length >= 2 && !c3) reasons.push("C-3 not satisfied (culture_evidence_link must be a valid http(s) URL or the ID of a manifest cultural-evidence record whose scope matches this dish; guideline/nutrition/provenance IDs are never eligible)");
    return {
      classification: "needs_review",
      reasons,
      signals,
      broadTags,
    };
  }

  const declaredCuisines = input.cuisineList.map((c) => c.toLowerCase().trim());
  if (declaredCuisines.length > 0 && declaredCuisines.every((c) => NON_EG_CUISINE.has(c))) {
    return {
      classification: "not_egyptian",
      reasons: ["no Egyptian-scope signals and all declared cuisines are non-Egyptian"],
      signals,
      broadTags,
    };
  }

  if (declaredCuisines.length > 0 && declaredCuisines.some((c) => isBroadRegional(c))) {
    return {
      classification: "needs_review",
      reasons: ["only broad regional tags present (e.g. Middle Eastern/Mediterranean); not Egyptian evidence"],
      signals,
      broadTags,
    };
  }

  return {
    classification: "needs_review",
    reasons: ["no Egyptian-scope signals and cuisine not clearly classifiable"],
    signals,
    broadTags,
  };
}
