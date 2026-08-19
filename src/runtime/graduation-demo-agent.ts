import type { ExpandedAgentResponse } from "../agent/expanded-agent.js";
import { randomUUID } from "node:crypto";
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
import { ClaudeLayer, safetyPreScreen, type ClaudeLayerDependencies } from "../llm/claude-layer.js";
import { RuleBasedExpandedAgentPlanner } from "../agent/expanded-agent.js";
import { NUTRIGUARD_SYSTEM_PROMPT } from "../agent/system-prompt.js";
import { expandedPlannerIntentOf, type RuleBasedClassification } from "../llm/nlu-arbitration.js";
import {
  newTrace,
  type ClaudeRequestTrace,
  type RetrievalRoute,
} from "../llm/observability.js";
import type { ClassifierContextSummary, ReferenceCandidate } from "../llm/claude-classifier.js";
import type { AgentEntityResolvers } from "../llm/entity-validation.js";
import {
  InstrumentedEmbeddingProvider,
  InstrumentedVectorStore,
  recordHybridRetrievalEvent,
  summarizeRetrieval,
  withRetrievalCollection,
} from "../llm/retrieval-observer.js";
import type { HybridRetrievalEvent } from "./hybrid-retrieval-tools.js";
import { MealSelectionTools, type MealCategoryRecipeRecord, type MealCategoryRecipeSource } from "../tools/meal-selection-tools.js";
import { MealPlanSelectionFlow, type MealSelectionState } from "./meal-plan-selection.js";
import type { DashboardClient, DashboardMealCategory } from "../services/dashboard/dashboard-client.js";
import { MockDashboardClient } from "../services/dashboard/mock-dashboard-client.js";
import { InMemoryPendingMealOperationStore, type FrozenMealNutrition, type PendingMealOperationStore } from "../services/dashboard/pending-meal-operations.js";
import {
  NutriGuardBackendClient,
  type BackendFood,
  type BackendRecipe,
  type GraduationBackendDataSource,
} from "./graduation-backend-client.js";
import { HybridRetrievalTools } from "./hybrid-retrieval-tools.js";

const DIMENSIONS = 16_384;

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
  /**
   * Last two-recipe comparison, so an ambiguous follow-up can continue it.
   *
   * Optional for backward compatibility: a browser session that still holds a
   * memory blob written before this field existed must keep validating at the
   * API boundary instead of being rejected with a 400.
   */
  comparison?: {
    firstRecipeId: string;
    secondRecipeId: string;
    basis: "per_serving" | "per_100g";
    nutrient: string | null;
  } | null;
  /**
   * Step 16 multi-option meal-plan selection state.
   *
   * Deliberately stored inside the SAME bounded short-term memory the BUG-09 fix
   * introduced, next to `mealPlan` and `singleMealTarget`, rather than in a second
   * memory mechanism. That is what lets a selection reference survive intervening
   * turns and lets an unrelated question pass through without disturbing an
   * active pending confirmation.
   *
   * Only identifiers are stored. Nutrition numbers are recomputed from the
   * dataset every time they are displayed, and the authoritative frozen snapshot
   * of a shown summary lives server-side in the pending-operation store.
   *
   * Optional for backward compatibility: a browser session holding a memory blob
   * written before this field existed must keep validating at the API boundary.
   */
  mealSelection?: MealSelectionState | null;
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

/**
 * Comparison state (BUG-16).
 *
 * `compare_recipes` previously had no context variant at all, so after producing
 * a two-recipe comparison the agent downgraded its own state to a single-recipe
 * `recipe_reference` pointing at the first item. The second recipe, the basis and
 * the fact that a comparison had happened were discarded at the moment of
 * success, which is why "مين الأفضل؟" could not be answered as a continuation.
 */
export interface ComparisonConversationContext extends MemoryCarrier {
  schemaVersion: "1.0";
  lastIntent: "compare_recipes";
  firstRecipeId: string;
  secondRecipeId: string;
  basis: "per_serving" | "per_100g";
  /** The nutrient the previous turn compared, when it named one. */
  nutrient: string | null;
}

/**
 * Step 16 multi-option meal-plan selection state (see `meal-plan-selection.ts`).
 *
 * Carries `memory` like every other variant, so the shared BUG-09 memory keeps
 * accumulating while a selection is in progress.
 */
export interface MealSelectionConversationContext extends MemoryCarrier {
  schemaVersion: "1.0";
  lastIntent: "meal_selection";
  selection: MealSelectionState;
}

export type GraduationConversationContext = CalorieTargetConversationContext | LighterModificationConversationContext | RecipeReferenceConversationContext | MealPlanConversationContext | MealPlanDraftConversationContext | ComparisonConversationContext | MealSelectionConversationContext;

/**
 * Conversational cue that the user is referring to a dish already under
 * discussion instead of naming one.
 *
 * Single source of truth: `contextForMessage` and `invokeCore` previously each
 * carried their own near-duplicate copy of this pattern, which let them drift.
 *
 * Besides pronouns it now covers a bare definite reference such as
 * "اعرضلي مكونات الوصفه", which users reach for immediately after the agent
 * recommends a dish. Without it the router saw "مكونات" with no named recipe
 * and asked for ingredient weights in grams — an obvious loss of context.
 *
 * Short pronouns are boundary-anchored with Unicode lookarounds. Unanchored they
 * matched inside ordinary words — "صوديوم" contains "دي" and "جديد" contains
 * "دي" — so a sodium follow-up was mistaken for a pronoun reference and answered
 * about one dish. `\b` cannot be used for this: it is defined over `[A-Za-z0-9_]`,
 * so it never fires between two Arabic letters. English `it` is `\b`-anchored for
 * the same reason, otherwise it matched inside "white" and "with".
 */
const IMPLICIT_RECIPE_REFERENCE_PATTERN = new RegExp(
  [
    "(?<!\\p{L})(?:هي|دي|ده|دى)(?!\\p{L})",
    "(?:قارنها|خففها|قللها|زودها)",
    "(?<!\\p{L})(?:الوصفه|الوصفة|الاكله|الأكلة|الاكلة|الطبق)(?!\\p{L})",
    "\\b(?:it|that\\s+recipe|same\\s+recipe|the\\s+recipe|the\\s+dish)\\b",
  ].join("|"),
  "iu",
);

function usesImplicitRecipeReference(message: string): boolean {
  return IMPLICIT_RECIPE_REFERENCE_PATTERN.test(message);
}

/**
 * Explicit user rejection of the result just shown (BUG-11).
 *
 * Deliberately narrow. It must fire on identity/correctness denials such as
 * "دي مش وصفة كشري", "غلط", "مش كده", "مش دا اللي طلبته", and must NOT fire on
 * ordinary attribute questions such as "يعني هي مش صحية؟", which are legitimate
 * follow-up questions about a dish rather than a complaint about the answer.
 *
 * The trailing `(?![\p{L}])` guards matter: without them "مش صح" would also
 * match inside "مش صحية" and swallow a health question.
 */
