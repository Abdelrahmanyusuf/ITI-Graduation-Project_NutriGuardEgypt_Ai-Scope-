/** Step 6 deterministic quantity/unit normalization and coverage report. */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { stableJson } from "../audit/report.js";
import {
  buildIndex,
  normalizeWithState,
  parseIngredientDictionary,
  parseIngredientLine,
  parseReviewedMappings,
  parseReviewRegistry,
  resolveOccurrences,
  type IngredientOccurrence,
  type IngredientResolution,
} from "../domain/ingredients.js";
import {
  convertIngredientAmount,
  parseIngredientAmount,
  parseUnitConversionRegistry,
  type ConversionStatus,
  type MeasureVariant,
  type UnitCode,
} from "../domain/quantities.js";
import { readIngredientOccurrences } from "./resolve-ingredients.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(currentDir, "..", "..");

export interface QuantityCoverageReport {
  schemaVersion: "1.0";
  tool: "nutriguard-unit-normalizer";
  source: string | null;
  registry: {
    file: string;
    units: number;
    ingredientConversions: number;
    ediblePortionFactors: number;
    cookingYieldFactors: number;
  };
  occurrencesSeen: number;
  countedOccurrences: number;
  quantityParsed: number;
  quantityParsingRate: number | null;
  unitNormalized: number;
  unitNormalizationRate: number | null;
  gramConverted: number;
  gramConversionRate: number | null;
  acceptedIngredientMappings: number;
  byStatus: Record<ConversionStatus, number>;
  byUnit: Partial<Record<UnitCode, number>>;
  byMeasureVariant: Partial<Record<MeasureVariant, number>>;
  byConversionId: Record<string, number>;
  reviewQueueRecords: number;
  blockers: string[];
}

export interface QuantityReviewRecord {
  original: string;
  originalQuantity: string | null;
  originalUnit: string | null;
  normalizedUnit: UnitCode | null;
  measureVariant: MeasureVariant | null;
  ingredientText: string;
  ingredientKey: string | null;
  foodState: string | null;
  status: ConversionStatus;
  reasonCodes: string[];
  occurrences: IngredientOccurrence[];
}

export interface QuantityNormalizationRunResult {
  report: QuantityCoverageReport;
  queue: QuantityReviewRecord[];
  valid: boolean;
}

function occurrenceKey(occurrence: IngredientOccurrence): string {
  return `${occurrence.recipeId}#${occurrence.sourceRow}#${occurrence.ingredientIndex}`;
}

function resolutionIdentity(original: string): string {
  const parsed = parseIngredientLine(original);
  const name = normalizeWithState(parsed.name);
  return name !== "" ? `name:${name}` : `raw:${original.normalize("NFKC").trim().toLowerCase()}`;
}

