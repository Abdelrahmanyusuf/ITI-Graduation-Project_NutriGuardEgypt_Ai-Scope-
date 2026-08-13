import { randomUUID } from "node:crypto";
import type { ExpandedAgentResponse } from "./expanded-agent.js";
import { exclusionSafetyNote } from "./exclusion-safety.js";
import { NUTRIGUARD_SYSTEM_PROMPT_VERSION } from "./system-prompt.js";
import {
  calculateUnifiedDemoNutrition,
  type UnifiedDemoRecipe,
  type UnifiedEgyptianDemoDataset,
} from "../demo/unified-egyptian-dataset.js";
import type {
  DashboardClient,
  DashboardErrorCode,
  DashboardResponse,
  LogMealSelectionsRequest,
  MealCategory,
  NutritionSnapshot,
} from "../services/dashboard/dashboard-client.js";

export const PENDING_OPERATION_TTL_SECONDS = 600;
export const MAX_MEAL_SELECTION_SESSIONS = 1_000;

export interface VerifiedMealRecipe {
  recipeId: string;
  nameAr: string;
  nameEn: string;
  aliases: string[];
  mealCategories: MealCategory[];
  ingredientKeys: string[];
  verificationStatus: "verified" | "needs_review" | "rejected";
  nutrition: NutritionSnapshot;
  evidenceDocumentId?: string;
}

export interface VerifiedMealRecipeRepository {
  list(): Promise<VerifiedMealRecipe[]>;
}

export class InMemoryVerifiedMealRecipeRepository implements VerifiedMealRecipeRepository {
  public constructor(private readonly recipes: readonly VerifiedMealRecipe[]) {}
  public async list(): Promise<VerifiedMealRecipe[]> {
    return structuredClone([...this.recipes]);
  }
}

export class DatasetVerifiedMealRecipeRepository implements VerifiedMealRecipeRepository {
  public constructor(private readonly dataset: UnifiedEgyptianDemoDataset) {}

  public async list(): Promise<VerifiedMealRecipe[]> {
    return this.dataset.recipes.map((recipe) => this.toMealRecipe(recipe));
  }

  private toMealRecipe(recipe: UnifiedDemoRecipe): VerifiedMealRecipe {
    const calculated = calculateUnifiedDemoNutrition(this.dataset, recipe).perServing;
    const complete = calculated.kcal !== null && calculated.protein !== null && calculated.fat !== null && calculated.carbs !== null;
    return {
      recipeId: recipe.recipe_id,
      nameAr: recipe.name_ar,
      nameEn: recipe.name_en,
      aliases: [...recipe.alt_names],
      // Meal use is a stored human review decision. Raw category/main_dish
      // values are deliberately never converted at search time.
      mealCategories: [...recipe.meal_categories],
      ingredientKeys: recipe.ingredients.map((ingredient) => ingredient.ingredient),
      verificationStatus: recipe.status === "verified" ? "verified" : recipe.status === "rejected" ? "rejected" : "needs_review",
      nutrition: complete
        ? {
            calories: calculated.kcal!,
            protein_g: calculated.protein!,
            fat_g: calculated.fat!,
            carbs_g: calculated.carbs!,
            ...(calculated.sodium === null ? {} : { sodium_mg: calculated.sodium }),
          }
        : { calories: Number.NaN, protein_g: Number.NaN, fat_g: Number.NaN, carbs_g: Number.NaN },
      evidenceDocumentId: `DEMO-${recipe.recipe_id}`,
    };
  }
}

export interface MealRecipeSearchResult {
  category: MealCategory;
  status: "ok" | "only_n_found" | "empty";
  candidates: VerifiedMealRecipe[];
}

function completeNutrition(value: NutritionSnapshot): boolean {
  return [value.calories, value.protein_g, value.fat_g, value.carbs_g].every((number) => Number.isFinite(number) && number >= 0)
    && (value.sodium_mg === undefined || Number.isFinite(value.sodium_mg) && value.sodium_mg >= 0);
}

export async function search_recipes_by_meal_category(
  repository: VerifiedMealRecipeRepository,
  category: MealCategory,
  calorieCeiling?: number,
  exclusions: readonly string[] = [],
): Promise<MealRecipeSearchResult> {
  const excluded = new Set(exclusions);
  const candidates = (await repository.list())
    .filter((recipe) => recipe.verificationStatus === "verified")
    .filter((recipe) => recipe.mealCategories.includes(category))
    .filter((recipe) => completeNutrition(recipe.nutrition))
    .filter((recipe) => calorieCeiling === undefined || recipe.nutrition.calories <= calorieCeiling)
    .filter((recipe) => !recipe.ingredientKeys.some((key) => excluded.has(key)))
    .sort((left, right) => left.recipeId.localeCompare(right.recipeId))
    .slice(0, 3);
  return {
    category,
    status: candidates.length === 0 ? "empty" : candidates.length < 3 ? "only_n_found" : "ok",
    candidates,
  };
}

export type CeilingMode = "none" | "total_across_plan_equal_split" | "per_meal";

export interface MealOptionsConversationContext {
  schemaVersion: "1.0";
  lastIntent: "meal_options";
  mealSelectionSessionId: string;
}

export interface MealSelectionPendingConversationContext {
  schemaVersion: "1.0";
  lastIntent: "meal_selection_pending";
  mealSelectionSessionId: string;
  pendingOperationId: string;
}

