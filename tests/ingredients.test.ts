import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  FOOD_STATES,
  buildIndex,
  buildReviewQueue,
  computeCoverage,
  computeReviewContentHash,
  diceCoefficient,
  normalizeArabic,
  normalizeIngredientTerm,
  parseIngredientDictionary,
  parseIngredientLine,
  parseReviewedMappings,
  parseReviewRegistry,
  resolveIngredient,
  resolveIngredients,
  resolveOccurrences,
  type DictionaryProvenance,
  type IngredientEntry,
  type IngredientOccurrence,
  type ReviewRecord,
} from "../src/domain/ingredients.js";
import { isDictionaryRunValid } from "../src/scripts/resolve-ingredients.js";

const DICT_FILE = "data/dictionary/ingredients.json";
const REVIEWED_FILE = "data/dictionary/reviewed-mappings.json";
const REVIEW_REGISTRY_FILE = "data/dictionary/review-registry.json";

function readJsonFile(file: string): unknown {
  const text = readFileSync(file, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

function loadDictionary(): { entries: IngredientEntry[]; issues: string[] } {
  return parseIngredientDictionary(readJsonFile(DICT_FILE));
}

function loadReviewed(keys: ReadonlySet<string>) {
  const registry = parseReviewRegistry(readJsonFile(REVIEW_REGISTRY_FILE));
  assert.deepEqual(registry.issues, [], `registry issues: ${registry.issues.join("; ")}`);
  return parseReviewedMappings(readJsonFile(REVIEWED_FILE), keys, registry);
}

/** Production context: the real dictionary (all unapproved) + empty reviewed mappings. */
function makeContext() {
  const dict = loadDictionary();
  assert.deepEqual(dict.issues, [], `dictionary load issues: ${dict.issues.join("; ")}`);
  const index = buildIndex(dict.entries);
  const reviewed = loadReviewed(new Set(dict.entries.map((e) => e.key)));
  assert.deepEqual(reviewed.issues, [], `reviewed-mappings issues: ${reviewed.issues.join("; ")}`);
  return { index, reviewed: reviewed.mappings, dict };
}

// ---------------------------------------------------------------------------
// Synthetic APPROVED fixtures (test-only — never production data). These let us
// prove positive resolution (normalized_exact / alias_exact / reviewed_mapping)
// in both English and Arabic, plus content-hash approval and tampering.
// ---------------------------------------------------------------------------

const FIXTURE_REVIEWER = "fixture-reviewer";

function approvedProvenance(): DictionaryProvenance {
  return {
    version: "1.0",
    status: "approved",
    reviewer: FIXTURE_REVIEWER,
    reviewDate: "2026-08-09",
    source: "synthetic Step-5 test fixture (not production data)",
  };
}

function syntheticEntries(): IngredientEntry[] {
  return [
    {
      key: "rice",
      nameEn: "rice",
      nameAr: "أرز",
      nameEg: null,
      aliasesEn: [],
      aliasesAr: ["الأرز", "الرز", "الرز المصري"],
      aliasesEg: [],
      category: "grain",
      foodState: null,
      provenance: approvedProvenance(),
    },
    {
      key: "rice-cooked",
      nameEn: "cooked rice",
      nameAr: "أرز مطبوخ",
      nameEg: null,
      aliasesEn: [],
      aliasesAr: ["الأرز المطبوخ"],
      aliasesEg: [],
      category: "grain",
      foodState: "cooked",
      provenance: approvedProvenance(),
    },
    {
      key: "lentils",
      nameEn: "lentils",
      nameAr: "عدس",
      nameEg: null,
      aliasesEn: [],
      aliasesAr: ["العدس"],
      aliasesEg: [],
      category: "legume",
      foodState: null,
      provenance: approvedProvenance(),
    },
    {
      key: "coriander-leaf",
      nameEn: "coriander leaf",
      nameAr: "كسبرة",
      nameEg: null,
      aliasesEn: ["coriander", "cilantro", "fresh coriander"],
      aliasesAr: [],
      aliasesEg: [],
      category: "herb",
      foodState: null,
      provenance: approvedProvenance(),
    },
    {
      key: "coriander-seed",
      nameEn: "coriander seed",
      nameAr: "كزبرة حب",
      nameEg: null,
      aliasesEn: ["coriander", "ground coriander"],
      aliasesAr: [],
      aliasesEg: [],
      category: "spice",
      foodState: null,
      provenance: approvedProvenance(),
    },
    {
      key: "peas-dried",
      nameEn: "dried peas",
      nameAr: null,
      nameEg: null,
      aliasesEn: ["peas"],
      aliasesAr: [],
      aliasesEg: [],
      category: "legume",
      foodState: null,
      provenance: approvedProvenance(),
    },
    {
      key: "peas-fresh",
      nameEn: "fresh peas",
      nameAr: null,
      nameEg: null,
      aliasesEn: ["peas", "green peas"],
      aliasesAr: [],
      aliasesEg: [],
      category: "legume",
      foodState: null,
      provenance: approvedProvenance(),
    },
    {
      key: "chickpeas",
      nameEn: "chickpeas",
      nameAr: null,
      nameEg: null,
      aliasesEn: ["garbanzo beans"],
      aliasesAr: [],
      aliasesEg: [],
      category: "legume",
      foodState: null,
      provenance: approvedProvenance(),
    },
    {
      key: "egg",
      nameEn: "egg",
      nameAr: "بيضة",
      nameEg: null,
      aliasesEn: ["eggs"],
      aliasesAr: [],
      aliasesEg: [],
      category: "protein",
      foodState: null,
      provenance: approvedProvenance(),
    },
    {
      key: "egg-fried",
      nameEn: "fried egg",
      nameAr: "بيضة مقلية",
      nameEg: null,
      aliasesEn: ["fried eggs"],
      aliasesAr: ["البيضة المقلية"],
      aliasesEg: [],
      category: "protein",
      foodState: "fried",
      provenance: approvedProvenance(),
    },
  ];
}

interface SyntheticMapping {
  id: string;
  term: string;
  toKey: string;
  reviewer: string;
  reviewDate: string;
  evidence: string;
  source: string;
}

function syntheticReviewedMappings(): SyntheticMapping[] {
  return [
    {
      id: "synth-map-red-lentils",
      term: "red lentils",
      toKey: "lentils",
      reviewer: FIXTURE_REVIEWER,
      reviewDate: "2026-08-09",
      evidence: "test fixture: red lentils map to the canonical lentils record",
      source: "synthetic Step-5 test fixture",
    },
    {
      id: "synth-map-arabic-lentils",
      term: "العدس الأحمر",
      toKey: "lentils",
      reviewer: FIXTURE_REVIEWER,
      reviewDate: "2026-08-09",
      evidence: "test fixture: Arabic red lentils map to the canonical lentils record",
      source: "synthetic Step-5 test fixture",
    },
  ];
}

function registryRecordFor(m: SyntheticMapping): ReviewRecord {
  const normalizedTerm = normalizeIngredientTerm(m.term);
  return {
    id: m.id,
    normalizedTerm,
    toKey: m.toKey,
    reviewer: m.reviewer,
    reviewDate: m.reviewDate,
    evidence: m.evidence,
    source: m.source,
    contentHash: computeReviewContentHash({
      id: m.id,
      normalizedTerm,
      toKey: m.toKey,
      reviewer: m.reviewer,
      reviewDate: m.reviewDate,
      evidence: m.evidence,
      source: m.source,
    }),
  };
}

function reviewRegistryFor(mappings: readonly SyntheticMapping[]) {
  return parseReviewRegistry({ records: mappings.map(registryRecordFor) });
}

/** Approved test context: synthetic dictionary + content-hash-approved reviewed mappings. */
function makeApprovedContext() {
  const entries = syntheticEntries();
  const index = buildIndex(entries);
  const knownKeys = new Set(entries.map((e) => e.key));
  const mappings = syntheticReviewedMappings();
  const registry = parseReviewRegistry({ records: mappings.map(registryRecordFor) });
  assert.deepEqual(registry.issues, [], `registry issues: ${registry.issues.join("; ")}`);
  const reviewed = parseReviewedMappings(mappings, knownKeys, registry);
  assert.deepEqual(reviewed.issues, [], `reviewed issues: ${reviewed.issues.join("; ")}`);
  return { index, reviewed: reviewed.mappings, registry };
}

// ---------------------------------------------------------------------------
// Arabic normalization
// ---------------------------------------------------------------------------

test("Arabic normalization folds hamza/alef variants to a single alef", () => {
  assert.equal(normalizeArabic("أرز"), normalizeArabic("ارز"));
  assert.equal(normalizeArabic("أرز"), normalizeArabic("آرز"));
  assert.equal(normalizeArabic("إبريق"), "ابريق");
  assert.equal(normalizeIngredientTerm("الأرز"), normalizeIngredientTerm("الارز"));
});

test("Arabic normalization strips diacritics and folds ta marbuta / alef-maqsura", () => {
  assert.equal(normalizeArabic("باذِنْجَان"), normalizeArabic("باذنجان"));
  assert.equal(normalizeArabic("كسبرة"), normalizeArabic("كسبره"));
  assert.equal(normalizeArabic("كسبرى"), "كسبري", "alef-maqsura folds to yeh (ي)");
  assert.equal(normalizeArabic("بِطاطِس"), "بطاطس");
});

test("Arabic and English terms route to the correct normalizer", () => {
  assert.equal(normalizeIngredientTerm("ARABIC LESS LATIN"), normalizeIngredientTerm("arabic less latin"));
  assert.equal(normalizeIngredientTerm("Aَrabic؟   عسل"), normalizeIngredientTerm("ARABIC?   عسل"), "mixed text is lowered and space-folded");
  assert.equal(normalizeIngredientTerm("عسل"), normalizeIngredientTerm("عسل"), "pure Arabic is normalized on the Arabic path");
});

test("Arabic normalization folds the definite article (ال) so natural forms match", () => {
  assert.equal(normalizeArabic("البيضة"), normalizeArabic("بيضة"), "definite article is grammatical, not semantic");
  assert.equal(normalizeArabic("المقلية"), normalizeArabic("مقلية"));
  assert.equal(normalizeIngredientTerm("البيضة المقلية"), normalizeIngredientTerm("بيضة مقلية"));
});

// ---------------------------------------------------------------------------
// Ingredient-line parsing
// ---------------------------------------------------------------------------

test("parseIngredientLine preserves the original VERBATIM (never trimmed)", () => {
  const p = parseIngredientLine("  2 cups rice  ");
  assert.equal(p.original, "  2 cups rice  ");
  assert.equal(p.quantity, "2");
  assert.equal(p.unit, "cups");
  assert.equal(p.name, "rice");
});

test("parseIngredientLine separates quantity/unit/name for English", () => {
  const p = parseIngredientLine("2 cups rice");
  assert.equal(p.original, "2 cups rice");
  assert.equal(p.quantity, "2");
  assert.equal(p.unit, "cups");
  assert.equal(p.name, "rice");

  const frac = parseIngredientLine("1/2 teaspoon salt");
  assert.equal(frac.quantity, "1/2");
  assert.equal(frac.unit, "teaspoon");
  assert.equal(frac.name, "salt");

  const mixed = parseIngredientLine("1 1/2 pounds chicken");
  assert.equal(mixed.quantity, "1 1/2");
  assert.equal(mixed.unit, "pounds");
  assert.equal(mixed.name, "chicken");

  const bare = parseIngredientLine("onion");
  assert.equal(bare.quantity, null);
  assert.equal(bare.unit, null);
  assert.equal(bare.name, "onion");
});

test("Arabic ingredient lines are parsed with Arabic units", () => {
  const p = parseIngredientLine("2 كوب أرز");
  assert.equal(p.original, "2 كوب أرز");
  assert.equal(p.quantity, "2");
  assert.equal(p.unit, "كوب");
  assert.equal(p.name, "أرز");

  const gram = parseIngredientLine("150 جرام عدس");
  assert.equal(gram.unit, "جرام");
  assert.equal(gram.name, "عدس");
});

test("Arabic unit parsing uses longest-match (ملعقة كبيرة wins over ملعقة)", () => {
  const big = parseIngredientLine("2 ملعقة كبيرة سكر");
  assert.equal(big.unit, "ملعقة كبيرة");
  assert.equal(big.name, "سكر");

  const small = parseIngredientLine("1 ملعقة صغيرة فلفل");
  assert.equal(small.unit, "ملعقة صغيرة");
  assert.equal(small.name, "فلفل");

  const bare = parseIngredientLine("3 ملعقة عسل");
  assert.equal(bare.unit, "ملعقة");
  assert.equal(bare.name, "عسل");
});

test("Arabic-Indic (٠-٩) and Eastern-Arabic (۰-۹) digits are parsed as quantities", () => {
  const ind = parseIngredientLine("٢ كوب أرز");
  assert.equal(ind.quantity, "٢");
  assert.equal(ind.unit, "كوب");

  const eastern = parseIngredientLine("۲ كوب أرز");
  assert.equal(eastern.quantity, "۲");

  const mixed = parseIngredientLine("١/٢ ملعقة صغيرة ملح");
  assert.equal(mixed.quantity, "١/٢");
});

// ---------------------------------------------------------------------------
// Dictionary parsing (production data is unapproved)
// ---------------------------------------------------------------------------

test("dictionary file loads with no issues; production records are unapproved", () => {
  const { entries, issues } = loadDictionary();
  assert.deepEqual(issues, []);
  assert.ok(entries.length >= 20, `expected a meaningful dictionary, got ${entries.length}`);
  for (const e of entries) {
    assert.ok(e.key.trim() !== "");
    assert.ok(e.nameEn.trim() !== "");
    assert.equal(e.provenance.status, "unapproved", `entry ${e.key} must be unapproved`);
    assert.equal(e.provenance.reviewer, null, `entry ${e.key} must not fabricate a reviewer`);
    assert.equal(e.provenance.reviewDate, null, `entry ${e.key} must not fabricate a review date`);
    assert.ok(e.provenance.source.trim() !== "", `entry ${e.key} must carry a source`);
    if (e.foodState !== null) assert.ok(FOOD_STATES.includes(e.foodState));
  }
  const keys = entries.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, "keys are unique");
});

test("production unapproved records stay unresolved (never silently approved)", () => {
  const ctx = makeContext();
  const rice = resolveIngredient("rice", ctx);
  assert.equal(rice.status, "unresolved");
  assert.equal(rice.canonicalKey, null);
  assert.ok(rice.reasons.some((x) => x.includes("unapproved")));
});

test("dictionary validation rejects duplicate keys, invalid food states, and missing provenance", () => {
  const { entries, issues } = parseIngredientDictionary([
    {
      key: "x",
      nameEn: "x",
      aliasesEn: [],
      aliasesAr: [],
      aliasesEg: [],
      category: null,
      foodState: null,
      provenance: { version: "1.0", status: "approved", reviewer: "r", reviewDate: "2026-08-09", source: "s" },
    },
    {
      key: "x",
      nameEn: "y",
      aliasesEn: [],
      aliasesAr: [],
      aliasesEg: [],
      category: null,
      foodState: null,
      provenance: { version: "1.0", status: "approved", reviewer: "r", reviewDate: "2026-08-09", source: "s" },
    },
    {
      key: "z",
      nameEn: "z",
      aliasesEn: [],
      aliasesAr: [],
      aliasesEg: [],
      category: null,
      foodState: "crispy",
      provenance: { version: "1.0", status: "approved", reviewer: "r", reviewDate: "2026-08-09", source: "s" },
    },
    { key: "", nameEn: "empty", aliasesEn: [], aliasesAr: [], aliasesEg: [], category: null, foodState: null },
    {
      key: "noprov",
      nameEn: "no provenance",
      aliasesEn: [],
      aliasesAr: [],
      aliasesEg: [],
      category: null,
      foodState: null,
    },
  ]);
  assert.ok(issues.some((i) => i.includes("duplicate key")));
  assert.ok(issues.some((i) => i.includes("invalid foodState")));
  assert.ok(issues.some((i) => i.includes("'key' is required")));
  assert.ok(issues.some((i) => i.includes("'provenance'")), "missing provenance is a validation issue");
  // Strict: an entry with ANY structural or provenance error is rejected entirely.
  // Only the first `x` survives; z (bad foodState), empty-key and noprov (no provenance) are out.
  assert.equal(entries.length, 1, "only the valid first x entry survives strict validation");
});

test("unapproved provenance must not carry a reviewer or date (no fabrication)", () => {
  const { entries, issues } = parseIngredientDictionary([
    {
      key: "fab",
      nameEn: "fab",
      aliasesEn: [],
      aliasesAr: [],
      aliasesEg: [],
      category: null,
      foodState: null,
      provenance: { version: "1.0", status: "unapproved", reviewer: "someone", reviewDate: "2026-08-09", source: "s" },
    },
  ]);
  assert.ok(issues.some((i) => i.includes("unapproved provenance must NOT carry a reviewer/date")));
  assert.equal(entries.length, 0, "fabricated approval metadata rejects the entry");
});

// ---------------------------------------------------------------------------
// Reviewed-mapping structural validation (always fail-closed through a registry)
// ---------------------------------------------------------------------------

function validMapping(over: Partial<SyntheticMapping> = {}): SyntheticMapping {
  return {
    id: "reviewed-map-test-001",
    term: "red lentils",
    toKey: "lentils",
    reviewer: FIXTURE_REVIEWER,
    reviewDate: "2026-08-09",
    evidence: "Color variant of the same lentil entity.",
    source: "test fixture",
    ...over,
  };
}

test("reviewed mappings require id/reviewer/reviewDate/evidence/source", () => {
  const keys = new Set(["lentils"]);
  const r = parseReviewedMappings(
    [{ term: "red lentils", toKey: "lentils" }],
    keys,
    parseReviewRegistry({ records: [] })
  );
  assert.ok(r.issues.some((i) => i.includes("'id' is required")));
  assert.ok(r.issues.some((i) => i.includes("'reviewer' is required")));
  assert.ok(r.issues.some((i) => i.includes("'reviewDate' is required")));
  assert.ok(r.issues.some((i) => i.includes("'evidence'")));
  assert.ok(r.issues.some((i) => i.includes("'source' is required")));
  assert.equal(r.mappings.size, 0);
});

test("reviewed mappings reject invalid strict ISO dates and unknown toKeys", () => {
  const keys = new Set(["lentils"]);
  const emptyRegistry = parseReviewRegistry({ records: [] });
  const badDate = parseReviewedMappings([validMapping({ reviewDate: "2026-02-30" })], keys, emptyRegistry);
  assert.ok(badDate.issues.some((i) => i.includes("not a valid strict ISO calendar date")));
  assert.equal(badDate.mappings.size, 0);

  const badKey = parseReviewedMappings([validMapping({ toKey: "not-a-key" })], keys, emptyRegistry);
  assert.ok(badKey.issues.some((i) => i.includes("not a known dictionary key")));
  assert.equal(badKey.mappings.size, 0);
});

test("conflicting reviewed mappings for the same normalized term are excluded, never silently chosen", () => {
  const keys = new Set(["rice", "lentils"]);
  const mappings = [
    validMapping({ id: "a", term: "mix", toKey: "rice" }),
    validMapping({ id: "b", term: "mix", toKey: "lentils" }),
  ];
  const r = parseReviewedMappings(
    mappings,
    keys,
    reviewRegistryFor(mappings)
  );
  assert.ok(r.issues.some((i) => i.includes("conflicting targets") && i.includes("never auto-chosen")));
  assert.equal(r.mappings.has("mix"), false, "conflicted term is absent from the active mapping set");
});

test("duplicate reviewed mappings with the same target warn and use the first record", () => {
  const keys = new Set(["lentils"]);
  const mappings = [
    validMapping({ id: "a", term: "dupe", toKey: "lentils" }),
    validMapping({ id: "b", term: "dupe", toKey: "lentils" }),
  ];
  const r = parseReviewedMappings(
    mappings,
    keys,
    reviewRegistryFor(mappings)
  );
  assert.ok(r.issues.some((i) => i.includes("duplicate") && i.includes("first record")));
  assert.equal(r.mappings.get("dupe")?.id, "a");
});

// ---------------------------------------------------------------------------
// Review registry: content-hash approval + adversarial tampering
// ---------------------------------------------------------------------------

test("computeReviewContentHash is deterministic and content-sensitive", () => {
  const fields = {
    id: "m1",
    normalizedTerm: "red lentils",
    toKey: "lentils",
    reviewer: FIXTURE_REVIEWER,
    reviewDate: "2026-08-09",
    evidence: "e",
    source: "s",
  };
  const a = computeReviewContentHash(fields);
  const b = computeReviewContentHash(fields);
  assert.equal(a, b, "same content → same hash");
  assert.match(a, /^[a-f0-9]{64}$/, "review fingerprints must be SHA-256 hex");
  assert.notEqual(
    a,
    computeReviewContentHash({ ...fields, toKey: "rice" }),
    "changing toKey changes the hash"
  );
  assert.notEqual(
    a,
    computeReviewContentHash({ ...fields, reviewer: "someone-else" }),
    "changing reviewer changes the hash"
  );
  assert.notEqual(
    a,
    computeReviewContentHash({ ...fields, normalizedTerm: "green lentils" }),
    "changing normalizedTerm changes the hash"
  );
});

test("parseReviewRegistry verifies each record's stored hash (registry tamper detection)", () => {
  const good = registryRecordFor(syntheticReviewedMappings()[0]);
  const ok = parseReviewRegistry({ records: [good] });
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.records.length, 1);
  assert.ok(ok.byId.has(good.id));

  // Tamper the stored hash → rejected.
  const tamperedHash = parseReviewRegistry({ records: [{ ...good, contentHash: "00000000" }] });
  assert.ok(tamperedHash.issues.some((i) => i.includes("tampered")));
  assert.equal(tamperedHash.records.length, 0);

  // Tamper a content field but keep the old hash → rejected (approval invalidated).
  const tamperedContent = parseReviewRegistry({ records: [{ ...good, toKey: "rice" }] });
  assert.ok(tamperedContent.issues.some((i) => i.includes("tampered")));
  assert.equal(tamperedContent.records.length, 0);
});

