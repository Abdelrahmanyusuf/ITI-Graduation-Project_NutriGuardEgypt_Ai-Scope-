import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { stageRecipes } from "../src/scripts/stage-recipes.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UNIFIED_SOURCE = "unified_egyptian_rag_database_v2_final.json";

test("staging prefers the unified recipeSource and preserves reviewed human meal categories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nutriguard-unified-stage-"));
  await fs.mkdir(path.join(root, "data", "manifest"), { recursive: true });
  await fs.copyFile(path.join(PROJECT_ROOT, UNIFIED_SOURCE), path.join(root, UNIFIED_SOURCE));
  await fs.copyFile(
    path.join(PROJECT_ROOT, "data", "manifest", "sources.json"),
    path.join(root, "data", "manifest", "sources.json")
  );

  const result = await stageRecipes(root);

  assert.equal(result.valid, true);
  assert.equal(result.report.recipeSource, UNIFIED_SOURCE);
  assert.equal(result.report.importStats.rowsTotal, 215);
  assert.deepEqual(result.report.registryCounts, { needs_review: 0, verified: 215, rejected: 0 });
  assert.equal(result.report.eligibleForVerifiedDataset, 215);
  assert.equal(result.report.mealCategoryReviewQueue.length, 0);
  assert.equal(result.registry.length, 215);
  assert.equal(result.registry.every((recipe) => recipe.verificationStatus === "verified"), true);
  assert.equal(result.registry.every((recipe) => recipe.source.sourceFile === UNIFIED_SOURCE), true);
  assert.equal(result.registry.every((recipe) => recipe.license.status === "approved"), true);
  assert.equal(result.registry.every((recipe) => recipe.review.timeline.at(-1)?.action === "human_verified"), true);
  assert.equal(result.registry.every((recipe) => (recipe.review.mealCategories?.length ?? 0) > 0), true);
  assert.equal(
    result.report.recordBlockers.every((recipe) => !recipe.blockers.some((blocker) => blocker.includes("mealCategories"))),
    true
  );
});