export interface MealSelectionAppliedConversationContext {
  schemaVersion: "1.0";
  lastIntent: "meal_selection_applied";
  mealSelectionSessionId: string;
  pendingOperationId: string;
}

export type MealSelectionConversationContext =
  | MealOptionsConversationContext
  | MealSelectionPendingConversationContext
  | MealSelectionAppliedConversationContext;

interface ParsedPlanRequest {
  categories: MealCategory[];
  ceilingMode: CeilingMode;
  totalCeiling: number | null;
  categoryCeilings: Partial<Record<MealCategory, number>>;
  exclusions: string[];
  exclusionLabelsAr: string[];
  exclusionLabelsEn: string[];
}

interface CandidateSession {
  id: string;
  createdAtMs: number;
  categories: MealCategory[];
  candidates: Record<MealCategory, VerifiedMealRecipe[]>;
  selected: Partial<Record<MealCategory, VerifiedMealRecipe>>;
  ceilingMode: CeilingMode;
  totalCeiling: number | null;
  categoryCeilings: Partial<Record<MealCategory, number>>;
  exclusions: string[];
  exclusionLabelsAr: string[];
  exclusionLabelsEn: string[];
  latestPendingOperationId: string | null;
}

export interface DisplayedMealCandidateSnapshot {
  recipeId: string;
  nameAr: string;
  nameEn: string;
  aliases?: readonly string[];
  mealCategory: MealCategory;
  nutritionSnapshot: NutritionSnapshot;
}

export interface DisplayedMealSessionInput {
  candidates: readonly DisplayedMealCandidateSnapshot[];
  categories: readonly MealCategory[];
  ceilingMode: CeilingMode;
  totalCeiling?: number | null;
  categoryCeilings?: Partial<Record<MealCategory, number>>;
}

type PendingState = "ACTIVE" | "APPLIED" | "INVALID";

interface FrozenSelection {
  recipeId: string;
  mealCategory: MealCategory;
  nameAr: string;
  nameEn: string;
  nutritionSnapshot: NutritionSnapshot;
}

interface PendingOperation {
  id: string;
  selectionSessionId: string;
  state: PendingState;
  createdAtMs: number;
  expiresAtMs: number;
  selections: FrozenSelection[];
  total: NutritionSnapshot;
  ceilingMode: CeilingMode;
  submissionTimestamp: string | null;
}

export interface MealSelectionFlowOptions {
  now?: () => number;
  idFactory?: () => string;
  ttlSeconds?: number;
  maxSessions?: number;
}

