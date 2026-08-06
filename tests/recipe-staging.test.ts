import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createHash } from "node:crypto";

import {
  STAGING_SCHEMA_VERSION,
  applyReviewDecision,
  computeRowFingerprint,
  generateStableRecipeId,
  isEligibleForVerifiedDataset,
  latestHumanEvent,
  validateStagedRecipe,
  validateStagingRegistry,
  type RecordLicense,
  type RecipeSourceRef,
  type StagedRecipe,
} from "../src/domain/recipes.js";
import { parseManifest, type Manifest } from "../src/domain/manifest.js";
import { stageRecipes } from "../src/scripts/stage-recipes.js";

const CSV_FILE = "data/raw/Recipes For Eqyption Food.csv";
const FIXTURE_SOURCE_ID = "recipes-csv-fixture";

/** Full manifest as a Manifest object (camelCase) for in-memory use. */
function buildManifest(overrides: { sourceApproved?: boolean } = {}): Manifest {
  const approved = overrides.sourceApproved ?? true;
  return {
    schemaVersion: "1.0",
    sources: [
      {
        file: CSV_FILE,
        sourceId: FIXTURE_SOURCE_ID,
        sourceName: "Fixture recipes",
        sourceUrl: "https://example.test/fixtures",
        title: "Fixture recipes",
        visibleDate: "2026-08-01",
        sourceVersion: "v1",
        accessDate: "2026-08-01",
        license: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        reviewStatus: approved ? "approved" : "pending",
        reviewedBy: approved ? "fixture-reviewer" : null,
        reviewDate: approved ? "2026-08-01" : null,
        licenseReviewStatus: approved ? "approved" : null,
        licenseReviewedBy: approved ? "fixture-reviewer" : null,
        licenseReviewDate: approved ? "2026-08-01" : null,
        evidenceIds: [],
      },
      {
        file: "data/raw/WHO Guidelines.pdf",
        sourceId: "who-healthy-diet-factsheet-2026",
        sourceName: "WHO",
        sourceUrl: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
        title: "Healthy diet",
        visibleDate: "26 January 2026",
        sourceVersion: "v1",
        accessDate: "2026-01-26",
        license: null,
        licenseUrl: null,
        reviewStatus: "pending",
        reviewedBy: null,
        reviewDate: null,
        licenseReviewStatus: null,
        licenseReviewedBy: null,
        licenseReviewDate: null,
        evidenceIds: ["EG-REF-WHO-001"],
      },
    ],
    evidenceReferences: [
      {
        id: "EG-KOSHARI-CULTURAL-001",
        purpose: "egyptian_recipe_cultural_evidence",
        applicableTo: ["koshari", "kushari"],
      },
      {
        id: "EG-KOSHARI-CULTURAL-002",
        purpose: "egyptian_recipe_cultural_evidence",
        applicableTo: ["molokhia"],
      },
      {
        id: "EG-REF-WHO-001",
        purpose: "guideline_provenance",
        applicableTo: [],
      },
    ],
  };
}

/** Manifest serialized to JSON (snake_case) for writing to sources.json. */
function buildManifestJSON(overrides: { sourceApproved?: boolean } = {}): object {
  const approved = overrides.sourceApproved ?? true;
  return {
    schemaVersion: "1.0",
    sources: [
      {
        file: CSV_FILE,
        source_id: FIXTURE_SOURCE_ID,
        source_name: "Fixture recipes",
        source_url: "https://example.test/fixtures",
        title: "Fixture recipes",
        visible_date: "2026-08-01",
        source_version: "v1",
        access_date: "2026-08-01",
        license: "CC BY 4.0",
        license_url: "https://creativecommons.org/licenses/by/4.0/",
        review_status: approved ? "approved" : "pending",
        reviewed_by: approved ? "fixture-reviewer" : null,
        review_date: approved ? "2026-08-01" : null,
        license_review_status: approved ? "approved" : null,
        license_reviewed_by: approved ? "fixture-reviewer" : null,
        license_review_date: approved ? "2026-08-01" : null,
        evidence_ids: [],
      },
      {
        file: "data/raw/WHO Guidelines.pdf",
        source_id: "who-healthy-diet-factsheet-2026",
        source_name: "WHO",
        source_url: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
        title: "Healthy diet",
        visible_date: "26 January 2026",
        source_version: "v1",
        access_date: "2026-01-26",
        license: null,
        license_url: null,
        review_status: "pending",
        reviewed_by: null,
        review_date: null,
        license_review_status: null,
        license_reviewed_by: null,
        license_review_date: null,
        evidence_ids: ["EG-REF-WHO-001"],
      },
    ],
    evidenceReferences: [
      {
        id: "EG-KOSHARI-CULTURAL-001",
        purpose: "egyptian_recipe_cultural_evidence",
        applicableTo: ["koshari", "kushari"],
      },
      {
        id: "EG-KOSHARI-CULTURAL-002",
        purpose: "egyptian_recipe_cultural_evidence",
        applicableTo: ["molokhia"],
      },
      {
        id: "EG-REF-WHO-001",
        purpose: "guideline_provenance",
        applicableTo: [],
      },
    ],
  };
}

const FULL_MANIFEST = buildManifest();

function makeSource(overrides: Partial<RecipeSourceRef> = {}): RecipeSourceRef {
  return {
    sourceId: FIXTURE_SOURCE_ID,
    sourceFile: CSV_FILE,
    sourceRow: 2,
    sourceVersion: "v1",
    accessDate: "2026-08-01",
    url: "https://example.test/fixtures",
    ...overrides,
  };
}

function makeLicense(status: RecordLicense["status"] = "not_assessed"): RecordLicense {
  return {
    status,
    id: status === "approved" ? FIXTURE_SOURCE_ID : null,
    url: status === "approved" ? "https://creativecommons.org/licenses/by/4.0/" : null,
    note: null,
  };
}

function makeRecipe(overrides: Partial<StagedRecipe> = {}): StagedRecipe {
  const base: StagedRecipe = {
    recipeId: generateStableRecipeId(CSV_FILE, 2, "Koshari"),
    names: { ar: "كشري", en: "Koshari", eg: null, aliases: ["kushari"] },
    category: "main",
    subcategory: null,
    region: null,
    yield: { servings: null, finalCookedWeightG: null },
    source: makeSource(),
    license: makeLicense(),
    verificationStatus: "needs_review",
    review: {
      decision: "unreviewed",
      reviewerId: null,
      reviewDate: null,
      evidenceIds: [],
      rationale: null,
      autoRejected: false,
      snapshotFingerprint: null,
      staleReason: null,
      timeline: [
        {
          at: null,
          actor: "pipeline",
          action: "imported_as_needs_review",
          status: "needs_review",
          note: "Egyptian-scope evidence: dish_name_match=koshari",
          evidenceIds: [],
        },
      ],
    },
    version: STAGING_SCHEMA_VERSION,
    original: { recipe_title: "Koshari", cuisine_list: '["Egyptian"]' },
    originalTitle: "Koshari",
    notes: ["automated import from raw source; original row preserved verbatim"],
    sourceFingerprint: "fp-koshari-row-2",
  };
  return { ...base, ...overrides, review: { ...base.review, ...(overrides.review ?? {}) } };
}

