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
  type TrustedCurrentImport,
} from "../src/domain/recipes.js";
import { parseManifest, type Manifest } from "../src/domain/manifest.js";
import { stageRecipes } from "../src/scripts/stage-recipes.js";
import { detectMojibake } from "../src/audit/text.js";

const CSV_FILE = "data/raw/Recipes For Eqyption Food.csv";
const FIXTURE_SOURCE_ID = "recipes-csv-fixture";

const KOSHARI_FP = "83a79c623d602e26aaf06be71c6a46d1b81749dc496ec63fc5bc2ec488c5aabf";
const MOLOKHIA_FP = "783494990f4d2d9220633d206a32b6a61e5c8e5ca87819af5ecd18c5382f0c30";
const FP_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FP_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FP_ZEROS = "0000000000000000000000000000000000000000000000000000000000000000";

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
      mealCategories: [],
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
    sourceFingerprint: KOSHARI_FP,
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
      mealCategories: ["breakfast"],
      autoRejected: false,
      snapshotFingerprint: KOSHARI_FP,
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
          mealCategories: ["breakfast"],
          sourceFingerprint: KOSHARI_FP,
          snapshotFingerprint: KOSHARI_FP,
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
          sourceFingerprint: KOSHARI_FP,
          snapshotFingerprint: KOSHARI_FP,
        },
      ],
    },
  });
  assert.deepEqual(validateStagedRecipe(padded, FULL_MANIFEST, trustedImportFor(padded)), []);
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
          sourceFingerprint: KOSHARI_FP,
          snapshotFingerprint: KOSHARI_FP,
        },
      ],
    },
  });
  assert.deepEqual(validateStagedRecipe(good, FULL_MANIFEST, trustedImportFor(good)), []);
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
          sourceFingerprint: KOSHARI_FP,
          snapshotFingerprint: KOSHARI_FP,
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
          sourceFingerprint: KOSHARI_FP,
          snapshotFingerprint: KOSHARI_FP,
        },
      ],
    },
  });
  assert.ok(validateStagedRecipe(badScheme, FULL_MANIFEST).some((i) => i.includes("not a valid http(s) URL")));
});

test("validation: missing sourceFingerprint is rejected", () => {
  const r = makeRecipe({ sourceFingerprint: "" });
  const issues = validateStagedRecipe(r, FULL_MANIFEST);
  assert.ok(issues.some((i) => i.includes("sourceFingerprint is required")), `issues=${JSON.stringify(issues)}`);
});

test("validation: non-SHA sourceFingerprint is rejected (short/non-hex strings)", () => {
  const rx = makeRecipe({ sourceFingerprint: "x" });
  const ix = validateStagedRecipe(rx, FULL_MANIFEST);
  assert.ok(
    ix.some((i) => i.includes("isSha256Hex") || i.includes("64-character lowercase SHA-256")),
    `x issues=${JSON.stringify(ix)}`
  );
  const rnh = makeRecipe({ sourceFingerprint: "not-a-hash" });
  const inh = validateStagedRecipe(rnh, FULL_MANIFEST);
  assert.ok(
    inh.some((i) => i.includes("isSha256Hex") || i.includes("64-character lowercase SHA-256")),
    `not-a-hash issues=${JSON.stringify(inh)}`
  );
});

test("validation: non-SHA sourceFingerprint is rejected (uppercase / too short / too long)", () => {
  const upper = makeRecipe({ sourceFingerprint: KOSHARI_FP.toUpperCase() });
  const iup = validateStagedRecipe(upper, FULL_MANIFEST);
  assert.ok(
    iup.some((i) => i.includes("isSha256Hex") || i.includes("64-character lowercase SHA-256")),
    `uppercase issues=${JSON.stringify(iup)}`
  );
  const short = makeRecipe({ sourceFingerprint: FP_A.slice(0, 63) });
  const isho = validateStagedRecipe(short, FULL_MANIFEST);
  assert.ok(
    isho.some((i) => i.includes("isSha256Hex") || i.includes("64-character lowercase SHA-256")),
    `short(63) issues=${JSON.stringify(isho)}`
  );
  const long = makeRecipe({ sourceFingerprint: FP_A + "a" });
  const ilo = validateStagedRecipe(long, FULL_MANIFEST);
  assert.ok(
    ilo.some((i) => i.includes("isSha256Hex") || i.includes("64-character lowercase SHA-256")),
    `long(65) issues=${JSON.stringify(ilo)}`
  );
});

test("validation: non-SHA snapshotFingerprint is rejected", () => {
  const base = makeVerifiedRecipe();
  const badTimeline = base.review.timeline.map((t) =>
    t.action === "human_verified" ? { ...t, snapshotFingerprint: "not-a-hash" } : t
  );
  const r = makeVerifiedRecipe({
    review: {
      ...base.review,
      snapshotFingerprint: "not-a-hash",
      timeline: badTimeline,
    },
  });
  const issues = validateStagedRecipe(r, FULL_MANIFEST);
  assert.ok(
    issues.some((i) => i.includes("snapshotFingerprint") && (i.includes("isSha256Hex") || i.includes("64-character lowercase SHA-256"))),
    `issues=${JSON.stringify(issues)}`
  );
});

test("validation: valid-format but incorrect fingerprint passes format validation (adversarial syntactic)", () => {
  for (const validFp of [FP_A, FP_B, FP_ZEROS, MOLOKHIA_FP]) {
    const base = makeVerifiedRecipe();
    const adversarialTimeline = base.review.timeline.map((t) =>
      t.action === "human_verified"
        ? { ...t, sourceFingerprint: validFp, snapshotFingerprint: validFp }
        : t
    );
    const r = makeVerifiedRecipe({
      sourceFingerprint: validFp,
      review: {
        ...base.review,
        snapshotFingerprint: validFp,
        timeline: adversarialTimeline,
      },
    });
    const issues = validateStagedRecipe(r, FULL_MANIFEST, trustedImportFor(r));
    assert.deepEqual(issues, [], `syntactically valid SHA-256 fingerprint ${validFp.slice(0,8)}... should pass format-only validation: ${JSON.stringify(issues)}`);
  }
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
      snapshotFingerprint: KOSHARI_FP,
      staleReason: null,
      timeline: [
        { at: null, actor: "pipeline", action: "imported_as_needs_review", status: "needs_review", note: "import", evidenceIds: [] },
        { at: "2026-08-06", actor: "reviewer-1", action: "human_rejected", status: "rejected", note: "   ", evidenceIds: [], sourceFingerprint: KOSHARI_FP, snapshotFingerprint: KOSHARI_FP },
      ],
    },
  });
  assert.ok(validateStagedRecipe(blankEvent, FULL_MANIFEST).some((i) => i.includes("note must be non-empty")));
});

test("review recorder: human verification requires reviewer + ISO date + manifest-valid evidence + rationale", () => {
  const r = makeRecipe();
  const authCtx = trustedImportFor(r);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: " ", reviewDate: "2026-08-06", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "x" }, FULL_MANIFEST, authCtx).ok, false);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-02-30", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "x" }, FULL_MANIFEST, authCtx).ok, false);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: [], rationale: "x" }, FULL_MANIFEST, authCtx).ok, false);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["EG-MISSING-001"], rationale: "x" }, FULL_MANIFEST, authCtx).ok, false);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["EG-REF-WHO-001"], rationale: "x" }, FULL_MANIFEST, authCtx).ok, false);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["EG-KOSHARI-CULTURAL-002"], rationale: "x" }, FULL_MANIFEST, authCtx).ok, false);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["  "], rationale: "x" }, FULL_MANIFEST, authCtx).ok, false);
  assert.equal(applyReviewDecision(r, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["https://example.test/ref"], rationale: " " }, FULL_MANIFEST, authCtx).ok, false);

  // URL evidence with rationale is accepted; IDs are trimmed and deduplicated.
  const ok = applyReviewDecision(
    r,
    { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["  https://example.test/ref  "], rationale: "consulted a documented public reference", mealCategories: ["breakfast"] },
    FULL_MANIFEST,
    authCtx
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
  assert.deepEqual(validateStagedRecipe(r, FULL_MANIFEST, trustedImportFor(r)), []);
  const g = isEligibleForVerifiedDataset(r, FULL_MANIFEST, trustedImportFor(r));
  assert.equal(g.eligible, true);
  assert.deepEqual(g.blockers, []);
});

