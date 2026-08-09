/**
 * Ingredient dictionary resolution pipeline — Step 5.
 *
 * Usage: node --import tsx src/scripts/resolve-ingredients.ts [--root <dir>]
 *
 * Loads the master ingredient dictionary (`data/dictionary/ingredients.json`)
 * and the human-reviewed mappings (`data/dictionary/reviewed-mappings.json`),
 * then resolves every unique ingredient term found in the raw recipe CSV
 * (the `ingredients` list field) against the dictionary using the
 * deterministic multi-stage resolver in `src/domain/ingredients.ts`.
 *
 * Outputs (deterministic, UTF-8, written under the project's committed dirs):
 *   - `data/reports/ingredient-dictionary-coverage.{json,md}` — coverage by
 *     ingredient count and, when a per-line weight is supplied via `--weighted`,
 *     by nutritionally-significant recipe weight;
 *   - `data/review/ingredient-dictionary-review-queue.{json,md}` — ambiguous and
 *     unresolved terms for MANUAL review (fuzzy suggestions are shown but are
 *     never auto-accepted as canonical mappings).
 *
 * Hard rules (mirror DATA_SOURCE_POLICY.md / MVP_REQUIREMENTS.md):
 *   - Automation NEVER accepts a fuzzy/vector match as a canonical mapping.
 *   - Ambiguous terms (e.g. coriander leaves vs seeds, dried peas vs fresh
 *     peas) stay separate and are routed to review; they are never merged.
 *   - Every accepted mapping lists the deterministic stage that produced it.
 *   - The raw recipe CSV under `data/raw/` is never modified.
 *
 * Exits non-zero when the dictionary is invalid or nothing was resolved.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDelimited, parseListField } from "../audit/csv.js";
import { decodeText } from "../audit/text.js";
import { stableJson } from "../audit/report.js";
import {
  buildIndex,
  buildReviewQueue,
  computeCoverage,
  parseIngredientDictionary,
  parseReviewedMappings,
  parseReviewRegistry,
  resolveOccurrences,
  type IngredientCoverage,
  type IngredientOccurrence,
} from "../domain/ingredients.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const TOOL_NAME = "nutriguard-ingredient-dictionary";
const COVERAGE_SCHEMA_VERSION = "1.0";

export interface WeightedLine {
  original: string;
  recipeId: string;
  sourceRow: number;
  ingredientIndex: number;
  /** Nutritionally-significant weight of this ingredient (grams) when known. */
  weightG?: number | null;
}

export interface DictionaryRunResult {
  report: DictionaryCoverageReport;
  queue: ReturnType<typeof buildReviewQueue>;
  dictionaryPath: string;
  valid: boolean;
}

export interface DictionaryCoverageReport {
  schemaVersion: string;
  tool: string;
  dictionary: { file: string; entries: number };
  reviewedMappings: { file: string; mappings: number };
  reviewedRegistry: { file: string; records: number };
  source: string | null;
  /** Raw ingredient-list lines observed in the source CSV (every occurrence). */
  occurrencesSeen: number;
  coverage: ReturnType<typeof computeCoverage>;
  queueRecords: number;
  resolvedSummary: IngredientCoverage["resolvedSummary"];
  blockers: string[];
}

export function isDictionaryRunValid(validation: {
  dictionaryIssues: readonly string[];
  reviewedMappingIssues: readonly string[];
  reviewRegistryIssues: readonly string[];
  occurrenceCoverageIssues: readonly string[];
  weightedCoverageIssues: readonly string[];
}): boolean {
  return (
    validation.dictionaryIssues.length === 0 &&
    validation.reviewedMappingIssues.length === 0 &&
    validation.reviewRegistryIssues.length === 0 &&
    validation.occurrenceCoverageIssues.length === 0 &&
    validation.weightedCoverageIssues.length === 0
  );
}

function fmtPct(rate: number | null): string {
  return rate === null ? "n/a" : (rate * 100).toFixed(2) + "%";
}