/** A structurally complete, human-verified record with approved provenance+license. */
function makeVerifiedRecipe(overrides: Partial<StagedRecipe> = {}): StagedRecipe {
  const base = makeRecipe({
    verificationStatus: "verified",
    license: makeLicense("approved"),
    review: {
      decision: "verified",
      reviewerId: "reviewer-1",
      reviewDate: "2026-08-06",
      evidenceIds: ["EG-KOSHARI-CULTURAL-001"],
      rationale: "documented cultural reference",
      autoRejected: false,
      snapshotFingerprint: "fp-koshari-row-2",
      staleReason: null,
      timeline: [
        {
          at: null,
          actor: "pipeline",
          action: "imported_as_needs_review",
          status: "needs_review",
          note: "Egyptian-scope evidence: dish_name_match=koshari",
          evidenceIds: [],
        },
        {
          at: "2026-08-06",
          actor: "reviewer-1",
          action: "human_verified",
          status: "verified",
          note: "documented cultural reference",
          evidenceIds: ["EG-KOSHARI-CULTURAL-001"],
        },
      ],
    },
  });
  return { ...base, ...overrides, review: { ...base.review, ...(overrides.review ?? {}) } };
}

test("stable recipe IDs are deterministic and distinct per source row", () => {
  const a1 = generateStableRecipeId("data/raw/x.csv", 2, "Koshari Egyptian");
  const a2 = generateStableRecipeId("data/raw/x.csv", 2, "Koshari Egyptian");
  assert.equal(a1, a2);
  assert.match(a1, /^EGR-[0-9A-F]{16}$/);
  const b = generateStableRecipeId("data/raw/x.csv", 3, "Koshari Egyptian");
  const c = generateStableRecipeId("data/raw/y.csv", 2, "Koshari Egyptian");
  assert.notEqual(a1, b);
  assert.notEqual(a1, c);
});

test("validation: every staged recipe requires a stable ID and a source reference", () => {
  const r = makeRecipe();
  assert.deepEqual(validateStagedRecipe(r, FULL_MANIFEST), []);
  assert.ok(validateStagedRecipe({ ...r, recipeId: "not-an-id" }, FULL_MANIFEST).some((i) => i.includes("recipeId")));
  assert.ok(validateStagedRecipe({ ...r, source: makeSource({ sourceId: "" }) }, FULL_MANIFEST).some((i) => i.includes("source.sourceId")));
  assert.ok(validateStagedRecipe({ ...r, source: makeSource({ sourceFile: "  " }) }, FULL_MANIFEST).some((i) => i.includes("source.sourceFile")));
});

test("validation: invalid verification statuses are rejected", () => {
  const r = makeRecipe();
  const bad = validateStagedRecipe({ ...r, verificationStatus: "verified_final" as never }, FULL_MANIFEST);
  assert.ok(bad.some((i) => i.includes("verificationStatus")));
  assert.ok(
    validateStagedRecipe({ ...r, verificationStatus: "verified", review: { ...r.review, decision: "unreviewed" } }, FULL_MANIFEST).some((i) =>
      i.includes("requires verificationStatus")
    )
  );
});

test("validation: an unverifiable recipe (verified without reviewer/date/evidence/human event) is rejected", () => {
  const r = makeRecipe();
  const verified = {
    ...r,
    verificationStatus: "verified" as const,
    review: {
      ...r.review,
      decision: "verified" as const,
      reviewerId: null,
      reviewDate: null,
      evidenceIds: [],
    },
  };
  const issues = validateStagedRecipe(verified, FULL_MANIFEST);
  assert.ok(issues.some((i) => i.includes("unverifiable") && i.includes("reviewerId")));
  assert.ok(issues.some((i) => i.includes("unverifiable") && i.includes("reviewDate")));
  assert.ok(issues.some((i) => i.includes("unverifiable") && i.includes("evidence")));
  assert.ok(issues.some((i) => i.includes("no human decision event")), "verified with pipeline-only timeline must fail");
});

test("validation: Arabic names must be valid UTF-8; mojibake fails", () => {
  assert.deepEqual(validateStagedRecipe(makeRecipe(), FULL_MANIFEST), []);
  const mojibake = makeRecipe({ names: { ar: "ÙƒØ´Ø±ÙŠ", en: "Koshari", eg: null, aliases: [] } });
  assert.ok(validateStagedRecipe(mojibake, FULL_MANIFEST).some((i) => i.includes("mojibake")));
  const blank = makeRecipe({ names: { ar: "   ", en: "Koshari", eg: null, aliases: [] } });
  assert.ok(validateStagedRecipe(blank, FULL_MANIFEST).some((i) => i.includes("non-empty")));
});

test("validation: duplicate IDs across the registry are detected", () => {
  const a = makeRecipe();
  const b = makeRecipe({ recipeId: a.recipeId });
  const v = validateStagingRegistry([a, b], FULL_MANIFEST);
  assert.deepEqual(v.duplicateIds, [a.recipeId]);
  assert.equal(v.valid, false);
});

test("validation: never invented zeros — servings/weight must be null or positive", () => {
  assert.deepEqual(validateStagedRecipe(makeRecipe(), FULL_MANIFEST), []);
  const zeroServings = makeRecipe({ yield: { servings: 0, finalCookedWeightG: null } });
  assert.ok(validateStagedRecipe(zeroServings, FULL_MANIFEST).some((i) => i.includes("servings")));
  const negativeWeight = makeRecipe({ yield: { servings: null, finalCookedWeightG: -5 } });
  assert.ok(validateStagedRecipe(negativeWeight, FULL_MANIFEST).some((i) => i.includes("finalCookedWeightG")));
});

test("evidence: nonexistent evidence IDs are rejected (a)", () => {
  const r = makeVerifiedRecipe({ review: { ...makeVerifiedRecipe().review, evidenceIds: ["EG-NOT-IN-MANIFEST"] } });
  const issues = validateStagedRecipe(r, FULL_MANIFEST);
  assert.ok(issues.some((i) => i.includes("not found")));
  assert.equal(isEligibleForVerifiedDataset(r, FULL_MANIFEST).eligible, false);
});

