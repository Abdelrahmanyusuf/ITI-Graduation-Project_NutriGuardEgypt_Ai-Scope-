/**
 * Compliance helpers for Egyptian-scope classification.
 *
 * These helpers formalise a non-negotiable rule for the read-only audit:
 * broad regional tags (Middle Eastern / Mediterranean / Levantine / "Arab" /
 * North African) are NOT evidence of Egyptian cuisine. Only explicit Egyptian
 * signals may feed a positive classification, and the audit never emits a
 * verified status on its own (a human reviewer must decide).
 */

/** Broad regional/cultural tags that must NOT count as Egyptian evidence. */
export const BROAD_TAG_TERMS = [
  "middle eastern",
  "middle east",
  "mediterranean",
  "arab",
  "arabian",
  "north african",
  "levantine",
  "levant",
  "african",
  "north africa",
];

/** Explicit Egyptian indicators that MAY serve as a positive signal. */
export const EGYPT_TERMS = ["egypt", "egyptian", "masri", "masry", "misri", "masrya"];

/** Returns true when a cuisine/tag string is a broad-tag (non-Egyptian-specific). */
export function isBroadRegional(cuisine: string): boolean {
  const t = cuisine.toLowerCase().trim();
  return BROAD_TAG_TERMS.some((term) => t === term || t.includes(term));
}

/** Returns true when a string explicitly references Egypt. */
export function isExplicitEgypt(t: string): boolean {
  const lower = t.toLowerCase();
  return EGYPT_TERMS.some((term) => lower.includes(term));
}