test("parseReviewRegistry rejects missing fields, bad dates and duplicate ids", () => {
  const base = registryRecordFor(syntheticReviewedMappings()[0]);
  const missing = parseReviewRegistry({ records: [{ ...base, reviewer: "" }] });
  assert.ok(missing.issues.some((i) => i.includes("'reviewer' is required")));
  assert.equal(missing.records.length, 0);

  const badDate = parseReviewRegistry({ records: [{ ...base, reviewDate: "2026-02-30" }] });
  assert.ok(badDate.issues.some((i) => i.includes("not a valid strict ISO calendar date")));

  const dup = parseReviewRegistry({ records: [base, base] });
  assert.ok(dup.issues.some((i) => i.includes("duplicate registry id")));
  assert.equal(dup.records.length, 0, "all records with a duplicate id must be rejected");
  assert.equal(dup.byId.has(base.id), false, "a duplicate id must never remain active");
});

test("reviewed mappings fail closed when the review registry is omitted", () => {
  const result = parseReviewedMappings([validMapping()], new Set(["lentils"]), undefined as never);
  assert.equal(result.mappings.size, 0);
  assert.ok(result.issues.some((issue) => issue.includes("review registry is required")));
});

test("run validity rejects dictionary, mapping, registry, occurrence, and weighted-coverage issues", () => {
  const valid = {
    dictionaryIssues: [] as string[],
    reviewedMappingIssues: [] as string[],
    reviewRegistryIssues: [] as string[],
    occurrenceCoverageIssues: [] as string[],
    weightedCoverageIssues: [] as string[],
  };
  assert.equal(isDictionaryRunValid(valid), true);
  for (const field of Object.keys(valid) as Array<keyof typeof valid>) {
    assert.equal(
      isDictionaryRunValid({ ...valid, [field]: ["invalid"] }),
      false,
      `${field} must make the run invalid`
    );
  }
});

