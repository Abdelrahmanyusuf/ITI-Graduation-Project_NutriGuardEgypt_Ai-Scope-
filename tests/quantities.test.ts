import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { parseIngredientDictionary } from "../src/domain/ingredients.js";
import {
  UNIT_CODES,
  convertIngredientAmount,
  normalizeUnitAlias,
  parseIngredientAmount,
  parseQuantityExpression,
  parseUnitConversionRegistry,
  type ParsedUnitConversionRegistry,
} from "../src/domain/quantities.js";
import { normalizeQuantityDataset } from "../src/scripts/normalize-quantities.js";

const REGISTRY_FILE = "data/dictionary/unit-conversions.json";
const INGREDIENTS_FILE = "data/dictionary/ingredients.json";

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function loadRegistry(): ParsedUnitConversionRegistry {
  const dictionary = parseIngredientDictionary(readJson(INGREDIENTS_FILE));
  assert.deepEqual(dictionary.issues, []);
  const knownKeys = new Set(dictionary.entries.map((entry) => entry.key));
  const registry = parseUnitConversionRegistry(readJson(REGISTRY_FILE), knownKeys);
  assert.deepEqual(registry.issues, [], `registry issues: ${registry.issues.join("; ")}`);
  return registry;
}

function mutableRegistryJson(): Record<string, unknown> {
  return structuredClone(readJson(REGISTRY_FILE)) as Record<string, unknown>;
}

test("production unit registry loads all required Step 6 units with provenance", () => {
  const registry = loadRegistry();
  for (const code of ["g", "kg", "ml", "l", "teaspoon", "tablespoon", "cup", "piece"] as const) {
    const unit = registry.units.get(code);
    assert.ok(unit, `missing required unit ${code}`);
    assert.ok(registry.sources.has(unit.sourceId), `${code} must reference a source`);
  }
  assert.deepEqual([...registry.units.keys()].sort(), [...UNIT_CODES].sort());
  assert.ok(registry.ingredientConversions.length >= 10);
});

test("registry rejects factors with missing provenance, zero factors, unknown ingredients, and duplicate identities", () => {
  const raw = mutableRegistryJson();
  const conversions = raw.ingredientConversions as Array<Record<string, unknown>>;
  conversions.push({ ...conversions[0], id: "duplicate-id-with-same-identity" });
  conversions.push({ ...conversions[0], id: "zero", ingredientKey: "missing-key", gramsPerUnit: 0, sourceId: "" });
  const parsed = parseUnitConversionRegistry(raw, new Set(["rice"]));
  assert.ok(parsed.issues.some((issue) => issue.includes("duplicate conversion identity")));
  assert.ok(parsed.issues.some((issue) => issue.includes("gramsPerUnit must be positive")));
  assert.ok(parsed.issues.some((issue) => issue.includes("ingredientKey") && issue.includes("unknown")));
  assert.ok(parsed.issues.some((issue) => issue.includes("complete source provenance")));
});

test("registry rejects ambiguous aliases instead of choosing one silently", () => {
  const raw = mutableRegistryJson();
  const units = raw.units as Array<Record<string, unknown>>;
  (units.find((unit) => unit.code === "kg")?.aliasesEn as string[]).push("gram");
  const parsed = parseUnitConversionRegistry(raw);
  assert.ok(parsed.issues.some((issue) => issue.includes('unit alias "gram" maps to multiple units')));
  assert.equal(parsed.aliasIndex.has("gram"), false);
});

test("registry enforces unit semantics and conversions fail closed when the registry is invalid", () => {
  const raw = mutableRegistryJson();
  const units = raw.units as Array<Record<string, unknown>>;
  const cup = units.find((unit) => unit.code === "cup");
  assert.ok(cup);
  cup.dimension = "mass";
  cup.baseUnit = "g";
  cup.factorToBase = 1;
  const parsed = parseUnitConversionRegistry(raw);
  assert.ok(parsed.issues.some((issue) => issue.includes("cup must be volume with baseUnit ml")));
  const converted = convertIngredientAmount("1 cup rice", { registry: parsed });
  assert.equal(converted.status, "invalid");
  assert.equal(converted.grams, null);
  assert.ok(converted.reasonCodes.includes("unit_conversion_registry_invalid"));
});

