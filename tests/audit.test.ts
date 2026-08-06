import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { scanIngredients, buildIngredientVocabulary, classifyNutritionCell } from "../src/audit/scan-ingredients.js";
import { scanRecipes } from "../src/audit/scan-recipes.js";
import { scanGuidelines } from "../src/audit/scan-guidelines.js";
import { scanPyramidJson } from "../src/audit/scan-pyramid-json.js";
import { scanPyramidImage } from "../src/audit/scan-pyramid-image.js";
import { parseCsv, parseDelimited, parseListField } from "../src/audit/csv.js";
import { decodeText, detectMojibake, detectNoise, normalizeTerm } from "../src/audit/text.js";
import { isNumeric, isZeroValue } from "../src/audit/numbers.js";
import { classifyRecipe, type RecipeInput } from "../src/audit/egyptian-evidence.js";
import { parsePdf } from "../src/audit/pdf.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) => readFileSync(path.join(FIXTURES, name));

test("parseCsv handles quoted fields, escaped quotes, CRLF and commas", () => {
  const csv = 'a,"b, c","he said ""hi""",d\r\n"e\nf",g,,h\n';
  const r = parseCsv(csv);
  assert.deepEqual(r.rows[0], ["a", "b, c", 'he said "hi"', "d"]);
  assert.deepEqual(r.rows[1], ["e\nf", "g", "", "h"]);
  assert.deepEqual(r.errors, []);
});

test("parseDelimited with tab delimiter parses quoted JSON-ish fields", () => {
  const t = 'a\t"b\tc"\t"[""x"", ""y""]"\n1\t2\t3\n';
  const r = parseDelimited(t, "\t");
  assert.equal(r.rows[0][1], "b\tc");
  assert.equal(r.rows[0][2], '["x", "y"]');
});

test("parseCsv reports unterminated quote as an error", () => {
  const r = parseCsv('a,"unterminated\n');
  assert.ok(r.errors.some((e) => e.includes("unterminated")));
});

test("parseListField parses JSON array and falls back tolerantly", () => {
  assert.deepEqual(parseListField('["a", "b"]'), ["a", "b"]);
  assert.deepEqual(parseListField('["a","b"]'), ["a", "b"]);
  assert.equal(parseListField(""), null);
  assert.deepEqual(parseListField("a,b,c"), ["a", "b", "c"]);
});

test("normalizeTerm lowercases and normalizes whitespace/punctuation", () => {
  assert.equal(normalizeTerm("  Olive   Oil,  "), "olive oil");
  assert.equal(normalizeTerm("كشري"), "كشري");
});

test("decodeText strips a UTF-8 BOM and reports encoding", () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const enc = decodeText(Buffer.concat([bom, Buffer.from("abc", "utf8")]));
  assert.equal(enc.bom, true);
  assert.equal(enc.text, "abc");
  assert.equal(enc.validUtf8, true);
});

