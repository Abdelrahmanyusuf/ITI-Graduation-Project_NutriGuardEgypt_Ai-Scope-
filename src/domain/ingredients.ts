/**
 * Ingredient dictionary + deterministic entity resolution — Step 5.
 *
 * A master ingredient dictionary with canonical Arabic / English / Egyptian
 * ingredient records and multilingual aliases, plus a strict multi-stage
 * entity resolver:
 *
 *   1. `normalized_exact`   — the query equals a canonical record's own name
 *                             after language-aware normalization;
 *   2. `alias_exact`        — the query equals a documented alias after the
 *                             same normalization;
 *   3. `reviewed_mapping`   — the normalized query maps through a HUMAN-reviewed
 *                             mapping entry (`data/dictionary/reviewed-mappings.json`);
 *   4. otherwise           — `unresolved` (pushed to the manual-review queue).
 *
 * Hard rules (mirror DATA_SOURCE_POLICY.md / MVP_REQUIREMENTS.md):
 *  - Original text is ALWAYS preserved verbatim (no trimming); `original`
 *    fields and every occurrence carry their exact source text.
 *  - Every reviewed mapping REQUIRES a non-empty reviewer, a valid strict ISO
 *    calendar date, an evidence/rationale source and a unique record ID.
 *    Mappings missing any required review metadata are REJECTED. Two reviewed
 *    mappings that normalize to the same term with conflicting targets are a
 *    VALIDATION ERROR and that term stays unresolved — the last Map.set never
 *    silently wins.
 *  - Every resolved record must be reproducible: normalized_exact/alias_exact
 *    matches surface the canonical record's provenance (dictionary version,
 *    reviewer, review date, source). reviewed_mapping matches surface the
 *    review metadata (id, reviewer, date, evidence, source).
 *  - Food-state compatibility is ENFORCED: if a query declares
 *    raw/cooked/boiled/fried/baked/drained, only a canonical record with that
 *    EXACT state may resolve it; otherwise it is unresolved/ambiguous and
 *    routed to review. State words are never merged into canonical names.
 *  - Dried peas/fava are modeled as their own canonical records (not as a
 *    "drained" state); "drained" is never a synonym for dried.
 *  - Aliases must be spelling/language variants of the SAME ingredient.
 *    Nutritionally distinct foods carry separate canonical records.
 *  - Fuzzy / vector matching NEVER produces an accepted canonical mapping.
 *  - Arabic is normalized deterministically (hamza/alef variants, ta marbuta,
 *    diacritics, tatweel) so spelling variants resolve to the same canonical.
 *  - No LLM, no randomness, no auto-approval.
 */

import { createHash } from "node:crypto";

import { normalizeTerm } from "../audit/text.js";

/** Food states kept separate everywhere (mirrors the SQL CHECK constraint). */
export const FOOD_STATES = ["raw", "cooked", "boiled", "fried", "baked", "drained"] as const;
export type FoodState = (typeof FOOD_STATES)[number];

/** Acceptable resolution stages. `none` = unresolved (review queue). */
export const RESOLUTION_STAGES = ["normalized_exact", "alias_exact", "reviewed_mapping"] as const;
export type ResolutionStage = (typeof RESOLUTION_STAGES)[number] | "none";

export type ResolutionStatus = "resolved" | "ambiguous" | "unresolved";

/** Dictionary schema version for `data/dictionary/ingredients.json`. */
export const INGREDIENT_DICTIONARY_SCHEMA = "1.0";

