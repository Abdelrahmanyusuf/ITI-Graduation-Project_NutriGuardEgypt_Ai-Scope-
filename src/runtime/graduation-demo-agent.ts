import type { ExpandedAgentResponse } from "../agent/expanded-agent.js";
import { InMemoryAlternativeRuleRepository, NutriGuardExpandedAgent } from "../agent/expanded-agent.js";
import { NUTRIGUARD_SYSTEM_PROMPT_VERSION } from "../agent/system-prompt.js";
import { exclusionSafetyNote as sharedExclusionSafetyNote } from "../agent/exclusion-safety.js";
import {
  DatasetVerifiedMealRecipeRepository,
  MealSelectionFlow,
  type MealOptionsConversationContext,
  type MealSelectionAppliedConversationContext,
  type MealSelectionConversationContext,
  type MealSelectionPendingConversationContext,
} from "../agent/meal-selection-flow.js";
import {
  buildGraduationRetrievalCorpus,
  calculateUnifiedDemoNutrition,
  GRADUATION_DEMO_CORPUS_ID,
  GRADUATION_RECIPE_SOURCE_ID,
  loadUnifiedEgyptianDemoDataset,
  toRecipeNutritionResult,
  type UnifiedDemoRecipe,
  type UnifiedEgyptianDemoDataset,
} from "../demo/unified-egyptian-dataset.js";
import { ingestRetrievalCorpus, ingestionEligibleCorpus } from "../retrieval/ingestion.js";
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
import { MockDashboardClient } from "../services/dashboard/mock-dashboard-client.js";
import type { DashboardClient, LogMealSelectionsRequest } from "../services/dashboard/dashboard-client.js";
import { NutriGuardCustomMealDashboardClient } from "../services/dashboard/nutriguard-custom-meal-dashboard-client.js";
import {
  assessNutritionBalance,
  calculatePortionForCalories,
  diversifyHealthRanked,
  rankHealthFirst,
  RECOMMENDATION_POLICY_VERSION,
  type CalculatedPortion,
} from "../recommendation/health-first.js";

const DIMENSIONS = 16_384;
const GRADUATION_DEMO_DAILY_CALORIE_BUDGET = 2_000;

const INGREDIENT_NAMES_AR: Readonly<Record<string, string>> = {
  almonds_raw: "لوز",
  ammonia_baking_powder: "نشادر",
  anise_seeds: "بذور يانسون",
  artichoke_bottoms_raw: "قلوب خرشوف",
  baking_powder: "بيكنج بودر",
  baking_soda: "بيكربونات صوديوم",
  banana_raw: "موز",
  bay_leaf: "ورق لورا",
  beef_brain_raw: "مخ بقري",
  beef_broth: "مرقة لحمة",
  beef_ground_raw: "لحمة مفرومة",
  beef_head_meat: "لحمة رأس",
  beef_heart_raw: "قلب بقري",
  beef_intestines_raw: "أمعاء بقري",
  beef_kidney_raw: "كلاوي بقري",
  beef_liver_raw: "كبدة بقري",
  beef_marrow_bones: "عظام نخاع بقري",
  beef_spleen_raw: "طحال بقري",
  rice_white_raw: "أرز أبيض",
  beef_trotters_raw: "كوارع بقري",
  beetroot_raw: "بنجر",
  black_eyed_peas_dry: "لوبيا جافة",
  black_pepper: "فلفل أسود",
  black_tea_dry_leaves: "شاي أسود",
  bread_crumbs: "بقسماط مطحون",
  bulgur_dry: "برغل",
  butter_raw: "زبدة",
  cabbage_raw: "كرنب",
  calamari_raw: "كالماري",
  cantaloupe_raw: "شمام",
  cape_gooseberry_raw: "حرنكش",
  cardamom_ground: "حبهان مطحون",
  carob_crushed: "خروب مجروش",
  caul_fat_raw: "منديل ضاني",
  cauliflower_raw: "قرنبيط",
  celery_raw: "كرفس",
  cheese_feta: "جبنة فيتا",
  chicken_broth: "مرقة فراخ",
  chicken_gizzard_raw: "قوانص فراخ",
  chicken_liver_raw: "كبدة فراخ",
  chickpeas_cooked: "حمص مطبوخ",
  chili_powder: "شطة مطحونة",
  chili_raw: "فلفل حار",
  chocolate_dark: "شوكولاتة داكنة",
  lentils_brown_dry: "عدس بني",
  cinnamon_ground: "قرفة مطحونة",
  coconut_shredded: "جوز هند مبشور",
  coffee_grounds_fine: "بن مطحون ناعم",
  coriander_ground: "كزبرة مطحونة",
  cornmeal_yellow: "دقيق ذرة أصفر",
  cornstarch: "نشا ذرة",
  cream_heavy: "كريمة كاملة الدسم",
  macaroni_dry: "مكرونة",
  date_paste: "عجوة",
  dill_raw: "شبت",
  doum_crushed_fruit: "دوم مجروش",
  duck_broth: "مرقة بط",
  duck_meat_raw: "لحم بط",
  egg_yolks: "صفار بيض",
  eggplant_raw: "باذنجان",
  chickpeas_dry: "حمص",
  fava_beans_split_dry: "فول مدشوش",
  fennel_seeds: "بذور شمر",
  feseekh_fish: "فسيخ",
  fish_fillet_raw: "فيليه سمك",
  flaxseed_oil: "زيت بذور الكتان",
  flour_wheat: "دقيق قمح",
  freekeh_dry: "فريك",
  tomato_sauce: "صلصة طماطم",
  onion_raw: "بصل",
  garlic_raw: "ثوم",
  vegetable_oil: "زيت نباتي",
  cumin_ground: "كمون",
  vinegar: "خل",
  fava_beans_dry: "فول",
  ghee: "سمنة",
  goose_meat_raw: "لحم أوز",
  grape_leaves_raw: "ورق عنب",
  green_beans_raw: "فاصوليا خضراء",
  green_pepper_raw: "فلفل أخضر",
  grey_mullet_raw: "سمك بوري",
  guava_raw: "جوافة",
  hazelnut_raw: "بندق",
  herring_smoked: "رنجة مدخنة",
  hibiscus_dry_flowers: "كركديه مجفف",
  honey: "عسل",
  ice_cream_vanilla: "آيس كريم فانيليا",
  jam_apricot: "مربى مشمش",
  kabsa_spices: "بهارات كبسة",
  kahk_essence: "ريحة كحك",
  kunafa_dough: "عجينة كنافة",
  lamb_fat_tail: "لية ضاني",
  lemon_juice: "عصير ليمون",
  lentils_yellow_dry: "عدس أصفر",
  lettuce_leaves: "خس",
  liquorice_root_bark: "عرقسوس",
  mackerel_raw: "ماكريل",
  mandi_spices: "بهارات مندي",
  mallow_leaves_raw: "خبيزة",
  mango_pulp_raw: "لب مانجو",
  mastic_gum: "مستكة",
  mayonnaise: "مايونيز",
  mint_dry: "نعناع مجفف",
  mint_leaves_fresh: "نعناع طازج",
  moghat_powder: "مسحوق مغات",
  molokhia_leaves: "ملوخية",
  okra_raw: "بامية",
  olive_oil: "زيت زيتون",
  orange_juice_raw: "عصير برتقال",
  orange_zest: "بشر برتقال",
  oriental_sausage: "سجق شرقي",
  orzo_dry: "لسان عصفور",
  oxtail_raw: "عكاوي",
  pastirma: "بسطرمة",
  peas_green_raw: "بسلة خضراء",
  pigeon_squab_raw: "حمام",
  pine_nuts: "صنوبر",
  pistachio_raw: "فستق",
  pomegranate_seeds: "حب رمان",
  prickly_pear_raw: "تين شوكي",
  puff_pastry_ruqaq: "رقاق",
  qatayef_dough: "عجينة قطايف",
  rabbit_broth: "مرقة أرانب",
  rabbit_meat_raw: "لحم أرانب",
  raisins: "زبيب",
  rice_cooked_ref: "أرز مطبوخ",
  rice_basmati_raw: "أرز بسمتي",
  rice_flour: "دقيق أرز",
  rose_water: "ماء ورد",
  sahlab_powder_starch: "مسحوق سحلب",
  sardines_raw: "سردين",
  semolina: "سميد",
  shrimp_raw: "جمبري",
  spinach_raw: "سبانخ",
  strawberry_raw: "فراولة",
  sugar_powdered: "سكر بودرة",
  sugar_white: "سكر أبيض",
  sugarcane_juice_raw: "عصير قصب",
  sweet_corn_canned: "ذرة حلوة معلبة",
  swiss_chard_raw: "سلق",
  tahini: "طحينة",
  tamarind_block: "تمر هندي",
  taro_root_raw: "قلقاس",
  tilapia_raw: "بلطي",
  toast_bread_white: "توست أبيض",
  tomato_paste: "معجون طماطم",
  turmeric_ground: "كركم مطحون",
  vanilla_extract: "فانيليا",
  vermicelli_dry: "شعرية",
  walnuts_raw: "عين جمل",
  watermelon_raw: "بطيخ",
  wheat_bran: "نخالة قمح",
  white_beans_dry: "فاصوليا بيضاء جافة",
  yeast_dry: "خميرة جافة",
  yogurt_plain: "زبادي",
  zucchini_raw: "كوسة",
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
  ...Object.entries(INGREDIENT_NAMES_AR).map(([key, arabicName]) => ({
    key,
    aliases: [arabicName, key.replaceAll("_", " ")],
  })),
];

interface ParsedIngredientAmount {
  key: string;
  grams: number;
  suppliedName: string;
}

export interface NutritionConversationMemory {
  schemaVersion: "1.0";
  turnCount: number;
  activeRecipeId: string | null;
  recentRecipeIds: string[];
  mealPlan: {
    phase: "draft" | "ready";
    mealCount: number;
    calorieTargetKcal: number | null;
    calorieConstraint: "target" | "maximum";
    excludedIngredientKeys: string[];
    recipeIds: string[];
  } | null;
  singleMealTarget: {
    calorieTargetKcal: number;
    category: string | null;
    relation: "closest" | "below" | "above";
    lastRecommendationCaloriesKcal: number;
    excludedIngredientKeys: string[];
    recipeId: string | null;
  } | null;
  lighterModification: {
    recipeId: string;
    ingredient: string;
    originalGrams: number;
    proposedGrams: number;
  } | null;
}

interface MemoryCarrier { memory?: NutritionConversationMemory }

export interface CalorieTargetConversationContext extends MemoryCarrier {
  schemaVersion: "1.0";
  lastIntent: "meal_calorie_target";
  calorieTargetKcal: number;
  category: string | null;
  relation: "closest" | "below" | "above";
  lastRecommendationCaloriesKcal: number;
  excludedIngredientKeys?: string[];
  recipeId?: string;
}

export interface LighterModificationConversationContext extends MemoryCarrier {
  schemaVersion: "1.0";
  lastIntent: "lighter_modification";
  recipeId: string;
  ingredient: string;
  originalGrams: number;
  proposedGrams: number;
}

export interface RecipeReferenceConversationContext extends MemoryCarrier {
  schemaVersion: "1.0";
  lastIntent: "recipe_reference";
  recipeId: string;
}

export interface MealPlanConversationContext extends MemoryCarrier {
  schemaVersion: "1.0";
  lastIntent: "meal_plan";
  calorieTargetKcal: number;
  excludedIngredientKeys: string[];
  recipeIds: string[];
  mealCount?: number;
  calorieConstraint?: "target" | "maximum";
}

export interface MealPlanDraftConversationContext extends MemoryCarrier {
  schemaVersion: "1.0";
  lastIntent: "meal_plan_draft";
  mealCount: number;
  excludedIngredientKeys: string[];
  calorieConstraint: "target" | "maximum";
}

export type MealOptionsGraduationContext = MealOptionsConversationContext & MemoryCarrier;
export type MealSelectionPendingGraduationContext = MealSelectionPendingConversationContext & MemoryCarrier;
export type MealSelectionAppliedGraduationContext = MealSelectionAppliedConversationContext & MemoryCarrier;

export type GraduationConversationContext = CalorieTargetConversationContext | LighterModificationConversationContext | RecipeReferenceConversationContext | MealPlanConversationContext | MealPlanDraftConversationContext | MealOptionsGraduationContext | MealSelectionPendingGraduationContext | MealSelectionAppliedGraduationContext;

function isMealSelectionContext(context: GraduationConversationContext | undefined): context is MealSelectionConversationContext & MemoryCarrier {
  return context?.lastIntent === "meal_options" || context?.lastIntent === "meal_selection_pending" || context?.lastIntent === "meal_selection_applied";
}

function answerLanguage(message: string, requested: "ar-EG" | "ar" | "en" | undefined): "ar-EG" | "ar" | "en" {
  if (/\p{Script=Arabic}/u.test(message)) return requested === "ar" ? "ar" : "ar-EG";
  if (/[A-Za-z]/u.test(message)) return "en";
  return requested ?? "ar-EG";
}

function mealCategory(message: string): string | null {
  if (/(?:breakfast|فطار|إفطار|افطار)/iu.test(message)) return "breakfast";
  if (/(?:dessert|sweet|حلوى|حلويات|(?:حاجة|حاجه|أكلة|اكله|طبق).{0,10}حلوة|(?:حاجة|حاجه|أكلة|اكله|طبق).{0,10}حلوه)/iu.test(message)) return "dessert";
  if (/(?:drink|beverage|مشروب|عصير)/iu.test(message)) return "beverage";
  if (/(?:salad|سلطة)/iu.test(message)) return "salad";
  if (/(?:soup|شوربة)/iu.test(message)) return "soup";
  if (/(?:lunch|dinner|غدا|غداء|عشا|عشاء)/iu.test(message)) return "main_dish";
  return null;
}

const DAIRY_INGREDIENT_KEYS = new Set(["butter_raw", "cheese_feta", "cream_heavy", "ghee", "ice_cream_vanilla", "milk_whole", "yogurt_plain"]);
const ADDED_FAT_INGREDIENT_KEYS = new Set(["vegetable_oil", "olive_oil", "flaxseed_oil", "ghee", "butter_raw"]);
const EXCLUSION_MARKER_PATTERN = /(?:بدون|من دون|من غير|خالي(?:ه)?(?: تماما| كليا| 100)? من|مفيهاش|مافيهاش|ما\s*يكونش\s*فيها|ميكنش\s*فيها|ما\s*يبقاش\s*فيها|لا\s*تحتوي(?:\s+(?:علي|على))?|شيل(?:لي)?|احذف(?:لي)?|استبعد|بلاش|ما\s*تحطش|ماتحطش|without|free of|free from|remove|delete|omit|\bno\b)/iu;

function exclusionTargetText(message: string): string {
  const normalized = normalizedLookupText(message);
  // Use the final marker so a parenthetical recipe name such as
  // "مسقعة ... (بدون لحمة)" cannot override the user's later exclusion.
  const markers = [...normalized.matchAll(new RegExp(EXCLUSION_MARKER_PATTERN.source, "giu"))];
  const marker = markers.at(-1);
  if (marker) {
    const afterMarker = normalized.slice((marker.index ?? 0) + marker[0].length).trim();
    return afterMarker.split(/\s+(?:من|from)\s+/iu, 1)[0]?.trim() ?? "";
  }
  const suffixFree = normalized.match(/\bfree\b/iu);
  if (suffixFree) return normalized.slice(0, suffixFree.index).split(/\s+/u).slice(-4).join(" ");
  return "";
}

function hasIngredientExclusionRequest(message: string): boolean {
  const normalized = normalizedLookupText(message);
  return EXCLUSION_MARKER_PATTERN.test(normalized) || /\bfree\b/iu.test(normalized);
}

function excludedIngredientKeys(message: string): string[] {
  const normalized = normalizedLookupText(message);
  const excluded = new Set<string>();
  if (/(?:بدون|من دون|من غير|خالي(?:ه)?(?: تماما| كليا| 100)? من|مفيهاش|مافيهاش|ما\s*يكونش\s*فيها|ميكنش\s*فيها|ما\s*يبقاش\s*فيها|لا\s*تحتوي(?:\s+(?:علي|على))?|حساسيه من|حساسيه|استبعد|بلاش|ما\s*تحطش|ماتحطش).{0,40}(?:البان|بان|لبن|حليب|منتجات البان|منتجات بان)|(?:dairy[ -]?free|no dairy|milk allergy)/iu.test(normalized)) {
    for (const key of DAIRY_INGREDIENT_KEYS) excluded.add(key);
  }
  const exclusionText = exclusionTargetText(message);
  if (exclusionText) {
    if (/(?:زيت|oil|added fat)/iu.test(exclusionText)) {
      for (const key of ADDED_FAT_INGREDIENT_KEYS) excluded.add(key);
    }
    const matches = INGREDIENT_ALIASES.flatMap((entry) => entry.aliases.flatMap((alias) => {
      const normalizedAlias = normalizedLookupText(alias);
      const index = exclusionText.indexOf(normalizedAlias);
      return index < 0 ? [] : [{ key: entry.key, index, length: normalizedAlias.length }];
    })).sort((a, b) => a.index - b.index || b.length - a.length || a.key.localeCompare(b.key));
    for (const match of matches) {
      excluded.add(match.key);
    }
  }
  return [...excluded];
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
  }).replace(/٫/gu, ".").replace(/(?<=\d)[,٬](?=\d{3}(?:\D|$))/gu, "");
}