test("decodeText falls back to latin1 for invalid UTF-8 (binary content)", () => {
  const enc = decodeText(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  assert.equal(enc.validUtf8, false);
  assert.ok(enc.encoding.includes("latin1"));
});

test("detectMojibake flags replacement characters and latin1-of-arabic", () => {
  assert.ok(detectMojibake("ab\uFFFDcd").detected);
  assert.ok(detectMojibake("Ø§ÙƒÙ„").detected);
  assert.equal(detectMojibake("normal text here").detected, false);
});

test("detectNoise flags control chars and repeated punctuation", () => {
  assert.ok(detectNoise("....").detected);
  assert.ok(detectNoise("a\u0007b").detected);
  assert.equal(detectNoise("clean text").detected, false);
});

test("isNumeric distinguishes empty, valid, and invalid numbers", () => {
  assert.equal(isNumeric(""), false);
  assert.equal(isNumeric("12.5"), true);
  assert.equal(isNumeric("-3"), true);
  assert.equal(isNumeric(".5"), true);
  assert.equal(isNumeric("12abc"), false);
  assert.equal(isNumeric("1,5"), false);
});

test("isZeroValue identifies explicit zeros and not empty", () => {
  assert.equal(isZeroValue(""), false);
  assert.equal(isZeroValue("0"), true);
  assert.equal(isZeroValue("0.00"), true);
  assert.equal(isZeroValue("12"), false);
});

test("ingredient CSV scanner: missing/invalid numbers, zeros, no conflation when only zeros", () => {
  const audit = scanIngredients({
    relativePath: "tests/fixtures/ingredients.csv",
    bytes: readFixture("ingredients.csv"),
  });
  assert.equal(audit.docCount, 3);
  const energy = audit.columns.find((c) => c.name === "ENERGY (Kcal)");
  assert.ok(energy);
  assert.equal(energy.missing, 1);
  assert.equal(energy.invalidNumerics, 0);
  const protein = audit.columns.find((c) => c.name === "PROTEIN (g)");
  assert.ok(protein);
  assert.equal(protein.invalidNumerics, 1);
});

test("ingredient scanner detects explicit-zero vs missing conflation", () => {
  const csv = Buffer.from('FOOD,ENERGY (Kcal)\n"x",\n"y",0\n', "utf8");
  const audit = scanIngredients({ relativePath: "x.csv", bytes: csv });
  assert.equal(audit.zeroVsMissingConflation.detected, true);
  assert.ok(audit.zeroVsMissingConflation.columns.includes("ENERGY (Kcal)"));
});

test("ingredient scanner reports duplicate FOOD keys", () => {
  const csv = Buffer.from('FOOD\n"z"\n"z"\n', "utf8");
  const audit = scanIngredients({ relativePath: "x.csv", bytes: csv });
  assert.equal(audit.duplicates.groups.length, 1);
  assert.equal(audit.duplicates.duplicateRowCount, 1);
});

test("buildIngredientVocabulary collects normalized FOOD names", () => {
  const csv = Buffer.from('FOOD\n"Olive Oil"\n"Olive Oil"\n"Bread"\n', "utf8");
  const { vocabulary } = buildIngredientVocabulary(csv);
  assert.equal(vocabulary.has("olive oil"), true);
  assert.equal(vocabulary.has("bread"), true);
  assert.equal(vocabulary.size, 2);
});

test("recipe scanner: exact match against vocabulary and classification", () => {
  const vocab = new Set(["lentils", "rice", "bread"]);
  const result = scanRecipes({
    relativePath: "tests/fixtures/recipes.csv",
    bytes: readFixture("recipes.csv"),
    vocabulary: vocab,
  });
  const audit = result.audit;
  assert.equal(audit.docCount, 3);

  const m = audit.exactIngredientMatch;
  assert.ok(m);
  // unique terms: lentils, rice, bread -> all three match the vocabulary
  assert.equal(m.numerator, 3);
  assert.equal(m.denominator, 3);
  assert.equal(m.rate, 1);

  // malformed row flagged
  assert.ok(audit.structuralErrors.some((e) => e.includes("expected")));
});

test("recipe scanner: duplicate titles detected", () => {
  const csv = Buffer.from(
    'recipe_title\tcategory\tnum_ingredients\n"dup"\ta\t1\n"dup"\tb\t2\n',
    "utf8"
  );
  const result = scanRecipes({
    relativePath: "x.csv",
    bytes: csv,
    vocabulary: new Set<string>(),
  });
  assert.equal(result.audit.duplicates.groups.length, 1);
  assert.equal(result.audit.duplicates.duplicateRowCount, 1);
});

test("recipe scanner: suspicious zeros flagged as possible missing->0", () => {
  const csv = Buffer.from('recipe_title\tcategory\tnum_ingredients\n"x"\ta\t0\n', "utf8");
  const result = scanRecipes({
    relativePath: "x.csv",
    bytes: csv,
    vocabulary: new Set<string>(),
  });
  assert.equal(result.audit.suspiciousZeros.count, 1);
});

test("recipe scanner: quantity/unit coverage computed over ingredient lines", () => {
  const csv = Buffer.from(
    'recipe_title\tcategory\tingredients\n"x"\ta\t"[""1 cup rice"", ""salt""]"\n',
    "utf8"
  );
  const result = scanRecipes({
    relativePath: "x.csv",
    bytes: csv,
    vocabulary: new Set<string>(),
  });
  const q = result.audit.leadingQuantityHeuristic;
  const u = result.audit.recognizedUnitHeuristic;
  assert.ok(q);
  assert.equal(q.numerator, 1);
  assert.equal(q.denominator, 2);
  assert.ok(u);
  assert.equal(u.numerator, 1);
  assert.equal(u.denominator, 2);
});

test("recipe scanner: canonical coverage metrics are unknown (rate null), not 0", () => {
  const csv = Buffer.from(
    'recipe_title\tcategory\tingredients\n"x"\ta\t"[""1 cup rice"", ""salt""]"\n',
    "utf8"
  );
  const result = scanRecipes({
    relativePath: "x.csv",
    bytes: csv,
    vocabulary: new Set<string>(),
  });
  const cq = result.audit.canonicalQuantityParsingCoverage;
  const cm = result.audit.canonicalIngredientLineMappingCoverage;
  assert.ok(cq);
  assert.equal(cq.rate, null);
  assert.equal(cq.numerator, 0);
  assert.ok(cm);
  assert.equal(cm.rate, null);
});

test("recipe scanner: unit matching is token-boundary aware and excludes taste/to-taste", () => {
  const csv = Buffer.from(
    'recipe_title\tcategory\tingredients\n"x"\ta\t"[""2 large eggs"", ""cooking spray"", ""salt to taste"", ""1 tsp cumin""]"\n',
    "utf8"
  );
  const result = scanRecipes({
    relativePath: "x.csv",
    bytes: csv,
    vocabulary: new Set<string>(),
  });
  const u = result.audit.recognizedUnitHeuristic;
  assert.ok(u);
  // "2 large eggs": no unit token; "cooking spray": no unit; "salt to taste":
  // excluded as optional/to-taste; "1 tsp cumin": has unit tsp.
  assert.equal(u.numerator, 1);
  assert.equal(u.denominator, 3);
  const q = result.audit.leadingQuantityHeuristic;
  assert.ok(q);
  // quantity lines: "2 large eggs" (2), "1 tsp cumin" (1); "salt to taste" excluded
  assert.equal(q.numerator, 2);
  assert.equal(q.denominator, 3);
});

test("recipe scanner: serving/yield and food-state coverage are unavailable (rate null), not 0", () => {
  const csv = Buffer.from('recipe_title\tcategory\tingredients\n"x"\ta\t"[""1 cup rice""]"\n', "utf8");
  const result = scanRecipes({ relativePath: "x.csv", bytes: csv, vocabulary: new Set<string>() });
  const s = result.audit.servingYieldCoverage;
  const f = result.audit.foodStateCoverage;
  assert.ok(s);
  assert.equal(s.rate, null);
  assert.ok(f);
  assert.equal(f.rate, null);
});

test("classifyRecipe: two independent signals + C-1..C-3 -> candidate, never verified", () => {
  const input: RecipeInput = {
    row: 1,
    title: "Koshari Egyptian",
    description: "classic",
    category: "main",
    subcategory: "",
    cuisineList: ["Egyptian"],
    mainIngredient: "lentils",
    ingredientTerms: ["lentils", "rice"],
    mojibakeInTitle: false,
    malformed: false,
    missingTitle: false,
    missingIngredients: false,
    hasInstructions: true,
    fileIsValidUtf8: true,
    sourceId: "src-1",
    sourceVersion: "v1",
    accessDate: "2026-01-26",
    cultureEvidenceLink: "https://example.org/culture/koshari",
  };
  const r = classifyRecipe(input);
  assert.equal(r.classification, "candidate");
  assert.ok(r.reasons[0].includes("strong Egyptian-specific signals"));
  // automated logic can never produce a verified status
  assert.notEqual(r.classification, "verified_egyptian");
});

test("classifyRecipe: broad Middle Eastern/Mediterranean tags are NOT Egyptian evidence", () => {
  const base: RecipeInput = {
    row: 2,
    title: "Falafel",
    description: "",
    category: "main",
    subcategory: "",
    cuisineList: ["Middle Eastern"],
    mainIngredient: "",
    ingredientTerms: ["chickpeas"],
    mojibakeInTitle: false,
    malformed: false,
    missingTitle: false,
    missingIngredients: false,
    hasInstructions: true,
    fileIsValidUtf8: true,
    sourceId: "src-1",
    sourceVersion: "v1",
    accessDate: "2026-01-26",
    cultureEvidenceLink: "https://example.org/culture/falafel",
  };
  // "Falafel + Middle Eastern": dish alias plus a broad tag -> needs_review, NOT candidate.
  const me = classifyRecipe({ ...base, cuisineList: ["Middle Eastern"] });
  assert.equal(me.classification, "needs_review");
  assert.notEqual(me.classification, "candidate");
  // "Falafel + Mediterranean": same outcome.
  const med = classifyRecipe({ ...base, cuisineList: ["Mediterranean"] });
  assert.equal(med.classification, "needs_review");
  assert.notEqual(med.classification, "candidate");
  // Broad tags are discounted, never counted in the positive-signal total.
  assert.deepEqual(me.signals, ["dish_name_match=falafel"]);
  assert.ok(me.broadTags.includes("Middle Eastern"));
  assert.ok(med.broadTags.includes("Mediterranean"));
});

test("classifyRecipe: dish alias + broad tag is never candidate even with C-1..C-3", () => {
  const input: RecipeInput = {
    row: 2,
    title: "Koshari",
    description: "",
    category: "main",
    subcategory: "",
    cuisineList: ["Middle Eastern"],
    mainIngredient: "",
    ingredientTerms: ["lentils", "rice"],
    mojibakeInTitle: false,
    malformed: false,
    missingTitle: false,
    missingIngredients: false,
    hasInstructions: true,
    fileIsValidUtf8: true,
    sourceId: "src-1",
    sourceVersion: "v1",
    accessDate: "2026-01-26",
    cultureEvidenceLink: "https://example.org/culture/koshari",
  };
  const r = classifyRecipe(input);
  // Only ONE positive signal (dish_name_match); the broad tag is discounted.
  assert.equal(r.classification, "needs_review");
  assert.notEqual(r.classification, "candidate");
});

test("classifyRecipe: a single ingredient alone never classifies", () => {
  const input: RecipeInput = {
    row: 2,
    title: "Lentil soup",
    description: "",
    category: "soup",
    subcategory: "",
    cuisineList: ["American"],
    mainIngredient: "lentils",
    ingredientTerms: ["lentils"],
    mojibakeInTitle: false,
    malformed: false,
    missingTitle: false,
    missingIngredients: false,
    hasInstructions: true,
    fileIsValidUtf8: true,
    sourceId: "src-1",
    sourceVersion: "v1",
    accessDate: "2026-01-26",
    cultureEvidenceLink: "https://example.org/culture/x",
  };
  const r = classifyRecipe(input);
  assert.notEqual(r.classification, "candidate");
});

test("classifyRecipe: dish alias matching is token-boundary aware (no substring hits)", () => {
  const base: RecipeInput = {
    row: 2,
    title: "Truthful lentil stew",
    description: "",
    category: "stew",
    subcategory: "",
    cuisineList: ["American"],
    mainIngredient: "spoonful of lentils",
    ingredientTerms: ["lentils"],
    mojibakeInTitle: false,
    malformed: false,
    missingTitle: false,
    missingIngredients: false,
    hasInstructions: true,
    fileIsValidUtf8: true,
    sourceId: "src-1",
    sourceVersion: "v1",
    accessDate: "2026-01-26",
    cultureEvidenceLink: "https://example.org/culture/x",
  };
  // "ful" must not match inside "Truthful"/"spoonful".
  const r = classifyRecipe(base);
  assert.ok(!r.signals.some((s) => s.startsWith("dish_name_match")));
  assert.equal(r.classification, "needs_review");
  // A genuine token-boundary "ful medames" DOES match.
  const hit = classifyRecipe({ ...base, title: "Ful Medames with olive oil" });
  assert.ok(hit.signals.some((s) => s === "dish_name_match=ful medames"));
});

test("classifyRecipe: candidate requires C-1 (source_id/version/access_date) and C-3 (evidence link)", () => {
  const strong: RecipeInput = {
    row: 1,
    title: "Koshari Egyptian",
    description: "classic",
    category: "main",
    subcategory: "",
    cuisineList: ["Egyptian"],
    mainIngredient: "",
    ingredientTerms: ["lentils", "rice"],
    mojibakeInTitle: false,
    malformed: false,
    missingTitle: false,
    missingIngredients: false,
    hasInstructions: true,
    fileIsValidUtf8: true,
    sourceId: "",
    sourceVersion: "",
    accessDate: "",
    cultureEvidenceLink: "",
  };
  assert.equal(classifyRecipe(strong).classification, "needs_review");
  assert.equal(classifyRecipe({ ...strong, sourceId: "s", sourceVersion: "v", accessDate: "2026-01-01", cultureEvidenceLink: "" }).classification, "needs_review");
  assert.equal(classifyRecipe({ ...strong, sourceId: "s", sourceVersion: "v", accessDate: "2026-01-01", cultureEvidenceLink: "https://example.org/e" }).classification, "candidate");
});

test("classifyRecipe: candidate requires non-empty instructions (C-2)", () => {
  const base: RecipeInput = {
    row: 1,
    title: "Koshari Egyptian",
    description: "classic",
    category: "main",
    subcategory: "",
    cuisineList: ["Egyptian"],
    mainIngredient: "",
    ingredientTerms: ["lentils", "rice"],
    mojibakeInTitle: false,
    malformed: false,
    missingTitle: false,
    missingIngredients: false,
    hasInstructions: false,
    fileIsValidUtf8: true,
    sourceId: "src-1",
    sourceVersion: "v1",
    accessDate: "2026-01-26",
    cultureEvidenceLink: "https://example.org/e",
  };
  assert.equal(classifyRecipe(base).classification, "needs_review");
  assert.equal(classifyRecipe({ ...base, hasInstructions: true }).classification, "candidate");
});

test("classifyRecipe: C-1 access_date must be a strict ISO date (pattern + real date), never just non-empty", () => {
  const base: RecipeInput = {
    row: 1,
    title: "Koshari Egyptian",
    description: "classic",
    category: "main",
    subcategory: "",
    cuisineList: ["Egyptian"],
    mainIngredient: "",
    ingredientTerms: ["lentils", "rice"],
    mojibakeInTitle: false,
    malformed: false,
    missingTitle: false,
    missingIngredients: false,
    hasInstructions: true,
    fileIsValidUtf8: true,
    sourceId: "src-1",
    sourceVersion: "v1",
    accessDate: "2026-01-26",
    cultureEvidenceLink: "https://example.org/e",
  };
  // reviewer negatives must stay needs_review
  const negatives = ["not-a-date", "", "26 January 2026", "2026/01/26", "2026-1-26", "2026-02-30", "2026-13-01", "2026-00-10"];
  for (const n of negatives) {
    assert.equal(classifyRecipe({ ...base, accessDate: n }).classification, "needs_review", `access_date "${n}" must fail C-1`);
  }
  for (const ok of ["2026-01-26", "2024-02-29", "2000-01-01"]) {
    assert.equal(classifyRecipe({ ...base, accessDate: ok }).classification, "candidate", `access_date ${ok} must satisfy C-1`);
  }
});

test("classifyRecipe: C-3 link is an http(s) URL or a scoped manifest cultural-evidence ID", () => {
  const base: RecipeInput = {
    row: 1,
    title: "Koshari Egyptian",
    description: "classic",
    category: "main",
    subcategory: "",
    cuisineList: ["Egyptian"],
    mainIngredient: "",
    ingredientTerms: ["lentils", "rice"],
    mojibakeInTitle: false,
    malformed: false,
    missingTitle: false,
    missingIngredients: false,
    hasInstructions: true,
    fileIsValidUtf8: true,
    sourceId: "src-1",
    sourceVersion: "v1",
    accessDate: "2026-01-26",
    cultureEvidenceLink: "https://example.org/culture/koshari",
  };
  // reviewer negatives must stay needs_review
  for (const bad of ["not-linkable", "koshari recipe page", "ftp://example.org/x", "https://", ""]) {
    assert.equal(
      classifyRecipe({ ...base, cultureEvidenceLink: bad }).classification,
      "needs_review",
      `culture_evidence_link="${bad}" should fail C-3`
    );
  }
  // a valid URL resolves C-3
  assert.equal(classifyRecipe(base).classification, "candidate");
  // a manifest cultural-evidence ID scoped to Koshari resolves C-3 as well
  const idInput: RecipeInput = {
    ...base,
    cultureEvidenceLink: "EG-KOSHARI-CULTURAL-001",
    culturalEvidence: [{ id: "EG-KOSHARI-CULTURAL-001", applicableTo: ["koshari", "kushari"] }],
  };
  assert.equal(classifyRecipe(idInput).classification, "candidate");
  // an ID that is NOT registered in the manifest does NOT resolve
  assert.equal(
    classifyRecipe({
      ...base,
      cultureEvidenceLink: "EG-UNREGISTERED-001",
      culturalEvidence: [{ id: "OTHER-REF", applicableTo: ["koshari"] }],
    }).classification,
    "needs_review"
  );
});

test("classifyRecipe: manifest IDs satisfy C-3 only when typed cultural evidence scoped to THIS dish", () => {
  const base: RecipeInput = {
    row: 1,
    title: "Koshari Egyptian",
    description: "classic",
    category: "main",
    subcategory: "",
    cuisineList: ["Egyptian"],
    mainIngredient: "",
    ingredientTerms: ["lentils", "rice"],
    mojibakeInTitle: false,
    malformed: false,
    missingTitle: false,
    missingIngredients: false,
    hasInstructions: true,
    fileIsValidUtf8: true,
    sourceId: "src-1",
    sourceVersion: "v1",
    accessDate: "2026-01-26",
    cultureEvidenceLink: "EG-REF-WHO-001",
  };
  // The WHO healthy-diet factsheet ID (purpose guideline_provenance) is general
  // nutrition guidance, never cultural evidence -> only guideline/nutrition
  // provenance may come from it; C-3 must NOT resolve.
  assert.equal(classifyRecipe({ ...base, culturalEvidence: [] }).classification, "needs_review");
  // A cultural record scoped to a different dish (Ful Medames) cannot satisfy
  // C-3 for Koshari -> needs_review.
  assert.equal(
    classifyRecipe({
      ...base,
      cultureEvidenceLink: "EG-FUL-CULTURAL-001",
      culturalEvidence: [{ id: "EG-FUL-CULTURAL-001", applicableTo: ["ful medames"] }],
    }).classification,
    "needs_review"
  );
  // A cultural record scoped to Koshari DOES satisfy C-3 -> candidate.
  assert.equal(
    classifyRecipe({
      ...base,
      cultureEvidenceLink: "EG-KOSHARI-CULTURAL-001",
      culturalEvidence: [{ id: "EG-KOSHARI-CULTURAL-001", applicableTo: ["koshari", "kushari"] }],
    }).classification,
    "candidate"
  );
});

test("recipe scanner: directions parsed as a source list field; empty/whitespace arrays fail C-2", () => {
  const header =
    "recipe_title\tcategory\tdirections\tingredients\tcuisine_list\tsource_id\tsource_version\taccess_date\tculture_evidence_link\n";
  const rows = [
    '"Koshari Empty Array"\t"main"\t"[]"\t"[""lentils"", ""rice""]"\t"[""Egyptian""]"\t"src-1"\t"v1"\t"2026-01-26"\t"https://example.org/e"\n',
    '"Koshari Empty String"\t"main"\t"[""""]"\t"[""lentils"", ""rice""]"\t"[""Egyptian""]"\t"src-1"\t"v1"\t"2026-01-26"\t"https://example.org/e"\n',
    '"Koshari Whitespace"\t"main"\t"[""   ""]"\t"[""lentils"", ""rice""]"\t"[""Egyptian""]"\t"src-1"\t"v1"\t"2026-01-26"\t"https://example.org/e"\n',
    '"Koshari Plain"\t"main"\t"   "\t"[""lentils"", ""rice""]"\t"[""Egyptian""]"\t"src-1"\t"v1"\t"2026-01-26"\t"https://example.org/e"\n',
    '"Koshari Real Steps"\t"main"\t"[""boil lentils"", ""serve""]"\t"[""lentils"", ""rice""]"\t"[""Egyptian""]"\t"src-1"\t"v1"\t"2026-01-26"\t"https://example.org/e"\n',
  ];
  const result = scanRecipes({
    relativePath: "x.csv",
    bytes: Buffer.from(header + rows.join(""), "utf8"),
    vocabulary: new Set<string>(),
  });
  const byTitle = new Map(result.classificationRecords.map((r) => [r.title, r.classification]));
  assert.equal(byTitle.get("Koshari Empty Array"), "needs_review");
  assert.equal(byTitle.get("Koshari Empty String"), "needs_review");
  assert.equal(byTitle.get("Koshari Whitespace"), "needs_review");
  assert.equal(byTitle.get("Koshari Plain"), "needs_review");
  assert.equal(byTitle.get("Koshari Real Steps"), "candidate");
});

test("recipe scanner: candidate also requires strict ISO access_date and a linkable evidence value", () => {
  const header =
    "recipe_title\tcategory\tdirections\tingredients\tcuisine_list\tmain_ingredient\tegy_ingredient_coverage\tsource_id\tsource_version\taccess_date\tculture_evidence_link\n";
  const row = (title: string, accessDate: string, link: string) =>
    `"${title}"\t"main"\t"[""boil""]"\t"[""lentils"", ""rice""]"\t"[""Egyptian""]"\t""\t"1"\t"src-1"\t"v1"\t"${accessDate}"\t"${link}"\n`;
  const result = scanRecipes({
    relativePath: "x.csv",
    bytes: Buffer.from(
      header +
        row("Koshari A", "not-a-date", "https://example.org/e") +
        row("Koshari B", "2026-01-26", "not-linkable") +
        row("Koshari C", "2026-02-30", "https://example.org/e"),
      "utf8"
    ),
    vocabulary: new Set<string>(),
  });
  const byTitle = new Map(result.classificationRecords.map((r) => [r.title, r.classification]));
  assert.equal(byTitle.get("Koshari A"), "needs_review");
  assert.equal(byTitle.get("Koshari B"), "needs_review");
  assert.equal(byTitle.get("Koshari C"), "needs_review");
});

test("recipe scanner: manifest evidence ID resolves C-3 only for a scoped cultural-evidence record", () => {
  const header =
    "recipe_title\tcategory\tdirections\tingredients\tcuisine_list\tmain_ingredient\tegy_ingredient_coverage\tsource_id\tsource_version\taccess_date\tculture_evidence_link\n";
  const csv = (link: string) =>
    Buffer.from(
      header + `"Koshari Egyptian"\t"main"\t"[""boil""]"\t"[""lentils"", ""rice""]"\t"[""Egyptian""]"\t""\t"1"\t"src-1"\t"v1"\t"2026-01-26"\t"${link}"\n`,
      "utf8"
    );
  // The WHO guideline-provenance ID (EG-REF-WHO-001) is NOT eligible for C-3.
  const who = scanRecipes({
    relativePath: "x.csv",
    bytes: csv("EG-REF-WHO-001"),
    vocabulary: new Set<string>(),
    culturalEvidence: [],
  });
  assert.equal(who.classificationRecords[0].classification, "needs_review");
  // A Koshari-scoped cultural-evidence record resolves C-3 -> candidate.
  const kult = scanRecipes({
    relativePath: "x.csv",
    bytes: csv("EG-KOSHARI-CULTURAL-001"),
    vocabulary: new Set<string>(),
    culturalEvidence: [{ id: "EG-KOSHARI-CULTURAL-001", applicableTo: ["koshari", "kushari"] }],
  });
  assert.equal(kult.classificationRecords[0].classification, "candidate");
  // The same ID scoped to a different dish stays needs_review.
  const wrong = scanRecipes({
    relativePath: "x.csv",
    bytes: csv("EG-KOSHARI-CULTURAL-001"),
    vocabulary: new Set<string>(),
    culturalEvidence: [{ id: "EG-KOSHARI-CULTURAL-001", applicableTo: ["ful medames"] }],
  });
  assert.equal(wrong.classificationRecords[0].classification, "needs_review");
});

test("classifyRecipe: malformed row -> rejected", () => {
  const input: RecipeInput = {
    row: 3,
    title: "x",
    description: "",
    category: "",
    subcategory: "",
    cuisineList: [],
    mainIngredient: "",
    ingredientTerms: [],
    mojibakeInTitle: false,
    malformed: true,
    missingTitle: false,
    missingIngredients: false,
    hasInstructions: true,
    fileIsValidUtf8: true,
    sourceId: "",
    sourceVersion: "",
    accessDate: "",
    cultureEvidenceLink: "",
  };
  assert.equal(classifyRecipe(input).classification, "rejected");
});

test("classifyRecipe: mojibake title -> rejected", () => {
  const input: RecipeInput = {
    row: 4,
    title: "Ã©clair \uFFFD",
    description: "",
    category: "",
    subcategory: "",
    cuisineList: [],
    mainIngredient: "",
    ingredientTerms: [],
    mojibakeInTitle: true,
    malformed: false,
    missingTitle: false,
    missingIngredients: false,
    hasInstructions: true,
    fileIsValidUtf8: true,
    sourceId: "",
    sourceVersion: "",
    accessDate: "",
    cultureEvidenceLink: "",
  };
  assert.equal(classifyRecipe(input).classification, "rejected");
});

test("classifyRecipe: non-Egyptian declared cuisines -> not_egyptian", () => {
  const input: RecipeInput = {
    row: 5,
    title: "Plain toast",
    description: "",
    category: "bread",
    subcategory: "",
    cuisineList: ["Italian", "French"],
    mainIngredient: "",
    ingredientTerms: ["bread"],
    mojibakeInTitle: false,
    malformed: false,
    missingTitle: false,
    missingIngredients: false,
    hasInstructions: true,
    fileIsValidUtf8: true,
    sourceId: "",
    sourceVersion: "",
    accessDate: "",
    cultureEvidenceLink: "",
  };
  const r = classifyRecipe(input);
  assert.equal(r.classification, "not_egyptian");
});

test("recipe scanner is deterministic across two runs", () => {
  const vocab = new Set(["lentils", "rice", "bread"]);
  const a = scanRecipes({
    relativePath: "tests/fixtures/recipes.csv",
    bytes: readFixture("recipes.csv"),
    vocabulary: vocab,
  });
  const b = scanRecipes({
    relativePath: "tests/fixtures/recipes.csv",
    bytes: readFixture("recipes.csv"),
    vocabulary: vocab,
  });
  assert.deepEqual(a, b);
});

test("ingredient scanner: nutrition cells classified incl. trace markers, zeros, invalid", () => {
  const csv = Buffer.from(
    'FOOD,PROTEIN (g),VITAMIN A (ugre)\n"a",,\n"b",T,0\n"c",5,T\n"d",abc,12\n',
    "utf8"
  );
  const audit = scanIngredients({ relativePath: "x.csv", bytes: csv });
  assert.ok(audit.nutrition);
  const protein = audit.nutrition.columns.find((c) => c.column === "PROTEIN (g)");
  const vA = audit.nutrition.columns.find((c) => c.column === "VITAMIN A (ugre)");
  assert.ok(protein);
  assert.ok(vA);
  // PROTEIN: missing=1 (row a), trace=1 (T), valid=1 (5), invalid=1 (abc)
  assert.equal(protein.missing, 1);
  assert.equal(protein.recognizedTraceMarkers, 1);
  assert.equal(protein.validNumeric, 1);
  assert.equal(protein.invalid, 1);
  assert.equal(protein.explicitZero, 0);
  // VITAMIN A: missing=1 (row a), zero=1 (row b), trace=1 (T), valid=1 (12)
  assert.equal(vA.missing, 1);
  assert.equal(vA.explicitZero, 1);
  assert.equal(vA.recognizedTraceMarkers, 1);
  assert.equal(vA.validNumeric, 1);
  assert.equal(vA.invalid, 0);
});

test("ingredient scanner: nutrition per-column counts sum to the documented totals", () => {
  const csv = Buffer.from(
    'FOOD,PROTEIN (g)\n"a",5\n"b",\n"c",T\n"d",abc\n"e",0\n',
    "utf8"
  );
  const audit = scanIngredients({ relativePath: "x.csv", bytes: csv });
  assert.ok(audit.nutrition);
  const protein = audit.nutrition.columns.find((c) => c.column === "PROTEIN (g)");
  assert.ok(protein);
  // 5 rows: valid=1, missing=1, trace=1, invalid=1, zero=1
  assert.equal(protein.validNumeric + protein.explicitZero + protein.recognizedTraceMarkers + protein.invalid, protein.present);
  assert.equal(protein.present + protein.missing, 5);
});

test("recipe scanner: cuisine_list distribution warns when a field is constant/non-discriminative", () => {
  const csv = Buffer.from(
    'recipe_title\tcategory\tcuisine_list\tegy_ingredient_coverage\tingredients\n"a"\tx\t"[""Egyptian""]"\t"0.5"\t"[""rice""]"\n"b"\tx\t"[""Egyptian""]"\t"0.5"\t"[""rice""]"\n',
    "utf8"
  );
  const result = scanRecipes({ relativePath: "x.csv", bytes: csv, vocabulary: new Set(["rice"]) });
  const egy = result.audit.egyIngredientCoverageField;
  assert.ok(egy);
  assert.equal(egy.constant, true);
  assert.ok(egy.note.includes("non-discriminative"));
});

test("parsePdf: not-a-PDF is reported as such (no crash)", () => {
  const r = parsePdf(Buffer.from("hello world"));
  assert.equal(r.pageCount, null);
  assert.equal(r.extractionAvailable, false);
  assert.ok(r.errors.some((e) => e.includes("not a PDF")));
});

test("parsePdf: WHO guidelines PDF -> pageCount 8, extractable text, OCR noise tokens", () => {
  const r = parsePdf(readFixture("who-guidelines.pdf"));
  assert.equal(r.pageCount, 8);
  assert.equal(r.extractionAvailable, true);
  assert.ok(r.text.includes("Donate rid Health"));
  assert.ok(r.text.includes("wey viyanization"));
  assert.ok(r.text.includes("26 January 2026"));
});

test("ingredient scanner: Unnamed: 21 and metadata headers are excluded from nutrition columns", () => {
  const csv = Buffer.from(
    'FOOD,PROTEIN (g),Unnamed: 21,main_category,subcategory,prep_state\n"a",5,x,cat,sub,raw\n',
    "utf8"
  );
  const audit = scanIngredients({ relativePath: "x.csv", bytes: csv });
  assert.ok(audit.nutrition);
  assert.equal(audit.nutrition.columns.length, 1);
  assert.equal(audit.nutrition.columns[0].column, "PROTEIN (g)");
});

test("ingredient scanner: source invalidNumerics equals sum of nutrition column invalid", () => {
  const csv = Buffer.from(
    'FOOD,PROTEIN (g),VITAMIN A (ugre)\n"a",T,\n"b",5,0\n"c",abc,x\n',
    "utf8"
  );
  const audit = scanIngredients({ relativePath: "x.csv", bytes: csv });
  assert.ok(audit.nutrition);
  const sumInvalid = audit.nutrition.columns.reduce((s, c) => s + c.invalid, 0);
  assert.equal(audit.invalidNumerics.count, sumInvalid);
  // trace markers (T) are NOT invalid
  const protein = audit.nutrition.columns.find((c) => c.column === "PROTEIN (g)");
  assert.ok(protein);
  assert.equal(protein.recognizedTraceMarkers, 1);
  assert.equal(protein.invalid, 1); // "abc"
  const vA = audit.nutrition.columns.find((c) => c.column === "VITAMIN A (ugre)");
  assert.ok(vA);
  assert.equal(vA.invalid, 1); // "x"
  // per-column columns[] invalidNumerics agree with the canonical classifier
  const colProtein = audit.columns.find((c) => c.name === "PROTEIN (g)");
  assert.ok(colProtein);
  assert.equal(colProtein.invalidNumerics, 1);
});

test("canonical nutrition classifier is shared and classifies trace/zero/valid/invalid/missing", () => {
  const c = (v: string) => classifyNutritionCell(v, "PROTEIN (g)", 1);
  assert.equal(c(""), "missing");
  assert.equal(c("  "), "missing");
  const cls = (v: string) => {
    const r = c(v);
    return r === "missing" ? "missing" : r.classification;
  };
  assert.equal(cls("T"), "recognized_trace_marker");
  assert.equal(cls("tr"), "recognized_trace_marker");
  assert.equal(cls("trace"), "recognized_trace_marker");
  assert.equal(cls("0"), "explicit_zero");
  assert.equal(cls("12.5"), "valid_numeric");
  assert.equal(cls("abc"), "invalid");
});

test("scanGuidelines: non-WHO PDF is not labeled WHO and gets no WHO date/OCR notes", () => {
  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    Buffer.from("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n"),
    Buffer.from("4 0 obj\n<< /Length 20 >>\nstream\n(General cooking tips)\nendstream\nendobj\n"),
    Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n"),
  ]);
  const audit = scanGuidelines({ relativePath: "non-who.pdf", bytes: pdf });
  assert.ok(audit.guidelineCoverage);
  const g = audit.guidelineCoverage;
  assert.equal(g.provenanceStatus, "unknown");
  assert.equal(g.visibleSource, null);
  assert.equal(g.visibleTitle, null);
  assert.notEqual(g.visibleDate, "26 January 2026");
  assert.equal(g.visibleDate, null);
  assert.equal(g.ocrNoiseDetected, false);
  for (const n of g.notes) {
    assert.ok(!/Donate rid|viyanization/i.test(n));
    assert.ok(!n.includes("26 January 2026"));
  }
});