function fmtRate(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function markdownEscape(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function renderCoverage(report: QuantityCoverageReport): string {
  const lines = [
    "# Unit Normalization Coverage Report",
    "",
    `- Tool: ${report.tool}`,
    `- Source: ${report.source ?? "n/a"}`,
    `- Registry: ${report.registry.file}`,
    `- Units: ${report.registry.units}`,
    `- Sourced ingredient conversions: ${report.registry.ingredientConversions}`,
    `- Sourced edible-portion factors: ${report.registry.ediblePortionFactors}`,
    `- Sourced cooking-yield factors: ${report.registry.cookingYieldFactors}`,
    "",
    "## Coverage",
    "",
    `- Ingredient occurrences: ${report.occurrencesSeen}`,
    `- Counted occurrences: ${report.countedOccurrences}`,
    `- Quantity parsed: ${report.quantityParsed} (${fmtRate(report.quantityParsingRate)})`,
    `- Unit normalized: ${report.unitNormalized} (${fmtRate(report.unitNormalizationRate)})`,
    `- Gram converted: ${report.gramConverted} (${fmtRate(report.gramConversionRate)})`,
    `- Accepted ingredient mappings available: ${report.acceptedIngredientMappings}`,
    `- Statuses: converted=${report.byStatus.converted}, partial=${report.byStatus.partial}, unsupported=${report.byStatus.unsupported}, invalid=${report.byStatus.invalid}`,
    `- Measure variants: standard=${report.byMeasureVariant.standard ?? 0}, egyptian_household=${report.byMeasureVariant.egyptian_household ?? 0}`,
    `- Review queue records: ${report.reviewQueueRecords}`,
    "",
    "## Blockers",
    "",
    ...(report.blockers.length > 0 ? report.blockers.map((item) => `- ${item}`) : ["- None."]),
    "",
    "> Unsupported and partial records have no fabricated gram value. Fuzzy/LLM output is never used.",
    "",
  ];
  return lines.join("\n");
}

function renderQueue(queue: readonly QuantityReviewRecord[]): string {
  const lines = [
    "# Unit Normalization Review Queue",
    "",
    "| Original | Quantity | Unit | Canonical unit | Measure variant | Ingredient key | Status | Reasons | Occurrences |",
    "|---|---|---|---|---|---|---|---|---:|",
  ];
  for (const item of queue) {
    lines.push(
      `| ${markdownEscape(item.original)} | ${markdownEscape(item.originalQuantity ?? "")} | ${markdownEscape(item.originalUnit ?? "")} | ${item.normalizedUnit ?? ""} | ${item.measureVariant ?? ""} | ${item.ingredientKey ?? ""} | ${item.status} | ${markdownEscape(item.reasonCodes.join(", "))} | ${item.occurrences.length} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

export async function normalizeQuantityDataset(root = PROJECT_ROOT): Promise<QuantityNormalizationRunResult> {
  const dictionaryPath = path.join(root, "data", "dictionary", "ingredients.json");
  const reviewedPath = path.join(root, "data", "dictionary", "reviewed-mappings.json");
  const reviewRegistryPath = path.join(root, "data", "dictionary", "review-registry.json");
  const unitRegistryPath = path.join(root, "data", "dictionary", "unit-conversions.json");
  const rawRoot = path.join(root, "data", "raw");
  const reportDir = path.join(root, "data", "reports");
  const reviewDir = path.join(root, "data", "review");
  const rel = (value: string): string => path.relative(root, value).replaceAll("\\", "/");

  const dictionaryRaw = JSON.parse((await fs.readFile(dictionaryPath, "utf8")).replace(/^\uFEFF/, "")) as unknown;
  const reviewedRaw = JSON.parse((await fs.readFile(reviewedPath, "utf8")).replace(/^\uFEFF/, "")) as unknown;
  const reviewRegistryRaw = JSON.parse((await fs.readFile(reviewRegistryPath, "utf8")).replace(/^\uFEFF/, "")) as unknown;
  const unitRegistryRaw = JSON.parse((await fs.readFile(unitRegistryPath, "utf8")).replace(/^\uFEFF/, "")) as unknown;

  const dictionary = parseIngredientDictionary(dictionaryRaw);
  const knownKeys = new Set(dictionary.entries.map((entry) => entry.key));
  const reviewRegistry = parseReviewRegistry(reviewRegistryRaw);
  const reviewed = parseReviewedMappings(reviewedRaw, knownKeys, reviewRegistry);
  const unitRegistry = parseUnitConversionRegistry(unitRegistryRaw, knownKeys);
  const { occurrences, source } = await readIngredientOccurrences(rawRoot);
  const resolutions = resolveOccurrences(occurrences, {
    index: buildIndex(dictionary.entries),
    reviewed: reviewed.mappings,
  });

  const resolutionByOccurrence = new Map<string, IngredientResolution>();
  const resolutionByIdentity = new Map<string, IngredientResolution>();
  for (const resolution of resolutions) {
    resolutionByIdentity.set(resolutionIdentity(resolution.original), resolution);
    for (const occurrence of resolution.occurrences) resolutionByOccurrence.set(occurrenceKey(occurrence), resolution);
  }

  const byStatus: Record<ConversionStatus, number> = { converted: 0, partial: 0, unsupported: 0, invalid: 0 };
  const byUnit: Partial<Record<UnitCode, number>> = {};
  const byMeasureVariant: Partial<Record<MeasureVariant, number>> = {};
  const byConversionId: Record<string, number> = {};
  const queueGroups = new Map<string, QuantityReviewRecord>();
  let quantityParsed = 0;
  let unitNormalized = 0;
  let gramConverted = 0;
  let acceptedIngredientMappings = 0;

  for (const occurrence of occurrences) {
    const resolution = resolutionByOccurrence.get(occurrenceKey(occurrence))
      ?? resolutionByIdentity.get(resolutionIdentity(occurrence.original));
    const ingredientKey = resolution?.status === "resolved" ? resolution.canonicalKey : null;
    if (ingredientKey) acceptedIngredientMappings += 1;
    const parsed = parseIngredientAmount(occurrence.original, unitRegistry);
    const converted = convertIngredientAmount(occurrence.original, {
      registry: unitRegistry,
      ingredientKey,
      foodState: resolution?.foodState ?? null,
    });
    if (parsed.quantity.value) quantityParsed += 1;
    if (parsed.normalizedUnit) {
      unitNormalized += 1;
      byUnit[parsed.normalizedUnit] = (byUnit[parsed.normalizedUnit] ?? 0) + 1;
    }
    if (parsed.measureVariant) {
      byMeasureVariant[parsed.measureVariant] = (byMeasureVariant[parsed.measureVariant] ?? 0) + 1;
    }
    if (converted.grams) gramConverted += 1;
    byStatus[converted.status] += 1;
    if (converted.conversionId) {
      byConversionId[converted.conversionId] = (byConversionId[converted.conversionId] ?? 0) + 1;
    }
    if (converted.status !== "converted") {
      const key = `${converted.status}|${converted.original}|${converted.ingredientKey ?? ""}`;
      const existing = queueGroups.get(key);
      if (existing) {
        existing.occurrences.push(occurrence);
      } else {
        queueGroups.set(key, {
          original: converted.original,
          originalQuantity: converted.originalQuantity,
          originalUnit: converted.originalUnit,
          normalizedUnit: converted.normalizedUnit,
          measureVariant: converted.measureVariant,
          ingredientText: converted.ingredientText,
          ingredientKey: converted.ingredientKey,
          foodState: converted.foodState,
          status: converted.status,
          reasonCodes: converted.reasonCodes,
          occurrences: [occurrence],
        });
      }
    }
  }

  const queue = [...queueGroups.values()].sort(
    (a, b) => a.original.localeCompare(b.original) || a.status.localeCompare(b.status)
  );
  const blockers: string[] = [];
  for (const issue of dictionary.issues) blockers.push(`dictionary validation: ${issue}`);
  for (const issue of reviewRegistry.issues) blockers.push(`review registry validation: ${issue}`);
  for (const issue of reviewed.issues) blockers.push(`reviewed mappings validation: ${issue}`);
  for (const issue of unitRegistry.issues) blockers.push(`unit registry validation: ${issue}`);
  if (!source) blockers.push("No raw recipe CSV was found.");
  if (occurrences.length === 0) blockers.push("No ingredient occurrences were extracted.");
  if (byStatus.converted + byStatus.partial + byStatus.unsupported + byStatus.invalid !== occurrences.length) {
    blockers.push("Status counts do not equal extracted occurrences.");
  }
  if (acceptedIngredientMappings === 0) {
    blockers.push(
      "No approved Step 5 ingredient mappings are available, so ingredient-specific factors cannot be applied to production rows."
    );
  }
  if (gramConverted === 0) blockers.push("No occurrence could be converted to grams.");

  const total = occurrences.length;
  const report: QuantityCoverageReport = {
    schemaVersion: "1.0",
    tool: "nutriguard-unit-normalizer",
    source: source ? rel(source) : null,
    registry: {
      file: rel(unitRegistryPath),
      units: unitRegistry.units.size,
      ingredientConversions: unitRegistry.ingredientConversions.length,
      ediblePortionFactors: unitRegistry.ediblePortionFactors.length,
      cookingYieldFactors: unitRegistry.cookingYieldFactors.length,
    },
    occurrencesSeen: total,
    countedOccurrences: byStatus.converted + byStatus.partial + byStatus.unsupported + byStatus.invalid,
    quantityParsed,
    quantityParsingRate: total > 0 ? quantityParsed / total : null,
    unitNormalized,
    unitNormalizationRate: total > 0 ? unitNormalized / total : null,
    gramConverted,
    gramConversionRate: total > 0 ? gramConverted / total : null,
    acceptedIngredientMappings,
    byStatus,
    byUnit: Object.fromEntries(Object.entries(byUnit).sort(([a], [b]) => a.localeCompare(b))),
    byMeasureVariant: Object.fromEntries(Object.entries(byMeasureVariant).sort(([a], [b]) => a.localeCompare(b))),
    byConversionId: Object.fromEntries(Object.entries(byConversionId).sort(([a], [b]) => a.localeCompare(b))),
    reviewQueueRecords: queue.length,
    blockers,
  };

  await fs.mkdir(reportDir, { recursive: true });
  await fs.mkdir(reviewDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(reportDir, "unit-normalization-coverage.json"), stableJson(report), "utf8"),
    fs.writeFile(path.join(reportDir, "unit-normalization-coverage.md"), renderCoverage(report), "utf8"),
    fs.writeFile(path.join(reviewDir, "unit-normalization-review-queue.json"), stableJson({ records: queue }), "utf8"),
    fs.writeFile(path.join(reviewDir, "unit-normalization-review-queue.md"), renderQueue(queue), "utf8"),
  ]);

  const valid =
    dictionary.issues.length === 0 &&
    reviewRegistry.issues.length === 0 &&
    reviewed.issues.length === 0 &&
    unitRegistry.issues.length === 0 &&
    report.countedOccurrences === report.occurrencesSeen &&
    acceptedIngredientMappings > 0 &&
    gramConverted > 0;
  return { report, queue, valid };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 && args[rootIndex + 1] ? path.resolve(args[rootIndex + 1]) : PROJECT_ROOT;
  try {
    const result = await normalizeQuantityDataset(root);
    const report = result.report;
    console.log(
      `unit normalization: ${report.occurrencesSeen} occurrences; ` +
        `${report.quantityParsed} quantities (${fmtRate(report.quantityParsingRate)}), ` +
        `${report.unitNormalized} units (${fmtRate(report.unitNormalizationRate)}), ` +
        `${report.gramConverted} gram conversions (${fmtRate(report.gramConversionRate)}); ` +
        `${report.reviewQueueRecords} review records`
    );
    if (!result.valid) {
      console.error("unit normalization validation FAILED (see report blockers)");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`unit normalization: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) void main();