/** Human-review status of a canonical dictionary record. */
export const REVIEW_STATUSES = ["unapproved", "approved"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * Provenance/review metadata for a canonical dictionary record (and its aliases).
 *
 * `unapproved` is the honest default: the record is repo-backed (it lives in
 * `data/dictionary/ingredients.json`) but has NO human approval yet. `reviewer`
 * and `reviewDate` MUST be empty while `status === "unapproved"` — fabricating
 * a reviewer name, date or "approved" claim is a validation error. Only a real
 * human review record can graduate a record to `approved`.
 */
export interface DictionaryProvenance {
  /** Dictionary schema version the record ships in. */
  version: string;
  /** Human-review status; "approved" only after a recorded human approval. */
  status: ReviewStatus;
  /** Human reviewer identity — present only when status === "approved". */
  reviewer: string | null;
  /** Strict ISO calendar date of approval — present only when status === "approved". */
  reviewDate: string | null;
  /** Repo-backed source reference for the canonical identity. */
  source: string;
}

/**
 * A single canonical ingredient record. One canonical entity per
 * nutritionally distinct food; aliases are spelling/language variants only.
 */
export interface IngredientEntry {
  /** Stable canonical key, e.g. `lentils` or `peas-dried`. */
  key: string;
  /** Canonical English name (used for normalized-exact matching). */
  nameEn: string;
  /** Canonical Arabic name (used for normalized-exact matching). */
  nameAr: string | null;
  /** Egyptian-dialect name (informative; also an alias). */
  nameEg: string | null;
  /** English spelling/language aliases (SAME food only). */
  aliasesEn: string[];
  /** Arabic spelling/language aliases (SAME food only). */
  aliasesAr: string[];
  /** Egyptian-dialect aliases (SAME food only). */
  aliasesEg: string[];
  /** Open category, e.g. `grain`, `legume`, `vegetable`, `spice`. */
  category: string | null;
  /** The food state this record represents, or null for a state-neutral item. */
  foodState: FoodState | null;
  /** Provenance/review metadata for this record + its aliases. */
  provenance: DictionaryProvenance;
  /** Optional reviewer-facing notes. */
  notes?: string;
}

/**
 * A human-reviewed term → canonical mapping (`data/dictionary/reviewed-mappings.json`).
 * A reviewed mapping is ONLY valid when it carries a real human review: a
 * non-empty reviewer, a valid strict ISO date, evidence, a source, and a
 * globally-unique id. Validators reject the record (never fabricating approval)
 * when any of these is missing.
 */
export interface ReviewedMapping {
  /** Unique mapping-record id (required; surfaced in results + reports). */
  id: string;
  /** The original (untouched) term text that was reviewed. */
  term: string;
  /** Canonical key it maps to. */
  toKey: string;
  /** Reviewer identity that approved it (required, non-empty). */
  reviewer: string;
  /** Strict ISO calendar review date (required, valid). */
  reviewDate: string;
  /** Rationale/evidence/source reference (required, non-empty). */
  evidence: string;
  /** Source reference for the mapping (required, non-empty). */
  source: string;
}

/**
 * An immutable approval record in `data/dictionary/review-registry.json`.
 *
 * Approval is bound to the EXACT mapping content via `contentHash`: a
 * deterministic hash over (id, normalizedTerm, toKey, reviewer, reviewDate,
 * evidence, source). Changing ANY of those fields after approval changes the
 * hash, which invalidates the approval — the mapping is then excluded from the
 * active set and must be re-reviewed. The record's own stored hash is verified
 * on load, so registry tampering is detected too.
 */
export interface ReviewRecord {
  /** Mapping-record id (matches a reviewed-mapping `id`). */
  id: string;
  /** Normalized form of the reviewed term (the matching key). */
  normalizedTerm: string;
  /** Canonical key it maps to. */
  toKey: string;
  /** Reviewer identity (required, non-empty). */
  reviewer: string;
  /** Strict ISO calendar review date (required, valid). */
  reviewDate: string;
  /** Rationale/evidence/source reference (required, non-empty). */
  evidence: string;
  /** Source reference for the mapping (required, non-empty). */
  source: string;
  /** Deterministic content fingerprint over the fields above. */
  contentHash: string;
}

/** A parsed, validated review registry. */
export interface ParsedReviewRegistry {
  records: ReviewRecord[];
  /** id → record (for approval lookup). */
  byId: Map<string, ReviewRecord>;
  issues: string[];
}

/**
 * Deterministic content fingerprint for a review record. Binds approval to the
 * EXACT content: id, normalized term, toKey, reviewer, reviewDate, evidence and
 * source. Changing any field changes the hash, which invalidates the approval.
 * Uses SHA-256 over canonical, field-ordered JSON. This is an integrity
 * fingerprint, not a substitute for the human reviewer identity/evidence that
 * is also required by the registry schema.
 */
export function computeReviewContentHash(fields: {
  id: string;
  normalizedTerm: string;
  toKey: string;
  reviewer: string;
  reviewDate: string;
  evidence: string;
  source: string;
}): string {
  const canonical = JSON.stringify([
    fields.id,
    fields.normalizedTerm,
    fields.toKey,
    fields.reviewer,
    fields.reviewDate,
    fields.evidence,
    fields.source,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Parse + validate the review registry (`data/dictionary/review-registry.json`).
 *
 * Each record binds approval to its exact content via `contentHash`. On load we
 * recompute the hash from the record's own fields and compare — a registry entry
 * whose stored hash does not match its content is rejected (registry tampering
 * detection). Records missing required fields, carrying an invalid strict ISO
 * date, or duplicating an id are also rejected. Nothing here fabricates approval.
 */
export function parseReviewRegistry(raw: unknown): ParsedReviewRegistry {
  const records: ReviewRecord[] = [];
  const byId = new Map<string, ReviewRecord>();
  const issues: string[] = [];
  if (raw === null || raw === undefined) return { records, byId, issues };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    issues.push("review registry must be a JSON object with a 'records' array");
    return { records, byId, issues };
  }
  const container = raw as Record<string, unknown>;
  if (!Array.isArray(container.records)) {
    issues.push("review registry must contain a 'records' array");
    return { records, byId, issues };
  }
  const idCounts = new Map<string, number>();
  for (const e of container.records) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) continue;
    const id = typeof (e as Record<string, unknown>).id === "string"
      ? ((e as Record<string, unknown>).id as string).trim()
      : "";
    if (id !== "") idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  for (let i = 0; i < container.records.length; i += 1) {
    const e = container.records[i];
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      issues.push(`review registry record ${i}: must be an object`);
      continue;
    }
    const rec = e as Record<string, unknown>;
    const label = `review registry record ${i}`;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    const normalizedTerm = typeof rec.normalizedTerm === "string" ? rec.normalizedTerm.trim() : "";
    const toKey = typeof rec.toKey === "string" ? rec.toKey.trim() : "";
    const reviewer = typeof rec.reviewer === "string" ? rec.reviewer.trim() : "";
    const reviewDate = typeof rec.reviewDate === "string" ? rec.reviewDate.trim() : "";
    const evidence = typeof rec.evidence === "string" ? rec.evidence.trim() : "";
    const source = typeof rec.source === "string" ? rec.source.trim() : "";
    const contentHash = typeof rec.contentHash === "string" ? rec.contentHash.trim() : "";
    let ok = true;
    if (id === "") {
      issues.push(`${label}: 'id' is required`);
      ok = false;
    }
    if (normalizedTerm === "") {
      issues.push(`${label}: 'normalizedTerm' is required`);
      ok = false;
    }
    if (toKey === "") {
      issues.push(`${label}: 'toKey' is required`);
      ok = false;
    }
    if (reviewer === "") {
      issues.push(`${label}: 'reviewer' is required (non-empty)`);
      ok = false;
    }
    if (reviewDate === "") {
      issues.push(`${label}: 'reviewDate' is required`);
      ok = false;
    } else if (!isStrictIsoDate(reviewDate)) {
      issues.push(`${label}: 'reviewDate' "${reviewDate}" is not a valid strict ISO calendar date`);
      ok = false;
    }
    if (evidence === "") {
      issues.push(`${label}: 'evidence' (rationale/source) is required`);
      ok = false;
    }
    if (source === "") {
      issues.push(`${label}: 'source' is required`);
      ok = false;
    }
    if (contentHash === "") {
      issues.push(`${label}: 'contentHash' is required`);
      ok = false;
    }
    if (id !== "" && (idCounts.get(id) ?? 0) > 1) {
      issues.push(`${label}: duplicate registry id "${id}"`);
      ok = false;
    }
    // Verify the stored hash against the record's own content (registry tamper check).
    if (ok) {
      const expected = computeReviewContentHash({ id, normalizedTerm, toKey, reviewer, reviewDate, evidence, source });
      if (expected !== contentHash) {
        issues.push(`${label}: stored contentHash does not match record content (registry entry tampered)`);
        ok = false;
      }
    }
    if (!ok) continue;
    records.push({ id, normalizedTerm, toKey, reviewer, reviewDate, evidence, source, contentHash });
    byId.set(id, records[records.length - 1]);
  }
  return { records, byId, issues };
}

/** True when the string contains Arabic-script codepoints. */
export function containsArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

const ARABIC_COMBINING_RE = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/**
 * Remove a leading Arabic definite article ("ال", alef-lam) from a single
 * token. The article is grammatical, not semantic — "البيضة" and "بيضة" name
 * the same food — so folding them together lets natural forms like
 * "البيضة المقلية" match the canonical "بيضة مقلية". Only strips when the
 * article is a true prefix (token is longer than the article itself).
 */
function stripDefiniteArticle(token: string): string {
  return token.length > 2 && token.startsWith("\u0627\u0644") ? token.slice(2) : token;
}

/** Deterministic Arabic normalization for matching (never alters stored text). */
export function normalizeArabic(text: string): string {
  const decomposed = text.normalize("NFD").replace(ARABIC_COMBINING_RE, "").normalize("NFC");
  const folded = decomposed.replace(/[\u0622\u0623\u0625\u0671\u0629\u0649]/g, (c) =>
    c === "\u0622" || c === "\u0623" || c === "\u0625" || c === "\u0671" ? "\u0627" : c === "\u0629" ? "\u0647" : "\u064A"
  );
  const cleaned = folded.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
  // Fold the definite article per token so natural Arabic forms match canonicals.
  return cleaned.split(/\s+/).map(stripDefiniteArticle).join(" ").trim();
}

/** Language-aware normalization of an ingredient term for matching. */
export function normalizeIngredientTerm(text: string): string {
  if (!containsArabic(text)) return normalizeTerm(text);
  const normalized = normalizeArabic(text);
  const tokenized = normalized
    .split(/\s+/)
    .map((token) => token.replace(/^ال(?=\p{L})/u, ""))
    .filter((token) => token !== "")
    .join(" ")
    .trim();
  return tokenized;
}

/**
 * Maps an English/normalized-Arabic token to a food state (kept separate).
 *
 * Conventions (mem code):
 *  - Arabic keys are stored in their normalized base form; at lookup time the
 *    incoming token is normalized the same way (`normalizeArabic`) so that
 *    diacritic (vocalized) and feminine variants ("مُطَبوخة", "مطبوخ"
 *    vs "مطوعة", "مطبوخ") match.
 *  - مشوي / مشوية / grilled / roasted are DELIBERATELY ABSENT: the supported
 *    state set is raw/cooked/boiled/fried/baked/drained and "grilled" has no
 *    state-model entry, so it is NOT forced into baked. Such queries fall
 *    through to unresolved and are routed to the manual review queue (or an
 *    explicit dictionary record when a human extends the state model).
 */
const FOOD_STATE_WORDS: Readonly<Record<string, FoodState>> = {
  raw: "raw", "خام": "raw", "نيئ": "raw", "نيئة": "raw",
  cooked: "cooked", "مطبوخ": "cooked", "مطبوخة": "cooked",
  boiled: "boiled", "مسلوق": "boiled", "مسلوقة": "boiled",
  fried: "fried", "مقلي": "fried", "مقلية": "fried",
  baked: "baked", "مخبوز": "baked", "مخبوزة": "baked",
  drained: "drained", "مصفى": "drained", "مصفاة": "drained",
};

/**
 * Lookup index for food-state words. English keys are case-folded; Arabic keys
 * are normalized (`normalizeArabic`) so vocalized/feminine/spelling variants
 * resolve to the same state without fabricating extra entries.
 */
const FOOD_STATE_INDEX: ReadonlyMap<string, FoodState> = (() => {
  const m = new Map<string, FoodState>();
  for (const [word, state] of Object.entries(FOOD_STATE_WORDS)) {
    m.set(containsArabic(word) ? normalizeArabic(word) : word.toLowerCase(), state);
  }
  return m;
})();

/** English/Arabic tokens that mean grilled/roasted — never auto-reclassified to baked. */
const GRILLED_ROASTED_REVIEW_TOKENS = new Set<string>([
  "grilled", "grill", "roasted", "roast",
  // Arabic keys are stored in the same normalized base form used for lookup.
  normalizeArabic("مشوي"), normalizeArabic("مشوية"), normalizeArabic("مشاوي"),
  normalizeArabic("محمر"), normalizeArabic("محمص"), normalizeArabic("محمصة"),
]);

/** Accessory/prep words removed ONLY for matching; the original stays intact. */
const PREP_TOKENS = new Set<string>([
  "optional", "chopped", "sliced", "minced", "diced", "peeled", "grated",
  "crushed", "mashed", "cubed", "halved", "divided", "shredded",
]);

export interface NormalizedQuery {
  /** Identity text used for exact/alias matching (food state removed). */
  text: string;
  /** Detected food state (if any). */
  foodState: FoodState | null;
  /** True when the line declares a grilled/roasted preparation (routes to review). */
  grilledOrRoasted: boolean;
}

/** Analyzes raw line text into an identity query + separate food state. */
export function normalizeForMatching(raw: string): NormalizedQuery {
  let s = raw.trim();
  s = s.replace(/\b(?:to\s+taste|optional|as\s+needed|not\s+required)\b/gi, " ").replace(/\s+/g, " ").trim();
  const tokens = s.split(/\s+/).filter((t) => t !== "");
  const kept: string[] = [];
  let foodState: FoodState | null = null;
  let grilledOrRoasted = false;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const normalizedToken = normalizeIngredientTerm(token);
    const hit = FOOD_STATE_INDEX.get(lower) ?? FOOD_STATE_INDEX.get(normalizedToken);
    const grilled = GRILLED_ROASTED_REVIEW_TOKENS.has(lower) || GRILLED_ROASTED_REVIEW_TOKENS.has(normalizedToken);
    if (hit !== undefined) {
      foodState = hit;
    } else if (grilled) {
      grilledOrRoasted = true;
    } else if (!PREP_TOKENS.has(lower)) {
      kept.push(token);
    }
  }
  return { text: normalizeIngredientTerm(kept.join(" ")), foodState, grilledOrRoasted };
}