const MEAL_COUNT_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  واحد: 1, واحدة: 1,
  اثنين: 2, اتنين: 2, اثنتين: 2,
  ثلاث: 3, ثلاثة: 3, تلات: 3, تلاتة: 3,
  اربع: 4, اربعة: 4, أربع: 4, أربعة: 4,
  خمس: 5, خمسة: 5,
  ست: 6, ستة: 6,
  سبع: 7, سبعة: 7,
  ثمان: 8, ثمانية: 8, تمن: 8, تمانية: 8,
  تسع: 9, تسعة: 9,
  عشر: 10, عشرة: 10,
};

function mealCountFromWords(value: string): number | null {
  if (/(?:^|\s)وجبتين(?=\s|$)/u.test(value)) return 2;
  if (/(?:^|\s)(?:a\s+)?couple(?:\s+of)?\s+meals?(?=\s|$)/iu.test(value)) return 2;
  const reversedArabic = value.match(/(?:^|\s)(?:وجبة|وجبه)\s+(واحد|واحدة)(?=\s|$)/u);
  if (reversedArabic?.[1]) return 1;
  const match = value.match(/(?:^|\s)(one|two|three|four|five|six|seven|eight|nine|ten|واحد|واحدة|اثنين|اتنين|اثنتين|ثلاث|ثلاثة|تلات|تلاتة|اربع|اربعة|أربع|أربعة|خمس|خمسة|ست|ستة|سبع|سبعة|ثمان|ثمانية|تمن|تمانية|تسع|تسعة|عشر|عشرة)\s+(?:meals?|وجبات|وجبة|وجبه)(?=\s|$)/iu);
  return match?.[1] ? MEAL_COUNT_WORDS[match[1].toLocaleLowerCase("ar-EG")] ?? null : null;
}

function hasOutOfRangeMealCountWord(value: string): boolean {
  return /(?:^|\s)(?:zero|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|صفر|حداشر|احداشر|إحداشر|احد\s+عشر|إحدى\s+عشرة|اتناشر|اثنا\s+عشر|اثنتا\s+عشرة)\s+(?:meals?|وجبات|وجبة|وجبه)(?=\s|$)/iu.test(value);
}

function hasAmbiguousOrMalformedMealCount(value: string): boolean {
  const numberWord = "one|two|three|four|five|six|seven|eight|nine|ten";
  return new RegExp(`(?:^|\\s)(?:\\d+\\s*(?:-|to|or)\\s*\\d+|(?:${numberWord})\\s+(?:or|to)\\s+(?:${numberWord})|few|several|some|multiple|tree|thre|threee|tow|twoo|fiv|fivee|eigth|eightt|nien|tenn)\\s+meals?(?=\\s|$)`, "iu").test(value);
}

interface DisplayIngredientGrams {
  ingredient: string;
  displayName: string;
  grams: number;
}

function roundedIngredientGrams(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? rounded : Number(value.toPrecision(2));
}

/** Ingredient input weights for a full recipe or a scaled cooked serving. */
function recipeIngredientGrams(
  recipe: UnifiedDemoRecipe,
  language: "ar-EG" | "ar" | "en",
  servingFraction: number | null,
): DisplayIngredientGrams[] {
  const scale = servingFraction === null ? 1 : servingFraction / recipe.servings;
  return recipe.ingredients.map((item) => ({
    ingredient: item.ingredient,
    displayName: ingredientLabel(item.ingredient, language),
    grams: roundedIngredientGrams(item.grams * scale),
  }));
}