test("MVP gate: a verified recipe with human-assigned mealCategories is eligible", () => {
  const recipe = makeVerifiedRecipe({
    review: { ...makeVerifiedRecipe().review, mealCategories: ["lunch", "dinner"] },
  });
  recipe.review.timeline = recipe.review.timeline.map((event) =>
    event.action === "human_verified" ? { ...event, mealCategories: ["lunch", "dinner"] } : event
  );
  assert.equal(isEligibleForVerifiedDataset(recipe, FULL_MANIFEST, trustedImportFor(recipe)).eligible, true);
});

test("MVP gate: a verified recipe with empty or missing mealCategories is blocked", () => {
  for (const mealCategories of [[] as Array<"breakfast" | "lunch" | "dinner">, undefined]) {
    const recipe = makeVerifiedRecipe({ review: { ...makeVerifiedRecipe().review, mealCategories } });
    recipe.review.timeline = recipe.review.timeline.map((event) =>
      event.action === "human_verified" ? { ...event, mealCategories } : event
    );
    const result = isEligibleForVerifiedDataset(recipe, FULL_MANIFEST, trustedImportFor(recipe));
    assert.equal(result.eligible, false);
    assert.ok(result.blockers.some((blocker) => blocker.includes("human-assigned review.mealCategories")));
  }
});

test("mealCategories are never derived from raw category or main_dish fields", () => {
  const original = makeRecipe();
  const changed = {
    ...original,
    category: "main_dish",
    original: { ...original.original, category: "breakfast", main_dish: true },
  };
  assert.deepEqual(original.review.mealCategories, []);
  assert.deepEqual(changed.review.mealCategories, []);
});