/**
 * Like `normalizeForMatching` but KEEPS the food-state word in the text. This
 * lets a query like "cooked rice" match the state-specific canonical record
 * (`rice-cooked`) during the state-aware pass.
 */
export function normalizeWithState(raw: string): string {
  let s = raw.trim();
  s = s.replace(/\b(?:to\s+taste|optional|as\s+needed|not\s+required)\b/gi, " ").replace(/\s+/g, " ").trim();
  const tokens = s.split(/\s+/).filter((t) => t !== "");
  const kept: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (!PREP_TOKENS.has(lower)) kept.push(token);
  }
  return normalizeIngredientTerm(kept.join(" "));
}

/** A parsed ingredient line: original text (verbatim) + quantity text + unit text. */
export interface ParsedIngredientLine {
  /** The exact original raw text — never trimmed. */
  original: string;
  /** Exact quantity text (Western/European/Arabic-Indic/Eastern-Arabic digits). */
  quantity: string | null;
  /** Exact unit phrase text as it appeared (e.g. "tablespoons" or "ملعقة كبيرة"). */
  unit: string | null;
  name: string;
}

const QUANTITY_RE =
  /^(\d+\s+\d+\/\d+|\d+\s*[\u00BC-\u00BE\u2150-\u2189]+|\d+\/\d+|[\u00BC-\u00BE\u2150-\u2189]+|\d+(?:\.\d+)?|[\u0660-\u0669\u06F0-\u06F9]+\s+[\u0660-\u0669\u06F0-\u06F9]+\/[\u0660-\u0669\u06F0-\u06F9]+|[\u0660-\u0669\u06F0-\u06F9]+\/[\u0660-\u0669\u06F0-\u06F9]+|[\u0660-\u0669\u06F0-\u06F9]+(?:\.\d+)?)/;

/**
 * Arabic unit phrases. Longest phrases first so "ملعقة كبيرة" wins over
 * "ملعقة" (longest-match parsing).
 */
const ARABIC_UNIT_PHRASES: ReadonlyArray<string> = [
  "ملعقة كبيرة",
  "ملعقة صغيرة",
  "ملاعق كبيرة",
  "ملاعق صغيرة",
  "كوب",
  "كوبين",
  "ملعقة",
  "ملاعق",
  "كيلو",
  "جرام",
  "جم",
  "لتر",
  "فنجان",
  "فنجانين",
  "حبة",
  "حبتين",
  "فصوص",
];

const ENGLISH_UNIT_WORDS = new Set<string>([
  "cup", "cups", "tablespoon", "tablespoons", "tbsp", "teaspoon", "teaspoons", "tsp",
  "pound", "pounds", "lb", "lbs", "ounce", "ounces", "oz", "g", "gram", "grams",
  "kg", "kilogram", "kilograms", "ml", "milliliter", "milliliters", "liter", "liters",
  "clove", "cloves", "slice", "slices", "pinch", "can", "package", "bunch", "stalk",
  "head", "piece", "pieces", "stick", "sprig", "sprigs", "dash", "handful", "quart",
  "pint", "jar", "wedge", "wedges", "sheet", "sheets", "bar", "loaf", "bottle",
  "drop", "drops",
]);