test("registry requires every supported Step 6 unit", () => {
  const raw = mutableRegistryJson();
  raw.units = (raw.units as Array<Record<string, unknown>>).filter((unit) => unit.code !== "cup");
  const parsed = parseUnitConversionRegistry(raw);
  assert.ok(parsed.issues.some((issue) => issue.includes('required unit "cup" is missing')));
});

test("factor IDs are globally unique across ingredient, edible-portion, and yield records", () => {
  const raw = mutableRegistryJson();
  raw.ediblePortionFactors = [
    {
      id: "shared-factor-id",
      ingredientKey: "rice",
      foodState: "raw",
      factorMin: 0.9,
      factorMax: 0.9,
      uncertainty: "approximate",
      sourceId: "usda-nutritive-value-2002",
      sourceLocator: "test fixture one",
      originalValue: "90%",
      originalContext: "test-only factor",
    },
    {
      id: "shared-factor-id",
      ingredientKey: "onion",
      foodState: "raw",
      factorMin: 0.8,
      factorMax: 0.8,
      uncertainty: "approximate",
      sourceId: "usda-nutritive-value-2002",
      sourceLocator: "test fixture two",
      originalValue: "80%",
      originalContext: "test-only factor",
    },
  ];
  const parsed = parseUnitConversionRegistry(raw);
  assert.ok(parsed.issues.filter((issue) => issue.includes("unique id")).length >= 2);
  assert.deepEqual(parsed.ediblePortionFactors, []);
});

test("registry rejects edible-portion factors above 100 percent", () => {
  const raw = mutableRegistryJson();
  raw.ediblePortionFactors = [
    {
      id: "invalid-edible-factor",
      ingredientKey: "rice",
      foodState: "raw",
      factorMin: 0.9,
      factorMax: 1.1,
      uncertainty: "range",
      sourceId: "usda-nutritive-value-2002",
      sourceLocator: "test fixture",
      originalValue: "90%-110%",
      originalContext: "invalid test-only edible factor",
    },
  ];
  const parsed = parseUnitConversionRegistry(raw, new Set(["rice", "rice-cooked", "onion", "garlic", "egg", "white-sugar", "honey", "canola-oil", "corn-oil", "olive-oil"]));
  assert.ok(parsed.issues.some((issue) => issue.includes("edible-portion factors cannot exceed 1")));
});

test("unit alias normalization supports Arabic and Egyptian spellings", () => {
  const registry = loadRegistry();
  assert.equal(registry.aliasIndex.get(normalizeUnitAlias("جرام")), "g");
  assert.equal(registry.aliasIndex.get(normalizeUnitAlias("معلقة كبيرة")), "tablespoon");
  assert.equal(registry.aliasIndex.get(normalizeUnitAlias("كباية")), "cup");
  assert.equal(registry.aliasIndex.get(normalizeUnitAlias("فصوص")), "clove");
});

test("parses integers, decimals, ASCII fractions, mixed fractions, and vulgar fractions", () => {
  assert.deepEqual(parseQuantityExpression("2").value, { min: 2, max: 2 });
  assert.deepEqual(parseQuantityExpression("1.25").value, { min: 1.25, max: 1.25 });
  assert.deepEqual(parseQuantityExpression("1/2").value, { min: 0.5, max: 0.5 });
  assert.deepEqual(parseQuantityExpression("1 1/2").value, { min: 1.5, max: 1.5 });
  assert.deepEqual(parseQuantityExpression("1-1/2").value, { min: 1.5, max: 1.5 });
  assert.deepEqual(parseQuantityExpression("½").value, { min: 0.5, max: 0.5 });
  assert.deepEqual(parseQuantityExpression("1½").value, { min: 1.5, max: 1.5 });
  assert.deepEqual(parseQuantityExpression("⅔").value, { min: 0.666666667, max: 0.666666667 });
});

test("parses Arabic-Indic and Eastern-Arabic quantities and fractions", () => {
  assert.deepEqual(parseQuantityExpression("١/٢").value, { min: 0.5, max: 0.5 });
  assert.deepEqual(parseQuantityExpression("۲ ۱/۲").value, { min: 2.5, max: 2.5 });
  assert.deepEqual(parseQuantityExpression("١٫٥").value, { min: 1.5, max: 1.5 });
});