test("a mapping is approved only when its content hash matches the registry record", () => {
  const entries = syntheticEntries();
  const knownKeys = new Set(entries.map((e) => e.key));
  const mappings = syntheticReviewedMappings();
  const registry = parseReviewRegistry({ records: mappings.map(registryRecordFor) });

  // Correct content → approved and active.
  const approved = parseReviewedMappings(mappings, knownKeys, registry);
  assert.equal(approved.mappings.size, 2, "both mappings approved via content hash");

  // Tamper a mapping's toKey after approval → hash mismatch → approval invalidated.
  const tampered = parseReviewedMappings(
    [{ ...mappings[0], toKey: "rice" }],
    knownKeys,
    registry
  );
  assert.ok(tampered.issues.some((i) => i.includes("approval invalidated")));
  assert.equal(tampered.mappings.size, 0);

  // Unknown id (no registry record) → not approved.
  const unknown = parseReviewedMappings([{ ...mappings[0], id: "not-in-registry" }], knownKeys, registry);
  assert.ok(unknown.issues.some((i) => i.includes("not approved")));
  assert.equal(unknown.mappings.size, 0);
});

// ---------------------------------------------------------------------------
// Positive resolution with synthetic APPROVED fixtures (EN + AR)
// ---------------------------------------------------------------------------