test("MVP gate: verified but unlicensed or unattributed is blocked", () => {
  const base = makeVerifiedRecipe();
  const unlicensed = { ...base, license: makeLicense("not_assessed") };
  const noReviewer = makeVerifiedRecipe({ review: { ...base.review, reviewerId: null } });
  const baseCtx = trustedImportFor(base);
  assert.equal(isEligibleForVerifiedDataset(unlicensed, FULL_MANIFEST, baseCtx).eligible, false);
  assert.ok(isEligibleForVerifiedDataset(unlicensed, FULL_MANIFEST, baseCtx).blockers.some((b) => b.includes("license")));
  assert.ok(isEligibleForVerifiedDataset(noReviewer, FULL_MANIFEST, baseCtx).blockers.some((b) => b.includes("reviewer")));
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

/** A trusted current-source snapshot for the fixture CSV at source row 2.
 * `fingerprint` is the freshly computed fingerprint of that row and
 * `recipeId` is the record's NON-NULL stable recipe identity (identity
 * authentication is mandatory and unconditional). */
function currentImportFor(fingerprint: string, recipeId: string, row = 2, sourceFile = CSV_FILE): TrustedCurrentImport {
  return { rows: [{ sourceFile, sourceRow: row, recipeId, originalTitle: null, fingerprint }] };
}

/** Build a trusted current-source snapshot that AUTHENTICATES `recipe` exactly
 * (matching source file, row, non-null recipeId and freshly computed
 * fingerprint = recipe.sourceFingerprint). Use when a record is genuinely
 * present in the current import. */
function trustedImportFor(recipe: StagedRecipe): TrustedCurrentImport {
  return {
    rows: [
      {
        sourceFile: recipe.source.sourceFile,
        sourceRow: recipe.source.sourceRow ?? 2,
        recipeId: recipe.recipeId,
        originalTitle: recipe.originalTitle,
        fingerprint: recipe.sourceFingerprint ?? "",
      },
    ],
  };
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
  const decidedTarget = records.find((r) => r.originalTitle === "Koshari Egyptian") as StagedRecipe;
  const decided = applyReviewDecision(
    decidedTarget,
    { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "documented cultural reference", mealCategories: ["breakfast"] },
    manifest,
    trustedImportFor(decidedTarget)
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
    sourceFingerprint: FP_A,
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
    { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "documented cultural reference", mealCategories: ["breakfast"] },
    manifest,
    trustedImportFor(koshari)
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
      mealCategories: ["breakfast"],
    },
    manifest,
    trustedImportFor(koshari),
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
      mealCategories: ["breakfast"],
    },
    manifest,
    // The v2 fingerprint is the freshly computed fingerprint of the current row,
    // and the record's non-null recipeId must match the trusted row identity.
    currentImportFor(v2SourceFp, afterR3.recipeId),
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

test("regression: legacy schema migration routes v1.0 verified records back to needs_review", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  await stageRecipes(dir);
  const registryPath = path.join(dir, "data", "staging", "recipes.json");
  const current = JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[];
  const koshari = current.find((r) => r.originalTitle === "Koshari Egyptian");
  assert.ok(koshari, "fixture has Koshari Egyptian row");

  const legacyV1 = {
    recipeId: koshari.recipeId,
    names: { ar: null, en: "Koshari Egyptian", eg: null, aliases: [] },
    category: koshari.category,
    subcategory: null,
    region: null,
    yield: { servings: null, finalCookedWeightG: null },
    source: {
      sourceId: FIXTURE_SOURCE_ID,
      sourceFile: CSV_FILE,
      sourceRow: 2,
      sourceVersion: "v1",
      accessDate: "2026-08-01",
      url: "https://example.test/fixtures",
    },
    license: { status: "approved" as const, id: FIXTURE_SOURCE_ID, url: "https://creativecommons.org/licenses/by/4.0/", note: null },
    verificationStatus: "verified" as const,
    review: {
      decision: "verified" as const,
      reviewerId: "legacy-reviewer",
      reviewDate: "2026-06-01",
      evidenceIds: ["EG-KOSHARI-CULTURAL-001"],
      rationale: "legacy review before v2.0 fingerprint schema",
      autoRejected: false,
      staleReason: null,
      timeline: [
        { at: null, actor: "pipeline", action: "imported_as_needs_review", status: "needs_review" as const, note: "legacy import", evidenceIds: [] as string[] },
        { at: "2026-06-01", actor: "legacy-reviewer", action: "human_verified", status: "verified" as const, note: "legacy review before v2.0 fingerprint schema", evidenceIds: ["EG-KOSHARI-CULTURAL-001"] },
      ],
    },
    version: "1.0",
    original: koshari.original,
    originalTitle: "Koshari Egyptian",
    notes: [],
  };

  await fs.writeFile(registryPath, JSON.stringify([legacyV1], null, 2));
  const result = await stageRecipes(dir);
  const manifest = await fixtureManifest(dir);
  const migrated = (JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[]).find((r) => r.recipeId === koshari.recipeId);
  assert.ok(migrated);
  assert.equal(migrated.verificationStatus, "needs_review", `legacy v1.0 verified record routed back to needs_review; staleReason=${String(migrated.review.staleReason)}`);
  assert.equal(migrated.review.decision, "unreviewed", "decision cleared on legacy review re-routing");
  assert.ok(
    migrated.review.staleReason !== null,
    `staleReason should be set after migration of a legacy reviewed record; got=${String(migrated.review.staleReason)}`
  );
  assert.equal(migrated.review.staleCode, "legacy_snapshot_unbound", "legacy unbound migration carries the machine-readable stale code");
  assert.ok(
    migrated.review.timeline.some((t) => t.action === "source_drift_detected" || t.action === "migrated_from_legacy" || t.action === "migrated_cannot_bind_snapshot"),
    "timeline records the migration/drift transition"
  );
  assert.ok(migrated.review.timeline.some((t) => t.action === "migrated_cannot_bind_snapshot"), "migrated_cannot_bind_snapshot is a legitimate stale-transition event");
  // Do NOT fabricate a historical reviewed fingerprint.
  const legacyMigrationEvent = migrated.review.timeline.find((t) => t.action === "migrated_cannot_bind_snapshot");
  assert.ok(legacyMigrationEvent);
  assert.equal(legacyMigrationEvent.previousFingerprint, null, "legacy migration never fabricates previousFingerprint");
  assert.equal(legacyMigrationEvent.currentFingerprint, null, "legacy migration never fabricates currentFingerprint");
  assert.equal(migrated.version, STAGING_SCHEMA_VERSION, "migrated record bumped to current schema version");
  // The migrated registry is structurally VALID (this is the key regression fix).
  assert.equal(result.valid, true, "legacy migration yields a structurally valid registry");
  assert.equal(result.report.validationIssues.length, 0, `no validation issues after legacy migration; issues=${JSON.stringify(result.report.validationIssues)}`);
  const migratedIssues = validateStagedRecipe(migrated, manifest);
  assert.deepEqual(migratedIssues, [], `migrated record validates cleanly; issues=${JSON.stringify(migratedIssues)}`);
  assert.equal(result.report.eligibleForVerifiedDataset, 0, "migrated legacy review is not silently eligible");
  assert.equal(result.report.registryCounts.verified, 0, "no fabricated verified recipes after legacy migration");
  assert.equal(result.report.registryCounts.needs_review, 1, "migrated legacy record is a needs_review record");
  await fs.rm(dir, { recursive: true, force: true });
});

test("stage pipeline: EOF orphaned (source_deleted) source is blocked from re-review and re-stays blocked after tampering + restore", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const registryPath = path.join(dir, "data", "staging", "recipes.json");
  const csvPath = path.join(dir, "data", "raw", "Recipes For Eqyption Food.csv");
  const manifest = await fixtureManifest(dir);

  // ---- import and verify a recipe ----
  await stageRecipes(dir);
  const koshariId = await reviewKoshari(dir, registryPath);
  const first = (JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[]).find((r) => r.recipeId === koshariId)!;
  assert.equal(first.verificationStatus, "verified", "recipe was human-verified");

  // ---- delete its raw row and re-stage -> orphaned source_deleted ----
  await fs.writeFile(csvPath, Buffer.from(FIXTURE_HEADER + FIXTURE_ROWS.slice(1).join(""), "utf8"));
  const second = await stageRecipes(dir);
  const orphan = second.registry.find((r) => r.recipeId === koshariId)!;
  assert.ok(orphan);
  assert.equal(orphan.verificationStatus, "needs_review", "deleted reviewed row is routed back to review");
  assert.equal(orphan.review.staleCode, "source_deleted", "deleted/orphaned row produces staleCode=source_deleted");
  assert.ok((orphan.review.staleReason ?? "").toLowerCase().includes("deleted"), `staleReason explains the deleted row: ${String(orphan.review.staleReason)}`);
  const orphanedSnapshot = JSON.parse(JSON.stringify(orphan)) as StagedRecipe;

  // ---- applyReviewDecision must return ok:false for an orphaned record,
  // no matter the supplied identity/date/evidence/rationale ----
  const blocked = applyReviewDecision(
    orphan,
    { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-06", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "documented cultural reference" },
    manifest,
  );
  assert.equal(blocked.ok, false, "orphaned record cannot be re-verified");
  if (!blocked.ok) {
    assert.ok(blocked.errors.some((e) => e.toLowerCase().includes("source_deleted") || e.toLowerCase().includes("orphan")), `blocker reason explicit: ${JSON.stringify(blocked.errors)}`);
  }

  // ---- tamper the record manually to look verified; validation/eligibility must still block it ----
  const tampered: StagedRecipe = JSON.parse(JSON.stringify(orphan)) as StagedRecipe;
  tampered.verificationStatus = "verified";
  tampered.review.decision = "verified";
  tampered.review.reviewerId = "tamperer";
  tampered.review.reviewDate = "2026-08-06";
  tampered.review.evidenceIds = ["EG-KOSHARI-CULTURAL-001"];
  tampered.review.rationale = "tampered: forged verified verdict on an orphaned row";
  // Persist so a real stage run validates against the tampered blob.
  await fs.writeFile(registryPath, JSON.stringify([tampered]));
  const tamperRun = await stageRecipes(dir);
  assert.equal(tamperRun.report.eligibleForVerifiedDataset, 0, "tampered orphaned overly-verified record never enters the MVP set");
  assert.ok(
    tamperRun.report.validationIssues.some((x) => x.issues.some((i) => i.toLowerCase().includes("stale") || i.toLowerCase().includes("orphan"))),
    "validation independently flags the tampered orphaned verified record",
  );
  // Eligibility gate blocks it independently of hand-edited status/reviewer fields.
  assert.equal(isEligibleForVerifiedDataset(tampered, manifest).eligible, false, "eligibility independently blocks the orphaned record");
  const tamperedIssues = validateStagedRecipe(tampered, manifest);
  assert.ok(tamperedIssues.some((i) => i.toLowerCase().includes("stale") || i.toLowerCase().includes("orphan")), "validation issues explain the orphan block");

  // ---- restore the documented current source snapshot, then re-attach ----
  await fs.writeFile(registryPath, JSON.stringify([orphanedSnapshot]));
  await fs.writeFile(csvPath, Buffer.from(FIXTURE_HEADER + FIXTURE_ROWS.join(""), "utf8"));
  const reattachedRun = await stageRecipes(dir);
  assert.ok(reattachedRun.valid, "registry valid after re-attachment");
  const reattached = (JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[]).find((r) => r.recipeId === koshariId)!;
  assert.equal(reattached.review.staleCode, "source_changed", "restored source downgrades orphaned -> source_changed (now reviewable)");
  assert.equal(reattached.verificationStatus, "needs_review");

  // ---- only now is a fresh review allowed ----
  const reReview = applyReviewDecision(
    reattached,
    { decision: "verified", reviewerId: "reviewer-2", reviewDate: "2026-08-07", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "re-reviewed against a documented current source row", mealCategories: ["breakfast"] },
    manifest,
    // The restored current row is present in the trusted current import.
    trustedImportFor(reattached),
  );
  assert.equal(reReview.ok, true, "re-review allowed only after the record is re-attached to a current source snapshot");
  await fs.rm(dir, { recursive: true, force: true });
});

test("stage pipeline: CHANGED source stays reviewable once a new current fingerprint exists", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const registryPath = path.join(dir, "data", "staging", "recipes.json");
  const csvPath = path.join(dir, "data", "raw", "Recipes For Eqyption Food.csv");
  const manifest = await fixtureManifest(dir);

  await stageRecipes(dir);
  const koshariId = await reviewKoshari(dir, registryPath);
  const v1 = (JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[]).find((r) => r.recipeId === koshariId)!;
  const v1Fp = v1.sourceFingerprint;

  // Change the canonical row -> drift; the pipeline refreshes the new fingerprint.
  const changedCsv = (await fs.readFile(csvPath, "utf8")).replace('"classic"', '"classic updated"');
  await fs.writeFile(csvPath, changedCsv);
  const drifted = await stageRecipes(dir);
  const afterDrift = (JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[]).find((r) => r.recipeId === koshariId)!;
  assert.equal(afterDrift.review.staleCode, "source_changed", "changed row yields staleCode=source_changed");
  assert.equal(drifted.report.eligibleForVerifiedDataset, 0, "changed record is not silently eligible");
  assert.ok(afterDrift.sourceFingerprint && afterDrift.sourceFingerprint !== v1Fp, "machine-owned sourceFingerprint refreshed to the new current row");

  // Re-review remains allowed: applyReviewDecision succeeds against the new bind.
  const rev = applyReviewDecision(
    afterDrift,
    { decision: "verified", reviewerId: "reviewer-2", reviewDate: "2026-08-07", evidenceIds: ["EG-KOSHARI-CULTURAL-001"] /* valid */, rationale: "re-reviewed against the updated source row", mealCategories: ["breakfast"] },
    manifest,
    // The changed row still exists in the trusted current import (new fingerprint).
    trustedImportFor(afterDrift),
  );
  assert.equal(rev.ok, true, "re-review allowed when a new current fingerprint exists");
  await fs.rm(dir, { recursive: true, force: true });
});