test("evidence: guideline-provenance IDs are rejected (b)", () => {
  const r = makeVerifiedRecipe({ review: { ...makeVerifiedRecipe().review, evidenceIds: ["EG-REF-WHO-001"] } });
  const issues = validateStagedRecipe(r, FULL_MANIFEST);
  assert.ok(issues.some((i) => i.includes("not cultural evidence")));
});

test("evidence: cultural IDs scoped to another dish are rejected (c)", () => {
  const r = makeVerifiedRecipe({ review: { ...makeVerifiedRecipe().review, evidenceIds: ["EG-KOSHARI-CULTURAL-002"] } });
  const issues = validateStagedRecipe(r, FULL_MANIFEST);
  assert.ok(issues.some((i) => i.includes("not applicable")));
});

test("evidence: blank-after-trim evidence fails; whitespace around a valid ID is trimmed (d)", () => {
  const blank = makeVerifiedRecipe({ review: { ...makeVerifiedRecipe().review, evidenceIds: ["   "] } });
  const issues = validateStagedRecipe(blank, FULL_MANIFEST);
  assert.ok(issues.some((i) => i.includes("non-blank")));
  assert.ok(issues.some((i) => i.includes("lacks documented evidence")));

  const padded = makeVerifiedRecipe({
    review: {
      ...makeVerifiedRecipe().review,
      evidenceIds: ["  EG-KOSHARI-CULTURAL-001  "],
      timeline: [
        ...makeVerifiedRecipe().review.timeline.filter((t) => t.action !== "human_verified"),
        {
          at: "2026-08-06",
          actor: "reviewer-1",
          action: "human_verified",
          status: "verified",
          note: "documented cultural reference",
          evidenceIds: ["EG-KOSHARI-CULTURAL-001"],
        },
      ],
    },
  });
  assert.deepEqual(validateStagedRecipe(padded, FULL_MANIFEST), []);
});

test("evidence: URL references require valid http(s) AND a non-empty rationale", () => {
  const url = "https://example.test/documented-reference";
  const good = makeVerifiedRecipe({
    review: {
      ...makeVerifiedRecipe().review,
      evidenceIds: [url],
      timeline: [
        {
          at: null,
          actor: "pipeline",
          action: "imported_as_needs_review",
          status: "needs_review",
          note: "Egyptian-scope evidence: dish_name_match=koshari",
          evidenceIds: [],
        },
        {
          at: "2026-08-06",
          actor: "reviewer-1",
          action: "human_verified",
          status: "verified",
          note: "documented cultural reference",
          evidenceIds: [url],
        },
      ],
    },
  });
  assert.deepEqual(validateStagedRecipe(good, FULL_MANIFEST), []);
  const noRationale = makeVerifiedRecipe({
    review: {
      ...makeVerifiedRecipe().review,
      evidenceIds: [url],
      rationale: "   ",
      timeline: [
        {
          at: null,
          actor: "pipeline",
          action: "imported_as_needs_review",
          status: "needs_review",
          note: "Egyptian-scope evidence: dish_name_match=koshari",
          evidenceIds: [],
        },
        {
          at: "2026-08-06",
          actor: "reviewer-1",
          action: "human_verified",
          status: "verified",
          note: "documented cultural reference",
          evidenceIds: [url],
        },
      ],
    },
  });
  assert.ok(validateStagedRecipe(noRationale, FULL_MANIFEST).some((i) => i.includes("rationale")));
  const badScheme = makeVerifiedRecipe({
    review: {
      ...makeVerifiedRecipe().review,
      evidenceIds: ["ftp://example.test/x"],
      timeline: [
        {
          at: null,
          actor: "pipeline",
          action: "imported_as_needs_review",
          status: "needs_review",
          note: "Egyptian-scope evidence: dish_name_match=koshari",
          evidenceIds: [],
        },
        {
          at: "2026-08-06",
          actor: "reviewer-1",
          action: "human_verified",
          status: "verified",
          note: "documented cultural reference",
          evidenceIds: ["ftp://example.test/x"],
        },
      ],
    },
  });
  assert.ok(validateStagedRecipe(badScheme, FULL_MANIFEST).some((i) => i.includes("not a valid http(s) URL")));
});

test("license: approved status without manifest backing fails (e)", () => {
  const approvedManually = makeVerifiedRecipe({
    license: makeLicense("approved"),
    source: makeSource({ sourceId: "data/raw/SomeOther.csv", sourceFile: "data/raw/SomeOther.csv" }),
  });
  const noRecord = validateStagedRecipe(approvedManually, FULL_MANIFEST);
  assert.ok(noRecord.some((i) => i.includes("not backed by any source record")));

  const pendingManifest = buildManifest({ sourceApproved: false });
  const againstPending = validateStagedRecipe(makeVerifiedRecipe(), pendingManifest);
  assert.ok(againstPending.some((i) => i.includes("license review is not approved")));
  assert.equal(isEligibleForVerifiedDataset(makeVerifiedRecipe(), pendingManifest).eligible, false);
});

test("verified: a record with no matching human timeline event fails (f)", () => {
  const noHumanEvent = makeVerifiedRecipe({
    review: { ...makeVerifiedRecipe().review, timeline: makeVerifiedRecipe().review.timeline.filter((t) => t.action !== "human_verified") },
  });
  const issues = validateStagedRecipe(noHumanEvent, FULL_MANIFEST);
  assert.ok(issues.some((i) => i.includes("no human decision event")));
});

test("rejection: blank human rejection reasons fail (g)", () => {
  const r = makeRecipe();
  const bad = applyReviewDecision(
    r,
    { decision: "rejected", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: [], rationale: "   " },
    FULL_MANIFEST
  );
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.ok(bad.errors.some((e) => e.toLowerCase().includes("rejection reasons")));

  // A record with a blank human_rejected event note also fails validation.
  const blankEvent = makeVerifiedRecipe({
    verificationStatus: "rejected",
    review: {
      decision: "rejected",
      reviewerId: "reviewer-1",
      reviewDate: "2026-08-06",
      evidenceIds: [],
      rationale: "   ",
      autoRejected: false,
      snapshotFingerprint: "fp-koshari-row-2",
      staleReason: null,
      timeline: [
        { at: null, actor: "pipeline", action: "imported_as_needs_review", status: "needs_review", note: "import", evidenceIds: [] },
        { at: "2026-08-06", actor: "reviewer-1", action: "human_rejected", status: "rejected", note: "   ", evidenceIds: [] },
      ],
    },
  });
  assert.ok(validateStagedRecipe(blankEvent, FULL_MANIFEST).some((i) => i.includes("note must be non-empty")));
});