test("scanGuidelines: WHO identity only via explicit provenance record or content evidence", () => {
  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    Buffer.from("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n"),
    Buffer.from("4 0 obj\n<< /Length 30 >>\nstream\n(World Health Organization) Tj\nendstream\nendobj\n"),
    Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n"),
  ]);
  const audit = scanGuidelines({ relativePath: "r.pdf", bytes: pdf });
  assert.ok(audit.guidelineCoverage);
  const g = audit.guidelineCoverage;
  assert.equal(g.provenanceStatus, "identified");
  assert.ok(g.visibleSource && g.visibleSource.includes("World Health Organization"));
});

test("scanGuidelines: WHO PDF (fixture) derives visibleTitle from content and detects OCR corruption of the org name", () => {
  const pdf = readFixture("who-guidelines.pdf");
  // Without any provenance: no WHO identity claim, but the visible title and the
  // OCR corruption region are derived from the extracted content ("Donate rid
  // Health wey viyanization Healthy diet 26 January 2026").
  const bare = scanGuidelines({ relativePath: "who-guidelines.pdf", bytes: pdf });
  assert.ok(bare.guidelineCoverage);
  assert.equal(bare.guidelineCoverage.visibleTitle, "Healthy diet");
  assert.equal(bare.guidelineCoverage.visibleDate, "26 January 2026");
  assert.equal(bare.guidelineCoverage.provenanceStatus, "unknown");
  assert.equal(bare.guidelineCoverage.ocrNoiseDetected, false, "no WHO identity claimed -> no WHO corruption claim");

  // With an explicit provenance record (as supplied by data/manifest/sources.json)
  // the WHO identity is identified and the corrupted org name is flagged with
  // bounded samples drawn from the extracted content.
  const audit = scanGuidelines({
    relativePath: "who-guidelines.pdf",
    bytes: pdf,
    provenance: { source: "WHO — World Health Organization", title: "Healthy diet", date: "26 January 2026" },
  });
  const g = audit.guidelineCoverage;
  assert.ok(g);
  assert.equal(g.provenanceStatus, "identified");
  assert.ok(g.visibleSource && /WHO/i.test(g.visibleSource));
  assert.equal(g.visibleTitle, "Healthy diet");
  assert.equal(g.visibleDate, "26 January 2026");
  assert.equal(g.ocrNoiseDetected, true);
  assert.ok(g.notes.some((n) => /Donate rid Health/i.test(n)));
  assert.ok(g.notes.some((n) => /wey viyanization/i.test(n)));
  const noise = audit.ocrOrExtractionNoise;
  assert.ok(noise.kinds.includes("ocr_corrupted_organization_name"));
  assert.ok(noise.samples.length <= 8);
  assert.ok(noise.samples.some((s) => /Donate rid Health/i.test(s)));
  assert.ok(noise.samples.some((s) => /wey viyanization/i.test(s)));
});