function ingredientGramLines(ingredients: readonly DisplayIngredientGrams[], language: "ar-EG" | "ar" | "en", indent = "• "): string {
  return ingredients.map((item) => `${indent}${item.displayName}: ${item.grams} ${language === "en" ? "g" : "جرام"}`).join("\n");
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

function assertCompleteArabicIngredientDictionary(dataset: UnifiedEgyptianDemoDataset): void {
  const keys = new Set([
    ...Object.keys(dataset.ingredientNutrition),
    ...dataset.recipes.flatMap((recipe) => recipe.ingredients.map((item) => item.ingredient)),
  ]);
  const missing = [...keys].filter((key) => !INGREDIENT_NAMES_AR[key] || !/\p{Script=Arabic}/u.test(INGREDIENT_NAMES_AR[key]!)).sort();
  if (missing.length > 0) throw new Error(`Arabic ingredient display dictionary is incomplete: ${missing.join(", ")}`);
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Produce a presentation name for a recipe whose ingredient list has changed.
 * The source title is never followed by a contradictory "without X" suffix.
 * If the source title itself names a removed ingredient, that ingredient phrase
 * is removed before the title is shown.
 */
function modifiedRecipeDisplayName(
  recipe: UnifiedDemoRecipe,
  removedIngredientKeys: readonly string[],
  language: "ar-EG" | "ar" | "en",
): string {
  let name = language === "en" ? recipe.name_en : recipe.name_ar;
  for (const key of removedIngredientKeys) {
    const aliases = new Set([
      ingredientLabel(key, language),
      ...(INGREDIENT_ALIASES.find((entry) => entry.key === key)?.aliases ?? []),
    ]);
    const matchingLanguage = [...aliases]
      .filter((alias) => language === "en" ? !/\p{Script=Arabic}/u.test(alias) : /\p{Script=Arabic}/u.test(alias))
      .sort((left, right) => right.length - left.length);
    for (const alias of matchingLanguage) {
      if (language === "en") {
        name = name.replace(new RegExp(`(?:\\s+(?:with|and|&)\\s+)?${escapedRegex(alias)}`, "giu"), " ");
      } else {
        name = name.replace(new RegExp(`(?:بال|وال|ال|ب|و)?${escapedRegex(alias)}`, "giu"), " ");
      }
    }
  }
  name = language === "en"
    ? name.replace(/\s*&\s*/gu, " and ").replace(/\bwith\s+(?:and\s+)?/giu, "with ").replace(/\s{2,}/gu, " ").replace(/\s+(?:with|and)\s*$/giu, "").trim()
    : name.replace(/\s+وال(?=\p{L})/gu, " بال").replace(/\s{2,}/gu, " ").replace(/\s+و\s*$/gu, "").trim();
  if (name.length < 2) return language === "en" ? "Modified Egyptian recipe" : "وصفة مصرية معدّلة";
  return language === "en" ? `${name} — modified recipe` : `${name} — وصفة معدّلة`;
}

function exclusionSafetyNote(removedNames: readonly string[], language: "ar-EG" | "ar" | "en"): string {
  return sharedExclusionSafetyNote(removedNames, language);
}

function reconcileEnergyWithMacros(
  nutrition: ReturnType<typeof calculateUnifiedDemoNutrition>["perServing"],
): { recordedKcal: number; macroEstimateKcal: number; differenceKcal: number } | null {
  if (nutrition.kcal === null || nutrition.protein === null || nutrition.carbs === null || nutrition.fat === null) return null;
  const macroEstimateKcal = Math.round((nutrition.protein * 4 + nutrition.carbs * 4 + nutrition.fat * 9) * 10) / 10;
  return {
    recordedKcal: nutrition.kcal,
    macroEstimateKcal,
    differenceKcal: Math.round((nutrition.kcal - macroEstimateKcal) * 10) / 10,
  };
}

function energyReconciliationNote(
  nutrition: ReturnType<typeof calculateUnifiedDemoNutrition>["perServing"],
  language: "ar-EG" | "ar" | "en",
): string {
  const reconciliation = reconcileEnergyWithMacros(nutrition);
  if (!reconciliation) return "";
  return language === "en"
    ? ` Recorded ingredient energy is ${reconciliation.recordedKcal} kcal; the approximate 4/4/9 macro check is ${reconciliation.macroEstimateKcal} kcal. These are shown separately because source energy can differ from the simplified macro equation.`
    : ` السعرات من طاقة المكونات المسجلة هي ${reconciliation.recordedKcal}؛ وفحص الماكروز التقريبي بمعادلة 4/4/9 يساوي ${reconciliation.macroEstimateKcal} سعر حراري. بنعرض الرقمين منفصلين لأن طاقة المصدر قد تختلف عن المعادلة المبسطة.`;
}

function perServingNutritionSummary(
  nutrition: ReturnType<typeof calculateUnifiedDemoNutrition>["perServing"],
  language: "ar-EG" | "ar" | "en",
): string {
  if (language === "en") {
    return `Estimated per serving after exclusion: ${nutrition.kcal ?? "unknown"} kcal, ${nutrition.protein ?? "unknown"} g protein, ${nutrition.carbs ?? "unknown"} g carbohydrates, and ${nutrition.fat ?? "unknown"} g total fat.${energyReconciliationNote(nutrition, language)}`;
  }
  return `تقدير الحصة بعد الاستبعاد: ${nutrition.kcal ?? "غير متوفر"} سعر حراري، ${nutrition.protein ?? "غير متوفر"} جم بروتين، ${nutrition.carbs ?? "غير متوفر"} جم كربوهيدرات، و${nutrition.fat ?? "غير متوفر"} جم دهون كلية.${energyReconciliationNote(nutrition, language)}`;
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
  "taameya": "EGY-RCP-003",
  "taamiya": "EGY-RCP-003",
  "egyptian falafel": "EGY-RCP-003",
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
  const normalizedText = normalizedLookupText(text);
  if (/(?:طوارئ|نزيف|إغماء|أغمي|اغمي|مش\s*بيتنفس|لا\s*يتنفس|اختناق|جرعة زائدة|suicid|emergency|overdose|diagnos|شخّص|شخص(?:\s*لي|لي)|تشخيص|دواء|علاج|مريض|حامل|سكري(?![\p{L}\p{N}])|ضغط|allergic|وزني.{0,20}طولي|عايز\s*اخس|اعمل\s+لي\s+نظام|نظام\s+غذائي\s+ليا|رجيم\s*قاسي)/iu.test(text)) return "medical_safety";
  const explicitComparison = /(?:قارن|مقارنة|compare|versus|\bvs\b)/iu.test(text);
  const comparativeQuestion = /(?:ولا|أيهما|ايهما|مين\s+(?:أقل|اقل|اكتر|أكثر)|أقل من|اكتر من|أكثر من)/iu.test(text)
    && /(?:سعر|بروتين|كربوهيدرات|دهون|ألياف|الياف|سكر|صوديوم|ملح|calorie|protein|carb|fat|fiber|sugar|sodium)/iu.test(text);
  if (explicitComparison || comparativeQuestion) return "compare_recipes";
  const explicitModification = hasIngredientExclusionRequest(text) || /(?:نسخة\s+(?:أخف|اخف|دايت)|(?:أ|ا)?قلل|خفض|تقليل|خفف|تعديل|بديل\s+(?:أخف|اخف)|lighter\s+(?:version|alternative)|reduce.{0,20}(?:calorie|fat|oil))/iu.test(text);
  const namedSuitabilityQuestion = namedRecipes.length > 0 && !explicitModification
    && /(?:هل|يعني|طب|مناسب|is).{0,45}(?:صحي|صحيه|النظام\s+الغذائي|دايت|مناسب|healthy|diet)|(?:صحي|صحيه).{0,20}(?:ولا|ام)/iu.test(text);
  if (namedSuitabilityQuestion) return "general_guideline";
  if (namedRecipes.length > 0 && /(?:طريقة\s+عمل|مكونات|عايز\s+وصفه|اريد\s+وصفه|how.{0,20}\bmake|ingredients)/iu.test(text)) return "find_recipe";
  const namedNutritionRequest = /(?:سعر|كالوري|طاقة|بروتين|كربوهيدرات|كارب|ماكروز|دهون|ألياف|الياف|سكر|صوديوم|ملح|قيمه\s+غذائيه|nutrition|macro|calorie|kcal|protein|carb|fat|fiber|sugar|sodium)/iu.test(text);
  const startsWithNutritionRequest = /^(?:السعرات|سعرات|القيمه\s+الغذائيه|قيمه\s+غذائيه|البروتين|الصوديوم|الدهون|nutrition|calories?)/iu.test(text);
  if (namedRecipes.length > 0 && namedNutritionRequest && (!explicitModification || startsWithNutritionRequest)) return "recipe_nutrition";
  const namedDietRequest = namedRecipes.length > 0 && /(?:دايت|خفيف|صحي|أخف|اخف|قليل(?:ة)?\s+(?:السعرات|الدهون|الزيت)|زيت\s+قليل|(?:زيت|دهون).{0,10}(?:اقل|أقل)|(?:اقل|أقل).{0,10}(?:زيت|دهون)|lower[ -]?calorie|healthier)/iu.test(text);
  if (explicitModification || namedDietRequest) return "lighter_modification";
  if (/(?:مش\s*معايا|مش\s*لاقي|معايا.{0,40}(?:ينفع|مش)|بديل|استبدل|استبدال|ينفع.{0,24}(?:بدل|مكان)|أستخدم.{0,24}بدل|substitute|replacement|swap)/iu.test(text)) return "unsupported";
  if (/(?:أصل(?:ه|ها)?|أصله|اصلها|جات\s*لمصر|من\s*أيام|من\s*قد\s*إيه|بقاله|فرعوني|مستوردة|الخديوي|قبل\s*الإسلام|مين\s+(?:اخترع|عمل)|ليه\s+(?:اسمها|اتسمت)|فرق(?:ه|ها)?\s+عن|histor(?:y|ical)|origin of|who invented)/iu.test(text)) return "unsupported";
  if (/(?:أنا|انا|وأنا|وانا|هل|ممكن|ينفع|وصفات|أكلات|اكلات|for\s+(?:a\s+)?|i\s+am|i'm|suitable).{0,24}(?:نباتي|فيجن|كيتو|جلوتين|صيامي|vegetarian|vegan|keto|gluten[ -]?free)|(?:أنا\s*صايم|صيام)/iu.test(text)) return "unsupported";
  if (/(?:إزاي\s*أخلي|ازاي\s*اخلي|عشان.{0,30}(?:ما|مي)|بيستوي.{0,20}قد\s*إيه|درجة\s*حرارة|من\s*غير\s*ما|بيتخمر.{0,20}قد\s*إيه|بتتقلب\s*إزاي)/iu.test(text)) return "unsupported";
  const explicitWhoReference = /\bWHO\b/u.test(text) || /\bworld health organi[sz]ation\b/iu.test(text);
  if (explicitWhoReference || /(?:هرم غذائي|منظمه الصحه|ارشاد|توصيات|الحد اليومي|دهون مشبعه|دهون متحوله|دهون غير مشبعه|مضر|guideline|food pyramid)/iu.test(normalizedText)) return "general_guideline";
  const nutrientTerms = /(?:سعر|كالوري|طاقة|بروتين|كربوهيدرات|كارب|ماكروز|دهون|ألياف|الياف|سكر|صوديوم|ملح|غذائي|nutrition|macro|calorie|kcal|protein|carb|fat|fiber|sugar|sodium)/iu;
  if (namedRecipes.length > 0 && nutrientTerms.test(text)) return "recipe_nutrition";
  if (namedRecipes.length === 0 && nutrientTerms.test(text) && /(?:رشح|اقترح|وجبة|أكلة|اكلة|ناقصني|عالي|عالية|غني|غنية|قليل|قليلة|high|rich|low|recommend|suggest)/iu.test(text)) return "find_recipe";
  if (/\d\s*(?:g|gr|gram|grams|جرام|جرامات|جم)(?![\p{L}\p{N}])/iu.test(text) || (namedRecipes.length === 0 && (asksForIngredientCalories(text) || (nutrientTerms.test(text) && /(?:\sفي\s|per\s+100|لكل\s+100)/iu.test(text))))) return "ingredient_nutrition";
  if (namedRecipes.length === 0 && nutrientTerms.test(text) && /(?:ما\s+(?:هو|هي|هى)|يعني\s+ايه|معني|معنى|اشرح|الفرق|يومي|مسموح|الحد|توصي|اضرار|أضرار|فوائد|فوايد|عام|مضر|مضره|صحي|صحيه|what\s+(?:is|are)|explain|difference|guideline|recommend)/iu.test(text)) return "general_guideline";
  if (namedRecipes.length > 0 || mealCategory(text) || /(?:وصفة|طريقة عمل|أعمل|اعمل|مكونات|اقترح|رشح|وجبة|أكلة|اكلة|ناقصني|عندي|معايا|متوفر|عالية|عالي|غنية|غني|قليلة السعرات|recipe|how.{0,20}\bmake|meal|dish|food|high protein|low calorie|i have|using|surprise\s+me|(?:pick|choose|suggest|recommend)\s+something)/iu.test(text)) return "find_recipe";
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

type PersonalNutrientKey = "calories" | "protein" | "carbohydrate" | "fat";
interface PersonalNutrientValue { target: number | null; consumed: number | null; remaining: number | null }
type PersonalNutritionValues = Record<PersonalNutrientKey, PersonalNutrientValue>;

function backendContextResponse(
  language: "ar-EG" | "ar" | "en",
  contextType: string,
  message: string,
  backendData: Record<string, unknown>,
): ExpandedAgentResponse {
  return {
    status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [], message,
    data: { intent: "personal_backend_context", contextType, ...backendData }, evidenceDocumentIds: [], provenance: [],
    toolTrace: [{ tool: "get_user_nutrition_context", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
  };
}

function requestedDate(message: string): string | null {
  const match = normalizeNumberDigits(message).match(/\b(20\d{2}-\d{2}-\d{2})\b/u);
  if (!match?.[1]) return null;
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(match[1]) ? match[1] : null;
}

function dateInCairo(now: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function findBackendNumber(value: unknown, keys: readonly string[], depth = 0): number | null {
  if (depth > 5 || typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  for (const nested of Object.values(record)) {
    const candidate = findBackendNumber(nested, keys, depth + 1);
    if (candidate !== null) return candidate;
  }
  return null;
}

function personalNutritionValues(targets: unknown, summary: unknown): PersonalNutritionValues {
  const fields: Record<PersonalNutrientKey, { target: string[]; consumed: string[]; remaining: string[] }> = {
    calories: { target: ["caloriesTarget", "energyKcal", "dailyCalories", "calorieTarget", "targetCalories", "calories"], consumed: ["caloriesConsumed", "energyKcal", "totalCalories", "consumedCalories", "calories"], remaining: ["caloriesRemaining", "remainingCalories", "remainingCaloriesKcal"] },
    protein: { target: ["proteinTargetGrams", "proteinG", "dailyProteinG", "proteinTargetG", "protein"], consumed: ["proteinConsumedGrams", "proteinG", "totalProteinG", "consumedProteinG", "protein"], remaining: ["proteinRemainingGrams", "remainingProteinG"] },
    carbohydrate: { target: ["carbsTargetGrams", "carbohydrateG", "carbsG", "dailyCarbohydrateG", "carbohydrateTargetG", "carbohydrate"], consumed: ["carbsConsumedGrams", "carbohydrateG", "carbsG", "totalCarbohydrateG", "consumedCarbohydrateG", "carbohydrate"], remaining: ["carbsRemainingGrams", "carbohydrateRemainingGrams", "remainingCarbohydrateG"] },
    fat: { target: ["fatTargetGrams", "fatG", "dailyFatG", "fatTargetG", "fat"], consumed: ["fatConsumedGrams", "fatG", "totalFatG", "consumedFatG", "fat"], remaining: ["fatRemainingGrams", "remainingFatG"] },
  };
  return Object.fromEntries(Object.entries(fields).map(([key, aliases]) => {
    const target = findBackendNumber(targets, aliases.target);
    const consumed = findBackendNumber(summary, aliases.consumed);
    const reportedRemaining = findBackendNumber(summary, aliases.remaining);
    const remaining = reportedRemaining ?? (target === null || consumed === null ? null : Math.max(0, Math.round((target - consumed) * 10) / 10));
    return [key, { target, consumed, remaining }];
  })) as PersonalNutritionValues;
}

function personalNutritionLines(
  values: PersonalNutritionValues,
  language: "ar-EG" | "ar" | "en",
  field: keyof PersonalNutrientValue,
): string[] {
  const labels: Record<PersonalNutrientKey, { ar: string; en: string; unitAr: string; unitEn: string }> = {
    calories: { ar: "السعرات", en: "Calories", unitAr: "سعر حراري", unitEn: "kcal" },
    protein: { ar: "البروتين", en: "Protein", unitAr: "جم", unitEn: "g" },
    carbohydrate: { ar: "الكربوهيدرات", en: "Carbohydrates", unitAr: "جم", unitEn: "g" },
    fat: { ar: "الدهون", en: "Fat", unitAr: "جم", unitEn: "g" },
  };
  return (Object.keys(values) as PersonalNutrientKey[]).flatMap((key) => {
    const value = values[key][field];
    if (value === null) return [];
    const label = labels[key];
    return [`• ${language === "en" ? label.en : label.ar}: ${value} ${language === "en" ? label.unitEn : label.unitAr}`];
  });
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
    private readonly mealSelection: MealSelectionFlow,
  ) {}

  public async invoke(input: { message: string; language?: "ar-EG" | "ar" | "en"; context?: GraduationConversationContext }): Promise<ExpandedAgentResponse> {
    const focusedContext = this.contextForMessage(input.context, input.message);
    const response = await this.invokeCore({ ...input, context: focusedContext });
    return this.withConversationMemory(response, input.context, focusedContext);
  }

  private contextForMessage(context: GraduationConversationContext | undefined, message: string): GraduationConversationContext | undefined {
    const memory = context?.memory;
    if (!memory) return context;
    const text = normalizeNumberDigits(message);
    const planCue = /(?:وجبات|خطه|خطة|طول\s+اليوم|السعرات\s+اليومي|هدف(?:ي)?.{0,20}سعر|خليهم|زود\s+وجبه|زود\s+وجبة|قلل\s+وجبه|قلل\s+وجبة|meal\s+plan|daily\s+calorie)/iu.test(text);
    if (memory.mealPlan && (planCue || context.lastIntent === "meal_plan" || context.lastIntent === "meal_plan_draft")) {
      const plan = memory.mealPlan;
      return plan.phase === "draft" || plan.calorieTargetKcal === null
        ? { schemaVersion: "1.0", lastIntent: "meal_plan_draft", mealCount: plan.mealCount, excludedIngredientKeys: [...plan.excludedIngredientKeys], calorieConstraint: plan.calorieConstraint, memory }
        : { schemaVersion: "1.0", lastIntent: "meal_plan", calorieTargetKcal: plan.calorieTargetKcal, excludedIngredientKeys: [...plan.excludedIngredientKeys], recipeIds: [...plan.recipeIds], mealCount: plan.mealCount, calorieConstraint: plan.calorieConstraint, memory };
    }
    const lighterCue = /(?:أقلل|اقلل|قلل|أقل|اقل|أكتر|اكتر|أكثر|تاني|تانب|more|again|further|lower)/iu.test(text);
    if (memory.lighterModification && lighterCue) {
      return { schemaVersion: "1.0", lastIntent: "lighter_modification", ...memory.lighterModification, memory };
    }
    const singleMealCue = /(?:أقل|اقل|أكتر|اكتر|أكثر|more|less|lower|higher)/iu.test(text);
    if (memory.singleMealTarget && singleMealCue) {
      const single = memory.singleMealTarget;
      return { schemaVersion: "1.0", lastIntent: "meal_calorie_target", calorieTargetKcal: single.calorieTargetKcal, category: single.category, relation: single.relation, lastRecommendationCaloriesKcal: single.lastRecommendationCaloriesKcal, excludedIngredientKeys: [...single.excludedIngredientKeys], ...(single.recipeId ? { recipeId: single.recipeId } : {}), memory };
    }
    const recipeCue = /(?:هي|دي|ده|ها\b|قارنها|خففها|قللها|زودها|الوصفه\s+اللي\s+فاتت|الاكله\s+اللي\s+فاتت|it|that\s+recipe|same\s+recipe)/iu.test(text);
    if (memory.activeRecipeId && recipeCue) return { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: memory.activeRecipeId, memory };
    return context;
  }

  private withConversationMemory(
    response: ExpandedAgentResponse,
    incoming: GraduationConversationContext | undefined,
    focused: GraduationConversationContext | undefined,
  ): ExpandedAgentResponse {
    const responseData = response.data && typeof response.data === "object" ? response.data as Record<string, unknown> : {};
    const next = responseData.conversationContext as GraduationConversationContext | undefined;
    const base = incoming?.memory ?? focused?.memory;
    const memory: NutritionConversationMemory = base ? {
      ...base,
      turnCount: Math.min(100, base.turnCount + 1),
      recentRecipeIds: [...base.recentRecipeIds],
      mealPlan: base.mealPlan ? { ...base.mealPlan, excludedIngredientKeys: [...base.mealPlan.excludedIngredientKeys], recipeIds: [...base.mealPlan.recipeIds] } : null,
      singleMealTarget: base.singleMealTarget ? { ...base.singleMealTarget, excludedIngredientKeys: [...base.singleMealTarget.excludedIngredientKeys] } : null,
      lighterModification: base.lighterModification ? { ...base.lighterModification } : null,
    } : {
      schemaVersion: "1.0", turnCount: 1, activeRecipeId: null, recentRecipeIds: [], mealPlan: null, singleMealTarget: null, lighterModification: null,
    };
    const absorb = (candidate: GraduationConversationContext | undefined): void => {
      if (!candidate) return;
      const rememberRecipe = (recipeId: string | undefined): void => {
        if (!recipeId) return;
        memory.activeRecipeId = recipeId;
        memory.recentRecipeIds = [recipeId, ...memory.recentRecipeIds.filter((id) => id !== recipeId)].slice(0, 8);
      };
      if (candidate.lastIntent === "recipe_reference") rememberRecipe(candidate.recipeId);
      if (candidate.lastIntent === "lighter_modification") {
        rememberRecipe(candidate.recipeId);
        memory.lighterModification = { recipeId: candidate.recipeId, ingredient: candidate.ingredient, originalGrams: candidate.originalGrams, proposedGrams: candidate.proposedGrams };
      }
      if (candidate.lastIntent === "meal_calorie_target") {
        rememberRecipe(candidate.recipeId);
        memory.singleMealTarget = { calorieTargetKcal: candidate.calorieTargetKcal, category: candidate.category, relation: candidate.relation, lastRecommendationCaloriesKcal: candidate.lastRecommendationCaloriesKcal, excludedIngredientKeys: [...candidate.excludedIngredientKeys ?? []], recipeId: candidate.recipeId ?? null };
      }
      if (candidate.lastIntent === "meal_plan_draft") {
        memory.mealPlan = { phase: "draft", mealCount: candidate.mealCount, calorieTargetKcal: null, calorieConstraint: candidate.calorieConstraint, excludedIngredientKeys: [...candidate.excludedIngredientKeys], recipeIds: [] };
      }
      if (candidate.lastIntent === "meal_plan") {
        memory.mealPlan = { phase: "ready", mealCount: candidate.mealCount ?? candidate.recipeIds.length, calorieTargetKcal: candidate.calorieTargetKcal, calorieConstraint: candidate.calorieConstraint ?? "target", excludedIngredientKeys: [...candidate.excludedIngredientKeys], recipeIds: [...candidate.recipeIds] };
        memory.recentRecipeIds = [...candidate.recipeIds, ...memory.recentRecipeIds.filter((id) => !candidate.recipeIds.includes(id))].slice(0, 8);
        if (!memory.activeRecipeId) memory.activeRecipeId = candidate.recipeIds[0] ?? null;
      }
    };
    absorb(incoming);
    absorb(next);
    const recommendationIds = Array.isArray(responseData.recommendations)
      ? responseData.recommendations.flatMap((entry) => typeof entry === "object" && entry !== null && typeof (entry as { recipeId?: unknown }).recipeId === "string" ? [(entry as { recipeId: string }).recipeId] : [])
      : [];
    if (recommendationIds.length > 0) {
      memory.recentRecipeIds = [...recommendationIds, ...memory.recentRecipeIds.filter((id) => !recommendationIds.includes(id))].slice(0, 8);
      memory.activeRecipeId ??= recommendationIds[0] ?? null;
    }
    const recommendationContext: RecipeReferenceConversationContext | undefined = recommendationIds[0]
      ? { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: recommendationIds[0], memory }
      : undefined;
    const current = next ?? focused ?? incoming ?? recommendationContext;
    if (!current) return response;
    const conversationContext: GraduationConversationContext = { ...current, memory };
    return { ...response, data: { ...responseData, conversationContext } };
  }

  private async invokeCore(input: { message: string; language?: "ar-EG" | "ar" | "en"; context?: GraduationConversationContext }): Promise<ExpandedAgentResponse> {
    const result = await this.base.invoke(input);
    if (result.safetyFlags.length > 0 || result.integrityFlags.length > 0) return result;
    if (result.status === "emergency" || result.status === "refused") return result;
    const query = input.message.trim();
    const language = answerLanguage(query, input.language);
    const mealSelectionResponse = await this.mealSelection.handle({
      message: query,
      language,
      ...(isMealSelectionContext(input.context) ? { context: input.context } : {}),
    });
    if (mealSelectionResponse) return mealSelectionResponse;
    const personalized = await this.personalBackendResponse(query, language);
    if (personalized) return personalized;
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
    const contextualMealPlanFollowup = (input.context?.lastIntent === "meal_plan" || input.context?.lastIntent === "meal_plan_draft")
      && /(?:قلل|خفض|زود|ارفع|غير|بدل|اقل|اكتر|reduce|increase|change)/iu.test(query);
    const deterministicIntent = contextualCalorieFollowup || contextualMealPlanFollowup ? "find_recipe" : contextualLighterFollowup ? "lighter_modification" : classifyGraduationIntent(query, namedRecipes);

    if (/(?:احتياجي اليومي|احتياج(?:ي)?.{0,20}سعر|daily calorie needs|\bTDEE\b|\bBMR\b)/iu.test(query)) {
      return this.personalCalorieRequirementUnsupported(language);
    }

    const conversationalResponse = this.scopedConversationResponse(query, language);
    if (conversationalResponse) return conversationalResponse;

    // The graduation UI exposes one answer, not raw retrieval candidates. Safety and
    // integrity always keep the authority of the production agent above this router.
    if (deterministicIntent === "medical_safety") return this.medicalSafetyFallback(query, language, result);
    if (namedRecipes.length === 0) {
      const conceptAnswer = this.nutritionConceptAnswer(query, language);
      if (conceptAnswer) return conceptAnswer;
    }
    const directMealPlan = await this.recommendMealPlanWithBackendTarget(query, language, input.context);
    if (directMealPlan) return directMealPlan;
    const hasExplicitCalorieTarget = /\d+(?:\.\d+)?\s*(?:سعر(?:ة|ات)?(?:\s*حراري(?:ة|ه)?)?|كالوري|kcal|calories?)/iu.test(normalizeNumberDigits(query));
    if ((mealCategory(query) || input.context?.lastIntent === "meal_calorie_target" || namedRecipes.length > 0 && hasExplicitCalorieTarget) && !(namedRecipes.length > 0 && hasIngredientExclusionRequest(query))) {
      const directCalorieTarget = this.recommendToCalorieTarget(query, language, input.context);
      if (directCalorieTarget) return directCalorieTarget;
    }
    if (namedRecipes.length === 0 && hasIngredientExclusionRequest(query) && /(?:وجبه|وجبة|اكل|أكل|meal|food)/iu.test(query)) {
      const exclusionRecommendation = this.recommendWithExclusions(query, language);
      if (exclusionRecommendation) return exclusionRecommendation;
    }
    if (namedRecipes.length === 0 && hasIngredientExclusionRequest(query)) {
      const exclusions = excludedIngredientKeys(query);
      const dairyRequest = DAIRY_INGREDIENT_KEYS.size > 0 && [...DAIRY_INGREDIENT_KEYS].every((key) => exclusions.includes(key));
      const excludedLabel = language === "en" ? dairyRequest ? "all recorded dairy ingredients" : "the requested ingredients"
        : dairyRequest ? "كل مكونات الألبان المسجلة، ومنها الزبادي واللبن والجبن والسمن والزبدة" : "المكونات المطلوبة";
      return {
        status: "clarification", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en"
          ? `Understood. I will exclude ${excludedLabel}. Tell me whether you want breakfast, lunch, dinner, or a snack, and optionally give a calorie target. I will filter the recorded ingredient list, but cannot guarantee absence of cross-contamination.`
          : `تمام، هأستبعد ${excludedLabel}. قول لي عايز فطار ولا غداء ولا عشاء ولا سناك، وممكن تكتب هدف السعرات. هافلتر المكونات المسجلة، لكن لا أقدر أضمن عدم وجود تلوث تبادلي.`,
        data: { intent: "find_recipe", requiredInput: "meal_type_or_calorie_target", excludedIngredientKeys: exclusions },
        evidenceDocumentIds: [], provenance: [], toolTrace: [], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
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
      if (namedRecipes[0] && /(?:صحي|صحيه|النظام\s+الغذائي|دايت|مناسب|healthy|diet)/iu.test(query)) return this.recipeHealthSummary(namedRecipes[0], language);
      return this.guidelineAnswer(query, language);
    }
    if (deterministicIntent === "find_recipe") {
      const recipe = namedRecipes[0];
      if (recipe) return this.recipeDetails(recipe, language, [{ documentId: `DEMO-${recipe.recipe_id}`, title: language === "en" ? recipe.name_en : recipe.name_ar, text: recipe.method_summary, score: 1 }], [this.recipeProvenance(recipe, language)]);
      const calorieTargetRecommendation = this.recommendToCalorieTarget(query, language, input.context);
      if (calorieTargetRecommendation) return calorieTargetRecommendation;
      const deterministicCategory = mealCategory(query);
      if (deterministicCategory) return this.recommendMeal(deterministicCategory, language, input.context);
      const nutritionRecommendation = this.recommendByNutrition(query, language);
      if (nutritionRecommendation) return nutritionRecommendation;
      const pantryRecommendation = this.recommendFromIngredients(query, language);
      if (pantryRecommendation) return pantryRecommendation;
      const anyMealRecommendation = this.recommendAnyMeal(query, language, input.context);
      if (anyMealRecommendation) return anyMealRecommendation;
      const backendRecipe = await this.backendRecipeDetails(query, language);
      if (backendRecipe) return { ...backendRecipe, data: { ...(backendRecipe.data ?? {}), intent: "find_recipe" } };
      return this.recipeNotFound(language);
    }
    return this.unsupported(language);

  }

  private async personalBackendResponse(query: string, language: "ar-EG" | "ar" | "en"): Promise<ExpandedAgentResponse | null> {
    if (!this.backend) return null;
    const wantsSummary = /(?:ملخص|استهلكت|اكلت.{0,15}النهارده|أكلت.{0,15}النهارده|summary|consumed|logged today)/iu.test(query);
    const wantsRemaining = /(?:ناقصني|متبقي|متبقى|فاضلي|فاضلى|باقيلي|باقي ليا|remaining|left today|still need)/iu.test(query);
    const wantsTargets = /(?:هدفي|التارجت|الهدف اليومي|target|daily goal|احتياجي اليومي)/iu.test(query);
    const wantsProfile = /(?:البروفايل الصحي|الهيلث بروفايل|بياناتي الصحية|health profile|my profile)/iu.test(query);
    const wantsRules = /(?:تفضيلاتي|حساسيتي|الحساسية عندي|الممنوع عندي|food preferences|my allergies|my restrictions|user rules)/iu.test(query);
    if (!wantsSummary && !wantsRemaining && !wantsTargets && !wantsProfile && !wantsRules) return null;

    const authFailure = (): ExpandedAgentResponse => ({
      status: "clarification", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en"
        ? "Sign in through the frontend so NutriGuard can read your Backend profile and tracking data for this request."
        : "سجّل دخول من الـFrontend علشان NutriGuard يقدر يقرأ البروفايل وبيانات التتبع من الـBackend في الطلب ده.",
      data: { intent: "personal_backend_context", requiredInput: "backend_access_token" }, evidenceDocumentIds: [], provenance: [],
      toolTrace: [{ tool: "get_user_nutrition_context", ok: false, code: "invalid_token" }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    });

    try {
      if (wantsProfile && this.backend.getHealthProfile) {
        const profile = await this.backend.getHealthProfile();
        return backendContextResponse(language, "health_profile", language === "en" ? "I loaded your health profile from the Backend." : "حمّلت بيانات البروفايل الصحي من الـBackend.", { profile });
      }
      if (wantsRules) {
        const rules = this.backend.getUserRules ? await this.backend.getUserRules()
          : this.backend.getFoodPreferences ? await this.backend.getFoodPreferences() : null;
        if (rules !== null) return backendContextResponse(language, "user_rules", language === "en" ? "I loaded your current preferences and nutrition rules from the Backend." : "حمّلت تفضيلاتك وقواعد التغذية الحالية من الـBackend.", { rules });
      }
      if ((wantsSummary || wantsRemaining || wantsTargets) && this.backend.getDailySummary) {
        const date = requestedDate(query) ?? dateInCairo(Date.now());
        const summary = await this.backend.getDailySummary(date);
        let targets: unknown = summary;
        if (this.backend.getNutritionTargets) {
          try { targets = await this.backend.getNutritionTargets(); } catch { /* Current Backend exposes targets inside the dated summary. */ }
        }
        const values = personalNutritionValues(targets, summary);
        const lines = personalNutritionLines(values, language, wantsRemaining ? "remaining" : wantsSummary ? "consumed" : "target");
        const title = language === "en"
          ? wantsRemaining ? `Remaining nutrition for ${date}` : wantsSummary ? `Consumed nutrition for ${date}` : "Your daily nutrition targets"
          : wantsRemaining ? `المتبقي ليوم ${date}` : wantsSummary ? `المستهلك ليوم ${date}` : "أهدافك الغذائية اليومية";
        const message = lines.length > 0
          ? `${title}:\n${lines.join("\n")}`
          : language === "en" ? "The Backend responded, but it did not provide recognized numeric target/summary fields." : "الـBackend رد، لكن الاستجابة لم تحتوِ على حقول أرقام معروفة للهدف أو الملخص.";
        return backendContextResponse(language, wantsRemaining ? "remaining" : wantsSummary ? "daily_summary" : "targets", message, { date, targets, summary, calculated: values });
      }
      return backendContextResponse(language, "unavailable", language === "en" ? "This Backend capability is not available in the configured adapter." : "القدرة دي مش متاحة في إعداد الـBackend Adapter الحالي.", {});
    } catch (cause) {
      const record = typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : {};
      if (record.code === "invalid_token" || record.status === 401 || record.status === 403) return authFailure();
      return {
        status: "no_result", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en" ? "I could not read your current Backend nutrition data. Nothing was guessed." : "مقدرتش أقرأ بيانات التغذية الحالية من الـBackend، ومخمنتش أي أرقام.",
        data: { intent: "personal_backend_context", errorCode: "backend_unavailable" }, evidenceDocumentIds: [], provenance: [],
        toolTrace: [{ tool: "get_user_nutrition_context", ok: false, code: "backend_unavailable" }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
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

  private async recommendMealPlanWithBackendTarget(
    query: string,
    language: "ar-EG" | "ar" | "en",
    context?: GraduationConversationContext,
  ): Promise<ExpandedAgentResponse | null> {
    const initial = this.recommendMealPlan(query, language, context);
    if (!initial || initial.data?.requiredInput !== "daily_calorie_target") return initial;
    if (!this.backend?.getDailySummary) return initial;

    const date = requestedDate(query) ?? dateInCairo(Date.now());
    try {
      const summary = await this.backend.getDailySummary(date);
      let remaining = findBackendNumber(summary, ["caloriesRemaining", "remainingCalories", "remainingCaloriesKcal"]);
      if (remaining === null && this.backend.getNutritionTargets) {
        const targets = await this.backend.getNutritionTargets();
        remaining = personalNutritionValues(targets, summary).calories.remaining;
      }
      if (remaining === null) return initial;
      if (remaining < 300 || remaining > 5_000) {
        return {
          ...initial,
          status: "no_result",
          message: language === "en"
            ? `Your Backend reports ${remaining} kcal remaining for ${date}, which is outside the supported 300–5000 kcal range for a full meal plan. I did not invent or replace that value.`
            : `الـBackend مسجل إن المتبقي ليوم ${date} هو ${remaining} سعر حراري، وده خارج نطاق خطة اليوم الكاملة المدعوم من 300 إلى 5000 سعر. ما غيّرتش الرقم ولا افترضت رقم بديل.`,
          data: { intent: "meal_plan", reason: "backend_remaining_calories_out_of_range", backendNutritionDate: date, remainingCaloriesKcal: remaining },
          toolTrace: [{ tool: "get_user_nutrition_context", ok: true, code: null }],
        };
      }
      const planned = this.recommendMealPlan(`${query} ${remaining} kcal`, language, context);
      if (!planned) return initial;
      return {
        ...planned,
        message: language === "en"
          ? `Using your Backend balance of ${remaining} kcal remaining for ${date}:\n${planned.message}`
          : `بناءً على المتبقي المسجل في الـBackend ليوم ${date} وهو ${remaining} سعر حراري:\n${planned.message}`,
        data: { ...(planned.data ?? {}), calorieTargetSource: "backend_remaining_calories", backendNutritionDate: date, remainingCaloriesKcal: remaining },
        toolTrace: [{ tool: "get_user_nutrition_context", ok: true, code: null }, ...planned.toolTrace],
      };
    } catch {
      // Backend or authentication failure falls back to asking for the target. It must
      // never turn a valid meal-plan request into a false "recipe not found" result.
      return initial;
    }
  }

  private recommendMealPlan(query: string, language: "ar-EG" | "ar" | "en", context?: GraduationConversationContext): ExpandedAgentResponse | null {
    const normalized = normalizeNumberDigits(query);
    const previous = context?.lastIntent === "meal_plan" || context?.lastIntent === "meal_plan_draft" ? context : undefined;
    const wordMealCount = mealCountFromWords(normalized);
    const outOfRangeWordCount = hasOutOfRangeMealCountWord(normalized);
    const ambiguousOrMalformedMealCount = hasAmbiguousOrMalformedMealCount(normalized);
    const numericMealCountRequest = /-?\d+(?:\.\d+)?\s*(?:وجبه|وجبة|وجبات|meals?)/iu.test(normalized);
    const englishPlanRequest = wordMealCount !== null || outOfRangeWordCount || ambiguousOrMalformedMealCount || /\b(?:suggest|recommend|plan|prepare)\b.{0,24}\b(?:meals|meal\s+plan|food\s+plan)\b/iu.test(normalized);
    const isPlanRequest = /(?:حض(?:ر|ّ?ر)|جهز|اعمل|رتب).{0,30}(?:وجبات|اكل\s+اليوم)|\d+\s*(?:وجبات|meals?)|(?:وجبات|اكل)\s+(?:اليوم|يوم|طول\s+اليوم)|طول\s+اليوم|خطه\s+وجبات|خطة\s+وجبات|نظام\s+يوم|هدف(?:ي)?\s+(?:في\s+)?السعرات\s+اليومي|meal\s+plan|meals?\s+for\s+the\s+day|prepare.{0,20}meals?/iu.test(normalized);
    const hasDailyTargetWording = /(?:هدف(?:ي)?|السعرات\s+اليومي|في\s+اليوم|طول\s+اليوم|daily\s+(?:target|calories?))/iu.test(normalized);
    const countMatch = normalized.match(/(-?\d+(?:\.\d+)?)\s*(?:وجبه|وجبة|وجبات|meals?)/iu);
    const requestedMealCount = countMatch && !ambiguousOrMalformedMealCount ? Number(countMatch[1]) : outOfRangeWordCount || ambiguousOrMalformedMealCount ? Number.NaN : wordMealCount;
    const changesMealCount = /(?:زود|ضيف|اضف|قلل|احذف|شيل|increase|add|remove|reduce).{0,12}(?:وجبه|وجبة|وجبات|meal)/iu.test(normalized);
    const isPlanFollowup = Boolean(previous && (hasDailyTargetWording || requestedMealCount !== null || changesMealCount || hasIngredientExclusionRequest(normalized) || /(?:قلل|خفض|زود|ارفع|غير|بدل|خلي|اقل|اكتر|reduce|increase|change)/iu.test(normalized)));
    if (!isPlanRequest && !englishPlanRequest && !numericMealCountRequest && !isPlanFollowup) return null;
    const explicit = normalized.match(/(\d+(?:\.\d+)?)\s*(?:سعر(?:ة|ات)?(?:\s*حراري(?:ة|ه)?)?|كالوري|kcal|calories?)/iu);
    const amount = explicit ? Number(explicit[1]) : null;
    const previousMealCount = previous?.mealCount ?? 3;
    const relativeMealCount = changesMealCount
      ? /(?:زود|ضيف|اضف|increase|add)/iu.test(normalized) ? previousMealCount + 1 : previousMealCount - 1
      : null;
    const mealCount = requestedMealCount ?? relativeMealCount ?? previousMealCount;
    if (!Number.isInteger(mealCount) || mealCount < 1 || mealCount > 10) {
      return {
        status: "clarification", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en" ? "I can build a bounded example containing 1 to 10 meals. Choose a meal count in that range." : "أقدر أجهز مثالًا محسوبًا من وجبة واحدة لحد 10 وجبات. اختار عددًا داخل النطاق ده.",
        data: { intent: "meal_plan", requiredInput: "meal_count_between_1_and_10" }, evidenceDocumentIds: [], provenance: [], toolTrace: [], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const maximumWording = /(?:لا\s*(?:يتخط|يتجاوز|يزيد)|ما\s*(?:يتخط|يتجاوز|يزيد)|بحد\s*(?:اقصي|أقصى)|حد\s*(?:اقصي|أقصى)|تحت|اقل\s+من|أقل\s+من|at\s+most|maximum|under|not\s+exceed|no\s+more\s+than)/iu.test(normalized);
    const calorieConstraint: "target" | "maximum" = maximumWording ? "maximum" : previous?.calorieConstraint ?? "target";
    const previousTarget = previous?.lastIntent === "meal_plan" ? previous.calorieTargetKcal : undefined;
    let target = amount ?? previousTarget;
    if (isPlanFollowup && previous?.lastIntent === "meal_plan" && !changesMealCount && !hasDailyTargetWording && /(?:قلل|خفض|زود|ارفع|اقل|اكتر|reduce|increase)/iu.test(normalized)) {
      const delta = amount ?? 200;
      target = /(?:زود|ارفع|اكتر|increase)/iu.test(normalized) ? previous.calorieTargetKcal + delta : previous.calorieTargetKcal - delta;
    }
    const exclusions = new Set([...previous?.excludedIngredientKeys ?? [], ...excludedIngredientKeys(query)]);
    if (target === null || target === undefined) {
      const conversationContext: MealPlanDraftConversationContext = { schemaVersion: "1.0", lastIntent: "meal_plan_draft", mealCount, excludedIngredientKeys: [...exclusions], calorieConstraint };
      return {
        status: "clarification", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en" ? `What daily calorie ${calorieConstraint === "maximum" ? "maximum" : "target"} should the ${mealCount}-meal example use? For example: “2000 kcal.”` : `تمام، هجهز ${mealCount} ${mealCount === 1 ? "وجبة" : "وجبات"}. هدفك اليومي كام سعر حراري؟ مثال: «2000 سعر حراري».`,
        data: { intent: "meal_plan", requiredInput: "daily_calorie_target", conversationContext }, evidenceDocumentIds: [], provenance: [], toolTrace: [], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    if (!Number.isFinite(target) || target < 300 || target > 5_000) {
      return {
        status: "clarification", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en" ? "Give me a daily calorie target between 300 and 5000 kcal." : "اكتب هدف سعرات يومي بين 300 و5000 سعر حراري.",
        data: { intent: "meal_plan", requiredInput: "daily_calorie_target_between_300_and_5000" }, evidenceDocumentIds: [], provenance: [], toolTrace: [], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const used = new Set<string>();
    const recentRecipeIds = new Set(context?.memory?.recentRecipeIds ?? []);
    const choose = (categories: ReadonlySet<string>, desired: number) => rankHealthFirst(this.dataset.recipes
      .filter((recipe) => categories.has(recipe.category) && !used.has(recipe.recipe_id) && !recipeContainsExcludedIngredient(recipe, exclusions))
      .map((recipe) => {
        const calculation = calculateUnifiedDemoNutrition(this.dataset, recipe);
        return { recipe, calculation, assessment: assessNutritionBalance(recipe, calculation) };
      }), context?.memory?.recentRecipeIds)
      .map((entry) => ({ ...entry, portion: calculatePortionForCalories(entry.calculation, desired, entry.recipe.servings, calorieConstraint === "maximum" ? "floor" : "nearest") }))
      .filter((entry): entry is typeof entry & { portion: CalculatedPortion } => entry.portion !== null)
      .filter((entry) => entry.portion.servingFraction >= 0.25 && entry.portion.servingFraction <= 2)
      .sort((left, right) => Number(recentRecipeIds.has(left.recipe.recipe_id)) - Number(recentRecipeIds.has(right.recipe.recipe_id))
        || right.assessment.score - left.assessment.score
        || Math.abs(1 - left.portion.servingFraction) - Math.abs(1 - right.portion.servingFraction)
        || left.recipe.recipe_id.localeCompare(right.recipe.recipe_id))[0];
    const slotDefinitions = {
      breakfast: { categories: new Set(["breakfast", "bread"]), groupShare: 0.25 },
      lunch: { categories: new Set(["main_dish"]), groupShare: 0.4 },
      dinner: { categories: new Set(["main_dish", "soup", "salad"]), groupShare: 0.35 },
    } as const;
    const slotCounts = mealCount === 1
      ? { breakfast: 0, lunch: 1, dinner: 0 }
      : mealCount === 2
        ? { breakfast: 1, lunch: 1, dinner: 0 }
        : { breakfast: 1, lunch: 1, dinner: 1 };
    const extraSlotOrder = ["lunch", "dinner", "breakfast"] as const;
    for (let index = 3; index < mealCount; index += 1) slotCounts[extraSlotOrder[(index - 3) % extraSlotOrder.length]!] += 1;
    const requestedSlots = (Object.keys(slotDefinitions) as Array<keyof typeof slotDefinitions>).flatMap((key) => {
      const count = slotCounts[key];
      const definition = slotDefinitions[key];
      return Array.from({ length: count }, (_, index) => ({
        key,
        index: index + 1,
        categories: definition.categories,
        share: definition.groupShare / count,
      }));
    });
    const meals: Array<{ slot: string; recipe: UnifiedDemoRecipe; portion: CalculatedPortion; healthScore: number }> = [];
    for (const slot of requestedSlots) {
      const caloriesUsed = meals.reduce((sum, meal) => sum + (meal.portion.nutrition.kcal ?? 0), 0);
      const slotsRemaining = mealCount - meals.length;
      const desired = calorieConstraint === "maximum" ? Math.max(0, (target - caloriesUsed) / slotsRemaining) : target * slot.share;
      const selected = choose(slot.categories, desired);
      if (!selected) break;
      used.add(selected.recipe.recipe_id);
      meals.push({ slot: slot.key, recipe: selected.recipe, portion: selected.portion, healthScore: selected.assessment.score });
    }
    if (meals.length !== mealCount) {
      const conversationContext: MealPlanDraftConversationContext = { schemaVersion: "1.0", lastIntent: "meal_plan_draft", mealCount, excludedIngredientKeys: [...exclusions], calorieConstraint };
      return {
        status: "no_result", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en" ? `The recorded recipes cannot satisfy ${mealCount} distinct meals under all of those rules. I did not silently ignore any rule.` : `الوصفات المسجلة لا تكفي لتجهيز ${mealCount} وجبات مختلفة مع كل الشروط دي. ما تجاهلتش أي شرط من غير ما أوضح.`,
        data: { intent: "meal_plan", reasonCode: "rules_cannot_be_satisfied", targetCaloriesKcal: target, mealCount, calorieConstraint, excludedIngredientKeys: [...exclusions], rulesUnmet: ["distinct_meals_within_calorie_rule"], conversationContext }, evidenceDocumentIds: [], provenance: [], toolTrace: [{ tool: "calculate_nutrition", ok: false, code: "rules_cannot_be_satisfied" }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const total = Math.round(meals.reduce((sum, meal) => sum + (meal.portion.nutrition.kcal ?? 0), 0) * 10) / 10;
    const difference = Math.round((total - target) * 10) / 10;
    const labels: Record<string, string> = language === "en" ? { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" } : { breakfast: "الفطار", lunch: "الغداء", dinner: "العشاء" };
    const groupOrder = ["breakfast", "lunch", "dinner"];
    const sections = groupOrder.flatMap((slot) => {
      const group = meals.filter((meal) => meal.slot === slot);
      if (group.length === 0) return [];
      const lines = group.map((meal, index) => {
        const ingredients = recipeIngredientGrams(meal.recipe, language, meal.portion.servingFraction);
        const ingredientTitle = language === "en" ? "Ingredient input grams for this portion" : "جرامات المكونات الداخلة في الحصة";
        return `• ${index + 1}. ${language === "en" ? meal.recipe.name_en : meal.recipe.name_ar} — ${meal.portion.portionGrams} ${language === "en" ? "g" : "جرام"}, ${meal.portion.nutrition.kcal} ${language === "en" ? "kcal" : "سعر حراري"}\n  ${ingredientTitle}:\n${ingredientGramLines(ingredients, language, "    • ")}`;
      });
      const subtotal = Math.round(group.reduce((sum, meal) => sum + (meal.portion.nutrition.kcal ?? 0), 0) * 10) / 10;
      return [`${labels[slot]} (${group.length}):\n${lines.join("\n")}\n${language === "en" ? "Subtotal" : "الإجمالي"}: ${subtotal} ${language === "en" ? "kcal" : "سعر حراري"}`];
    });
    const exclusionNote = exclusions.size === 0 ? "" : language === "en"
      ? "\n\nI excluded recipes whose recorded ingredients match your exclusions. This is not an allergy or cross-contamination guarantee."
      : "\n\nاستبعدت الوصفات التي تحتوي مكوناتها المسجلة على العناصر المطلوبة. ده مش ضمان خلو من مسببات الحساسية أو التلوث التبادلي.";
    const conversationContext: MealPlanConversationContext = { schemaVersion: "1.0", lastIntent: "meal_plan", calorieTargetKcal: target, excludedIngredientKeys: [...exclusions], recipeIds: meals.map((meal) => meal.recipe.recipe_id), mealCount, calorieConstraint };
    const goalLabel = language === "en" ? calorieConstraint === "maximum" ? `a maximum of ${target}` : `a target of ${target}` : calorieConstraint === "maximum" ? `بحد أقصى ${target}` : `لهدف ${target}`;
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en" ? `${mealCount}-meal example with ${goalLabel} kcal for the day, divided into breakfast, lunch, and dinner:\n\n${sections.join("\n\n")}\n\nCalculated total: ${total} kcal${calorieConstraint === "target" ? ` (${difference >= 0 ? "+" : ""}${difference} from target)` : " (within the maximum)"}.${exclusionNote}\n\nThis is a general dataset-based example, not a personal prescription.` : `مثال ${mealCount} ${mealCount === 1 ? "وجبة" : "وجبات"} ${goalLabel} سعر حراري لليوم، مقسّمة إلى فطار وغداء وعشاء:\n\n${sections.join("\n\n")}\n\nالإجمالي المحسوب: ${total} سعر حراري${calorieConstraint === "target" ? ` (${difference >= 0 ? "+" : ""}${difference} عن الهدف)` : "، داخل الحد الأقصى"}.${exclusionNote}\n\nده مثال عام مبني على بيانات المشروع، مش وصفة علاجية أو نظام شخصي.`,
      data: { intent: "meal_plan", recommendationType: "daily_calorie_plan", recommendationPolicy: RECOMMENDATION_POLICY_VERSION, targetCaloriesKcal: target, totalCaloriesKcal: total, differenceCaloriesKcal: difference, mealCount, calorieConstraint, mealDistribution: slotCounts, rulesApplied: { maximumCaloriesKcal: calorieConstraint === "maximum" ? target : null, excludedIngredientKeys: [...exclusions], distinctRecipes: true, categorizedMeals: true, healthFirstRanking: true }, excludedIngredientKeys: [...exclusions], meals: meals.map((meal) => ({ slot: meal.slot, slotIndex: meals.filter((candidate) => candidate.slot === meal.slot).indexOf(meal) + 1, recipeId: meal.recipe.recipe_id, name: language === "en" ? meal.recipe.name_en : meal.recipe.name_ar, portionGrams: meal.portion.portionGrams, servingFraction: meal.portion.servingFraction, portionNutrition: meal.portion.nutrition, portionBasis: meal.portion.basis, ingredients: recipeIngredientGrams(meal.recipe, language, meal.portion.servingFraction), ingredientWeightBasis: "input_grams_scaled_to_selected_portion", nutritionBalanceScore: meal.healthScore, cuisineOrigin: meal.recipe.origin })), conversationContext },
      evidenceDocumentIds: meals.map((meal) => `DEMO-${meal.recipe.recipe_id}`), provenance: meals.map((meal) => this.recipeProvenance(meal.recipe, language)), toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private recommendToCalorieTarget(query: string, language: "ar-EG" | "ar" | "en", context?: GraduationConversationContext): ExpandedAgentResponse | null {
    const normalized = normalizeNumberDigits(query);
    const calorieContext = context?.lastIntent === "meal_calorie_target" ? context : undefined;
    const explicit = normalized.match(/(\d+(?:\.\d+)?)\s*(?:سعر(?:ة|ات)?(?:\s*حراري(?:ة|ه)?)?|كالوري|kcal|calories?)/iu);
    const lowerFollowup = /(?:أقل|اقل|تحت|less|lower|under)/iu.test(normalized);
    const higherFollowup = /(?:أكتر|اكتر|أكثر|اعلى|أعلى|more|higher|over)/iu.test(normalized);
    const freshExclusions = excludedIngredientKeys(query);
    if (!explicit && !calorieContext) return null;
    if (!explicit && !lowerFollowup && !higherFollowup && freshExclusions.length === 0) return null;
    const explicitTarget = explicit ? Number(explicit[1]) : null;
    const target = explicitTarget ?? (freshExclusions.length > 0
      ? calorieContext?.calorieTargetKcal
      : calorieContext?.lastRecommendationCaloriesKcal ?? calorieContext?.calorieTargetKcal);
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
    const exclusions = new Set([...calorieContext?.excludedIngredientKeys ?? [], ...freshExclusions]);
    const mealCategories = new Set(["main_dish", "breakfast", "soup"]);
    const namedRecipe = explicitlyNamedRecipe(this.dataset, query);
    const recentRecipeIds = new Set(context?.memory?.recentRecipeIds ?? []);
    const candidates = rankHealthFirst(this.dataset.recipes
      .filter((recipe) => namedRecipe ? recipe.recipe_id === namedRecipe.recipe_id : true)
      .filter((recipe) => category ? recipe.category === category : mealCategories.has(recipe.category))
      .filter((recipe) => !recipeContainsExcludedIngredient(recipe, exclusions))
      .map((recipe) => {
        const calculation = calculateUnifiedDemoNutrition(this.dataset, recipe);
        return { recipe, calculation, assessment: assessNutritionBalance(recipe, calculation) };
      }), context?.memory?.recentRecipeIds)
      .map((entry) => ({ ...entry, portion: calculatePortionForCalories(entry.calculation, desiredTarget, entry.recipe.servings) }))
      .filter((entry): entry is typeof entry & { portion: CalculatedPortion } => entry.portion !== null)
      .filter((entry) => entry.portion.servingFraction >= 0.2 && entry.portion.servingFraction <= 2.5)
      .sort((left, right) => Number(recentRecipeIds.has(left.recipe.recipe_id)) - Number(recentRecipeIds.has(right.recipe.recipe_id))
        || right.assessment.score - left.assessment.score
        || Math.abs(1 - left.portion.servingFraction) - Math.abs(1 - right.portion.servingFraction)
        || left.recipe.recipe_id.localeCompare(right.recipe.recipe_id));
    const selected = candidates[0];
    if (!selected) {
      return {
        status: "no_result", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en" ? `I could not find a recorded meal ${relation === "below" ? "below" : relation === "above" ? "above" : "close to"} ${target} kcal per serving in the current dataset.` : `ملقتش وجبة مسجلة ${relation === "below" ? "أقل من" : relation === "above" ? "أعلى من" : "قريبة من"} ${target} سعر حراري للحصة في البيانات الحالية.`,
        data: { intent: "find_recipe", recommendationType: "calorie_target", targetCaloriesKcal: target, relation }, evidenceDocumentIds: [], provenance: [], toolTrace: [{ tool: "calculate_nutrition", ok: false, code: "no_matching_meal" }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const name = language === "en" ? selected.recipe.name_en : selected.recipe.name_ar;
    const calories = selected.portion.nutrition.kcal!;
    const difference = Math.round(Math.abs(calories - target) * 10) / 10;
    const energyReconciliation = reconcileEnergyWithMacros(selected.portion.nutrition);
    const macroDifferenceFromTarget = energyReconciliation === null ? null : Math.round(Math.abs(energyReconciliation.macroEstimateKcal - target) * 10) / 10;
    const relationText = language === "en" ? relation === "below" ? `the closest meal below ${target}` : relation === "above" ? `the closest meal above ${target}` : `the closest meal to ${target}`
      : relation === "below" ? `أقرب وجبة أقل من ${target}` : relation === "above" ? `أقرب وجبة أعلى من ${target}` : `أقرب وجبة لهدف ${target}`;
    const conversationContext: GraduationConversationContext = { schemaVersion: "1.0", lastIntent: "meal_calorie_target", calorieTargetKcal: target, category, relation, lastRecommendationCaloriesKcal: calories, excludedIngredientKeys: [...exclusions], recipeId: selected.recipe.recipe_id };
    const exclusionNote = exclusions.size === 0 ? "" : language === "en"
      ? " The recorded ingredients matching your exclusions were filtered out; this is not an allergy or cross-contamination guarantee."
      : " تم استبعاد الوصفات التي تحتوي مكوناتها المسجلة على العناصر المطلوبة، لكن ده مش ضمان حساسية أو خلو من التلوث التبادلي.";
    const portionIngredients = recipeIngredientGrams(selected.recipe, language, selected.portion.servingFraction);
    const portionIngredientText = language === "en"
      ? `\n\nIngredient input weights for this portion:\n${ingredientGramLines(portionIngredients, language)}`
      : `\n\nأوزان المكونات الداخلة في الحصة:\n${ingredientGramLines(portionIngredients, language)}`;
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en" ? `${relationText} is ${name}: about ${selected.portion.portionGrams} g provides ${calories} kcal, ${selected.portion.nutrition.protein ?? "unknown"} g protein, ${selected.portion.nutrition.carbs ?? "unknown"} g carbohydrates, and ${selected.portion.nutrition.fat ?? "unknown"} g fat. The grams are calculated from the verified per-100g snapshot. Difference from the target: ${difference} kcal.${energyReconciliationNote(selected.portion.nutrition, language)}${macroDifferenceFromTarget === null ? "" : ` Difference using the 4/4/9 check: ${macroDifferenceFromTarget} kcal.`}${exclusionNote}${portionIngredientText}` : `${relationText} هي ${name}: حوالي ${selected.portion.portionGrams} جرام تعطي ${calories} سعر حراري، ${selected.portion.nutrition.protein ?? "غير متوفر"} جم بروتين، ${selected.portion.nutrition.carbs ?? "غير متوفر"} جم كربوهيدرات، و${selected.portion.nutrition.fat ?? "غير متوفر"} جم دهون. الجرامات محسوبة من القيمة الموثقة لكل 100 جرام. الفرق عن الهدف ${difference} سعر حراري.${energyReconciliationNote(selected.portion.nutrition, language)}${macroDifferenceFromTarget === null ? "" : ` والفرق حسب فحص 4/4/9 هو ${macroDifferenceFromTarget} سعر حراري.`}${exclusionNote}${portionIngredientText}`,
      data: { intent: "find_recipe", recommendationType: "calorie_target", recommendationPolicy: RECOMMENDATION_POLICY_VERSION, targetCaloriesKcal: target, relation, differenceCaloriesKcal: difference, differenceBasis: "verified_per_100g_portion", macroDifferenceFromTargetKcal: macroDifferenceFromTarget, energyReconciliation, excludedIngredientKeys: [...exclusions], recipeId: selected.recipe.recipe_id, recipeName: name, caloriesPerServingKcal: calories, portionCaloriesKcal: calories, portionGrams: selected.portion.portionGrams, servingFraction: selected.portion.servingFraction, portionNutrition: selected.portion.nutrition, portionBasis: selected.portion.basis, ingredients: portionIngredients, ingredientWeightBasis: "input_grams_scaled_to_selected_portion", nutritionBalanceScore: selected.assessment.score, nutritionBalanceAssessment: selected.assessment, cuisineOrigin: selected.recipe.origin, locallyAvailableInEgypt: selected.recipe.origin === "Egypt", conversationContext },
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
      .map((recipe) => {
        const calculation = calculateUnifiedDemoNutrition(this.dataset, recipe);
        return { recipe, calculation, nutrition: calculation.perServing, assessment: assessNutritionBalance(recipe, calculation) };
      })
      .filter((entry) => entry.nutrition[target] !== null)
      .sort((a, b) => {
        const first = a.nutrition[target] ?? 0;
        const second = b.nutrition[target] ?? 0;
        return (wantsLow ? first - second : second - first)
          || b.assessment.score - a.assessment.score
          || a.recipe.recipe_id.localeCompare(b.recipe.recipe_id);
      });
    const selected = candidates[0];
    if (!selected) return null;
    const name = language === "en" ? selected.recipe.name_en : selected.recipe.name_ar;
    const units = target === "sodium" ? (language === "en" ? "mg" : "مجم") : target === "kcal" ? (language === "en" ? "kcal" : "سعر حراري") : language === "en" ? "g" : "جم";
    const labels = language === "en"
      ? { protein: "protein", fiber: "fiber", sodium: "sodium", kcal: "calories" }
      : { protein: "البروتين", fiber: "الألياف", sodium: "الصوديوم", kcal: "السعرات" };
    const value = selected.nutrition[target];
    const ingredients = recipeIngredientGrams(selected.recipe, language, 1);
    const ingredientText = ingredientGramLines(ingredients, language);
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en" ? `${name} is the strongest matching option in the current project dataset for ${wantsLow ? "lower" : "higher"} ${labels[target]}: about ${value} ${units} in a ${Math.round(selected.calculation.finalWeightG / selected.recipe.servings)} g serving.\n\nIngredient input weights for one serving:\n${ingredientText}\n\nThis is a dataset-based suggestion, not a personalized diet.` : `${name} هو الاختيار الأقرب في بيانات المشروع لطلب ${wantsLow ? "الأقل" : "الأعلى"} في ${labels[target]}: حوالي ${value} ${units} في حصة ${Math.round(selected.calculation.finalWeightG / selected.recipe.servings)} جرام.\n\nأوزان المكونات الداخلة في الحصة:\n${ingredientText}\n\nده اقتراح من البيانات، مش نظام غذائي شخصي.`,
      data: { intent: "find_recipe", recommendationType: "nutrition_ranked", recommendationPolicy: RECOMMENDATION_POLICY_VERSION, targetNutrient: target, direction: wantsLow ? "lower" : "higher", recipeId: selected.recipe.recipe_id, recipeName: name, portionGrams: Math.round(selected.calculation.finalWeightG / selected.recipe.servings), ingredients, ingredientWeightBasis: "input_grams_for_one_recorded_serving", perServing: selected.nutrition, nutritionBalanceScore: selected.assessment.score, cuisineOrigin: selected.recipe.origin },
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
      const calculation = calculateUnifiedDemoNutrition(this.dataset, recipe);
      return { recipe, matched, calculation, assessment: assessNutritionBalance(recipe, calculation) };
    }).filter((entry) => entry.matched.length > 0).sort((a, b) => b.matched.length - a.matched.length || b.assessment.score - a.assessment.score || a.recipe.recipe_id.localeCompare(b.recipe.recipe_id));
    const selected = candidates[0];
    if (!selected) return null;
    const name = language === "en" ? selected.recipe.name_en : selected.recipe.name_ar;
    const matchedLabels = selected.matched.map((key) => ingredientLabel(key, language));
    const ingredients = recipeIngredientGrams(selected.recipe, language, 1);
    const ingredientText = ingredientGramLines(ingredients, language);
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en" ? `${name} is the closest Egyptian recipe in the project data to the ingredients you listed (${matchedLabels.join(", ")}). You may still need additional ingredients.\n\nIngredient input weights for one serving:\n${ingredientText}` : `${name} هي أقرب وصفة مصرية في بيانات المشروع للمكونات اللي ذكرتها (${matchedLabels.join("، ")})، وقد تحتاج مكونات إضافية.\n\nأوزان المكونات الداخلة في الحصة:\n${ingredientText}`,
      data: { intent: "find_recipe", recommendationType: "ingredient_overlap", recommendationPolicy: RECOMMENDATION_POLICY_VERSION, recipeId: selected.recipe.recipe_id, recipeName: name, portionGrams: Math.round(selected.calculation.finalWeightG / selected.recipe.servings), ingredients, ingredientWeightBasis: "input_grams_for_one_recorded_serving", matchedIngredients: selected.matched, nutritionBalanceScore: selected.assessment.score, cuisineOrigin: selected.recipe.origin }, evidenceDocumentIds: [`DEMO-${selected.recipe.recipe_id}`], provenance: [this.recipeProvenance(selected.recipe, language)], toolTrace: [{ tool: "search_recipes", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
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
      sourceId: GRADUATION_RECIPE_SOURCE_ID,
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
    const ingredients = recipeIngredientGrams(recipe, language, null);
    message += language === "en"
      ? `\n\nIngredient input weights for the full recorded recipe:\n${ingredientGramLines(ingredients, language)}`
      : `\n\nأوزان المكونات الداخلة في الوصفة الكاملة:\n${ingredientGramLines(ingredients, language)}`;
    return {
      status: "ok", primaryIntent: "recipe_nutrition", language, safetyFlags: [], integrityFlags: [], message,
      data: { intent: "recipe_nutrition", demoOnly: true, reviewStatus: this.dataset.metadata.review_status, recipeId: recipe.recipe_id, recipeName: name, servings: recipe.servings, finalWeightG: calculation.finalWeightG, ingredients, ingredientWeightBasis: "input_grams_for_full_recorded_recipe", fullRecipe: calculation.totals, perServing: calculation.perServing, per100g: calculation.per100g, caloriesPerServingKcal: calculation.perServing.kcal, caloriesPer100gKcal: calculation.per100g.kcal, totalRecipeCaloriesKcal: calculation.totals.kcal, saturatedFat: null, conversationContext: { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: recipe.recipe_id } },
      evidenceDocumentIds: [`DEMO-${recipe.recipe_id}`], provenance: [this.recipeProvenance(recipe, language)],
      toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private compareRecipes(first: UnifiedDemoRecipe, second: UnifiedDemoRecipe, query: string, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse {
    const firstCalculation = calculateUnifiedDemoNutrition(this.dataset, first);
    const secondCalculation = calculateUnifiedDemoNutrition(this.dataset, second);
    const basis = /(?:حصة|للحصه|للحصة|per serving)/iu.test(query) ? "perServing" : "per100g";
    const firstName = language === "en" ? first.name_en : first.name_ar;
    const secondName = language === "en" ? second.name_en : second.name_ar;
    const basisLabel = basis === "perServing" ? (language === "en" ? "per serving" : "للحصة") : (language === "en" ? "per 100 g" : "لكل 100 جرام");
    const metrics = [
      { key: "kcal", ar: "السعرات", en: "Calories", unitAr: "سعر حراري", unitEn: "kcal", pattern: /(?:سعر|كالوري|calorie|kcal)/iu, overview: true },
      { key: "protein", ar: "البروتين", en: "Protein", unitAr: "جم", unitEn: "g", pattern: /(?:بروتين|protein)/iu, overview: true },
      { key: "carbs", ar: "الكربوهيدرات", en: "Carbohydrates", unitAr: "جم", unitEn: "g", pattern: /(?:كربوهيدرات|كارب|carb)/iu, overview: true },
      { key: "fat", ar: "الدهون", en: "Total fat", unitAr: "جم", unitEn: "g", pattern: /(?:دهون|fat)/iu, overview: true },
      { key: "fiber", ar: "الألياف", en: "Fiber", unitAr: "جم", unitEn: "g", pattern: /(?:ألياف|الياف|fiber)/iu, overview: true },
      { key: "sugar", ar: "السكر", en: "Sugar", unitAr: "جم", unitEn: "g", pattern: /(?:سكر|sugar)/iu, overview: false },
      { key: "sodium", ar: "الصوديوم", en: "Sodium", unitAr: "مجم", unitEn: "mg", pattern: /(?:صوديوم|ملح|sodium|salt)/iu, overview: true },
    ] as const;
    const requestedMetrics = metrics.filter((metric) => metric.pattern.test(query));
    if (requestedMetrics.length !== 1) {
      const displayedMetrics = requestedMetrics.length > 0 ? requestedMetrics : metrics.filter((metric) => metric.overview);
      const values = Object.fromEntries(displayedMetrics.map((metric) => [metric.key, {
        first: firstCalculation[basis][metric.key], second: secondCalculation[basis][metric.key],
        unit: language === "en" ? metric.unitEn : metric.unitAr,
      }]));
      const lines = displayedMetrics.map((metric) => {
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
        data: { intent: "compare_recipes", comparisonType: requestedMetrics.length > 0 ? "requested_metrics" : "overview", requestedNutrients: requestedMetrics.map((metric) => metric.key), demoOnly: true, reviewStatus: this.dataset.metadata.review_status, basis: basis === "perServing" ? "per_serving" : "per_100g", first: { recipeId: first.recipe_id, name: firstName }, second: { recipeId: second.recipe_id, name: secondName }, metrics: values, conversationContext: { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: first.recipe_id } },
        evidenceDocumentIds: [`DEMO-${first.recipe_id}`, `DEMO-${second.recipe_id}`], provenance: [this.recipeProvenance(first, language), this.recipeProvenance(second, language)],
        toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const nutrient = requestedMetrics[0]!.key;
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
      data: { intent: "compare_recipes", demoOnly: true, reviewStatus: this.dataset.metadata.review_status, basis: basis === "perServing" ? "per_serving" : "per_100g", nutrient, first: { recipeId: first.recipe_id, name: firstName, value: firstValue }, second: { recipeId: second.recipe_id, name: secondName, value: secondValue }, unit, conversationContext: { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: first.recipe_id } },
      evidenceDocumentIds: [`DEMO-${first.recipe_id}`, `DEMO-${second.recipe_id}`], provenance: [this.recipeProvenance(first, language), this.recipeProvenance(second, language)],
      toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private lighterModification(recipe: UnifiedDemoRecipe, query: string, language: "ar-EG" | "ar" | "en", context?: LighterModificationConversationContext): ExpandedAgentResponse {
    const asksForExclusion = hasIngredientExclusionRequest(query)
      && !/(?:نسخ(?:ه|ة)\s+(?:اخف|أخف)|(?:ا|أ)?قلل|قلل|خفف|كتير|زياده|زيادة|lighter\s+(?:version|alternative))/iu.test(query);
    if (asksForExclusion) {
      const requested = new Set(excludedIngredientKeys(query));
      const targetText = exclusionTargetText(query);
      const genericOil = /(?:زيت|دهون|oil|added fat)/iu.test(targetText);
      const removable = recipe.ingredients.filter((item) => requested.has(item.ingredient) || (genericOil && ADDED_FAT_INGREDIENT_KEYS.has(item.ingredient)));
      if (removable.length === 0) {
        const name = language === "en" ? recipe.name_en : recipe.name_ar;
        return {
          status: "no_result", primaryIntent: "lighter_recipe", language, safetyFlags: [], integrityFlags: [],
          message: language === "en" ? `I found ${name}, but I could not match the excluded ingredient to an ingredient recorded in that recipe. I will not return the original recipe as if the exclusion were applied.` : `وجدت ${name}، لكن ما قدرتش أطابق المكوّن المطلوب استبعاده مع مكوّن مسجل في الوصفة. مش هاعرض الوصفة الأصلية كأن الاستبعاد اتطبق.`,
          data: { intent: "lighter_modification", reasonCode: "excluded_ingredient_not_resolved", recipeId: recipe.recipe_id }, evidenceDocumentIds: [`DEMO-${recipe.recipe_id}`], provenance: [this.recipeProvenance(recipe, language)], toolTrace: [{ tool: "calculate_nutrition", ok: false, code: "excluded_ingredient_not_resolved" }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
        };
      }
      const original = calculateUnifiedDemoNutrition(this.dataset, recipe);
      const removableItems = new Set(removable);
      const removedWeight = removable.reduce((sum, item) => sum + item.grams, 0);
      const modifiedRecipe: UnifiedDemoRecipe = {
        ...recipe,
        ingredients: recipe.ingredients.filter((item) => !removableItems.has(item)),
        final_yield_weight_grams: Math.max(1, recipe.final_yield_weight_grams - removedWeight),
      };
      const modified = calculateUnifiedDemoNutrition(this.dataset, modifiedRecipe);
      const removedNames = removable.map((item) => ingredientLabel(item.ingredient, language));
      const displayName = modifiedRecipeDisplayName(recipe, removable.map((item) => item.ingredient), language);
      const saved = original.perServing.kcal === null || modified.perServing.kcal === null ? null : Math.round((original.perServing.kcal - modified.perServing.kcal) * 10) / 10;
      const remaining = modifiedRecipe.ingredients.map((item) => `• ${item.quantity} ${localizedUnit(item.unit, language)} ${ingredientLabel(item.ingredient, language)}`).join("\n");
      const nutritionSummary = perServingNutritionSummary(modified.perServing, language);
      const safetyNote = exclusionSafetyNote(removedNames, language);
      return {
        status: "ok", primaryIntent: "lighter_recipe", language, safetyFlags: [], integrityFlags: [],
        message: language === "en"
          ? `${displayName}\n\nIngredients after exclusion:\n${remaining}\n\n${nutritionSummary}${saved === null ? "" : ` The calculated reduction is about ${saved} kcal per serving.`}\n\n${safetyNote}\n\nRemoving an ingredient may change feasibility, taste, and texture.`
          : `${displayName}\n\nالمكونات بعد الاستبعاد:\n${remaining}\n\n${nutritionSummary}${saved === null ? "" : ` الانخفاض المحسوب حوالي ${saved} سعر حراري للحصة.`}\n\n${safetyNote}\n\nحذف المكوّن قد يغيّر قابلية التنفيذ والطعم والقوام.`,
        data: { intent: "lighter_modification", modificationType: "ingredient_exclusion", recipeId: recipe.recipe_id, displayName, removedIngredient: { key: removable[0]!.ingredient, grams: removable[0]!.grams }, removedIngredients: removable.map((item) => ({ key: item.ingredient, displayName: ingredientLabel(item.ingredient, language), grams: item.grams })), remainingIngredients: modifiedRecipe.ingredients.map((item) => ({ ...item, displayName: ingredientLabel(item.ingredient, language) })), originalNutrition: original, modifiedNutrition: modified, caloriesSavedPerServingKcal: saved, safetyDisclaimer: safetyNote, conversationContext: { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: recipe.recipe_id } }, evidenceDocumentIds: [`DEMO-${recipe.recipe_id}`], provenance: [this.recipeProvenance(recipe, language)], toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const candidate = recipe.ingredients.filter((item) => ADDED_FAT_INGREDIENT_KEYS.has(item.ingredient) && item.state !== "frying" && item.grams >= 10).sort((a, b) => b.grams - a.grams)[0];
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
      data: { intent: "lighter_modification", demoOnly: true, reviewStatus: this.dataset.metadata.review_status, recipeId: recipe.recipe_id, modification: { ingredient: candidate.ingredient, originalGrams: candidate.grams, ...(continuing ? { previousGrams: currentGrams } : {}), proposedGrams }, originalCalories: { fullRecipe: calculation.totals.kcal, perServing: calculation.perServing.kcal }, previousModifiedCalories: { perServing: previousPerServing }, modifiedCalories: { fullRecipe: newFull, perServing: newPerServing }, caloriesSaved: { fullRecipe: Math.round(savedFull * 10) / 10, perServing: savedPerServing, additionalPerServing: incrementalSavedPerServing }, conversationContext },
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
        data: { intent: "general_guideline", demoOnly: true, reviewStatus: this.dataset.metadata.review_status, guideline: { documentId: "DEMO-WHO-HEALTHY-DIET", title: "WHO Healthy Diet Fact Sheet" } },
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
        data: { intent: "general_guideline", demoOnly: true, reviewStatus: this.dataset.metadata.review_status, guideline: { documentId: "DEMO-WHO-SODIUM", title: "WHO Sodium Reduction Fact Sheet" } }, evidenceDocumentIds: ["DEMO-WHO-SODIUM"], provenance: [{ sourceId: "DEMO-WHO-GUIDANCE", versionId: "2.0-final-demo-normalized", title: "WHO Sodium Reduction Fact Sheet", url: "https://www.who.int/news-room/fact-sheets/detail/salt-reduction", accessedAt: this.dataset.metadata.created_date, locator: "WHO-SODIUM" }], toolTrace: [{ tool: "search_guidelines", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
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
      data: { intent: "general_guideline", demoOnly: true, reviewStatus: this.dataset.metadata.review_status, guideline: { documentId: hit.document.id, title: hit.document.title } }, evidenceDocumentIds: [hit.document.id], provenance: search.provenance,
      toolTrace: [{ tool: "search_guidelines", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private nutritionConceptAnswer(query: string, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse | null {
    // Concept matching must preserve lexical prefixes. The recipe lookup normalizer
    // intentionally removes Arabic definite articles, but doing that to words such
    // as "ألياف" turns them into an unrelated token and breaks ordinary questions.
    const normalized = normalizeNumberDigits(query)
      .normalize("NFKD")
      .toLocaleLowerCase("ar-EG")
      .replace(/[\u064B-\u065F\u0670]/gu, "")
      .replace(/[آأإٱ]/gu, "ا")
      .replace(/ى/gu, "ي")
      .replace(/ة/gu, "ه")
      .replace(/ـ/gu, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    const asksForExplanation = /(?:ما\s+(?:هو|هي|هى)|يعني\s+ايه|معني|اشرح|الفرق|هل|مضر|صحي|فائده|فوائد|اضرار|what\s+(?:is|are)|explain|difference|healthy|harmful)/iu.test(normalized);
    if (!asksForExplanation) return null;

    type Concept = { key: string; ar: string; en: string; documentId: string; title: string; url: string };
    let concept: Concept | null = null;
    const saturated = /(?:(?:ال)?دهون\s+(?:ال)?مشبعه|saturated\s+fat)/iu.test(normalized);
    const unsaturated = /(?:غير\s+(?:ال)?مشبعه|unsaturated\s+fat)/iu.test(normalized);
    const trans = /(?:(?:ال)?دهون\s+(?:ال)?متحوله|trans\s+fat)/iu.test(normalized);
    if (saturated && unsaturated) {
      concept = {
        key: "saturated_vs_unsaturated_fat",
        ar: "الدهون المشبعة وغير المشبعة فئتان من الدهون الغذائية. توصي إرشادات المشروع بتقليل الدهون المشبعة واستبدالها قدر الإمكان بمصادر دهون غير مشبعة، مع بقاء إجمالي الدهون في حدود معتدلة. من أمثلة المصادر المسجلة للدهون المشبعة: السمن البلدي واللحوم الدهنية والجلد. لا يستخدم NutriGuard هذا الشرح للحكم طبيًا على شخص أو وصفة بعينها.",
        en: "Saturated and unsaturated fats are two dietary-fat categories. The project guidance recommends limiting saturated fat and replacing it where practical with unsaturated-fat sources while keeping total fat moderate. Recorded saturated-fat examples include ghee, fatty meat, and skin. NutriGuard does not use this explanation to make a medical judgment about a person or a specific recipe.",
        documentId: "DEMO-WHO-FAT", title: "WHO Healthy Diet — Dietary Fats", url: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
      };
    } else if (saturated) {
      concept = {
        key: "saturated_fat",
        ar: "الدهون المشبعة نوع من الدهون الغذائية. في إرشادات المشروع تشمل مصادرها السمن البلدي واللحوم الدهنية والجلد، وتوصي منظمة الصحة العالمية بألا تتجاوز 10% من إجمالي الطاقة. النسبة حد عام للسكان وليست تشخيصًا أو حكمًا على أكلة بعينها.",
        en: "Saturated fat is a type of dietary fat. Project guidance lists ghee, fatty meat, and skin among its sources, and WHO guidance limits it to no more than 10% of total energy. This is general population guidance, not a diagnosis or a judgment about one dish.",
        documentId: "DEMO-WHO-FAT", title: "WHO Healthy Diet — Dietary Fats", url: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
      };
    } else if (trans) {
      concept = {
        key: "trans_fat",
        ar: "الدهون المتحولة فئة من الدهون توصي إرشادات المشروع بتجنبها قدر الإمكان، وألا تتجاوز 1% من إجمالي الطاقة. لا يفترض NutriGuard أن قيمتها صفر في أي وصفة إذا لم تكن مسجلة.",
        en: "Trans fat is a dietary-fat category that project guidance recommends avoiding as far as possible and limiting to no more than 1% of total energy. NutriGuard never assumes it is zero in a recipe when the value is missing.",
        documentId: "DEMO-WHO-FAT", title: "WHO Healthy Diet — Dietary Fats", url: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
      };
    } else if (unsaturated) {
      concept = {
        key: "unsaturated_fat",
        ar: "الدهون غير المشبعة فئة من الدهون تشمل الدهون الأحادية والمتعددة غير المشبعة. تعرضها الإرشادات العامة كبديل أفضل من الدهون المشبعة، لكن بيانات المشروع الحالية لا تضع لها رقمًا يوميًا مستقلًا؛ لذلك لن يخترع NutriGuard حدًا غير مسجل.",
        en: "Unsaturated fats include monounsaturated and polyunsaturated fats. General guidance presents them as preferable replacements for saturated fat, but the current project corpus has no separate daily numeric target for them, so NutriGuard will not invent one.",
        documentId: "DEMO-WHO-FAT", title: "WHO Healthy Diet — Dietary Fats", url: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
      };
    } else if (/(?:سكريات?\s+حره|سكر|sugar)/iu.test(normalized)) {
      concept = {
        key: "free_sugars",
        ar: "السكريات الحرة تشمل السكر المضاف والعسل وشراب الفاكهة. توصي إرشادات المشروع بألا تتجاوز 10% من إجمالي الطاقة، والأفضل أقل من 5%. عند 2000 سعر حراري يعادل ذلك حدًا أقصى 50 جرامًا، والأفضل 25 جرامًا. دي إرشادات عامة وليست هدفًا شخصيًا.",
        en: "Free sugars include added sugar, honey, and fruit syrups. Project guidance limits them to less than 10% of total energy and preferably below 5%. At 2,000 kcal, that corresponds to a maximum of 50 g and preferably 25 g. This is general guidance, not a personal target.",
        documentId: "DEMO-WHO-SUGAR", title: "WHO Free Sugars Guidance", url: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
      };
    } else if (/(?:صوديوم|ملح|sodium|salt)/iu.test(normalized)) {
      concept = {
        key: "sodium",
        ar: "الصوديوم معدن يدخل جزء كبير منه في الغذاء عن طريق الملح. توصي منظمة الصحة العالمية البالغين بأقل من 2000 مجم صوديوم يوميًا، أي أقل من 5 جرامات ملح. ده حد عام ولا يصنّف وصفة بعينها من غير معرفة قيمتها وحجم الحصة.",
        en: "Sodium is a mineral, much of which enters the diet through salt. WHO recommends adults consume less than 2,000 mg sodium per day, equivalent to less than 5 g salt. This general limit does not classify a recipe without its recorded value and serving size.",
        documentId: "DEMO-WHO-SODIUM", title: "WHO Sodium Reduction Guidance", url: "https://www.who.int/news-room/fact-sheets/detail/salt-reduction",
      };
    } else if (/(?:بروتين|protein)/iu.test(normalized)) {
      concept = {
        key: "protein",
        ar: "البروتين عنصر غذائي يمد الجسم بالأحماض الأمينية اللازمة لبناء الأنسجة وصيانتها. تعرض قاعدة NutriGuard كمية البروتين المسجلة لكل وصفة أو مكوّن، لكنها لا تحدد احتياجك الشخصي من غير تقييم مناسب.",
        en: "Protein supplies amino acids used to build and maintain body tissues. NutriGuard can report recorded protein for a recipe or ingredient, but it does not determine a personal requirement without an appropriate assessment.",
        documentId: "DEMO-WHO-HEALTHY-DIET", title: "WHO Healthy Diet Fact Sheet", url: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
      };
    } else if (/(?:كربوهيدرات|كارب|carbohydrate|carbs?)/iu.test(normalized)) {
      concept = {
        key: "carbohydrates",
        ar: "الكربوهيدرات مجموعة من العناصر الغذائية يستخدمها الجسم كمصدر للطاقة، وتشمل النشويات والسكريات والألياف. يعرض NutriGuard الكمية المسجلة، لكنه لا يخترع هدفًا شخصيًا أو يعتبر كل الأنواع متساوية.",
        en: "Carbohydrates are nutrients used by the body for energy and include starches, sugars, and fiber. NutriGuard reports recorded amounts but does not invent a personal target or treat every type as equivalent.",
        documentId: "DEMO-WHO-HEALTHY-DIET", title: "WHO Healthy Diet Fact Sheet", url: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
      };
    } else if (/(?:الياف|fiber)/iu.test(normalized)) {
      concept = {
        key: "fiber",
        ar: "الألياف نوع من الكربوهيدرات يوجد في الأغذية النباتية مثل الخضروات والفاكهة والبقول والحبوب الكاملة. يعرض NutriGuard القيمة المسجلة للوصفات، ولا يحول القيمة المفقودة إلى صفر.",
        en: "Fiber is a carbohydrate found in plant foods such as vegetables, fruit, legumes, and whole grains. NutriGuard reports recorded recipe values and never turns a missing value into zero.",
        documentId: "DEMO-WHO-HEALTHY-DIET", title: "WHO Healthy Diet Fact Sheet", url: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
      };
    } else if (/(?:(?:ال)?سعرات?\s+(?:ال)?حراريه|كالوري|طاقه|calorie|energy)/iu.test(normalized)) {
      concept = {
        key: "calories",
        ar: "السعرات الحرارية وحدة لقياس الطاقة التي يوفرها الطعام. يستطيع NutriGuard حساب السعرات من الكميات المسجلة، لكنه لا يحدد احتياجك الشخصي تلقائيًا لأن ذلك يحتاج بيانات وتقييمًا مناسبًا.",
        en: "Calories measure the energy supplied by food. NutriGuard can calculate calories from recorded quantities, but it does not automatically determine a personal requirement because that needs suitable inputs and assessment.",
        documentId: "DEMO-WHO-HEALTHY-DIET", title: "WHO Healthy Diet Fact Sheet", url: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
      };
    } else if (/(?:دهون|fat)/iu.test(normalized)) {
      concept = {
        key: "dietary_fat",
        ar: "الدهون عنصر غذائي ومصدر مركز للطاقة، وتشمل أنواعًا مشبعة وغير مشبعة ومتحولة. إرشادات المشروع تفرّق بين الأنواع ولا تعتبر كل الدهون متساوية، وتضع الدهون الكلية في نطاق 15–30% من الطاقة مع تقليل المشبعة والمتحولة.",
        en: "Fat is a nutrient and concentrated energy source, including saturated, unsaturated, and trans fats. Project guidance distinguishes these types rather than treating all fat equally, placing total fat at 15–30% of energy while limiting saturated and trans fat.",
        documentId: "DEMO-WHO-FAT", title: "WHO Healthy Diet — Dietary Fats", url: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
      };
    }
    if (!concept) return null;
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: `${language === "en" ? concept.en : concept.ar}\n\n${language === "en" ? "This is general nutrition information, not personalized medical advice." : "دي معلومة غذائية عامة، مش نصيحة طبية مخصصة."}`,
      data: { intent: "general_guideline", concept: concept.key, demoOnly: true, reviewStatus: this.dataset.metadata.review_status, guideline: { documentId: concept.documentId, title: concept.title } },
      evidenceDocumentIds: [concept.documentId], provenance: [{ sourceId: "DEMO-WHO-GUIDANCE", versionId: "2.0-final-demo-normalized", title: concept.title, url: concept.url, accessedAt: this.dataset.metadata.created_date, locator: concept.documentId }],
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

  private scopedConversationResponse(query: string, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse | null {
    const normalized = normalizedLookupText(query);
    const compact = normalized.replace(/\s+/gu, " ").trim();
    const response = (
      responseType: "greeting" | "acknowledgement" | "capabilities" | "food_clarification",
      message: string,
      status: "ok" | "clarification" = "ok",
    ): ExpandedAgentResponse => ({
      status,
      primaryIntent: "general_guidance",
      language,
      safetyFlags: [],
      integrityFlags: [],
      message,
      data: { intent: "scoped_conversation", responseType },
      evidenceDocumentIds: [],
      provenance: [],
      toolTrace: [],
      promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    });

    const isGreeting = /^(?:السلام عليكم|سلام عليكم|وعليكم السلام|وعليكم سلام|اهلا|اهلين|مرحبا|ازيك|عامل ايه|صباح الخير|صباح خير|مساء الخير|مساء خير|hello|hi|hey|good morning|good evening)[!?.\s]*$/iu.test(compact);
    if (isGreeting) {
      return response("greeting", language === "en"
        ? "Hello! I’m NutriGuard, your Egyptian-food nutrition assistant. Ask me about an Egyptian recipe, its ingredients or calories, a numerical comparison, or a general nutrition guideline."
        : "أهلًا بيك! أنا NutriGuard، مساعدك للتغذية والأكل المصري. اسألني عن وصفة مصرية، مكوناتها أو سعراتها، مقارنة رقمية، أو إرشاد غذائي عام.");
    }

    const isAcknowledgement = /^(?:شكرا|متشكر|تسلم|تمام|اوك|اوكي|ماشي|حلو|thanks|thank you|great|okay|ok)[!?.\s]*$/iu.test(compact);
    if (isAcknowledgement) {
      return response("acknowledgement", language === "en"
        ? "You’re welcome. Send me the Egyptian dish, ingredient and weight, comparison, or calorie target you want to check."
        : "العفو! ابعتلي اسم الأكلة المصرية، أو المكوّن ووزنه، أو المقارنة، أو هدف السعرات اللي عايز تحققه.");
    }

    const asksCapabilities = /^(?:مين انت|انت مين|بتعمل ايه|تقدر تعمل ايه|ممكن تساعدني|ساعدني|ايه خدماتك|ايه امكانياتك|who are you|what can you do|help|help me)[!?.\s]*$/iu.test(compact);
    if (asksCapabilities) {
      return response("capabilities", language === "en"
        ? "I specialize in Egyptian food. I can find recorded recipes, show ingredients and methods, calculate recipe or ingredient nutrition, compare two dishes on the same basis, suggest a meal around a calorie target, make a recorded recipe lighter with deterministic calculations, and provide sourced general nutrition guidance. I don’t diagnose conditions or answer unrelated topics."
        : "أنا متخصص في الأكل المصري والتغذية: أقدر أبحث عن وصفة مسجلة، أعرض المكونات والطريقة، أحسب قيم الوصفة أو مكونات بأوزانها، أقارن أكلتين على نفس الأساس، أرشح وجبة حول هدف سعرات، وأعمل تعديل أخف بحساب واضح، أو أقدّم إرشادًا غذائيًا عامًا بمصدره. ما بشخّصش حالات مرضية وما بجاوبش في موضوعات خارج النطاق.");
    }

    const vagueFoodRequest = /^(?:انا جعان|انا جوعان|جعان|جوعان|عايز اكل|عاوز اكل|رشحلي حاجه|اقترحلي حاجه|اختارلي اكله|i am hungry|im hungry|i want food|suggest something to eat)[!?.\s]*$/iu.test(compact);
    if (vagueFoodRequest) {
      return response("food_clarification", language === "en"
        ? "Sure—do you want breakfast, lunch, dinner, or a snack? You can also give me a calorie target, such as: “an Egyptian lunch around 500 kcal.”"
        : "تمام—عايز فطار، غدا، عشا، ولا سناك؟ وممكن تحدد هدف سعرات، مثل: «وجبة غدا مصرية حوالي 500 سعر حراري».", "clarification");
    }

    return null;
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
      message: language === "en"
        ? "I’m NutriGuard, specialized in Egyptian food and nutrition. I won’t answer that part because it is outside the project’s verified scope, but I can help with an Egyptian recipe, calories or ingredients, a numerical comparison, general nutrition guidance, or a calculated lighter modification."
        : "أنا NutriGuard ومتخصص في الأكل المصري والتغذية. مش هجاوب على الجزء ده علشان أفضل ملتزم بنطاق ومصادر المشروع، لكن أقدر أساعدك في وصفة مصرية، سعرات أو مكونات، مقارنة رقمية، إرشاد غذائي عام، أو تعديل أخف بحساب واضح.",
      data: { intent, reasonCode: "out_of_scope" }, evidenceDocumentIds: [], provenance: [], toolTrace: [], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private generalAdvice(language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse {
    const message = language === "en"
      ? "General nutrition tips:\n\n• Compare meals using the same basis, such as per serving or per 100 g.\n• Build the meal around vegetables and a clear protein source.\n• Watch portion size and added oil because both can change calories substantially.\n• Prefer water over sweetened drinks for everyday meals.\n• Missing data means unknown, not zero.\n\nFor personalized or medical advice, consult a qualified dietitian or clinician."
      : "نصائح غذائية عامة:\n\n• قارن الوجبات على نفس الأساس: للحصة أو لكل 100 جرام.\n• خلّي في الوجبة خضار ومصدر بروتين واضح.\n• راقب حجم الحصة والزيت المضاف لأنهم ممكن يغيّروا السعرات بشكل كبير.\n• اختار المياه بدل المشروبات المحلاة في الوجبات اليومية.\n• القيمة الناقصة معناها غير معروفة، مش صفر.\n\nلو محتاج نصيحة شخصية أو لحالة مرضية، راجع أخصائي تغذية أو طبيب مؤهل.";
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [], message,
      data: { demoOnly: true, reviewStatus: this.dataset.metadata.review_status, adviceType: "general_non_medical" }, evidenceDocumentIds: [], provenance: [],
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
        data: { intent: "ingredient_nutrition", demoOnly: true, reviewStatus: this.dataset.metadata.review_status, requiredInput: "ingredient_weights_in_grams" }, evidenceDocumentIds: [], provenance: [],
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
      data: { intent: "ingredient_nutrition", demoOnly: true, reviewStatus: this.dataset.metadata.review_status, calculationType: "ingredient_weights", ingredients: allCalculated.map(({ key, grams, suppliedName, caloriesKcal }) => ({ key, grams, suppliedName, caloriesKcal, foodState: key.endsWith("_raw") ? "raw" : key.endsWith("_cooked") ? "cooked" : null })), totalCaloriesKcal: total, partial: stillUnknown.length > 0 || known.length !== allCalculated.length, backendFoodsUsed: backendCalculated.length },
      evidenceDocumentIds: [], provenance: [{ sourceId: GRADUATION_RECIPE_SOURCE_ID, versionId: "2.0-final-demo-normalized", title: language === "en" ? "Ingredient nutrition reference" : "مرجع القيم الغذائية للمكونات", url: null, accessedAt: this.dataset.metadata.created_date, locator: "ingredient_nutrition_reference" }, ...backendProvenance],
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

  private recommendAnyMeal(query: string, language: "ar-EG" | "ar" | "en", context?: GraduationConversationContext): ExpandedAgentResponse | null {
    const requestsAnyMeal = /(?:اقترح|رشح|اختار|هات)(?:\s*لي)?\s+(?:أي|اي)\s+(?:وجبة|أكلة|اكلة|وصفة|أكل|اكل|طعام)(?:\s+مصر(?:ي|ية))?|(?:suggest|recommend|pick|choose)(?:\s+me)?\s+(?:any|an|a|some)\s+(?:egyptian\s+)?(?:meal|dish|recipe|food)|give\s+me\s+(?:any|an|a|some)\s+(?:egyptian\s+)?(?:meal|dish|recipe|food)|(?:suggest|recommend|pick|choose|give\s+me)\s+something\s+(?:egyptian\s+)?(?:to\s+eat)?|surprise\s+me\s+with\s+(?:an?\s+)?egyptian\s+(?:meal|dish|recipe)|(?:any|whatever)\s+egyptian\s+(?:meal|dish|recipe|food)\s+(?:is\s+)?(?:fine|okay|ok)/iu.test(query);
    if (!requestsAnyMeal) return null;
    const allowedCategories = new Set(["breakfast", "main_dish", "soup", "salad"]);
    const selected = rankHealthFirst(this.dataset.recipes
      .filter((recipe) => allowedCategories.has(recipe.category))
      .map((recipe) => {
        const calculation = calculateUnifiedDemoNutrition(this.dataset, recipe);
        return { recipe, calculation, assessment: assessNutritionBalance(recipe, calculation) };
      }), context?.memory?.recentRecipeIds)[0];
    if (!selected) return null;
    const { recipe, calculation, assessment } = selected;
    const name = language === "en" ? recipe.name_en : recipe.name_ar;
    const portionGrams = Math.round(calculation.finalWeightG / recipe.servings);
    const ingredients = recipeIngredientGrams(recipe, language, 1);
    const ingredientLines = ingredientGramLines(ingredients, language, "  • ");
    const recommendation = {
      recipeId: recipe.recipe_id,
      name,
      portionGrams,
      caloriesKcal: calculation.perServing.kcal,
      proteinG: calculation.perServing.protein,
      ingredients,
      ingredientWeightBasis: "input_grams_for_one_recorded_serving",
      nutritionBalanceScore: assessment.score,
      cuisineOrigin: recipe.origin,
    };
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en"
        ? `A verified Egyptian option selected deterministically by the project's nutrition-balance policy is ${name}.\n\nServing: ${portionGrams} g, about ${calculation.perServing.kcal ?? "unknown"} kcal.\nIngredient input weights for this serving:\n${ingredientLines}\n\nThese ingredient grams are scaled from the recorded full recipe; the cooked serving weight can differ because of cooking yield.`
        : `اختيار مصري موثق ومحدد بشكل ثابت حسب سياسة التوازن الغذائي في المشروع هو ${name}.\n\nالحصة: ${portionGrams} جرام، حوالي ${calculation.perServing.kcal ?? "غير معروف"} سعر حراري.\nأوزان المكونات الداخلة في الحصة:\n${ingredientLines}\n\nجرامات المكونات متقسمة من الوصفة الكاملة المسجلة، ووزن الحصة بعد التسوية ممكن يختلف بسبب فاقد أو زيادة الطهي.`,
      data: { intent: "find_recipe", recommendationType: "any_egyptian_meal", recommendationPolicy: RECOMMENDATION_POLICY_VERSION, recommendations: [recommendation] },
      evidenceDocumentIds: [`DEMO-${recipe.recipe_id}`], provenance: [this.recipeProvenance(recipe, language)],
      toolTrace: [{ tool: "search_recipes", ok: true, code: null }, { tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private recommendMeal(category: string, language: "ar-EG" | "ar" | "en", context?: GraduationConversationContext): ExpandedAgentResponse {
    const ranked = rankHealthFirst(this.dataset.recipes
      .filter((recipe) => recipe.category === category)
      .map((recipe) => {
        const calculation = calculateUnifiedDemoNutrition(this.dataset, recipe);
        return { recipe, calculation, assessment: assessNutritionBalance(recipe, calculation) };
      }), context?.memory?.recentRecipeIds);
    const selected = diversifyHealthRanked(ranked, 3);
    if (selected.length === 0) {
      return {
        status: "no_result", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en" ? "I could not find a matching Egyptian meal in the demo dataset." : "ملقتش وجبة مصرية مناسبة للنوع ده في بيانات العرض.",
        data: null, evidenceDocumentIds: [], provenance: [], toolTrace: [{ tool: "search_recipes", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const recommendations = selected.map(({ recipe, calculation, assessment }) => {
      const servingGrams = Math.round(calculation.finalWeightG / recipe.servings);
      return { recipeId: recipe.recipe_id, name: language === "en" ? recipe.name_en : recipe.name_ar, portionGrams: servingGrams, caloriesKcal: calculation.perServing.kcal, proteinG: calculation.perServing.protein, ingredients: recipeIngredientGrams(recipe, language, 1), ingredientWeightBasis: "input_grams_for_one_recorded_serving", nutritionBalanceScore: assessment.score, cuisineOrigin: recipe.origin };
    });
    const lines = recommendations.map((item) => language === "en"
      ? `• ${item.name} — ${item.portionGrams} g per serving, about ${item.caloriesKcal ?? "unknown"} kcal and ${item.proteinG ?? "unknown"} g protein.\n  Ingredient input grams:\n${ingredientGramLines(item.ingredients, language, "    • ")}`
      : `• ${item.name} — الحصة ${item.portionGrams} جرام، حوالي ${item.caloriesKcal ?? "غير معروف"} سعر حراري و${item.proteinG ?? "غير معروف"} جم بروتين.\n  جرامات المكونات الداخلة في الحصة:\n${ingredientGramLines(item.ingredients, language, "    • ")}`);
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en"
        ? `Here are three verified Egyptian options ranked first by the project's nutrition-balance policy and diversified by cooking method:\n\n${lines.join("\n")}\n\nThe score is a transparent comparison heuristic, not a medical “healthy” certification.`
        : `دي 3 اختيارات مصرية موثقة، مرتبة أولًا بسياسة التوازن الغذائي في المشروع ومتنوعة حسب طريقة الطهي:\n\n${lines.join("\n")}\n\nالترتيب أداة مقارنة شفافة، مش شهادة طبية إن أكلة معينة «صحية» لكل شخص.`,
      data: { demoOnly: true, reviewStatus: this.dataset.metadata.review_status, recommendationPolicy: RECOMMENDATION_POLICY_VERSION, rankingMeaning: "graduation_project_comparison_heuristic_not_medical_certification", recommendations }, evidenceDocumentIds: selected.map(({ recipe }) => `DEMO-${recipe.recipe_id}`),
      provenance: selected.map(({ recipe }) => ({ sourceId: GRADUATION_RECIPE_SOURCE_ID, versionId: "2.0-final-demo-normalized", title: language === "en" ? recipe.name_en : recipe.name_ar, url: recipe.source_url, accessedAt: this.dataset.metadata.created_date, locator: recipe.recipe_id })),
      toolTrace: [{ tool: "search_recipes", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private recommendWithExclusions(query: string, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse | null {
    const exclusions = new Set(excludedIngredientKeys(query));
    if (exclusions.size === 0) return null;
    const categoryPriority = new Map(["main_dish", "breakfast", "soup", "salad"].map((category, index) => [category, index]));
    const candidate = this.dataset.recipes
      .filter((recipe) => categoryPriority.has(recipe.category) && !recipeContainsExcludedIngredient(recipe, exclusions))
      .map((recipe) => {
        const nutrition = calculateUnifiedDemoNutrition(this.dataset, recipe);
        return { recipe, nutrition, assessment: assessNutritionBalance(recipe, nutrition) };
      })
      .filter(({ nutrition }) => nutrition.perServing.kcal !== null)
      .sort((left, right) => (categoryPriority.get(left.recipe.category) ?? 99) - (categoryPriority.get(right.recipe.category) ?? 99)
        || right.assessment.score - left.assessment.score
        || left.recipe.recipe_id.localeCompare(right.recipe.recipe_id))[0];
    if (!candidate) return null;
    const { recipe, nutrition } = candidate;
    const title = language === "en" ? recipe.name_en : recipe.name_ar;
    const ingredients = recipeIngredientGrams(recipe, language, null);
    const ingredientText = ingredientGramLines(ingredients, language);
    const dairyRequest = [...DAIRY_INGREDIENT_KEYS].every((key) => exclusions.has(key));
    const exclusionNames = dairyRequest
      ? [language === "en" ? "the recorded dairy ingredients" : "منتجات الألبان المسجلة"]
      : [...exclusions].map((key) => ingredientLabel(key, language));
    const safetyNote = exclusionSafetyNote(exclusionNames, language);
    const nutritionSummary = perServingNutritionSummary(nutrition.perServing, language);
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en"
        ? `${title}\n\nThis recorded recipe already matches the requested ingredient filter; its full-recipe ingredient weights were not altered:\n${ingredientText}\n\n${nutritionSummary.replace("after exclusion", "after applying the filter")}\n\n${safetyNote}`
        : `${title}\n\nالوصفة المسجلة مطابقة لفلتر الاستبعاد المطلوب، وأوزان مكونات الوصفة الكاملة لم تتغير:\n${ingredientText}\n\n${nutritionSummary.replace("بعد الاستبعاد", "بعد تطبيق الفلتر")}\n\n${safetyNote}`,
      data: {
        intent: "find_recipe", recommendationType: "ingredient_exclusion", modificationType: "ingredient_exclusion_filter",
        recipeWasModified: false, recipeId: recipe.recipe_id, displayName: title,
        excludedIngredientKeys: [...exclusions], ingredients, ingredientWeightBasis: "input_grams_for_full_recorded_recipe",
        nutrition: nutrition, safetyDisclaimer: safetyNote,
        conversationContext: { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: recipe.recipe_id },
      },
      evidenceDocumentIds: [`DEMO-${recipe.recipe_id}`], provenance: [this.recipeProvenance(recipe, language)],
      toolTrace: [{ tool: "search_recipes", ok: true, code: null }, { tool: "calculate_nutrition", ok: true, code: null }],
      promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private recipeDetails(
    recipe: UnifiedDemoRecipe,
    language: "ar-EG" | "ar" | "en",
    passages: Array<{ documentId: string; title: string; text: string; score: number }>,
    provenance: ExpandedAgentResponse["provenance"],
  ): ExpandedAgentResponse {
    const calculation = calculateUnifiedDemoNutrition(this.dataset, recipe);
    const ingredients = recipeIngredientGrams(recipe, language, null);
    const ingredientText = ingredientGramLines(ingredients, language);
    const title = language === "en" ? recipe.name_en : recipe.name_ar;
    const nutrition = calculation.perServing;
    const servingWeightG = Math.round(calculation.finalWeightG / recipe.servings);
    const message = language === "en"
      ? `${title}\n\nIngredient input weights for the full recorded recipe (${recipe.servings} servings):\n${ingredientText}\n\nPreparation method (recorded in Arabic in the source):\n${recipe.method_summary}\n\nEstimated ${servingWeightG} g serving: ${nutrition.kcal ?? "unknown"} kcal, ${nutrition.protein ?? "unknown"} g protein, ${nutrition.fat ?? "unknown"} g fat, and ${nutrition.carbs ?? "unknown"} g carbohydrates.${energyReconciliationNote(nutrition, language)}`
      : `${title}\n\nأوزان المكونات الداخلة في الوصفة الكاملة (${recipe.servings} حصص):\n${ingredientText}\n\nطريقة التحضير:\n${recipe.method_summary}\n\nتقدير الحصة (${servingWeightG} جرام): ${nutrition.kcal ?? "غير معروف"} سعر حراري، ${nutrition.protein ?? "غير معروف"} جم بروتين، ${nutrition.fat ?? "غير معروف"} جم دهون، و${nutrition.carbs ?? "غير معروف"} جم كربوهيدرات.${energyReconciliationNote(nutrition, language)}`;
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [], message,
      data: { intent: "find_recipe", demoOnly: true, reviewStatus: this.dataset.metadata.review_status, recipe: { recipeId: recipe.recipe_id, nameAr: recipe.name_ar, nameEn: recipe.name_en, servings: recipe.servings, servingWeightG, ingredients, ingredientWeightBasis: "input_grams_for_full_recorded_recipe", method: recipe.method_summary, nutritionPerServing: nutrition, cuisineOrigin: recipe.origin, energyReconciliation: reconcileEnergyWithMacros(nutrition) }, passages, conversationContext: { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: recipe.recipe_id } },
      evidenceDocumentIds: passages.map((passage) => passage.documentId), provenance,
      toolTrace: [{ tool: "search_recipes", ok: true, code: null }, { tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

}

export interface GraduationDemoAgentOptions {
  mealSelectionFlow?: MealSelectionFlow;
}

/**
 * Gives only the interactive graduation runtime a deterministic successful
 * dashboard path. MockDashboardClient itself deliberately keeps its fail-closed
 * no-scenario behavior for tests and every other caller.
 */
function createGraduationDemoDashboard(): DashboardClient {
  const mock = new MockDashboardClient();
  const configuredKeys = new Set<string>();
  let dailyCaloriesRemaining = GRADUATION_DEMO_DAILY_CALORIE_BUDGET;

  return {
    async logMealSelections(request: LogMealSelectionsRequest) {
      if (!configuredKeys.has(request.idempotency_key)) {
        configuredKeys.add(request.idempotency_key);
        const requestedCalories = Math.round(request.selections.reduce(
          (total, selection) => total + selection.nutrition_snapshot.calories,
          0,
        ) * 10) / 10;
        if (requestedCalories > dailyCaloriesRemaining) {
          mock.enqueue({
            kind: "error",
            errorCode: "insufficient_calories",
            message: "The graduation-demo calorie balance is insufficient for this selection.",
          });
        } else {
          dailyCaloriesRemaining = Math.round((dailyCaloriesRemaining - requestedCalories) * 10) / 10;
          mock.enqueue({ kind: "success", dailyCaloriesRemaining });
        }
      }
      return mock.logMealSelections(request);
    },
  };
}

export async function buildGraduationDemoAgent(
  nodeEnv: "development" | "test",
  backendDataSource?: GraduationBackendDataSource | null,
  options: GraduationDemoAgentOptions = {},
): Promise<GraduationDemoAgent> {
  if (nodeEnv !== "development" && nodeEnv !== "test") throw new Error("graduation demo agent is forbidden outside development/test");
  const dataset = await loadUnifiedEgyptianDemoDataset();
  assertCompleteArabicIngredientDictionary(dataset);
  const recipes = new Map(dataset.recipes.map((recipe) => [recipe.recipe_id, recipe]));
  const embeddingProvider = new GraduationDemoEmbeddingProvider();
  const vectorStore = new InMemoryVectorStore();
  await ingestRetrievalCorpus(ingestionEligibleCorpus(buildGraduationRetrievalCorpus(dataset)), embeddingProvider, vectorStore);
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
    ? nodeEnv === "development" ? new NutriGuardBackendClient(
      process.env.NUTRIGUARD_BACKEND_BASE_URL?.trim() || undefined,
      fetch,
      4_000,
      /^(?:1|true|yes|on)$/iu.test(process.env.NUTRIGUARD_ALLOW_INSECURE_BACKEND_HTTP?.trim() ?? "false"),
    ) : null
    : backendDataSource;
  const backendTrackingEnabled = /^(?:1|true|yes|on)$/iu.test(process.env.NUTRIGUARD_BACKEND_TRACKING_ENABLED?.trim() ?? "false");
  const backendCanTrackMeals = Boolean(backend?.createCustomMealBatch || (backend?.createCustomMeal && backend.deleteCustomMeal));
  const dashboard = backendTrackingEnabled && backend && backendCanTrackMeals
    ? new NutriGuardCustomMealDashboardClient({
      backend,
      resolveRecipe: (recipeId) => {
        const recipe = recipes.get(recipeId);
        return recipe ? { nameAr: recipe.name_ar, nameEn: recipe.name_en } : null;
      },
    })
    : createGraduationDemoDashboard();
  const mealSelection = options.mealSelectionFlow ?? new MealSelectionFlow(
    new DatasetVerifiedMealRecipeRepository(dataset, ingredientLabel),
    dashboard,
  );
  return new GraduationDemoAgent(new NutriGuardExpandedAgent(tools, new InMemoryAlternativeRuleRepository([])), tools, dataset, backend, mealSelection);
}