test("resolves canonical English names via normalized_exact (rice, lentils)", () => {
  const ctx = makeApprovedContext();
  const rice = resolveIngredient("rice", ctx);
  assert.equal(rice.status, "resolved");
  assert.equal(rice.stage, "normalized_exact");
  assert.equal(rice.canonicalKey, "rice");
  const lentils = resolveIngredient("lentils", ctx);
  assert.equal(lentils.status, "resolved");
  assert.equal(lentils.canonicalKey, "lentils");
});

test("resolves canonical Arabic names via normalized_exact (أرز, عدس)", () => {
  const ctx = makeApprovedContext();
  const rice = resolveIngredient("أرز", ctx);
  assert.equal(rice.status, "resolved");
  assert.equal(rice.canonicalKey, "rice");
  const lentils = resolveIngredient("عدس", ctx);
  assert.equal(lentils.status, "resolved");
  assert.equal(lentils.canonicalKey, "lentils");
});

test("resolves English quantity/unit lines to the canonical record", () => {
  const ctx = makeApprovedContext();
  const r = resolveIngredient("2 cups rice", ctx);
  assert.equal(r.status, "resolved");
  assert.equal(r.canonicalKey, "rice");
  assert.equal(r.quantity, "2");
  assert.equal(r.unit, "cups");
});