const CATEGORY_ORDER: MealCategory[] = ["breakfast", "lunch", "dinner"];
const CATEGORY_LABELS = {
  ar: { breakfast: "الفطار", lunch: "الغداء", dinner: "العشاء" },
  en: { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" },
} as const;
// Arabic category tokens may carry a conjunction, a one-letter preposition,
// and the definite article. The lam + article contraction is written "لل".
// Keep this morphology in one place so forms such as والفطار، للفطار، بالغداء،
// and كالعشاء are handled consistently instead of accumulating literal aliases.
const ARABIC_CATEGORY_PREFIX = "(?:و)?(?:(?:ل(?:ل)?|ب|ك)?(?:ال)?)?";
const CATEGORY_PATTERNS: Record<MealCategory, string> = {
  breakfast: `(?<![\\p{L}\\p{N}])(?:${ARABIC_CATEGORY_PREFIX}(?:فطار|افطار)|breakfast)(?![\\p{L}\\p{N}])`,
  lunch: `(?<![\\p{L}\\p{N}])(?:${ARABIC_CATEGORY_PREFIX}(?:غدا|غداء)|lunch)(?![\\p{L}\\p{N}])`,
  dinner: `(?<![\\p{L}\\p{N}])(?:${ARABIC_CATEGORY_PREFIX}(?:عشا|عشاء)|dinner)(?![\\p{L}\\p{N}])`,
};
const ORDINALS: ReadonlyArray<{ index: number; pattern: string }> = [
  { index: 0, pattern: "(?:الأول|الاول|أول|اول|first|1)" },
  { index: 1, pattern: "(?:الثاني|الثانى|التاني|التانى|ثاني|تانى|second|2)" },
  { index: 2, pattern: "(?:الثالث|التالت|ثالث|تالت|third|3)" },
];

/**
 * Complete Step 16 confirmation whitelist (literal phrases before normalization):
 * - Arabic (`ar`, `ar-EG`): "تأكيد", "اكد", "أكد", "ايوه اكد",
 *   "أيوه أكد", "تمام قفل كده", "ابعتها كده", "ابعته كده".
 * - English (`en`): "confirm", "yes confirm", "send it", "log it".
 *
 * Matching is exact after normalizeText: English case, Arabic hamza variants,
 * diacritics, tatweel, punctuation, and repeated whitespace are normalized.
 * This is a literal whitelist, not an intent classifier, so "yes" alone and
 * any other unlisted phrase are rejected. A whitelisted phrase is also rejected
 * if looksLikeModification detects a selection change, new meal request, or
 * hedging marker (for example, "confirm but change lunch"). All Arabic example
 * confirmations from Step 16 prompt step 5 are implemented above; none are
 * documentation-only examples.
 */
const CONFIRMATION_PHRASES = new Set([
  "تأكيد", "اكد", "أكد", "ايوه اكد", "أيوه أكد", "تمام قفل كده", "ابعتها كده", "ابعته كده",
  "confirm", "yes confirm", "send it", "log it",
].map((phrase) => normalizeText(phrase)));

function normalizeText(value: string): string {
  const arabic = "٠١٢٣٤٥٦٧٨٩";
  const eastern = "۰۱۲۳۴۵۶۷۸۹";
  return value.normalize("NFKC")
    .replace(/[٠-٩۰-۹]/gu, (digit) => {
      const first = arabic.indexOf(digit);
      return String(first >= 0 ? first : eastern.indexOf(digit));
    })
    .replace(/[ًٌٍَُِّْـ]/gu, "")
    .replace(/[إأآ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ة/gu, "ه")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function normalizeNameMatch(value: string): string {
  return normalizeText(value).split(" ").map((token) => token.startsWith("ال") && token.length > 3 ? token.slice(2) : token).join(" ");
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function categoryLabel(category: MealCategory, language: "ar-EG" | "ar" | "en"): string {
  return language === "en" ? CATEGORY_LABELS.en[category] : CATEGORY_LABELS.ar[category];
}

function parseCategories(text: string): MealCategory[] {
  return CATEGORY_ORDER.filter((category) => new RegExp(CATEGORY_PATTERNS[category], "iu").test(text));
}

export function apportionCalorieCeiling(
  totalCalories: number,
  categories: readonly MealCategory[],
): Partial<Record<MealCategory, number>> {
  if (!Number.isInteger(totalCalories) || totalCalories <= 0) throw new Error("totalCalories must be a positive integer");
  const orderedCategories = CATEGORY_ORDER.filter((category) => categories.includes(category));
  if (orderedCategories.length === 0) throw new Error("at least one meal category is required");
  const floorShare = Math.floor(totalCalories / orderedCategories.length);
  const result: Partial<Record<MealCategory, number>> = {};
  for (const category of orderedCategories) result[category] = floorShare;
  const last = orderedCategories.at(-1)!;
  result[last] = floorShare + (totalCalories - floorShare * orderedCategories.length);
  return result;
}

export function applyPerMealCalorieCeiling(
  caloriesPerMeal: number,
  categories: readonly MealCategory[],
): Partial<Record<MealCategory, number>> {
  if (!Number.isInteger(caloriesPerMeal) || caloriesPerMeal <= 0) throw new Error("caloriesPerMeal must be a positive integer");
  const result: Partial<Record<MealCategory, number>> = {};
  for (const category of CATEGORY_ORDER) {
    if (categories.includes(category)) result[category] = caloriesPerMeal;
  }
  if (Object.keys(result).length === 0) throw new Error("at least one meal category is required");
  return result;
}

function parseExclusions(text: string): { keys: string[]; labelsAr: string[]; labelsEn: string[] } {
  const keys = new Set<string>();
  const labelsAr: string[] = [];
  const labelsEn: string[] = [];
  const hasExclusion = /(?:بدون|من غير|من دون|حساسيه|حساسية|استبعد|بلاش|without|allergy|allergic|free[ -]?from|no\s+)/iu.test(text);
  if (!hasExclusion) return { keys: [], labelsAr, labelsEn };
  if (/(?:البان|ألبان|لبن|حليب|dairy|milk)/iu.test(text)) {
    for (const key of ["butter_raw", "cheese_feta", "cream_heavy", "ghee", "ice_cream_vanilla", "milk_whole", "yogurt_plain"]) keys.add(key);
    labelsAr.push("منتجات الألبان المسجلة");
    labelsEn.push("the recorded dairy ingredients");
  }
  if (/(?:مكسرات|nuts?)/iu.test(text)) {
    for (const key of ["almonds_raw", "hazelnuts_raw", "peanuts_raw", "walnuts_raw"]) keys.add(key);
    labelsAr.push("المكسرات المسجلة");
    labelsEn.push("the recorded nuts");
  }
  if (/(?:زيت|oil)/iu.test(text)) {
    for (const key of ["vegetable_oil", "olive_oil", "flaxseed_oil", "ghee", "butter_raw"]) keys.add(key);
    labelsAr.push("الزيوت والدهون المضافة المسجلة");
    labelsEn.push("the recorded added oils and fats");
  }
  return { keys: [...keys], labelsAr, labelsEn };
}

function parsePlanRequest(message: string): ParsedPlanRequest | null {
  const text = normalizeText(message);
  const categories = parseCategories(text);
  const planCue = /(?:عايز|عاوز|حضر|جهز|اعمل|رتب|اختيارات|وجبه|وجبة|وجبات|meal|option|plan)/iu.test(text);
  const explicitlyRequestsOptions = /(?:اختيارات|خيارات|options?|multi option)/iu.test(text);
  // This compatibility route is read-only. It must never gain a dashboard write;
  // every future logging path must enter through confirm_and_log_meal_selection.
  const legacySingleMealShape = categories.length === 1 && /(?:وجبه|وجبات|\bmeal\b)/iu.test(text) && !explicitlyRequestsOptions;
  if (categories.length === 0 || !planCue || legacySingleMealShape) return null;
  const calorieMatches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:سعر(?:ه|ات)?(?:\s*حراري(?:ه)?)?|كالوري|kcal|calories?)/giu)];
  const calorie = calorieMatches[0] ? Number(calorieMatches[0][1]) : null;
  if (calorie !== null && (!Number.isInteger(calorie) || calorie <= 0 || calorie > 5_000)) return null;
  const perMeal = /(?:كل\s+وجبه|لكل\s+وجبه|كل\s+وجبة|لكل\s+وجبة|per\s+meal|each\s+meal)/iu.test(text);
  const ceilingMode: CeilingMode = calorie === null ? "none" : categories.length > 1 && !perMeal ? "total_across_plan_equal_split" : "per_meal";
  const categoryCeilings: Partial<Record<MealCategory, number>> = {};
  if (calorie !== null && ceilingMode === "per_meal") {
    Object.assign(categoryCeilings, applyPerMealCalorieCeiling(calorie, categories));
  }
  if (calorie !== null && ceilingMode === "total_across_plan_equal_split") {
    Object.assign(categoryCeilings, apportionCalorieCeiling(calorie, categories));
  }
  const exclusions = parseExclusions(text);
  return {
    categories,
    ceilingMode,
    totalCeiling: calorie,
    categoryCeilings,
    exclusions: exclusions.keys,
    exclusionLabelsAr: exclusions.labelsAr,
    exclusionLabelsEn: exclusions.labelsEn,
  };
}

function nutritionLine(snapshot: NutritionSnapshot, language: "ar-EG" | "ar" | "en"): string {
  const sodium = snapshot.sodium_mg === undefined ? "" : language === "en" ? `, sodium ${snapshot.sodium_mg} mg` : `، صوديوم ${snapshot.sodium_mg} مجم`;
  return language === "en"
    ? `${snapshot.calories} kcal, protein ${snapshot.protein_g} g, carbs ${snapshot.carbs_g} g, fat ${snapshot.fat_g} g${sodium}`
    : `${snapshot.calories} سعرة، بروتين ${snapshot.protein_g} جم، كربوهيدرات ${snapshot.carbs_g} جم، دهون ${snapshot.fat_g} جم${sodium}`;
}

function sumNutrition(selections: readonly FrozenSelection[]): NutritionSnapshot {
  const sodiumValues = selections.map((selection) => selection.nutritionSnapshot.sodium_mg);
  return {
    calories: round1(selections.reduce((sum, selection) => sum + selection.nutritionSnapshot.calories, 0)),
    protein_g: round1(selections.reduce((sum, selection) => sum + selection.nutritionSnapshot.protein_g, 0)),
    fat_g: round1(selections.reduce((sum, selection) => sum + selection.nutritionSnapshot.fat_g, 0)),
    carbs_g: round1(selections.reduce((sum, selection) => sum + selection.nutritionSnapshot.carbs_g, 0)),
    ...(sodiumValues.every((value) => value !== undefined)
      ? { sodium_mg: round1(sodiumValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)) }
      : {}),
  };
}