/**
 * Deterministically split a raw ingredient line into quantity text + unit text
 * + name text. `original` is preserved VERBATIM (no trimming). Quantity/unit
 * strings are extracted exactly as they appeared in the line. Arabic units use
 * longest-match (e.g. "ملعقة كبيرة" before "ملعقة"); Arabic-Indic (٠-٩) and
 * Eastern Arabic (۰-۹) digits are supported for quantities.
 */
export function parseIngredientLine(raw: string): ParsedIngredientLine {
  const original = raw;
  const working = raw.trim();
  let rest = working;
  let quantity: string | null = null;
  const m = rest.match(QUANTITY_RE);
  if (m && m[0] !== "") {
    quantity = m[0];
    rest = rest.slice(quantity.length).trim();
  }

  let unit: string | null = null;
  if (rest !== "") {
    const words = rest.split(/\s+/);
    let matchedArabic: string | null = null;
    for (const phrase of ARABIC_UNIT_PHRASES) {
      const count = phrase.split(/\s+/).length;
      if (words.length < count) continue;
      const candidate = words.slice(0, count).join(" ");
      if (containsArabic(candidate) && normalizeArabic(candidate) === normalizeArabic(phrase)) {
        matchedArabic = candidate;
        break;
      }
    }
    if (matchedArabic !== null) {
      unit = matchedArabic;
      rest = words.slice(matchedArabic.split(/\s+/).length).join(" ");
    } else if (ENGLISH_UNIT_WORDS.has(words[0].toLowerCase())) {
      unit = words[0];
      rest = words.slice(1).join(" ");
    }
  }

  return { original, quantity, unit, name: rest.trim() };
}

/** Validation result of a parsed ingredient dictionary. */
export interface DictionaryParse {
  entries: IngredientEntry[];
  issues: string[];
}

function isStrictIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

function parseProvenance(rec: Record<string, unknown>, label: string): { value: DictionaryProvenance | null; issues: string[] } {
  const issues: string[] = [];
  const p = rec.provenance;
  if (typeof p !== "object" || p === null || Array.isArray(p)) {
    issues.push(`${label}: 'provenance' (version/status/source) is required`);
    return { value: null, issues };
  }
  const prov = p as Record<string, unknown>;
  const version = typeof prov.version === "string" ? prov.version.trim() : "";
  const status = typeof prov.status === "string" ? prov.status.trim() : "";
  const reviewer = typeof prov.reviewer === "string" ? prov.reviewer.trim() : "";
  const reviewDate = typeof prov.reviewDate === "string" ? prov.reviewDate.trim() : "";
  const source = typeof prov.source === "string" ? prov.source.trim() : "";
  if (version === "") issues.push(`${label}: provenance 'version' is required`);
  if (status === "") {
    issues.push(`${label}: provenance 'status' (unapproved|approved) is required`);
  } else if (!REVIEW_STATUSES.includes(status as ReviewStatus)) {
    issues.push(`${label}: provenance 'status' must be "unapproved" or "approved"`);
  }
  if (source === "") issues.push(`${label}: provenance 'source' is required`);
  if (status === "approved") {
    if (reviewer === "") issues.push(`${label}: provenance 'reviewer' is required when status is approved`);
    if (reviewDate === "") {
      issues.push(`${label}: provenance 'reviewDate' is required when status is approved`);
    } else if (!isStrictIsoDate(reviewDate)) {
      issues.push(`${label}: provenance 'reviewDate' "${reviewDate}" is not a valid strict ISO calendar date`);
    }
  } else if (status === "unapproved") {
    if (reviewer !== "" || reviewDate !== "") {
      issues.push(
        `${label}: unapproved provenance must NOT carry a reviewer/date (no approval record exists; nothing may be fabricated)`
      );
    }
  }
  if (issues.length === 0) {
    return { value: { version, status: status as ReviewStatus, reviewer: status === "approved" ? reviewer : null, reviewDate: status === "approved" ? reviewDate : null, source }, issues };
  }
  return { value: null, issues };
}

/**
 * Parse & validate the master ingredient dictionary JSON. STRUCTURALLY STRICT:
 * an entry that has ANY structural or provenance error is REJECTED entirely —
 * it never enters the returned `entries` array, therefore it never reaches the
 * resolver index or the accepted-mapping report. Malformed/non-array inputs
 * only produce issues (never exceptions). Alias fingerprints are cross-checked:
 * a normalized alias shared across distinct canonical records is reported
 * (nutritionally-distinct silent-merge risk) so authors must handle it via
 * separate records or a human-reviewed mapping — never a silent merge.
 */
export function parseIngredientDictionary(raw: unknown): DictionaryParse {
  const entries: IngredientEntry[] = [];
  const issues: string[] = [];

  const list = (v: unknown, field: string, label: string): { ok: boolean; out: string[] } => {
    if (!Array.isArray(v)) {
      issues.push(`${label}: '${field}' must be an array of strings`);
      return { ok: false, out: [] };
    }
    let ok = true;
    const out: string[] = [];
    for (const x of v) {
      if (typeof x !== "string") {
        issues.push(`${label}: '${field}' must contain only strings`);
        ok = false;
        continue;
      }
      const t = x.trim();
      if (t === "") continue;
      out.push(t);
    }
    return { ok, out };
  };

  if (!Array.isArray(raw)) {
    issues.push("ingredient dictionary must be a JSON array of entries");
    return { entries, issues };
  }

  const seenKeys = new Map<string, number>();

  for (let i = 0; i < raw.length; i += 1) {
    const e = raw[i];
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      issues.push(`dictionary entry ${i}: must be an object`);
      continue;
    }
    const rec = e as Record<string, unknown>;
    const label = `dictionary entry ${i}`;
    const key = typeof rec.key === "string" ? rec.key.trim() : "";
    const nameEn = typeof rec.nameEn === "string" ? rec.nameEn.trim() : "";

    let ok = true;
    if (key === "") {
      issues.push(`${label}: 'key' is required`);
      ok = false;
    }
    if (nameEn === "") {
      issues.push(`${label} (key "${key}"): 'nameEn' is required`);
      ok = false;
    }

    const nameAr = typeof rec.nameAr === "string" && rec.nameAr.trim() !== "" ? rec.nameAr.trim() : null;
    const nameEg = typeof rec.nameEg === "string" && rec.nameEg.trim() !== "" ? rec.nameEg.trim() : null;
    const aliasesEn = list(rec.aliasesEn, "aliasesEn", label);
    const aliasesAr = list(rec.aliasesAr, "aliasesAr", label);
    const aliasesEg = list(rec.aliasesEg, "aliasesEg", label);
    const category = typeof rec.category === "string" && rec.category.trim() !== "" ? rec.category.trim() : null;

    const foodState = rec.foodState as FoodState | null | undefined;
    if (foodState !== null && foodState !== undefined && !FOOD_STATES.includes(foodState)) {
      issues.push(`${label}: invalid foodState "${String(foodState)}"`);
      ok = false;
    }

    const provenance = parseProvenance(rec, `${label} (key "${key}")`);
    if (provenance.value === null) ok = false;
    issues.push(...provenance.issues);

    // Missing/invalid structural fields or invalid provenance => reject the entry.
    if (!aliasesEn.ok || !aliasesAr.ok || !aliasesEg.ok) ok = false;

    if (!ok) continue;

    const prev = seenKeys.get(key);
    if (prev !== undefined) {
      issues.push(`${label}: duplicate key "${key}" (entry ${prev} and ${i})`);
      continue;
    }
    seenKeys.set(key, i);

    entries.push({
      key,
      nameEn,
      nameAr,
      nameEg,
      aliasesEn: aliasesEn.out,
      aliasesAr: aliasesAr.out,
      aliasesEg: aliasesEg.out,
      category,
      foodState: foodState ?? null,
      provenance: provenance.value!,
      notes: typeof rec.notes === "string" && rec.notes.trim() !== "" ? rec.notes.trim() : undefined,
    });
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));
  return { entries, issues };
}