function renderCoverageMarkdown(report: DictionaryCoverageReport): string {
  const c = report.coverage;
  const lines: string[] = [];
  lines.push(`# Ingredient Dictionary Coverage Report`);
  lines.push(``);
  lines.push(`- Tool: ${report.tool}`);
  lines.push(`- Schema version: ${report.schemaVersion}`);
  lines.push(`- Dictionary: ${report.dictionary.file} (${report.dictionary.entries} canonical records)`);
  lines.push(`- Reviewed mappings: ${report.reviewedMappings.file} (${report.reviewedMappings.mappings})`);
  lines.push(
    `- Review registry: ${report.reviewedRegistry.file} (${report.reviewedRegistry.records} content-hash-verified records)`
  );
  lines.push(`- Source: ${report.source ?? "n/a (no raw recipe CSV found)"}`);
  lines.push(`- Ingredient occurrences read: ${report.occurrencesSeen}`);
  lines.push(``);

  lines.push(`## Resolution`);
  lines.push(``);
  lines.push(`- Required ingredient occurrences: ${c.total}`);
  lines.push(`- Resolved occurrences: ${c.resolved} (${fmtPct(c.byCountRate)})`);
  lines.push(`- Ambiguous (review queue): ${c.ambiguous}`);
  lines.push(`- Unresolved (review queue): ${c.unresolved}`);
  lines.push(`- Unique normalized ingredient terms: ${c.uniqueTotal}`);
  lines.push(`- Unique-term resolution rate: ${fmtPct(c.byUniqueCountRate)}`);
  lines.push(`- By stage: normalized_exact=${c.byStage.normalized_exact} alias_exact=${c.byStage.alias_exact} reviewed_mapping=${c.byStage.reviewed_mapping}`);
  lines.push(``);

  lines.push(`## Coverage`);
  lines.push(``);
  lines.push(`- By ingredient occurrence count: ${fmtPct(c.byCountRate)}`);
  if (c.totalWeightG !== null && c.byWeightRate !== null) {
    lines.push(
      `- By nutritionally-significant recipe weight: ${fmtPct(c.byWeightRate)} (${c.resolvedWeightG ?? 0}g of ${c.totalWeightG}g mapped)`
    );
  } else {
    lines.push(
      `- By nutritionally-significant recipe weight: n/a (no per-ingredient weight supplied in this run)`
    );
  }
  lines.push(`- Distinct canonical records resolved: ${c.resolvedKeys.length}`);
  lines.push(``);

  lines.push(`## Accepted mappings (traceable, deterministic)`);
  lines.push(``);
  if (report.resolvedSummary.length === 0) {
    lines.push(`**None.** Nothing is fabricated to reach a coverage target.`);
  } else {
    for (const r of report.resolvedSummary) {
      lines.push(`- \`${r.original}\` -> \`${r.canonicalKey}\` [${r.stage}]`);
      if (r.stage === "reviewed_mapping" && r.reviewed) {
        lines.push(`  - reviewed record \`${r.reviewed.id}\` by ${r.reviewed.reviewer} on ${r.reviewed.reviewDate}`);
        lines.push(`  - evidence: ${r.reviewed.evidence}`);
        lines.push(`  - source: ${r.reviewed.source}`);
      } else if (r.provenance) {
        if (r.provenance.status === "approved") {
          lines.push(
            `  - dictionary provenance: ${r.provenance.source} (v${r.provenance.version}, approved by ${r.provenance.reviewer} on ${r.provenance.reviewDate})`
          );
        } else {
          lines.push(`  - dictionary provenance: ${r.provenance.source} (v${r.provenance.version}, status ${r.provenance.status})`);
        }
      }
    }
  }
  lines.push(``);

  lines.push(`## Blockers`);
  lines.push(``);
  for (const b of report.blockers) lines.push(`- ${b}`);
  lines.push(``);

  lines.push(`> Deterministic, read-only resolution. Fuzzy/vector matches are`);
  lines.push(`> NEVER auto-accepted as canonical mappings; ambiguous terms stay`);
  lines.push(`> separate and are routed to the manual review queue.`);
  lines.push(``);
  return lines.join("\n");
}