test("parses English and Arabic ranges while rejecting descending/invalid ranges", () => {
  assert.deepEqual(parseQuantityExpression("1-2"), {
    original: "1-2",
    kind: "range",
    value: { min: 1, max: 2 },
    reason: null,
  });
  assert.deepEqual(parseQuantityExpression("1½–2").value, { min: 1.5, max: 2 });
  assert.deepEqual(parseQuantityExpression("1 to 2").value, { min: 1, max: 2 });
  assert.deepEqual(parseQuantityExpression("١ إلى ٢").value, { min: 1, max: 2 });
  assert.equal(parseQuantityExpression("2-1").kind, "invalid");
  assert.equal(parseQuantityExpression("1/0").kind, "invalid");
});

test("ingredient-line parser preserves original quantity/unit and separates ingredient text", () => {
  const registry = loadRegistry();
  const parsed = parseIngredientAmount("  1 1/2 cups rice  ", registry);
  assert.equal(parsed.original, "  1 1/2 cups rice  ");
  assert.equal(parsed.originalQuantity, "1 1/2");
  assert.equal(parsed.originalUnit, "cups");
  assert.equal(parsed.normalizedUnit, "cup");
  assert.equal(parsed.ingredientText, "rice");
  assert.deepEqual(parsed.quantity.value, { min: 1.5, max: 1.5 });
});

test("ingredient-line parser uses longest Arabic household-measure aliases", () => {
  const registry = loadRegistry();
  const tablespoon = parseIngredientAmount("٢ ملعقة كبيرة عسل", registry);
  assert.equal(tablespoon.originalUnit, "ملعقة كبيرة");
  assert.equal(tablespoon.normalizedUnit, "tablespoon");
  assert.equal(tablespoon.measureVariant, "standard");
  assert.equal(tablespoon.ingredientText, "عسل");

  const teaspoon = parseIngredientAmount("١ معلقة صغيرة سكر", registry);
  assert.equal(teaspoon.normalizedUnit, "teaspoon");
  assert.equal(teaspoon.originalUnit, "معلقة صغيرة");
  assert.equal(teaspoon.measureVariant, "egyptian_household");
});

test("explicit size qualifiers infer piece but preserve the fact that the unit was omitted", () => {
  const registry = loadRegistry();
  const english = parseIngredientAmount("1 medium onion", registry);
  assert.equal(english.originalUnit, null);
  assert.equal(english.normalizedUnit, "piece");
  assert.equal(english.qualifier, "medium");
  assert.equal(english.unitInferred, true);
  assert.equal(english.ingredientText, "onion");

  const arabic = parseIngredientAmount("١ حبة متوسطة بصل", registry);
  assert.equal(arabic.originalUnit, "حبة");
  assert.equal(arabic.normalizedUnit, "piece");
  assert.equal(arabic.qualifier, "medium");
  assert.equal(arabic.ingredientText, "بصل");
});

test("to taste, as needed, and frying oil return explicit unsupported statuses", () => {
  const registry = loadRegistry();
  for (const [line, code] of [
    ["salt to taste", "quantity_to_taste"],
    ["water as needed", "quantity_as_needed"],
    ["oil for frying", "frying_oil_absorption_unknown"],
    ["زيت للقلي", "frying_oil_absorption_unknown"],
  ]) {
    const parsed = parseIngredientAmount(line, registry);
    assert.equal(parsed.status, "unsupported");
    assert.equal(parsed.quantity.value, null);
    assert.ok(parsed.reasonCodes.includes(code));
  }
});

test("measured qualitative and frying quantities preserve their original quantity and unit", () => {
  const registry = loadRegistry();
  const parsed = parseIngredientAmount("2 tbsp olive oil for frying", registry);
  assert.equal(parsed.status, "unsupported");
  assert.equal(parsed.originalQuantity, "2");
  assert.equal(parsed.originalUnit, "tbsp");
  assert.equal(parsed.normalizedUnit, "tablespoon");
  assert.equal(parsed.measureVariant, "standard");
  assert.equal(parsed.ingredientText, "olive oil for frying");
  assert.equal(parsed.quantity.kind, "qualitative");
  assert.equal(parsed.quantity.value, null);
});

