import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_NUTRITION_COLUMNS = ["energy_kcal", "protein_g", "carbohydrate_g", "fat_g", "final_yield_weight_grams"] as const;
const PROVENANCE_COLUMNS = ["source_url", "source", "citation", "license"] as const;

export interface RegionalRecipeSourceAudit {
  sourceFile: string;
  rowsTotal: number;
  delimiter: "tab";
  headers: string[];
  hasRequiredNutritionColumns: boolean;
  missingRequiredNutritionColumns: string[];
  hasPerRecordProvenanceColumn: boolean;
  contradictoryMultiCuisineRows: number;
  middleEasternTaggedRows: number;
  middleEasternAndContradictoryRows: number;
  eligibleForTrustedRecommendations: number;
  decision: "blocked_pending_nutrition_provenance_and_human_review";
  notes: string[];
}

function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "\t" && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function cuisineValues(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase()) : [];
  } catch {
    return value.split(/[,;|]/u).map((item) => item.trim().toLowerCase()).filter(Boolean);
  }
}

export async function auditRegionalRecipeSource(filePath = path.resolve("Recipes For Eqyption Food.csv")): Promise<RegionalRecipeSourceAudit> {
  const rows = parseTsv(await readFile(filePath, "utf8"));
  const headers = rows[0] ?? [];
  const records = rows.slice(1);
  const cuisineIndex = headers.indexOf("cuisine_list");
  const cuisines = records.map((record) => cuisineValues(record[cuisineIndex] ?? ""));
  const contradictoryMultiCuisineRows = cuisines.filter((values) => values.length >= 4).length;
  const middleEasternTaggedRows = cuisines.filter((values) => values.some((value) => value.includes("middle eastern"))).length;
  const middleEasternAndContradictoryRows = cuisines.filter((values) => values.length >= 4 && values.some((value) => value.includes("middle eastern"))).length;
  const missingRequiredNutritionColumns = REQUIRED_NUTRITION_COLUMNS.filter((column) => !headers.includes(column));
  const hasPerRecordProvenanceColumn = PROVENANCE_COLUMNS.some((column) => headers.includes(column));
  return {
    sourceFile: path.basename(filePath),
    rowsTotal: records.length,
    delimiter: "tab",
    headers,
    hasRequiredNutritionColumns: missingRequiredNutritionColumns.length === 0,
    missingRequiredNutritionColumns: [...missingRequiredNutritionColumns],
    hasPerRecordProvenanceColumn,
    contradictoryMultiCuisineRows,
    middleEasternTaggedRows,
    middleEasternAndContradictoryRows,
    eligibleForTrustedRecommendations: 0,
    decision: "blocked_pending_nutrition_provenance_and_human_review",
    notes: [
      "Local ingredient coverage is not evidence of cuisine origin or nutritional completeness.",
      "A Middle Eastern tag is not trusted when the same row carries several contradictory cuisine tags.",
      "No row is exposed to RAG recommendations until nutrition, provenance, and human review gates pass.",
    ],
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await auditRegionalRecipeSource(), null, 2)}\n`);
}
