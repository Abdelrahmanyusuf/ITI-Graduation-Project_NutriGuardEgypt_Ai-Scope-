/**
 * Read-only data audit runner.
 *
 * Usage: node --import tsx src/scripts/run-audit.ts [--root <dir>]
 *
 * Reads raw sources, produces:
 *   data/reports/data-audit.json
 *   data/reports/data-audit.md
 *   data/review/recipe-review-queue.json
 *   data/review/recipe-review-queue.md
 *   data/review/ingredient-review-queue.json
 *   data/review/ingredient-review-queue.md
 *
 * Output directories are always relative to the passed `root` (for tests this
 * may be a custom fixture root). Raw hashes (SHA-256) and byte sizes are
 * recorded in the JSON report. Never writes under data/raw/.
 *
 * Exits non-zero if: any source is structurally invalid, a required source is
 * missing, the pyramid image count != 18, or an unexpected exception occurs.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { buildIngredientVocabulary, scanIngredients } from "../audit/scan-ingredients.js";
import { scanRecipes } from "../audit/scan-recipes.js";
import { scanGuidelines } from "../audit/scan-guidelines.js";
import { scanPyramidJson } from "../audit/scan-pyramid-json.js";
import { scanPyramidImage } from "../audit/scan-pyramid-image.js";
import { renderAuditMarkdown, renderQueueMarkdown, stableJson } from "../audit/report.js";
import type { CulturalEvidenceRecord } from "../audit/egyptian-evidence.js";
import type {
  AuditReport,
  RecipeClassRecord,
  RecipeReviewClass,
  SourceAudit,
  SourceManifestReport,
} from "../audit/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const CLAIMED_BASELINE = "0.63% (claimed in Step 2 spec; verified against 29/4,633 unique normalized terms)";
const EXPECTED_IMAGE_COUNT = 18;

interface RawInputs {
  recipesCsv: string;
  ingredientsCsv: string;
  guidelinesPdf: string;
  pyramidJson: string;
  pyramidDir: string;
  pyramidImages: string[];
}

/** Discover required raw sources under a root directory; throws if any is missing. */
async function collectInputs(rawRoot: string): Promise<RawInputs> {
  const list = await fs.readdir(rawRoot);
  const recipesCsv = list.find((f) => f.toLowerCase().includes("recipes") && f.toLowerCase().endsWith(".csv"));
  const ingredientsCsv = list.find((f) => f.toLowerCase().includes("categorized") && f.toLowerCase().endsWith(".csv"));
  const guidelinesPdf = list.find((f) => f.toLowerCase().endsWith(".pdf"));
  const pyramidJson = list.find((f) => f.toLowerCase() === "food_pyramid.json");
  const pyramidDir = path.join(rawRoot, "Food Pyramid");

  let pyramidImages: string[] = [];
  try {
    const imgs = await fs.readdir(pyramidDir);
    pyramidImages = imgs.filter((f) => /\.(jpe?g)$/i.test(f)).sort();
  } catch {
    // image dir absent -> zero images (runner will fail on count below)
  }

  const requireFile = (name: string | undefined, label: string): string => {
    if (!name) throw new Error(`missing raw input under ${rawRoot}: ${label}`);
    return path.join(rawRoot, name);
  };

  return {
    recipesCsv: requireFile(recipesCsv, "recipe CSV"),
    ingredientsCsv: requireFile(ingredientsCsv, "ingredient/reference CSV"),
    guidelinesPdf: requireFile(guidelinesPdf, "guideline PDF"),
    pyramidJson: requireFile(pyramidJson, "food pyramid JSON"),
    pyramidDir,
    pyramidImages: pyramidImages.map((f) => path.join(pyramidDir, f)),
  };
}

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function countClasses(records: RecipeClassRecord[]): Record<RecipeReviewClass, number> {
  const counts: Record<RecipeReviewClass, number> = {
    candidate: 0,
    needs_review: 0,
    not_egyptian: 0,
    rejected: 0,
  };
  for (const r of records) counts[r.classification] += 1;
  return counts;
}

interface ManifestEntry {
  file?: string;
  source_id?: string;
  source_name?: string;
  title?: string | null;
  visible_date?: string | null;
  review_status?: string;
  evidence_ids?: string[];
}

interface ManifestEvidenceRef {
  id?: string;
  purpose?: string;
  applicableTo?: string[];
}

interface LoadedManifest {
  manifest: SourceManifestReport | null;
  provenance?: { source?: string; title?: string; date?: string };
  /** Evidence records typed `egyptian_recipe_cultural_evidence` (dish-scoped);
   * the only manifest IDs eligible for recipe C-3. */
  culturalEvidence: CulturalEvidenceRecord[];
}