function renderQueueMarkdown(
  queue: ReturnType<typeof buildReviewQueue>,
  source: string
): string {
  const lines: string[] = [];
  lines.push(`# Ingredient Dictionary Review Queue`);
  lines.push(``);
  lines.push(`- Source: ${source}`);
  lines.push(`- Records: ${queue.length}`);
  lines.push(``);
  for (const r of queue) {
    const kind = r.status === "ambiguous" ? "ambiguous" : "unmatched";
    lines.push(`- [${kind}] ${r.original}`);
    for (const reason of r.reasons) lines.push(`  - ${reason}`);
    if (r.ambiguityKeys.length > 0) {
      lines.push(`  - distinct canonical candidates (NOT merged): ${r.ambiguityKeys.join(", ")}`);
    }
    if (r.suggestions.length > 0) {
      lines.push(
        `  - fuzzy suggestions (NEVER auto-accepted): ${r.suggestions.map((s) => `${s.key}@${s.score.toFixed(2)}`).join(", ")}`
      );
    }
    if (r.occurrences.length > 0) {
      const seen = r.occurrences.map((o) => `"${o.original}" in "${o.recipeId || "?"}" (row ${o.sourceRow})`).join("; ");
      lines.push(`  - occurrences: ${seen}`);
    }
  }
  lines.push(``);
  return lines.join("\n");
}

/**
 * Extract every ingredient occurrence from the raw recipe CSV (`ingredients`
 * list field). Every occurrence keeps its source context: the recipe id
 * (recipe_title column), 1-based CSV row and the index within the recipe's
 * ingredient list. The raw CSV is never modified.
 */
export async function readIngredientOccurrences(rawRoot: string): Promise<{ occurrences: IngredientOccurrence[]; source: string | null }> {
  let list: string[];
  try {
    list = await fs.readdir(rawRoot);
  } catch {
    return { occurrences: [], source: null };
  }
  const f = list.find((n) => n.toLowerCase().includes("recipes") && n.toLowerCase().endsWith(".csv"));
  if (!f) return { occurrences: [], source: null };
  const source = path.join(rawRoot, f);
  const buf = await fs.readFile(source);
  const enc = decodeText(buf);
  const parsed = parseDelimited(enc.text, "\t");
  const headers = (parsed.rows[0] ?? []).map((h) => h.trim());
  const cIngredients = headers.indexOf("ingredients");
  const cRecipeTitle = headers.indexOf("recipe_title");
  const occurrences: IngredientOccurrence[] = [];
  for (let i = 1; i < parsed.rows.length; i += 1) {
    const row = parsed.rows[i];
    if (cIngredients < 0) break;
    const raw = row[cIngredients] ?? "";
    const lines = parseListField(raw) ?? [];
    const recipeId = cRecipeTitle >= 0 ? (row[cRecipeTitle] ?? "").trim() : "";
    for (let j = 0; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === "") continue;
      occurrences.push({ original: line, recipeId, sourceRow: i + 1, ingredientIndex: j });
    }
  }
  return { occurrences, source };
}

/** Load the weighted input lines (optional): [{original, weightG}] JSON array. */
async function readWeightedLines(weightedPath: string): Promise<WeightedLine[]> {
  const raw = await fs.readFile(weightedPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`--weighted file ${weightedPath} must contain a JSON array of {original, recipeId, sourceRow, ingredientIndex, weightG?}`);
  }
  const out: WeightedLine[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const e = parsed[i] as Record<string, unknown>;
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      throw new Error(`--weighted entry ${i} must be an object`);
    }
    const original = typeof e.original === "string" && e.original.trim() !== "" ? e.original : "";
    const recipeId = typeof e.recipeId === "string" && e.recipeId.trim() !== "" ? e.recipeId.trim() : "";
    const sourceRow = typeof e.sourceRow === "number" && Number.isInteger(e.sourceRow) ? e.sourceRow : NaN;
    const ingredientIndex =
      typeof e.ingredientIndex === "number" && Number.isInteger(e.ingredientIndex) ? e.ingredientIndex : NaN;
    const weightG = e.weightG === undefined || e.weightG === null ? null : Number(e.weightG);
    if (original === "" || recipeId === "" || !Number.isFinite(sourceRow) || !Number.isFinite(ingredientIndex)) {
      throw new Error(
        `--weighted entry ${i} must include original, recipeId, sourceRow, and ingredientIndex`
      );
    }
    if (weightG !== null && (!Number.isFinite(weightG) || weightG <= 0)) {
      throw new Error(`--weighted entry ${i} has invalid weightG`);
    }
    out.push({ original, recipeId, sourceRow, ingredientIndex, weightG });
  }
  return out;
}