test("regression: legacy-unbound re-review is allowed ONLY when a current imported fingerprint exists", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const registryPath = path.join(dir, "data", "staging", "recipes.json");

  // ---- Case B: legacy record whose row is NOT in the current import -> no fingerprint -> review blocked ----
  await stageRecipes(dir); // ensure data/staging exists
  const phantomId = generateStableRecipeId(CSV_FILE, 99, "Phantom Legacy");
  const legacyNoRow = {
    recipeId: phantomId,
    names: { ar: null, en: "Phantom Legacy", eg: null, aliases: [] },
    category: "main",
    subcategory: null,
    region: null,
    yield: { servings: null, finalCookedWeightG: null },
    source: {
      sourceId: FIXTURE_SOURCE_ID,
      sourceFile: CSV_FILE,
      sourceRow: 99,
      sourceVersion: "v1",
      accessDate: "2026-08-01",
      url: "https://example.test/fixtures",
    },
    license: { status: "approved" as const, id: FIXTURE_SOURCE_ID, url: "https://creativecommons.org/licenses/by/4.0/", note: null },
    verificationStatus: "verified" as const,
    review: {
      decision: "verified" as const,
      reviewerId: "legacy-reviewer",
      reviewDate: "2026-06-01",
      evidenceIds: ["EG-KOSHARI-CULTURAL-001"],
      rationale: "legacy review",
      autoRejected: false,
      staleReason: null,
      timeline: [
        { at: null, actor: "pipeline", action: "imported_as_needs_review", status: "needs_review" as const, note: "legacy import", evidenceIds: [] as string[] },
        { at: "2026-06-01", actor: "legacy-reviewer", action: "human_verified", status: "verified" as const, note: "legacy review", evidenceIds: ["CULT_VAR_001"] as string[] },
      ],
    },
    version: "1.0",
    original: { recipe_title: "Phantom Legacy" },
    originalTitle: "Phantom Legacy",
    notes: [],
  };
  await fs.writeFile(registryPath, JSON.stringify([legacyNoRow]));
  await stageRecipes(dir);
  const noRowMigrated = (JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[]).find((r) => r.recipeId === phantomId);
  assert.ok(noRowMigrated, "legacy record is preserved in the registry");
  assert.equal(noRowMigrated!.review.staleCode, "legacy_snapshot_unbound", "un-bound legacy carries the machine-readable code");
  const manifest = await fixtureManifest(dir);
  // Trusted current import for THIS run: the phantom's row (file CSV, row 99)
  // is NOT present in the actual fixture, so the current source row cannot be
  // authenticated even when a fingerprint is hand-supplied.
  const blockedReReview = applyReviewDecision(
    noRowMigrated!,
    { decision: "verified", reviewerId: "reviewer-2", reviewDate: "2026-08-07", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "review" },
    manifest,
    { rows: [] },
  );
  assert.equal(blockedReReview.ok, false, "legacy-unbound re-review is blocked when no current imported fingerprint exists");
  if (!blockedReReview.ok) {
    assert.ok(blockedReReview.errors.some((e) => e.toLowerCase().includes("sourcefingerprint") || e.toLowerCase().includes("source") || e.toLowerCase().includes("trusted")), `reason=${JSON.stringify(blockedReReview.errors)}`);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("regression: phantom/nonexistent legacy row + valid-looking fingerprint is never reviewable or eligible", () => {
  // A syntactically valid 64-hex SHA-256 string is NOT proof that a current
  // imported source row exists. A legacy_snapshot_unbound record with no
  // pipeline-recorded current-snapshot proof must be rejected even when the
  // fingerprint is well-formed.
  const stalePhantom: StagedRecipe = {
    ...makeRecipe(),
    sourceFingerprint: FP_A,
    verificationStatus: "needs_review",
    review: {
      decision: "unreviewed",
      reviewerId: null,
      reviewDate: null,
      evidenceIds: [],
      rationale: null,
      autoRejected: false,
      snapshotFingerprint: null,
      staleReason: "legacy record migrated without a documented snapshot fingerprint",
      staleCode: "legacy_snapshot_unbound",
      timeline: [
        { at: null, actor: "pipeline", action: "imported_as_needs_review", status: "needs_review", note: "legacy import", evidenceIds: [] },
        { at: null, actor: "pipeline", action: "migrated_cannot_bind_snapshot", status: "needs_review", note: "unbound", evidenceIds: [], previousFingerprint: null, currentFingerprint: null },
      ],
    },
  };
  const blocked = applyReviewDecision(
    stalePhantom,
    { decision: "verified", reviewerId: "reviewer-2", reviewDate: "2026-08-07", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "review" },
    FULL_MANIFEST,
    // The trusted current import does NOT contain this phantom's source row.
    { rows: [] },
  );
  assert.equal(blocked.ok, false, "valid-looking fingerprint without an authenticated current source row is rejected");
  if (!blocked.ok) {
    assert.ok(blocked.errors.some((e) => /current source row|trusted|source|fingerprint/i.test(e)), `reason explicit: ${JSON.stringify(blocked.errors)}`);
  }

  // The SAME phantom, tampered into a "verified" shape with hand-filled
  // reviewer fields, must never become eligible (lineage still has the
  // stale/rebind marker and carries no matching current-snapshot proof).
  const tampered: StagedRecipe = JSON.parse(JSON.stringify(stalePhantom)) as StagedRecipe;
  tampered.verificationStatus = "verified";
  tampered.review.decision = "verified";
  tampered.review.reviewerId = "tamperer";
  tampered.review.reviewDate = "2026-08-06";
  tampered.review.evidenceIds = ["EG-KOSHARI-CULTURAL-001"];
  tampered.review.rationale = "tampered: forged verified verdict on a phantom legacy row";
  tampered.review.staleReason = null;
  tampered.review.staleCode = null;
  tampered.review.snapshotFingerprint = FP_A;
  tampered.review.timeline = [
    ...tampered.review.timeline,
    { at: "2026-08-06", actor: "tamperer", action: "human_verified", status: "verified", note: "tampered", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], sourceFingerprint: FP_A, snapshotFingerprint: FP_A },
  ];
  const gate = isEligibleForVerifiedDataset(tampered, FULL_MANIFEST, { rows: [] });
  assert.equal(gate.eligible, false, "phantom legacy record cannot become eligible through manual status/reviewer manipulation");
  assert.ok(gate.blockers.some((b) => /current source row|trusted|not present|fabricated/i.test(b)), `gate explains the requirement: ${JSON.stringify(gate.blockers)}`);
  const issues = validateStagedRecipe(tampered, FULL_MANIFEST, { rows: [] });
  assert.ok(issues.some((i) => /current source row|trusted|not present|fabricated/i.test(i)), `validation explains the requirement: ${JSON.stringify(issues)}`);
});

test("regression: incorrect-but-valid fingerprint is rejected even when a different current-snapshot proof is recorded", () => {
  // The pipeline recorded a snapshot_rebound proof for the REAL current row
  // (FP_ZEROS), but the record carries a different well-formed fingerprint
  // (FP_A). This must be rejected / routed back before eligibility.
  const staleWithWrongFp: StagedRecipe = {
    ...makeRecipe(),
    sourceFingerprint: FP_A,
    verificationStatus: "needs_review",
    review: {
      decision: "unreviewed",
      reviewerId: null,
      reviewDate: null,
      evidenceIds: [],
      rationale: null,
      autoRejected: false,
      snapshotFingerprint: null,
      staleReason: "legacy record migrated without a documented snapshot fingerprint",
      staleCode: "legacy_snapshot_unbound",
      timeline: [
        { at: null, actor: "pipeline", action: "imported_as_needs_review", status: "needs_review", note: "legacy import", evidenceIds: [] },
        { at: null, actor: "pipeline", action: "migrated_cannot_bind_snapshot", status: "needs_review", note: "unbound", evidenceIds: [], previousFingerprint: null, currentFingerprint: null },
        { at: null, actor: "pipeline", action: "snapshot_rebound", status: "needs_review", note: "bound to the current imported row", evidenceIds: [], sourceFingerprint: FP_ZEROS, snapshotFingerprint: null, previousFingerprint: null, currentFingerprint: FP_ZEROS },
      ],
    },
  };
  const blocked = applyReviewDecision(
    staleWithWrongFp,
    { decision: "verified", reviewerId: "reviewer-2", reviewDate: "2026-08-07", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "review" },
    FULL_MANIFEST,
    // The trusted current import says the row's fingerprint is FP_ZEROS — which
    // is NOT the FP_A the record claims (identity is the record's genuine id,
    // so the failing check is the fingerprint mismatch).
    currentImportFor(FP_ZEROS, staleWithWrongFp.recipeId),
  );
  assert.equal(blocked.ok, false, "fingerprint that does not equal the freshly computed current row fingerprint is rejected");
  if (!blocked.ok) {
    assert.ok(blocked.errors.some((e) => /does not equal|does not match|fingerprint|current source row/i.test(e)), `reason explicit: ${JSON.stringify(blocked.errors)}`);
  }

  const tampered: StagedRecipe = JSON.parse(JSON.stringify(staleWithWrongFp)) as StagedRecipe;
  tampered.verificationStatus = "verified";
  tampered.review.decision = "verified";
  tampered.review.reviewerId = "tamperer";
  tampered.review.reviewDate = "2026-08-06";
  tampered.review.evidenceIds = ["EG-KOSHARI-CULTURAL-001"];
  tampered.review.rationale = "tampered: wrong-but-valid fingerprint";
  tampered.review.staleReason = null;
  tampered.review.staleCode = null;
  tampered.review.snapshotFingerprint = FP_A;
  tampered.review.timeline = [
    ...tampered.review.timeline,
    { at: "2026-08-06", actor: "tamperer", action: "human_verified", status: "verified", note: "tampered", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], sourceFingerprint: FP_A, snapshotFingerprint: FP_A },
  ];
  const gate = isEligibleForVerifiedDataset(tampered, FULL_MANIFEST, currentImportFor(FP_ZEROS, tampered.recipeId));
  assert.equal(gate.eligible, false, "incorrect-but-valid fingerprint is blocked before eligibility");
  assert.ok(gate.blockers.some((b) => /does not match|does not equal|fingerprint|not present/i.test(b)), `gate explains: ${JSON.stringify(gate.blockers)}`);
});