function errorMessage(code: DashboardErrorCode, language: "ar-EG" | "ar" | "en"): string {
  const english: Record<DashboardErrorCode, string> = {
    invalid_token: "the authentication token is invalid",
    recipe_not_found: "a selected recipe was not found",
    rate_limited: "the mock rate limit was reached",
    server_error: "the mock dashboard returned a server error",
    insufficient_calories: "the mock reported insufficient remaining calories",
    validation_failed: "the mock rejected the request validation",
    confirmation_expired: "the confirmation has expired",
  };
  const arabic: Record<DashboardErrorCode, string> = {
    invalid_token: "رمز التحقق غير صالح",
    recipe_not_found: "إحدى الوصفات المختارة غير موجودة",
    rate_limited: "تم الوصول لحد الطلبات في الـmock",
    server_error: "حصل خطأ في mock الداشبورد",
    insufficient_calories: "الـmock أبلغ إن السعرات المتبقية غير كافية",
    validation_failed: "الـmock رفض الطلب بسبب فشل التحقق",
    confirmation_expired: "انتهت صلاحية التأكيد",
  };
  return language === "en" ? english[code] : arabic[code];
}

function flowResponse(
  language: "ar-EG" | "ar" | "en",
  status: ExpandedAgentResponse["status"],
  message: string,
  data: Record<string, unknown> | null,
  evidenceDocumentIds: string[] = [],
  toolTrace: ExpandedAgentResponse["toolTrace"] = [],
): ExpandedAgentResponse {
  return {
    status,
    primaryIntent: "general_guidance",
    language,
    safetyFlags: [],
    integrityFlags: [],
    message,
    data,
    evidenceDocumentIds,
    provenance: [],
    toolTrace,
    promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
  };
}

export class MealSelectionFlow {
  private readonly sessions = new Map<string, CandidateSession>();
  private readonly pending = new Map<string, PendingOperation>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly ttlMs: number;
  private readonly maxSessions: number;

