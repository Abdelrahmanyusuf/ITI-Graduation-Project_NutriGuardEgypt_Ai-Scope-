import { createHash } from "node:crypto";

// Mirrors computeRowFingerprint from src/domain/recipes.ts
const CANONICAL_COLUMNS = [
  "recipe_title",
  "description",
  "category",
  "subcategory",
  "cuisine_list",
  "main_ingredient",
  "ingredients",
  "ingredients_canonical",
  "directions",
];

function computeRowFingerprint(sourceFile, sourceRow, headers, row) {
  const cols = {};
  for (const name of CANONICAL_COLUMNS) {
    const i = headers.indexOf(name);
    cols[name] = (i === -1 ? "" : (row[i] ?? "")).trim();
  }
  const key = JSON.stringify({ sourceFile, sourceRow, cols });
  return createHash("sha256").update(key, "utf8").digest("hex");
}

const CSV_FILE = "data/raw/Recipes For Eqyption Food.csv";
const headers = ["recipe_title","category","subcategory","description","ingredients","directions","ingredients_canonical","cuisine_list","main_ingredient","egy_ingredient_coverage"];

// Row 2 (line 2): Koshari Egyptian
const koshariRow = ['"Koshari Egyptian"','"main"','""','"classic"','["lentils", "rice"]','["boil lentils", "serve"]','["lentils", "rice"]','["Egyptian"]','""','"1"'];
const fp2 = computeRowFingerprint(CSV_FILE, 2, headers, koshariRow);
console.log("Koshari fp (row 2):", fp2);

// Also compute using the exact fixture CSV format (TSV with quoted values like the test uses)
// FIXTURE_HEADER = "recipe_title\tcategory\tsubcategory\tdescription\tingredients\tdirections\tingredients_canonical\tcuisine_list\tmain_ingredient\tegy_ingredient_coverage\n"
// FIXTURE_ROWS[0] = '"Koshari Egyptian"\t"main"\t""\t"classic"\t"[""lentils"", ""rice""]"\t"[""boil lentils"", ""serve""]"\t"[""lentils"", ""rice""]"\t"[""Egyptian""]"\t""\t"1"\n'
// The TSV parser would give: headers as the non-quoted text; values still have outer quotes from TSV double-quote style

// Let's use the exact values that parseDelimited would produce for the fixture
// After parsing TSV: values are unquoted by the CSV parser
const parsedHeaders = ["recipe_title","category","subcategory","description","ingredients","directions","ingredients_canonical","cuisine_list","main_ingredient","egy_ingredient_coverage"];
const parsedKoshariRow = ["Koshari Egyptian","main","","classic",`["lentils", "rice"]`,`["boil lentils", "serve"]`,`["lentils", "rice"]`,`["Egyptian"]`,"","1"];
const fp2parsed = computeRowFingerprint(CSV_FILE, 2, parsedHeaders, parsedKoshariRow);
console.log("Koshari fp (row 2, parsed):", fp2parsed);