test("regression: legacy migration with a genuinely imported current row can be legitimately re-reviewed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const registryPath = path.join(dir, "data", "staging", "recipes.json");
  await stageRecipes(dir);
  const current = JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[];
  const koshari = current.find((r) => r.originalTitle === "Koshari Egyptian");
  assert.ok(koshari, "fixture has Koshari Egyptian row");

  const legacyV1 = {
    recipeId: koshari.recipeId,
    names: koshari.names,
    category: koshari.category,
    subcategory: null,
    region: null,
    yield: { servings: null, finalCookedWeightG: null },
    source: koshari.source,
    license: koshari.license,
    verificationStatus: "verified" as const,
    review: {
      decision: "verified" as const,
      reviewerId: "legacy-reviewer",
      reviewDate: "2026-06-01",
      evidenceIds: ["EG-KOSHARI-CULTURAL-001"],
      rationale: "legacy review before v2.0 fingerprint schema",
      autoRejected: false,
      staleReason: null,
      timeline: [
        { at: null, actor: "pipeline", action: "imported_as_needs_review", status: "needs_review" as const, note: "legacy import", evidenceIds: [] as string[] },
        { at: "2026-06-01", actor: "legacy-reviewer", action: "human_verified", status: "verified" as const, note: "legacy review before v2.0 fingerprint schema", evidenceIds: ["EG-KOSHARI-CULTURAL-001"] as string[] },
      ],
    },
    version: "1.0",
    original: koshari.original,
    originalTitle: "Koshari Egyptian",
    notes: [],
  };

  await fs.writeFile(registryPath, JSON.stringify([legacyV1], null, 2));
  const result = await stageRecipes(dir);
  assert.equal(result.valid, true, "legacy migration remains structurally valid");
  const manifest = await fixtureManifest(dir);
  const migrated = (JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[]).find((r) => r.recipeId === koshari.recipeId);
  assert.ok(migrated);
  assert.equal(migrated.review.staleCode, "legacy_snapshot_unbound", "un-bound legacy carries the machine-readable code");
  assert.equal(migrated.verificationStatus, "needs_review", "legacy review routed back to review");

  // The pipeline bound the record to the genuinely imported row with an explicit
  // snapshot_rebound current-snapshot proof (no historical fingerprint invented).
  const rebound = migrated.review.timeline.find((t) => t.action === "snapshot_rebound");
  assert.ok(rebound, "pipeline records snapshot_rebound for a legacy record whose row is genuinely imported");
  assert.equal(rebound!.actor, "pipeline", "rebound proof is pipeline-authored");
  assert.ok(rebound!.currentFingerprint !== null, "rebound proof carries the pipeline-computed current fingerprint");
  assert.equal(rebound!.currentFingerprint, migrated.sourceFingerprint, "proof fingerprint equals the record's sourceFingerprint");
  const migEvent = migrated.review.timeline.find((t) => t.action === "migrated_cannot_bind_snapshot");
  assert.ok(migEvent, "migrated_cannot_bind_snapshot remains in the timeline");
  assert.equal(migEvent!.previousFingerprint, null, "legacy never fabricates a historical fingerprint");
  assert.equal(migEvent!.currentFingerprint, null, "legacy never fabricates a current snapshot on migration");

  // Legitimate re-review is now allowed (the genuinely imported current row is
  // present in the trusted current import with the freshly computed fingerprint).
  const rev = applyReviewDecision(
    migrated,
    { decision: "verified", reviewerId: "reviewer-2", reviewDate: "2026-08-07", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "re-reviewed against the genuinely imported current row", mealCategories: ["breakfast"] },
    manifest,
    // The genuinely imported current row is in the trusted current import.
    trustedImportFor(migrated),
  );
  assert.equal(rev.ok, true, `legacy record with a genuine current imported row is legitimately re-reviewable; errors=${!rev.ok ? JSON.stringify((rev as { errors: string[] }).errors) : ""}`);
  await fs.rm(dir, { recursive: true, force: true });
});