test("scanPyramidJson: schema violations become structural errors", () => {
  const scalar = scanPyramidJson({ relativePath: "x.json", bytes: Buffer.from("42") });
  assert.ok(scalar.structuralErrors.some((e) => e.includes("root must be an array or object")));

  const badLayers = scanPyramidJson({ relativePath: "x.json", bytes: Buffer.from(JSON.stringify({ layers: "nope" })) });
  assert.ok(badLayers.structuralErrors.some((e) => e.includes("'layers' must be an array")));

  const nonObject = scanPyramidJson({ relativePath: "x.json", bytes: Buffer.from(JSON.stringify([1, 2])) });
  assert.ok(nonObject.structuralErrors.some((e) => e.includes("entry is not an object")));

  const missing = scanPyramidJson({ relativePath: "x.json", bytes: Buffer.from(JSON.stringify([{ layer: 1 }])) });
  assert.ok(missing.structuralErrors.some((e) => e.includes("missing required field")));

  const dup = scanPyramidJson({ relativePath: "x.json", bytes: Buffer.from(JSON.stringify([{ layer: 1, category: "A", recommended_servings: "1", description: "d" }, { layer: 2, category: "A", recommended_servings: "2", description: "e" }])) });
  assert.ok(dup.structuralErrors.some((e) => e.includes("duplicate category")));
});

test("scanPyramidImage: fake six-byte JPEG FF D8 FF E0 FF D9 is flagged", () => {
  const fake = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
  const audit = scanPyramidImage({ relativePath: "fake.jpg", bytes: fake });
  assert.ok(audit.structuralErrors.some((e) => e.includes("overruns file end")));
});