  public constructor(
    private readonly recipes: VerifiedMealRecipeRepository,
    private readonly dashboard: DashboardClient,
    options: MealSelectionFlowOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.ttlMs = (options.ttlSeconds ?? PENDING_OPERATION_TTL_SECONDS) * 1_000;
    this.maxSessions = options.maxSessions ?? MAX_MEAL_SELECTION_SESSIONS;
    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1) throw new Error("maxSessions must be a positive integer");
  }

  public async handle(input: {
    message: string;
    language: "ar-EG" | "ar" | "en";
    context?: MealSelectionConversationContext;
  }): Promise<ExpandedAgentResponse | null> {
    const explicitNewPlan = /(?:خطه|خطة|اختيارات|خيارات).{0,12}(?:جديد|جديدة)|(?:ابدأ|ابدا).{0,12}(?:جديد|جديدة)|new\s+(?:meal\s+)?(?:plan|options?)/iu.test(normalizeText(input.message));
    if (input.context && !explicitNewPlan) {
      if (input.context.lastIntent === "meal_options") return this.resolveSelection(input.context.mealSelectionSessionId, input.message, input.language);
      if (input.context.lastIntent === "meal_selection_pending" || input.context.lastIntent === "meal_selection_applied") {
        if (this.isValidConfirmation(input.message)) {
          return this.confirm_and_log_meal_selection(input.context.pendingOperationId, input.language);
        }
        if (this.looksLikeModification(input.message)) {
          const operation = this.pending.get(input.context.pendingOperationId);
          if (operation?.state === "ACTIVE") operation.state = "INVALID";
          return this.resolveSelection(input.context.mealSelectionSessionId, input.message, input.language);
        }
        return flowResponse(
          input.language,
          "clarification",
          input.language === "en"
            ? "I did not treat that as confirmation. Send a clear confirmation with no changes, or state the selection change you want."
            : "ما اعتبرتش الرسالة دي تأكيدًا. ابعت تأكيد واضح من غير تعديل، أو اكتب التغيير المطلوب في الاختيارات.",
          { intent: "meal_selection_confirmation", reasonCode: "confirmation_not_explicit", conversationContext: input.context },
        );
      }
    }
    const request = parsePlanRequest(input.message);
    if (!request) return null;
    this.invalidateContextOperation(input.context);
    return this.showOptions(request, input.language);
  }

  public async confirm_and_log_meal_selection(
    pendingOperationId: string,
    language: "ar-EG" | "ar" | "en",
  ): Promise<ExpandedAgentResponse> {
    const operation = this.pending.get(pendingOperationId);
    if (!operation || operation.state === "INVALID" || operation.state === "ACTIVE" && this.now() >= operation.expiresAtMs) {
      if (operation) operation.state = "INVALID";
      return flowResponse(
        language,
        "clarification",
        language === "en" ? "This confirmation expired. Request the meal options again." : "انتهت صلاحية التأكيد. اطلب اختيارات الوجبات من جديد.",
        { intent: "meal_selection_log", errorCode: "confirmation_expired", mockCalled: false },
        [],
        [{ tool: "confirm_and_log_meal_selection", ok: false, code: "confirmation_expired" }],
      );
    }

    operation.submissionTimestamp ??= new Date(this.now()).toISOString();
    const payload: LogMealSelectionsRequest = {
      idempotency_key: operation.id,
      selections: operation.selections.map((selection) => ({
        recipe_id: selection.recipeId,
        meal_category: selection.mealCategory,
        nutrition_snapshot: structuredClone(selection.nutritionSnapshot),
        timestamp: operation.submissionTimestamp!,
      })),
    };
    const result = await this.dashboard.logMealSelections(payload);
    if (result.status === "success" && result.applied) operation.state = "APPLIED";
    if (result.status === "error" && result.error_code === "confirmation_expired") operation.state = "INVALID";
    return this.logResponse(operation, result, language);
  }

  /**
   * Internal test-only seam. It assigns verificationStatus = "verified" by
   * trusting the caller; it does not independently prove that candidates came
   * from search_recipes_by_meal_category. Never call it with data that is not
   * guaranteed to have passed through that verified-only search, and never
   * re-export it from the package's public surface.
   */
  protected beginDisplayedCandidateSession(input: DisplayedMealSessionInput): MealOptionsConversationContext {
    this.pruneState();
    const categories = CATEGORY_ORDER.filter((category) => input.categories.includes(category));
    if (categories.length === 0) throw new Error("at least one meal category is required");
    const candidates = { breakfast: [], lunch: [], dinner: [] } as Record<MealCategory, VerifiedMealRecipe[]>;
    for (const candidate of input.candidates) {
      if (!categories.includes(candidate.mealCategory)) throw new Error("candidate category must be part of the displayed session");
      if (!completeNutrition(candidate.nutritionSnapshot)) throw new Error("candidate nutrition snapshot must be complete");
      candidates[candidate.mealCategory].push({
        recipeId: candidate.recipeId,
        nameAr: candidate.nameAr,
        nameEn: candidate.nameEn,
        aliases: [...candidate.aliases ?? []],
        mealCategories: [candidate.mealCategory],
        ingredientKeys: [],
        verificationStatus: "verified",
        nutrition: structuredClone(candidate.nutritionSnapshot),
      });
    }
    const id = this.idFactory();
    this.sessions.set(id, {
      id,
      createdAtMs: this.now(),
      categories,
      candidates,
      selected: {},
      ceilingMode: input.ceilingMode,
      totalCeiling: input.totalCeiling ?? null,
      categoryCeilings: { ...input.categoryCeilings },
      exclusions: [],
      exclusionLabelsAr: [],
      exclusionLabelsEn: [],
      latestPendingOperationId: null,
    });
    return { schemaVersion: "1.0", lastIntent: "meal_options", mealSelectionSessionId: id };
  }

  private invalidateContextOperation(context: MealSelectionConversationContext | undefined): void {
    if (!context || context.lastIntent === "meal_options") return;
    const operation = this.pending.get(context.pendingOperationId);
    if (operation?.state === "ACTIVE") operation.state = "INVALID";
  }

  private async showOptions(request: ParsedPlanRequest, language: "ar-EG" | "ar" | "en"): Promise<ExpandedAgentResponse> {
    this.pruneState();
    const results = await Promise.all(request.categories.map((category) => search_recipes_by_meal_category(
      this.recipes,
      category,
      request.categoryCeilings[category],
      request.exclusions,
    )));
    const id = this.idFactory();
    const candidates = { breakfast: [], lunch: [], dinner: [] } as Record<MealCategory, VerifiedMealRecipe[]>;
    for (const result of results) candidates[result.category] = result.candidates;
    const session: CandidateSession = {
      id,
      createdAtMs: this.now(),
      categories: [...request.categories],
      candidates,
      selected: {},
      ceilingMode: request.ceilingMode,
      totalCeiling: request.totalCeiling,
      categoryCeilings: { ...request.categoryCeilings },
      exclusions: [...request.exclusions],
      exclusionLabelsAr: [...request.exclusionLabelsAr],
      exclusionLabelsEn: [...request.exclusionLabelsEn],
      latestPendingOperationId: null,
    };
    this.sessions.set(id, session);
    const sections = results.map((result) => {
      const label = categoryLabel(result.category, language);
      if (result.candidates.length === 0) return language === "en" ? `${label}: no verified matching recipes.` : `${label}: مفيش وصفات موثقة مطابقة.`;
      const lines = result.candidates.map((candidate, index) => `${index + 1}. ${language === "en" ? candidate.nameEn : candidate.nameAr} — ${nutritionLine(candidate.nutrition, language)}`);
      const count = result.candidates.length;
      const note = count < 3 ? language === "en" ? `Only ${count} verified option${count === 1 ? "" : "s"} found.` : `اتوجد ${count} ${count === 1 ? "اختيار موثق فقط" : "اختيارات موثقة فقط"}.` : "";
      return `${label}:\n${lines.join("\n")}${note ? `\n${note}` : ""}`;
    });
    const mode = request.ceilingMode === "total_across_plan_equal_split"
      ? language === "en" ? "One ceiling for the whole plan, split equally." : "سقف لكل الخطة، مقسوم بالتساوي."
      : request.ceilingMode === "per_meal"
        ? language === "en" ? "A separate ceiling for each meal." : "سقف لكل وجبة على حدة."
        : language === "en" ? "No calorie ceiling was supplied." : "لم يتم تحديد سقف سعرات.";
    const labels = language === "en" ? session.exclusionLabelsEn : session.exclusionLabelsAr;
    const safety = labels.length === 0 ? "" : `\n\n${exclusionSafetyNote(labels, language)}`;
    const available = results.reduce((sum, result) => sum + result.candidates.length, 0);
    const context: MealOptionsConversationContext = { schemaVersion: "1.0", lastIntent: "meal_options", mealSelectionSessionId: id };
    return flowResponse(
      language,
      available === 0 ? "no_result" : "ok",
      `${mode}\n\n${sections.join("\n\n")}${safety}${available > 0 ? language === "en" ? "\n\nChoose one option for each category." : "\n\nاختار اختيار واحد لكل فئة." : ""}`,
      {
        intent: "meal_option_selection",
        reviewStatus: "verified_only",
        ceilingMode: request.ceilingMode,
        totalCeilingKcal: request.totalCeiling,
        categoryCeilingsKcal: request.categoryCeilings,
        exclusions: request.exclusions,
        categories: results.map((result) => ({ category: result.category, status: result.status, count: result.candidates.length, candidates: result.candidates.map((candidate) => ({ recipeId: candidate.recipeId, name: language === "en" ? candidate.nameEn : candidate.nameAr, nutritionSnapshot: candidate.nutrition, verificationStatus: candidate.verificationStatus })) })),
        conversationContext: context,
      },
      results.flatMap((result) => result.candidates.flatMap((candidate) => candidate.evidenceDocumentId ? [candidate.evidenceDocumentId] : [])),
      [{ tool: "search_recipes_by_meal_category", ok: true, code: available === 0 ? "zero_verified_candidates" : null }],
    );
  }

  private pruneState(): void {
    const now = this.now();
    for (const operation of this.pending.values()) {
      if (operation.state === "ACTIVE" && now >= operation.expiresAtMs) operation.state = "INVALID";
    }
    while (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.values()].sort((left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id))[0];
      if (!oldest) break;
      this.sessions.delete(oldest.id);
      for (const [id, operation] of this.pending) {
        if (operation.selectionSessionId === oldest.id) this.pending.delete(id);
      }
    }
    this.pruneOperations();
  }

  private pruneOperations(preserveId?: string): void {
    const maximumOperations = this.maxSessions * 2;
    while (this.pending.size > maximumOperations) {
      const candidates = [...this.pending.values()].filter((operation) => operation.id !== preserveId);
      const oldest = candidates.sort((left, right) => {
        const stateOrder = (state: PendingState) => state === "INVALID" ? 0 : state === "APPLIED" ? 1 : 2;
        return stateOrder(left.state) - stateOrder(right.state) || left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id);
      })[0];
      if (!oldest) break;
      this.pending.delete(oldest.id);
    }
  }

  private async resolveSelection(sessionId: string, message: string, language: "ar-EG" | "ar" | "en"): Promise<ExpandedAgentResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) return this.invalidConfirmation(language);
    const resolution = this.resolveReferences(session, message);
    if (resolution.kind !== "ok") {
      const context: MealOptionsConversationContext = { schemaVersion: "1.0", lastIntent: "meal_options", mealSelectionSessionId: session.id };
      return flowResponse(
        language,
        "clarification",
        resolution.kind === "ambiguous"
          ? language === "en" ? "That selection is ambiguous across the displayed options. Name the category and option number." : "الاختيار ده ملتبس بين الخيارات المعروضة. اكتب فئة الوجبة ورقم الاختيار."
          : language === "en" ? "I could not match that to the currently displayed options. Choose by category and number." : "مقدرتش أوصل الرسالة بالخيارات المعروضة حاليًا. اختار باسم الفئة ورقم الاختيار.",
        { intent: "meal_option_selection", reasonCode: resolution.kind, conversationContext: context },
      );
    }
    for (const [category, recipe] of resolution.selections) session.selected[category] = recipe;
    const required = session.categories.filter((category) => session.candidates[category].length > 0);
    const remaining = required.filter((category) => !session.selected[category]);
    if (remaining.length > 0) {
      const context: MealOptionsConversationContext = { schemaVersion: "1.0", lastIntent: "meal_options", mealSelectionSessionId: session.id };
      return flowResponse(
        language,
        "clarification",
        language === "en" ? `Choose an option for: ${remaining.map((category) => categoryLabel(category, language)).join(", ")}.` : `اختار كمان لـ: ${remaining.map((category) => categoryLabel(category, language)).join("، ")}.`,
        { intent: "meal_option_selection", selectedCategories: Object.keys(session.selected), remainingCategories: remaining, conversationContext: context },
      );
    }
    return this.showConfirmation(session, language);
  }

  private resolveReferences(session: CandidateSession, message: string): { kind: "ok"; selections: Map<MealCategory, VerifiedMealRecipe> } | { kind: "ambiguous" | "no_match" } {
    const text = normalizeText(message);
    const nameMatchText = normalizeNameMatch(message);
    const selections = new Map<MealCategory, VerifiedMealRecipe>();
    for (const category of session.categories) {
      const candidates = session.candidates[category];
      if (candidates.length === 0) continue;
      for (const ordinal of ORDINALS) {
        const categoryPattern = CATEGORY_PATTERNS[category];
        const direct = new RegExp(`${ordinal.pattern}.{0,24}${categoryPattern}|${categoryPattern}.{0,24}${ordinal.pattern}`, "iu");
        if (direct.test(text) && candidates[ordinal.index]) selections.set(category, candidates[ordinal.index]!);
      }
    }
    const nameMatches: Array<{ category: MealCategory; recipe: VerifiedMealRecipe }> = [];
    for (const category of session.categories) {
      for (const recipe of session.candidates[category]) {
        const names = [recipe.nameAr, recipe.nameEn, ...recipe.aliases].map(normalizeNameMatch).filter((name) => name.length >= 2);
        if (names.some((name) => nameMatchText.includes(name))) nameMatches.push({ category, recipe });
      }
    }
    for (const match of nameMatches) {
      const sameRecipeMatches = nameMatches.filter((candidate) => candidate.recipe.recipeId === match.recipe.recipeId);
      if (sameRecipeMatches.length > 1 && !new RegExp(CATEGORY_PATTERNS[match.category], "iu").test(text)) return { kind: "ambiguous" };
      const existing = selections.get(match.category);
      if (existing && existing.recipeId !== match.recipe.recipeId) return { kind: "ambiguous" };
      selections.set(match.category, match.recipe);
    }
    if (selections.size === 0) {
      const availableCategories = session.categories.filter((category) => session.candidates[category].length > 0 && !session.selected[category]);
      const ordinal = ORDINALS.find((candidate) => new RegExp(`(?:^|\\s)${candidate.pattern}(?:$|\\s)`, "iu").test(text));
      if (availableCategories.length === 1 && ordinal) {
        const recipe = session.candidates[availableCategories[0]!][ordinal.index];
        if (recipe) selections.set(availableCategories[0]!, recipe);
      }
    }
    return selections.size > 0 ? { kind: "ok", selections } : { kind: "no_match" };
  }

  private showConfirmation(session: CandidateSession, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse {
    if (session.latestPendingOperationId) {
      const prior = this.pending.get(session.latestPendingOperationId);
      if (prior?.state === "ACTIVE") prior.state = "INVALID";
    }
    const selections = session.categories.flatMap((category) => {
      const selected = session.selected[category];
      return selected ? [{ recipeId: selected.recipeId, mealCategory: category, nameAr: selected.nameAr, nameEn: selected.nameEn, nutritionSnapshot: structuredClone(selected.nutrition) }] : [];
    });
    const now = this.now();
    const operation: PendingOperation = {
      id: this.idFactory(),
      selectionSessionId: session.id,
      state: "ACTIVE",
      createdAtMs: now,
      expiresAtMs: now + this.ttlMs,
      selections,
      total: sumNutrition(selections),
      ceilingMode: session.ceilingMode,
      submissionTimestamp: null,
    };
    this.pending.set(operation.id, operation);
    this.pruneOperations(operation.id);
    session.latestPendingOperationId = operation.id;
    const lines = selections.map((selection) => `• ${categoryLabel(selection.mealCategory, language)}: ${language === "en" ? selection.nameEn : selection.nameAr} — ${nutritionLine(selection.nutritionSnapshot, language)}`);
    const mode = operation.ceilingMode === "total_across_plan_equal_split"
      ? language === "en" ? "whole-plan ceiling (equal split)" : "سقف لكل الخطة (مقسوم بالتساوي)"
      : operation.ceilingMode === "per_meal" ? language === "en" ? "separate per-meal ceiling" : "سقف لكل وجبة على حدة" : language === "en" ? "no ceiling" : "بدون سقف سعرات";
    const context: MealSelectionPendingConversationContext = { schemaVersion: "1.0", lastIntent: "meal_selection_pending", mealSelectionSessionId: session.id, pendingOperationId: operation.id };
    return flowResponse(
      language,
      "ok",
      language === "en"
        ? `Confirmation summary (${mode}):\n${lines.join("\n")}\nTotal: ${nutritionLine(operation.total, language)}\n\nConfirm?`
        : `ملخص التأكيد (${mode}):\n${lines.join("\n")}\nالإجمالي: ${nutritionLine(operation.total, language)}\n\nتأكيد؟`,
      { intent: "meal_selection_confirmation", pendingOperationId: operation.id, state: operation.state, selections, totalNutritionSnapshot: operation.total, ceilingMode: operation.ceilingMode, conversationContext: context },
      selections.map((selection) => `DEMO-${selection.recipeId}`),
    );
  }

  private logResponse(operation: PendingOperation, response: DashboardResponse, language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse {
    const context: MealSelectionAppliedConversationContext | MealSelectionPendingConversationContext = operation.state === "APPLIED"
      ? { schemaVersion: "1.0", lastIntent: "meal_selection_applied", mealSelectionSessionId: operation.selectionSessionId, pendingOperationId: operation.id }
      : { schemaVersion: "1.0", lastIntent: "meal_selection_pending", mealSelectionSessionId: operation.selectionSessionId, pendingOperationId: operation.id };
    if (response.status === "error") {
      return flowResponse(
        language,
        "no_result",
        language === "en" ? `Nothing was logged: ${errorMessage(response.error_code, language)}. [MOCK DASHBOARD]` : `لم تتم إضافة أي شيء: ${errorMessage(response.error_code, language)}. [MOCK DASHBOARD]`,
        { intent: "meal_selection_log", mock: true, applied: false, errorCode: response.error_code, pendingOperationId: operation.id, conversationContext: context },
        [],
        [{ tool: "confirm_and_log_meal_selection", ok: false, code: response.error_code }],
      );
    }
    if (!response.applied) {
      return flowResponse(
        language,
        "ok",
        language === "en" ? `This selection was already logged; no new deduction occurred. Mock daily calories remaining: ${response.daily_calories_remaining}.` : `الاختيارات دي اتسجلت قبل كده؛ محصلش خصم جديد. السعرات اليومية المتبقية في الـmock: ${response.daily_calories_remaining}.`,
        { intent: "meal_selection_log", mock: true, applied: false, reason: response.reason, pendingOperationId: operation.id, dailyCaloriesRemaining: response.daily_calories_remaining, selections: operation.selections, totalNutritionSnapshot: operation.total, conversationContext: context },
        [],
        [{ tool: "confirm_and_log_meal_selection", ok: true, code: "already_logged" }],
      );
    }
    return flowResponse(
      language,
      "ok",
      language === "en" ? `Logged to the MOCK dashboard. Mock daily calories remaining: ${response.daily_calories_remaining}.` : `تم التسجيل في MOCK الداشبورد. السعرات اليومية المتبقية في الـmock: ${response.daily_calories_remaining}.`,
      { intent: "meal_selection_log", mock: true, applied: true, pendingOperationId: operation.id, loggedSelectionIds: response.logged_selection_ids, dailyCaloriesRemaining: response.daily_calories_remaining, selections: operation.selections, totalNutritionSnapshot: operation.total, conversationContext: context },
      [],
      [{ tool: "confirm_and_log_meal_selection", ok: true, code: null }],
    );
  }

  private invalidConfirmation(language: "ar-EG" | "ar" | "en"): ExpandedAgentResponse {
    return flowResponse(
      language,
      "clarification",
      language === "en" ? "This confirmation expired. Request the meal options again." : "انتهت صلاحية التأكيد. اطلب اختيارات الوجبات من جديد.",
      { intent: "meal_selection_log", errorCode: "confirmation_expired", mockCalled: false },
      [],
      [{ tool: "confirm_and_log_meal_selection", ok: false, code: "confirmation_expired" }],
    );
  }

  private isValidConfirmation(message: string): boolean {
    const text = normalizeText(message);
    return CONFIRMATION_PHRASES.has(text) && !this.looksLikeModification(message);
  }

  private looksLikeModification(message: string): boolean {
    const text = normalizeText(message);
    return /(?:\bبس\b|غير|بدل|استبدل|اختار|الاول|الثاني|التاني|الثالث|التالت|first|second|third|change|instead|but|وجبه|وجبات|meal)/iu.test(text);
  }
}

export async function confirm_and_log_meal_selection(
  flow: MealSelectionFlow,
  pendingOperationId: string,
  language: "ar-EG" | "ar" | "en" = "ar-EG",
): Promise<ExpandedAgentResponse> {
  return flow.confirm_and_log_meal_selection(pendingOperationId, language);
}
