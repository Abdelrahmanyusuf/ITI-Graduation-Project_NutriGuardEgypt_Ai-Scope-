import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { runAudit } from "../src/scripts/run-audit.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const INGREDIENTS_CSV = Buffer.from(
  'FOOD,PROTEIN (g),ENERGY (Kcal),prep_state\n"Rice",7.1,130,Raw / Unprepared\n"Lentils",9,116,Prepared / Cooked Dish\n"Bread",,,Ready\n',
  "utf8"
);

const RECIPES_CSV = Buffer.from(
  'recipe_title\tcategory\tnum_ingredients\tingredients\tingredients_canonical\tcuisine_list\tmain_ingredient\tegy_ingredient_coverage\n' +
    '"Koshari"\t"main"\t"2"\t"[""lentils"", ""rice""]"\t"[""lentils"", ""rice""]"\t"[""Egyptian""]"\t""\t"1"\n' +
    '"Plain toast"\t"main"\t"1"\t"[""bread""]"\t"[""bread""]"\t"[""Italian"",""French""]"\t""\t"0"\n',
  "utf8"
);

// Minimal 1-page PDF with an Info dictionary and a page content stream.
const MIN_PDF = Buffer.concat([
  Buffer.from("%PDF-1.4\n"),
  Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
  Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
  Buffer.from("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n"),
  Buffer.from("4 0 obj\n<< /Length 15 >>\nstream\n(Hello WHO)\nendstream\nendobj\n"),
  Buffer.from("5 0 obj\n<< /Title (Healthy diet) /CreationDate (D:20260126000000Z) >>\nendobj\n"),
  Buffer.from("trailer\n<< /Root 1 0 R /Info 5 0 R >>\n%%EOF\n"),
]);

const PYRAMID_JSON = Buffer.from(
  JSON.stringify(
    [
      { layer: 1, category: "Bread", description: "whole grains", recommended_servings: "6-11" },
      { layer: 2, category: "Vegetables", description: "fresh", recommended_servings: "3-5" },
    ],
    null,
    2
  ),
  "utf8"
);

function makeJpeg(id: number, valid = true): Buffer {
  // Structurally valid minimal JPEG: SOI, APP0, SOF0, SOS + scan data, EOI.
  // Each segment declares a length consistent with its payload so the
  // audit's marker-segment walker can traverse it cleanly.
  const body = Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x01, 0x01]), // APP0, segment length 4
    Buffer.from([0xff, 0xc0, 0x00, 0x09, 0x08, 0x00, 0x04, 0x00, 0x04, 0x03, 0x01]), // SOF0, length 9
    Buffer.from([0xff, 0xda, 0x00, 0x02]), // SOS, length 2 (no header body)
    Buffer.from(`img${id}`),
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
  return valid ? body : body.subarray(0, body.length - 2); // truncated (no EOI)
}

/** The exact fake "six-byte JPEG" `FF D8 FF E0 FF D9` the reviewer flagged. */
function makeFakeSixByteJpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
}

const SOURCE_MANIFEST = JSON.stringify(
  {
    schemaVersion: "1.0",
    sources: [
      {
        file: "data/raw/WHO Guidelines.pdf",
        source_id: "who-healthy-diet-factsheet-2026",
        source_name: "WHO — World Health Organization",
        title: "Healthy diet",
        visible_date: "26 January 2026",
        review_status: "pending",
        evidence_ids: ["EG-REF-WHO-001"],
      },
    ],
    evidenceReferences: [
      { id: "EG-REF-WHO-001", purpose: "guideline_provenance", status: "pending" },
      {
        id: "EG-KOSHARI-CULTURAL-001",
        purpose: "egyptian_recipe_cultural_evidence",
        applicableTo: ["koshari", "kushari"],
        status: "pending",
      },
    ],
  },
  null,
  2
);