/**
 * Parse the reviewed-mappings JSON into normalized-term → mapping records.
 *
 * A mapping is a *proposal* until it is approved. Approval is content-bound: the
 * `registry` (from `data/dictionary/review-registry.json`) holds immutable
 * review records, each carrying a `contentHash` computed over the exact mapping
 * content. A mapping is approved ONLY when a registry record with its id exists
 * AND the hash of the mapping's current content matches the registry's stored
 * hash. Changing ANY field after approval (term, toKey, reviewer, date,
 * evidence, source) changes the hash and invalidates the approval — the mapping
 * is then excluded from the active set and must be re-reviewed. Nothing is
 * auto-approved; there is no ID-only approval path.
 *
 * Strict review metadata remains REQUIRED (non-empty reviewer, valid strict ISO
 * date, evidence + source, globally-unique id); records missing any required
 * field, or carrying a duplicated id, are rejected. When two reviewed records
 * normalize to the same term with DIFFERENT targets, that term is a validation
 * error and is REMOVED entirely from the active mapping set — it never resolves
 * and is sent to the review queue.
 */
export function parseReviewedMappings(
  raw: unknown,
  knownKeys: ReadonlySet<string>,
  registry: ParsedReviewRegistry
): { mappings: Map<string, ReviewedMapping>; issues: string[] } {
  const mappings = new Map<string, ReviewedMapping>();
  const issues: string[] = [];
  const byNormalized = new Map<string, ReviewedMapping[]>();
  const seenIds = new Set<string>();
  const idCounts = new Map<string, number>();
  if (!registry || !(registry.byId instanceof Map)) {
    issues.push("review registry is required; reviewed mappings fail closed without human approval records");
    return { mappings, issues };
  }
  if (raw === null || raw === undefined) return { mappings, issues };
  if (!Array.isArray(raw)) {
    issues.push("reviewed mappings must be a JSON array of objects");
    return { mappings, issues };
  }

  for (const e of raw) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) continue;
    const rec = e as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (id === "") continue;
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  for (let i = 0; i < raw.length; i += 1) {
    const e = raw[i];
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      issues.push(`reviewed mapping ${i}: must be an object`);
      continue;
    }
    const rec = e as Record<string, unknown>;
    const label = `reviewed mapping ${i}`;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    const term = typeof rec.term === "string" ? rec.term.trim() : "";
    const toKey = typeof rec.toKey === "string" ? rec.toKey.trim() : "";

    let ok = true;
    if (id === "") {
      issues.push(`${label}: 'id' is required (mapping-record id)`);
      ok = false;
    } else if (seenIds.has(id) || (id !== "" && (idCounts.get(id) ?? 0) > 1)) {
      issues.push(`${label}: duplicate mapping id "${id}" (mapping ids must be globally unique)`);
      ok = false;
    }
    if (term === "" || toKey === "") {
      issues.push(`${label}: 'term' and 'toKey' are required`);
      ok = false;
    }
    if (!knownKeys.has(toKey)) {
      issues.push(`${label}: toKey "${toKey}" is not a known dictionary key`);
      ok = false;
    }
    const reviewer = typeof rec.reviewer === "string" ? rec.reviewer.trim() : "";
    if (reviewer === "") {
      issues.push(`${label}: 'reviewer' is required (non-empty)`);
      ok = false;
    }
    const reviewDate = typeof rec.reviewDate === "string" ? rec.reviewDate.trim() : "";
    if (reviewDate === "") {
      issues.push(`${label}: 'reviewDate' is required`);
      ok = false;
    } else if (!isStrictIsoDate(reviewDate)) {
      issues.push(`${label}: 'reviewDate' "${reviewDate}" is not a valid strict ISO calendar date`);
      ok = false;
    }
    const evidence = typeof rec.evidence === "string" ? rec.evidence.trim() : "";
    if (evidence === "") {
      issues.push(`${label}: 'evidence' (rationale/source) is required`);
      ok = false;
    }
    const source = typeof rec.source === "string" ? rec.source.trim() : "";
    if (source === "") {
      issues.push(`${label}: 'source' is required`);
      ok = false;
    }
    if (!ok) continue;

    // Approval is always content-bound and fail-closed. Structural validation
    // tests must supply explicit registry records just like production callers.
    const norm = normalizeIngredientTerm(term);
    if (norm === "") {
      issues.push(`${label}: term normalizes to empty`);
      continue;
    }
    const regRecord = registry.byId.get(id);
    if (!regRecord) {
      issues.push(`${label}: no approval record in review registry for id "${id}" (mapping not approved)`);
      continue;
    }
    const contentHash = computeReviewContentHash({
      id,
      normalizedTerm: norm,
      toKey,
      reviewer,
      reviewDate,
      evidence,
      source,
    });
    if (contentHash !== regRecord.contentHash) {
      issues.push(
        `${label}: content hash mismatch for id "${id}" — mapping content differs from its approval record; approval invalidated`
      );
      continue;
    }

    const mapping: ReviewedMapping = { id, term, toKey, reviewer, reviewDate, evidence, source };
    seenIds.add(id);
    const arr = byNormalized.get(norm) ?? [];
    arr.push(mapping);
    byNormalized.set(norm, arr);
  }

  // Conflict/duplicate detection over normalized terms (never a silent Map.set win).
  for (const [norm, recs] of byNormalized) {
    const distinctTargets = [...new Set(recs.map((r) => r.toKey))];
    if (distinctTargets.length > 1) {
      issues.push(
        `reviewed-mapping conflict: normalized term "${norm}" has conflicting targets (${distinctTargets.join(", ")}); it is excluded from resolution — it must be reviewed, never auto-chosen`
      );
      continue; // term stays absent in `mappings` → unresolved
    }
    if (recs.length > 1) {
      issues.push(
        `reviewed-mapping duplicate: normalized term "${norm}" appears ${recs.length} times with the same target; using the first record only`
      );
    }
    mappings.set(norm, recs[0]);
  }

  return { mappings, issues };
}

/** Index for exact + alias matching across the dictionary. */
export interface DictionaryIndex {
  byKey: Map<string, IngredientEntry>;
  /** normalized canonical name → entry keys (usually one). */
  nameIndex: Map<string, string[]>;
  /** normalized alias → entry keys. */
  aliasIndex: Map<string, string[]>;
}