/**
 * Load the curated audit source manifest (`data/manifest/sources.json`, OUTSIDE
 * data/raw) when present. It supplies the explicit provenance record for the
 * guideline PDF (identity/title/visible date) and purpose-typed evidence
 * references. `guideline_provenance` references (e.g. the WHO factsheet
 * `EG-REF-WHO-001`) identify the guideline source but are NEVER eligible for
 * recipe C-3; only `egyptian_recipe_cultural_evidence` references with a
 * dish-matching applicability scope (e.g. `EG-KOSHARI-CULTURAL-001`) may
 * resolve a C-3 claim. A malformed manifest is a hard failure; an absent
 * manifest is optional (the audit proceeds with no explicit provenance).
 */
async function loadSourceManifest(
  root: string,
  guidelinesRelPath: string,
  sha: (buf: Uint8Array) => string
): Promise<LoadedManifest> {
  const manifestPath = path.join(root, "data", "manifest", "sources.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { manifest: null, culturalEvidence: [] };
    }
    throw err;
  }

  let parsed: { schemaVersion?: string; sources?: ManifestEntry[]; evidenceReferences?: ManifestEvidenceRef[] };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`audit source manifest ${path.relative(root, manifestPath)} is not valid JSON`);
  }
  const entries = Array.isArray(parsed.sources) ? parsed.sources : [];
  for (const e of entries) {
    if (!e || typeof e.file !== "string" || typeof e.source_id !== "string") {
      throw new Error(`audit source manifest ${path.relative(root, manifestPath)}: each source needs file + source_id`);
    }
  }

  const rel = (p: string) => path.relative(root, p).replaceAll("\\", "/");
  const culturalEvidence: CulturalEvidenceRecord[] = [];
  for (const ref of parsed.evidenceReferences ?? []) {
    if (!ref || typeof ref.id !== "string" || ref.id.trim() === "") {
      throw new Error(`audit source manifest ${path.relative(root, manifestPath)}: each evidenceReference needs a non-empty id`);
    }
    const purpose = typeof ref.purpose === "string" ? ref.purpose.trim() : "guideline_provenance";
    if (purpose === "egyptian_recipe_cultural_evidence") {
      const applicableTo = Array.isArray(ref.applicableTo)
        ? ref.applicableTo.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter((s) => s !== "")
        : [];
      if (applicableTo.length === 0) {
        throw new Error(
          `audit source manifest ${path.relative(root, manifestPath)}: evidence id "${ref.id}" with purpose egyptian_recipe_cultural_evidence needs a non-empty applicableTo dish list`
        );
      }
      culturalEvidence.push({ id: ref.id.trim(), applicableTo });
    }
  }

  const sourceEntry = entries.find((e) => e.file === guidelinesRelPath);
  const provenance: LoadedManifest["provenance"] = sourceEntry
    ? {
        source: sourceEntry.source_name,
        title: sourceEntry.title ?? undefined,
        date: sourceEntry.visible_date ?? undefined,
      }
    : undefined;

  return {
    manifest: {
      relativePath: rel(manifestPath),
      sha256: sha(Buffer.from(raw, "utf8")),
      sources: entries.map((e) => ({
        file: e.file ?? "",
        sourceId: e.source_id ?? "",
        name: e.source_name ?? "",
        title: e.title ?? null,
        reviewStatus: e.review_status ?? "pending",
      })),
    },
    provenance,
    culturalEvidence,
  };
}