test("review recorder: human verification requires reviewer + ISO date + manifest-valid evidence + rationale", () => {
  const r = makeRecipe();
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: " ", reviewDate: "2026-08-06", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "x" }, FULL_MANIFEST).ok, false);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-02-30", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "x" }, FULL_MANIFEST).ok, false);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: [], rationale: "x" }, FULL_MANIFEST).ok, false);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["EG-MISSING-001"], rationale: "x" }, FULL_MANIFEST).ok, false);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["EG-REF-WHO-001"], rationale: "x" }, FULL_MANIFEST).ok, false);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["EG-KOSHARI-CULTURAL-002"], rationale: "x" }, FULL_MANIFEST).ok, false);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["  "], rationale: "x" }, FULL_MANIFEST).ok, false);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["https://example.test/ref"], rationale: " " }, FULL_MANIFEST).ok, false);

  // URL evidence with rationale is accepted; IDs are trimmed and deduplicated.
  const ok = applyReviewDecision(
    r,
    { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["  https://example.test/ref  "], rationale: "consulted a documented public reference" },
    FULL_MANIFEST
  );
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.recipe.verificationStatus, "verified");
  assert.deepEqual(ok.recipe.review.evidenceIds, ["https://example.test/ref"]);
  assert.equal(ok.recipe.review.reviewerId, "reviewer-1");
  assert.equal(ok.recipe.review.decision, "verified");
  assert.equal(ok.recipe.review.snapshotFingerprint, r.sourceFingerprint, "review binds to the reviewed source fingerprint");
  assert.equal(ok.recipe.review.staleReason, null);
  assert.equal(ok.recipe.review.timeline.length, 2);
  assert.equal(ok.recipe.review.timeline[1].action, "human_verified");
  assert.deepEqual(ok.recipe.review.timeline[1].evidenceIds, ["https://example.test/ref"]);
  assert.equal(r.verificationStatus, "needs_review", "the original record object was not mutated");
});

test("MVP gate: unreviewed/needs_review records are never eligible", () => {
  const g = isEligibleForVerifiedDataset(makeRecipe(), FULL_MANIFEST);
  assert.equal(g.eligible, false);
  assert.ok(g.blockers.some((b) => b.includes("not verified")));
});

test("MVP gate: a fully verified+attributed+licensed+manifest-backed record is eligible (positive)", () => {
  const r = makeVerifiedRecipe();
  assert.deepEqual(validateStagedRecipe(r, FULL_MANIFEST), []);
  const g = isEligibleForVerifiedDataset(r, FULL_MANIFEST);
  assert.equal(g.eligible, true);
  assert.deepEqual(g.blockers, []);
});

test("MVP gate: verified but unlicensed or unattributed is blocked", () => {
  const base = makeVerifiedRecipe();
  const unlicensed = { ...base, license: makeLicense("not_assessed") };
  const noReviewer = makeVerifiedRecipe({ review: { ...base.review, reviewerId: null } });
  assert.equal(isEligibleForVerifiedDataset(unlicensed, FULL_MANIFEST).eligible, false);
  assert.ok(isEligibleForVerifiedDataset(unlicensed, FULL_MANIFEST).blockers.some((b) => b.includes("license")));
  assert.ok(isEligibleForVerifiedDataset(noReviewer, FULL_MANIFEST).blockers.some((b) => b.includes("reviewer")));
});

test("defensive: malformed registry objects yield issues, never crashes (j)", () => {
  const garbage: unknown[] = [null, 42, "koshari", { recipeId: "EGR-0123456789ABCDEF" }, [], { names: "x", review: null, source: "s", license: 5, verificationStatus: "weird" }];
  const v = validateStagingRegistry(garbage, FULL_MANIFEST);
  assert.equal(v.valid, false);
  assert.ok(v.issues.some((x) => x.issues.some((i) => i.includes("malformed registry entry"))));
  assert.ok(v.issues.some((x) => x.recipeId === "EGR-0123456789ABCDEF"));

  assert.ok(validateStagedRecipe(null as unknown as StagedRecipe, FULL_MANIFEST).length > 0);
  assert.ok(
    validateStagedRecipe({ names: "x", review: null, source: "s", license: 5, verificationStatus: "weird" } as unknown as StagedRecipe, FULL_MANIFEST).length > 0
  );
  const badTimeline = makeRecipe({ review: { ...makeRecipe().review, timeline: [null as never] } });
  assert.ok(validateStagedRecipe(badTimeline, FULL_MANIFEST).some((i) => i.includes("timeline[0]")));
});

const FIXTURE_HEADER =
  "recipe_title\tcategory\tsubcategory\tdescription\tingredients\tdirections\tingredients_canonical\tcuisine_list\tmain_ingredient\tegy_ingredient_coverage\n";

const FIXTURE_ROWS = [
  '"Koshari Egyptian"\t"main"\t""\t"classic"\t"[""lentils"", ""rice""]"\t"[""boil lentils"", ""serve""]"\t"[""lentils"", ""rice""]"\t"[""Egyptian""]"\t""\t"1"\n',
  '"Spaghetti Bolognese"\t"main"\t""\t""\t"[""pasta"", ""beef""]"\t"[""cook""]"\t"[""pasta"", ""beef""]"\t"[""Italian""]"\t""\t"0"\n',
  '"Hummus Dip"\t"appetizer"\t""\t""\t"[""chickpeas""]"\t"[""blend""]"\t"[""chickpeas""]"\t"[""Middle Eastern""]"\t""\t"0"\n',
  '"Broken Row"\t"main"\n',
];

async function buildStagingRoot(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, "data", "manifest"), { recursive: true });
  await fs.mkdir(path.join(dir, "data", "raw"), { recursive: true });
  await fs.mkdir(path.join(dir, "data", "processed"), { recursive: true });
  await fs.writeFile(path.join(dir, "data", "manifest", "sources.json"), JSON.stringify(buildManifestJSON(), null, 2));
  await fs.writeFile(path.join(dir, "data", "raw", "Recipes For Eqyption Food.csv"), Buffer.from(FIXTURE_HEADER + FIXTURE_ROWS.join(""), "utf8"));
  await fs.writeFile(
    path.join(dir, "data", "processed", "cleaned_recipes.json"),
    JSON.stringify([{ name_en: "Air Fryer Bagel Chicken", ingredients_raw: [], instructions: [] }])
  );
}