test("resolves English via alias_exact (cilantro, garbanzo beans)", () => {
  const ctx = makeApprovedContext();
  const t = resolveIngredient("cilantro", ctx);
  assert.equal(t.status, "resolved");
  assert.equal(t.stage, "alias_exact");
  assert.equal(t.canonicalKey, "coriander-leaf");
  const cc = resolveIngredient("garbanzo beans", ctx);
  assert.equal(cc.status, "resolved");
  assert.equal(cc.canonicalKey, "chickpeas");
});

test("resolves Arabic via alias_exact (الرز المصري → rice)", () => {
  const ctx = makeApprovedContext();
  // "الرز المصري" (Egyptian rice) is a distinct alias — it does not equal the
  // canonical name "أرز", so it must match via alias_exact, not normalized_exact.
  const r = resolveIngredient("الرز المصري", ctx);
  assert.equal(r.status, "resolved");
  assert.equal(r.stage, "alias_exact");
  assert.equal(r.canonicalKey, "rice");
});

test("resolves a reviewed_mapping in English (red lentils → lentils)", () => {
  const ctx = makeApprovedContext();
  const mapped = resolveIngredient("red lentils", ctx);
  assert.equal(mapped.status, "resolved");
  assert.equal(mapped.stage, "reviewed_mapping");
  assert.equal(mapped.canonicalKey, "lentils");
  assert.ok(mapped.reviewed, "reviewed mapping metadata must be surfaced");
  assert.equal(mapped.reviewed?.id, "synth-map-red-lentils");
  assert.ok(mapped.reviewed?.reviewer && mapped.reviewed.evidence && mapped.reviewed.source);
});