async function buildRoot(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, "data", "manifest"), { recursive: true });
  await fs.mkdir(path.join(dir, "data", "raw", "Food Pyramid"), { recursive: true });
  await fs.writeFile(path.join(dir, "data", "manifest", "sources.json"), SOURCE_MANIFEST);
  await fs.writeFile(path.join(dir, "data", "raw", "Egyptian_Food_Categorized.csv"), INGREDIENTS_CSV);
  await fs.writeFile(path.join(dir, "data", "raw", "Recipes For Eqyption Food.csv"), RECIPES_CSV);
  await fs.writeFile(path.join(dir, "data", "raw", "WHO Guidelines.pdf"), MIN_PDF);
  await fs.writeFile(path.join(dir, "data", "raw", "food_pyramid.json"), PYRAMID_JSON);
  for (let i = 1; i <= 18; i += 1) {
    await fs.writeFile(path.join(dir, "data", "raw", "Food Pyramid", `Food Pyramid_${String(i).padStart(4, "0")}.jpg`), makeJpeg(i));
  }
}

async function rawHashes(dir: string): Promise<Map<string, string>> {
  const rawDir = path.join(dir, "data", "raw");
  const map = new Map<string, string>();
  const add = async (p: string) => {
    map.set(path.relative(dir, p), sha(await fs.readFile(p)));
  };
  for (const f of await fs.readdir(rawDir)) {
    const full = path.join(rawDir, f);
    const st = await fs.stat(full);
    if (st.isFile()) await add(full);
  }
  const imgDir = path.join(rawDir, "Food Pyramid");
  for (const f of await fs.readdir(imgDir)) await add(path.join(imgDir, f));
  return map;
}