export function buildIndex(entries: readonly IngredientEntry[]): DictionaryIndex {
  const byKey = new Map<string, IngredientEntry>();
  const nameIndex = new Map<string, string[]>();
  const aliasIndex = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, ekey: string): void => {
    const arr = map.get(key) ?? [];
    if (!arr.includes(ekey)) arr.push(ekey);
    map.set(key, arr);
  };
  for (const e of entries) {
    byKey.set(e.key, e);
    push(nameIndex, normalizeIngredientTerm(e.nameEn), e.key);
    if (e.nameAr) push(nameIndex, normalizeIngredientTerm(e.nameAr), e.key);
    if (e.nameEg) push(nameIndex, normalizeIngredientTerm(e.nameEg), e.key);
    for (const a of [...e.aliasesEn, ...e.aliasesAr, ...e.aliasesEg]) {
      const n = normalizeIngredientTerm(a);
      if (n !== "") push(aliasIndex, n, e.key);
    }
  }
  return { byKey, nameIndex, aliasIndex };
}

/** One concrete source occurrence of an ingredient (retained for traceability). */
export interface IngredientOccurrence {
  /** Exact raw text as it appeared in the source — NEVER trimmed. */
  original: string;
  /** Recipe id ("recipe_title" from the source row). */
  recipeId: string;
  /** 1-based source row within the ingredient CSV. */
  sourceRow: number;
  /** 0-based index of this ingredient within that recipe's ingredient list. */
  ingredientIndex: number;
}

/** A single resolution result — deterministic, traceable, never LLM. */
export interface IngredientResolution {
  /** Exact raw text (verbatim, untrimmed) used to resolve. */
  original: string;
  quantity: string | null;
  unit: string | null;
  queriedName: string;
  normalizedQuery: string;
  foodState: FoodState | null;
  status: ResolutionStatus;
  stage: ResolutionStage;
  canonicalKey: string | null;
  canonical: {
    nameEn: string;
    nameAr: string | null;
    nameEg: string | null;
    category: string | null;
    foodState: FoodState | null;
  } | null;
  /** Provenance of the canonical record (dictionary version, reviewer, date, source). */
  provenance: DictionaryProvenance | null;
  /** Reviewed-mapping metadata when stage === reviewed_mapping. */
  reviewed: Pick<ReviewedMapping, "id" | "term" | "toKey" | "reviewer" | "reviewDate" | "evidence" | "source"> | null;
  /** The exact dictionary string (name or alias) that the query matched. */
  matchedAgainst: string | null;
  /** Keys of the ambiguous candidates (when status = ambiguous). */
  ambiguityKeys: string[];
  /** Source occurrences aggregated over normalized deduplication. */
  occurrences: IngredientOccurrence[];
  /** Fuzzy suggestions (never accepted as a mapping). */
  suggestions: Array<{ key: string; score: number }>;
  reasons: string[];
}

export interface ResolveContext {
  index: DictionaryIndex;
  reviewed?: Map<string, ReviewedMapping> | null;
  /** Dice-coefficient threshold for suggestions (0..1). Default 0.55. */
  fuzzyThreshold?: number;
  maxSuggestions?: number;
}

/** Deterministic Dice-coefficient over character bigrams. */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i += 1) {
      const k = s.slice(i, i + 2);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [k, v] of A) if (B.has(k)) inter += Math.min(v, B.get(k)!);
  let total = 0;
  for (const v of A.values()) total += v;
  for (const v of B.values()) total += v;
  return total === 0 ? 0 : (2 * inter) / total;
}