test("regression: forged snapshot_rebound in the editable registry is NOT trusted as source proof", () => {
  // An attacker hand-writes a "perfectly shaped" snapshot_rebound event
  // (actor:"pipeline", a valid 64-hex fingerprint) for a row that does NOT
  // actually exist in the current import. The trusted raw-import index must be
  // the authority, so applyReviewDecision, validation and eligibility reject it
  // even though the timeline event looks impeccable.
  const alienRecipeId = generateStableRecipeId("data/raw/Alien Recipes.csv", 777, "Alien Dish");
  const forged: StagedRecipe = {
    ...makeRecipe(),
    recipeId: alienRecipeId,
    sourceFingerprint: FP_ZEROS,
    verificationStatus: "needs_review",
    source: makeSource({ sourceFile: "data/raw/Alien Recipes.csv", sourceRow: 777 }),
    review: {
      decision: "unreviewed",
      reviewerId: null,
      reviewDate: null,
      evidenceIds: [],
      rationale: null,
      autoRejected: false,
      snapshotFingerprint: null,
      staleReason: "forged legacy-unbound record for a nonexistent row",
      staleCode: "legacy_snapshot_unbound",
      timeline: [
        { at: null, actor: "pipeline", action: "imported_as_needs_review", status: "needs_review", note: "import", evidenceIds: [] },
        { at: null, actor: "pipeline", action: "migrated_cannot_bind_snapshot", status: "needs_review", note: "unbound", evidenceIds: [], previousFingerprint: null, currentFingerprint: null },
        { at: null, actor: "pipeline", action: "snapshot_rebound", status: "needs_review", note: "forged current row proof", evidenceIds: [], sourceFingerprint: FP_ZEROS, snapshotFingerprint: null, previousFingerprint: null, currentFingerprint: FP_ZEROS },
      ],
    },
  };

  // The current raw import contains NO such file/row, so the trusted index has
  // no matching current source row.
  const emptyCurrentImport: TrustedCurrentImport = { rows: [] };

  // applyReviewDecision must reject it even though the timeline event is "perfect".
  const blocked = applyReviewDecision(
    forged,
    { decision: "verified", reviewerId: "reviewer-9", reviewDate: "2026-08-07", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "review", mealCategories: ["breakfast"] },
    FULL_MANIFEST,
    emptyCurrentImport,
  );
  assert.equal(blocked.ok, false, "forged snapshot_rebound with a nonexistent source row is rejected");
  if (!blocked.ok) {
    assert.ok(blocked.errors.some((e) => /current source row|trusted|not present|fingerprint/i.test(e)), `reason explicit: ${JSON.stringify(blocked.errors)}`);
  }

  // Tampered to "verified": neither validation nor eligibility can accept it,
  // because the trusted index does not contain the row.
  const tampered: StagedRecipe = JSON.parse(JSON.stringify(forged)) as StagedRecipe;
  tampered.verificationStatus = "verified";
  tampered.review.decision = "verified";
  tampered.review.reviewerId = "forger";
  tampered.review.reviewDate = "2026-08-06";
  tampered.review.evidenceIds = ["EG-KOSHARI-CULTURAL-001"];
  tampered.review.rationale = "forged: hand-written snapshot_rebound event";
  tampered.review.staleReason = null;
  tampered.review.staleCode = null;
  tampered.review.snapshotFingerprint = FP_ZEROS;
  tampered.review.timeline = [
    ...tampered.review.timeline,
    { at: "2026-08-06", actor: "forger", action: "human_verified", status: "verified", note: "forged", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], sourceFingerprint: FP_ZEROS, snapshotFingerprint: FP_ZEROS },
  ];
  const gate = isEligibleForVerifiedDataset(tampered, FULL_MANIFEST, emptyCurrentImport);
  assert.equal(gate.eligible, false, "forged snapshot_rebound cannot make the record eligible");
  const tamperedIssues = validateStagedRecipe(tampered, FULL_MANIFEST, emptyCurrentImport);
  assert.ok(tamperedIssues.some((i) => /current source row|trusted|not present|fabricated/i.test(i)), `validation rejects: ${JSON.stringify(tamperedIssues)}`);

  // Sanity: with a real trusted current row whose fingerprint matches, the SAME
  // shaped record is legitimately re-reviewable (proves the check is precise,
  // not a blanket stale rejection).
  const legitimate: StagedRecipe = {
    ...makeRecipe(),
    sourceFingerprint: FP_ZEROS,
    verificationStatus: "needs_review",
    review: {
      ...forged.review,
    },
  };
  const ok = applyReviewDecision(
    legitimate,
    { decision: "verified", reviewerId: "reviewer-9", reviewDate: "2026-08-07", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "review", mealCategories: ["breakfast"] },
    FULL_MANIFEST,
    // The genuine current row belongs to `legitimate` (KOS line id) with FP_ZEROS.
    currentImportFor(FP_ZEROS, legitimate.recipeId),
  );
  assert.equal(ok.ok, true, "a genuine current row in the trusted index makes re-review legitimate");
});

test("regression: pending manifest source/license -> approved refreshes the staged record in place", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const manifestPath = path.join(dir, "data", "manifest", "sources.json");
  await fs.writeFile(manifestPath, JSON.stringify(buildManifestJSON({ sourceApproved: false }), null, 2));

  const first = await stageRecipes(dir);
  assert.equal(first.valid, true);
  const koshari1 = first.registry.find((r) => r.originalTitle === "Koshari Egyptian");
  assert.ok(koshari1);
  assert.equal(koshari1.license.status, "pending", "pending manifest → license.status=pending (source record exists, not yet approved)");
  assert.equal(koshari1.source.sourceId, FIXTURE_SOURCE_ID);

  const registryPath = path.join(dir, "data", "staging", "recipes.json");
  const koshariId = koshari1.recipeId;
  const bytes1 = await fs.readFile(registryPath, "utf8");

  await fs.writeFile(manifestPath, JSON.stringify(buildManifestJSON({ sourceApproved: true }), null, 2));
  const second = await stageRecipes(dir);
  assert.equal(second.valid, true);
  const koshari2 = second.registry.find((r) => r.recipeId === koshariId);
  assert.ok(koshari2, "same recipe record present after manifest approval");
  assert.equal(koshari2.recipeId, koshariId, "recipe identity is stable across manifest refresh");
  assert.equal(koshari2.license.status, "approved", "approved manifest → license.status=approved refreshed on same record");
  assert.equal(koshari2.license.id, FIXTURE_SOURCE_ID, "license.id populated from approved manifest");
  assert.ok(koshari2.license.url !== null && koshari2.license.url.startsWith("https://"), "license.url populated from approved manifest");
  assert.ok(koshari1 !== koshari2 || bytes1 !== await fs.readFile(registryPath, "utf8"), "registry bytes changed after manifest refresh");
  await fs.rm(dir, { recursive: true, force: true });
});

test("regression: approved -> pending/rejected revocation blocks verified-dataset eligibility", () => {
  const approved = makeVerifiedRecipe();
  const okGate = isEligibleForVerifiedDataset(approved, FULL_MANIFEST, trustedImportFor(approved));
  assert.equal(okGate.eligible, true, "baseline: fully approved record is eligible");

  const revokedLicense = makeVerifiedRecipe({ license: makeLicense("not_assessed") });
  const gate1 = isEligibleForVerifiedDataset(revokedLicense, FULL_MANIFEST, trustedImportFor(revokedLicense));
  assert.equal(gate1.eligible, false, "license revocation (not_assessed) blocks eligibility");
  assert.ok(gate1.blockers.some((b) => b.toLowerCase().includes("license")), `blocker should mention license: ${JSON.stringify(gate1.blockers)}`);

  const pendingManifest = buildManifest({ sourceApproved: false });
  const pendingRecord = makeVerifiedRecipe();
  const againstPending = isEligibleForVerifiedDataset(pendingRecord, pendingManifest, trustedImportFor(pendingRecord));
  assert.equal(againstPending.eligible, false, "manifest-level source revocation blocks eligibility");
  assert.ok(againstPending.blockers.some((b) => b.toLowerCase().includes("license") || b.toLowerCase().includes("source")), `blocker should mention license/source: ${JSON.stringify(againstPending.blockers)}`);
});