test("mass conversions are deterministic for g, kg, fractions, and ranges", () => {
  const registry = loadRegistry();
  assert.deepEqual(convertIngredientAmount("250 g rice", { registry }).grams, { min: 250, max: 250 });
  assert.deepEqual(convertIngredientAmount("1.5 kg rice", { registry }).grams, { min: 1500, max: 1500 });
  assert.deepEqual(convertIngredientAmount("1/2 kg rice", { registry }).grams, { min: 500, max: 500 });
  assert.deepEqual(convertIngredientAmount("1-2 kg rice", { registry }).grams, { min: 1000, max: 2000 });
  assert.equal(convertIngredientAmount("1-2 kg rice", { registry }).status, "converted");
});

test("volume units normalize to ml but remain partial without an ingredient factor", () => {
  const registry = loadRegistry();
  const ml = convertIngredientAmount("2 l water", { registry, ingredientKey: "water" });
  assert.equal(ml.status, "partial");
  assert.equal(ml.baseUnit, "ml");
  assert.deepEqual(ml.baseAmount, { min: 2000, max: 2000 });
  assert.equal(ml.grams, null);
  assert.ok(ml.reasonCodes.includes("ingredient_specific_conversion_missing"));
});

test("ingredient-specific cups never assume a universal cup weight", () => {
  const registry = loadRegistry();
  const rawRice = convertIngredientAmount("1 cup raw rice", { registry, ingredientKey: "rice", foodState: "raw" });
  const cookedRice = convertIngredientAmount("1 cup cooked rice", {
    registry,
    ingredientKey: "rice-cooked",
    foodState: "cooked",
  });
  const sugar = convertIngredientAmount("1 cup sugar", { registry, ingredientKey: "white-sugar" });
  const honey = convertIngredientAmount("1 cup honey", { registry, ingredientKey: "honey" });
  assert.deepEqual(rawRice.grams, { min: 185, max: 185 });
  assert.deepEqual(cookedRice.grams, { min: 158, max: 158 });
  assert.deepEqual(sugar.grams, { min: 200, max: 200 });
  assert.deepEqual(honey.grams, { min: 339, max: 339 });
  assert.equal(new Set([rawRice.grams?.min, cookedRice.grams?.min, sugar.grams?.min, honey.grams?.min]).size, 4);
});

test("an unspecified food state cannot borrow a raw ingredient conversion", () => {
  const registry = loadRegistry();
  const unspecified = convertIngredientAmount("1 cup rice", {
    registry,
    ingredientKey: "rice",
    foodState: null,
  });
  assert.equal(unspecified.status, "partial");
  assert.equal(unspecified.grams, null);
  assert.ok(unspecified.reasonCodes.includes("ingredient_specific_conversion_missing"));
});

test("Egyptian volume measures parse but never inherit US household factors", () => {
  const registry = loadRegistry();
  const result = convertIngredientAmount("١ كباية رز", {
    registry,
    ingredientKey: "rice",
    foodState: "raw",
  });
  assert.equal(result.status, "partial");
  assert.equal(result.normalizedUnit, "cup");
  assert.equal(result.measureVariant, "egyptian_household");
  assert.equal(result.baseAmount, null);
  assert.equal(result.grams, null);
  assert.ok(result.reasonCodes.includes("egyptian_household_conversion_missing"));
  assert.equal(result.conversionId, null);
});

test("raw and cooked rice states cannot borrow one another's conversion", () => {
  const registry = loadRegistry();
  const wrongState = convertIngredientAmount("1 cup rice", {
    registry,
    ingredientKey: "rice-cooked",
    foodState: null,
  });
  assert.equal(wrongState.status, "partial");
  assert.equal(wrongState.grams, null);
  assert.ok(wrongState.reasonCodes.includes("ingredient_specific_conversion_missing"));
});

test("sourced teaspoon/tablespoon factors work only for their ingredient", () => {
  const registry = loadRegistry();
  assert.deepEqual(
    convertIngredientAmount("2 tsp sugar", { registry, ingredientKey: "white-sugar" }).grams,
    { min: 8, max: 8 }
  );
  assert.deepEqual(
    convertIngredientAmount("2 tablespoons honey", { registry, ingredientKey: "honey" }).grams,
    { min: 42, max: 42 }
  );
  assert.deepEqual(
    convertIngredientAmount("1 tbsp olive oil", { registry, ingredientKey: "olive-oil" }).grams,
    { min: 14, max: 14 }
  );
  assert.equal(convertIngredientAmount("1 tbsp tomato", { registry, ingredientKey: "tomato" }).grams, null);
});