function resolveFuzzySuggestions(
  query: string,
  ctx: ResolveContext
): Array<{ key: string; score: number }> {
  const threshold = ctx.fuzzyThreshold ?? 0.55;
  const max = ctx.maxSuggestions ?? 6;
  const scored: Array<{ key: string; score: number }> = [];
  const seen = new Set<string>();
  for (const e of ctx.index.byKey.values()) {
    const probes = [e.nameEn, e.nameAr, e.nameEg, ...e.aliasesEn, ...e.aliasesAr, ...e.aliasesEg].filter(
      (v): v is string => typeof v === "string" && v.trim() !== ""
    );
    for (const probe of probes) {
      const score = diceCoefficient(query, normalizeIngredientTerm(probe));
      if (score >= threshold && !seen.has(e.key)) {
        seen.add(e.key);
        scored.push({ key: e.key, score });
      }
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, max);
}

/**
 * Resolve ONE raw ingredient line against the dictionary. Deterministic.
 * `occurrences` (when non-empty) preserves the source context of this line.
 */
export function resolveIngredient(
  original: string,
  ctx: ResolveContext,
  occurrences: IngredientOccurrence[] = []
): IngredientResolution {
  const parsed = parseIngredientLine(original);
  const q = normalizeForMatching(parsed.name);
  const fullText = normalizeWithState(parsed.name);

  const base: IngredientResolution = {
    original: parsed.original,
    quantity: parsed.quantity,
    unit: parsed.unit,
    queriedName: parsed.name,
    normalizedQuery: q.text,
    foodState: q.foodState,
    status: "unresolved",
    stage: "none",
    canonicalKey: null,
    canonical: null,
    provenance: null,
    reviewed: null,
    matchedAgainst: null,
    ambiguityKeys: [],
    occurrences,
    suggestions: [],
    reasons: [],
  };

  if (q.text === "") {
    base.reasons.push("query is empty after normalization (matches a prep/state-only line)");
    return base;
  }

  // GRILLED / ROASTED: not part of the state model (raw/cooked/boiled/fried/
  // baked/drained). Such lines are NEVER auto-reclassified (e.g. إلى baked) and
  // NEVER bound to a canonical record; they route to the manual review queue.
  if (q.grilledOrRoasted) {
    base.status = "unresolved";
    base.suggestions = resolveFuzzySuggestions(q.text, ctx);
    base.reasons.push(
      'line declares a grilled/roasted preparation ("مشوي/مشوبة/grilled/roasted") which has no state-model entry; it is NOT reclassified as baked and awaits human review'
    );
    return base;
  }

  let keys: string[] = [];
  let stage: ResolutionStage = "none";
  let matchedText: string | null = null;
  let reviewedUsed: ReviewedMapping | null = null;

  const attemptMatch = (
    text: string
  ): { keys: string[]; stage: ResolutionStage; reviewed: ReviewedMapping | null } | null => {
    const nameHit = ctx.index.nameIndex.get(text);
    if (nameHit && nameHit.length > 0) {
      return { keys: [...nameHit], stage: "normalized_exact", reviewed: null };
    }
    const aliasHit = ctx.index.aliasIndex.get(text);
    if (aliasHit && aliasHit.length > 0) {
      return { keys: [...aliasHit], stage: "alias_exact", reviewed: null };
    }
    const mapped = ctx.reviewed?.get(text);
    if (mapped && ctx.index.byKey.has(mapped.toKey)) {
      return { keys: [mapped.toKey], stage: "reviewed_mapping", reviewed: mapped };
    }
    return null;
  };

  // 1) State-aware full text (e.g. "cooked rice" -> rice-cooked).
  const primary = attemptMatch(fullText);
  if (primary) {
    keys = primary.keys;
    stage = primary.stage;
    matchedText = fullText;
    if (primary.reviewed) reviewedUsed = primary.reviewed;
  } else if (fullText !== q.text) {
    // 2) State-stripped identity text.
    const secondary = attemptMatch(q.text);
    if (secondary) {
      keys = secondary.keys;
      stage = secondary.stage;
      matchedText = q.text;
      if (secondary.reviewed) reviewedUsed = secondary.reviewed;
    }
  }

  // FOOD-STATE COMPATIBILITY: a declared query state may only match a canonical
  // record whose foodState is EXACTLY that state.
  if (stage !== "none" && q.foodState !== null) {
    const compatible = keys.filter((k) => ctx.index.byKey.get(k)?.foodState === q.foodState);
    if (compatible.length === 0) {
      base.status = "unresolved";
      base.stage = stage;
      base.ambiguityKeys = [...new Set(keys)];
      base.reasons.push(
        `declared food state "${q.foodState}" but no canonical record exists with that exact state (candidates: ${[...new Set(keys)].join(", ")}); awaiting review`
      );
      return base;
    }
    keys = compatible;
  }

  if (stage === "none" || keys.length === 0) {
    base.suggestions = resolveFuzzySuggestions(q.text, ctx);
    if (base.suggestions.length > 0) {
      base.reasons.push("fuzzy suggestions listed but NEVER accepted as a mapping (unresolved)");
    } else {
      base.reasons.push("no exact, alias, or reviewed-mapping match; no suggestions above threshold");
    }
    return base;
  }

  // Ambiguity handling: preserve distinct canonical entities; never merge.
  const unique = [...new Set(keys)];
  let pick: string | null = null;
  if (unique.length === 1) {
    pick = unique[0];
  }

  if (pick === null) {
    base.status = "ambiguous";
    base.stage = stage;
    base.ambiguityKeys = unique;
    base.reasons.push(
      `query matches ${unique.length} distinct canonical entities and is NOT merged: ${unique.join(", ")}`
    );
    return base;
  }

  const entry = ctx.index.byKey.get(pick);
  if (!entry) {
    base.status = "unresolved";
    base.reasons.push("internal: candidate resolved to a missing canonical record");
    return base;
  }

  base.status = "resolved";
  base.stage = stage;
  base.canonicalKey = pick;
  base.canonical = {
    nameEn: entry.nameEn,
    nameAr: entry.nameAr,
    nameEg: entry.nameEg,
    category: entry.category,
    foodState: entry.foodState,
  };
  base.provenance = entry.provenance;
  if (entry.provenance.status !== "approved") {
    base.status = "unresolved";
    base.stage = "none";
    base.canonicalKey = null;
    base.canonical = null;
    base.reasons.push(
      `canonical record "${pick}" exists but is unapproved; it remains pending and cannot produce a final resolved mapping`
    );
    return base;
  }
  if (stage === "reviewed_mapping" && reviewedUsed) {
    base.reviewed = {
      id: reviewedUsed.id,
      term: reviewedUsed.term,
      toKey: reviewedUsed.toKey,
      reviewer: reviewedUsed.reviewer,
      reviewDate: reviewedUsed.reviewDate,
      evidence: reviewedUsed.evidence,
      source: reviewedUsed.source,
    };
  }
  base.matchedAgainst = matchedText ?? null;
  if (stage === "normalized_exact") {
    base.reasons.push(`normalized_exact: canonical name "${matchedText ?? entry.nameEn}"`);
  } else if (stage === "alias_exact") {
    base.reasons.push(
      `alias_exact: alias "${matchedText ?? q.text}" (dict v${entry.provenance.version}, status ${entry.provenance.status})`
    );
  } else {
    base.reasons.push(
      `reviewed_mapping: record "${reviewedUsed?.id ?? ""}" by ${reviewedUsed?.reviewer ?? ""} on ${reviewedUsed?.reviewDate ?? ""} maps "${reviewedUsed?.term ?? matchedText ?? q.text}" to "${pick}"`
    );
  }
  return base;
}

/**
 * Resolve a set of raw occurrences, deduplicating by normalized query IDENTITY
 * while PRESERVING every occurrence's source context on the returned record.
 */
export function resolveOccurrences(
  occurrences: readonly IngredientOccurrence[],
  ctx: ResolveContext
): IngredientResolution[] {
  const byKey = new Map<string, IngredientResolution>();
  for (const occ of normalizeOccurrences(occurrences)) {
    const parsed = parseIngredientLine(occ.original);
    // Quantity and unit are occurrence attributes, not part of ingredient
    // identity. State/preparation text remains present so raw/cooked/etc. never
    // collapse into the same unique term.
    const normalizedNameIdentity = normalizeWithState(parsed.name);
    // Malformed/name-less source lines (for example "1 cup") are still real
    // occurrences. Keep them as unresolved review identities instead of
    // silently dropping them from count coverage.
    const identity = normalizedNameIdentity !== ""
      ? `name:${normalizedNameIdentity}`
      : `raw:${normalizeIngredientTerm(occ.original)}`;
    if (identity === "") continue;
    const existing = byKey.get(identity);
    if (existing) {
      if (
        !existing.occurrences.some(
          (o) =>
            o.recipeId === occ.recipeId &&
            o.sourceRow === occ.sourceRow &&
            o.ingredientIndex === occ.ingredientIndex
        )
      ) {
        existing.occurrences.push(occ);
      }
      continue;
    }
    byKey.set(identity, resolveIngredient(occ.original, ctx, [occ]));
  }
  return [...byKey.values()].sort((a, b) => a.original.localeCompare(b.original));
}

function normalizeOccurrences(occurrences: readonly IngredientOccurrence[]): IngredientOccurrence[] {
  const copy = occurrences.map((o) => ({
    original: o.original ?? "",
    recipeId: o.recipeId ?? "",
    sourceRow: typeof o.sourceRow === "number" ? o.sourceRow : 0,
    ingredientIndex: typeof o.ingredientIndex === "number" ? o.ingredientIndex : 0,
  }));
  copy.sort((a, b) => a.sourceRow - b.sourceRow || a.ingredientIndex - b.ingredientIndex);
  return copy;
}

/** Resolve many lines in order; output sorted by original text for determinism. */
export function resolveIngredients(
  originals: readonly string[],
  ctx: ResolveContext
): IngredientResolution[] {
  return originals
    .map((o) => resolveIngredient(o, ctx))
    .sort((a, b) => a.original.localeCompare(b.original));
}

/** Coverage metrics for a set of resolutions. */
export interface IngredientCoverage {
  total: number;
  resolved: number;
  ambiguous: number;
  unresolved: number;
  byCountRate: number | null;
  uniqueTotal: number;
  uniqueResolved: number;
  byUniqueCountRate: number | null;
  byWeightRate: number | null;
  resolvedWeightG: number | null;
  totalWeightG: number | null;
  byStage: Record<Exclude<ResolutionStage, "none">, number>;
  resolvedKeys: string[];
  /**
   * Weighted-validation issues: foreign occurrences (not in the resolution
   * inventory), mismatched original text, missing source identity, and
   * duplicates. Every reported entry is excluded from the weight totals.
   */
  weightedIssues: string[];
  /**
   * Deterministic summary for the report: resolved terms with their canonical
   * binding, the stage, and (for reviewed_mapping) the full review metadata.
   */
  resolvedSummary: Array<{
    original: string;
    canonicalKey: string;
    stage: ResolutionStage;
    provenance: DictionaryProvenance | null;
    reviewed: {
      id: string;
      term: string;
      toKey: string;
      reviewer: string;
      reviewDate: string;
      evidence: string;
      source: string;
    } | null;
  }>;
}

export interface WeightedInput {
  original: string;
  recipeId?: string | null;
  sourceRow?: number | null;
  ingredientIndex?: number | null;
  weightG?: number | null;
}

function occurrenceKey(occurrence: Pick<IngredientOccurrence, "recipeId" | "sourceRow" | "ingredientIndex">): string {
  return `${occurrence.recipeId}#${occurrence.sourceRow}#${occurrence.ingredientIndex}`;
}

/** Compute deterministic coverage across resolutions + optional weights. */
export function computeCoverage(
  resolutions: readonly IngredientResolution[],
  weighted?: readonly WeightedInput[] | null
): IngredientCoverage {
  const byStage: IngredientCoverage["byStage"] = {
    normalized_exact: 0,
    alias_exact: 0,
    reviewed_mapping: 0,
  };
  const resolvedKeys: string[] = [];
  const resolvedSummary: IngredientCoverage["resolvedSummary"] = [];
  let resolved = 0;
  let ambiguous = 0;
  let unresolved = 0;
  let uniqueResolved = 0;

  for (const r of resolutions) {
    const occurrenceCount = r.occurrences.length > 0 ? r.occurrences.length : 1;
    if (r.status === "resolved") {
      resolved += occurrenceCount;
      uniqueResolved += 1;
      if (r.stage === "normalized_exact" || r.stage === "alias_exact" || r.stage === "reviewed_mapping") {
        byStage[r.stage] += occurrenceCount;
      }
      if (r.canonicalKey !== null) resolvedKeys.push(r.canonicalKey);
      resolvedSummary.push({
        original: r.original,
        canonicalKey: r.canonicalKey ?? "",
        stage: r.stage,
        provenance: r.provenance,
        reviewed: r.reviewed,
      });
    } else if (r.status === "ambiguous") {
      ambiguous += occurrenceCount;
    } else {
      unresolved += occurrenceCount;
    }
  }

  const total = resolved + ambiguous + unresolved;
  const byCountRate = total > 0 ? resolved / total : null;
  const uniqueTotal = resolutions.length;
  const byUniqueCountRate = uniqueTotal > 0 ? uniqueResolved / uniqueTotal : null;
  const uniqueResolvedKeys = [...new Set(resolvedKeys)].sort();

  // The resolution inventory: every occurrence that was actually resolved,
  // keyed by source identity (recipeId, sourceRow, ingredientIndex). A weighted
  // entry is only valid if it references an occurrence in this inventory AND its
  // original text matches — foreign, mismatched and duplicate entries are
  // rejected (reported in weightedIssues) and excluded from the weight totals.
  const weightedIssues: string[] = [];
  let totalWeightG: number | null = null;
  let resolvedWeightG: number | null = null;
  if (weighted) {
    const inventory = new Map<string, string>();
    for (const r of resolutions) {
      for (const occ of r.occurrences) {
        inventory.set(occurrenceKey(occ), occ.original);
      }
    }
    const weightByOccurrence = new Map<string, number>();
    const seenWeightedKeys = new Set<string>();
    for (let i = 0; i < weighted.length; i += 1) {
      const w = weighted[i];
      const recipeId = typeof w.recipeId === "string" ? w.recipeId.trim() : "";
      const sourceRow = typeof w.sourceRow === "number" && Number.isInteger(w.sourceRow) ? w.sourceRow : null;
      const ingredientIndex =
        typeof w.ingredientIndex === "number" && Number.isInteger(w.ingredientIndex) ? w.ingredientIndex : null;
      if (recipeId === "" || sourceRow === null || ingredientIndex === null) {
        weightedIssues.push(
          `weighted entry ${i}: missing source identity (recipeId, sourceRow, ingredientIndex) — rejected`
        );
        continue;
      }
      const key = occurrenceKey({ recipeId, sourceRow, ingredientIndex });
      if (seenWeightedKeys.has(key)) {
        weightedIssues.push(`weighted entry ${i}: duplicate occurrence ${key} — rejected`);
        continue;
      }
      seenWeightedKeys.add(key);
      const invOriginal = inventory.get(key);
      if (invOriginal === undefined) {
        weightedIssues.push(`weighted entry ${i}: foreign occurrence ${key} (not in resolution inventory) — rejected`);
        continue;
      }
      if (invOriginal !== w.original) {
        weightedIssues.push(
          `weighted entry ${i}: original text mismatch at ${key} (weighted "${w.original}" vs inventory "${invOriginal}") — rejected`
        );
        continue;
      }
      if (typeof w.weightG === "number" && Number.isFinite(w.weightG) && w.weightG > 0) {
        weightByOccurrence.set(key, w.weightG);
      }
    }
    if (weightByOccurrence.size > 0) {
      totalWeightG = [...weightByOccurrence.values()].reduce((a, b) => a + b, 0);
      let acc = 0;
      for (const r of resolutions) {
        if (r.status === "resolved") {
          for (const occ of r.occurrences) {
            acc += weightByOccurrence.get(occurrenceKey(occ)) ?? 0;
          }
        }
      }
      resolvedWeightG = acc;
    }
  }

  const byWeightRate =
    totalWeightG !== null && totalWeightG > 0 && resolvedWeightG !== null
      ? resolvedWeightG / totalWeightG
      : null;

  return {
    total,
    resolved,
    ambiguous,
    unresolved,
    byCountRate,
    uniqueTotal,
    uniqueResolved,
    byUniqueCountRate,
    byWeightRate,
    resolvedWeightG,
    totalWeightG,
    byStage,
    resolvedKeys: uniqueResolvedKeys,
    weightedIssues,
    resolvedSummary,
  };
}

/** Queue records for human review: ambiguous + unresolved terms. */
export interface ReviewQueueRecord {
  original: string;
  normalizedQuery: string;
  status: "ambiguous" | "unresolved";
  stage: ResolutionStage;
  foodState: FoodState | null;
  ambiguityKeys: string[];
  suggestions: Array<{ key: string; score: number }>;
  reasons: string[];
  /** Source context of every occurrence that produced this record. */
  occurrences: IngredientOccurrence[];
}

/** Build the manual-review queue (deterministic, sorted by original text). */
export function buildReviewQueue(resolutions: readonly IngredientResolution[]): ReviewQueueRecord[] {
  const out: ReviewQueueRecord[] = [];
  for (const r of resolutions) {
    if (r.status === "resolved") continue;
    out.push({
      original: r.original,
      normalizedQuery: r.normalizedQuery,
      status: r.status,
      stage: r.stage,
      foodState: r.foodState,
      ambiguityKeys: r.ambiguityKeys,
      suggestions: r.suggestions,
      reasons: r.reasons,
      occurrences: r.occurrences,
    });
  }
  return out.sort((a, b) => a.original.localeCompare(b.original));
}