test("regression: missing original is rejected (original:null)", () => {
  const r = makeRecipe({ original: null as unknown as Record<string, unknown> });
  const issues = validateStagedRecipe(r, FULL_MANIFEST);
  assert.ok(issues.some((i) => i.includes("original source values are required")), `issues=${JSON.stringify(issues)}`);
});

test("regression: invalid/non-SHA fingerprint is rejected", () => {
  const r = makeRecipe({ sourceFingerprint: "not-a-hash" });
  const issues = validateStagedRecipe(r, FULL_MANIFEST);
  assert.ok(issues.some((i) => i.includes("sourceFingerprint") && (i.includes("isSha256Hex") || i.includes("64-character lowercase SHA-256"))), `issues=${JSON.stringify(issues)}`);
});

test("regression: valid-format but incorrect current-row fingerprint is routed back to review via drift", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  const registryPath = path.join(dir, "data", "staging", "recipes.json");

  await stageRecipes(dir);
  const records = JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[];
  const koshari = records.find((r) => r.originalTitle === "Koshari Egyptian");
  assert.ok(koshari);
  const correctSourceFp = koshari.sourceFingerprint;
  assert.ok(correctSourceFp && correctSourceFp.length === 64, "imported record has a SHA-256 sourceFingerprint");

  const adversarial: StagedRecipe = {
    ...koshari,
    sourceFingerprint: FP_A,
    verificationStatus: "verified",
    license: makeLicense("approved"),
    review: {
      decision: "verified",
      reviewerId: "adversarial-tamper",
      reviewDate: "2026-08-06",
      evidenceIds: ["EG-KOSHARI-CULTURAL-001"],
      rationale: "tampered: reviewed fingerprint does NOT match actual current CSV row",
      autoRejected: false,
      snapshotFingerprint: FP_A,
      staleReason: null,
      timeline: [
        { at: null, actor: "pipeline", action: "imported_as_needs_review", status: "needs_review", note: "import", evidenceIds: [] },
        {
          at: "2026-08-06",
          actor: "adversarial-tamper",
          action: "human_verified",
          status: "verified",
          note: "tampered: reviewed fingerprint does NOT match actual current CSV row",
          evidenceIds: ["EG-KOSHARI-CULTURAL-001"],
          sourceFingerprint: FP_A,
          snapshotFingerprint: FP_A,
        },
      ],
    },
  };
  await fs.writeFile(registryPath, JSON.stringify([adversarial], null, 2));
  const result = await stageRecipes(dir);
  assert.equal(result.valid, true, "registry remains structurally valid even after adversarial record routed");
  const routed = (JSON.parse(await fs.readFile(registryPath, "utf8")) as StagedRecipe[]).find((r) => r.recipeId === adversarial.recipeId);
  assert.ok(routed);
  assert.equal(routed.verificationStatus, "needs_review", "adversarial FP_A fingerprint mismatches current CSV row → drift routed back to review");
  assert.ok(routed.review.staleReason !== null, `staleReason should explain the drift; got=${String(routed.review.staleReason)}`);
  assert.ok(
    routed.review.staleReason !== null && routed.review.staleReason.toLowerCase().includes("changed"),
    `staleReason should mention fingerprint mismatch/changed: ${String(routed.review.staleReason)}`
  );
  assert.ok(routed.review.timeline.some((t) => t.action === "source_drift_detected"), "source_drift_detected event records the tamper-detection");
  assert.notEqual(routed.sourceFingerprint, FP_A, "sourceFingerprint is restored to the current imported row after drift");
  assert.equal(result.report.eligibleForVerifiedDataset, 0, "adversarial record never silently enters the verified dataset");
  await fs.rm(dir, { recursive: true, force: true });
});

test("regression: old and new reviewed fingerprints survive drift and re-review in timeline history", () => {
  const baseTimeline = makeVerifiedRecipe().review.timeline.map((t) =>
    t.action === "human_verified"
      ? { ...t, sourceFingerprint: FP_A, snapshotFingerprint: FP_A }
      : t
  );
  const v1: StagedRecipe = {
    ...makeVerifiedRecipe(),
    sourceFingerprint: FP_A,
    review: {
      ...makeVerifiedRecipe().review,
      snapshotFingerprint: FP_A,
      timeline: baseTimeline,
    },
  };

  assert.equal(v1.sourceFingerprint, FP_A, "v1 sourceFingerprint bound");
  assert.equal(v1.review.snapshotFingerprint, FP_A, "v1 snapshotFingerprint bound");
  assert.equal(v1.verificationStatus, "verified");

  const staleReason = "source row changed after review (canonical fingerprint mismatch); re-review required";

  const driftMutated: StagedRecipe = JSON.parse(JSON.stringify(v1));
  driftMutated.verificationStatus = "needs_review";
  driftMutated.sourceFingerprint = FP_B;
  driftMutated.review = {
    decision: "unreviewed",
    reviewerId: null,
    reviewDate: null,
    evidenceIds: [],
    rationale: null,
    autoRejected: false,
    snapshotFingerprint: null,
    staleReason,
    timeline: [
      ...v1.review.timeline,
      {
        at: null,
        actor: "pipeline",
        action: "source_drift_detected",
        status: "needs_review" as const,
        note: staleReason,
        evidenceIds: [] as string[],
        previousFingerprint: FP_A,
        currentFingerprint: FP_B,
      },
    ],
  };
  driftMutated.notes = [...driftMutated.notes, `source drift: ${staleReason}`];

  assert.equal(driftMutated.verificationStatus, "needs_review");
  assert.equal(driftMutated.review.staleReason, staleReason);
  assert.equal(driftMutated.sourceFingerprint, FP_B, "after drift: sourceFingerprint refreshed to FP_B");
  assert.equal(driftMutated.review.snapshotFingerprint, null, "after drift: snapshotFingerprint cleared for re-review binding");
  const driftEvent = driftMutated.review.timeline.find((t) => t.action === "source_drift_detected");
  assert.ok(driftEvent, "source_drift_detected event in timeline");
  assert.equal(driftEvent!.previousFingerprint, FP_A, "drift event records previousFingerprint=FP_A (v1 snapshot)");
  assert.equal(driftEvent!.currentFingerprint, FP_B, "drift event records currentFingerprint=FP_B (new row)");
  assert.ok(
    driftMutated.review.timeline.some((t) => t.action === "human_verified" && t.snapshotFingerprint === FP_A),
    "v1 human_verified event (FP_A) preserved in history after drift"
  );

  const rev = applyReviewDecision(
    driftMutated,
    {
      decision: "verified",
      reviewerId: "reviewer-2",
      reviewDate: "2026-08-07",
      evidenceIds: ["EG-KOSHARI-CULTURAL-001"],
      rationale: "re-reviewed against updated source row; cultural evidence still applies",
      mealCategories: ["breakfast"],
    },
    FULL_MANIFEST,
    currentImportFor(FP_B, driftMutated.recipeId),
  );
  assert.equal(rev.ok, true, `re-review should succeed; errors=${!rev.ok ? JSON.stringify((rev as { errors: string[] }).errors) : ""}`);
  if (!rev.ok) return;
  const v2 = rev.recipe;
  assert.equal(v2.verificationStatus, "verified");
  assert.equal(v2.sourceFingerprint, FP_B, "v2 sourceFingerprint is FP_B");
  assert.equal(v2.review.snapshotFingerprint, FP_B, "v2 snapshotFingerprint binds to FP_B");
  assert.equal(v2.review.staleReason, null, "staleReason cleared after successful re-review");

  const v2HumanEvent = v2.review.timeline.find((t) => t.action === "human_verified" && t.actor === "reviewer-2");
  assert.ok(v2HumanEvent, "v2 reviewer-2 human_verified event present");
  assert.equal(v2HumanEvent!.snapshotFingerprint, FP_B, "v2 human event snapshotFingerprint=FP_B");
  assert.equal(v2HumanEvent!.sourceFingerprint, FP_B, "v2 human event sourceFingerprint=FP_B");

  assert.ok(
    v2.review.timeline.some((t) => t.action === "human_verified" && t.snapshotFingerprint === FP_A),
    "v1 human_verified (FP_A) still present in FINAL timeline after re-review — history preserved"
  );
  assert.ok(
    v2.review.timeline.some((t) => t.action === "source_drift_detected"),
    "source_drift_detected still present in FINAL timeline after re-review — history preserved"
  );
  const preservedDrift = v2.review.timeline.find((t) => t.action === "source_drift_detected");
  assert.equal(preservedDrift!.previousFingerprint, FP_A, "drift event previousFingerprint=FP_A preserved after re-review");
  assert.equal(preservedDrift!.currentFingerprint, FP_B, "drift event currentFingerprint=FP_B preserved after re-review");
});