function fixtureManifest(dir: string): Promise<Manifest> {
  return fs.readFile(path.join(dir, "data", "manifest", "sources.json"), "utf8").then(parseManifest);
}

async function hashRawFiles(dir: string): Promise<string[]> {
  const rawRoot = path.join(dir, "data", "raw");
  const names = (await fs.readdir(rawRoot)).sort();
  const out: string[] = [];
  for (const n of names) {
    const buf = await fs.readFile(path.join(rawRoot, n));
    out.push(`${n}:${createHash("sha256").update(buf).digest("hex")}`);
  }
  return out;
}

test("stage pipeline: imports Egyptian-evidence rows as needs_review, rejects clear non-Egyptian, ignores the global dump", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const result = await stageRecipes(dir);

  const s = result.report.importStats;
  assert.equal(s.rowsTotal, 4);
  assert.equal(s.stagedNeedsReview, 1); // Koshari Egyptian
  assert.equal(s.stagedRejectedNonEgyptian, 1); // Spaghetti Bolognese (Italian)
  assert.equal(s.excludedNoEgyptianEvidence, 1); // Hummus (broad regional)
  assert.equal(s.excludedMalformedOrInvalid, 1); // broken row

  assert.equal(result.valid, true);
  assert.equal(result.registry.length, 2);
  assert.deepEqual(result.report.registryCounts, { needs_review: 1, verified: 0, rejected: 1 });
  assert.equal(result.report.eligibleForVerifiedDataset, 0);

  const koshari = result.registry.find((r) => r.originalTitle === "Koshari Egyptian");
  assert.ok(koshari);
  assert.equal(koshari.verificationStatus, "needs_review");
  assert.match(koshari.recipeId, /^EGR-[0-9A-F]{16}$/);
  assert.equal(koshari.review.reviewerId, null);
  assert.equal(koshari.review.reviewDate, null);
  assert.equal(koshari.review.timeline[0].action, "imported_as_needs_review");
  assert.equal(koshari.original.recipe_title, "Koshari Egyptian");
  assert.equal(koshari.original.cuisine_list, '["Egyptian"]');
  // Provenance + license are DERIVED from the manifest, not invented.
  assert.equal(koshari.source.sourceId, "recipes-csv-fixture");
  assert.equal(koshari.source.sourceVersion, "v1");
  assert.equal(koshari.source.accessDate, "2026-08-01");
  assert.equal(koshari.license.status, "approved");
  // Missing fields stay null (never fabricated).
  assert.equal(koshari.names.ar, null);
  assert.equal(koshari.names.eg, null);
  assert.equal(koshari.region, null);
  assert.equal(koshari.yield.servings, null);
  assert.equal(koshari.yield.finalCookedWeightG, null);
  // Fingerprints bound to the imported row.
  assert.ok(koshari.sourceFingerprint !== null && koshari.sourceFingerprint.length > 0);
  assert.equal(koshari.review.snapshotFingerprint, null);
  assert.equal(koshari.review.staleReason, null);

  const bolognese = result.registry.find((r) => r.originalTitle === "Spaghetti Bolognese");
  assert.ok(bolognese);
  assert.equal(bolognese.verificationStatus, "rejected");
  assert.equal(bolognese.review.autoRejected, true);
  assert.ok(bolognese.review.timeline[0].note.toLowerCase().includes("italian"));
  assert.equal(bolognese.review.reviewerId, null, "pipeline rejection is not a human verdict");

  // Blockers are derived from the manifest + real state (no unconditional provenance message).
  assert.ok(result.report.blockers.some((b) => b.includes("0 verified recipes")));
  assert.ok(!result.report.blockers.some((b) => b.includes("no source record")));
  assert.ok(result.report.blockers.some((b) => b.includes("unreviewed")));
  const koshariGate = result.report.recordBlockers.find((r) => r.recipeId === koshari.recipeId);
  assert.ok(koshariGate);
  assert.ok(koshariGate.blockers.some((b) => b.includes("not verified")), "record-specific blocker reported");

  const ignored = result.report.ignoredGlobalRecipeFiles.find((g) => g.file === "data/processed/cleaned_recipes.json");
  assert.ok(ignored);
  assert.equal(ignored.exists, true);
  assert.ok(!result.registry.some((r) => r.originalTitle === "Air Fryer Bagel Chicken"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("stage pipeline: deterministic; a preserved human review is validated against the POST-review run", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const first = await stageRecipes(dir);
  const registryPath = path.join(dir, "data", "staging", "recipes.json");
  const manifest = await fixtureManifest(dir);

  // Human review recorded through the decision recorder.
  const records = JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[];
  const decided = applyReviewDecision(
    records.find((r) => r.originalTitle === "Koshari Egyptian") as StagedRecipe,
    { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "documented cultural reference" },
    manifest
  );
  assert.equal(decided.ok, true);
  if (!decided.ok) return;
  await fs.writeFile(
    registryPath,
    JSON.stringify(records.map((r) => (r.recipeId === decided.recipe.recipeId ? decided.recipe : r)), null, 2)
  );

  const second = await stageRecipes(dir);
  const registry2 = await fs.readFile(registryPath, "utf8");

  const reviewed = (JSON.parse(registry2) as StagedRecipe[]).find((r) => r.recipeId === decided.recipe.recipeId);
  assert.ok(reviewed);
  assert.equal(reviewed.verificationStatus, "verified");
  assert.equal(reviewed.review.reviewerId, "reviewer-1");
  assert.equal(reviewed.review.timeline.length, 2);
  assert.equal(second.report.importStats.carriedOverFromRegistry, 0, "both records are regenerated by this import");
  assert.equal(second.report.registryCounts.verified, 1);
  // The post-review run is where eligibility must be validated (not the pre-review first run).
  assert.equal(second.report.eligibleForVerifiedDataset, 1, "manifest-backed review becomes eligible");
  assert.equal(first.report.eligibleForVerifiedDataset, 0, "automation never self-verifies before a human decision");
  const reviewedGate = second.report.recordBlockers.find((r) => r.recipeId === decided.recipe.recipeId);
  assert.ok(reviewedGate && reviewedGate.eligible);

  // Determinism: re-running with the SAME registry input yields identical bytes.
  await stageRecipes(dir);
  const registry3 = await fs.readFile(registryPath, "utf8");
  assert.equal(registry2, registry3);

  // A curated record (no raw row) with a valid import timeline survives and is carried over.
  const curated: StagedRecipe = {
    recipeId: generateStableRecipeId("curated/by-reviewer.md", 1, "Koshari Traditional"),
    names: { ar: "كشري تقليدي", en: "Koshari Traditional", eg: null, aliases: [] },
    category: null,
    subcategory: null,
    region: "Egypt",
    yield: { servings: null, finalCookedWeightG: null },
    source: {
      sourceId: "curated/by-reviewer.md",
      sourceFile: "curated/by-reviewer.md",
      sourceRow: 1,
      sourceVersion: null,
      accessDate: null,
      url: null,
    },
    license: { status: "not_assessed", id: null, url: null, note: null },
    verificationStatus: "needs_review",
    review: {
      decision: "unreviewed",
      reviewerId: null,
      reviewDate: null,
      evidenceIds: [],
      rationale: null,
      autoRejected: false,
      snapshotFingerprint: null,
      staleReason: null,
      timeline: [
        {
          at: null,
          actor: "pipeline",
          action: "curated_record_created",
          status: "needs_review",
          note: "curated record added by reviewer",
          evidenceIds: [],
        },
      ],
    },
    version: STAGING_SCHEMA_VERSION,
    original: { header: "curated record added by reviewer" },
    originalTitle: "Koshari Traditional",
    notes: [],
    sourceFingerprint: "fp-curated-1",
  };
  await fs.writeFile(registryPath, JSON.stringify([...(JSON.parse(registry3) as StagedRecipe[]), curated]));
  const third = await stageRecipes(dir);
  assert.equal(third.valid, true, "curated record with a valid creation timeline validates");
  assert.equal(third.report.importStats.carriedOverFromRegistry, 1, "only the curated record has no raw row");
  const registry4 = JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[];
  assert.ok(registry4.some((r) => r.recipeId === curated.recipeId), "curated record survives the re-import");
  const curatedGate = third.report.recordBlockers.find((r) => r.recipeId === curated.recipeId);
  assert.ok(curatedGate && !curatedGate.eligible, "unreviewed curated record is never eligible");

  await fs.rm(dir, { recursive: true, force: true });
});

async function reviewKoshari(dir: string, registryPath: string): Promise<string> {
  const manifest = await fixtureManifest(dir);
  const records = JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[];
  const koshari = records.find((r) => r.originalTitle === "Koshari Egyptian");
  assert.ok(koshari);
  const decided = applyReviewDecision(
    koshari,
    { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "documented cultural reference" },
    manifest
  );
  if (!decided.ok) throw new Error(`review decision rejected: ${decided.errors.join("; ")}`);
  await fs.writeFile(registryPath, JSON.stringify(records.map((r) => (r.recipeId === koshari.recipeId ? decided.recipe : r)), null, 2));
  return koshari.recipeId;
}

test("stage pipeline: a CHANGED reviewed source row is routed back to review with a drift reason (h)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const registryPath = path.join(dir, "data", "staging", "recipes.json");
  await stageRecipes(dir);
  const koshariId = await reviewKoshari(dir, registryPath);

  const csvPath = path.join(dir, "data", "raw", "Recipes For Eqyption Food.csv");
  const csv = await fs.readFile(csvPath, "utf8");
  const changed = csv.replace('"classic"', '"classic modernized"');
  assert.notEqual(changed, csv, "the row content really changed");
  await fs.writeFile(csvPath, changed);

  const second = await stageRecipes(dir);
  const rec = second.registry.find((r) => r.recipeId === koshariId);
  assert.ok(rec);
  assert.equal(rec.verificationStatus, "needs_review", "drifted record is routed back to review");
  assert.ok(rec.review.staleReason !== null && rec.review.staleReason.includes("changed"), `drift reason explicit: ${String(rec.review.staleReason)}`);
  assert.ok(rec.review.timeline.some((t) => t.action === "source_drift_detected"));
  assert.ok(rec.review.timeline.some((t) => t.action === "human_verified"), "historical timeline is preserved");
  assert.equal(second.report.importStats.sourceDriftRoutedToReview, 1);
  assert.equal(second.report.eligibleForVerifiedDataset, 0, "drifted record is never silently eligible");
  assert.equal(second.valid, true);

  // Deterministic across runs: drift is applied once, then registry is stable.
  const registryStable1 = await fs.readFile(registryPath, "utf8");
  await stageRecipes(dir);
  const registryStable2 = await fs.readFile(registryPath, "utf8");
  assert.equal(registryStable1, registryStable2);
  await fs.rm(dir, { recursive: true, force: true });
});

test("stage pipeline: a DELETED reviewed source row is routed back to review (orphaned) (i)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const registryPath = path.join(dir, "data", "staging", "recipes.json");
  await stageRecipes(dir);
  const koshariId = await reviewKoshari(dir, registryPath);

  // Remove the reviewed koshari row entirely from the raw source.
  const csvPath = path.join(dir, "data", "raw", "Recipes For Eqyption Food.csv");
  await fs.writeFile(csvPath, Buffer.from(FIXTURE_HEADER + FIXTURE_ROWS.slice(1).join(""), "utf8"));

  const second = await stageRecipes(dir);
  const rec = second.registry.find((r) => r.recipeId === koshariId);
  assert.ok(rec, "reviewed record is preserved even when its row disappears");
  assert.equal(rec.verificationStatus, "needs_review");
  assert.ok(rec.review.staleReason !== null && rec.review.staleReason.toLowerCase().includes("deleted"), String(rec.review.staleReason));
  assert.ok(rec.review.timeline.some((t) => t.action === "source_drift_detected"));
  assert.ok(rec.review.timeline.some((t) => t.action === "human_verified"), "historical timeline is preserved");
  assert.equal(second.report.importStats.sourceDriftRoutedToReview, 1);
  assert.equal(second.report.eligibleForVerifiedDataset, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test("stage pipeline: tampered verified-without-attribution fails validation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const registryPath = path.join(dir, "data", "staging", "recipes.json");
  await stageRecipes(dir);
  const records = JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[];
  records[0].verificationStatus = "verified";
  records[0].review.decision = "verified";
  records[0].review.reviewerId = null;
  records[0].review.reviewDate = null;
  records[0].review.evidenceIds = [];
  await fs.writeFile(registryPath, JSON.stringify(records));

  const result = await stageRecipes(dir);
  assert.equal(result.valid, false);
  assert.ok(result.report.validationIssues.some((x) => x.issues.some((i) => i.includes("unverifiable"))));
  assert.equal(result.report.eligibleForVerifiedDataset, 0, "tampered record never enters the MVP set");
  await fs.rm(dir, { recursive: true, force: true });
});

test("stage pipeline: duplicate IDs in the registry are flagged and block exit-success", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const registryPath = path.join(dir, "data", "staging", "recipes.json");
  await stageRecipes(dir);
  const records = JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[];
  const dup = { ...records[0] };
  dup.recipeId = records[0].recipeId;
  await fs.writeFile(registryPath, JSON.stringify([...records, dup]));

  const result = await stageRecipes(dir);
  assert.equal(result.valid, false);
  assert.deepEqual(result.report.duplicateIds, [records[0].recipeId]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("stage pipeline: malformed registry content yields validation issues, never a crash (j)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const registryPath = path.join(dir, "data", "staging", "recipes.json");
  await stageRecipes(dir);

  // Parseable JSON with malformed entries.
  await fs.writeFile(registryPath, JSON.stringify([null, 42, { recipeId: "not-an-id", review: "oops" }, "x"]));
  const result = await stageRecipes(dir);
  assert.equal(result.valid, false);
  assert.ok(result.report.validationIssues.some((x) => x.issues.some((i) => i.includes("malformed registry entry"))));
  assert.ok(result.report.validationIssues.some((x) => x.issues.some((i) => i.includes("recipeId"))));
  assert.equal(result.report.eligibleForVerifiedDataset, 0);

  // Not even valid JSON: reported as a validation issue, registry preserved, no crash.
  await fs.writeFile(registryPath, "{{{ not json");
  const result2 = await stageRecipes(dir);
  assert.equal(result2.valid, false);
  assert.ok(result2.report.validationIssues.some((x) => x.recipeId === "(registry)"));
  const preserved = await fs.readFile(registryPath, "utf8");
  assert.equal(preserved, "{{{ not json", "malformed registry is preserved for debugging");
  await fs.rm(dir, { recursive: true, force: true });
});

test("stage pipeline: raw files stay byte-identical; repeated runs are byte-identical (determinism)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const before = await hashRawFiles(dir);

  const r1 = await stageRecipes(dir);
  const afterFirst = await hashRawFiles(dir);
  assert.deepEqual(afterFirst, before, "staging never writes under data/raw");

  const files = [
    path.join(dir, "data", "staging", "recipes.json"),
    path.join(dir, "data", "reports", "recipe-verification-report.json"),
    path.join(dir, "data", "reports", "recipe-verification-report.md"),
  ];
  const bytes1 = await Promise.all(files.map((f) => fs.readFile(f)));
  const r2 = await stageRecipes(dir);
  const bytes2 = await Promise.all(files.map((f) => fs.readFile(f)));
  assert.deepEqual(bytes2, bytes1, "outputs are byte-identical across repeated runs");
  const afterSecond = await hashRawFiles(dir);
  assert.deepEqual(afterSecond, before);
  assert.equal(r1.report.eligibleForVerifiedDataset, 0);
  assert.equal(r2.report.eligibleForVerifiedDataset, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test("fingerprint: canonical row fingerprint is deterministic and sensitive to canonical columns", () => {
  const headers = ["recipe_title", "description", "category", "cuisine_list", "ingredients", "other"];
  const row = ["Koshari", "classic", "main", '["Egyptian"]', '["lentils"]', "cosmetic"];
  const f1 = computeRowFingerprint("data/raw/x.csv", 2, headers, row);
  const f2 = computeRowFingerprint("data/raw/x.csv", 2, headers, row);
  assert.equal(f1, f2);
  const changed = [...row];
  changed[1] = "modern"; // description is canonical
  assert.notEqual(computeRowFingerprint("data/raw/x.csv", 2, headers, changed), f1);
  const cosmetic = [...row];
  cosmetic[5] = "changed"; // 'other' is not canonical
  assert.equal(computeRowFingerprint("data/raw/x.csv", 2, headers, cosmetic), f1);
});

test("stage pipeline: full drift lifecycle — v1 reviewed → modify raw → drift → re-review v2 → stage keeps verified", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const registryPath = path.join(dir, "data", "staging", "recipes.json");
  const csvPath = path.join(dir, "data", "raw", "Recipes For Eqyption Food.csv");
  const manifest = await fixtureManifest(dir);

  // ---- Run 1: initial import, no review ----
  const r1 = await stageRecipes(dir);
  assert.equal(r1.report.registryCounts.needs_review, 1);
  assert.equal(r1.report.registryCounts.verified, 0);
  assert.equal(r1.valid, true);
  const koshari = (JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[])
    .find((r) => r.originalTitle === "Koshari Egyptian");
  assert.ok(koshari);
  const koshariId = koshari.recipeId;
  const v1SourceFp = koshari.sourceFingerprint;
  assert.ok(v1SourceFp && v1SourceFp.length > 0);

  // ---- Human review v1: bind to v1 fingerprint ----
  const decV1 = applyReviewDecision(
    koshari,
    {
      decision: "verified",
      reviewerId: "reviewer-1",
      reviewDate: "2026-08-06",
      evidenceIds: ["EG-KOSHARI-CULTURAL-001"],
      rationale: "documented cultural reference",
    },
    manifest,
  );
  assert.equal(decV1.ok, true);
  if (!decV1.ok) throw new Error("v1 review failed");
  assert.equal(decV1.recipe.review.snapshotFingerprint, v1SourceFp, "v1 snapshotFingerprint binds to v1 sourceFingerprint");
  const v1SnapshotFp = decV1.recipe.review.snapshotFingerprint;
  const v1TimelineLen = decV1.recipe.review.timeline.length;
  assert.equal(v1TimelineLen, 2); // import + human_verified
  await fs.writeFile(
    registryPath,
    JSON.stringify(
      (JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[]).map((r) =>
        r.recipeId === koshariId ? decV1.recipe : r,
      ),
      null,
      2,
    ),
  );

  // ---- Run 2: re-stage with unchanged CSV; record stays verified ----
  const r2 = await stageRecipes(dir);
  assert.equal(r2.valid, true);
  assert.equal(r2.report.registryCounts.verified, 1);
  assert.equal(r2.report.eligibleForVerifiedDataset, 1);
  const afterR2 = (JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[]).find(
    (r) => r.recipeId === koshariId,
  );
  assert.ok(afterR2);
  assert.equal(afterR2.verificationStatus, "verified");
  assert.equal(afterR2.review.snapshotFingerprint, v1SnapshotFp, "snapshotFingerprint preserved across unchanged run");
  assert.equal(afterR2.review.staleReason, null, "no staleReason on unchanged run");

  // ---- Modify the raw CSV canonical row (v2) — change description (canonical column) ----
  const csvV1 = await fs.readFile(csvPath, "utf8");
  const csvV2 = csvV1.replace('"classic"', '"classic modernized"');
  assert.notEqual(csvV2, csvV1);
  await fs.writeFile(csvPath, csvV2);

  // ---- Run 3: detect drift → route to needs_review, update machine-owned fields ----
  const r3 = await stageRecipes(dir);
  assert.equal(r3.valid, true, "registry remains structurally valid after drift");
  assert.equal(r3.report.registryCounts.needs_review, 1);
  assert.equal(r3.report.registryCounts.verified, 0);
  assert.equal(r3.report.importStats.sourceDriftRoutedToReview, 1);
  assert.equal(r3.report.eligibleForVerifiedDataset, 0, "drifted record is never eligible silently");
  const afterR3 = (JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[]).find(
    (r) => r.recipeId === koshariId,
  );
  assert.ok(afterR3);
  assert.equal(afterR3.verificationStatus, "needs_review", "drifted record routed back to needs_review");
  assert.equal(afterR3.review.decision, "unreviewed", "decision fields cleared on stale route");
  assert.equal(afterR3.review.reviewerId, null);
  assert.equal(afterR3.review.reviewDate, null);
  assert.equal(afterR3.review.rationale, null);
  assert.deepEqual(afterR3.review.evidenceIds, []);
  assert.ok(
    afterR3.review.staleReason !== null && afterR3.review.staleReason.toLowerCase().includes("changed"),
    `staleReason must mention a change: ${String(afterR3.review.staleReason)}`,
  );
  const v2SourceFp = afterR3.sourceFingerprint;
  assert.ok(v2SourceFp && v2SourceFp !== v1SourceFp, "sourceFingerprint updated to v2 after drift");
  assert.notEqual(
    afterR3.original.description,
    koshari.original.description,
    "original row updated to the new imported snapshot after drift",
  );
  assert.equal(
    afterR3.original.description,
    "classic modernized",
    "original description matches the NEW raw row after drift",
  );
  assert.equal(
    afterR3.review.snapshotFingerprint,
    null,
    "snapshotFingerprint cleared after drift so re-review binds to new fingerprint",
  );
  // Historical human decision preserved in the timeline.
  assert.ok(
    afterR3.review.timeline.some((t) => t.action === "human_verified"),
    "v1 human_verified timeline entry preserved after drift",
  );
  const preservedHuman = afterR3.review.timeline.find((t) => t.action === "human_verified");
  assert.ok(preservedHuman, "v1 human event exists");
  assert.equal(preservedHuman!.actor, "reviewer-1");
  assert.equal(preservedHuman!.note, "documented cultural reference");
  assert.deepEqual(preservedHuman!.evidenceIds, ["EG-KOSHARI-CULTURAL-001"]);
  // source_drift_detected event appended.
  assert.ok(afterR3.review.timeline.some((t) => t.action === "source_drift_detected"));
  assert.ok(afterR3.review.timeline.length > v1TimelineLen, "timeline grew with drift event(s)");

  // Deterministic: re-running with drifted row doesn't double-apply drift.
  const stableAfterDrift1 = await fs.readFile(registryPath, "utf8");
  await stageRecipes(dir);
  const stableAfterDrift2 = await fs.readFile(registryPath, "utf8");
  assert.equal(stableAfterDrift1, stableAfterDrift2, "drift output is deterministic across repeated runs");

  // ---- Human re-review v2: bind re-review to the NEW v2 fingerprint ----
  const decV2 = applyReviewDecision(
    afterR3,
    {
      decision: "verified",
      reviewerId: "reviewer-2",
      reviewDate: "2026-08-07",
      evidenceIds: ["EG-KOSHARI-CULTURAL-001"],
      rationale: "re-reviewed against updated source row; cultural evidence still applies",
    },
    manifest,
  );
  if (decV2.ok !== true) {
    assert.fail(`v2 re-review rejected: ${(decV2 as { ok: false; errors: string[] }).errors.join("; ")}`);
  }
  assert.equal(
    decV2.recipe.review.snapshotFingerprint,
    v2SourceFp,
    "v2 snapshotFingerprint now binds to v2 sourceFingerprint",
  );
  await fs.writeFile(
    registryPath,
    JSON.stringify(
      (JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[]).map((r) =>
        r.recipeId === koshariId ? decV2.recipe : r,
      ),
      null,
      2,
    ),
  );

  // ---- Run 4: re-stage with v2 UNCHANGED — record MUST remain verified and eligible ----
  const r4 = await stageRecipes(dir);
  assert.equal(r4.valid, true);
  assert.equal(r4.report.registryCounts.verified, 1);
  assert.equal(r4.report.registryCounts.needs_review, 0);
  assert.equal(r4.report.importStats.sourceDriftRoutedToReview, 0, "no false drift on unchanged v2");
  assert.equal(r4.report.eligibleForVerifiedDataset, 1, "re-reviewed v2 record is eligible on unchanged run");
  const afterR4 = (JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[]).find(
    (r) => r.recipeId === koshariId,
  );
  assert.ok(afterR4);
  assert.equal(afterR4.verificationStatus, "verified");
  assert.equal(afterR4.review.decision, "verified");
  assert.equal(afterR4.review.staleReason, null, "staleReason cleared after successful re-review");
  assert.equal(afterR4.review.snapshotFingerprint, v2SourceFp, "v2 snapshotFingerprint stable on re-run");
  assert.equal(afterR4.sourceFingerprint, v2SourceFp, "v2 sourceFingerprint stable on re-run");
  // Full history preserved: v1 human, drift, v2 human events all present.
  assert.ok(
    afterR4.review.timeline.some((t) => t.action === "human_verified" && t.actor === "reviewer-1"),
    "v1 reviewer-1 human_verified preserved in history",
  );
  assert.ok(
    afterR4.review.timeline.some((t) => t.action === "source_drift_detected"),
    "source_drift_detected preserved in history",
  );
  assert.ok(
    afterR4.review.timeline.some((t) => t.action === "human_verified" && t.actor === "reviewer-2"),
    "v2 reviewer-2 human_verified appended",
  );
  // latestHumanEvent agrees with current state (the review binder invariant).
  const latest = latestHumanEvent(afterR4.review);
  assert.ok(latest, "has latest human event after v2");
  assert.equal(latest!.actor, "reviewer-2");
  assert.equal(latest!.status, "verified");

  // ---- Run 5: final determinism check — v2 verified registry byte-stable ----
  const v2Verified1 = await fs.readFile(registryPath, "utf8");
  const r5 = await stageRecipes(dir);
  const v2Verified2 = await fs.readFile(registryPath, "utf8");
  assert.equal(v2Verified1, v2Verified2, "final v2 verified registry is byte-identical across runs");
  assert.equal(r5.report.eligibleForVerifiedDataset, 1);
  assert.equal(r5.valid, true);

  await fs.rm(dir, { recursive: true, force: true });
});