const RESULT_REJECTION_PATTERNS: readonly RegExp[] = [
  // "دي مش وصفة ..." / "ده مش أكلة ..." / "الرد مش صح"
  /(?:دي|ده|دا|هذه|هذا|الرد|الاجابه|الإجابة|النتيجه|النتيجة)?\s*(?:مش|ليست|ليس)\s*(?:وصفه|وصفة|اكله|أكلة|اكلة|طبق|هي|هو)(?![\p{L}])/u,
  // "مش صح" / "مش صحيح" but never "مش صحية"
  /(?:مش|ليس)\s*(?:صح|صحيح)(?![\p{L}])/u,
  // "مش كده" / "مش كدا" / "مش كذا"
  /(?:مش|ليس)\s*(?:كده|كدا|كذا)(?![\p{L}])/u,
  // "مش دا اللي طلبته" / "مش اللي طلبته" / "مش اللي عايزه"
  /(?:مش|ليس)\s*(?:دا|ده|دي)?\s*(?:اللي|الذي)\s*(?:طلبته|طلبت|عايزه|عايزة|اريده|أريده|قلته)/u,
  // standalone wrongness
  /(?:^|\s)(?:غلط|غلطان|خطأ|خطا|بالغلط|انت\s*غلطت)(?![\p{L}])/u,
  /(?:that'?s|this\s+is)\s+(?:not|wrong|incorrect)/iu,
  /(?:^|\s)(?:wrong|incorrect)(?:\s+(?:recipe|dish|answer|result))?(?![\p{L}])/iu,
  /not\s+what\s+i\s+(?:asked|wanted|requested)/iu,
];

function detectsResultRejection(message: string): boolean {
  const normalized = normalizedLookupText(message);
  return RESULT_REJECTION_PATTERNS.some((pattern) => pattern.test(normalized) || pattern.test(message));
}

/** True when a conversation context still points at `recipeId` in any form. */
function contextPointsAtRecipe(context: GraduationConversationContext, recipeId: string): boolean {
  if (context.lastIntent === "meal_plan") return context.recipeIds.includes(recipeId);
  if (context.lastIntent === "meal_plan_draft") return false;
  if (context.lastIntent === "compare_recipes") return context.firstRecipeId === recipeId || context.secondRecipeId === recipeId;
  if (context.lastIntent === "meal_selection") {
    return context.selection.categories.some((category) => category.options.some((option) => option.recipeIds.includes(recipeId)));
  }
  return context.recipeId === recipeId;
}

/**
 * Nutrients a comparison can be resolved on, matched against normalized text.
 * Ordered so that a more specific term is tested before a broader one.
 */
const COMPARABLE_NUTRIENTS: ReadonlyArray<{ key: "kcal" | "protein" | "carbs" | "fat" | "fiber" | "sugar" | "sodium"; pattern: RegExp }> = [
  { key: "sodium", pattern: /(?:صوديوم|ملح|sodium|salt)/u },
  { key: "protein", pattern: /(?:بروتين|protein)/u },
  { key: "carbs", pattern: /(?:كربوهيدرات|كارب|carb)/u },
  { key: "fiber", pattern: /(?:الياف|fiber|fibre)/u },
  { key: "sugar", pattern: /(?:سكر|sugar)/u },
  { key: "fat", pattern: /(?:دهون|fat)/u },
  { key: "kcal", pattern: /(?:سعر|سعرات|كالوري|طاقه|calorie|kcal|energy)/u },
];

function comparisonNutrient(message: string): "kcal" | "protein" | "carbs" | "fat" | "fiber" | "sugar" | "sodium" | null {
  const normalized = normalizedLookupText(message);
  return COMPARABLE_NUTRIENTS.find((entry) => entry.pattern.test(normalized))?.key ?? null;
}

/**
 * Ambiguous continuation of a comparison (BUG-16).
 *
 * Covers superlative questions ("مين الأفضل؟"), bare criterion questions
 * ("الأقل صوديوم؟") and justification questions ("ليه؟"). These carry no dish
 * name, so without this they fell through to an unrelated intent and answered
 * about a single one of the two compared dishes.
 */
const COMPARISON_FOLLOWUP_PATTERN =
  /(?:افضل|احسن|اصح|انسب|اقل|اكتر|اكثر|اعلي|اغني|ايهما|ايهم|مين|ليه|لماذا|ليش|فرق|why|better|best|which|healthier|lower|higher)/u;

function isComparisonFollowup(message: string): boolean {
  return COMPARISON_FOLLOWUP_PATTERN.test(normalizedLookupText(message));
}

function asksWhy(message: string): boolean {
  return /(?:ليه|لماذا|ليش|why|كيف\s*كده|ازاي\s*كده)/u.test(normalizedLookupText(message));
}

/**
 * A bare nutrient question that names no dish, e.g. "الدهون المشبعة كام".
 *
 * Such a question is about the dish already under discussion. It used to be
 * handled only by accident, because the unanchored pronoun "ده" matched inside
 * "الدهون". Anchoring the pronouns removed that accident, so the intent is now
 * expressed explicitly instead of relying on a false-positive substring match.
 */
function isBareNutrientQuestion(message: string): boolean {
  const normalized = normalizedLookupText(message);
  return comparisonNutrient(message) !== null && MEASUREMENT_QUESTION_PATTERN.test(normalized);
}

/**
 * Definitional / explanatory questions (BUG-13).
 *
 * "ما المقصود بالدهون المشبعة؟" asks what a concept *is*; it must not be
 * answered with one recipe's number. Measurement wording is excluded so that
 * "كام الدهون المشبعة في الكشري" and "إيه قيمة الصوديوم" remain recipe lookups.
 *
 * Patterns are written against `normalizedLookupText` output, which strips the
 * definite article — so "المقصود" is matched here as "مقصود" and "بالدهون" as
 * "دهون". Matching the article-bearing forms silently never fired.
 */
const DEFINITIONAL_QUESTION_PATTERN =
  /(?:مقصود|معني|يعني\s*ايه|مفهوم|تعريف|عرفلي|عرفني|اشرحلي|اشرح|وضحلي|وضح|افهم|ايه\s*الفرق\s*بين|what\s+(?:is|are)\s+meant|what\s+does\s+.{0,40}\bmean|meaning\s+of|define|definition\s+of|explain)/u;

const MEASUREMENT_QUESTION_PATTERN =
  /(?:كام|كم|قيمه|نسبه|مقدار|عدد|how\s+much|how\s+many|value\s+of|amount\s+of)/u;

function isDefinitionalQuestion(message: string): boolean {
  const normalized = normalizedLookupText(message);
  if (!DEFINITIONAL_QUESTION_PATTERN.test(normalized)) return false;
  return !MEASUREMENT_QUESTION_PATTERN.test(normalized);
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

/**
 * Dataset categories that make up each dashboard meal category.
 *
 * `breakfast`, `lunch` and `dinner` reuse the mapping the existing day-plan
 * builder already applies, so the two features cannot disagree about what a
 * lunch is. `snacks` is new in Step 16 v3 and maps to the small-portion
 * categories in the dataset. Salad is deliberately left out of `snacks` because
 * it already belongs to `dinner`.
 */
const MEAL_CATEGORY_DATASET_CATEGORIES: Readonly<Record<DashboardMealCategory, readonly string[]>> = {
  breakfast: ["breakfast", "bread"],
  lunch: ["main_dish"],
  dinner: ["main_dish", "soup", "salad"],
  snacks: ["appetizer", "pickle", "beverage", "dessert"],
};

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

/**
 * Single source of truth for the allergy/exclusion disclaimer.
 *
 * Exported so the Step 16 meal-selection flow can reuse this exact implementation
 * rather than restating the wording. Do not add a second copy anywhere.
 */
export function exclusionSafetyNote(removedNames: readonly string[], language: "ar-EG" | "ar" | "en"): string {
  const names = removedNames.join(language === "en" ? ", " : " و");
  return language === "en"
    ? `I excluded ${names} at your request. If this relates to a severe allergy, consult a qualified clinician or dietitian; NutriGuard cannot guarantee absence of cross-contamination.`
    : `تم استبعاد ${names} بناءً على طلبك. لو الاستبعاد مرتبط بحساسية شديدة، راجع طبيبًا أو أخصائي تغذية مؤهلًا؛ النظام لا يضمن خلو الطعام من التلوث التبادلي.`;
}

function perServingNutritionSummary(
  nutrition: ReturnType<typeof calculateUnifiedDemoNutrition>["perServing"],
  language: "ar-EG" | "ar" | "en",
): string {
  if (language === "en") {
    return `Estimated per serving after exclusion: ${nutrition.kcal ?? "unknown"} kcal, ${nutrition.protein ?? "unknown"} g protein, ${nutrition.carbs ?? "unknown"} g carbohydrates, and ${nutrition.fat ?? "unknown"} g total fat.`;
  }
  return `تقدير الحصة بعد الاستبعاد: ${nutrition.kcal ?? "غير متوفر"} سعر حراري، ${nutrition.protein ?? "غير متوفر"} جم بروتين، ${nutrition.carbs ?? "غير متوفر"} جم كربوهيدرات، و${nutrition.fat ?? "غير متوفر"} جم دهون كلية.`;
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
  // BUG-13: a definitional question ("ما المقصود بالدهون المشبعة؟") asks what a
  // concept means, not what one recipe's value is. It must reach sourced general
  // guidance rather than a recipe-specific nutrient lookup. Checked before the
  // nutrient branches, and only when no measurement word ("كام", "قيمة") is
  // present, so "كام الدهون المشبعة في الكشري" stays a recipe lookup.
  if (isDefinitionalQuestion(text)) return "general_guideline";
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
  private readonly expandedPlanner = new RuleBasedExpandedAgentPlanner();
  private readonly entityVocabulary: string[];

  public constructor(
    private readonly base: NutriGuardExpandedAgent,
    private readonly tools: NutriGuardToolset,
    private readonly dataset: UnifiedEgyptianDemoDataset,
    private readonly backend: GraduationBackendDataSource | null,
    private readonly claude: ClaudeLayer = new ClaudeLayer({ classifierClient: null, formatterClient: null }),
    private readonly mealSelection: MealPlanSelectionFlow = buildMealPlanSelectionFlow({ dataset }),
  ) {
    // Dataset-wide entity vocabulary for the grounding validator: any of these
    // names appearing in Claude prose while absent from the structured input is
    // a fabricated reference.
    this.entityVocabulary = [
      ...dataset.recipes.flatMap((recipe) => [recipe.name_ar, recipe.name_en, ...recipe.alt_names]),
      ...Object.values(INGREDIENT_NAMES_AR),
      ...Object.keys(dataset.ingredientNutrition).map((key) => key.replaceAll("_", " ")),
    ].filter((name) => typeof name === "string" && name.trim().length >= 3);
  }

  /** Read-only access to the Claude layer, used by the internal debug route. */
  public get claudeLayer(): ClaudeLayer {
    return this.claude;
  }

  public async invoke(input: { message: string; language?: "ar-EG" | "ar" | "en"; context?: GraduationConversationContext }): Promise<ExpandedAgentResponse> {
    // With no Claude stage configured and no debug panel enabled, the agent
    // behaves exactly as it did before Step 17b: no added work, no added
    // latency, and byte-identical responses.
    if (!this.claude.tracingEnabled) return this.invokeDeterministic(input);
    return this.invokeWithClaudeLayer(input);
  }

  private async invokeDeterministic(
    input: { message: string; language?: "ar-EG" | "ar" | "en"; context?: GraduationConversationContext },
    forcedRecipeReference?: UnifiedDemoRecipe,
  ): Promise<ExpandedAgentResponse> {
    const focusedContext = this.contextForMessage(input.context, input.message);
    const response = await this.invokeCore({ ...input, context: focusedContext }, forcedRecipeReference);
    return this.withConversationMemory(response, input.context, focusedContext);
  }

  /**
   * Part A + Part B orchestration.
   *
   * Order matters: the rule-based safety screen runs first so a medical_safety,
   * emergency, or integrity-flagged request never reaches Claude in any role
   * (invariant I4, acceptance criterion 6). Deterministic routing is then run
   * unchanged, so Claude cannot influence which answer is produced — only how
   * an already-computed answer is worded, and only after grounding validation.
   */
  private async invokeWithClaudeLayer(input: { message: string; language?: "ar-EG" | "ar" | "en"; context?: GraduationConversationContext }): Promise<ExpandedAgentResponse> {
    const startedAt = performance.now();
    const query = input.message.trim();
    const language = answerLanguage(query, input.language);
    const namedRecipes = explicitlyNamedRecipes(this.dataset, query);
    const ruleBasedIntent = classifyGraduationIntent(query, namedRecipes);
    const trace = newTrace({ traceId: randomUUID(), language, ruleBasedIntent });

    const preScreen = safetyPreScreen(query, ruleBasedIntent);
    trace.safetyRouted = preScreen.safetyRouted;
    trace.safetyRouteReason = preScreen.reason;
    let forcedRecipeReference: UnifiedDemoRecipe | undefined;

    if (!preScreen.safetyRouted) {
      const ruleBased: RuleBasedClassification = {
        graduationIntent: ruleBasedIntent,
        expandedPlannerIntent: expandedPlannerIntentOf(await this.expandedPlanner.plan({
          systemPrompt: NUTRIGUARD_SYSTEM_PROMPT,
          promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
          userMessage: query,
          language,
        }).catch(() => null)),
      };
      const classification = await this.claude.classificationStage({
        message: query,
        language,
        context: this.classifierContext(input.context),
        ruleBased,
        resolvers: this.entityResolvers(),
      });      trace.nluRoute = classification.arbitration.route;
      trace.expandedPlannerIntent = ruleBased.expandedPlannerIntent;
      trace.claudeIntent = classification.arbitration.claude?.intent ?? null;
      trace.claudeConfidence = classification.arbitration.claude?.confidence ?? null;
      trace.claudeIntentAgreed = classification.arbitration.agreed;
      trace.classifierModel = classification.arbitration.claudeModel;
      trace.classifierFailureReason = classification.arbitration.claudeFailureReason;
      trace.latencies.claudeClassifierMs = classification.latencyMs;
      if (classification.entityReport) {
        trace.entityCandidatesTotal = classification.entityReport.records.length;
        trace.entityCandidatesAccepted = classification.entityReport.acceptedCount;
        trace.entityCandidatesRejected = classification.entityReport.rejectedCount;
      }
      if (this.claude.config.rawMessageDebugOptIn) trace.rawMessage = query;

      // Reference resolution. The deterministic cue is tried first; the model is
      // consulted only when the deterministic path found nothing, the user named
      // no dish at all, and a closed candidate set exists. Consulting it while a
      // dish is named explicitly is what caused BUG-10.
      const candidates = this.referenceCandidates(input.context);
      const deterministicallyResolved = usesImplicitRecipeReference(query);
      const namesARecipeExplicitly = namedRecipes.length > 0;
      // An ambiguous follow-up to a comparison is resolved as a continuation of
      // that comparison, so the model must not be asked to pick one of the two
      // compared dishes — doing so turned "مين الأفضل؟" into a single-recipe answer.
      const continuesComparison = this.classifierContextIsComparison(input.context) && isComparisonFollowup(query);
      if (this.claude.config.referenceResolutionEnabled && !deterministicallyResolved && !namesARecipeExplicitly && !continuesComparison && candidates.length > 0) {
        const validation = this.validateReferenceResolution(classification.arbitration.claude?.referenced_recipe_id, candidates);
        forcedRecipeReference = validation.recipe;
        trace.referenceResolution = validation.outcome;
        trace.referenceResolvedRecipeId = validation.recipe?.recipe_id ?? null;
      } else {
        trace.referenceResolution = namesARecipeExplicitly
          ? "skipped_explicit_recipe_named"
          : continuesComparison
            ? "skipped_comparison_continuation"
            : deterministicallyResolved ? "resolved_deterministically" : "not_proposed";
      }
    }

    // Deterministic pipeline, unchanged and always authoritative.
    const calculationStartedAt = performance.now();
    const { result: deterministic, collection } = await withRetrievalCollection(() => this.invokeDeterministic(input, forcedRecipeReference));
    trace.latencies.deterministicCalculationMs = Math.round(performance.now() - calculationStartedAt);

    const searchToolInvoked = deterministic.toolTrace.some((entry) => entry.tool === "search_recipes" || entry.tool === "search_guidelines");
    const retrieval = summarizeRetrieval(collection, searchToolInvoked);
    trace.retrievalRoute = retrieval.route as RetrievalRoute;
    trace.geminiEmbeddingsCalled = retrieval.geminiEmbeddingsCalled;
    trace.qdrantReturnedResult = retrieval.qdrantReturnedResult;
    trace.localFallbackSearchUsed = retrieval.localFallbackSearchUsed;
    trace.latencies.embeddingCallMs = retrieval.embeddingCallMs;
    trace.latencies.vectorSearchMs = retrieval.vectorSearchMs;
    trace.latencies.localFallbackSearchMs = retrieval.localFallbackSearchMs;

    const formatted = await this.applyFormatter(deterministic, language, preScreen.safetyRouted, trace);
    trace.latencies.totalMs = Math.round(performance.now() - startedAt);
    this.claude.recordTrace(trace);
    return formatted;
  }

  /**
   * Replace the deterministic wording with Claude's only when Part B is in
   * scope for the intent and the grounding validator passed.
   */
  private async applyFormatter(
    response: ExpandedAgentResponse,
    language: "ar-EG" | "ar" | "en",
    safetyRouted: boolean,
    trace: ClaudeRequestTrace,
  ): Promise<ExpandedAgentResponse> {
    const intent = typeof response.data?.intent === "string" ? response.data.intent : trace.ruleBasedIntent;
    // I4/B3: the fixed safety copy is never rephrased, and only fully computed
    // successful answers are eligible at all. Step 16 selection turns are also
    // excluded: their exact wording carries the confirmation contract (the
    // operation id, the "nothing is logged yet" statement, and the mock notice),
    // which must never be reworded by a model.
    const eligible = !safetyRouted
      && response.status === "ok"
      && response.safetyFlags.length === 0
      && response.integrityFlags.length === 0
      && response.primaryIntent !== "medical_safety_request"
      && intent !== "meal_plan_selection"
      && response.data !== null;
    if (!eligible) {
      trace.formatterRoute = intent === "medical_safety" || response.primaryIntent === "medical_safety_request"
        ? "formatter_hard_disabled_medical_safety"
        : "formatter_intent_out_of_scope";
      return response;
    }
    const stage = await this.claude.formatterStage({
      intent,
      language,
      deterministicText: response.message,
      data: response.data,
      knownEntityVocabulary: this.entityVocabulary,
    });
    trace.formatterRoute = stage.route;
    trace.formatterModel = stage.model;
    trace.formatterFailureReason = stage.failureReason;
    trace.groundingPassed = stage.grounding ? stage.grounding.passed : null;
    trace.groundingFailureCodes = stage.grounding?.violations.map((violation) => violation.code) ?? [];
    trace.groundingViolationTokens = stage.grounding?.violations.map((violation) => violation.token) ?? [];
    trace.latencies.claudeFormatterMs = stage.formatterLatencyMs;
    trace.latencies.groundingValidationMs = stage.groundingLatencyMs;
    if (stage.rejectedOutput !== null && this.claude.config.rawMessageDebugOptIn) {
      trace.rejectedFormatterOutput = stage.rejectedOutput;
      trace.rejectedFormatterFacts = JSON.stringify(stage.rejectedFacts?.values ?? null);
    }
    // Any rejection keeps the deterministic template verbatim.
    if (stage.text === null) return response;
    return { ...response, message: stage.text };
  }

  /**
   * Bounded structural summary of the short-term session context.
   *
   * Reuses the existing conversation memory rather than reimplementing it, and
   * passes intent labels and identifiers only — never a nutrition value. The
   * candidate list is the closed set a conversational reference may resolve to.
   */
  private classifierContext(context?: GraduationConversationContext): ClassifierContextSummary | null {
    if (!context) return null;
    return {
      lastIntent: context.lastIntent,
      activeRecipeId: context.memory?.activeRecipeId ?? null,
      turnCount: context.memory?.turnCount ?? null,
      pendingOperation: context.lastIntent === "meal_plan_draft"
        ? "meal_plan_draft_awaiting_calorie_target"
        : context.lastIntent === "meal_selection"
          ? `meal_selection_${context.selection.phase}`
          : null,
      referenceCandidates: this.referenceCandidates(context),
    };
  }

  /**
   * The closed candidate set for reference resolution, taken entirely from
   * deterministic session memory. The model can only pick from this list.
   */
  private referenceCandidates(context?: GraduationConversationContext): ReferenceCandidate[] {
    if (!context) return [];
    const ids = new Set<string>();
    if (context.memory?.activeRecipeId) ids.add(context.memory.activeRecipeId);
    for (const id of context.memory?.recentRecipeIds ?? []) ids.add(id);
    if (context.lastIntent === "recipe_reference" || context.lastIntent === "lighter_modification") ids.add(context.recipeId);
    if (context.lastIntent === "meal_calorie_target" && context.recipeId) ids.add(context.recipeId);
    if (context.lastIntent === "meal_plan") for (const id of context.recipeIds) ids.add(id);
    if (context.lastIntent === "meal_selection") {
      for (const category of context.selection.categories) for (const option of category.options) for (const id of option.recipeIds) ids.add(id);
    }
    return [...ids]
      .slice(0, 8)
      .flatMap((recipeId) => {
        const recipe = this.dataset.recipes.find((candidate) => candidate.recipe_id === recipeId);
        return recipe ? [{ recipeId, displayName: recipe.name_ar }] : [];
      });
  }

  /**
   * Validate a model-proposed reference (A5 applied to reference resolution).
   *
   * Two independent gates: the id must be a member of the closed candidate set
   * that deterministic memory produced, and it must resolve to a real dataset
   * recipe. A value failing either gate is discarded, never used.
   */
  private validateReferenceResolution(
    proposedId: string | null | undefined,
    candidates: readonly ReferenceCandidate[],
  ): { recipe: UnifiedDemoRecipe | undefined; outcome: "not_proposed" | "accepted" | "rejected_outside_candidate_set" | "rejected_unknown_recipe" } {
    if (!proposedId) return { recipe: undefined, outcome: "not_proposed" };
    if (!candidates.some((candidate) => candidate.recipeId === proposedId)) {
      return { recipe: undefined, outcome: "rejected_outside_candidate_set" };
    }
    const recipe = this.dataset.recipes.find((candidate) => candidate.recipe_id === proposedId);
    return recipe ? { recipe, outcome: "accepted" } : { recipe: undefined, outcome: "rejected_unknown_recipe" };
  }

  /** True when the incoming context is a stored two-recipe comparison. */
  private classifierContextIsComparison(context?: GraduationConversationContext): boolean {
    if (!context) return false;
    if (context.lastIntent === "compare_recipes") return true;
    return context.memory?.comparison != null;
  }

  /** A5 resolvers: the exact paths a user-typed name would take. */
  private entityResolvers(): AgentEntityResolvers {
    return {
      resolveRecipeId: (name) => explicitlyNamedRecipe(this.dataset, name)?.recipe_id ?? null,
      resolveIngredientKey: (name) => {
        const normalized = normalizedLookupText(name);
        if (!normalized) return null;
        const match = INGREDIENT_ALIASES
          .flatMap((entry) => entry.aliases.map((alias) => ({ key: entry.key, alias: normalizedLookupText(alias) })))
          .filter((candidate) => candidate.alias.length >= 2 && candidate.alias === normalized)
          .sort((left, right) => right.alias.length - left.alias.length)[0];
        return match?.key ?? null;
      },
    };
  }

  /**
   * Read the Step 16 selection state out of the existing session context.
   *
   * Reads the SAME bounded memory object the BUG-09 fix introduced. The focused
   * context pointer is preferred when present, and the shared memory is the
   * fallback, which is what lets a selection survive intervening turns about
   * something else.
   */
  private mealSelectionState(context?: GraduationConversationContext): MealSelectionState | null {
    if (context?.lastIntent === "meal_selection") return context.selection;
    return context?.memory?.mealSelection ?? null;
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
    const recipeCue = usesImplicitRecipeReference(text);
    // BUG-16: a remembered comparison is re-focused for an ambiguous follow-up,
    // but an explicit pronoun reference to a single dish still wins so
    // "خففها"/"قارنها" keep their existing behaviour.
    if (memory.comparison && !recipeCue && isComparisonFollowup(text)) {
      return {
        schemaVersion: "1.0",
        lastIntent: "compare_recipes",
        firstRecipeId: memory.comparison.firstRecipeId,
        secondRecipeId: memory.comparison.secondRecipeId,
        basis: memory.comparison.basis,
        nutrient: memory.comparison.nutrient,
        memory,
      };
    }
    if (memory.activeRecipeId && recipeCue) return { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: memory.activeRecipeId, memory };
    // A bare nutrient question continues on the dish already under discussion.
    if (memory.activeRecipeId && isBareNutrientQuestion(text)) return { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: memory.activeRecipeId, memory };
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
      comparison: base.comparison ? { ...base.comparison } : null,
      mealSelection: base.mealSelection ? structuredClone(base.mealSelection) : null,
    } : {
      schemaVersion: "1.0", turnCount: 1, activeRecipeId: null, recentRecipeIds: [], mealPlan: null, singleMealTarget: null, lighterModification: null, comparison: null, mealSelection: null,
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
      if (candidate.lastIntent === "compare_recipes") {
        // Remember BOTH compared recipes and the basis. `activeRecipeId` still
        // becomes the first one so existing pronoun follow-ups ("خففها") keep
        // working, but the comparison itself is no longer lost.
        memory.comparison = { firstRecipeId: candidate.firstRecipeId, secondRecipeId: candidate.secondRecipeId, basis: candidate.basis, nutrient: candidate.nutrient };
        memory.recentRecipeIds = [candidate.firstRecipeId, candidate.secondRecipeId, ...memory.recentRecipeIds.filter((id) => id !== candidate.firstRecipeId && id !== candidate.secondRecipeId)].slice(0, 8);
        memory.activeRecipeId = candidate.firstRecipeId;
      }
      if (candidate.lastIntent === "meal_selection") {
        // Step 16 state joins the same shared memory as every other feature, so a
        // selection reference or a pending confirmation survives turns spent on an
        // unrelated question.
        memory.mealSelection = structuredClone(candidate.selection);
        const shown = candidate.selection.categories.flatMap((category) => category.options.flatMap((option) => option.recipeIds));
        memory.recentRecipeIds = [...new Set([...shown, ...memory.recentRecipeIds])].slice(0, 8);
      }
    };
    absorb(incoming);
    absorb(next);
    // BUG-11: a rejected recipe must not survive in short-term memory, or the
    // next pronoun would silently resolve straight back to it.
    const clearedRecipeId = typeof responseData.clearActiveRecipeId === "string" ? responseData.clearActiveRecipeId : null;
    if (clearedRecipeId) {
      memory.recentRecipeIds = memory.recentRecipeIds.filter((id) => id !== clearedRecipeId);
      if (memory.activeRecipeId === clearedRecipeId) memory.activeRecipeId = null;
      if (memory.lighterModification?.recipeId === clearedRecipeId) memory.lighterModification = null;
      if (memory.singleMealTarget?.recipeId === clearedRecipeId) memory.singleMealTarget = null;
      const nextRecipeId = next?.lastIntent === "recipe_reference" ? next.recipeId : null;
      if (nextRecipeId && nextRecipeId !== clearedRecipeId) memory.activeRecipeId = nextRecipeId;
    }
    const current = next ?? focused ?? incoming;
    if (!current) return response;
    // Clearing memory alone is not enough: the top-level context pointer must
    // also stop aiming at the rejected recipe, otherwise the very next
    // "اعرضلي مكونات الوصفه" resolves straight back to it.
    if (clearedRecipeId && contextPointsAtRecipe(current, clearedRecipeId)) return response;
    const conversationContext: GraduationConversationContext = { ...current, memory };
    return { ...response, data: { ...responseData, conversationContext } };
  }

  private async invokeCore(
    input: { message: string; language?: "ar-EG" | "ar" | "en"; context?: GraduationConversationContext },
    forcedRecipeReference?: UnifiedDemoRecipe,
  ): Promise<ExpandedAgentResponse> {
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
    // BUG-10 guard. A model-resolved reference may only fill a gap, never
    // outrank a dish the user named explicitly. Without this, asking for
    // "سعرات الكشري" while an unrelated recipe sat in session memory returned
    // that unrelated recipe's (correctly calculated) numbers — a wrong answer
    // that looks right, which is far harder to spot than a fabrication.
    const explicitlyNamed = namedRecipes.length > 0;
    // Captured BEFORE any implicit or model-resolved reference is spliced in, so
    // later routing can ask "did the USER name a dish?" rather than "does the
    // list contain one?". Without this, an injected reference made an ambiguous
    // comparison follow-up look like an explicit single-dish request.
    const userNamedRecipeCount = namedRecipes.length;
    const modelReference = explicitlyNamed ? undefined : forcedRecipeReference;
    const resolvedReference = modelReference ?? referencedRecipe;
    // Precedence rule: an implicit reference may never displace a dish the user
    // named. The single exception is a verb carrying an attached pronoun
    // ("قارنها بالكشري", "خففها"), where the remembered dish is grammatically a
    // participant in the request rather than a competitor to the named one.
    const attachedPronounVerb = /(?:قارنها|خففها|قللها|زودها)/u.test(query);
    const implicitReferenceAllowed = attachedPronounVerb
      || (!explicitlyNamed && (usesImplicitRecipeReference(query) || isBareNutrientQuestion(query)));
    const usesImplicitReference = modelReference !== undefined || implicitReferenceAllowed;
    if (resolvedReference && usesImplicitReference && !namedRecipes.some((recipe) => recipe.recipe_id === resolvedReference.recipe_id)) namedRecipes.unshift(resolvedReference);
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

    // Step 16, part 1: turns that answer an already-displayed option list, an
    // already-displayed confirmation summary, or a confirmation with no live
    // pending operation. Runs before generic conversational handling so a
    // confirmation can never be swallowed as a bare acknowledgement, and returns
    // null for anything unrelated so the rest of the router is unaffected.
    const mealSelectionState = this.mealSelectionState(input.context);
    const selectionTurn = await this.mealSelection.handleStateTurn({ message: query, language, state: mealSelectionState });
    if (selectionTurn) return selectionTurn;

    const conversationalResponse = this.scopedConversationResponse(query, language);
    if (conversationalResponse) return conversationalResponse;

    // BUG-11 safety net. When the user explicitly rejects what was just shown,
    // never serve that same result again. This exists independently of the
    // BUG-10 fix because a mismatch can arise from any cause: an ambiguous
    // name, a stale session reference, or simply the wrong dish being recorded.
    if (detectsResultRejection(query)) {
      const rejectedId = referencedId ?? input.context?.memory?.activeRecipeId ?? null;
      if (rejectedId) return this.rejectedResultResponse(rejectedId, namedRecipes, language);
    }

    // BUG-16: an ambiguous follow-up to a comparison stays inside that
    // comparison. Only when the user names no dish of their own — naming two
    // dishes is a fresh comparison, naming one is a normal single-recipe request.
    if (input.context?.lastIntent === "compare_recipes" && userNamedRecipeCount === 0 && isComparisonFollowup(query)) {
      const continuation = this.comparisonFollowup(input.context, query, language);
      if (continuation) return continuation;
    }

    // The graduation UI exposes one answer, not raw retrieval candidates. Safety and
    // integrity always keep the authority of the production agent above this router.
    if (deterministicIntent === "medical_safety") return this.medicalSafetyFallback(query, language, result);
    // Step 16, part 2: a fresh multi-option meal-plan request. Deliberately placed
    // after the medical-safety gate so a safety-routed message can never be
    // answered with a meal plan, and before the single-answer day planner so an
    // explicit multi-category or snacks request is not collapsed into one plan.
    const selectionRequest = await this.mealSelection.handleNewRequest({ message: query, language, state: mealSelectionState });
    if (selectionRequest) return selectionRequest;
    const directMealPlan = this.recommendMealPlan(query, language, input.context);
    if (directMealPlan) return directMealPlan;
    if (mealCategory(query) || input.context?.lastIntent === "meal_calorie_target") {
      const directCalorieTarget = this.recommendToCalorieTarget(query, language, input.context);
      if (directCalorieTarget) return directCalorieTarget;
    }
    if (namedRecipes.length === 0 && hasIngredientExclusionRequest(query) && /(?:وجبه|وجبة|اكل|أكل|meal|food)/iu.test(query)) {
      const exclusionRecommendation = this.recommendWithExclusions(query, language);
      if (exclusionRecommendation) return exclusionRecommendation;
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
    const previous = context?.lastIntent === "meal_plan" || context?.lastIntent === "meal_plan_draft" ? context : undefined;
    const isPlanRequest = /(?:حض(?:ر|ّ?ر)|جهز|اعمل|رتب).{0,30}(?:وجبات|اكل\s+اليوم)|\d+\s*(?:وجبات|meals?)|(?:وجبات|اكل)\s+(?:اليوم|يوم|طول\s+اليوم)|طول\s+اليوم|خطه\s+وجبات|خطة\s+وجبات|نظام\s+يوم|هدف(?:ي)?\s+(?:في\s+)?السعرات\s+اليومي|meal\s+plan|meals?\s+for\s+the\s+day|prepare.{0,20}meals?/iu.test(normalized);
    const hasDailyTargetWording = /(?:هدف(?:ي)?|السعرات\s+اليومي|في\s+اليوم|طول\s+اليوم|daily\s+(?:target|calories?))/iu.test(normalized);
    const countMatch = normalized.match(/(\d+)\s*(?:وجبه|وجبة|وجبات|meals?)/iu);
    const requestedMealCount = countMatch ? Number(countMatch[1]) : null;
    const changesMealCount = /(?:زود|ضيف|اضف|قلل|احذف|شيل|increase|add|remove|reduce).{0,12}(?:وجبه|وجبة|وجبات|meal)/iu.test(normalized);
    // A fresh request for ONE meal must not be absorbed as a follow-up to an
    // earlier day plan. Previously any exclusion phrase ("ميكنش فيها منتجات
    // ألبان") was enough to make a single-meal request rebuild the whole plan,
    // so "وجبة فطار 500 سعر" returned three meals totalling 500 kcal.
    const planModificationVerb = /(?:قلل|خفض|زود|ارفع|غير|بدل|خلي|احذف|شيل|ارجع|reduce|increase|change|remove)/iu.test(normalized);
    const singleMealRequest = !planModificationVerb
      && !hasDailyTargetWording
      && requestedMealCount === null
      && !changesMealCount
      && !/(?:وجبات|meals)/iu.test(normalized)
      && (mealCategory(normalized) !== null || /وجب(?:ه|ة)/u.test(normalized));
    const isPlanFollowup = Boolean(previous && !singleMealRequest && (hasDailyTargetWording || requestedMealCount !== null || changesMealCount || hasIngredientExclusionRequest(normalized) || /(?:قلل|خفض|زود|ارفع|غير|بدل|خلي|اقل|اكتر|reduce|increase|change)/iu.test(normalized)));
    if (!isPlanRequest && !isPlanFollowup) return null;
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
    const choose = (categories: ReadonlySet<string>, desired: number, enforceCeiling: boolean) => this.dataset.recipes
      .filter((recipe) => categories.has(recipe.category) && !used.has(recipe.recipe_id) && !recipeContainsExcludedIngredient(recipe, exclusions))
      .map((recipe) => ({ recipe, nutrition: calculateUnifiedDemoNutrition(this.dataset, recipe).perServing }))
      .filter((entry): entry is typeof entry & { nutrition: typeof entry.nutrition & { kcal: number } } => entry.nutrition.kcal !== null)
      .filter((entry) => !enforceCeiling || entry.nutrition.kcal <= desired)
      .sort((a, b) => Math.abs(a.nutrition.kcal - desired) - Math.abs(b.nutrition.kcal - desired) || a.recipe.recipe_id.localeCompare(b.recipe.recipe_id))[0];
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
    const meals: Array<{ slot: string; recipe: UnifiedDemoRecipe; nutrition: ReturnType<typeof calculateUnifiedDemoNutrition>["perServing"] & { kcal: number } }> = [];
    for (const slot of requestedSlots) {
      const caloriesUsed = meals.reduce((sum, meal) => sum + meal.nutrition.kcal, 0);
      const slotsRemaining = mealCount - meals.length;
      const desired = calorieConstraint === "maximum" ? Math.max(0, (target - caloriesUsed) / slotsRemaining) : target * slot.share;
      const selected = choose(slot.categories, desired, calorieConstraint === "maximum");
      if (!selected) break;
      used.add(selected.recipe.recipe_id);
      meals.push({ slot: slot.key, recipe: selected.recipe, nutrition: selected.nutrition });
    }
    if (meals.length !== mealCount) {
      const conversationContext: MealPlanDraftConversationContext = { schemaVersion: "1.0", lastIntent: "meal_plan_draft", mealCount, excludedIngredientKeys: [...exclusions], calorieConstraint };
      return {
        status: "no_result", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
        message: language === "en" ? `The recorded recipes cannot satisfy ${mealCount} distinct meals under all of those rules. I did not silently ignore any rule.` : `الوصفات المسجلة لا تكفي لتجهيز ${mealCount} وجبات مختلفة مع كل الشروط دي. ما تجاهلتش أي شرط من غير ما أوضح.`,
        data: { intent: "meal_plan", reasonCode: "rules_cannot_be_satisfied", targetCaloriesKcal: target, mealCount, calorieConstraint, excludedIngredientKeys: [...exclusions], rulesUnmet: ["distinct_meals_within_calorie_rule"], conversationContext }, evidenceDocumentIds: [], provenance: [], toolTrace: [{ tool: "calculate_nutrition", ok: false, code: "rules_cannot_be_satisfied" }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }
    const total = Math.round(meals.reduce((sum, meal) => sum + meal.nutrition.kcal, 0) * 10) / 10;
    const difference = Math.round((total - target) * 10) / 10;
    const labels: Record<string, string> = language === "en" ? { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" } : { breakfast: "الفطار", lunch: "الغداء", dinner: "العشاء" };
    const groupOrder = ["breakfast", "lunch", "dinner"];
    const sections = groupOrder.flatMap((slot) => {
      const group = meals.filter((meal) => meal.slot === slot);
      if (group.length === 0) return [];
      const lines = group.map((meal, index) => `• ${index + 1}. ${language === "en" ? meal.recipe.name_en : meal.recipe.name_ar} — ${meal.nutrition.kcal} ${language === "en" ? "kcal" : "سعر حراري"}`);
      const subtotal = Math.round(group.reduce((sum, meal) => sum + meal.nutrition.kcal, 0) * 10) / 10;
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
      data: { intent: "meal_plan", recommendationType: "daily_calorie_plan", targetCaloriesKcal: target, totalCaloriesKcal: total, differenceCaloriesKcal: difference, mealCount, calorieConstraint, mealDistribution: slotCounts, rulesApplied: { maximumCaloriesKcal: calorieConstraint === "maximum" ? target : null, excludedIngredientKeys: [...exclusions], distinctRecipes: true, categorizedMeals: true }, excludedIngredientKeys: [...exclusions], meals: meals.map((meal) => ({ slot: meal.slot, slotIndex: meals.filter((candidate) => candidate.slot === meal.slot).indexOf(meal) + 1, recipeId: meal.recipe.recipe_id, name: language === "en" ? meal.recipe.name_en : meal.recipe.name_ar, perServing: meal.nutrition })), conversationContext },
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

  /**
   * User-facing provenance for one demo recipe.
   *
   * BUG-15: the recorded `source_url` is an `en.wikipedia.org` page for 214 of
   * the 215 demo recipes, and the dataset's own `metadata.review_status` is
   * `needs_review`. DATA_SOURCE_POLICY.md requires that a record whose
   * review status is not `approved` must not be surfaced to users, and that
   * user-facing results cite only approved active sources. The URL was being
   * rendered by the chat UI as a clickable "دليل مرتبط" (related evidence) link
   * next to calculated nutrition, which was wrong twice over:
   *
   *  1. it presented an unapproved source as approved evidence; and
   *  2. it misattributed the numbers — Wikipedia is the recorded *culinary*
   *     source for the dish text, while the nutrition is recalculated from
   *     `ingredient_nutrition_reference`.
   *
   * The link is therefore withheld (`url: null`, which the UI renders as plain
   * text rather than an anchor). The attribution itself is preserved in the
   * title, because the dish text is reused under CC BY-SA 4.0 and dropping
   * attribution entirely would trade a policy problem for a licence one.
   */
  private recipeProvenance(recipe: UnifiedDemoRecipe, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse["provenance"][number] {
    const name = language === "en" ? recipe.name_en : recipe.name_ar;
    return {
      sourceId: "DEMO-UNIFIED-EGYPTIAN-DATASET",
      versionId: "2.0-final-demo-normalized",
      title: language === "en"
        ? `${name} — project demo dataset (nutrition recalculated from the ingredient reference; dish text from an unapproved candidate source pending review)`
        : `${name} — بيانات عرض المشروع (القيم الغذائية محسوبة من مرجع المكونات؛ نص الطبق من مصدر مرشّح غير معتمد بعد المراجعة)`,
      url: null,
      accessedAt: this.dataset.metadata.created_date,
      locator: recipe.recipe_id,
    };
  }

  /**
   * Response to an explicit rejection of the previous result (BUG-11).
   *
   * Two branches, and neither can re-serve the rejected recipe:
   *  - the correction names exactly one different, resolvable dish, so
   *    resolution is re-attempted with that corrected understanding;
   *  - otherwise the mismatch is acknowledged, the rejected dish is named so
   *    the user can see what went wrong, and a precise name is requested.
   *
   * Both branches clear the rejected recipe from short-term memory so a later
   * pronoun cannot silently resolve back to it.
   */
  private rejectedResultResponse(
    rejectedRecipeId: string,
    namedRecipes: readonly UnifiedDemoRecipe[],
    language: "ar-EG" | "ar" | "en",
  ): ExpandedAgentResponse {
    const rejected = this.dataset.recipes.find((recipe) => recipe.recipe_id === rejectedRecipeId);
    const rejectedName = rejected ? (language === "en" ? rejected.name_en : rejected.name_ar) : rejectedRecipeId;
    const corrected = namedRecipes.filter((recipe) => recipe.recipe_id !== rejectedRecipeId);

    if (corrected.length === 1) {
      const recipe = corrected[0]!;
      const calculation = calculateUnifiedDemoNutrition(this.dataset, recipe);
      const nutrition = calculation.perServing;
      const name = language === "en" ? recipe.name_en : recipe.name_ar;
      const ingredients = recipe.ingredients
        .map((item) => `• ${item.quantity} ${localizedUnit(item.unit, language)} ${ingredientLabel(item.ingredient, language)}`)
        .join("\n");
      const message = language === "en"
        ? `You are right — I showed ${rejectedName}, which is not what you asked for. The recipe you mean is ${name}.\n\nIngredients (${recipe.servings} servings):\n${ingredients}\n\nEstimated per serving: ${nutrition.kcal ?? "unknown"} kcal, ${nutrition.protein ?? "unknown"} g protein, ${nutrition.carbs ?? "unknown"} g carbohydrates, and ${nutrition.fat ?? "unknown"} g fat.`
        : `معاك حق — اللي عرضته كان ${rejectedName}، وده مش اللي طلبته. الوصفة المقصودة هي ${name}.\n\nالمكونات (${recipe.servings} حصص):\n${ingredients}\n\nتقدير الحصة: ${nutrition.kcal ?? "غير معروف"} سعر حراري، ${nutrition.protein ?? "غير معروف"} جم بروتين، ${nutrition.carbs ?? "غير معروف"} جم كربوهيدرات، و${nutrition.fat ?? "غير معروف"} جم دهون.`;
      return {
        status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [], message,
        data: {
          intent: "find_recipe", correctionApplied: true, reasonCode: "user_rejected_previous_result",
          rejectedRecipeId, rejectedRecipeName: rejectedName,
          recipeId: recipe.recipe_id, recipeName: name,
          recipe: { recipeId: recipe.recipe_id, nameAr: recipe.name_ar, nameEn: recipe.name_en, servings: recipe.servings, ingredients: recipe.ingredients, method: recipe.method_summary, nutritionPerServing: nutrition },
          clearActiveRecipeId: rejectedRecipeId,
          conversationContext: { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: recipe.recipe_id },
        },
        evidenceDocumentIds: [`DEMO-${recipe.recipe_id}`], provenance: [this.recipeProvenance(recipe, language)],
        toolTrace: [{ tool: "search_recipes", ok: true, code: "user_correction_reresolved" }, { tool: "calculate_nutrition", ok: true, code: null }],
        promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }

    const ambiguous = corrected.length > 1;
    const message = language === "en"
      ? `You are right, and I am sorry — I showed ${rejectedName}, which does not match what you asked for. I will not repeat it.${ambiguous ? ` I can see more than one possible dish in your message (${corrected.map((recipe) => recipe.name_en).join(", ")}).` : ""}\n\nWrite the exact Egyptian dish name on its own, for example “كشري” or “فول مدمس”, and I will resolve it precisely instead of guessing.`
      : `معاك حق وأنا آسف — اللي عرضته كان ${rejectedName}، وهو مش مطابق لطلبك، ومش هكرره.${ambiguous ? ` وشايف في رسالتك أكتر من طبق محتمل (${corrected.map((recipe) => recipe.name_ar).join("، ")}).` : ""}\n\nاكتب اسم الأكلة المصرية بالظبط ولوحده، مثلًا «كشري» أو «فول مدمس»، وأنا أحددها بدقة بدل التخمين.`;
    return {
      status: "clarification", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [], message,
      data: {
        intent: "find_recipe", correctionApplied: true, reasonCode: "user_rejected_previous_result",
        requiredInput: "exact_recipe_name", rejectedRecipeId, rejectedRecipeName: rejectedName,
        candidateRecipeIds: corrected.map((recipe) => recipe.recipe_id),
        clearActiveRecipeId: rejectedRecipeId,
      },
      evidenceDocumentIds: [], provenance: [],
      toolTrace: [{ tool: "search_recipes", ok: false, code: "user_rejected_previous_result" }],
      promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  /**
   * Continue a comparison instead of abandoning it (BUG-16).
   *
   * Reached only when the previous turn was a comparison and the current message
   * names no dish of its own. It never returns a single-recipe result for one of
   * the two compared items.
   *
   * Numbers come from the same deterministic calculator the original comparison
   * used, so a criterion follow-up is answered with real recomputed values on the
   * basis already established, not from remembered prose.
   */
  private comparisonFollowup(
    context: ComparisonConversationContext,
    query: string,
    language: "ar-EG" | "ar" | "en",
  ): ExpandedAgentResponse | null {
    const first = this.dataset.recipes.find((recipe) => recipe.recipe_id === context.firstRecipeId);
    const second = this.dataset.recipes.find((recipe) => recipe.recipe_id === context.secondRecipeId);
    if (!first || !second) return null;

    const basis = context.basis === "per_serving" ? "perServing" : "per100g";
    const basisLabel = basis === "perServing" ? (language === "en" ? "per serving" : "للحصة") : (language === "en" ? "per 100 g" : "لكل 100 جرام");
    const firstName = language === "en" ? first.name_en : first.name_ar;
    const secondName = language === "en" ? second.name_en : second.name_ar;
    const nextContext: ComparisonConversationContext = { ...context };
    const provenance = [this.recipeProvenance(first, language), this.recipeProvenance(second, language)];
    const evidenceDocumentIds = [`DEMO-${first.recipe_id}`, `DEMO-${second.recipe_id}`];

    const nutrient = comparisonNutrient(query);
    if (nutrient) {
      const firstValue = calculateUnifiedDemoNutrition(this.dataset, first)[basis][nutrient];
      const secondValue = calculateUnifiedDemoNutrition(this.dataset, second)[basis][nutrient];
      const unit = nutrient === "sodium" ? (language === "en" ? "mg" : "مجم") : nutrient === "kcal" ? (language === "en" ? "kcal" : "سعر حراري") : language === "en" ? "g" : "جم";
      const label = language === "en"
        ? ({ sodium: "sodium", protein: "protein", carbs: "carbohydrates", fat: "total fat", fiber: "fiber", sugar: "sugar", kcal: "calories" } as const)[nutrient]
        : ({ sodium: "الصوديوم", protein: "البروتين", carbs: "الكربوهيدرات", fat: "الدهون الكلية", fiber: "الألياف", sugar: "السكر", kcal: "السعرات" } as const)[nutrient];
      const wantsHigher = /(?:اكتر|اكثر|اعلي|اغني|higher|more|richer)/u.test(normalizedLookupText(query));
      let verdict: string;
      if (firstValue === null || secondValue === null) {
        verdict = language === "en" ? "A conclusion is unavailable because one value is missing." : "لا يمكن الحكم لأن إحدى القيمتين غير متوفرة.";
      } else if (firstValue === secondValue) {
        verdict = language === "en" ? "Both are equal on this metric." : "القيمتان متساويتان في العنصر ده.";
      } else {
        const winner = wantsHigher
          ? (firstValue > secondValue ? firstName : secondName)
          : (firstValue < secondValue ? firstName : secondName);
        verdict = language === "en"
          ? `${winner} is ${wantsHigher ? "higher" : "lower"} in ${label} on this basis.`
          : `${winner} هو ${wantsHigher ? "الأعلى" : "الأقل"} في ${label} على نفس الأساس.`;
      }
      nextContext.nutrient = nutrient;
      return {
        status: "ok", primaryIntent: "compare_recipes", language, safetyFlags: [], integrityFlags: [],
        message: language === "en"
          ? `Continuing the comparison of ${firstName} and ${secondName} — ${label} ${basisLabel}:\n\n• ${firstName}: ${firstValue ?? "unknown"} ${unit}\n• ${secondName}: ${secondValue ?? "unknown"} ${unit}\n\n${verdict}\n\nThis is a numerical comparison, not personalized medical advice.`
          : `بكمّل نفس المقارنة بين ${firstName} و${secondName} — ${label} ${basisLabel}:\n\n• ${firstName}: ${firstValue ?? "غير متوفر"} ${unit}\n• ${secondName}: ${secondValue ?? "غير متوفر"} ${unit}\n\n${verdict}\n\nدي مقارنة رقمية وليست نصيحة طبية شخصية.`,
        data: {
          intent: "compare_recipes", comparisonType: "followup_nutrient", continuedComparison: true,
          basis: context.basis, nutrient, unit,
          first: { recipeId: first.recipe_id, name: firstName, value: firstValue },
          second: { recipeId: second.recipe_id, name: secondName, value: secondValue },
          conversationContext: nextContext,
        },
        evidenceDocumentIds, provenance,
        toolTrace: [{ tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      };
    }

    // No criterion named: restate that there is no absolute winner and offer the
    // criteria, rather than inventing a preference or switching intent.
    const criteria = language === "en"
      ? "calories, protein, carbohydrates, total fat, fiber, or sodium"
      : "السعرات، البروتين، الكربوهيدرات، الدهون الكلية، الألياف، أو الصوديوم";
    const why = asksWhy(query);
    const message = language === "en"
      ? `${why ? "Because" : "As before,"} there is no absolute “better” between ${firstName} and ${secondName}: the answer depends on the metric that matters for your goal, and the two dishes do not win on the same ones.\n\nTell me which metric matters most — ${criteria} — and I will say which of the two wins on it ${basisLabel}, using the recorded values.`
      : `${why ? "لأن" : "زي ما قلت،"} مفيش «أفضل» بشكل مطلق بين ${firstName} و${secondName}: الإجابة تعتمد على العنصر المهم لهدفك، والاتنين مش بيتفوقوا في نفس العناصر.\n\nقولي العنصر الأهم لك — ${criteria} — وأنا أقولك مين الأفضل فيه ${basisLabel} بالقيم المسجلة.`;
    return {
      status: "clarification", primaryIntent: "compare_recipes", language, safetyFlags: [], integrityFlags: [],
      message,
      data: {
        intent: "compare_recipes", comparisonType: "followup_criterion_required", continuedComparison: true,
        requiredInput: "comparison_criterion", basis: context.basis,
        availableCriteria: ["kcal", "protein", "carbs", "fat", "fiber", "sodium"],
        first: { recipeId: first.recipe_id, name: firstName },
        second: { recipeId: second.recipe_id, name: secondName },
        conversationContext: nextContext,
      },
      evidenceDocumentIds, provenance,
      toolTrace: [{ tool: "calculate_nutrition", ok: true, code: "comparison_criterion_required" }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
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
    // BUG-12: nutrient detection runs on NORMALIZED text. The previous raw-text
    // patterns required an exact "ة" and no shadda, so ordinary Egyptian
    // spellings ("المشبعه", "المشبّعة") failed to register as a saturated-fat
    // request and the generic "دهون" branch answered with TOTAL fat instead — a
    // different nutrient, silently substituted for the one that was asked about.
    const nutrientQuery = normalizedLookupText(normalizeNumberDigits(query));
    const asksSaturatedFat = /(?:مشبعه|مشبع|saturated)/u.test(nutrientQuery);
    const requestedNutrients = [
      /(?:سعر|سعرات|كالوري|calorie|kcal)/u.test(nutrientQuery) ? "kcal" : null,
      /(?:بروتين|protein)/u.test(nutrientQuery) ? "protein" : null,
      /(?:كربوهيدرات|كارب|carb)/u.test(nutrientQuery) ? "carbs" : null,
      // Never treat a saturated-fat question as a total-fat question.
      /(?:دهون|fat)/u.test(nutrientQuery) && !asksSaturatedFat ? "fat" : null,
      /(?:الياف|fiber|fibre)/u.test(nutrientQuery) ? "fiber" : null,
      /(?:سكر|sugar)/u.test(nutrientQuery) ? "sugar" : null,
      /(?:صوديوم|ملح|sodium|salt)/u.test(nutrientQuery) ? "sodium" : null,
    ].filter((item): item is "kcal" | "protein" | "carbs" | "fat" | "fiber" | "sugar" | "sodium" => item !== null);
    const requested = requestedNutrients;
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
        data: { intent: "compare_recipes", comparisonType: "overview", demoOnly: true, reviewStatus: "needs_review", basis: basis === "perServing" ? "per_serving" : "per_100g", first: { recipeId: first.recipe_id, name: firstName }, second: { recipeId: second.recipe_id, name: secondName }, metrics: values, conversationContext: { schemaVersion: "1.0", lastIntent: "compare_recipes", firstRecipeId: first.recipe_id, secondRecipeId: second.recipe_id, basis: basis === "perServing" ? "per_serving" : "per_100g", nutrient: null } },
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
      data: { intent: "compare_recipes", demoOnly: true, reviewStatus: "needs_review", basis: basis === "perServing" ? "per_serving" : "per_100g", nutrient, first: { recipeId: first.recipe_id, name: firstName, value: firstValue }, second: { recipeId: second.recipe_id, name: secondName, value: secondValue }, unit, conversationContext: { schemaVersion: "1.0", lastIntent: "compare_recipes", firstRecipeId: first.recipe_id, secondRecipeId: second.recipe_id, basis: basis === "perServing" ? "per_serving" : "per_100g", nutrient } },
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
      const oilKeys = new Set(["vegetable_oil", "olive_oil", "ghee", "butter_raw"]);
      const removable = recipe.ingredients.filter((item) => requested.has(item.ingredient) || (genericOil && oilKeys.has(item.ingredient)));
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
    // BUG-14: state each reduction on an explicitly named basis. The previous
    // wording put "التخفيض الإضافي ... للحصة" next to "إجمالي التخفيض ... للحصة"
    // and never showed the whole-recipe figure's basis, so two or three numbers
    // that measure different things read as if they contradicted each other.
    const savedFullRounded = Math.round(savedFull * 10) / 10;
    const message = language === "en"
      ? `${continuing ? "A further reduction for" : "A lower-calorie"} ${name}: reduce the added ${displayedIngredient} from ${currentGrams} g to ${proposedGrams} g and keep the other recorded ingredients unchanged.\n\n`
        + `Reduction from this step — per serving: -${incrementalSavedPerServing} kcal\n`
        + `Cumulative reduction vs the recorded recipe — per serving: -${savedPerServing} kcal | whole recipe (${recipe.servings} servings): -${savedFullRounded} kcal\n`
        + `Serving calories: about ${previousPerServing} → ${newPerServing} kcal\n\n`
        + `The whole-recipe figure is the per-serving reduction across all ${recipe.servings} recorded servings, not a separate saving. This is a deterministic change based on the recorded oil quantity; taste and texture may change.`
      : `${continuing ? "تقليل إضافي لسعرات" : "نسخة أقل سعرات من"} ${name}: قلّل ${displayedIngredient} المضاف من ${currentGrams} جرام إلى ${proposedGrams} جرام، مع إبقاء باقي المكونات المسجلة كما هي.\n\n`
        + `التخفيض من الخطوة دي — للحصة الواحدة: -${incrementalSavedPerServing} سعر حراري\n`
        + `إجمالي التخفيض عن الوصفة المسجلة — للحصة الواحدة: -${savedPerServing} سعر حراري | لإجمالي الوصفة (${recipe.servings} حصص): -${savedFullRounded} سعر حراري\n`
        + `سعرات الحصة: من نحو ${previousPerServing} إلى ${newPerServing} سعر حراري\n\n`
        + `رقم إجمالي الوصفة هو نفس تخفيض الحصة مضروبًا في ${recipe.servings} حصص مسجلة، وليس توفيرًا منفصلًا أو رقمًا مختلفًا. ده تعديل محسوب من كمية الزيت المسجلة، وقد يغيّر الطعم أو القوام.`;
    conversationContext.proposedGrams = proposedGrams;
    return {
      status: "ok", primaryIntent: "lighter_recipe", language, safetyFlags: [], integrityFlags: [], message,
      data: { intent: "lighter_modification", demoOnly: true, reviewStatus: "needs_review", recipeId: recipe.recipe_id, servings: recipe.servings, modification: { ingredient: candidate.ingredient, originalGrams: candidate.grams, ...(continuing ? { previousGrams: currentGrams } : {}), proposedGrams }, originalCalories: { fullRecipe: calculation.totals.kcal, perServing: calculation.perServing.kcal }, previousModifiedCalories: { perServing: previousPerServing }, modifiedCalories: { fullRecipe: newFull, perServing: newPerServing }, caloriesSaved: { fullRecipe: savedFullRounded, perServing: savedPerServing, additionalPerServing: incrementalSavedPerServing, basisNote: `fullRecipe equals perServing multiplied by the ${recipe.servings} recorded servings; it is the same reduction expressed on a different basis, not an additional saving` }, conversationContext },
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
      provenance: recipes.map((recipe) => this.recipeProvenance(recipe, language)),
      toolTrace: [{ tool: "search_recipes", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private recommendWithExclusions(query: string, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse | null {
    const exclusions = new Set(excludedIngredientKeys(query));
    if (exclusions.size === 0) return null;
    const categoryPriority = new Map(["main_dish", "breakfast", "soup", "salad"].map((category, index) => [category, index]));
    const candidate = this.dataset.recipes
      .filter((recipe) => categoryPriority.has(recipe.category) && !recipeContainsExcludedIngredient(recipe, exclusions))
      .map((recipe) => ({ recipe, nutrition: calculateUnifiedDemoNutrition(this.dataset, recipe) }))
      .filter(({ nutrition }) => nutrition.perServing.kcal !== null)
      .sort((left, right) => (categoryPriority.get(left.recipe.category) ?? 99) - (categoryPriority.get(right.recipe.category) ?? 99)
        || left.recipe.recipe_id.localeCompare(right.recipe.recipe_id))[0];
    if (!candidate) return null;
    const { recipe, nutrition } = candidate;
    const title = language === "en" ? recipe.name_en : recipe.name_ar;
    const ingredients = recipe.ingredients.map((item) => `• ${item.quantity} ${localizedUnit(item.unit, language)} ${ingredientLabel(item.ingredient, language)}`).join("\n");
    const dairyRequest = [...DAIRY_INGREDIENT_KEYS].every((key) => exclusions.has(key));
    const exclusionNames = dairyRequest
      ? [language === "en" ? "the recorded dairy ingredients" : "منتجات الألبان المسجلة"]
      : [...exclusions].map((key) => ingredientLabel(key, language));
    const safetyNote = exclusionSafetyNote(exclusionNames, language);
    const nutritionSummary = perServingNutritionSummary(nutrition.perServing, language);
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en"
        ? `${title}\n\nThis recorded recipe already matches the requested ingredient filter; its ingredient list was not altered:\n${ingredients}\n\n${nutritionSummary.replace("after exclusion", "after applying the filter")}\n\n${safetyNote}`
        : `${title}\n\nالوصفة المسجلة مطابقة لفلتر الاستبعاد المطلوب، لذلك لم يتم تغيير مكوناتها:\n${ingredients}\n\n${nutritionSummary.replace("بعد الاستبعاد", "بعد تطبيق الفلتر")}\n\n${safetyNote}`,
      data: {
        intent: "find_recipe", recommendationType: "ingredient_exclusion", modificationType: "ingredient_exclusion_filter",
        recipeWasModified: false, recipeId: recipe.recipe_id, displayName: title,
        excludedIngredientKeys: [...exclusions], ingredients: recipe.ingredients.map((item) => ({ ...item, displayName: ingredientLabel(item.ingredient, language) })),
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
    const ingredients = recipe.ingredients.map((item) => `• ${item.quantity} ${localizedUnit(item.unit, language)} ${ingredientLabel(item.ingredient, language)}`).join("\n");
    const title = language === "en" ? recipe.name_en : recipe.name_ar;
    const nutrition = calculation.perServing;
    const message = language === "en"
      ? `${title}\n\nIngredients for ${recipe.servings} servings:\n${ingredients}\n\nPreparation method (recorded in Arabic in the source):\n${recipe.method_summary}\n\nEstimated per serving: ${nutrition.kcal ?? "unknown"} kcal, ${nutrition.protein ?? "unknown"} g protein, ${nutrition.fat ?? "unknown"} g fat, and ${nutrition.carbs ?? "unknown"} g carbohydrates.`
      : `${title}\n\nالمكونات (${recipe.servings} حصص):\n${ingredients}\n\nطريقة التحضير:\n${recipe.method_summary}\n\nتقدير الحصة: ${nutrition.kcal ?? "غير معروف"} سعر حراري، ${nutrition.protein ?? "غير معروف"} جم بروتين، ${nutrition.fat ?? "غير معروف"} جم دهون، و${nutrition.carbs ?? "غير معروف"} جم كربوهيدرات.`;
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [], message,
      data: { intent: "find_recipe", demoOnly: true, reviewStatus: "needs_review", recipe: { recipeId: recipe.recipe_id, nameAr: recipe.name_ar, nameEn: recipe.name_en, servings: recipe.servings, ingredients: recipe.ingredients, method: recipe.method_summary, nutritionPerServing: nutrition }, passages, conversationContext: { schemaVersion: "1.0", lastIntent: "recipe_reference", recipeId: recipe.recipe_id } },
      evidenceDocumentIds: passages.map((passage) => passage.documentId), provenance,
      toolTrace: [{ tool: "search_recipes", ok: true, code: null }, { tool: "calculate_nutrition", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

}

/**
 * Rule-based 8-intent classifier. Exported for the Step 17b regression report,
 * which must call exactly the classifier the live path uses.
 */
export function classifyRuleBasedGraduationIntent(dataset: UnifiedEgyptianDemoDataset, message: string): GraduationIntent {
  const query = message.trim();
  return classifyGraduationIntent(query, explicitlyNamedRecipes(dataset, query));
}

export type { GraduationIntent };

/**
 * Per-serving snapshot for the Step 16 flow.
 *
 * Returns `null` when any of the four contract macros is unknown. A recipe whose
 * snapshot cannot be fully calculated is never shown as a candidate and never
 * logged, because both the displayed nutrition and the dashboard payload must be
 * complete and identical. Missing values are never zero-filled or guessed.
 */
function demoMealNutrition(dataset: UnifiedEgyptianDemoDataset, recipe: UnifiedDemoRecipe): FrozenMealNutrition | null {
  const perServing = calculateUnifiedDemoNutrition(dataset, recipe).perServing;
  if (perServing.kcal === null || perServing.protein === null || perServing.carbs === null || perServing.fat === null) return null;
  return {
    caloriesKcal: perServing.kcal,
    proteinG: perServing.protein,
    carbsG: perServing.carbs,
    fatG: perServing.fat,
    sodiumMg: perServing.sodium,
  };
}

/**
 * Verification status per recipe, taken from the retrieval corpus rather than
 * restated.
 *
 * `buildGraduationRetrievalCorpus` is the single place that decides which demo
 * recipes count as verified for retrieval. Reading it here means the meal-category
 * search and vector search can never disagree about that.
 */
function demoVerificationStatuses(dataset: UnifiedEgyptianDemoDataset): ReadonlyMap<string, string> {
  const statuses = new Map<string, string>();
  for (const document of buildGraduationRetrievalCorpus(dataset).documents) {
    const recipeId = typeof document.metadata.recipeId === "string" ? document.metadata.recipeId : null;
    if (document.kind === "recipe" && recipeId) statuses.set(recipeId, document.egyptianVerificationStatus ?? "needs_review");
  }
  return statuses;
}

/** Demo-dataset implementation of the meal-category recipe port. */
class DemoMealCategoryRecipeSource implements MealCategoryRecipeSource {
  private readonly byCategory = new Map<DashboardMealCategory, MealCategoryRecipeRecord[]>();

  public constructor(dataset: UnifiedEgyptianDemoDataset, verificationStatuses: ReadonlyMap<string, string>) {
    for (const mealCategory of Object.keys(MEAL_CATEGORY_DATASET_CATEGORIES) as DashboardMealCategory[]) {
      const datasetCategories = new Set(MEAL_CATEGORY_DATASET_CATEGORIES[mealCategory]);
      const records = dataset.recipes
        .filter((recipe) => datasetCategories.has(recipe.category))
        .flatMap((recipe) => {
          const nutrition = demoMealNutrition(dataset, recipe);
          if (!nutrition) return [];
          return [{
            recipeId: recipe.recipe_id,
            name: recipe.name_ar,
            datasetCategory: recipe.category,
            verificationStatus: verificationStatuses.get(recipe.recipe_id) ?? "needs_review",
            ingredientKeys: recipe.ingredients.map((item) => item.ingredient),
            nutrition,
            provenance: {
              sourceId: "DEMO-UNIFIED-EGYPTIAN-DATASET",
              versionId: "graduation-demo",
              title: recipe.name_ar,
              url: recipe.source_url,
              accessedAt: dataset.metadata.created_date,
              locator: recipe.recipe_id,
            },
          } satisfies MealCategoryRecipeRecord];
        });
      this.byCategory.set(mealCategory, records);
    }
  }

  public listByMealCategory(category: DashboardMealCategory): readonly MealCategoryRecipeRecord[] {
    return this.byCategory.get(category) ?? [];
  }
}

export interface GraduationDashboardOptions {
  /**
   * Dashboard implementation. Defaults to the deterministic local mock.
   *
   * This is the seam a real HTTP client would occupy once the cross-team auth
   * linkage from section 1 of the integration contract is resolved. Until then no
   * real implementation exists.
   */
  dashboard?: DashboardClient;
  /** Server-side pending-operation table. Defaults to a fresh in-memory store. */
  pendingOperations?: PendingMealOperationStore;
  /** Injected clock for the submission timestamp. */
  now?: () => Date;
}

/** Compose the Step 16 flow over the demo dataset. */
function buildMealPlanSelectionFlow(
  input: { dataset: UnifiedEgyptianDemoDataset } & GraduationDashboardOptions,
): MealPlanSelectionFlow {
  const { dataset } = input;
  const recipes = new Map(dataset.recipes.map((recipe) => [recipe.recipe_id, recipe]));
  const pendingOperations = input.pendingOperations ?? new InMemoryPendingMealOperationStore();
  const tools = new MealSelectionTools({
    recipes: new DemoMealCategoryRecipeSource(dataset, demoVerificationStatuses(dataset)),
    dashboard: input.dashboard ?? new MockDashboardClient(),
    pendingOperations,
    now: input.now,
  });
  return new MealPlanSelectionFlow({
    tools,
    pendingOperations,
    helpers: {
      // Reused, not reimplemented: the disclaimer, the exclusion parser and the
      // text normalizers are the existing implementations from earlier fixes.
      exclusionSafetyNote,
      excludedIngredientKeys,
      ingredientLabel,
      normalizeNumberDigits,
      normalizedLookupText,
      dairyIngredientKeys: DAIRY_INGREDIENT_KEYS,
    },
    recipeSnapshot: (recipeId, language) => {
      const recipe = recipes.get(recipeId);
      if (!recipe) return null;
      const nutrition = demoMealNutrition(dataset, recipe);
      if (!nutrition) return null;
      return { name: language === "en" ? recipe.name_en : recipe.name_ar, nutrition };
    },
  });
}

export async function buildGraduationDemoAgent(
  nodeEnv: "development" | "test",
  backendDataSource?: GraduationBackendDataSource | null,
  claudeLayer?: ClaudeLayer | ClaudeLayerDependencies | null,
  dashboardOptions?: GraduationDashboardOptions,
): Promise<GraduationDemoAgent> {
  if (nodeEnv !== "development" && nodeEnv !== "test") throw new Error("graduation demo agent is forbidden outside development/test");
  const dataset = await loadUnifiedEgyptianDemoDataset();
  assertCompleteArabicIngredientDictionary(dataset);
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
      embeddingProvider: new InstrumentedEmbeddingProvider(new OpenAICompatibleEmbeddingProvider({
        baseUrl: process.env.EMBEDDING_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: embeddingApiKey,
        modelId: process.env.EMBEDDING_MODEL?.trim() || "gemini-embedding-2",
        dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? "3072"),
        timeoutMs,
      })),
      vectorStore: new InstrumentedVectorStore(new QdrantVectorStore({
        baseUrl: qdrantUrl,
        collection: qdrantCollection,
        apiKey: process.env.QDRANT_API_KEY?.trim() || undefined,
        timeoutMs,
      })),
      corpusId: process.env.RETRIEVAL_CORPUS_ID?.trim() || GRADUATION_DEMO_CORPUS_ID,
      calculateNutrition,
      guidelineRules: new InMemoryGuidelineRuleRepository([]),
    });
    tools = new HybridRetrievalTools(remoteTools, localTools, {
      timeoutMs,
      circuitBreakerMs,
      observer: (event: HybridRetrievalEvent) => recordHybridRetrievalEvent(event),
    });
  }
  const backend = backendDataSource === undefined
    ? nodeEnv === "development" ? new NutriGuardBackendClient(process.env.NUTRIGUARD_BACKEND_BASE_URL?.trim() || undefined) : null
    : backendDataSource;
  // A test or caller that passes nothing gets a fully inert layer, so the
  // deterministic behaviour of every existing suite is unchanged. Passing
  // `undefined` explicitly is the same as passing nothing; only `development`
  // builds read Claude credentials from the environment.
  const layer = claudeLayer instanceof ClaudeLayer
    ? claudeLayer
    : claudeLayer
      ? new ClaudeLayer(claudeLayer)
      : nodeEnv === "development"
        ? new ClaudeLayer()
        : new ClaudeLayer({ classifierClient: null, formatterClient: null });
  return new GraduationDemoAgent(
    new NutriGuardExpandedAgent(tools, new InMemoryAlternativeRuleRepository([])),
    tools,
    dataset,
    backend,
    layer,
    // Step 16: the dashboard is a deterministic local mock unless a caller injects
    // an implementation. No real dashboard client exists in this repository.
    buildMealPlanSelectionFlow({ dataset, ...dashboardOptions }),
  );
}
