import type { ExpandedAgentResponse } from "../agent/expanded-agent.js";
import { InMemoryAlternativeRuleRepository, NutriGuardExpandedAgent } from "../agent/expanded-agent.js";
import { NUTRIGUARD_SYSTEM_PROMPT_VERSION } from "../agent/system-prompt.js";
import {
  buildGraduationRetrievalCorpus,
  calculateUnifiedDemoNutrition,
  GRADUATION_DEMO_CORPUS_ID,
  loadUnifiedEgyptianDemoDataset,
  toRecipeNutritionResult,
  type UnifiedDemoRecipe,
  type UnifiedEgyptianDemoDataset,
} from "../demo/unified-egyptian-dataset.js";
import { ingestRetrievalCorpus } from "../retrieval/ingestion.js";
import { OpenAICompatibleEmbeddingProvider } from "../retrieval/embeddings.js";
import { QdrantVectorStore } from "../retrieval/qdrant.js";
import type { EmbeddingProvider } from "../retrieval/types.js";
import { InMemoryVectorStore } from "../retrieval/vector-store.js";
import { InMemoryGuidelineRuleRepository, NutriGuardTools, type NutriGuardToolset } from "../tools/nutriguard-tools.js";
import {
  NutriGuardBackendClient,
  type BackendFood,
  type BackendRecipe,
  type GraduationBackendDataSource,
} from "./graduation-backend-client.js";
import { HybridRetrievalTools } from "./hybrid-retrieval-tools.js";

const DIMENSIONS = 16_384;

const INGREDIENT_NAMES_AR: Readonly<Record<string, string>> = {
  rice_white_raw: "أرز أبيض",
  lentils_brown_dry: "عدس بني",
  macaroni_dry: "مكرونة",
  chickpeas_dry: "حمص",
  tomato_sauce: "صلصة طماطم",
  onion_raw: "بصل",
  garlic_raw: "ثوم",
  vegetable_oil: "زيت نباتي",
  cumin_ground: "كمون",
  vinegar: "خل",
  fava_beans_dry: "فول",
  lemon_juice: "عصير ليمون",
  olive_oil: "زيت زيتون",
  tomato_raw: "طماطم",
  parsley_raw: "بقدونس",
  cilantro_raw: "كزبرة",
  sesame_seeds: "سمسم",
  chicken_breast_raw: "صدور فراخ",
  chicken_meat_raw: "فراخ",
  beef_stew_meat_raw: "لحمة",
  potato_raw: "بطاطس",
  eggs_raw: "بيض",
  milk_whole: "لبن كامل الدسم",
  pita_bread: "عيش بلدي",
  cucumber_raw: "خيار",
  carrot_raw: "جزر",
};

const INGREDIENT_ALIASES: ReadonlyArray<{ key: string; aliases: readonly string[] }> = [
  { key: "chicken_breast_raw", aliases: ["chicken breast", "صدور فراخ", "صدر فراخ", "صدر دجاج"] },
  { key: "chicken_meat_raw", aliases: ["chicken", "فراخ", "دجاج"] },
  { key: "beef_stew_meat_raw", aliases: ["beef", "meat", "لحمة", "لحم"] },
  { key: "rice_white_raw", aliases: ["white rice", "rice", "أرز", "ارز", "رز"] },
  { key: "macaroni_dry", aliases: ["macaroni", "pasta", "مكرونة", "مكرونه"] },
  { key: "lentils_brown_dry", aliases: ["brown lentils", "lentils", "عدس"] },
  { key: "fava_beans_dry", aliases: ["fava beans", "beans", "فول"] },
  { key: "chickpeas_dry", aliases: ["chickpeas", "حمص"] },
  { key: "olive_oil", aliases: ["olive oil", "زيت زيتون"] },
  { key: "vegetable_oil", aliases: ["vegetable oil", "زيت نباتي", "زيت"] },
  { key: "potato_raw", aliases: ["potatoes", "potato", "بطاطس", "بطاطا"] },
  { key: "tomato_raw", aliases: ["tomatoes", "tomato", "طماطم"] },
  { key: "onion_raw", aliases: ["onions", "onion", "بصل"] },
  { key: "garlic_raw", aliases: ["garlic", "ثوم"] },
  { key: "eggs_raw", aliases: ["eggs", "egg", "بيض"] },
  { key: "milk_whole", aliases: ["whole milk", "milk", "لبن", "حليب"] },
  { key: "pita_bread", aliases: ["pita bread", "bread", "عيش بلدي", "عيش", "خبز"] },
  { key: "cucumber_raw", aliases: ["cucumber", "خيار"] },
  { key: "carrot_raw", aliases: ["carrots", "carrot", "جزر"] },
];

interface ParsedIngredientAmount {
  key: string;
  grams: number;
  suppliedName: string;
}

export interface CalorieTargetConversationContext {
  schemaVersion: "1.0";
  lastIntent: "meal_calorie_target";
  calorieTargetKcal: number;
  category: string | null;
  relation: "closest" | "below" | "above";
  lastRecommendationCaloriesKcal: number;
  excludedIngredientKeys?: string[];
  recipeId?: string;
}

export interface LighterModificationConversationContext {
  schemaVersion: "1.0";
  lastIntent: "lighter_modification";
  recipeId: string;
  ingredient: string;
  originalGrams: number;
  proposedGrams: number;
}

export interface RecipeReferenceConversationContext {
  schemaVersion: "1.0";
  lastIntent: "recipe_reference";
  recipeId: string;
}

export interface MealPlanConversationContext {
  schemaVersion: "1.0";
  lastIntent: "meal_plan";
  calorieTargetKcal: number;
  excludedIngredientKeys: string[];
  recipeIds: string[];
}

export type GraduationConversationContext = CalorieTargetConversationContext | LighterModificationConversationContext | RecipeReferenceConversationContext | MealPlanConversationContext;

function answerLanguage(message: string, requested: "ar-EG" | "ar" | "en" | undefined): "ar-EG" | "ar" | "en" {
  if (/\p{Script=Arabic}/u.test(message)) return requested === "ar" ? "ar" : "ar-EG";
  if (/[A-Za-z]/u.test(message)) return "en";
  return requested ?? "ar-EG";
}

function mealCategory(message: string): string | null {
  if (/(?:breakfast|فطار|إفطار|افطار)/iu.test(message)) return "breakfast";
  if (/(?:dessert|sweet|حلو|حلويات)/iu.test(message)) return "dessert";
  if (/(?:drink|beverage|مشروب|عصير)/iu.test(message)) return "beverage";
  if (/(?:salad|سلطة)/iu.test(message)) return "salad";
  if (/(?:soup|شوربة)/iu.test(message)) return "soup";
  if (/(?:lunch|dinner|غدا|غداء|عشا|عشاء)/iu.test(message)) return "main_dish";
  return null;
}

const DAIRY_INGREDIENT_KEYS = new Set(["butter_raw", "cheese_feta", "cream_heavy", "ghee", "ice_cream_vanilla", "milk_whole", "yogurt_plain"]);

function excludedIngredientKeys(message: string): string[] {
  const normalized = normalizedLookupText(message);
  const excluded = new Set<string>();
  if (/(?:بدون|من غير|مفيهاش|مافيهاش|حساسيه من|حساسيه|استبعد).{0,18}(?:البان|بان|لبن|حليب|منتجات البان|منتجات بان)|(?:dairy[ -]?free|no dairy|milk allergy)/iu.test(normalized)) {
    for (const key of DAIRY_INGREDIENT_KEYS) excluded.add(key);
  }
  const marker = normalized.match(/(?:بدون|من غير|مفيهاش|مافيهاش|استبعد|without|\bno\b)/iu);
  const exclusionText = marker ? normalized.slice((marker.index ?? 0) + marker[0].length) : "";
  if (exclusionText) {
    for (const entry of INGREDIENT_ALIASES) {
      if (entry.aliases.some((alias) => exclusionText.includes(normalizedLookupText(alias)))) excluded.add(entry.key);
    }
  }
  return [...excluded].sort();
}

function recipeContainsExcludedIngredient(recipe: UnifiedDemoRecipe, excluded: ReadonlySet<string>): boolean {
  return recipe.ingredients.some((item) => excluded.has(item.ingredient));
}

function normalizeNumberDigits(value: string): string {
  const arabic = "٠١٢٣٤٥٦٧٨٩";
  const eastern = "۰۱۲۳۴۵۶۷۸۹";
  return value.replace(/[٠-٩۰-۹]/gu, (digit) => {
    const arabicIndex = arabic.indexOf(digit);
    return String(arabicIndex >= 0 ? arabicIndex : eastern.indexOf(digit));
  }).replace(/٫/gu, ".");
}

function parseIngredientAmounts(message: string): { parsed: ParsedIngredientAmount[]; unknownSegments: string[] } {
  const normalized = normalizeNumberDigits(message).toLocaleLowerCase("ar-EG");
  const segments = normalized.split(/\s*(?:,|،|\+|\n|\s+و(?=\s*\d)|\s+and\s+)\s*/iu).map((segment) => segment.trim()).filter(Boolean);
  const parsed: ParsedIngredientAmount[] = [];
  const unknownSegments: string[] = [];
  for (const segment of segments) {
    const quantity = segment.match(/(-?\d+(?:\.\d+)?)\s*(?:g|gr|gram|grams|جرام|جرامات|جم)(?![\p{L}\p{N}])/iu);
    if (!quantity) continue;
    const grams = Number(quantity[1]);
    if (!Number.isFinite(grams) || grams <= 0 || grams > 10_000) {
      unknownSegments.push(segment);
      continue;
    }
    const alias = INGREDIENT_ALIASES
      .flatMap((entry) => entry.aliases.map((name) => ({ key: entry.key, name: name.toLocaleLowerCase("ar-EG") })))
      .sort((a, b) => b.name.length - a.name.length)
      .find((candidate) => segment.includes(candidate.name));
    if (!alias) unknownSegments.push(segment);
    else parsed.push({ key: alias.key, grams, suppliedName: alias.name });
  }
  return { parsed, unknownSegments };
}

function asksForIngredientCalories(message: string): boolean {
  return /\d\s*(?:g|gr|gram|grams|جرام|جرامات|جم)(?![\p{L}\p{N}])/iu.test(normalizeNumberDigits(message))
    || /(?:calculate|calories|kcal|ingredients|احسب|سعرات|سعر حراري|مكونات)/iu.test(message);
}

function asksForAdvice(message: string): boolean {
  return /(?:advice|tips|healthy|healthier|نصيحة|نصائح|صحي|صحية|أخف|اخف)/iu.test(message);
}

function querySubject(message: string): string {
  return normalizedLookupText(normalizeNumberDigits(message))
    .split(/\s+/u)
    .filter((token) => !/^\d+(?:\.\d+)?$/u.test(token) && !new Set([
      "كم", "كام", "سعر", "سعرات", "حراري", "حرارية", "كالوري", "طاقة", "في", "من", "هو", "هي",
      "طريقة", "عمل", "مكونات", "وصفة", "اكل", "اكلة", "الاكل", "الاكلة", "عاوز", "اريد",
      "احسب", "حساب", "جرام", "جرامات", "جم", "g", "gr", "gram", "grams",
      "how", "many", "calculate", "calories", "kcal", "energy", "in", "the", "a", "an", "recipe", "method", "make", "for",
    ]).has(token))
    .join(" ").trim();
}

function candidateNameMatchesQuery(query: string, names: readonly string[]): boolean {
  const normalizedQuery = ` ${normalizedLookupText(query)} `;
  return names.some((name) => {
    const normalizedName = normalizedLookupText(name);
    if (normalizedName.length < 2) return false;
    return normalizedQuery.includes(` ${normalizedName} `);
  });
}

function backendFoodProvenance(food: BackendFood, title: string): ExpandedAgentResponse["provenance"][number] {
  return {
    sourceId: `BACKEND-FOOD-${food.id}`, versionId: "live-public-api", title,
    url: `http://nutriguard.runasp.net/api/Foods/${food.id}`, accessedAt: null, locator: String(food.id),
  };
}

function localizedUnit(unit: string, language: "ar-EG" | "ar" | "en"): string {
  if (language === "en") return unit.replaceAll("_", " ");
  return ({ gram: "جرام", tablespoon: "ملعقة كبيرة", teaspoon: "ملعقة صغيرة", cup: "كوب", piece: "قطعة" } as Record<string, string>)[unit] ?? unit.replaceAll("_", " ");
}

function ingredientLabel(ingredient: string, language: "ar-EG" | "ar" | "en"): string {
  return language === "en" ? ingredient.replaceAll("_", " ") : INGREDIENT_NAMES_AR[ingredient] ?? ingredient.replaceAll("_", " ");
}