test("resolves a reviewed_mapping in Arabic (العدس الأحمر → lentils)", () => {
  const ctx = makeApprovedContext();
  const mapped = resolveIngredient("العدس الأحمر", ctx);
  assert.equal(mapped.status, "resolved");
  assert.equal(mapped.stage, "reviewed_mapping");
  assert.equal(mapped.canonicalKey, "lentils");
  assert.equal(mapped.reviewed?.id, "synth-map-arabic-lentils");
});

// ---------------------------------------------------------------------------
// Ambiguity: never merged
// ---------------------------------------------------------------------------

test("coriander alone is ambiguous (leaves vs seeds) and is NOT merged", () => {
  const ctx = makeApprovedContext();
  const r = resolveIngredient("coriander", ctx);
  assert.equal(r.status, "ambiguous");
  assert.deepEqual([...r.ambiguityKeys].sort(), ["coriander-leaf", "coriander-seed"]);
  assert.ok(r.reasons.some((x) => x.includes("NOT merged")));
  assert.equal(r.canonicalKey, null);

  const leaves = resolveIngredient("fresh coriander", ctx);
  assert.equal(leaves.status, "resolved");
  assert.equal(leaves.canonicalKey, "coriander-leaf");
  const seeds = resolveIngredient("ground coriander", ctx);
  assert.equal(seeds.status, "resolved");
  assert.equal(seeds.canonicalKey, "coriander-seed");
});

test("dried peas vs fresh peas stay separate (ambiguous base, resolved with qualifier)", () => {
  const ctx = makeApprovedContext();
  const bare = resolveIngredient("peas", ctx);
  assert.equal(bare.status, "ambiguous");
  assert.deepEqual([...bare.ambiguityKeys].sort(), ["peas-dried", "peas-fresh"]);

  const dry = resolveIngredient("dried peas", ctx);
  assert.equal(dry.status, "resolved");
  assert.equal(dry.canonicalKey, "peas-dried");
  const fresh = resolveIngredient("green peas", ctx);
  assert.equal(fresh.status, "resolved");
  assert.equal(fresh.canonicalKey, "peas-fresh");
});

// ---------------------------------------------------------------------------
// Food states (enforced, never merged) incl. Arabic definite-article forms
// ---------------------------------------------------------------------------

test("food-state words are recorded separately and route to the exact-state record", () => {
  const ctx = makeApprovedContext();
  const fried = resolveIngredient("2 fried eggs", ctx);
  assert.equal(fried.status, "resolved");
  assert.equal(fried.canonicalKey, "egg-fried");
  assert.equal(fried.foodState, "fried");
  const raw = resolveIngredient("2 eggs", ctx);
  assert.equal(raw.canonicalKey, "egg");
  assert.equal(raw.foodState, null);
  assert.notEqual(raw.canonicalKey, fried.canonicalKey);
});

test("cooked rice resolves to the cooked-state record via the state-aware pass", () => {
  const ctx = makeApprovedContext();
  const r = resolveIngredient("1 cup cooked rice", ctx);
  assert.equal(r.status, "resolved");
  assert.equal(r.canonicalKey, "rice-cooked");
  assert.equal(r.foodState, "cooked");
});

test("declared food state with no exact-state record stays unresolved (never downgraded)", () => {
  const ctx = makeApprovedContext();
  const boiled = resolveIngredient("boiled lentils", ctx);
  assert.equal(boiled.status, "unresolved");
  assert.ok(boiled.reasons.some((x) => x.includes("no canonical record exists with that exact state")));
});

test("drained is never a synonym for dried (dried peas vs drained peas)", () => {
  const ctx = makeApprovedContext();
  const drained = resolveIngredient("drained peas", ctx);
  assert.notEqual(drained.canonicalKey, "peas-dried");
  assert.equal(drained.status, "unresolved", "no canonical record has foodState=drained for peas");
});

test("Arabic definite-article food-state forms resolve without merging states", () => {
  const ctx = makeApprovedContext();
  // "البيضة المقلية" (the fried egg) and "بيضة مقلية" (fried egg) both → egg-fried.
  const definite = resolveIngredient("البيضة المقلية", ctx);
  assert.equal(definite.status, "resolved");
  assert.equal(definite.canonicalKey, "egg-fried");
  assert.equal(definite.foodState, "fried");
  const bare = resolveIngredient("بيضة مقلية", ctx);
  assert.equal(bare.status, "resolved");
  assert.equal(bare.canonicalKey, "egg-fried");
  // But plain "بيضة" (egg) must NOT merge into the fried-state record.
  const plain = resolveIngredient("بيضة", ctx);
  assert.equal(plain.canonicalKey, "egg");
  assert.equal(plain.foodState, null);
  assert.notEqual(plain.canonicalKey, definite.canonicalKey);
});

// ---------------------------------------------------------------------------
// Provenance surfacing
// ---------------------------------------------------------------------------