test("Egyptian count measures convert only with sourced ingredient and size records", () => {
  const registry = loadRegistry();
  const onion = convertIngredientAmount("١ حبة متوسطة بصل", { registry, ingredientKey: "onion", foodState: "raw" });
  assert.equal(onion.status, "converted");
  assert.deepEqual(onion.grams, { min: 110, max: 110 });

  const onionNoSize = convertIngredientAmount("1 piece onion", { registry, ingredientKey: "onion" });
  assert.equal(onionNoSize.status, "partial");
  assert.equal(onionNoSize.grams, null);

  const garlic = convertIngredientAmount("٣ فصوص ثوم", { registry, ingredientKey: "garlic", foodState: "raw" });
  assert.deepEqual(garlic.grams, { min: 9, max: 9 });

  const egg = convertIngredientAmount("2 large eggs", { registry, ingredientKey: "egg", foodState: "raw" });
  assert.deepEqual(egg.grams, { min: 100, max: 100 });
});

test("every applied factor is traceable to source, locator, original value, and context", () => {
  const registry = loadRegistry();
  const result = convertIngredientAmount("1 cup raw rice", { registry, ingredientKey: "rice", foodState: "raw" });
  assert.equal(result.status, "converted");
  assert.ok(result.provenance.length >= 2, "unit + ingredient factor sources are surfaced");
  assert.ok(result.appliedFactors.length >= 2);
  for (const factor of result.appliedFactors) {
    assert.ok(factor.id);
    assert.ok(factor.source.id && factor.source.title && factor.source.url && factor.source.accessDate);
    assert.ok(factor.sourceLocator && factor.originalValue && factor.originalContext);
  }
});

test("uncertainty is preserved for household factors and quantity ranges", () => {
  const registry = loadRegistry();
  const cup = convertIngredientAmount("1 cup raw rice", { registry, ingredientKey: "rice", foodState: "raw" });
  assert.equal(cup.uncertainty, "approximate");
  const range = convertIngredientAmount("1-2 cups raw rice", { registry, ingredientKey: "rice", foodState: "raw" });
  assert.deepEqual(range.grams, { min: 185, max: 370 });
  assert.equal(range.uncertainty, "range");
});

test("edible-portion and cooking-yield factors apply only when explicitly sourced", () => {
  const raw = mutableRegistryJson();
  raw.ediblePortionFactors = [
    {
      id: "fixture-chicken-edible",
      ingredientKey: "chicken",
      foodState: "raw",
      factorMin: 0.7,
      factorMax: 0.8,
      uncertainty: "range",
      sourceId: "usda-nutritive-value-2002",
      sourceLocator: "synthetic test locator",
      originalValue: "70%-80% edible",
      originalContext: "test-only sourced factor fixture",
    },
  ];
  raw.cookingYieldFactors = [
    {
      id: "fixture-chicken-yield",
      ingredientKey: "chicken",
      foodStateFrom: "raw",
      foodStateTo: "cooked",
      factorMin: 0.7,
      factorMax: 0.7,
      uncertainty: "approximate",
      sourceId: "usda-nutritive-value-2002",
      sourceLocator: "synthetic test locator",
      originalValue: "70% cooking yield",
      originalContext: "test-only sourced factor fixture",
    },
  ];
  const registry = parseUnitConversionRegistry(raw, new Set(["rice", "rice-cooked", "onion", "garlic", "egg", "white-sugar", "honey", "canola-oil", "corn-oil", "olive-oil", "chicken"]));
  assert.deepEqual(registry.issues, []);
  const converted = convertIngredientAmount("100 g chicken", {
    registry,
    ingredientKey: "chicken",
    foodState: "raw",
    applyEdiblePortion: true,
    targetFoodState: "cooked",
  });
  assert.equal(converted.status, "converted");
  assert.deepEqual(converted.edibleGrams, { min: 70, max: 80 });
  assert.deepEqual(converted.yieldAdjustedGrams, { min: 49, max: 56 });
  assert.ok(converted.appliedFactors.some((factor) => factor.kind === "edible_portion"));
  assert.ok(converted.appliedFactors.some((factor) => factor.kind === "cooking_yield"));
});