function normalizedLookupText(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase("ar-EG")
    .replace(/[\u064B-\u065F\u0670]/gu, "")
    .replace(/[آأإٱ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ة/gu, "ه")
    .replace(/ـ/gu, "")
    // Collapse only repeated Arabic long-vowel letters. Collapsing every repeated
    // letter would corrupt meaningful prefixes such as "للكشري".
    .replace(/([اوي])\1+/gu, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .map((token) => /^وال[\p{L}]{3,}$/u.test(token) ? token.slice(3)
      : /^(?:بال|كال)[\p{L}]{3,}$/u.test(token) ? token.slice(3)
      : /^لل[\p{L}]{3,}$/u.test(token) ? token.slice(2)
      : /^ال[\p{L}]{3,}$/u.test(token) ? token.slice(2)
      : token)
    .join(" ");
}

function explicitlyNamedRecipe(dataset: UnifiedEgyptianDemoDataset, query: string): UnifiedDemoRecipe | null {
  const normalizedQuery = ` ${normalizedLookupText(query)} `;
  const candidates = dataset.recipes.flatMap((recipe) => [recipe.name_ar, recipe.name_en, ...recipe.alt_names]
    .map(normalizedLookupText)
    .filter((name) => name.length >= 3 && normalizedQuery.includes(` ${name} `))
    .map((name) => ({ recipe, nameLength: name.length })));
  candidates.sort((a, b) => b.nameLength - a.nameLength || a.recipe.recipe_id.localeCompare(b.recipe.recipe_id));
  return candidates[0]?.recipe ?? null;
}

function isWithinOneEdit(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let first = left;
  let second = right;
  if (first.length > second.length) [first, second] = [second, first];
  let edits = 0;
  for (let firstIndex = 0, secondIndex = 0; firstIndex < first.length || secondIndex < second.length;) {
    if (first[firstIndex] === second[secondIndex]) { firstIndex += 1; secondIndex += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (first.length === second.length) { firstIndex += 1; secondIndex += 1; }
    else secondIndex += 1;
  }
  return true;
}

type GraduationIntent =
  | "find_recipe"
  | "recipe_nutrition"
  | "ingredient_nutrition"
  | "compare_recipes"
  | "general_guideline"
  | "lighter_modification"
  | "unsupported"
  | "medical_safety";

const COMMON_RECIPE_ALIASES: Readonly<Record<string, string>> = {
  "كشري": "EGY-RCP-001",
  "الكشري": "EGY-RCP-001",
  "فول": "EGY-RCP-002",
  "الفول": "EGY-RCP-002",
  "طعمية": "EGY-RCP-003",
  "الطعمية": "EGY-RCP-003",
};

function explicitlyNamedRecipes(dataset: UnifiedEgyptianDemoDataset, query: string): UnifiedDemoRecipe[] {
  const normalizedQuery = ` ${normalizedLookupText(query)} `;
  const queryTokens = normalizedLookupText(query).split(/\s+/u).filter(Boolean);
  const matches = new Map<string, { recipe: UnifiedDemoRecipe; nameLength: number; index: number }>();
  const uniqueArabicPrefixes = new Map<string, UnifiedDemoRecipe | null>();
  const exactArabicNames = new Map(dataset.recipes.map((recipe) => [normalizedLookupText(recipe.name_ar), recipe.recipe_id]));
  for (const recipe of dataset.recipes) {
    const tokens = normalizedLookupText(recipe.name_ar).split(/\s+/u).filter(Boolean);
    if (tokens.length < 3) continue;
    const prefix = tokens.slice(0, 2).join(" ");
    if (exactArabicNames.has(prefix) && exactArabicNames.get(prefix) !== recipe.recipe_id) { uniqueArabicPrefixes.set(prefix, null); continue; }
    uniqueArabicPrefixes.set(prefix, uniqueArabicPrefixes.has(prefix) ? null : recipe);
  }
  for (const recipe of dataset.recipes) {
    for (const name of [recipe.name_ar, recipe.name_en, ...recipe.alt_names].map(normalizedLookupText)) {
      if (name.length < 3) continue;
      const exactIndex = normalizedQuery.indexOf(` ${name} `);
      const conjunctionIndex = normalizedQuery.indexOf(` و${name} `);
      const index = exactIndex < 0 ? conjunctionIndex : conjunctionIndex < 0 ? exactIndex : Math.min(exactIndex, conjunctionIndex);
      if (index < 0) continue;
      const current = matches.get(recipe.recipe_id);
      if (!current || name.length > current.nameLength) matches.set(recipe.recipe_id, { recipe, nameLength: name.length, index });
    }
  }
  for (const recipe of dataset.recipes) {
    if (matches.has(recipe.recipe_id)) continue;
    const name = normalizedLookupText(recipe.name_ar);
    const nameTokens = name.split(/\s+/u).filter(Boolean);
    if (nameTokens.length < 2 || nameTokens.length > queryTokens.length) continue;
    for (let start = 0; start <= queryTokens.length - nameTokens.length; start += 1) {
      const window = queryTokens.slice(start, start + nameTokens.length);
      if (!nameTokens.every((token, index) => isWithinOneEdit(token, window[index] ?? ""))) continue;
      if (!nameTokens.some((token, index) => token === window[index])) continue;
      const phrase = window.join(" ");
      matches.set(recipe.recipe_id, { recipe, nameLength: name.length, index: normalizedQuery.indexOf(` ${phrase} `) });
      break;
    }
    if (!matches.has(recipe.recipe_id)) {
      const prefix = nameTokens.slice(0, 2).join(" ");
      const prefixIndex = normalizedQuery.indexOf(` ${prefix} `);
      const allTokensPresent = nameTokens.every((token) => queryTokens.some((queryToken) => isWithinOneEdit(token, queryToken)));
      if (prefixIndex >= 0 && allTokensPresent) matches.set(recipe.recipe_id, { recipe, nameLength: name.length, index: prefixIndex });
    }
  }
  for (const [prefix, recipe] of uniqueArabicPrefixes) {
    if (!recipe || matches.has(recipe.recipe_id)) continue;
    const exactIndex = normalizedQuery.indexOf(` ${prefix} `);
    const conjunctionIndex = normalizedQuery.indexOf(` و${prefix} `);
    const index = exactIndex < 0 ? conjunctionIndex : conjunctionIndex < 0 ? exactIndex : Math.min(exactIndex, conjunctionIndex);
    if (index >= 0) matches.set(recipe.recipe_id, { recipe, nameLength: prefix.length, index });
  }
  for (const [alias, recipeId] of Object.entries(COMMON_RECIPE_ALIASES)) {
    const normalizedAlias = normalizedLookupText(alias);
    const exactIndex = normalizedQuery.indexOf(` ${normalizedAlias} `);
    const conjunctionIndex = normalizedQuery.indexOf(` و${normalizedAlias} `);
    const index = exactIndex < 0 ? conjunctionIndex : conjunctionIndex < 0 ? exactIndex : Math.min(exactIndex, conjunctionIndex);
    if (index < 0) continue;
    if ([...matches.values()].some((match) => match.index === index && match.nameLength > normalizedAlias.length)) continue;
    const recipe = dataset.recipes.find((candidate) => candidate.recipe_id === recipeId);
    if (recipe && !matches.has(recipeId)) matches.set(recipeId, { recipe, nameLength: normalizedAlias.length, index });
  }
  const values = [...matches.values()];
  return values
    .filter((candidate) => !values.some((other) => other.index === candidate.index && other.nameLength > candidate.nameLength))
    .sort((a, b) => a.index - b.index || b.nameLength - a.nameLength)
    .map(({ recipe }) => recipe);
}

function classifyGraduationIntent(query: string, namedRecipes: readonly UnifiedDemoRecipe[]): GraduationIntent {
  const text = normalizeNumberDigits(query);
  if (/(?:طوارئ|نزيف|إغماء|أغمي|اغمي|مش\s*بيتنفس|لا\s*يتنفس|اختناق|جرعة زائدة|suicid|emergency|overdose|diagnos|شخّص|شخص(?:\s*لي|لي)|تشخيص|دواء|علاج|مريض|حامل|سكري|ضغط|allergic|وزني.{0,20}طولي|عايز\s*اخس|اعمل\s+لي\s+نظام|نظام\s+غذائي\s+ليا|رجيم\s*قاسي)/iu.test(text)) return "medical_safety";
  const explicitComparison = /(?:قارن|مقارنة|compare|versus|\bvs\b)/iu.test(text);
  const comparativeQuestion = /(?:ولا|أيهما|ايهما|مين\s+(?:أقل|اقل|اكتر|أكثر)|أقل من|اكتر من|أكثر من)/iu.test(text)
    && /(?:سعر|بروتين|كربوهيدرات|دهون|ألياف|الياف|سكر|صوديوم|ملح|calorie|protein|carb|fat|fiber|sugar|sodium)/iu.test(text);
  if (explicitComparison || comparativeQuestion) return "compare_recipes";
  const explicitModification = /(?:بدون|من\s*غير|نسخة\s+(?:أخف|اخف|دايت)|(?:أ|ا)?قلل|خفض|تقليل|خفف|تعديل|بديل\s+(?:أخف|اخف)|lighter\s+(?:version|alternative)|reduce.{0,20}(?:calorie|fat|oil))/iu.test(text);
  if (namedRecipes.length > 0 && /(?:هل|is).{0,30}(?:صحي|صحيه|healthy)|(?:صحي|صحيه).{0,20}(?:ولا|ام)/iu.test(text)) return "general_guideline";
  if (namedRecipes.length > 0 && /(?:طريقة\s+عمل|مكونات|عايز\s+وصفه|اريد\s+وصفه|how.{0,20}\bmake|ingredients)/iu.test(text)) return "find_recipe";
  const namedNutritionRequest = /(?:سعر|كالوري|طاقة|بروتين|كربوهيدرات|كارب|ماكروز|دهون|ألياف|الياف|سكر|صوديوم|ملح|قيمه\s+غذائيه|nutrition|macro|calorie|kcal|protein|carb|fat|fiber|sugar|sodium)/iu.test(text);
  const startsWithNutritionRequest = /^(?:السعرات|سعرات|القيمه\s+الغذائيه|قيمه\s+غذائيه|البروتين|الصوديوم|الدهون|nutrition|calories?)/iu.test(text);
  if (namedRecipes.length > 0 && namedNutritionRequest && (!explicitModification || startsWithNutritionRequest)) return "recipe_nutrition";
  const namedDietRequest = namedRecipes.length > 0 && /(?:دايت|خفيف|صحي|أخف|اخف|قليل(?:ة)?\s+(?:السعرات|الدهون)|lower[ -]?calorie|healthier)/iu.test(text);
  if (explicitModification || namedDietRequest) return "lighter_modification";
  if (/(?:مش\s*معايا|مش\s*لاقي|معايا.{0,40}(?:ينفع|مش)|بديل|استبدل|استبدال|ينفع.{0,24}(?:بدل|مكان)|أستخدم.{0,24}بدل|substitute|replacement|swap)/iu.test(text)) return "unsupported";
  if (/(?:أصل(?:ه|ها)?|أصله|اصلها|جات\s*لمصر|من\s*أيام|من\s*قد\s*إيه|بقاله|فرعوني|مستوردة|الخديوي|قبل\s*الإسلام|مين\s+(?:اخترع|عمل)|ليه\s+(?:اسمها|اتسمت)|فرق(?:ه|ها)?\s+عن|histor(?:y|ical)|origin of|who invented)/iu.test(text)) return "unsupported";
  if (/(?:أنا|انا|وأنا|وانا|هل|ممكن|ينفع|وصفات|أكلات|اكلات|for\s+(?:a\s+)?|i\s+am|i'm|suitable).{0,24}(?:نباتي|فيجن|كيتو|جلوتين|صيامي|vegetarian|vegan|keto|gluten[ -]?free)|(?:أنا\s*صايم|صيام)/iu.test(text)) return "unsupported";
  if (/(?:إزاي\s*أخلي|ازاي\s*اخلي|عشان.{0,30}(?:ما|مي)|بيستوي.{0,20}قد\s*إيه|درجة\s*حرارة|من\s*غير\s*ما|بيتخمر.{0,20}قد\s*إيه|بتتقلب\s*إزاي)/iu.test(text)) return "unsupported";
  if (/(?:هرم غذائي|الهرم الغذائي|منظمة الصحة|إرشاد|ارشاد|توصيات|الحد اليومي|دهون مشبعه|مضر|مضره|guideline|food pyramid|\bWHO\b)/iu.test(text)) return "general_guideline";
  const nutrientTerms = /(?:سعر|كالوري|طاقة|بروتين|كربوهيدرات|كارب|ماكروز|دهون|ألياف|الياف|سكر|صوديوم|ملح|غذائي|nutrition|macro|calorie|kcal|protein|carb|fat|fiber|sugar|sodium)/iu;
  if (namedRecipes.length > 0 && nutrientTerms.test(text)) return "recipe_nutrition";
  if (namedRecipes.length === 0 && nutrientTerms.test(text) && /(?:رشح|اقترح|وجبة|أكلة|اكلة|ناقصني|عالي|عالية|غني|غنية|قليل|قليلة|high|rich|low|recommend|suggest)/iu.test(text)) return "find_recipe";
  if (/\d\s*(?:g|gr|gram|grams|جرام|جرامات|جم)(?![\p{L}\p{N}])/iu.test(text) || (namedRecipes.length === 0 && (asksForIngredientCalories(text) || (nutrientTerms.test(text) && /(?:\sفي\s|per\s+100|لكل\s+100)/iu.test(text))))) return "ingredient_nutrition";
  if (namedRecipes.length === 0 && nutrientTerms.test(text) && /(?:يومي|مسموح|الحد|توصي|اضرار|أضرار|فوائد|فوايد|عام|guideline|recommend)/iu.test(text)) return "general_guideline";
  if (namedRecipes.length > 0 || mealCategory(text) || /(?:وصفة|طريقة عمل|أعمل|اعمل|مكونات|اقترح|رشح|وجبة|أكلة|اكلة|ناقصني|عندي|معايا|متوفر|عالية|عالي|غنية|غني|قليلة السعرات|recipe|how.{0,20}\bmake|meal|high protein|low calorie|i have|using)/iu.test(text)) return "find_recipe";
  if (asksForAdvice(text) || /(?:صحي عامة|نصائح غذائية|healthy eating)/iu.test(text)) return "general_guideline";
  return "unsupported";
}

function normalizedTokens(value: string): string[] {
  const normalized = value.normalize("NFKD").toLocaleLowerCase("ar-EG").replace(/[\u064B-\u065F\u0670]/gu, "").replace(/[^\p{L}\p{N}\n]+/gu, " ");
  const baseTokens = normalized.split(/\s+/u).filter(Boolean);
  const tokens = baseTokens.map((token) => /^ال[\p{L}]{3,}$/u.test(token) ? token.slice(2) : token);
  const grams = tokens.flatMap((token) => token.length < 3 ? [] : Array.from({ length: token.length - 2 }, (_, index) => `#${token.slice(index, index + 3)}`));
  return [...tokens, ...grams];
}

function hash(value: string): number {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

/** Local deterministic retrieval for the graduation demo; never selected as a production embedding model. */
export class GraduationDemoEmbeddingProvider implements EmbeddingProvider {
  public readonly modelId = "LOCAL-HASHED-NGRAM-GRADUATION-DEMO";

  public async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = Array<number>(DIMENSIONS).fill(0);
      const [title = "", ...rest] = text.split("\n");
      let tokenCount = 0;
      const add = (token: string, weight: number) => { vector[hash(token) % DIMENSIONS] = (vector[hash(token) % DIMENSIONS] ?? 0) + weight; };
      for (const token of normalizedTokens(title)) { add(token, 20); tokenCount += 1; }
      for (const token of normalizedTokens(rest.join(" "))) { add(token, token.startsWith("#") ? 0.35 : 1); tokenCount += 1; }
      if (tokenCount === 0) vector[0] = 0.0001;
      return vector;
    });
  }
}

class GraduationDemoAgent {
  public constructor(
    private readonly base: NutriGuardExpandedAgent,
    private readonly tools: NutriGuardToolset,
    private readonly dataset: UnifiedEgyptianDemoDataset,
    private readonly backend: GraduationBackendDataSource | null,
  ) {}

  public async invoke(input: { message: string; language?: "ar-EG" | "ar" | "en"; context?: GraduationConversationContext }): Promise<ExpandedAgentResponse> {
    const result = await this.base.invoke(input);
    if (result.safetyFlags.length > 0 || result.integrityFlags.length > 0) return result;
    if (result.status === "emergency" || result.status === "refused") return result;
    const query = input.message.trim();
    const language = answerLanguage(query, input.language);
    const namedRecipes = explicitlyNamedRecipes(this.dataset, query);
    const referencedId = input.context?.lastIntent === "recipe_reference" ? input.context.recipeId
      : input.context?.lastIntent === "lighter_modification" ? input.context.recipeId
        : input.context?.lastIntent === "meal_calorie_target" ? input.context.recipeId ?? null : null;
    const referencedRecipe = referencedId ? this.dataset.recipes.find((recipe) => recipe.recipe_id === referencedId) : undefined;
    const usesImplicitReference = /(?:هي|دي|ده|ها\b|قارنها|خففها|قللها|زودها|الوصفه اللي فاتت|الاكله اللي فاتت|it|that recipe|same recipe)/iu.test(query);
    if (referencedRecipe && usesImplicitReference && !namedRecipes.some((recipe) => recipe.recipe_id === referencedRecipe.recipe_id)) namedRecipes.unshift(referencedRecipe);
    const contextualCalorieFollowup = input.context?.lastIntent === "meal_calorie_target"
      && /^(?:لا\s*)?(?:عاوز|عايز|محتاج)?\s*(?:وجبة\s*)?(?:أقل|اقل|أكتر|اكتر|أكثر|more|less|lower|higher)/iu.test(query);
    const contextualLighterFollowup = input.context?.lastIntent === "lighter_modification"
      && /(?:أقلل|اقلل|قلل|أقل|اقل|أكتر|اكتر|أكثر|تاني|تانب|more|again|further|lower)/iu.test(query);
    const contextualMealPlanFollowup = input.context?.lastIntent === "meal_plan"
      && /(?:قلل|خفض|زود|ارفع|غير|بدل|اقل|اكتر|reduce|increase|change)/iu.test(query);
    const deterministicIntent = contextualCalorieFollowup || contextualMealPlanFollowup ? "find_recipe" : contextualLighterFollowup ? "lighter_modification" : classifyGraduationIntent(query, namedRecipes);

    if (/(?:احتياجي اليومي|احتياج(?:ي)?.{0,20}سعر|daily calorie needs|\bTDEE\b|\bBMR\b)/iu.test(query)) {
      return this.personalCalorieRequirementUnsupported(language);
    }

    // The graduation UI exposes one answer, not raw retrieval candidates. Safety and
    // integrity always keep the authority of the production agent above this router.
    if (deterministicIntent === "medical_safety") return this.medicalSafetyFallback(query, language, result);
    const directMealPlan = this.recommendMealPlan(query, language, input.context);
    if (directMealPlan) return directMealPlan;
    if (mealCategory(query) || input.context?.lastIntent === "meal_calorie_target") {
      const directCalorieTarget = this.recommendToCalorieTarget(query, language, input.context);
      if (directCalorieTarget) return directCalorieTarget;
    }
    if (deterministicIntent === "compare_recipes") {
      if (namedRecipes.length < 2) return this.comparisonClarification(namedRecipes, language);
      return this.compareRecipes(namedRecipes[0]!, namedRecipes[1]!, query, language);
    }
    if (deterministicIntent === "lighter_modification") {
      const contextCandidate = input.context?.lastIntent === "lighter_modification" ? input.context : undefined;
      const contextualRecipe = contextCandidate
        ? this.dataset.recipes.find((candidate) => candidate.recipe_id === contextCandidate.recipeId)
        : undefined;
      const recipe = namedRecipes[0] ?? explicitlyNamedRecipe(this.dataset, query) ?? contextualRecipe;
      const lighterContext = contextCandidate?.recipeId === recipe?.recipe_id ? contextCandidate : undefined;
      return recipe ? this.lighterModification(recipe, query, language, lighterContext) : this.recipeClarification("lighter_modification", language);
    }
    if (deterministicIntent === "recipe_nutrition") return this.recipeNutrition(namedRecipes[0]!, query, language);
    if (deterministicIntent === "ingredient_nutrition") return this.ingredientCalories(query, language);
    if (deterministicIntent === "general_guideline") {
      if (namedRecipes[0] && /(?:صحي|صحيه|healthy)/iu.test(query)) return this.recipeHealthSummary(namedRecipes[0], language);
      return this.guidelineAnswer(query, language);
    }
    if (deterministicIntent === "find_recipe") {
      const recipe = namedRecipes[0];
      if (recipe) return this.recipeDetails(recipe, language, [{ documentId: `DEMO-${recipe.recipe_id}`, title: language === "en" ? recipe.name_en : recipe.name_ar, text: recipe.method_summary, score: 1 }], [this.recipeProvenance(recipe, language)]);
      const calorieTargetRecommendation = this.recommendToCalorieTarget(query, language, input.context);
      if (calorieTargetRecommendation) return calorieTargetRecommendation;
      const deterministicCategory = mealCategory(query);
      if (deterministicCategory) return this.recommendMeal(deterministicCategory, language);
      const nutritionRecommendation = this.recommendByNutrition(query, language);
      if (nutritionRecommendation) return nutritionRecommendation;
      const pantryRecommendation = this.recommendFromIngredients(query, language);
      if (pantryRecommendation) return pantryRecommendation;
      const backendRecipe = await this.backendRecipeDetails(query, language);
      if (backendRecipe) return { ...backendRecipe, data: { ...(backendRecipe.data ?? {}), intent: "find_recipe" } };
      return this.recipeNotFound(language);
    }
    return this.unsupported(language);

  }

  private medicalSafetyFallback(query: string, language: "ar-EG" | "ar" | "en", base: ExpandedAgentResponse): ExpandedAgentResponse {
    if (base.status === "emergency" || base.status === "refused" || base.safetyFlags.length > 0) return base;
    const emergency = /(?:مش\s*بيتنفس|لا\s*يتنفس|أغمي|اغمي|فاقد\s*الوعي|نزيف\s*شديد|اختناق|جرعة\s*زائدة|emergency|not breathing|unconscious|overdose)/iu.test(query);
    if (emergency) {
      return {
        status: "emergency", primaryIntent: "medical_safety_request", language, safetyFlags: ["emergency"], integrityFlags: [],
        message: language === "en" ? "This may be an emergency. Call the local emergency service now and follow the dispatcher's instructions. Do not wait for an AI response or give food or drink to an unconscious person." : "ده ممكن يكون طارئًا. اتصل بالإسعاف فورًا واتبع تعليمات مسؤول الطوارئ. ما تستناش رد من الذكاء الاصطناعي، وما تديش أكل أو شرب لشخص فاقد الوعي.",
        data: { intent: "medical_safety" }, evidenceDocumentIds: [], provenance: [], toolTrace: [], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    return {
      status: "refused", primaryIntent: "medical_safety_request", language, safetyFlags: ["medical_advice_request"], integrityFlags: [],
      message: language === "en" ? "I cannot diagnose a condition or prescribe medication. A qualified clinician or pharmacist should assess the person. I can still provide non-personalized general nutrition information." : "ما ينفعش أشخّص حالة أو أوصف دواء. لازم طبيب أو صيدلي مؤهل يقيّم الحالة. أقدر فقط أقدّم معلومات غذائية عامة غير مخصصة.",
      data: { intent: "medical_safety" }, evidenceDocumentIds: [], provenance: [], toolTrace: [], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private comparisonClarification(recipes: readonly UnifiedDemoRecipe[], language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse {
    const recognized = recipes.map((recipe) => language === "en" ? recipe.name_en : recipe.name_ar);
    return {
      status: "clarification", primaryIntent: "compare_recipes", language, safetyFlags: [], integrityFlags: [],
      message: language === "en"
        ? `Name two different Egyptian recipes and the nutrient to compare, for example: “Which is lower in sodium, Ful Medames or Koshary?”${recognized.length ? ` I recognized only: ${recognized.join(", ")}.` : ""}`
        : `اكتب اسم وصفتين مصريتين مختلفتين والعنصر المطلوب مقارنته، مثل: «الفول ولا الكشري أقل صوديوم؟»${recognized.length ? ` تعرّفت فقط على: ${recognized.join("، ")}.` : ""}`,
      data: { intent: "compare_recipes", requiredInput: "two_distinct_recipe_names", recognizedRecipes: recognized }, evidenceDocumentIds: [], provenance: [], toolTrace: [], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private recommendMealPlan(query: string, language: "ar-EG" | "ar" | "en", context?: GraduationConversationContext): ExpandedAgentResponse | null {
    const normalized = normalizeNumberDigits(query);
    const previous = context?.lastIntent === "meal_plan" ? context : undefined;
    const isPlanRequest = /(?:وجبات (?:اليوم|يوم|طول اليوم)|طول اليوم|خطة وجبات|نظام يوم|meal plan|meals for the day)/iu.test(normalized);
    const isPlanFollowup = Boolean(previous && /(?:قلل|خفض|زود|ارفع|غير|بدل|اقل|اكتر|reduce|increase|change)/iu.test(normalized));
    if (!isPlanRequest && !isPlanFollowup) return null;
    const explicit = normalized.match(/(\d+(?:\.\d+)?)\s*(?:سعر(?:ة|ات)?(?:\s*حراري(?:ة|ه)?)?|كالوري|kcal|calories?)/iu);
    const amount = explicit ? Number(explicit[1]) : null;
    let target = isPlanRequest ? amount : previous?.calorieTargetKcal;
    if (isPlanFollowup && previous) {
      const delta = amount ?? 200;
      target = /(?:زود|ارفع|اكتر|increase)/iu.test(normalized) ? previous.calorieTargetKcal + delta : previous.calorieTargetKcal - delta;
    }
    if (target === null || target === undefined || !Number.isFinite(target) || target < 600 || target > 5_000) {
      return {
        status: "clarification", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en" ? "Give me a daily calorie target between 600 and 5000 kcal so I can build a deterministic three-meal example." : "اكتب هدف سعرات يومي بين 600 و5000 سعر حراري علشان أجهز مثالًا محسوبًا من 3 وجبات.",
        data: { intent: "meal_plan", requiredInput: "daily_calorie_target" }, evidenceDocumentIds: [], provenance: [], toolTrace: [], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const exclusions = new Set([...previous?.excludedIngredientKeys ?? [], ...excludedIngredientKeys(query)]);
    const used = new Set<string>();
    const choose = (categories: ReadonlySet<string>, desired: number) => this.dataset.recipes
      .filter((recipe) => categories.has(recipe.category) && !used.has(recipe.recipe_id) && !recipeContainsExcludedIngredient(recipe, exclusions))
      .map((recipe) => ({ recipe, nutrition: calculateUnifiedDemoNutrition(this.dataset, recipe).perServing }))
      .filter((entry): entry is typeof entry & { nutrition: typeof entry.nutrition & { kcal: number } } => entry.nutrition.kcal !== null)
      .sort((a, b) => Math.abs(a.nutrition.kcal - desired) - Math.abs(b.nutrition.kcal - desired) || a.recipe.recipe_id.localeCompare(b.recipe.recipe_id))[0];
    const requestedSlots = [
      { key: "breakfast", share: 0.25, categories: new Set(["breakfast"]) },
      { key: "lunch", share: 0.4, categories: new Set(["main_dish"]) },
      { key: "dinner", share: 0.35, categories: new Set(["main_dish", "soup"]) },
    ] as const;
    const meals = requestedSlots.flatMap((slot) => {
      const selected = choose(slot.categories, target * slot.share);
      if (!selected) return [];
      used.add(selected.recipe.recipe_id);
      return [{ slot: slot.key, recipe: selected.recipe, nutrition: selected.nutrition }];
    });
    if (meals.length !== requestedSlots.length) {
      return {
        status: "no_result", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en" ? "The current recorded recipes cannot satisfy all three meal slots with those exclusions. I will not silently ignore a rule." : "الوصفات المسجلة حاليًا لا تكفي لتجهيز 3 وجبات مع كل الاستبعادات دي. مش هاتجاهل أي شرط من غير ما أوضح.",
        data: { intent: "meal_plan", reasonCode: "rules_cannot_be_satisfied", targetCaloriesKcal: target, excludedIngredientKeys: [...exclusions], rulesUnmet: ["three_distinct_meals"] }, evidenceDocumentIds: [], provenance: [], toolTrace: [{ tool: "calculate_nutrition", ok: false, code: "rules_cannot_be_satisfied" }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const total = Math.round(meals.reduce((sum, meal) => sum + meal.nutrition.kcal, 0) * 10) / 10;
    const difference = Math.round((total - target) * 10) / 10;
    const labels = language === "en" ? { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" } : { breakfast: "الإفطار", lunch: "الغداء", dinner: "العشاء" };
    const lines = meals.map((meal) => `• ${labels[meal.slot]}: ${language === "en" ? meal.recipe.name_en : meal.recipe.name_ar} — ${meal.nutrition.kcal} ${language === "en" ? "kcal" : "سعر حراري"}`);
    const exclusionNote = exclusions.size === 0 ? "" : language === "en"
      ? "\n\nI excluded recipes whose recorded ingredients match your exclusions. This is not an allergy or cross-contamination guarantee."
      : "\n\nاستبعدت الوصفات التي تحتوي مكوناتها المسجلة على العناصر المطلوبة. ده مش ضمان خلو من مسببات الحساسية أو التلوث التبادلي.";
    const conversationContext: MealPlanConversationContext = { schemaVersion: "1.0", lastIntent: "meal_plan", calorieTargetKcal: target, excludedIngredientKeys: [...exclusions], recipeIds: meals.map((meal) => meal.recipe.recipe_id) };
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en" ? `Three-meal example for a ${target} kcal daily target:\n\n${lines.join("\n")}\n\nCalculated total: ${total} kcal (${difference >= 0 ? "+" : ""}${difference} from target).${exclusionNote}\n\nThis is a general dataset-based example, not a personal prescription.` : `مثال 3 وجبات لهدف يومي ${target} سعر حراري:\n\n${lines.join("\n")}\n\nالإجمالي المحسوب: ${total} سعر حراري (${difference >= 0 ? "+" : ""}${difference} عن الهدف).${exclusionNote}\n\nده مثال عام مبني على بيانات المشروع، مش وصفة علاجية أو نظام شخصي.`,
      data: { intent: "meal_plan", recommendationType: "daily_calorie_plan", targetCaloriesKcal: target, totalCaloriesKcal: total, differenceCaloriesKcal: difference, excludedIngredientKeys: [...exclusions], meals: meals.map((meal) => ({ slot: meal.slot, recipeId: meal.recipe.recipe_id, name: language === "en" ? meal.recipe.name_en : meal.recipe.name_ar, perServing: meal.nutrition })), conversationContext },
      evidenceDocumentIds: meals.map((meal) => `DEMO-${meal.recipe.recipe_id}`), provenance: meals.map((meal) => this.recipeProvenance(meal.recipe, language)), toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private recommendToCalorieTarget(query: string, language: "ar-EG" | "ar" | "en", context?: GraduationConversationContext): ExpandedAgentResponse | null {
    const normalized = normalizeNumberDigits(query);
    const calorieContext = context?.lastIntent === "meal_calorie_target" ? context : undefined;
    const explicit = normalized.match(/(\d+(?:\.\d+)?)\s*(?:سعر(?:ة|ات)?(?:\s*حراري(?:ة|ه)?)?|كالوري|kcal|calories?)/iu);
    const lowerFollowup = /(?:أقل|اقل|تحت|less|lower|under)/iu.test(normalized);
    const higherFollowup = /(?:أكتر|اكتر|أكثر|اعلى|أعلى|more|higher|over)/iu.test(normalized);
    if (!explicit && !calorieContext) return null;
    if (!explicit && !lowerFollowup && !higherFollowup) return null;
    const explicitTarget = explicit ? Number(explicit[1]) : null;
    const target = explicitTarget ?? calorieContext?.lastRecommendationCaloriesKcal ?? calorieContext?.calorieTargetKcal;
    if (target === undefined || !Number.isFinite(target) || target < 50 || target > 5_000) return null;
    const relation: "closest" | "below" | "above" = lowerFollowup ? "below" : higherFollowup ? "above" : "closest";
    // A relative follow-up such as "عاوز أقل" should produce a meaningful step,
    // not a technically lower result that differs by only a fraction of a kcal.
    const desiredTarget = explicitTarget !== null
      ? target
      : relation === "below"
        ? Math.max(50, target - 50)
        : relation === "above"
          ? Math.min(5_000, target + 50)
          : target;
    const category = mealCategory(query) ?? calorieContext?.category ?? null;
    const exclusions = new Set([...calorieContext?.excludedIngredientKeys ?? [], ...excludedIngredientKeys(query)]);
    const mealCategories = new Set(["main_dish", "breakfast", "soup"]);
    const candidates = this.dataset.recipes
      .filter((recipe) => category ? recipe.category === category : mealCategories.has(recipe.category))
      .filter((recipe) => !recipeContainsExcludedIngredient(recipe, exclusions))
      .map((recipe) => ({ recipe, nutrition: calculateUnifiedDemoNutrition(this.dataset, recipe).perServing }))
      .filter((entry): entry is typeof entry & { nutrition: typeof entry.nutrition & { kcal: number } } => entry.nutrition.kcal !== null)
      .filter((entry) => relation === "below" ? entry.nutrition.kcal < target : relation === "above" ? entry.nutrition.kcal > target : true)
      .sort((a, b) => {
        const firstDistance = Math.abs(a.nutrition.kcal - desiredTarget);
        const secondDistance = Math.abs(b.nutrition.kcal - desiredTarget);
        return firstDistance - secondDistance || a.recipe.recipe_id.localeCompare(b.recipe.recipe_id);
      });
    const selected = candidates[0];
    if (!selected) {
      return {
        status: "no_result", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en" ? `I could not find a recorded meal ${relation === "below" ? "below" : relation === "above" ? "above" : "close to"} ${target} kcal per serving in the current dataset.` : `ملقتش وجبة مسجلة ${relation === "below" ? "أقل من" : relation === "above" ? "أعلى من" : "قريبة من"} ${target} سعر حراري للحصة في البيانات الحالية.`,
        data: { intent: "find_recipe", recommendationType: "calorie_target", targetCaloriesKcal: target, relation }, evidenceDocumentIds: [], provenance: [], toolTrace: [{ tool: "calculate_nutrition", ok: false, code: "no_matching_meal" }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const name = language === "en" ? selected.recipe.name_en : selected.recipe.name_ar;
    const calories = selected.nutrition.kcal;
    const difference = Math.round(Math.abs(calories - target) * 10) / 10;
    const relationText = language === "en" ? relation === "below" ? `the closest meal below ${target}` : relation === "above" ? `the closest meal above ${target}` : `the closest meal to ${target}`
      : relation === "below" ? `أقرب وجبة أقل من ${target}` : relation === "above" ? `أقرب وجبة أعلى من ${target}` : `أقرب وجبة لهدف ${target}`;
    const conversationContext: GraduationConversationContext = { schemaVersion: "1.0", lastIntent: "meal_calorie_target", calorieTargetKcal: target, category, relation, lastRecommendationCaloriesKcal: calories, excludedIngredientKeys: [...exclusions], recipeId: selected.recipe.recipe_id };
    const exclusionNote = exclusions.size === 0 ? "" : language === "en"
      ? " The recorded ingredients matching your exclusions were filtered out; this is not an allergy or cross-contamination guarantee."
      : " تم استبعاد الوصفات التي تحتوي مكوناتها المسجلة على العناصر المطلوبة، لكن ده مش ضمان حساسية أو خلو من التلوث التبادلي.";
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en" ? `${relationText} kcal per serving is ${name}: about ${calories} kcal, ${selected.nutrition.protein ?? "unknown"} g protein, ${selected.nutrition.carbs ?? "unknown"} g carbohydrates, and ${selected.nutrition.fat ?? "unknown"} g fat. Difference from the target: ${difference} kcal. Ask for the recipe name to see ingredients and preparation.${exclusionNote}` : `${relationText} سعر حراري للحصة هي ${name}: حوالي ${calories} سعر حراري، ${selected.nutrition.protein ?? "غير متوفر"} جم بروتين، ${selected.nutrition.carbs ?? "غير متوفر"} جم كربوهيدرات، و${selected.nutrition.fat ?? "غير متوفر"} جم دهون. الفرق عن الهدف ${difference} سعر حراري. اطلب اسم الوصفة لعرض المكونات والطريقة.${exclusionNote}`,
      data: { intent: "find_recipe", recommendationType: "calorie_target", targetCaloriesKcal: target, relation, differenceCaloriesKcal: difference, excludedIngredientKeys: [...exclusions], recipeId: selected.recipe.recipe_id, recipeName: name, caloriesPerServingKcal: calories, perServing: selected.nutrition, conversationContext },
      evidenceDocumentIds: [`DEMO-${selected.recipe.recipe_id}`], provenance: [this.recipeProvenance(selected.recipe, language)], toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private recommendByNutrition(query: string, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse | null {
    if (!/(?:رشح|اقترح|وجبة|أكلة|اكلة|ناقصني|عالي|عالية|غني|غنية|قليل|قليلة|high|rich|low|recommend|suggest)/iu.test(query)) return null;
    const target = /(?:بروتين|protein)/iu.test(query) ? "protein"
      : /(?:ألياف|الياف|fiber)/iu.test(query) ? "fiber"
      : /(?:صوديوم|ملح|sodium|salt)/iu.test(query) ? "sodium"
      : /(?:سعر|كالوري|calorie|kcal)/iu.test(query) ? "kcal" : null;
    if (!target) return null;
    const wantsLow = /(?:قليل|قليلة|أقل|اقل|منخفض|low|lower)/iu.test(query) || target === "kcal";
    const candidates = this.dataset.recipes
      .filter((recipe) => target === "kcal" ? new Set(["main_dish", "breakfast", "soup"]).has(recipe.category) : recipe.category !== "beverage")
      .map((recipe) => ({ recipe, nutrition: calculateUnifiedDemoNutrition(this.dataset, recipe).perServing }))
      .filter((entry) => entry.nutrition[target] !== null)
      .sort((a, b) => {
        const first = a.nutrition[target] ?? 0;
        const second = b.nutrition[target] ?? 0;
        return (wantsLow ? first - second : second - first) || a.recipe.recipe_id.localeCompare(b.recipe.recipe_id);
      });
    const selected = candidates[0];
    if (!selected) return null;
    const name = language === "en" ? selected.recipe.name_en : selected.recipe.name_ar;
    const units = target === "sodium" ? (language === "en" ? "mg" : "مجم") : target === "kcal" ? (language === "en" ? "kcal" : "سعر حراري") : language === "en" ? "g" : "جم";
    const labels = language === "en"
      ? { protein: "protein", fiber: "fiber", sodium: "sodium", kcal: "calories" }
      : { protein: "البروتين", fiber: "الألياف", sodium: "الصوديوم", kcal: "السعرات" };
    const value = selected.nutrition[target];
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en" ? `${name} is the strongest matching option in the current project dataset for ${wantsLow ? "lower" : "higher"} ${labels[target]}: about ${value} ${units} per serving. Ask for its recipe if you want the ingredients and method. This is a dataset-based suggestion, not a personalized diet.` : `${name} هو الاختيار الأقرب في بيانات المشروع لطلب ${wantsLow ? "الأقل" : "الأعلى"} في ${labels[target]}: حوالي ${value} ${units} للحصة. اطلب اسم الوصفة لو عايز المكونات والطريقة. ده اقتراح من البيانات، مش نظام غذائي شخصي.`,
      data: { intent: "find_recipe", recommendationType: "nutrition_ranked", targetNutrient: target, direction: wantsLow ? "lower" : "higher", recipeId: selected.recipe.recipe_id, recipeName: name, perServing: selected.nutrition },
      evidenceDocumentIds: [`DEMO-${selected.recipe.recipe_id}`], provenance: [this.recipeProvenance(selected.recipe, language)], toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private recommendFromIngredients(query: string, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse | null {
    if (!/(?:عندي|معايا|متوفر|المكونات دي|ingredients i have|i have|using|with)/iu.test(query)) return null;
    const normalized = normalizedLookupText(query);
    const requestedKeys = new Set(INGREDIENT_ALIASES.filter((entry) => entry.aliases.some((alias) => normalized.includes(normalizedLookupText(alias)))).map((entry) => entry.key));
    if (requestedKeys.size === 0) return null;
    const candidates = this.dataset.recipes.map((recipe) => {
      const recipeKeys = new Set(recipe.ingredients.map((ingredient) => ingredient.ingredient));
      const matched = [...requestedKeys].filter((key) => recipeKeys.has(key));
      return { recipe, matched };
    }).filter((entry) => entry.matched.length > 0).sort((a, b) => b.matched.length - a.matched.length || a.recipe.recipe_id.localeCompare(b.recipe.recipe_id));
    const selected = candidates[0];
    if (!selected) return null;
    const name = language === "en" ? selected.recipe.name_en : selected.recipe.name_ar;
    const matchedLabels = selected.matched.map((key) => ingredientLabel(key, language));
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en" ? `${name} is the closest Egyptian recipe in the project data to the ingredients you listed (${matchedLabels.join(", ")}). Ask for ${name} to see the recorded ingredients and method; you may still need additional ingredients.` : `${name} هي أقرب وصفة مصرية في بيانات المشروع للمكونات اللي ذكرتها (${matchedLabels.join("، ")}). اطلب ${name} لعرض المكونات والطريقة المسجلة؛ وقد تحتاج مكونات إضافية.`,
      data: { intent: "find_recipe", recommendationType: "ingredient_overlap", recipeId: selected.recipe.recipe_id, recipeName: name, matchedIngredients: selected.matched }, evidenceDocumentIds: [`DEMO-${selected.recipe.recipe_id}`], provenance: [this.recipeProvenance(selected.recipe, language)], toolTrace: [{ tool: "search_recipes", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private recipeNotFound(language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse {
    return {
      status: "no_result", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en" ? "I could not find a sufficiently matching Egyptian recipe in the current project dataset. Write the exact Egyptian dish name; I will not substitute an unrelated recipe." : "ملقتش وصفة مصرية مطابقة بدرجة كافية في بيانات المشروع الحالية. اكتب اسم الطبق المصري بدقة؛ مش هبدّل طلبك بوصفة غير مرتبطة.",
      data: { intent: "find_recipe", reason: "no_sufficiently_matching_recipe", reasonCode: "recipe_not_in_verified_dataset" }, evidenceDocumentIds: [], provenance: [], toolTrace: [{ tool: "search_recipes", ok: true, code: "no_result" }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private recipeProvenance(recipe: UnifiedDemoRecipe, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse["provenance"][number] {
    return {
      sourceId: "DEMO-UNIFIED-EGYPTIAN-DATASET",
      versionId: "2.0-final-demo-normalized",
      title: language === "en" ? recipe.name_en : recipe.name_ar,
      url: recipe.source_url,
      accessedAt: this.dataset.metadata.created_date,
      locator: recipe.recipe_id,
    };
  }

  private recipeNutrition(recipe: UnifiedDemoRecipe, query: string, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse {
    const calculation = calculateUnifiedDemoNutrition(this.dataset, recipe);
    const name = language === "en" ? recipe.name_en : recipe.name_ar;
    const value = (amount: number | null, unit: string) => amount === null ? (language === "en" ? "unknown" : "غير متوفر") : `${amount} ${unit}`;
    const line = (label: string, nutrition: typeof calculation.totals) => language === "en"
      ? `${label}: ${value(nutrition.kcal, "kcal")}; protein ${value(nutrition.protein, "g")}; carbs ${value(nutrition.carbs, "g")}; total fat ${value(nutrition.fat, "g")}; fiber ${value(nutrition.fiber, "g")}; sugar ${value(nutrition.sugar, "g")}; sodium ${value(nutrition.sodium, "mg")}.`
      : `${label}: ${value(nutrition.kcal, "سعر حراري")}؛ بروتين ${value(nutrition.protein, "جم")}؛ كربوهيدرات ${value(nutrition.carbs, "جم")}؛ دهون كلية ${value(nutrition.fat, "جم")}؛ ألياف ${value(nutrition.fiber, "جم")}؛ سكر ${value(nutrition.sugar, "جم")}؛ صوديوم ${value(nutrition.sodium, "مجم")}.`;
    const wantsFull = /(?:القيم(?:ة)?\s+الغذائية\s+الكاملة|كل\s+القيم|ماكروز|تفاصيل\s+غذائية|full\s+(?:nutrition|nutritional)|all\s+nutrients|macros?)/iu.test(query);
    const asksSaturatedFat = /(?:دهون\s+مشبعة|الدهون\s+المشبعة|saturated\s+fat)/iu.test(query);
    const requested = [
      /(?:سعر|كالوري|calorie|kcal)/iu.test(query) ? "kcal" : null,
      /(?:بروتين|protein)/iu.test(query) ? "protein" : null,
      /(?:كربوهيدرات|كارب|carb)/iu.test(query) ? "carbs" : null,
      /(?:دهون|fat)/iu.test(query) && !asksSaturatedFat ? "fat" : null,
      /(?:ألياف|الياف|fiber)/iu.test(query) ? "fiber" : null,
      /(?:سكر|sugar)/iu.test(query) ? "sugar" : null,
      /(?:صوديوم|ملح|sodium|salt)/iu.test(query) ? "sodium" : null,
    ].filter((item): item is "kcal" | "protein" | "carbs" | "fat" | "fiber" | "sugar" | "sodium" => item !== null);
    const explicitPer100g = /(?:100\s*(?:جرام|جم)|لكل\s*100|per\s*100\s*g)/iu.test(normalizeNumberDigits(query));
    const explicitFullRecipe = /(?:الوصفة\s+كاملة|كامل\s+الوصفة|full\s+recipe|whole\s+recipe)/iu.test(query);
    const basis = explicitPer100g ? "per100g" : explicitFullRecipe ? "totals" : "perServing";
    const basisLabel = language === "en" ? basis === "per100g" ? "per 100 g" : basis === "totals" ? "in the full recipe" : `per serving (${recipe.servings} servings recorded)`
      : basis === "per100g" ? "لكل 100 جرام" : basis === "totals" ? "في الوصفة كاملة" : `للحصة الواحدة (${recipe.servings} حصص مسجلة)`;
    const labels = language === "en"
      ? { kcal: ["calories", "kcal"], protein: ["protein", "g"], carbs: ["carbohydrates", "g"], fat: ["total fat", "g"], fiber: ["fiber", "g"], sugar: ["sugar", "g"], sodium: ["sodium", "mg"] } as const
      : { kcal: ["السعرات", "سعر حراري"], protein: ["البروتين", "جم"], carbs: ["الكربوهيدرات", "جم"], fat: ["الدهون الكلية", "جم"], fiber: ["الألياف", "جم"], sugar: ["السكر", "جم"], sodium: ["الصوديوم", "مجم"] } as const;
    let message: string;
    if (asksSaturatedFat) {
      message = language === "en" ? `${name}: saturated fat is not available in the current dataset; missing means unknown, not zero.` : `${name}: الدهون المشبعة غير متوفرة في البيانات الحالية؛ القيمة الناقصة معناها غير معروفة، مش صفر.`;
    } else if (!wantsFull && requested.length === 1) {
      const nutrient = requested[0]!;
      const [label, unit] = labels[nutrient];
      const amount = calculation[basis][nutrient];
      message = language === "en" ? `${name}: ${label} ${basisLabel} are ${value(amount, unit)}.` : `${name}: ${label} ${basisLabel} هي ${value(amount, unit)}.`;
      if (nutrient === "kcal" && basis === "perServing" && calculation.per100g.kcal !== null) {
        message += language === "en" ? ` For reference, it is ${calculation.per100g.kcal} kcal per 100 g.` : ` وللمقارنة: ${calculation.per100g.kcal} سعر حراري لكل 100 جرام.`;
      }
      message += language === "en" ? " Values are graduation-demo estimates." : " القيم تقديرية لعرض مشروع التخرج.";
    } else {
      message = language === "en"
        ? `${name}\n\n${line("Full recipe", calculation.totals)}\n${line(`Per serving (${recipe.servings} servings)`, calculation.perServing)}\n${line("Per 100 g", calculation.per100g)}\n\nSaturated fat is not available in the current dataset. Values are graduation-demo estimates, not medical advice.`
        : `${name}\n\n${line("الوصفة كاملة", calculation.totals)}\n${line(`القيم للحصة الواحدة (${recipe.servings} حصص)`, calculation.perServing)}\n${line("لكل 100 جرام", calculation.per100g)}\n\nالدهون المشبعة غير متوفرة في البيانات الحالية. القيم تقديرية لعرض مشروع التخرج وليست نصيحة طبية.`;
    }
    return {
      status: "ok", primaryIntent: "recipe_nutrition", language, safetyFlags: [], integrityFlags: [], message,
      data: { intent: "recipe_nutrition", demoOnly: true, reviewStatus: "needs_review", recipeId: recipe.recipe_id, recipeName: name, servings: recipe.servings, finalWeightG: calculation.finalWeightG, fullRecipe: calculation.totals, perServing: calculation.perServing, per100g: calculation.per100g, caloriesPerServingKcal: calculation.perServing.kcal, caloriesPer100gKcal: calculation.per100g.kcal, totalRecipeCaloriesKcal: calculation.totals.kcal, saturatedFat: null, conversationContext: { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: recipe.recipe_id } },
      evidenceDocumentIds: [`DEMO-${recipe.recipe_id}`], provenance: [this.recipeProvenance(recipe, language)],
      toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private compareRecipes(first: UnifiedDemoRecipe, second: UnifiedDemoRecipe, query: string, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse {
    const firstCalculation = calculateUnifiedDemoNutrition(this.dataset, first);
    const secondCalculation = calculateUnifiedDemoNutrition(this.dataset, second);
    const basis = /(?:حصة|للحصه|للحصة|per serving)/iu.test(query) ? "perServing" : "per100g";
    const hasExplicitNutrient = /(?:سعر|كالوري|صوديوم|ملح|بروتين|كربوهيدرات|كارب|دهون|ألياف|الياف|سكر|calorie|kcal|sodium|salt|protein|carb|fat|fiber|sugar)/iu.test(query);
    const firstName = language === "en" ? first.name_en : first.name_ar;
    const secondName = language === "en" ? second.name_en : second.name_ar;
    const basisLabel = basis === "perServing" ? (language === "en" ? "per serving" : "للحصة") : (language === "en" ? "per 100 g" : "لكل 100 جرام");
    if (!hasExplicitNutrient) {
      const metrics = [
        { key: "kcal", ar: "السعرات", en: "Calories", unitAr: "سعر", unitEn: "kcal" },
        { key: "protein", ar: "البروتين", en: "Protein", unitAr: "جم", unitEn: "g" },
        { key: "carbs", ar: "الكربوهيدرات", en: "Carbohydrates", unitAr: "جم", unitEn: "g" },
        { key: "fat", ar: "الدهون", en: "Total fat", unitAr: "جم", unitEn: "g" },
        { key: "fiber", ar: "الألياف", en: "Fiber", unitAr: "جم", unitEn: "g" },
        { key: "sodium", ar: "الصوديوم", en: "Sodium", unitAr: "مجم", unitEn: "mg" },
      ] as const;
      const values = Object.fromEntries(metrics.map((metric) => [metric.key, {
        first: firstCalculation[basis][metric.key], second: secondCalculation[basis][metric.key],
        unit: language === "en" ? metric.unitEn : metric.unitAr,
      }]));
      const lines = metrics.map((metric) => {
        const firstValue = firstCalculation[basis][metric.key] ?? (language === "en" ? "unknown" : "غير متوفر");
        const secondValue = secondCalculation[basis][metric.key] ?? (language === "en" ? "unknown" : "غير متوفر");
        const label = language === "en" ? metric.en : metric.ar;
        const unit = language === "en" ? metric.unitEn : metric.unitAr;
        return `• ${label}: ${firstName} ${firstValue} ${unit} — ${secondName} ${secondValue} ${unit}`;
      });
      return {
        status: "ok", primaryIntent: "compare_recipes", language, safetyFlags: [], integrityFlags: [],
        message: language === "en"
          ? `Nutritional comparison ${basisLabel}:\n\n${lines.join("\n")}\n\nThere is no single overall winner: choose the relevant metric for your goal. This is a numerical comparison, not personalized medical advice.`
          : `مقارنة غذائية ${basisLabel}:\n\n${lines.join("\n")}\n\nمفيش اختيار أفضل بشكل مطلق؛ الاختيار يعتمد على العنصر المهم لهدفك. دي مقارنة رقمية وليست نصيحة طبية شخصية.`,
        data: { intent: "compare_recipes", comparisonType: "overview", demoOnly: true, reviewStatus: "needs_review", basis: basis === "perServing" ? "per_serving" : "per_100g", first: { recipeId: first.recipe_id, name: firstName }, second: { recipeId: second.recipe_id, name: secondName }, metrics: values, conversationContext: { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: first.recipe_id } },
        evidenceDocumentIds: [`DEMO-${first.recipe_id}`, `DEMO-${second.recipe_id}`], provenance: [this.recipeProvenance(first, language), this.recipeProvenance(second, language)],
        toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const nutrient = /(?:صوديوم|ملح|sodium|salt)/iu.test(query) ? "sodium"
      : /(?:بروتين|protein)/iu.test(query) ? "protein"
      : /(?:كربوهيدرات|كارب|carb)/iu.test(query) ? "carbs"
      : /(?:دهون|fat)/iu.test(query) ? "fat"
      : /(?:ألياف|الياف|fiber)/iu.test(query) ? "fiber"
      : /(?:سكر|sugar)/iu.test(query) ? "sugar" : "kcal";
    const firstValue = firstCalculation[basis][nutrient];
    const secondValue = secondCalculation[basis][nutrient];
    const unit = nutrient === "sodium" ? (language === "en" ? "mg" : "مجم") : nutrient === "kcal" ? (language === "en" ? "kcal" : "سعر حراري") : language === "en" ? "g" : "جم";
    const label = language === "en" ? ({ sodium: "sodium", protein: "protein", carbs: "carbohydrates", fat: "total fat", fiber: "fiber", sugar: "sugar", kcal: "calories" } as const)[nutrient]
      : ({ sodium: "الصوديوم", protein: "البروتين", carbs: "الكربوهيدرات", fat: "الدهون الكلية", fiber: "الألياف", sugar: "السكر", kcal: "السعرات" } as const)[nutrient];
    let conclusion = language === "en" ? "A conclusion is unavailable because one value is missing." : "لا يمكن تحديد الأقل لأن إحدى القيم غير متوفرة.";
    if (firstValue !== null && secondValue !== null) {
      const lower = firstValue === secondValue ? null : firstValue < secondValue ? firstName : secondName;
      conclusion = lower === null ? (language === "en" ? "Both values are equal." : "القيمتان متساويتان.")
        : language === "en" ? `${lower} is lower in ${label} on this basis.` : `${lower} هو الأقل في ${label} على نفس أساس المقارنة.`;
    }
    return {
      status: "ok", primaryIntent: "compare_recipes", language, safetyFlags: [], integrityFlags: [],
      message: language === "en" ? `${label} comparison ${basisLabel}:\n\n• ${firstName}: ${firstValue ?? "unknown"} ${unit}\n• ${secondName}: ${secondValue ?? "unknown"} ${unit}\n\n${conclusion}` : `مقارنة ${label} ${basisLabel}:\n\n• ${firstName}: ${firstValue ?? "غير متوفر"} ${unit}\n• ${secondName}: ${secondValue ?? "غير متوفر"} ${unit}\n\n${conclusion}`,
      data: { intent: "compare_recipes", demoOnly: true, reviewStatus: "needs_review", basis: basis === "perServing" ? "per_serving" : "per_100g", nutrient, first: { recipeId: first.recipe_id, name: firstName, value: firstValue }, second: { recipeId: second.recipe_id, name: secondName, value: secondValue }, unit, conversationContext: { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: first.recipe_id } },
      evidenceDocumentIds: [`DEMO-${first.recipe_id}`, `DEMO-${second.recipe_id}`], provenance: [this.recipeProvenance(first, language), this.recipeProvenance(second, language)],
      toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private lighterModification(recipe: UnifiedDemoRecipe, query: string, language: "ar-EG" | "ar" | "en", context?: LighterModificationConversationContext): ExpandedAgentResponse {
    const asksForExclusion = /(?:بدون|من\s*غير|without|no\s+)/iu.test(query)
      && !/(?:نسخ(?:ه|ة)\s+(?:اخف|أخف)|(?:ا|أ)?قلل|قلل|خفف|lighter\s+(?:version|alternative))/iu.test(query);
    if (asksForExclusion) {
      const requested = new Set(excludedIngredientKeys(query));
      const genericOil = /(?:بدون|من\s*غير|without|no\s+).{0,12}(?:زيت|oil)/iu.test(query);
      const removable = recipe.ingredients
        .filter((item) => requested.has(item.ingredient) || (genericOil && /(?:oil|ghee|butter)/iu.test(item.ingredient)))
        .sort((a, b) => b.grams - a.grams)[0];
      if (!removable) {
        const name = language === "en" ? recipe.name_en : recipe.name_ar;
        return {
          status: "no_result", primaryIntent: "lighter_recipe", language, safetyFlags: [], integrityFlags: [],
          message: language === "en" ? `I found ${name}, but I could not match the excluded ingredient to an ingredient recorded in that recipe. I will not return the original recipe as if the exclusion were applied.` : `وجدت ${name}، لكن ما قدرتش أطابق المكوّن المطلوب استبعاده مع مكوّن مسجل في الوصفة. مش هاعرض الوصفة الأصلية كأن الاستبعاد اتطبق.`,
          data: { intent: "lighter_modification", reasonCode: "excluded_ingredient_not_resolved", recipeId: recipe.recipe_id }, evidenceDocumentIds: [`DEMO-${recipe.recipe_id}`], provenance: [this.recipeProvenance(recipe, language)], toolTrace: [{ tool: "calculate_nutrition", ok: false, code: "excluded_ingredient_not_resolved" }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
        };
      }
      const original = calculateUnifiedDemoNutrition(this.dataset, recipe);
      const modifiedRecipe: UnifiedDemoRecipe = {
        ...recipe,
        ingredients: recipe.ingredients.filter((item) => item !== removable),
        final_yield_weight_grams: Math.max(1, recipe.final_yield_weight_grams - removable.grams),
      };
      const modified = calculateUnifiedDemoNutrition(this.dataset, modifiedRecipe);
      const name = language === "en" ? recipe.name_en : recipe.name_ar;
      const removedName = ingredientLabel(removable.ingredient, language);
      const saved = original.perServing.kcal === null || modified.perServing.kcal === null ? null : Math.round((original.perServing.kcal - modified.perServing.kcal) * 10) / 10;
      const remaining = modifiedRecipe.ingredients.map((item) => `• ${item.quantity} ${localizedUnit(item.unit, language)} ${ingredientLabel(item.ingredient, language)}`).join("\n");
      return {
        status: "ok", primaryIntent: "lighter_recipe", language, safetyFlags: [], integrityFlags: [],
        message: language === "en" ? `${name} without ${removedName}:\n\n${remaining}\n\nEstimated serving: ${modified.perServing.kcal ?? "unknown"} kcal (${saved === null ? "change unknown" : `${saved} kcal less than the recorded recipe`}). Removing an ingredient may change feasibility, taste and texture; this is not an allergy or cross-contamination guarantee.` : `${name} بدون ${removedName}:\n\n${remaining}\n\nتقدير الحصة بعد الاستبعاد: ${modified.perServing.kcal ?? "غير متوفر"} سعر حراري${saved === null ? "" : `، أقل بحوالي ${saved} سعر من الوصفة المسجلة`}. حذف المكوّن قد يغيّر قابلية التنفيذ والطعم والقوام؛ وده مش ضمان حساسية أو خلو من التلوث التبادلي.`,
        data: { intent: "lighter_modification", modificationType: "ingredient_exclusion", recipeId: recipe.recipe_id, removedIngredient: { key: removable.ingredient, grams: removable.grams }, remainingIngredients: modifiedRecipe.ingredients, originalNutrition: original, modifiedNutrition: modified, caloriesSavedPerServingKcal: saved, conversationContext: { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: recipe.recipe_id } }, evidenceDocumentIds: [`DEMO-${recipe.recipe_id}`], provenance: [this.recipeProvenance(recipe, language)], toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const oils = new Set(["vegetable_oil", "olive_oil", "ghee", "butter_raw"]);
    const candidate = recipe.ingredients.filter((item) => oils.has(item.ingredient) && item.state !== "frying" && item.grams >= 10).sort((a, b) => b.grams - a.grams)[0];
    if (!candidate) return this.recipeClarification("lighter_modification", language, recipe);
    const reference = this.dataset.ingredientNutrition[candidate.ingredient];
    const calculation = calculateUnifiedDemoNutrition(this.dataset, recipe);
    if (!reference || reference.kcal === null || calculation.totals.kcal === null || calculation.perServing.kcal === null) return this.recipeClarification("lighter_modification", language, recipe);
    const continuing = context?.ingredient === candidate.ingredient && context.originalGrams === candidate.grams;
    const currentGrams = continuing ? context.proposedGrams : candidate.grams;
    const conversationContext: LighterModificationConversationContext = {
      schemaVersion: "1.0", lastIntent: "lighter_modification", recipeId: recipe.recipe_id,
      ingredient: candidate.ingredient, originalGrams: candidate.grams, proposedGrams: currentGrams,
    };
    if (currentGrams <= 5) {
      const name = language === "en" ? recipe.name_en : recipe.name_ar;
      return {
        status: "no_result", primaryIntent: "lighter_recipe", language, safetyFlags: [], integrityFlags: [],
        message: language === "en"
          ? `${name} is already at the smallest measured added-fat amount this demo can recommend (${currentGrams} g). I will not assume removing it entirely or change another ingredient without a validated substitution rule.`
          : `${name} وصل بالفعل لأقل كمية دهون مضافة يقدر العرض يحسبها بشكل موثوق (${currentGrams} جرام). مش هافترض حذفها تمامًا أو أغيّر مكوّن تاني من غير قاعدة بديل موثقة.`,
        data: { intent: "lighter_modification", recipeId: recipe.recipe_id, limitReached: true, conversationContext },
        evidenceDocumentIds: [`DEMO-${recipe.recipe_id}`], provenance: [this.recipeProvenance(recipe, language)],
        toolTrace: [{ tool: "calculate_nutrition", ok: false, code: "minimum_measured_fat_reached" }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const proposedGrams = Math.max(5, Math.round(currentGrams / 2 * 10) / 10);
    const savedFull = Math.round(reference.kcal * (candidate.grams - proposedGrams)) / 100;
    const savedPerServing = Math.round(savedFull / recipe.servings * 10) / 10;
    const previousSavedFull = Math.round(reference.kcal * (candidate.grams - currentGrams)) / 100;
    const previousSavedPerServing = Math.round(previousSavedFull / recipe.servings * 10) / 10;
    const incrementalSavedPerServing = Math.round((savedPerServing - previousSavedPerServing) * 10) / 10;
    const newFull = Math.round((calculation.totals.kcal - savedFull) * 10) / 10;
    const newPerServing = Math.round((calculation.perServing.kcal - savedPerServing) * 10) / 10;
    const previousPerServing = Math.round((calculation.perServing.kcal - previousSavedPerServing) * 10) / 10;
    const name = language === "en" ? recipe.name_en : recipe.name_ar;
    const ingredient = ingredientLabel(candidate.ingredient, language);
    const displayedIngredient = language === "en" ? ingredient
      : candidate.ingredient === "vegetable_oil" ? "الزيت النباتي"
      : candidate.ingredient === "olive_oil" ? "زيت الزيتون"
      : `ال${ingredient}`;
    const message = language === "en"
      ? `${continuing ? "A further reduction for" : "A lower-calorie"} ${name}: reduce the added ${displayedIngredient} from ${currentGrams} g to ${proposedGrams} g and keep the other recorded ingredients unchanged.\n\nEstimated additional reduction: ${incrementalSavedPerServing} kcal per serving. The serving changes from about ${previousPerServing} to ${newPerServing} kcal; total reduction from the recorded recipe is ${savedPerServing} kcal per serving.\n\nThis is a deterministic change based on the recorded oil quantity; taste and texture may change.`
      : `${continuing ? "تقليل إضافي لسعرات" : "نسخة أقل سعرات من"} ${name}: قلّل ${displayedIngredient} المضاف من ${currentGrams} جرام إلى ${proposedGrams} جرام، مع إبقاء باقي المكونات المسجلة كما هي.\n\nالتخفيض الإضافي التقديري ${incrementalSavedPerServing} سعر حراري للحصة. وبذلك تنخفض الحصة من نحو ${previousPerServing} إلى ${newPerServing} سعر حراري؛ وإجمالي التخفيض عن الوصفة المسجلة ${savedPerServing} سعر حراري للحصة.\n\nده تعديل محسوب من كمية الزيت المسجلة، وقد يغيّر الطعم أو القوام.`;
    conversationContext.proposedGrams = proposedGrams;
    return {
      status: "ok", primaryIntent: "lighter_recipe", language, safetyFlags: [], integrityFlags: [], message,
      data: { intent: "lighter_modification", demoOnly: true, reviewStatus: "needs_review", recipeId: recipe.recipe_id, modification: { ingredient: candidate.ingredient, originalGrams: candidate.grams, ...(continuing ? { previousGrams: currentGrams } : {}), proposedGrams }, originalCalories: { fullRecipe: calculation.totals.kcal, perServing: calculation.perServing.kcal }, previousModifiedCalories: { perServing: previousPerServing }, modifiedCalories: { fullRecipe: newFull, perServing: newPerServing }, caloriesSaved: { fullRecipe: Math.round(savedFull * 10) / 10, perServing: savedPerServing, additionalPerServing: incrementalSavedPerServing }, conversationContext },
      evidenceDocumentIds: [`DEMO-${recipe.recipe_id}`], provenance: [this.recipeProvenance(recipe, language)],
      toolTrace: [{ tool: "search_recipes", ok: true, code: null }, { tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private async guidelineAnswer(query: string, language: "ar-EG" | "ar" | "en"): Promise<ExpandedAgentResponse> {
    if (/(?:هرم غذائي|الهرم الغذائي|food pyramid)/iu.test(query)) {
      return {
        status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en"
          ? "WHO does not require one universal food-pyramid shape. Its current healthy-diet guidance uses four principles: adequacy, balance, moderation and diversity. In practice, emphasize varied minimally processed foods—including vegetables, fruit, legumes, whole grains and lean protein sources—and limit sodium, free sugars and unhealthy fats. This is general guidance, not a personalized diet."
          : "منظمة الصحة العالمية لا تفرض شكلاً واحدًا ثابتًا للهرم الغذائي. إرشاداتها الحالية تشرح النظام الصحي من خلال أربعة مبادئ: الكفاية، والتوازن، والاعتدال، والتنوع. عمليًا: نوّع الأطعمة قليلة التصنيع مثل الخضروات والفاكهة والبقول والحبوب الكاملة ومصادر البروتين قليلة الدهون، وقلّل الصوديوم والسكريات الحرة والدهون غير الصحية. ده إرشاد عام، مش نظام غذائي شخصي.",
        data: { intent: "general_guideline", demoOnly: true, reviewStatus: "needs_review", guideline: { documentId: "DEMO-WHO-HEALTHY-DIET", title: "WHO Healthy Diet Fact Sheet" } },
        evidenceDocumentIds: ["DEMO-WHO-HEALTHY-DIET"], provenance: [{ sourceId: "DEMO-WHO-GUIDANCE", versionId: "2.0-final-demo-normalized", title: "WHO Healthy Diet Fact Sheet", url: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet", accessedAt: this.dataset.metadata.created_date, locator: "WHO-HEALTHY-DIET" }],
        toolTrace: [{ tool: "search_guidelines", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    if (/(?:صوديوم|ملح|sodium|salt)/iu.test(query)) {
      return {
        status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en"
          ? "WHO recommends adults consume less than 2,000 mg of sodium per day (equivalent to less than 5 g of salt). This is a general population limit; it does not by itself classify any NutriGuard recipe as high-sodium. A recipe must be assessed from its own recorded value on the same basis, such as per serving or per 100 g. This is general guidance, not personalized medical advice."
          : "توصي منظمة الصحة العالمية بأن يستهلك البالغون أقل من 2000 مجم صوديوم يوميًا (ما يعادل أقل من 5 جرام ملح). ده حد عام للسكان، ولا يصنّف وحده أي وصفة في NutriGuard بأنها عالية الصوديوم؛ لازم نحكم من القيمة المسجلة للوصفة وعلى نفس الأساس: للحصة أو لكل 100 جرام. ده إرشاد عام، مش نصيحة طبية شخصية.",
        data: { intent: "general_guideline", demoOnly: true, reviewStatus: "needs_review", guideline: { documentId: "DEMO-WHO-SODIUM", title: "WHO Sodium Reduction Fact Sheet" } }, evidenceDocumentIds: ["DEMO-WHO-SODIUM"], provenance: [{ sourceId: "DEMO-WHO-GUIDANCE", versionId: "2.0-final-demo-normalized", title: "WHO Sodium Reduction Fact Sheet", url: "https://www.who.int/news-room/fact-sheets/detail/salt-reduction", accessedAt: this.dataset.metadata.created_date, locator: "WHO-SODIUM" }], toolTrace: [{ tool: "search_guidelines", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    if (asksForAdvice(query) && !/(?:صوديوم|ملح|سكر|دهون|sodium|salt|sugar|fat)/iu.test(query)) return this.generalAdvice(language);
    const searchQuery = /(?:صوديوم|ملح|sodium|salt)/iu.test(query) ? `${query} WHO sodium salt intake`
      : /(?:سكر|sugar)/iu.test(query) ? `${query} WHO free sugars intake`
      : /(?:دهون|fat)/iu.test(query) ? `${query} WHO saturated trans fat intake`
      : query;
    const search = await this.tools.searchGuidelines({ query: searchQuery, limit: 1, minScore: 0.01 });
    if (!search.ok || search.data.hits.length === 0) return this.unsupported(language, "general_guideline");
    const hit = search.data.hits[0]!;
    const sections = hit.document.text.split(/\n\s*\n/u);
    const preferredText = sections[language === "en" ? 1 : 0] ?? sections[0] ?? hit.document.text;
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en" ? `${preferredText}\n\nThis is general guidance, not personalized medical advice.` : `${preferredText}\n\nده إرشاد عام، وليس نصيحة طبية مخصصة.`,
      data: { intent: "general_guideline", demoOnly: true, reviewStatus: "needs_review", guideline: { documentId: hit.document.id, title: hit.document.title } }, evidenceDocumentIds: [hit.document.id], provenance: search.provenance,
      toolTrace: [{ tool: "search_guidelines", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private recipeClarification(intent: "find_recipe" | "lighter_modification", language: "ar-EG" | "ar" | "en", recipe?: UnifiedDemoRecipe): ExpandedAgentResponse {
    const name = recipe ? (language === "en" ? recipe.name_en : recipe.name_ar) : null;
    const message = intent === "lighter_modification"
      ? language === "en" ? name ? `I found ${name}, but its recorded ingredients do not include a measurable added fat that I can safely reduce with a deterministic calculation.` : "Tell me the exact Egyptian dish you want to make lighter, for example: a lower-calorie Koshary."
        : name ? `وجدت ${name}، لكن مكوناتها المسجلة لا تحتوي على دهون مضافة قابلة للتقليل بحساب موثوق.` : "اكتب اسم الأكلة المصرية التي تريد نسخة أخف منها، مثل: عايز نسخة أقل سعرات من الكشري."
      : language === "en" ? "Tell me the exact Egyptian dish name so I can return one matching recipe." : "اكتب اسم الأكلة المصرية بوضوح علشان أرجع لك وصفة واحدة مطابقة.";
    return { status: "clarification", primaryIntent: intent === "lighter_modification" ? "lighter_recipe" : "general_guidance", language, safetyFlags: [], integrityFlags: [], message, data: { intent, requiredInput: "exact_recipe_name" }, evidenceDocumentIds: [], provenance: [], toolTrace: [], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION };
  }

  private personalCalorieRequirementUnsupported(language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse {
    return {
      status: "unsupported", primaryIntent: "unsupported_request", language, safetyFlags: [], integrityFlags: [],
      message: language === "en"
        ? "I can calculate calories in foods and build a general example around a calorie target you provide, but I cannot determine your personal daily calorie requirement. That requires validated personal inputs and professional interpretation. If you already have a target, say: “three meals for 2000 kcal.”"
        : "أقدر أحسب سعرات الأطعمة وأجهّز مثالًا عامًا على هدف سعرات أنت تحدده، لكن ما ينفعش أحدد احتياجك الشخصي اليومي من السعرات؛ ده يحتاج بيانات شخصية موثقة وتقييم مختص. لو عندك هدف محدد، اكتب مثلًا: «3 وجبات في اليوم على 2000 سعر حراري».",
      data: { intent: "unsupported", reasonCode: "personal_calorie_requirement_not_supported" }, evidenceDocumentIds: [], provenance: [], toolTrace: [], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private recipeHealthSummary(recipe: UnifiedDemoRecipe, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse {
    const nutrition = calculateUnifiedDemoNutrition(this.dataset, recipe).perServing;
    const name = language === "en" ? recipe.name_en : recipe.name_ar;
    const conversationContext: RecipeReferenceConversationContext = { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: recipe.recipe_id };
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en"
        ? `${name} cannot be labelled simply “healthy” or “unhealthy” without a goal and portion context. One recorded serving is about ${nutrition.kcal ?? "unknown"} kcal, ${nutrition.protein ?? "unknown"} g protein, ${nutrition.carbs ?? "unknown"} g carbohydrates, ${nutrition.fat ?? "unknown"} g total fat, ${nutrition.fiber ?? "unknown"} g fiber, and ${nutrition.sodium ?? "unknown"} mg sodium. Saturated fat is unavailable, so it must not be assumed to be zero. This is a numeric context, not personalized medical advice.`
        : `ما ينفعش نحكم على ${name} إنها «صحية» أو «غير صحية» بشكل مطلق من غير هدف وحجم حصة. الحصة المسجلة حوالي ${nutrition.kcal ?? "غير متوفر"} سعر حراري، ${nutrition.protein ?? "غير متوفر"} جم بروتين، ${nutrition.carbs ?? "غير متوفر"} جم كربوهيدرات، ${nutrition.fat ?? "غير متوفر"} جم دهون كلية، ${nutrition.fiber ?? "غير متوفر"} جم ألياف، و${nutrition.sodium ?? "غير متوفر"} مجم صوديوم. الدهون المشبعة غير متوفرة، فلا يصح اعتبارها صفرًا. ده سياق رقمي عام، مش نصيحة طبية شخصية.`,
      data: { intent: "general_guideline", assessmentType: "recipe_numeric_context", recipeId: recipe.recipe_id, perServing: nutrition, saturatedFat: null, conversationContext }, evidenceDocumentIds: [`DEMO-${recipe.recipe_id}`], provenance: [this.recipeProvenance(recipe, language)], toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private unsupported(language: "ar-EG" | "ar" | "en", intent: GraduationIntent = "unsupported"): ExpandedAgentResponse {
    return {
      status: "unsupported", primaryIntent: "unsupported_request", language, safetyFlags: [], integrityFlags: [],
      message: language === "en" ? "I can help with Egyptian recipes, recipe or ingredient nutrition, numerical comparisons, general nutrition guidance, and lower-calorie recipe modifications. This request is outside the current scope." : "أقدر أساعدك في وصفات مصرية، القيم الغذائية للوصفات أو المكونات، المقارنات الرقمية، الإرشادات الغذائية العامة، أو نسخة أقل سعرات من وصفة. الطلب ده خارج نطاق النسخة الحالية.",
      data: { intent, reasonCode: "out_of_scope" }, evidenceDocumentIds: [], provenance: [], toolTrace: [], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private generalAdvice(language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse {
    const message = language === "en"
      ? "General nutrition tips:\n\n• Compare meals using the same basis, such as per serving or per 100 g.\n• Build the meal around vegetables and a clear protein source.\n• Watch portion size and added oil because both can change calories substantially.\n• Prefer water over sweetened drinks for everyday meals.\n• Missing data means unknown, not zero.\n\nFor personalized or medical advice, consult a qualified dietitian or clinician."
      : "نصائح غذائية عامة:\n\n• قارن الوجبات على نفس الأساس: للحصة أو لكل 100 جرام.\n• خلّي في الوجبة خضار ومصدر بروتين واضح.\n• راقب حجم الحصة والزيت المضاف لأنهم ممكن يغيّروا السعرات بشكل كبير.\n• اختار المياه بدل المشروبات المحلاة في الوجبات اليومية.\n• القيمة الناقصة معناها غير معروفة، مش صفر.\n\nلو محتاج نصيحة شخصية أو لحالة مرضية، راجع أخصائي تغذية أو طبيب مؤهل.";
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [], message,
      data: { demoOnly: true, reviewStatus: "needs_review", adviceType: "general_non_medical" }, evidenceDocumentIds: [], provenance: [],
      toolTrace: [], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private async ingredientCalories(query: string, language: "ar-EG" | "ar" | "en"): Promise<ExpandedAgentResponse> {
    const { parsed, unknownSegments } = parseIngredientAmounts(query);
    const backendCalculated: Array<{ key: string; grams: number; suppliedName: string; caloriesKcal: number | null; backendFood: BackendFood }> = [];
    const stillUnknown: string[] = [];
    for (const segment of unknownSegments) {
      const amount = normalizeNumberDigits(segment).match(/(-?\d+(?:\.\d+)?)\s*(?:g|gr|gram|grams|جرام|جرامات|جم)(?![\p{L}\p{N}])/iu);
      const term = querySubject(segment);
      if (!this.backend || !amount || !term) { stillUnknown.push(segment); continue; }
      try {
        const foods = await this.backend.searchFoods(term, 5);
        const food = foods.find((candidate) => candidateNameMatchesQuery(segment, [candidate.name, ...candidate.aliases]));
        if (!food) { stillUnknown.push(segment); continue; }
        const grams = Number(amount[1]);
        const calories = food.energy === null ? null : Math.round(food.energy * grams) / 100;
        backendCalculated.push({ key: `backend:${food.id}`, grams, suppliedName: language === "en" ? food.name : food.aliases.find((alias) => /\p{Script=Arabic}/u.test(alias)) ?? food.name, caloriesKcal: calories === null ? null : Math.round(calories * 10) / 10, backendFood: food });
      } catch { stillUnknown.push(segment); }
    }
    if (parsed.length === 0 && backendCalculated.length === 0) {
      const backendFood = await this.backendFoodCalories(query, language);
      if (backendFood) return backendFood;
      return {
        status: "clarification", primaryIntent: "recipe_nutrition", language, safetyFlags: [], integrityFlags: [],
        message: language === "en"
          ? "Write each ingredient with its weight in grams, for example: 150 g rice + 100 g chicken breast + 10 g olive oil."
          : "اكتب كل مكوّن ووزنه بالجرام، مثال: 150 جرام أرز + 100 جرام صدور فراخ + 10 جرام زيت زيتون.",
        data: { intent: "ingredient_nutrition", demoOnly: true, reviewStatus: "needs_review", requiredInput: "ingredient_weights_in_grams" }, evidenceDocumentIds: [], provenance: [],
        toolTrace: [{ tool: "calculate_nutrition", ok: false, code: "ingredient_weights_required" }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const calculated = parsed.map((item) => {
      const reference = this.dataset.ingredientNutrition[item.key];
      const calories = reference?.kcal === null || reference?.kcal === undefined ? null : Math.round(reference.kcal * item.grams) / 100;
      return { ...item, caloriesKcal: calories === null ? null : Math.round(calories * 10) / 10 };
    });
    const allCalculated = [...calculated, ...backendCalculated];
    const known = allCalculated.filter((item) => item.caloriesKcal !== null);
    const total = Math.round(known.reduce((sum, item) => sum + (item.caloriesKcal ?? 0), 0) * 10) / 10;
    const lines = allCalculated.map((item) => {
      const name = "backendFood" in item ? item.suppliedName : ingredientLabel(item.key, language);
      const state = "backendFood" in item ? null : item.key.endsWith("_raw") ? (language === "en" ? "raw" : "نيء") : item.key.endsWith("_cooked") ? (language === "en" ? "cooked" : "مطبوخ") : null;
      const calories = item.caloriesKcal === null ? (language === "en" ? "unknown" : "غير معروفة") : `${item.caloriesKcal} ${language === "en" ? "kcal" : "سعر حراري"}`;
      return `• ${name}${state ? ` (${state})` : ""}: ${item.grams} ${language === "en" ? "g" : "جرام"} = ${calories}`;
    });
    const unknownNote = stillUnknown.length === 0 ? "" : language === "en"
      ? `\n\nNot counted because the ingredient was not recognized: ${stillUnknown.join(" | ")}`
      : `\n\nلم يتم حساب أجزاء غير معروفة: ${stillUnknown.join(" | ")}`;
    const backendProvenance = backendCalculated.map((item) => backendFoodProvenance(item.backendFood, item.suppliedName));
    return {
      status: "ok", primaryIntent: "recipe_nutrition", language, safetyFlags: [], integrityFlags: [],
      message: language === "en"
        ? `Estimated calories from the supplied weights:\n\n${lines.join("\n")}\n\nTotal calculated calories: ${total} kcal.${unknownNote}`
        : `تقدير السعرات من الأوزان اللي كتبتها:\n\n${lines.join("\n")}\n\nإجمالي السعرات المحسوبة: ${total} سعر حراري.${unknownNote}`,
      data: { intent: "ingredient_nutrition", demoOnly: true, reviewStatus: "needs_review", calculationType: "ingredient_weights", ingredients: allCalculated.map(({ key, grams, suppliedName, caloriesKcal }) => ({ key, grams, suppliedName, caloriesKcal, foodState: key.endsWith("_raw") ? "raw" : key.endsWith("_cooked") ? "cooked" : null })), totalCaloriesKcal: total, partial: stillUnknown.length > 0 || known.length !== allCalculated.length, backendFoodsUsed: backendCalculated.length },
      evidenceDocumentIds: [], provenance: [{ sourceId: "DEMO-UNIFIED-EGYPTIAN-DATASET", versionId: "2.0-final-demo-normalized", title: language === "en" ? "Ingredient nutrition reference" : "مرجع القيم الغذائية للمكونات", url: null, accessedAt: this.dataset.metadata.created_date, locator: "ingredient_nutrition_reference" }, ...backendProvenance],
      toolTrace: [{ tool: "calculate_nutrition", ok: true, code: stillUnknown.length > 0 ? "partial" : null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private async backendFoodCalories(query: string, language: "ar-EG" | "ar" | "en"): Promise<ExpandedAgentResponse | null> {
    if (!this.backend) return null;
    const term = querySubject(query);
    if (!term) return null;
    try {
      const foods = await this.backend.searchFoods(term, 5);
      const food = foods.find((candidate) => candidateNameMatchesQuery(query, [candidate.name, ...candidate.aliases]));
      if (!food || food.energy === null) return null;
      const name = language === "en" ? food.name : food.aliases.find((alias) => /\p{Script=Arabic}/u.test(alias)) ?? food.name;
      return {
        status: "ok", primaryIntent: "recipe_nutrition", language, safetyFlags: [], integrityFlags: [],
        message: language === "en"
          ? `${name}: the backend food reference reports ${food.energy} kcal, ${food.protein ?? "unknown"} g protein, ${food.carbohydrate ?? "unknown"} g carbohydrates, and ${food.fat ?? "unknown"} g fat per 100 g.`
          : `${name}: مرجع الأطعمة في الـBackend يعرض ${food.energy} سعر حراري، ${food.protein ?? "غير معروف"} جم بروتين، ${food.carbohydrate ?? "غير معروف"} جم كربوهيدرات، و${food.fat ?? "غير معروف"} جم دهون لكل 100 جرام.`,
        data: { intent: "ingredient_nutrition", demoOnly: true, reviewStatus: "backend_candidate", backendFoodId: food.id, caloriesPer100gKcal: food.energy, proteinPer100gG: food.protein, carbohydratePer100gG: food.carbohydrate, fatPer100gG: food.fat, sodiumPer100gMg: food.sodium },
        evidenceDocumentIds: [], provenance: [backendFoodProvenance(food, name)],
        toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    } catch { return null; }
  }

  private async backendRecipeDetails(query: string, language: "ar-EG" | "ar" | "en"): Promise<ExpandedAgentResponse | null> {
    if (!this.backend) return null;
    const term = querySubject(query);
    if (term.length < 2) return null;
    try {
      const summaries = await this.backend.searchRecipes(term, 5);
      const summary = summaries.find((candidate) => candidateNameMatchesQuery(query, [candidate.name, ...candidate.aliases]));
      if (!summary) return null;
      const recipe: BackendRecipe = await this.backend.getRecipe(summary.id);
      const arabicName = recipe.aliases.find((alias) => /\p{Script=Arabic}/u.test(alias));
      const name = language === "en" ? recipe.name : arabicName ?? recipe.name;
      const ingredients = recipe.ingredients.map((item) => `• ${item.quantity} ${item.unit} ${item.foodName}`).join("\n");
      const instructions = recipe.instructions?.trim() || recipe.description?.trim() || (language === "en" ? "Preparation instructions are not available." : "طريقة التحضير غير متاحة في الاستجابة الحالية.");
      return {
        status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en"
          ? `${name}\n\nIngredients (${recipe.servings} servings):\n${ingredients}\n\nPreparation:\n${instructions}\n\nThe backend currently does not expose calculated nutrition per recipe serving.`
          : `${name}\n\nالمكونات (${recipe.servings} حصص):\n${ingredients}\n\nطريقة التحضير:\n${instructions}\n\nالـBackend لا يعرض حاليًا القيم الغذائية المحسوبة للحصة في الوصفة دي.`,
        data: { demoOnly: true, reviewStatus: "backend_candidate", backendRecipeId: recipe.id, recipe: { name, servings: recipe.servings, preparationTimeMinutes: recipe.preparationTimeMinutes, ingredients: recipe.ingredients, instructions } },
        evidenceDocumentIds: [], provenance: [{ sourceId: `BACKEND-RECIPE-${recipe.id}`, versionId: "live-public-api", title: name, url: `http://nutriguard.runasp.net/api/Recipes/${recipe.id}`, accessedAt: null, locator: String(recipe.id) }],
        toolTrace: [{ tool: "search_recipes", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    } catch { return null; }
  }

  private recommendMeal(category: string, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse {
    const recipes = this.dataset.recipes.filter((recipe) => recipe.category === category).slice(0, 3);
    if (recipes.length === 0) {
      return {
        status: "no_result", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en" ? "I could not find a matching Egyptian meal in the demo dataset." : "ملقتش وجبة مصرية مناسبة للنوع ده في بيانات العرض.",
        data: null, evidenceDocumentIds: [], provenance: [], toolTrace: [{ tool: "search_recipes", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const recommendations = recipes.map((recipe) => {
      const nutrition = calculateUnifiedDemoNutrition(this.dataset, recipe).perServing;
      return { recipeId: recipe.recipe_id, name: language === "en" ? recipe.name_en : recipe.name_ar, caloriesKcal: nutrition.kcal, proteinG: nutrition.protein };
    });
    const lines = recommendations.map((item) => language === "en"
      ? `• ${item.name} — about ${item.caloriesKcal ?? "unknown"} kcal and ${item.proteinG ?? "unknown"} g protein per serving.`
      : `• ${item.name} — حوالي ${item.caloriesKcal ?? "غير معروف"} سعر حراري و${item.proteinG ?? "غير معروف"} جم بروتين للحصة.`);
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en"
        ? `Here are three Egyptian options from the project dataset:\n\n${lines.join("\n")}\n\nTell me which one you prefer and I can show its ingredients and preparation method.`
        : `دي 3 اختيارات مصرية من قاعدة المشروع:\n\n${lines.join("\n")}\n\nاكتب اسم الاختيار اللي عجبك وأنا أعرض لك المكونات وطريقة التحضير.`,
      data: { demoOnly: true, reviewStatus: "needs_review", recommendations }, evidenceDocumentIds: recipes.map((recipe) => `DEMO-${recipe.recipe_id}`),
      provenance: recipes.map((recipe) => ({ sourceId: "DEMO-UNIFIED-EGYPTIAN-DATASET", versionId: "2.0-final-demo-normalized", title: language === "en" ? recipe.name_en : recipe.name_ar, url: recipe.source_url, accessedAt: this.dataset.metadata.created_date, locator: recipe.recipe_id })),
      toolTrace: [{ tool: "search_recipes", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private recipeDetails(
    recipe: UnifiedDemoRecipe,
    language: "ar-EG" | "ar" | "en",
    passages: Array<{ documentId: string; title: string; text: string; score: number }>,
    provenance: ExpandedAgentResponse["provenance"],
  ): ExpandedAgentResponse {
    const calculation = calculateUnifiedDemoNutrition(this.dataset, recipe);
    const ingredients = recipe.ingredients.map((item) => `• ${item.quantity} ${localizedUnit(item.unit, language)} ${ingredientLabel(item.ingredient, language)}`).join("\n");
    const title = language === "en" ? recipe.name_en : recipe.name_ar;
    const nutrition = calculation.perServing;
    const message = language === "en"
      ? `${title}\n\nIngredients for ${recipe.servings} servings:\n${ingredients}\n\nPreparation method (recorded in Arabic in the source):\n${recipe.method_summary}\n\nEstimated per serving: ${nutrition.kcal ?? "unknown"} kcal, ${nutrition.protein ?? "unknown"} g protein, ${nutrition.fat ?? "unknown"} g fat, and ${nutrition.carbs ?? "unknown"} g carbohydrates.`
      : `${title}\n\nالمكونات (${recipe.servings} حصص):\n${ingredients}\n\nطريقة التحضير:\n${recipe.method_summary}\n\nتقدير الحصة: ${nutrition.kcal ?? "غير معروف"} سعر حراري، ${nutrition.protein ?? "غير معروف"} جم بروتين، ${nutrition.fat ?? "غير معروف"} جم دهون، و${nutrition.carbs ?? "غير معروف"} جم كربوهيدرات.`;
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [], message,
      data: { demoOnly: true, reviewStatus: "needs_review", recipe: { recipeId: recipe.recipe_id, nameAr: recipe.name_ar, nameEn: recipe.name_en, servings: recipe.servings, ingredients: recipe.ingredients, method: recipe.method_summary, nutritionPerServing: nutrition }, passages, conversationContext: { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: recipe.recipe_id } },
      evidenceDocumentIds: passages.map((passage) => passage.documentId), provenance,
      toolTrace: [{ tool: "search_recipes", ok: true, code: null }, { tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

}

export async function buildGraduationDemoAgent(
  nodeEnv: "development" | "test",
  backendDataSource?: GraduationBackendDataSource | null,
): Promise<GraduationDemoAgent> {
  if (nodeEnv !== "development" && nodeEnv !== "test") throw new Error("graduation demo agent is forbidden outside development/test");
  const dataset = await loadUnifiedEgyptianDemoDataset();
  const recipes = new Map(dataset.recipes.map((recipe) => [recipe.recipe_id, recipe]));
  const embeddingProvider = new GraduationDemoEmbeddingProvider();
  const vectorStore = new InMemoryVectorStore();
  await ingestRetrievalCorpus(buildGraduationRetrievalCorpus(dataset), embeddingProvider, vectorStore);
  const calculateNutrition = async (recipeId: string) => {
    const recipe = recipes.get(recipeId);
    if (!recipe) throw new Error(`graduation demo recipe not found: ${recipeId}`);
    return toRecipeNutritionResult(dataset, recipe);
  };
  const localTools = new NutriGuardTools({
    embeddingProvider, vectorStore, corpusId: GRADUATION_DEMO_CORPUS_ID,
    calculateNutrition,
    guidelineRules: new InMemoryGuidelineRuleRepository([]),
  });
  let tools: NutriGuardToolset = localTools;
  const hybridEnabled = !/^(?:0|false|no|off)$/iu.test(process.env.HYBRID_RETRIEVAL_ENABLED?.trim() ?? "true");
  const embeddingApiKey = process.env.GEMINI_API_KEY?.trim() || process.env.EMBEDDING_API_KEY?.trim();
  const qdrantUrl = process.env.QDRANT_URL?.trim();
  const qdrantCollection = process.env.QDRANT_COLLECTION?.trim();
  if (hybridEnabled && embeddingApiKey && qdrantUrl && qdrantCollection) {
    const seconds = Number(process.env.TIMEOUT_SECONDS ?? "2");
    const timeoutMs = Math.round(Math.min(10, Math.max(0.25, Number.isFinite(seconds) ? seconds : 2)) * 1_000);
    const cooldownSeconds = Number(process.env.RETRIEVAL_CIRCUIT_BREAKER_SECONDS ?? "30");
    const circuitBreakerMs = Math.round(Math.min(300, Math.max(0, Number.isFinite(cooldownSeconds) ? cooldownSeconds : 30)) * 1_000);
    const remoteTools = new NutriGuardTools({
      embeddingProvider: new OpenAICompatibleEmbeddingProvider({
        baseUrl: process.env.EMBEDDING_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: embeddingApiKey,
        modelId: process.env.EMBEDDING_MODEL?.trim() || "gemini-embedding-2",
        dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? "3072"),
        timeoutMs,
      }),
      vectorStore: new QdrantVectorStore({
        baseUrl: qdrantUrl,
        collection: qdrantCollection,
        apiKey: process.env.QDRANT_API_KEY?.trim() || undefined,
        timeoutMs,
      }),
      corpusId: process.env.RETRIEVAL_CORPUS_ID?.trim() || GRADUATION_DEMO_CORPUS_ID,
      calculateNutrition,
      guidelineRules: new InMemoryGuidelineRuleRepository([]),
    });
    tools = new HybridRetrievalTools(remoteTools, localTools, { timeoutMs, circuitBreakerMs });
  }
  const backend = backendDataSource === undefined
    ? nodeEnv === "development" ? new NutriGuardBackendClient(process.env.NUTRIGUARD_BACKEND_BASE_URL?.trim() || undefined) : null
    : backendDataSource;
  return new GraduationDemoAgent(new NutriGuardExpandedAgent(tools, new InMemoryAlternativeRuleRepository([])), tools, dataset, backend);
}