test("resolved records surface canonical provenance; reviewed_mapping surfaces review metadata", () => {
  const ctx = makeApprovedContext();
  const alias = resolveIngredient("cilantro", ctx);
  assert.equal(alias.status, "resolved");
  assert.ok(alias.provenance && alias.provenance.reviewer?.trim() !== "" && alias.provenance.version !== "");
  assert.equal(alias.provenance.status, "approved");

  const mapped = resolveIngredient("red lentils", ctx);
  assert.equal(mapped.status, "resolved");
  assert.equal(mapped.stage, "reviewed_mapping");
  assert.equal(mapped.canonicalKey, "lentils");
  assert.ok(mapped.reviewed && mapped.reviewed.id && mapped.reviewed.reviewer && mapped.reviewed.evidence);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("resolution is deterministic across repeated calls", () => {
  const ctx = makeApprovedContext();
  const a = resolveIngredients(["2 cups rice", "coriander", "بيضة مقلية", "red lentils", "dried peas"], ctx);
  const b = resolveIngredients(["2 cups rice", "coriander", "بيضة مقلية", "red lentils", "dried peas"], ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test("diceCoefficient behaves sanely", () => {
  assert.equal(diceCoefficient("rice", "rice"), 1);
  assert.ok(diceCoefficient("rice", "nice") > diceCoefficient("rice", "pasta"));
});

// ---------------------------------------------------------------------------
// Occurrences: every source context preserved
// ---------------------------------------------------------------------------

test("resolveOccurrences dedupes by identity while preserving every occurrence", () => {
  const ctx = makeApprovedContext();
  const occs: IngredientOccurrence[] = [
    { original: "2 cups rice", recipeId: "Recipe A", sourceRow: 2, ingredientIndex: 0 },
    { original: "2 cups rice", recipeId: "Recipe B", sourceRow: 9, ingredientIndex: 1 },
    { original: "coriander", recipeId: "Recipe A", sourceRow: 3, ingredientIndex: 0 },
  ];
  const res = resolveOccurrences(occs, ctx);
  const rice = res.find((r) => r.original === "2 cups rice");
  assert.ok(rice);
  assert.equal(rice.status, "resolved");
  assert.equal(rice.canonicalKey, "rice");
  assert.equal(rice.occurrences.length, 2);
  assert.deepEqual(
    rice.occurrences.map((o) => o.recipeId),
    ["Recipe A", "Recipe B"]
  );

  const cor = res.find((r) => r.original === "coriander");
  assert.ok(cor);
  assert.equal(cor.status, "ambiguous");
  assert.equal(cor.occurrences.length, 1);
  assert.equal(cor.occurrences[0].recipeId, "Recipe A");
});

test("resolveOccurrences ignores quantity/unit for identity and retains the full source identity", () => {
  const ctx = makeApprovedContext();
  const occs: IngredientOccurrence[] = [
    { original: "1 cup rice", recipeId: "Recipe A", sourceRow: 2, ingredientIndex: 0 },
    { original: "2 cups rice", recipeId: "Recipe B", sourceRow: 2, ingredientIndex: 0 },
  ];
  const resolutions = resolveOccurrences(occs, ctx);
  assert.equal(resolutions.length, 1, "quantities and units must not create distinct ingredient identities");
  assert.equal(resolutions[0].normalizedQuery, "rice");
  assert.equal(resolutions[0].occurrences.length, 2, "recipeId is part of source occurrence identity");
  assert.deepEqual(resolutions[0].occurrences.map((o) => o.original), ["1 cup rice", "2 cups rice"]);

  const coverage = computeCoverage(resolutions);
  assert.equal(coverage.total, 2, "coverage by count still counts every occurrence");
  assert.equal(coverage.uniqueTotal, 1, "unique coverage counts the ingredient identity, not quantity variants");
});

test("resolveOccurrences never drops name-less source lines from count coverage", () => {
  const ctx = makeApprovedContext();
  const occurrences: IngredientOccurrence[] = [
    { original: "1 cup", recipeId: "Recipe A", sourceRow: 2, ingredientIndex: 0 },
    { original: "2 cups", recipeId: "Recipe B", sourceRow: 3, ingredientIndex: 0 },
  ];
  const resolutions = resolveOccurrences(occurrences, ctx);
  const coverage = computeCoverage(resolutions);
  assert.equal(coverage.total, occurrences.length);
  assert.equal(coverage.unresolved, occurrences.length);
  assert.ok(resolutions.every((resolution) => resolution.status === "unresolved"));
});

test("review queue records carry their occurrence context", () => {
  const ctx = makeApprovedContext();
  const occs: IngredientOccurrence[] = [
    { original: "coriander", recipeId: "Recipe A", sourceRow: 4, ingredientIndex: 0 },
    { original: "notthere", recipeId: "Recipe B", sourceRow: 5, ingredientIndex: 2 },
  ];
  const queue = buildReviewQueue(resolveOccurrences(occs, ctx));
  assert.equal(queue.length, 2);
  for (const rec of queue) {
    assert.ok(rec.occurrences.length >= 1, "review records must preserve source context");
  }
});

// ---------------------------------------------------------------------------
// Coverage: occurrence-based + unique-term reported separately
// ---------------------------------------------------------------------------

test("coverage is occurrence-based; unique-term coverage reported separately", () => {
  const ctx = makeApprovedContext();
  const occs: IngredientOccurrence[] = [
    { original: "rice", recipeId: "R", sourceRow: 1, ingredientIndex: 0 },
    { original: "rice", recipeId: "R", sourceRow: 1, ingredientIndex: 1 },
    { original: "coriander", recipeId: "R", sourceRow: 1, ingredientIndex: 2 },
    { original: "notthere", recipeId: "R", sourceRow: 1, ingredientIndex: 3 },
  ];
  const res = resolveOccurrences(occs, ctx);
  const cov = computeCoverage(res);
  assert.equal(cov.total, 4, "total counts occurrences");
  assert.equal(cov.resolved, 2, "rice appears twice (2 resolved occurrences)");
  assert.equal(cov.ambiguous, 1, "coriander is ambiguous");
  assert.equal(cov.unresolved, 1, "notthere is unresolved");
  assert.equal(cov.uniqueTotal, 3, "rice, coriander, notthere = 3 unique terms");
  assert.equal(cov.uniqueResolved, 1, "only rice resolves uniquely");
  assert.ok(Math.abs(cov.byCountRate! - 2 / 4) < 1e-9);
  assert.ok(Math.abs(cov.byUniqueCountRate! - 1 / 3) < 1e-9);
});

test("coverage without weights records honest nulls, never a fabricated 0", () => {
  const ctx = makeApprovedContext();
  const resolutions = ["rice", "notthere"].map((t) => resolveIngredient(t, ctx));
  const cov = computeCoverage(resolutions);
  assert.equal(cov.totalWeightG, null);
  assert.equal(cov.resolvedWeightG, null);
  assert.equal(cov.byWeightRate, null);
});

// ---------------------------------------------------------------------------
// Weighted coverage validation (foreign / mismatched / duplicate / missing id)
// ---------------------------------------------------------------------------

test("weighted coverage validates each entry against the resolution inventory", () => {
  const ctx = makeApprovedContext();
  const occs: IngredientOccurrence[] = [
    { original: "rice", recipeId: "R", sourceRow: 1, ingredientIndex: 0 },
    { original: "lentils", recipeId: "R", sourceRow: 1, ingredientIndex: 1 },
    { original: "notthere", recipeId: "R", sourceRow: 1, ingredientIndex: 2 },
  ];
  const res = resolveOccurrences(occs, ctx);
  const cov = computeCoverage(res, [
    { original: "rice", recipeId: "R", sourceRow: 1, ingredientIndex: 0, weightG: 200 },
    { original: "lentils", recipeId: "R", sourceRow: 1, ingredientIndex: 1, weightG: 100 },
    { original: "notthere", recipeId: "R", sourceRow: 1, ingredientIndex: 2, weightG: 50 },
  ]);
  assert.equal(cov.totalWeightG, 350);
  assert.equal(cov.resolvedWeightG, 300, "rice(200)+lentils(100); notthere unresolved");
  assert.ok(Math.abs(cov.byWeightRate! - 300 / 350) < 1e-9);
  assert.deepEqual(cov.weightedIssues, [], "all entries valid");
});

test("weighted coverage rejects foreign occurrences (not in inventory)", () => {
  const ctx = makeApprovedContext();
  const occs: IngredientOccurrence[] = [{ original: "rice", recipeId: "R", sourceRow: 1, ingredientIndex: 0 }];
  const res = resolveOccurrences(occs, ctx);
  const cov = computeCoverage(res, [
    { original: "rice", recipeId: "R", sourceRow: 1, ingredientIndex: 0, weightG: 200 },
    { original: "rice", recipeId: "OTHER", sourceRow: 9, ingredientIndex: 0, weightG: 999 },
  ]);
  assert.equal(cov.totalWeightG, 200, "foreign entry excluded from total");
  assert.equal(cov.resolvedWeightG, 200);
  assert.equal(cov.weightedIssues.length, 1);
  assert.ok(cov.weightedIssues[0].includes("foreign"));
});

test("weighted coverage rejects mismatched original text", () => {
  const ctx = makeApprovedContext();
  const occs: IngredientOccurrence[] = [{ original: "rice", recipeId: "R", sourceRow: 1, ingredientIndex: 0 }];
  const res = resolveOccurrences(occs, ctx);
  const cov = computeCoverage(res, [{ original: "lentils", recipeId: "R", sourceRow: 1, ingredientIndex: 0, weightG: 200 }]);
  assert.equal(cov.totalWeightG, null, "mismatched entry excluded → no valid weights");
  assert.equal(cov.weightedIssues.length, 1);
  assert.ok(cov.weightedIssues[0].includes("mismatch"));
});

test("weighted coverage rejects duplicate and missing-identity entries", () => {
  const ctx = makeApprovedContext();
  const occs: IngredientOccurrence[] = [{ original: "rice", recipeId: "R", sourceRow: 1, ingredientIndex: 0 }];
  const res = resolveOccurrences(occs, ctx);
  const cov = computeCoverage(res, [
    { original: "rice", recipeId: "R", sourceRow: 1, ingredientIndex: 0, weightG: 200 },
    { original: "rice", recipeId: "R", sourceRow: 1, ingredientIndex: 0, weightG: 300 },
    { original: "rice", weightG: 50 },
  ]);
  assert.equal(cov.totalWeightG, 200, "only the first valid entry counts");
  assert.equal(cov.weightedIssues.length, 2, "one duplicate + one missing identity");
  assert.ok(cov.weightedIssues.some((i) => i.includes("duplicate")));
  assert.ok(cov.weightedIssues.some((i) => i.includes("missing source identity")));
});

// ---------------------------------------------------------------------------
// Review queue + resolved summary
// ---------------------------------------------------------------------------

test("review queue carries ambiguous + unresolved only, sorted deterministically", () => {
  const ctx = makeApprovedContext();
  const originals = ["peas", "coriander", "rice", "notthere"];
  const resolutions = originals.map((t) => resolveIngredient(t, ctx));
  const queue = buildReviewQueue(resolutions);
  assert.equal(queue.length, 3);
  assert.ok(queue.every((r) => r.status === "ambiguous" || r.status === "unresolved"));
  assert.ok(queue.some((r) => r.status === "ambiguous" && r.ambiguityKeys.includes("peas-dried")));
  assert.ok(queue.some((r) => r.status === "unresolved" && r.original === "notthere"));
  assert.deepEqual(
    queue.map((r) => r.original),
    [...queue.map((r) => r.original)].sort(),
    "queue is sorted by original text"
  );
});

test("coverage resolvedSummary traces stage, key, original, and review metadata (no LLM in the loop)", () => {
  const ctx = makeApprovedContext();
  const resolutions = ["cilantro", "dried peas", "red lentils", "peas"].map((t) => resolveIngredient(t, ctx));
  const cov = computeCoverage(resolutions);
  for (const s of cov.resolvedSummary) {
    assert.ok(typeof s.canonicalKey === "string" && s.canonicalKey !== "");
    assert.ok(["normalized_exact", "alias_exact", "reviewed_mapping"].includes(s.stage));
  }
  const mapped = cov.resolvedSummary.find((s) => s.stage === "reviewed_mapping");
  assert.ok(mapped, "reviewed_mapping must appear in the summary");
  assert.ok(mapped.reviewed && mapped.reviewed.id && mapped.reviewed.reviewer && mapped.reviewed.evidence);
  assert.equal(cov.resolvedSummary.length, 3);
});