test("missing edible/yield factors return partial without fabricated adjusted grams", () => {
  const registry = loadRegistry();
  const edible = convertIngredientAmount("100 g chicken", {
    registry,
    ingredientKey: "chicken",
    foodState: "raw",
    applyEdiblePortion: true,
  });
  assert.equal(edible.status, "partial");
  assert.deepEqual(edible.grams, { min: 100, max: 100 });
  assert.equal(edible.edibleGrams, null);

  const cooked = convertIngredientAmount("100 g chicken", {
    registry,
    ingredientKey: "chicken",
    foodState: "raw",
    targetFoodState: "cooked",
  });
  assert.equal(cooked.status, "partial");
  assert.equal(cooked.yieldAdjustedGrams, null);
  assert.ok(cooked.reasonCodes.includes("cooking_yield_factor_missing"));
});

test("frying-oil absorption is never fabricated even when an oil factor exists", () => {
  const registry = loadRegistry();
  const result = convertIngredientAmount("1 tbsp olive oil for frying", {
    registry,
    ingredientKey: "olive-oil",
  });
  assert.equal(result.status, "unsupported");
  assert.equal(result.grams, null);
  assert.ok(result.reasonCodes.includes("frying_oil_absorption_unknown"));
});

test("unrecognized and absent units return explicit partial/unsupported statuses", () => {
  const registry = loadRegistry();
  const pinch = convertIngredientAmount("2 pinches salt", { registry, ingredientKey: "salt" });
  assert.equal(pinch.status, "partial");
  assert.equal(pinch.grams, null);
  const absent = convertIngredientAmount("salt", { registry, ingredientKey: "salt" });
  assert.equal(absent.status, "unsupported");
  assert.equal(absent.grams, null);
});

test("repeated conversions are byte-for-byte deterministic", () => {
  const registry = loadRegistry();
  const options = { registry, ingredientKey: "honey" } as const;
  const first = convertIngredientAmount("1/2 tablespoon honey", options);
  const second = convertIngredientAmount("1/2 tablespoon honey", options);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("dataset normalizer writes traceable coverage and converts an approved fixture end to end", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "nutriguard-step6-"));
  try {
    const dictionaryDir = path.join(fixtureRoot, "data", "dictionary");
    const rawDir = path.join(fixtureRoot, "data", "raw");
    await mkdir(dictionaryDir, { recursive: true });
    await mkdir(rawDir, { recursive: true });

    const dictionary = structuredClone(readJson(INGREDIENTS_FILE)) as Array<Record<string, unknown>>;
    const rice = dictionary.find((entry) => entry.key === "rice");
    assert.ok(rice);
    rice.provenance = {
      version: "test-1",
      reviewer: "Step 6 integration test",
      reviewDate: "2026-08-09",
      source: "tests/quantities.test.ts",
      status: "approved",
    };
    rice.foodState = "raw";

    await Promise.all([
      writeFile(path.join(dictionaryDir, "ingredients.json"), JSON.stringify(dictionary), "utf8"),
      writeFile(path.join(dictionaryDir, "reviewed-mappings.json"), "[]", "utf8"),
      writeFile(path.join(dictionaryDir, "review-registry.json"), '{"records":[]}', "utf8"),
      writeFile(path.join(dictionaryDir, "unit-conversions.json"), JSON.stringify(readJson(REGISTRY_FILE)), "utf8"),
      writeFile(path.join(rawDir, "recipes-fixture.csv"), 'recipe_title\tingredients\nFixture\t"[""1 cup raw rice""]"\n', "utf8"),
    ]);

    const result = await normalizeQuantityDataset(fixtureRoot);
    assert.equal(result.valid, true);
    assert.equal(result.report.occurrencesSeen, 1);
    assert.equal(result.report.acceptedIngredientMappings, 1);
    assert.equal(result.report.gramConverted, 1);
    assert.equal(result.report.byConversionId["usda-rice-raw-cup-185g"], 1);
    assert.deepEqual(result.report.blockers, []);
    assert.deepEqual(result.queue, []);

    const persisted = JSON.parse(
      await readFile(path.join(fixtureRoot, "data", "reports", "unit-normalization-coverage.json"), "utf8")
    ) as { gramConverted: number };
    assert.equal(persisted.gramConverted, 1);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