test("trusted-source auth: deleting stale history + empty index cannot make a phantom record admissible", () => {
  // A record with a VALID recipe ID whose source row does not exist anywhere in
  // the current import, and whose mutable stale history has been fully deleted
  // (staleCode/staleReason/timeline stale events removed) MUST fail closed. The
  // editable registry is not the authority; authentication is unconditional.
  const record: StagedRecipe = {
    ...makeRecipe(),
    verificationStatus: "verified",
    license: makeLicense("approved"),
    review: {
      decision: "verified",
      reviewerId: "tamperer",
      reviewDate: "2026-08-06",
      evidenceIds: ["EG-KOSHARI-CULTURAL-001"],
      rationale: "tampered: stale history deleted, no current row present",
      autoRejected: false,
      snapshotFingerprint: KOSHARI_FP,
      staleReason: null,
      staleCode: null,
      timeline: [
        { at: null, actor: "pipeline", action: "imported_as_needs_review", status: "needs_review", note: "import", evidenceIds: [] },
        { at: "2026-08-06", actor: "tamperer", action: "human_verified", status: "verified", note: "tampered", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], sourceFingerprint: KOSHARI_FP, snapshotFingerprint: KOSHARI_FP },
      ],
    },
  };
  // The record claims row 2 of the fixture CSV but we give an EMPTY trusted index:
  // no current source row can be authenticated.
  const emptyIndex: TrustedCurrentImport = { rows: [] };

  const decided = applyReviewDecision(record, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-07", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "re-verify" }, FULL_MANIFEST, emptyIndex);
  assert.equal(decided.ok, false, "a human review decision requires an authenticated current source row");

  // Manually verified-field-tampering: validation fails closed (no current row).
  const tamperedIssues = validateStagedRecipe(record, FULL_MANIFEST, emptyIndex);
  assert.ok(tamperedIssues.length > 0, `active verified record without a current row fails validation: ${JSON.stringify(tamperedIssues)}`);
  assert.ok(tamperedIssues.some((i) => /current source row|trusted|not present/i.test(i)), `auth reason explicit: ${JSON.stringify(tamperedIssues)}`);

  const gate = isEligibleForVerifiedDataset(record, FULL_MANIFEST, emptyIndex);
  assert.equal(gate.eligible, false, "eligibility is false without an authenticated current source row");
  assert.ok(gate.blockers.some((b) => /current source row|trusted|not present/i.test(b)), `gate explains: ${JSON.stringify(gate.blockers)}`);
});

test("trusted-source auth: the trusted row identity is REQUIRED and non-null", () => {
  const record: StagedRecipe = {
    ...makeRecipe(),
    verificationStatus: "verified",
    license: makeLicense("approved"),
    review: {
      decision: "verified",
      reviewerId: "reviewer-1",
      reviewDate: "2026-08-06",
      evidenceIds: ["EG-KOSHARI-CULTURAL-001"],
      rationale: "documented cultural reference",
      autoRejected: false,
      snapshotFingerprint: KOSHARI_FP,
      staleReason: null,
      staleCode: null,
      timeline: [
        { at: null, actor: "pipeline", action: "imported_as_needs_review", status: "needs_review", note: "import", evidenceIds: [] },
        { at: "2026-08-06", actor: "reviewer-1", action: "human_verified", status: "verified", note: "rechecked", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], sourceFingerprint: KOSHARI_FP, snapshotFingerprint: KOSHARI_FP },
      ],
    },
  };

  // Matching file / row / fingerprint but recipeId = null is REJECTED: identity is
  // mandatory and must be a non-null valid stable recipe ID.
  const nullIdentity: TrustedCurrentImport = {
    rows: [{ sourceFile: CSV_FILE, sourceRow: 2, recipeId: null as unknown as string, originalTitle: null, fingerprint: KOSHARI_FP }],
  };
  assert.ok(currentSourceRowRejected(record, nullIdentity), "recipeId:null in the trusted row is rejected");

  // Matching file / row / fingerprint but a DIFFERENT valid recipe ID is REJECTED.
  const differentValidId = generateStableRecipeId(CSV_FILE, 2, "Different Dish");
  const wrongIdentity: TrustedCurrentImport = {
    rows: [{ sourceFile: CSV_FILE, sourceRow: 2, recipeId: differentValidId, originalTitle: null, fingerprint: KOSHARI_FP }],
  };
  assert.ok(currentSourceRowRejected(record, wrongIdentity), "a different valid recipe ID in the trusted row is rejected");

  // Exact match (file, row, recipeId, fingerprint) SUCCEEDS.
  const exact = trustedImportFor(record);
  const decided = applyReviewDecision(record, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-07", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "re-verify matched row", mealCategories: ["breakfast"] }, FULL_MANIFEST, exact);
  assert.equal(decided.ok, true, "exact match (file/row/recipeId/fingerprint) authenticates and succeeds");
});

/** True when the current-source authentication of `record` under `index` is rejected. */
function currentSourceRowRejected(record: StagedRecipe, index: TrustedCurrentImport): boolean {
  const decided = applyReviewDecision(record, { decision: "verified", reviewerId: "reviewer-1", reviewDate: "2026-08-07", evidenceIds: ["EG-KOSHARI-CULTURAL-001"], rationale: "re-verify" }, FULL_MANIFEST, index);
  return decided.ok === false;
}

test("step 3 reports contain no mojibake when generated", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-stage-"));
  await buildStagingRoot(dir);
  await stageRecipes(dir);
  const reportMdPath = path.join(dir, "data", "reports", "recipe-verification-report.md");
  const reportJsonPath = path.join(dir, "data", "reports", "recipe-verification-report.json");

  const mdContent = await fs.readFile(reportMdPath, "utf8");
  const mdCheck = detectMojibake(mdContent);
  assert.equal(mdCheck.detected, false, `recipe-verification-report.md should not contain mojibake; kinds=${JSON.stringify(mdCheck.kinds)} examples=${JSON.stringify(mdCheck.examples)}`);

  const jsonContent = await fs.readFile(reportJsonPath, "utf8");
  const jsonCheck = detectMojibake(jsonContent);
  assert.equal(jsonCheck.detected, false, `recipe-verification-report.json should not contain mojibake; kinds=${JSON.stringify(jsonCheck.kinds)} examples=${JSON.stringify(jsonCheck.examples)}`);

  await fs.rm(dir, { recursive: true, force: true });
});