export function resolveDictionary(root = PROJECT_ROOT): Promise<DictionaryRunResult> {
  return runResolveDictionary(root);
}

async function runResolveDictionary(root: string): Promise<DictionaryRunResult> {
  const dictionaryPath = path.join(root, "data", "dictionary", "ingredients.json");
  const reviewedPath = path.join(root, "data", "dictionary", "reviewed-mappings.json");
  const reviewedRegistryPath = path.join(root, "data", "dictionary", "review-registry.json");
  const rawRoot = path.join(root, "data", "raw");
  const reportsDir = path.join(root, "data", "reports");
  const reviewDir = path.join(root, "data", "review");
  const rel = (p: string) => path.relative(root, p).replaceAll("\\", "/");

  let dictionaryRaw: unknown;
  try {
    dictionaryRaw = JSON.parse((await fs.readFile(dictionaryPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`ingredient dictionary ${rel(dictionaryPath)} is missing (Step 5 requires it)`);
    }
    throw err;
  }
  const dict = parseIngredientDictionary(dictionaryRaw);
  const knownKeys = new Set(dict.entries.map((e) => e.key));
  let reviewedRaw: unknown = [];
  try {
    reviewedRaw = JSON.parse((await fs.readFile(reviewedPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    reviewedRaw = [];
  }
  let reviewedRegistryRaw: unknown;
  try {
    reviewedRegistryRaw = JSON.parse((await fs.readFile(reviewedRegistryPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    reviewedRegistryRaw = null;
  }
  const reviewedRegistry = parseReviewRegistry(reviewedRegistryRaw);
  const reviewed = parseReviewedMappings(reviewedRaw, knownKeys, reviewedRegistry);

  const index = buildIndex(dict.entries);
  const { occurrences, source } = await readIngredientOccurrences(rawRoot);
  const weightedPath = process.argv.indexOf("--weighted");
  let weighted: WeightedLine[] | null = null;
  if (weightedPath !== -1 && process.argv[weightedPath + 1]) {
    weighted = await readWeightedLines(path.resolve(process.argv[weightedPath + 1]));
  }

  // Dedup by normalized identity while PRESERVING every occurrence context.
  const resolutions = resolveOccurrences(occurrences, { index, reviewed: reviewed.mappings });
  const coverage = computeCoverage(resolutions, weighted);
  const queue = buildReviewQueue(resolutions);
  const occurrenceCoverageIssues: string[] = [];
  if (coverage.total !== occurrences.length) {
    occurrenceCoverageIssues.push(
      `counted ${coverage.total} occurrences but extracted ${occurrences.length}; no source occurrence may be dropped`
    );
  }

  const blockers: string[] = [];
  for (const issue of dict.issues) blockers.push(`dictionary validation: ${issue}`);
  for (const issue of reviewed.issues) blockers.push(`reviewed-mappings validation: ${issue}`);
  for (const issue of reviewedRegistry.issues) blockers.push(`review-registry validation: ${issue}`);
  for (const issue of occurrenceCoverageIssues) blockers.push(`occurrence coverage: ${issue}`);
  for (const issue of coverage.weightedIssues) blockers.push(`weighted coverage: ${issue}`);
  if (source === null) blockers.push("No raw recipe CSV found under data/raw — no ingredient terms to resolve.");
  if (dict.entries.length === 0) blockers.push("The ingredient dictionary is empty — coverage cannot be computed.");
  if (occurrences.length === 0) blockers.push("The raw recipe CSV has no ingredient occurrences to resolve.");
  if (coverage.resolved === 0) {
    blockers.push(
      "0 ingredient occurrences are mapped to an approved canonical record — acceptance target is not met and is not being fabricated."
    );
  }
  if (coverage.ambiguous > 0 || coverage.unresolved > 0) {
    blockers.push(
      `${coverage.ambiguous + coverage.unresolved} counted occurrences are routed to ${queue.length} unique review records; approved mappings require a content-hash-verified record in data/dictionary/review-registry.json.`
    );
  }

  const report: DictionaryCoverageReport = {
    schemaVersion: COVERAGE_SCHEMA_VERSION,
    tool: TOOL_NAME,
    dictionary: { file: rel(dictionaryPath), entries: dict.entries.length },
    reviewedMappings: { file: rel(reviewedPath), mappings: reviewed.mappings.size },
    reviewedRegistry: { file: rel(reviewedRegistryPath), records: reviewedRegistry.records.length },
    source: source ? rel(source) : null,
    occurrencesSeen: occurrences.length,
    coverage,
    queueRecords: queue.length,
    resolvedSummary: coverage.resolvedSummary,
    blockers,
  };

  await fs.mkdir(reportsDir, { recursive: true });
  await fs.mkdir(reviewDir, { recursive: true });
  await fs.writeFile(
    path.join(reportsDir, "ingredient-dictionary-coverage.json"),
    stableJson(report),
    "utf8"
  );
  await fs.writeFile(
    path.join(reportsDir, "ingredient-dictionary-coverage.md"),
    renderCoverageMarkdown(report),
    "utf8"
  );
  await fs.writeFile(
    path.join(reviewDir, "ingredient-dictionary-review-queue.json"),
    stableJson({ records: queue }),
    "utf8"
  );
  await fs.writeFile(
    path.join(reviewDir, "ingredient-dictionary-review-queue.md"),
    renderQueueMarkdown(queue, source ? rel(source) : "n/a"),
    "utf8"
  );

  return {
    report,
    queue,
    dictionaryPath,
    valid: isDictionaryRunValid({
      dictionaryIssues: dict.issues,
      reviewedMappingIssues: reviewed.issues,
      reviewRegistryIssues: reviewedRegistry.issues,
      occurrenceCoverageIssues,
      weightedCoverageIssues: coverage.weightedIssues,
    }),
  };
}

async function main(): Promise<void> {
  let root = PROJECT_ROOT;
  const args = process.argv.slice(2);
  const rootArg = args.indexOf("--root");
  if (rootArg !== -1 && args[rootArg + 1]) root = path.resolve(args[rootArg + 1]);

  try {
    // The report + review queue are generated inside resolveDictionary BEFORE
    // this point, so they are always written even when acceptance fails below.
    const result = await resolveDictionary(root);
    const c = result.report.coverage;
    console.log(
      `ingredient dictionary: ${result.report.dictionary.entries} records; ` +
        `${result.report.occurrencesSeen} raw occurrences -> ${c.total} counted occurrences -> ${c.resolved} resolved (${fmtPct(c.byCountRate)}), ` +
        `${c.uniqueTotal} unique terms (${fmtPct(c.byUniqueCountRate)}); ` +
        `${c.ambiguous} ambiguous, ${c.unresolved} unresolved; ${result.report.queueRecords} unique review records`
    );
    // Acceptance contract: zero accepted (resolved) mappings is a blocking
    // acceptance failure. The honest report + queue have already been written.
    if (c.resolved === 0) {
      console.error(
        "ingredient dictionary acceptance FAILED: 0 ingredient occurrences mapped to an approved canonical record (see coverage report blockers)."
      );
      process.exitCode = 1;
    } else if (!result.valid) {
      console.error("ingredient dictionary validation FAILED (see coverage report blockers)");
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`ingredient dictionary: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  void main();
}