test("integration: runAudit uses a custom fixture root and reports all sources", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  const report = await runAudit(dir);
  assert.equal(report.sources.length, 22); // 4 + 18 images
  assert.equal(report.rawProvenance.files.length, 22);
  assert.equal(report.structurallyInvalid, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: missing source causes runAudit to throw (non-zero path)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  await fs.unlink(path.join(dir, "data", "raw", "food_pyramid.json"));
  await assert.rejects(() => runAudit(dir), /missing raw input/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: corrupt ingredient CSV causes non-zero structural failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  await fs.writeFile(
    path.join(dir, "data", "raw", "Egyptian_Food_Categorized.csv"),
    Buffer.from('FOOD,PROTEIN (g)\n"a","unterminated\n')
  );
  const report = await runAudit(dir);
  assert.equal(report.structurallyInvalid, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: corrupt recipe CSV causes non-zero structural failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  await fs.writeFile(
    path.join(dir, "data", "raw", "Recipes For Eqyption Food.csv"),
    Buffer.from('recipe_title\tcategory\n"a"\t"b"\nmalformed-row\n')
  );
  const report = await runAudit(dir);
  assert.equal(report.structurallyInvalid, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: corrupt PDF (not a PDF) causes non-zero structural failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  await fs.writeFile(path.join(dir, "data", "raw", "WHO Guidelines.pdf"), Buffer.from("not a pdf at all"));
  const report = await runAudit(dir);
  assert.equal(report.structurallyInvalid, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: corrupt pyramid JSON causes non-zero structural failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  await fs.writeFile(path.join(dir, "data", "raw", "food_pyramid.json"), Buffer.from("{ not json"));
  const report = await runAudit(dir);
  assert.equal(report.structurallyInvalid, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: invalid/truncated JPEG causes non-zero structural failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  await fs.writeFile(
    path.join(dir, "data", "raw", "Food Pyramid", "Food Pyramid_0001.jpg"),
    makeJpeg(1, false)
  );
  const report = await runAudit(dir);
  assert.equal(report.structurallyInvalid, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: image count != 18 causes non-zero structural failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  await fs.unlink(path.join(dir, "data", "raw", "Food Pyramid", "Food Pyramid_0018.jpg"));
  const report = await runAudit(dir);
  assert.equal(report.structurallyInvalid, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: candidate count is zero when C-1..C-3 provenance requirements are unmet", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  const report = await runAudit(dir);
  // The fixture recipe CSV has no source_id/source_version/access_date columns
  // and no cultural-evidence link, so C-1 and C-3 fail -> zero candidates.
  assert.equal(report.recipeClassification.counts.candidate, 0);
  const queue = JSON.parse(await fs.readFile(path.join(dir, "data", "review", "recipe-review-queue.json"), "utf8"));
  for (const rec of queue.records) {
    assert.notEqual(rec.classification, "verified_egyptian");
    assert.equal(rec.humanVerification.status, "unreviewed");
    assert.equal(rec.humanVerification.reviewerId, null);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: rows satisfying C-1..C-3 can become candidate (still never verified)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  // Add provenance/evidence columns so C-1..C-3 are satisfiable, and make the
  // first recipe carry two independent positive signals.
  await fs.writeFile(
    path.join(dir, "data", "raw", "Recipes For Eqyption Food.csv"),
    Buffer.from(
      'recipe_title\tcategory\tdirections\tingredients\tingredients_canonical\tcuisine_list\tmain_ingredient\tegy_ingredient_coverage\tsource_id\tsource_version\taccess_date\tculture_evidence_link\n' +
        '"Koshari Egyptian"\t"main"\t"boil then serve"\t"[""lentils"", ""rice""]"\t"[""lentils"", ""rice""]"\t"[""Egyptian""]"\t""\t"1"\t"src-1"\t"v1"\t"2026-01-26"\t"https://example.org/culture/koshari"\n' +
        '"Plain toast"\t"main"\t"toast"\t"[""bread""]"\t"[""bread""]"\t"[""Italian"",""French""]"\t""\t"0"\t"src-1"\t"v1"\t"2026-01-26"\t"https://example.org/culture/x"\n',
      "utf8"
    )
  );
  const report = await runAudit(dir);
  assert.equal(report.recipeClassification.counts.candidate, 1);
  const queue = JSON.parse(await fs.readFile(path.join(dir, "data", "review", "recipe-review-queue.json"), "utf8"));
  for (const rec of queue.records) {
    assert.notEqual(rec.classification, "verified_egyptian");
    assert.equal(rec.humanVerification.status, "unreviewed");
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: raw file hashes are unchanged by running the audit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  const before = await rawHashes(dir);
  await runAudit(dir);
  const after = await rawHashes(dir);
  assert.deepEqual([...before].sort(), [...after].sort());
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: curated manifest drives WHO provenance; WHO guideline-provenance ID never satisfies recipe C-3", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  // Cite the manifest's WHO guideline-provenance ID instead of a URL; access_date
  // is a strict ISO date. Even though every other gate holds, EG-REF-WHO-001 is
  // general-nutrition provenance, NOT recipe cultural evidence -> C-3 fails.
  await fs.writeFile(
    path.join(dir, "data", "raw", "Recipes For Eqyption Food.csv"),
    Buffer.from(
      'recipe_title\tcategory\tdirections\tingredients\tingredients_canonical\tcuisine_list\tmain_ingredient\tegy_ingredient_coverage\tsource_id\tsource_version\taccess_date\tculture_evidence_link\n' +
        '"Koshari Egyptian"\t"main"\t"[""boil"", ""serve""]"\t"[""lentils"", ""rice""]"\t"[""lentils"", ""rice""]"\t"[""Egyptian""]"\t""\t"1"\t"src-1"\t"v1"\t"2026-01-26"\t"EG-REF-WHO-001"\n',
      "utf8"
    )
  );
  const report = await runAudit(dir);
  // WHO guideline-provenance ID is NOT cultural evidence -> zero candidates.
  assert.equal(report.recipeClassification.counts.candidate, 0);
  // The manifest is reported (outside data/raw; raw untouched).
  assert.ok(report.sourceManifest);
  assert.ok(report.sourceManifest.relativePath.endsWith("data/manifest/sources.json"));
  assert.ok(report.sourceManifest.sources.some((s) => s.sourceId === "who-healthy-diet-factsheet-2026"));
  assert.ok(report.sourceManifest.sources.every((s) => s.reviewStatus === "pending"));
  // The guideline PDF is still identified via the explicit provenance record.
  const g = report.sources.find((s) => s.kind === "guidelines_pdf");
  assert.ok(g && g.guidelineCoverage);
  assert.equal(g.guidelineCoverage.provenanceStatus, "identified");
  assert.ok(g.guidelineCoverage.visibleSource && g.guidelineCoverage.visibleSource.includes("WHO"));
  assert.equal(g.guidelineCoverage.visibleTitle, "Healthy diet");
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: scoped cultural-evidence manifest ID satisfies C-3 (candidate, never verified)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  await fs.writeFile(
    path.join(dir, "data", "raw", "Recipes For Eqyption Food.csv"),
    Buffer.from(
      'recipe_title\tcategory\tdirections\tingredients\tingredients_canonical\tcuisine_list\tmain_ingredient\tegy_ingredient_coverage\tsource_id\tsource_version\taccess_date\tculture_evidence_link\n' +
        '"Koshari Egyptian"\t"main"\t"[""boil"", ""serve""]"\t"[""lentils"", ""rice""]"\t"[""lentils"", ""rice""]"\t"[""Egyptian""]"\t""\t"1"\t"src-1"\t"v1"\t"2026-01-26"\t"EG-KOSHARI-CULTURAL-001"\n',
      "utf8"
    )
  );
  const report = await runAudit(dir);
  // C-3 resolves the Koshari-scoped cultural-evidence ID -> candidate (never verified).
  assert.equal(report.recipeClassification.counts.candidate, 1);
  const queue = JSON.parse(await fs.readFile(path.join(dir, "data", "review", "recipe-review-queue.json"), "utf8"));
  for (const rec of queue.records) {
    assert.notEqual(rec.classification, "verified_egyptian");
    assert.equal(rec.humanVerification.status, "unreviewed");
    assert.equal(rec.humanVerification.reviewerId, null);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: cultural manifest ID scoped to another dish does not satisfy C-3", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  // Re-scope the Koshari cultural record to a different dish (Ful Medames), so
  // the loader still exposes it but it must NOT resolve for a Koshari recipe.
  const manifest = JSON.parse(SOURCE_MANIFEST);
  manifest.evidenceReferences[1].applicableTo = ["ful medames"];
  await fs.writeFile(path.join(dir, "data", "manifest", "sources.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(
    path.join(dir, "data", "raw", "Recipes For Eqyption Food.csv"),
    Buffer.from(
      'recipe_title\tcategory\tdirections\tingredients\tingredients_canonical\tcuisine_list\tmain_ingredient\tegy_ingredient_coverage\tsource_id\tsource_version\taccess_date\tculture_evidence_link\n' +
        '"Koshari Egyptian"\t"main"\t"[""boil""]"\t"[""lentils"", ""rice""]"\t"[""lentils"", ""rice""]"\t"[""Egyptian""]"\t""\t"1"\t"src-1"\t"v1"\t"2026-01-26"\t"EG-KOSHARI-CULTURAL-001"\n',
      "utf8"
    )
  );
  const report = await runAudit(dir);
  assert.equal(report.recipeClassification.counts.candidate, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: malformed manifest is a hard failure (invalid JSON)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  await fs.writeFile(path.join(dir, "data", "manifest", "sources.json"), Buffer.from("{ not json"));
  await assert.rejects(() => runAudit(dir), /manifest/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: two runs produce byte-identical report/queue outputs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  await runAudit(dir);
  const run1 = {
    json: await fs.readFile(path.join(dir, "data", "reports", "data-audit.json"), "utf8"),
    md: await fs.readFile(path.join(dir, "data", "reports", "data-audit.md"), "utf8"),
    rq: await fs.readFile(path.join(dir, "data", "review", "recipe-review-queue.json"), "utf8"),
    iq: await fs.readFile(path.join(dir, "data", "review", "ingredient-review-queue.json"), "utf8"),
  };
  await runAudit(dir);
  const run2 = {
    json: await fs.readFile(path.join(dir, "data", "reports", "data-audit.json"), "utf8"),
    md: await fs.readFile(path.join(dir, "data", "reports", "data-audit.md"), "utf8"),
    rq: await fs.readFile(path.join(dir, "data", "review", "recipe-review-queue.json"), "utf8"),
    iq: await fs.readFile(path.join(dir, "data", "review", "ingredient-review-queue.json"), "utf8"),
  };
  assert.deepEqual(run1, run2);
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: fake six-byte JPEG FF D8 FF E0 FF D9 is flagged structurally invalid", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  await fs.writeFile(
    path.join(dir, "data", "raw", "Food Pyramid", "Food Pyramid_0001.jpg"),
    makeFakeSixByteJpeg()
  );
  const report = await runAudit(dir);
  assert.equal(report.structurallyInvalid, true);
  const pyramidSource = report.sources.find((s) => s.kind === "food_pyramid_images" && s.relativePath.includes("0001.jpg"));
  assert.ok(pyramidSource);
  assert.ok(pyramidSource.structuralErrors.some((e) => e.includes("overruns file end")));
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: duplicate image hashes produce a top-level structural error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  // Make image 0002 identical to 0001 by bytes.
  const img1 = await fs.readFile(path.join(dir, "data", "raw", "Food Pyramid", "Food Pyramid_0001.jpg"));
  await fs.writeFile(path.join(dir, "data", "raw", "Food Pyramid", "Food Pyramid_0002.jpg"), img1);
  const report = await runAudit(dir);
  assert.equal(report.structurallyInvalid, true);
  assert.ok(report.structuralErrors.some((e) => e.includes("duplicate pyramid image by hash")));
  assert.ok(Array.isArray(report.structuralErrors));
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: wrong image count is a top-level structural error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  await fs.unlink(path.join(dir, "data", "raw", "Food Pyramid", "Food Pyramid_0018.jpg"));
  const report = await runAudit(dir);
  assert.equal(report.structurallyInvalid, true);
  assert.ok(report.structuralErrors.some((e) => e.includes("image count")));
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: pyramid JSON schema violations become structural errors", async () => {
  const cases: Array<{ name: string; payload: Buffer }> = [
    { name: "missing-fields", payload: Buffer.from(JSON.stringify([{ layer: 1 }])) },
    { name: "wrong-types", payload: Buffer.from(JSON.stringify([{ layer: 1, category: { x: 1 }, recommended_servings: "2", description: "d" }])) },
    { name: "scalar-root", payload: Buffer.from("42") },
    { name: "invalid-layers", payload: Buffer.from(JSON.stringify({ layers: "not-an-array" })) },
    { name: "duplicate-categories", payload: Buffer.from(JSON.stringify([{ layer: 1, category: "A", recommended_servings: "1", description: "d" }, { layer: 2, category: "A", recommended_servings: "2", description: "e" }])) },
  ];
  for (const c of cases) {
    const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
    await buildRoot(dir);
    await fs.writeFile(path.join(dir, "data", "raw", "food_pyramid.json"), c.payload);
    const report = await runAudit(dir);
    assert.equal(report.structurallyInvalid, true, `case ${c.name} should be structurally invalid`);
    if (c.name === "duplicate-categories") {
      assert.ok(report.structuralErrors.some((e) => e.includes("duplicate category")));
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function runCliAudit(rootDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // Windows requires a shell to execute `npm.cmd`. The root path is quoted so
  // spaces in the temp path are handled.
  const command = `npm run audit -- --root "${rootDir}"`;
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: process.cwd(),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("integration: CLI `npm run audit -- --root` exits 0 on a valid fixture", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  const res = await runCliAudit(dir);
  assert.equal(res.code, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: CLI `npm run audit -- --root` exits 1 on a schema-invalid pyramid JSON", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  await fs.writeFile(path.join(dir, "data", "raw", "food_pyramid.json"), Buffer.from("42"));
  const res = await runCliAudit(dir);
  assert.equal(res.code, 1);
  assert.ok(res.stderr.includes("structurally invalid") || res.stdout.includes("structurally invalid"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("integration: CLI `npm run audit -- --root` exits 1 on a fake six-byte JPEG", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nutriguard-"));
  await buildRoot(dir);
  await fs.writeFile(
    path.join(dir, "data", "raw", "Food Pyramid", "Food Pyramid_0001.jpg"),
    makeFakeSixByteJpeg()
  );
  const res = await runCliAudit(dir);
  assert.equal(res.code, 1);
  await fs.rm(dir, { recursive: true, force: true });
});