export async function runAudit(root = PROJECT_ROOT): Promise<AuditReport> {
  const rawRoot = path.join(root, "data", "raw");
  const reportsDir = path.join(root, "data", "reports");
  const reviewDir = path.join(root, "data", "review");

  const inputs = await collectInputs(rawRoot);
  const read = (p: string) => fs.readFile(p);

  const rel = (p: string) => path.relative(root, p).replaceAll("\\", "/");

  // Curated provenance manifest (OUTSIDE data/raw). Optional: absent -> the
  // guideline PDF is reported with no explicit WHO provenance.
  const loadedManifest = await loadSourceManifest(root, rel(inputs.guidelinesPdf), sha256);

  const ingredientsBytes = await read(inputs.ingredientsCsv);
  const ingredientsAudit = scanIngredients({ relativePath: rel(inputs.ingredientsCsv), bytes: ingredientsBytes });

  const { vocabulary } = buildIngredientVocabulary(ingredientsBytes);

  const recipesBytes = await read(inputs.recipesCsv);
  const recipeResult = scanRecipes({
    relativePath: rel(inputs.recipesCsv),
    bytes: recipesBytes,
    vocabulary,
    culturalEvidence: loadedManifest.culturalEvidence,
  });

  const guidelinesAudit = scanGuidelines({
    relativePath: rel(inputs.guidelinesPdf),
    bytes: await read(inputs.guidelinesPdf),
    provenance: loadedManifest.provenance,
  });

  const pyramidJsonAudit = scanPyramidJson({
    relativePath: rel(inputs.pyramidJson),
    bytes: await read(inputs.pyramidJson),
  });

  const pyramidImageAudits: SourceAudit[] = [];
  const rawFiles: string[] = [inputs.recipesCsv, inputs.ingredientsCsv, inputs.guidelinesPdf, inputs.pyramidJson];
  for (const img of inputs.pyramidImages) {
    path.relative(root, img);
    rawFiles.push(img);
    const b = await read(img);
    pyramidImageAudits.push(scanPyramidImage({ relativePath: rel(img), bytes: b }));
  }

  // Aggregate structural errors across ALL sources.
  const structuralErrors: string[] = [];
  for (const audit of [ingredientsAudit, recipeResult.audit, guidelinesAudit, pyramidJsonAudit, ...pyramidImageAudits]) {
    for (const e of audit.structuralErrors) structuralErrors.push(`${audit.relativePath}: ${e}`);
  }
  if (inputs.pyramidImages.length !== EXPECTED_IMAGE_COUNT) {
    structuralErrors.push(
      `food pyramid image count is ${inputs.pyramidImages.length}, expected ${EXPECTED_IMAGE_COUNT}`
    );
  }

  // Raw provenance: SHA-256 + byte size for every raw input (before any report is written).
  const provenanceFiles: Array<{ relativePath: string; sha256: string; byteSize: number }> = [];
  for (const rawPath of rawFiles) {
    const buf = await read(rawPath);
    provenanceFiles.push({
      relativePath: rel(rawPath),
      sha256: sha256(buf),
      byteSize: buf.length,
    });
  }
  provenanceFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  // Detect duplicate images by hash across the 18.
  const byHash = new Map<string, string[]>();
  for (const img of inputs.pyramidImages) {
    const hash = sha256(await read(img));
    const bucket = byHash.get(hash) ?? [];
    bucket.push(rel(img));
    byHash.set(hash, bucket);
  }
  const duplicateImageGroups = [...byHash.values()]
    .filter((g) => g.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (duplicateImageGroups.length > 0) {
    for (const group of duplicateImageGroups) {
      structuralErrors.push(`duplicate pyramid image by hash: ${group.join(", ")}`);
    }
  }

  const classificationRecords = recipeResult.classificationRecords;
  const ingredientQueue = recipeResult.ingredientQueue;

  const report: AuditReport = {
    schemaVersion: "1.0",
    tool: "nutriguard-egypt-data-audit",
    rawRoot: "data/raw",
    sources: [
      ingredientsAudit,
      recipeResult.audit,
      guidelinesAudit,
      pyramidJsonAudit,
      ...pyramidImageAudits,
    ],
    recipeClassification: { counts: countClasses(classificationRecords) },
    ingredientMatching: {
      claimedBaseline: CLAIMED_BASELINE,
      recalculated: recipeResult.audit.exactIngredientMatch ?? { numerator: 0, denominator: 0, rate: null },
      uniqueTerms: recipeResult.audit.uniqueIngredientTerms.count,
    },
    rawProvenance: { files: provenanceFiles },
    sourceManifest: loadedManifest.manifest,
    structuralErrors,
    structurallyInvalid: structuralErrors.length > 0,
  };

  // Persist outputs (deterministic; no timestamps).
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.mkdir(reviewDir, { recursive: true });

  const recipeSource = rel(inputs.recipesCsv);
  const ingredientSource = rel(inputs.ingredientsCsv);

  await fs.writeFile(path.join(reportsDir, "data-audit.json"), stableJson(report), "utf8");
  await fs.writeFile(path.join(reportsDir, "data-audit.md"), renderAuditMarkdown(report), "utf8");
  await fs.writeFile(
    path.join(reviewDir, "recipe-review-queue.json"),
    stableJson({ source: recipeSource, records: classificationRecords }),
    "utf8"
  );
  await fs.writeFile(
    path.join(reviewDir, "recipe-review-queue.md"),
    renderQueueMarkdown("recipe", classificationRecords, recipeSource),
    "utf8"
  );
  await fs.writeFile(
    path.join(reviewDir, "ingredient-review-queue.json"),
    stableJson({ source: ingredientSource, records: ingredientQueue }),
    "utf8"
  );
  await fs.writeFile(
    path.join(reviewDir, "ingredient-review-queue.md"),
    renderQueueMarkdown("ingredient", ingredientQueue, ingredientSource),
    "utf8"
  );

  return report;
}

async function main(): Promise<void> {
  let root = PROJECT_ROOT;
  const args = process.argv.slice(2);
  const rootArg = args.indexOf("--root");
  if (rootArg !== -1 && args[rootArg + 1]) root = path.resolve(args[rootArg + 1]);

  try {
    const report = await runAudit(root);
    console.log(`audit complete: ${report.sources.length} source(s), ${report.sources.reduce((s, x) => s + x.docCount, 0)} document(s)`);
    if (report.structurallyInvalid) {
      console.error("ERROR: structurally invalid or missing inputs found; exiting non-zero");
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`audit failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  void main();
}