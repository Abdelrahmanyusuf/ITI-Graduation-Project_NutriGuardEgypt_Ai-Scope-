import type { ExpandedAgentResponse } from "../agent/expanded-agent.js";
import { NUTRIGUARD_SYSTEM_PROMPT_VERSION } from "../agent/system-prompt.js";
import type { DashboardMealCategory } from "../services/dashboard/dashboard-client.js";
import { PENDING_MEAL_CONFIRMATION_TTL_SECONDS, type FrozenMealNutrition, type FrozenMealSelection, type PendingMealOperationStore } from "../services/dashboard/pending-meal-operations.js";
import type { MealCategoryOption, MealCategorySearchOutput, MealSelectionToolset } from "../tools/meal-selection-tools.js";

type Language = "ar-EG" | "ar" | "en";

/** Which meaning a single stated calorie ceiling has. */
export type MealCeilingMode = "total" | "per_meal" | "none";

/**
 * One requested category inside an active selection state.
 *
 * Only identifiers are stored. Every nutrition number is recalculated from the
 * dataset on the turn it is displayed, so the numbers shown in the candidate
 * list, in the confirmation summary, and in the post-log confirmation can never
 * drift apart, and a tampered client payload can never inject a value.
 */
export interface MealSelectionCategoryState {
  mealCategory: DashboardMealCategory;
  /** Options exactly as shown, each holding one recipe (or two for a snack set). */
  options: Array<{ optionIndex: number; recipeIds: string[] }>;
  /** Real number of verified recipes that matched, used for the honest count. */
  verifiedMatchCount: number;
  selectedOptionIndex: number | null;
}

export interface MealSelectionState {
  schemaVersion: "1.0";
  phase: "awaiting_selection" | "awaiting_confirmation" | "completed";
  ceilingMode: MealCeilingMode;
  ceilingKcal: number | null;
  includeSodium: boolean;
  excludedIngredientKeys: string[];
  categories: MealSelectionCategoryState[];
  /**
   * The id generated once, at summary-display time. It is the idempotency key and
   * is never regenerated for a retry or a repeated confirmation message.
   */
  pendingOperationId: string | null;
}

export interface MealSelectionContextEnvelope {
  schemaVersion: "1.0";
  lastIntent: "meal_selection";
  selection: MealSelectionState;
}

/** Deterministic helpers borrowed from the agent so nothing is reimplemented. */
export interface MealSelectionSharedHelpers {
  /**
   * The exact allergy/exclusion disclaimer implemented by the earlier exclusion
   * fix. Injected rather than copied so there is a single implementation.
   */
  exclusionSafetyNote(removedNames: readonly string[], language: Language): string;
  excludedIngredientKeys(message: string): string[];
  ingredientLabel(key: string, language: Language): string;
  normalizeNumberDigits(value: string): string;
  normalizedLookupText(value: string): string;
  dairyIngredientKeys: ReadonlySet<string>;
}

export interface MealSelectionRecipeName {
  recipeId: string;
  name: string;
}

export interface MealPlanSelectionFlowDependencies {
  tools: MealSelectionToolset;
  pendingOperations: PendingMealOperationStore;
  helpers: MealSelectionSharedHelpers;
  /** Display name + recomputed nutrition for one recipe, per serving. */
  recipeSnapshot(recipeId: string, language: Language): { name: string; nutrition: FrozenMealNutrition } | null;
}

export interface MealPlanSelectionInput {
  message: string;
  language: Language;
  state: MealSelectionState | null;
}

const CATEGORY_ORDER: readonly DashboardMealCategory[] = ["breakfast", "lunch", "dinner", "snacks"];

/**
 * Category detection, deliberately boundary-anchored on normalized text.
 *
 * The lookarounds are not decoration. Unanchored, "عشا" matches inside "عشان",
 * which is one of the most common words in Egyptian Arabic and appears in
 * existing regression messages. `\b` cannot be used between Arabic letters
 * because it is defined over `[A-Za-z0-9_]`.
 *
 * Known and accepted limitation: normalization folds "غدًا" (tomorrow) onto
 * "غدا" (lunch). This flow is only entered when a category appears together with
 * an explicit multi-option cue, so "الطقس غدًا" cannot reach it.
 *
 * The optional leading "و" matters: the text normalizer strips "ال", "وال",
 * "بال", "كال" and "لل" prefixes but not a bare conjunction, so without it
 * "فطار وغدا وعشا وسناكس" only detected the first category.
 */
const CATEGORY_PATTERNS: ReadonlyArray<{ category: DashboardMealCategory; pattern: RegExp }> = [
  { category: "breakfast", pattern: /(?<!\p{L})و?(?:فطار|افطار)(?!\p{L})|\bbreakfast\b/iu },
  { category: "lunch", pattern: /(?<!\p{L})و?(?:غدا|غداء)(?!\p{L})|\blunch\b/iu },
  { category: "dinner", pattern: /(?<!\p{L})و?(?:عشا|عشاء)(?!\p{L})|\bdinner\b|\bsupper\b/iu },
  { category: "snacks", pattern: /(?<!\p{L})و?(?:سناكس|سناك|سناكات|تصبيره|تصبيرات)(?!\p{L})|\bsnacks?\b|(?<!\p{L})و?(?:وجب(?:ه|ات)\s+خفيف(?:ه|ات))(?!\p{L})/iu },
];

/** Explicit "give me options to choose from" wording. */
const OPTIONS_CUE_PATTERN = /(?<!\p{L})(?:اختيارات|خيارات|اقتراحات|بدائل)(?!\p{L})|\boptions?\b|\bchoices?\b/iu;

/** "وجبة"/"meal" as a noun, used only to keep single-meal requests on their old path. */
const MEAL_NOUN_PATTERN = /(?<!\p{L})(?:وجبه|وجبات|وجبتين)(?!\p{L})|\bmeals?\b/iu;

const PER_MEAL_CEILING_PATTERN = /(?:كل\s*وجب(?:ه|ة)|لكل\s*وجب(?:ه|ة)|للوجب(?:ه|ة)\s*الواحده|per\s+meal|each\s+meal|every\s+meal)/iu;

const CALORIE_AMOUNT_PATTERN = /(\d+(?:\.\d+)?)\s*(?:سعر(?:ه|ة|ات)?(?:\s*حراري(?:ه|ة)?)?|كالوري|kcal|calories?)/iu;

const SODIUM_REQUEST_PATTERN = /(?:صوديوم|ملح|sodium|salt)/iu;

/**
 * Unambiguous positive confirmation (Step 16 v3 correction).
 *
 * The whole message, ignoring punctuation and filler, must consist of positive
 * confirmation wording. Anything carrying a modification, a new constraint,
 * hesitation, or an unrelated question is deliberately excluded so it can never
 * be read as consent to a write.
 */
const CONFIRMATION_PATTERN = /^(?:(?:ايوه|اه|نعم|اوك|ok|okay|yes|yep|sure)\s+)?(?:تاكيد|اكد|اكدها|اكدهم|موافق|موافقه|سجل|سجلها|سجلهم|احفظ|احفظها|confirm|confirmed|log\s+it|save\s+it|go\s+ahead|do\s+it)$/iu;

/** Bare agreement that is NOT specific enough to authorise a write on its own. */
const WEAK_AGREEMENT_PATTERN = /^(?:تمام|ماشي|حلو|طيب|اوك|اوكي|ايوه|اه|نعم|يس|ok|okay|fine|good|great|yes|yeah|sure)$/iu;

const CANCEL_PATTERN = /^(?:(?:لا|مش|بلاش)\s*)?(?:الغي|الغاء|كنسل|بلاش|متسجلش|ماتسجلش|لا\s*تسجل|cancel|stop|abort|forget\s+it|never\s+mind)$/iu;

/**
 * Wording that makes a message a selection attempt even when nothing in it
 * resolves.
 *
 * Needed so "اختار الملوخية" — a pick verb naming a dish that is not on the
 * displayed list — is answered with a clarification rather than a guess, while a
 * bare "عايز الملوخية" stays an ordinary new recipe request and keeps its
 * existing route.
 */
const SELECTION_INTENT_PATTERN = /(?<!\p{L})(?:اختار|اختر|اختاره|اختيار|هاخد|هخد)(?!\p{L})|\b(?:choose|pick|select|option)\b/iu;

/**
 * A change request. Detected before confirmation, so "تمام بس غير الغدا" is a
 * change rather than the consent it superficially resembles.
 */
const MODIFICATION_PATTERN = /(?<!\p{L})(?:غير|غيّر|بدل|استبدل|شيل|احذف|عدل)(?!\p{L})|\b(?:change|replace|swap|remove|different|another)\b/iu;

/**
 * Ordinals, bounded on both sides against letters AND digits.
 *
 * Without the digit lookarounds "13" contained the ordinal "3" and "1800"
 * contained "1", so a calorie amount silently became an option number.
 */
const ORDINAL_PATTERNS: ReadonlyArray<{ index: number; pattern: RegExp }> = [
  { index: 1, pattern: /(?<![\p{L}\p{N}])و?(?:اول|اولي|واحد|1)(?![\p{L}\p{N}])|\b(?:first|one)\b/iu },
  { index: 2, pattern: /(?<![\p{L}\p{N}])و?(?:تاني|ثاني|تانيه|ثانيه|اتنين|2)(?![\p{L}\p{N}])|\b(?:second|two)\b/iu },
  { index: 3, pattern: /(?<![\p{L}\p{N}])و?(?:تالت|ثالت|ثالث|تالته|تلاته|ثلاثه|3)(?![\p{L}\p{N}])|\b(?:third|three)\b/iu },
];

const CATEGORY_LABELS: Record<DashboardMealCategory, { ar: string; en: string }> = {
  breakfast: { ar: "الفطار", en: "Breakfast" },
  lunch: { ar: "الغداء", en: "Lunch" },
  dinner: { ar: "العشاء", en: "Dinner" },
  snacks: { ar: "السناكس", en: "Snacks" },
};

function label(category: DashboardMealCategory, language: Language): string {
  return language === "en" ? CATEGORY_LABELS[category].en : CATEGORY_LABELS[category].ar;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function response(
  status: ExpandedAgentResponse["status"],
  language: Language,
  message: string,
  data: Record<string, unknown>,
  toolTrace: ExpandedAgentResponse["toolTrace"] = [],
  provenance: ExpandedAgentResponse["provenance"] = [],
  evidenceDocumentIds: string[] = [],
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
    provenance,
    toolTrace,
    promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
  };
}

interface ParsedReference {
  category: DashboardMealCategory | null;
  optionIndex: number | null;
  /** How the reference was recognised, reported so a clarification can explain it. */
  via: "ordinal_with_category" | "bare_ordinal" | "recipe_name" | "category_only";
}

/**
 * Step 16 — multi-option meal-plan selection against the mocked dashboard.
 *
 * The flow owns four turn shapes and nothing else:
 *   1. a request for candidate options in one or more meal categories;
 *   2. a selection (or a change of selection) referring to the just-shown list;
 *   3. an unambiguous confirmation of a displayed summary;
 *   4. a cancellation.
 *
 * It returns `null` for anything it does not own, so the surrounding router keeps
 * its existing behaviour untouched.
 *
 * No write reaches the dashboard client except through
 * `confirm_and_log_meal_selection`, and only after a summary was displayed in an
 * earlier turn and confirmed in a later one.
 */
export class MealPlanSelectionFlow {
  public constructor(private readonly dependencies: MealPlanSelectionFlowDependencies) {}

  /**
   * Turns that depend on an existing selection state: cancel, select, change,
   * confirm, or an explicit answer to a confirmation that no longer has a live
   * pending operation.
   *
   * Returns `null` when the message is not about the selection at all, which is
   * what lets an unrelated question pass straight through while a pending
   * operation quietly stays active until its TTL.
   *
   * Called early in the router, before generic conversational handling, so a
   * confirmation cannot be swallowed as a generic acknowledgement.
   */
  public async handleStateTurn(input: MealPlanSelectionInput): Promise<ExpandedAgentResponse | null> {
    const { language } = input;
    const helpers = this.dependencies.helpers;
    const normalized = helpers.normalizedLookupText(helpers.normalizeNumberDigits(input.message.trim()));
    const state = input.state;

    if (state && state.phase !== "completed") {
      if (CANCEL_PATTERN.test(normalized)) return this.cancel(state, language);

      const modification = MODIFICATION_PATTERN.test(normalized);
      const references = this.parseReferences(normalized, state);
      const confirmation = CONFIRMATION_PATTERN.test(normalized);
      const weakAgreement = WEAK_AGREEMENT_PATTERN.test(normalized);

      // A change always beats a confirmation. "تمام بس غير الغدا" is a
      // modification, so it invalidates the pending operation instead of
      // authorising the write it superficially appears to accept.
      if (modification || references.length > 0) {
        return this.applySelections(state, references, { language, modification });
      }
      // A pick verb that resolved to nothing is a selection attempt against a list
      // that no longer contains what the user named. Ask, never guess.
      if (SELECTION_INTENT_PATTERN.test(normalized)) {
        return this.ambiguousReference(state, language, "no_currently_displayed_match", state.categories.filter((category) => category.options.length > 0).map((category) => category.mealCategory));
      }
      if (state.phase === "awaiting_confirmation" && confirmation) return this.confirm(state, language);
      if (state.phase === "awaiting_confirmation" && weakAgreement) return this.confirmationIntentUnclear(state, language);
      if (state.phase === "awaiting_selection" && (confirmation || weakAgreement)) return this.stillAwaitingSelection(state, language);
      // Anything else while a pending operation is active is NOT a confirmation
      // and NOT a rejection. The operation simply stays active until its TTL.
      return null;
    }

    // A confirmation with no live pending operation must be answered explicitly
    // rather than silently ignored or guessed at.
    if (CONFIRMATION_PATTERN.test(normalized)) {
      if (!state) return this.confirmationExpired(null, "unknown", language);
      return this.confirmationExpired(state.pendingOperationId, "resolved", language);
    }
    return null;
  }

  /**
   * A fresh request for candidate options. Returns `null` when the message is not
   * a multi-option meal-plan request, so every previously supported phrasing keeps
   * its existing route.
   *
   * Called later in the router than `handleStateTurn`, after the medical-safety
   * gate, so a safety-routed message can never be answered with a meal plan.
   */
  public async handleNewRequest(input: MealPlanSelectionInput): Promise<ExpandedAgentResponse | null> {
    const helpers = this.dependencies.helpers;
    const raw = helpers.normalizeNumberDigits(input.message.trim());
    const normalized = helpers.normalizedLookupText(raw);
    const request = this.parseRequest(raw, normalized);
    if (!request) return null;
    return this.showCandidates(request, input.language, input.message);
  }

  // -------------------------------------------------------------------------
  // Request parsing
  // -------------------------------------------------------------------------

  /**
   * Decide whether this message is a multi-option meal-plan request.
   *
   * The gate is deliberately narrow so that every previously supported phrasing
   * keeps its old route. It fires only when at least one meal category is named
   * AND one of these holds:
   *   - two or more distinct categories are named;
   *   - the snacks category is named (new in v3, so no prior behaviour exists);
   *   - explicit options wording is present ("اختيارات", "options", …);
   *   - a calorie ceiling is stated for a bare category with no "وجبة"/"meal"
   *     noun, which is the "عايز غدا 600 سعرة" shape from the specification.
   * The last clause is what keeps "عاوز وجبة إفطار 500 سعر" on the existing
   * single-meal path.
   */
  private parseRequest(raw: string, normalized: string): { categories: DashboardMealCategory[]; ceilingKcal: number | null; ceilingMode: MealCeilingMode; includeSodium: boolean } | null {
    const categories = CATEGORY_ORDER.filter((category) => CATEGORY_PATTERNS.find((entry) => entry.category === category)?.pattern.test(normalized));
    if (categories.length === 0) return null;
    const amount = raw.match(CALORIE_AMOUNT_PATTERN);
    const ceilingKcal = amount ? Number(amount[1]) : null;
    const validCeiling = ceilingKcal !== null && Number.isFinite(ceilingKcal) && ceilingKcal >= 50 && ceilingKcal <= 5_000 ? ceilingKcal : null;
    const optionsCue = OPTIONS_CUE_PATTERN.test(normalized);
    const bareCategoryCeiling = validCeiling !== null && !MEAL_NOUN_PATTERN.test(normalized);
    if (categories.length < 2 && !categories.includes("snacks") && !optionsCue && !bareCategoryCeiling) return null;

    const perMeal = PER_MEAL_CEILING_PATTERN.test(normalized);
    // Product decision (v2, tightened in v3): one ceiling with several categories
    // caps the TOTAL; per-meal wording caps each category; one ceiling with a
    // single category is that meal's ceiling, which is per-meal by definition.
    const ceilingMode: MealCeilingMode = validCeiling === null
      ? "none"
      : perMeal || categories.length === 1 ? "per_meal" : "total";
    return { categories, ceilingKcal: validCeiling, ceilingMode, includeSodium: SODIUM_REQUEST_PATTERN.test(normalized) };
  }

  /**
   * Resolve every selection reference in the message against what is displayed.
   *
   * Recognised shapes: an ordinal paired with a category ("الأول في الفطار"), a
   * bare ordinal, a recipe name matching a shown option, and a bare category
   * ("غير الغدا") which asks for that category to be chosen again.
   */
  private parseReferences(normalized: string, state: MealSelectionState): ParsedReference[] {
    const categoryHits = state.categories.flatMap((category) => {
      const pattern = CATEGORY_PATTERNS.find((entry) => entry.category === category.mealCategory)?.pattern;
      if (!pattern) return [];
      const match = normalized.match(new RegExp(pattern.source, "iu"));
      return match?.index === undefined ? [] : [{ category: category.mealCategory, index: match.index }];
    });
    const ordinalHits = ORDINAL_PATTERNS.flatMap((entry) => {
      const matches = [...normalized.matchAll(new RegExp(entry.pattern.source, "giu"))];
      return matches.map((match) => ({ optionIndex: entry.index, index: match.index ?? 0 }));
    }).sort((left, right) => left.index - right.index);

    const references: ParsedReference[] = [];
    const usedCategories = new Set<DashboardMealCategory>();
    for (const ordinal of ordinalHits) {
      const nearest = [...categoryHits]
        .filter((hit) => !usedCategories.has(hit.category))
        .sort((left, right) => Math.abs(left.index - ordinal.index) - Math.abs(right.index - ordinal.index) || CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category))[0];
      if (nearest) {
        usedCategories.add(nearest.category);
        references.push({ category: nearest.category, optionIndex: ordinal.optionIndex, via: "ordinal_with_category" });
      } else {
        references.push({ category: null, optionIndex: ordinal.optionIndex, via: "bare_ordinal" });
      }
    }

    // Recipe names. Every currently shown option contributes its full normalized
    // name plus its first one and two tokens, so "الفول" can resolve "فول مدمس".
    if (references.length === 0) {
      const padded = ` ${normalized} `;
      const hits: Array<{ category: DashboardMealCategory; optionIndex: number; phraseLength: number }> = [];
      for (const category of state.categories) {
        for (const option of category.options) {
          for (const recipeId of option.recipeIds) {
            const snapshot = this.dependencies.recipeSnapshot(recipeId, "ar-EG");
            const english = this.dependencies.recipeSnapshot(recipeId, "en");
            const names = [snapshot?.name, english?.name].filter((name): name is string => typeof name === "string");
            for (const name of names) {
              const normalizedName = this.dependencies.helpers.normalizedLookupText(name);
              const tokens = normalizedName.split(/\s+/u).filter(Boolean);
              const phrases = new Set<string>([normalizedName]);
              if (tokens[0] && tokens[0].length >= 3) phrases.add(tokens[0]);
              if (tokens.length >= 2) phrases.add(tokens.slice(0, 2).join(" "));
              for (const phrase of phrases) {
                if (phrase.length >= 3 && padded.includes(` ${phrase} `)) hits.push({ category: category.mealCategory, optionIndex: option.optionIndex, phraseLength: phrase.length });
              }
            }
          }
        }
      }
      const longest = Math.max(0, ...hits.map((hit) => hit.phraseLength));
      const best = hits.filter((hit) => hit.phraseLength === longest);
      const distinct = new Map(best.map((hit) => [`${hit.category}#${hit.optionIndex}`, hit]));
      if (distinct.size === 1) {
        const only = [...distinct.values()][0]!;
        references.push({ category: only.category, optionIndex: only.optionIndex, via: "recipe_name" });
      } else if (distinct.size > 1) {
        // Ambiguous on purpose: surfaced as a clarification, never guessed.
        for (const hit of distinct.values()) references.push({ category: hit.category, optionIndex: hit.optionIndex, via: "recipe_name" });
      }
    }

    // A bare category with no ordinal asks to re-choose that category.
    if (references.length === 0) {
      for (const hit of categoryHits) references.push({ category: hit.category, optionIndex: null, via: "category_only" });
    }
    return references;
  }

  // -------------------------------------------------------------------------
  // Candidate listing
  // -------------------------------------------------------------------------

  private async showCandidates(
    request: { categories: DashboardMealCategory[]; ceilingKcal: number | null; ceilingMode: MealCeilingMode; includeSodium: boolean },
    language: Language,
    originalMessage: string,
  ): Promise<ExpandedAgentResponse> {
    const helpers = this.dependencies.helpers;
    const exclusions = helpers.excludedIngredientKeys(originalMessage);
    // In TOTAL mode the ceiling is intentionally NOT pushed down into the search.
    // Each category returns its usual verified candidates and the ceiling is
    // enforced once, on the summed selection, at summary time. That avoids
    // inventing an arbitrary per-category split.
    const perCategoryCeiling = request.ceilingMode === "per_meal" ? request.ceilingKcal : null;

    const results: Array<{ category: DashboardMealCategory; output: MealCategorySearchOutput }> = [];
    const provenance: ExpandedAgentResponse["provenance"] = [];
    const toolTrace: ExpandedAgentResponse["toolTrace"] = [];
    for (const category of request.categories) {
      const search = await this.dependencies.tools.searchRecipesByMealCategory({ category, calorieCeilingKcal: perCategoryCeiling, exclusions });
      toolTrace.push({ tool: "search_recipes_by_meal_category", ok: search.ok, code: search.ok ? null : search.errors[0]?.code ?? "unknown" });
      if (!search.ok) continue;
      results.push({ category, output: search.data });
      provenance.push(...search.provenance);
    }

    const state: MealSelectionState = {
      schemaVersion: "1.0",
      phase: "awaiting_selection",
      ceilingMode: request.ceilingMode,
      ceilingKcal: request.ceilingKcal,
      includeSodium: request.includeSodium,
      excludedIngredientKeys: exclusions,
      categories: results.map(({ category, output }) => ({
        mealCategory: category,
        options: output.options.map((option) => ({ optionIndex: option.optionIndex, recipeIds: option.recipes.map((recipe) => recipe.recipeId) })),
        verifiedMatchCount: output.verifiedMatchCount,
        selectedOptionIndex: null,
      })),
      pendingOperationId: null,
    };

    // The tool records names in Arabic. Display names are re-resolved here through
    // the same snapshot function the summary uses, so one localization path serves
    // every stage and the numbers stay identical.
    const localized = results.map(({ category, output }) => ({
      category,
      output: { ...output, options: output.options.map((option) => this.localizeOption(option, language)) },
    }));

    const sections = localized.map(({ category, output }) => this.renderCategorySection(category, output, language, request.includeSodium));
    const selectable = state.categories.filter((category) => category.options.length > 0);
    const message = [
      language === "en" ? "Verified options per meal category:" : "اختيارات متحققة لكل قسم:",
      sections.join("\n\n"),
      this.renderCeilingLine(request.ceilingMode, request.ceilingKcal, language),
      selectable.length === 0
        ? language === "en"
          ? "Nothing matched, so there is nothing to select and nothing was logged."
          : "مفيش أي اختيار مطابق، فمفيش حاجة تتختار ومفيش حاجة اتسجلت."
        : language === "en"
          ? "Pick one option per category, for example: “the first for breakfast, the third for lunch”. I will show a summary and log nothing until you confirm it."
          : "اختار رقم واحد من كل قسم، مثال: «الأول في الفطار، التالت في الغدا». هعرض لك ملخص وما هسجّلش أي حاجة قبل ما تأكده.",
      this.exclusionNote(exclusions, language),
    ].filter((line) => line !== "").join("\n\n");

    return response(
      selectable.length === 0 ? "no_result" : "ok",
      language,
      message,
      {
        intent: "meal_plan_selection",
        stage: selectable.length === 0 ? "no_candidates" : "candidates",
        ceilingMode: request.ceilingMode,
        ceilingKcal: request.ceilingKcal,
        excludedIngredientKeys: exclusions,
        safetyDisclaimer: exclusions.length === 0 ? null : this.exclusionDisclaimer(exclusions, language),
        categories: localized.map(({ category, output }) => ({
          mealCategory: category,
          status: output.status,
          verifiedMatchCount: output.verifiedMatchCount,
          options: output.options.map((option) => this.optionPayload(option, request.includeSodium)),
        })),
        conversationContext: this.contextOf(state),
      },
      toolTrace,
      provenance,
      results.flatMap(({ output }) => output.options.flatMap((option) => option.recipes.map((recipe) => `DEMO-${recipe.recipeId}`))),
    );
  }

  private localizeOption(option: MealCategoryOption, language: Language): MealCategoryOption {
    return {
      ...option,
      recipes: option.recipes.map((recipe) => ({
        ...recipe,
        name: this.dependencies.recipeSnapshot(recipe.recipeId, language)?.name ?? recipe.name,
      })),
    };
  }

  private optionPayload(option: MealCategoryOption, includeSodium: boolean): Record<string, unknown> {
    return {
      optionIndex: option.optionIndex,
      isSnackSet: option.isSnackSet,
      subtotalCaloriesKcal: option.subtotalCaloriesKcal,
      recipes: option.recipes.map((recipe) => ({
        recipeId: recipe.recipeId,
        name: recipe.name,
        caloriesKcal: recipe.nutrition.caloriesKcal,
        proteinG: recipe.nutrition.proteinG,
        carbsG: recipe.nutrition.carbsG,
        fatG: recipe.nutrition.fatG,
        ...(includeSodium ? { sodiumMg: recipe.nutrition.sodiumMg } : {}),
      })),
    };
  }

  private renderCategorySection(category: DashboardMealCategory, output: MealCategorySearchOutput, language: Language, includeSodium: boolean): string {
    const heading = label(category, language);
    if (output.status === "empty") {
      return language === "en"
        ? `${heading}: no verified recipe matches these constraints, so I am showing none for it and continuing with the rest.`
        : `${heading}: مفيش أي وصفة متحققة مطابقة للشروط دي، فما عرضتش حاجة للقسم ده وكمّلت الباقي.`;
    }
    const countNote = output.status === "complete"
      ? language === "en"
        ? `${output.options.length} option${output.options.length === 1 ? "" : "s"} out of ${output.verifiedMatchCount} verified matching recipes`
        : `${output.options.length} اختيارات من أصل ${output.verifiedMatchCount} وصفة متحققة مطابقة`
      : language === "en"
        ? `only ${output.verifiedMatchCount} verified recipe${output.verifiedMatchCount === 1 ? "" : "s"} matched, so that is all there is`
        : `${output.verifiedMatchCount} وصفة متحققة بس مطابقة، فده كل اللي موجود`;
    const lines = output.options.map((option) => {
      const body = option.recipes.map((recipe) => this.renderNutritionLine(recipe.name, recipe.nutrition, language, includeSodium)).join(language === "en" ? "\n     + " : "\n     + ");
      const setNote = option.isSnackSet
        ? language === "en"
          ? `\n     [both together as one snack set, ${option.subtotalCaloriesKcal} kcal total]`
          : `\n     [الاتنين مع بعض كطقم سناكس واحد، الإجمالي ${option.subtotalCaloriesKcal} سعر حراري]`
        : "";
      return `• ${option.optionIndex}. ${body}${setNote}`;
    });
    return `${heading} (${countNote}):\n${lines.join("\n")}`;
  }

  private renderNutritionLine(name: string, nutrition: FrozenMealNutrition, language: Language, includeSodium: boolean): string {
    const sodium = includeSodium
      ? language === "en" ? `, ${nutrition.sodiumMg ?? "unknown"} mg sodium` : `، ${nutrition.sodiumMg ?? "غير متوفر"} مجم صوديوم`
      : "";
    return language === "en"
      ? `${name} — ${nutrition.caloriesKcal} kcal, ${nutrition.proteinG} g protein, ${nutrition.carbsG} g carbohydrates, ${nutrition.fatG} g fat${sodium}`
      : `${name} — ${nutrition.caloriesKcal} سعر حراري، ${nutrition.proteinG} جم بروتين، ${nutrition.carbsG} جم كربوهيدرات، ${nutrition.fatG} جم دهون${sodium}`;
  }

  private renderCeilingLine(mode: MealCeilingMode, ceilingKcal: number | null, language: Language): string {
    if (mode === "none" || ceilingKcal === null) {
      return language === "en" ? "Calorie ceiling: none stated." : "السقف الحراري: ما حددتش سقف.";
    }
    if (mode === "total") {
      return language === "en"
        ? `Calorie ceiling: ${ceilingKcal} kcal for the whole plan (a ceiling across all selected meals together).`
        : `السقف الحراري: ${ceilingKcal} سعر حراري — سقف لكل الخطة (على مجموع الوجبات المختارة كلها).`;
    }
    return language === "en"
      ? `Calorie ceiling: ${ceilingKcal} kcal per meal (applied to each category separately).`
      : `السقف الحراري: ${ceilingKcal} سعر حراري — سقف لكل وجبة على حدة (مطبّق على كل قسم لوحده).`;
  }

  /** Reuses the shared exclusion disclaimer instead of writing a second one. */
  private exclusionDisclaimer(exclusions: readonly string[], language: Language): string {
    const helpers = this.dependencies.helpers;
    const dairyRequest = exclusions.length > 0 && [...helpers.dairyIngredientKeys].every((key) => exclusions.includes(key));
    const names = dairyRequest
      ? [language === "en" ? "the recorded dairy ingredients" : "منتجات الألبان المسجلة"]
      : exclusions.map((key) => helpers.ingredientLabel(key, language));
    return helpers.exclusionSafetyNote(names, language);
  }

  private exclusionNote(exclusions: readonly string[], language: Language): string {
    if (exclusions.length === 0) return "";
    return this.exclusionDisclaimer(exclusions, language);
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  private async applySelections(
    state: MealSelectionState,
    references: readonly ParsedReference[],
    options: { language: Language; modification: boolean },
  ): Promise<ExpandedAgentResponse> {
    const { language } = options;
    const selectable = state.categories.filter((category) => category.options.length > 0);
    if (selectable.length === 0) return this.stillAwaitingSelection(state, language);

    const resolvable = references.filter((reference) => reference.optionIndex !== null);
    const nameHits = references.filter((reference) => reference.via === "recipe_name");
    if (nameHits.length > 1) {
      return this.ambiguousReference(state, language, "matches_more_than_one_category", nameHits.map((hit) => hit.category).filter((category): category is DashboardMealCategory => category !== null));
    }

    const next: MealSelectionState = {
      ...state,
      categories: state.categories.map((category) => ({ ...category, options: category.options.map((option) => ({ ...option, recipeIds: [...option.recipeIds] })) })),
      excludedIngredientKeys: [...state.excludedIngredientKeys],
    };
    let changed = false;

    for (const reference of resolvable) {
      const category = reference.category === null
        ? selectable.length === 1 ? selectable[0]!.mealCategory : null
        : reference.category;
      if (category === null) return this.ambiguousReference(state, language, "bare_ordinal_with_several_categories", selectable.map((entry) => entry.mealCategory));
      const target = next.categories.find((entry) => entry.mealCategory === category);
      if (!target || target.options.length === 0) return this.ambiguousReference(state, language, "category_has_no_displayed_option", [category]);
      const option = target.options.find((entry) => entry.optionIndex === reference.optionIndex);
      if (!option) return this.ambiguousReference(state, language, "option_not_displayed", [category]);
      if (target.selectedOptionIndex !== option.optionIndex) changed = true;
      target.selectedOptionIndex = option.optionIndex;
    }

    // A bare category reference clears that category's pick so it is chosen again.
    const clearOnly = references.filter((reference) => reference.via === "category_only" && reference.category !== null);
    for (const reference of clearOnly) {
      const target = next.categories.find((entry) => entry.mealCategory === reference.category);
      if (target && target.selectedOptionIndex !== null) { target.selectedOptionIndex = null; changed = true; }
    }

    if (resolvable.length === 0 && clearOnly.length === 0) {
      return this.ambiguousReference(state, language, "no_currently_displayed_match", selectable.map((entry) => entry.mealCategory));
    }

    // Any change after a summary was shown invalidates that pending operation
    // immediately, so a stale confirmation against it can never be accepted.
    if (state.pendingOperationId && (changed || options.modification)) {
      this.dependencies.pendingOperations.invalidate(state.pendingOperationId);
      next.pendingOperationId = null;
    }

    const outstanding = next.categories.filter((category) => category.options.length > 0 && category.selectedOptionIndex === null);
    if (outstanding.length > 0) {
      next.phase = "awaiting_selection";
      return this.awaitingRemaining(next, outstanding.map((category) => category.mealCategory), language);
    }
    return this.showSummary(next, language);
  }

  private awaitingRemaining(state: MealSelectionState, outstanding: readonly DashboardMealCategory[], language: Language): ExpandedAgentResponse {
    const chosen = state.categories.filter((category) => category.selectedOptionIndex !== null);
    const chosenLines = chosen.map((category) => {
      const option = category.options.find((entry) => entry.optionIndex === category.selectedOptionIndex);
      const names = (option?.recipeIds ?? []).map((recipeId) => this.dependencies.recipeSnapshot(recipeId, language)?.name ?? recipeId);
      return `• ${label(category.mealCategory, language)}: ${names.join(" + ")}`;
    });
    const missing = outstanding.map((category) => label(category, language)).join(language === "en" ? ", " : "، ");
    const message = [
      chosenLines.length === 0 ? "" : `${language === "en" ? "Recorded so far:" : "المسجّل لحد الآن:"}\n${chosenLines.join("\n")}`,
      language === "en" ? `Still waiting for a choice in: ${missing}. Nothing has been logged.` : `مستني اختيارك في: ${missing}. لسه مفيش حاجة اتسجلت.`,
    ].filter(Boolean).join("\n\n");
    return response("clarification", language, message, {
      intent: "meal_plan_selection",
      stage: "awaiting_selection",
      outstandingCategories: [...outstanding],
      conversationContext: this.contextOf({ ...state, phase: "awaiting_selection" }),
    });
  }

  private ambiguousReference(
    state: MealSelectionState,
    language: Language,
    reasonCode: string,
    categories: readonly DashboardMealCategory[],
  ): ExpandedAgentResponse {
    const names = categories.map((category) => label(category, language)).join(language === "en" ? ", " : "، ");
    const message = language === "en"
      ? `I could not tell which option you meant${names ? ` (candidates in: ${names})` : ""}. Name the category and the option number, for example: “the second for dinner”. Nothing was selected and nothing was logged.`
      : `مش واضح قصدك على أنهي اختيار${names ? ` (فيه احتمالات في: ${names})` : ""}. اكتب القسم ورقم الاختيار، مثال: «التاني في العشا». ما اخترتش حاجة وما سجّلتش حاجة.`;
    return response("clarification", language, message, {
      intent: "meal_plan_selection",
      stage: "ambiguous_reference",
      reasonCode,
      candidateCategories: [...categories],
      conversationContext: this.contextOf(state),
    });
  }

  private stillAwaitingSelection(state: MealSelectionState, language: Language): ExpandedAgentResponse {
    const outstanding = state.categories.filter((category) => category.options.length > 0 && category.selectedOptionIndex === null).map((category) => category.mealCategory);
    if (outstanding.length === 0) {
      return response("clarification", language, language === "en"
        ? "There is nothing selectable in the list I showed, so there is nothing to confirm."
        : "مفيش حاجة قابلة للاختيار في اللي عرضته، فمفيش حاجة تتأكد.", {
        intent: "meal_plan_selection",
        stage: "nothing_to_confirm",
        conversationContext: this.contextOf(state),
      });
    }
    return this.awaitingRemaining(state, outstanding, language);
  }

  // -------------------------------------------------------------------------
  // Confirmation summary
  // -------------------------------------------------------------------------

  private showSummary(state: MealSelectionState, language: Language): ExpandedAgentResponse {
    const frozen: FrozenMealSelection[] = [];
    for (const category of state.categories) {
      if (category.selectedOptionIndex === null) continue;
      const option = category.options.find((entry) => entry.optionIndex === category.selectedOptionIndex);
      if (!option) continue;
      const recipes = option.recipeIds.flatMap((recipeId) => {
        const snapshot = this.dependencies.recipeSnapshot(recipeId, language);
        return snapshot ? [{ recipeId, name: snapshot.name, nutrition: snapshot.nutrition }] : [];
      });
      if (recipes.length === 0) continue;
      frozen.push({
        mealCategory: category.mealCategory,
        optionIndex: option.optionIndex,
        recipes,
        subtotalCaloriesKcal: round(recipes.reduce((sum, recipe) => sum + recipe.nutrition.caloriesKcal, 0)),
      });
    }
    const total = round(frozen.reduce((sum, selection) => sum + selection.subtotalCaloriesKcal, 0));

    // TOTAL mode is enforced here and only here. Over budget means no pending
    // operation is created at all, so the flow cannot advance toward a write.
    if (state.ceilingMode === "total" && state.ceilingKcal !== null && total > state.ceilingKcal) {
      const excess = round(total - state.ceilingKcal);
      const message = [
        language === "en" ? "This selection is over your ceiling, so I did not prepare it for logging." : "الاختيار ده فوق السقف اللي طلبته، فما جهّزتهوش للتسجيل.",
        this.renderSelectionLines(frozen, language, state.includeSodium),
        language === "en"
          ? `Total: ${total} kcal against a whole-plan ceiling of ${state.ceilingKcal} kcal — over by ${excess} kcal.`
          : `الإجمالي: ${total} سعر حراري مقابل سقف ${state.ceilingKcal} سعر حراري لكل الخطة — زيادة ${excess} سعر حراري.`,
        language === "en"
          ? "Swap one or more selections for a lighter option and I will show a fresh summary. Nothing was logged."
          : "بدّل اختيار أو أكتر بواحد أخف وأنا أعرض ملخص جديد. مفيش حاجة اتسجلت.",
      ].join("\n\n");
      return response("no_result", language, message, {
        intent: "meal_plan_selection",
        stage: "over_total_ceiling",
        ceilingMode: state.ceilingMode,
        ceilingKcal: state.ceilingKcal,
        totalCaloriesKcal: total,
        excessCaloriesKcal: excess,
        pendingOperationId: null,
        selections: frozen.map((selection) => this.selectionPayload(selection, state.includeSodium)),
        conversationContext: this.contextOf({ ...state, phase: "awaiting_selection", pendingOperationId: null }),
      });
    }

    // The pending operation is created HERE, at summary-display time, and its id
    // is the idempotency key for every later send attempt.
    const operation = this.dependencies.pendingOperations.create({
      selections: frozen,
      totalCaloriesKcal: total,
      ceilingMode: state.ceilingMode,
      ceilingKcal: state.ceilingKcal,
      language,
    });
    const next: MealSelectionState = { ...state, phase: "awaiting_confirmation", pendingOperationId: operation.pendingOperationId };
    const message = [
      language === "en" ? "Summary before anything is logged:" : "ملخص اختيارك قبل أي تسجيل:",
      this.renderSelectionLines(frozen, language, state.includeSodium),
      language === "en" ? `Total: ${total} kcal.` : `الإجمالي: ${total} سعر حراري.`,
      this.renderCeilingLine(state.ceilingMode, state.ceilingKcal, language),
      language === "en"
        ? `Operation id: ${operation.pendingOperationId} (valid for ${PENDING_MEAL_CONFIRMATION_TTL_SECONDS / 60} minutes).`
        : `رقم العملية: ${operation.pendingOperationId} (صالح ${PENDING_MEAL_CONFIRMATION_TTL_SECONDS / 60} دقيقة).`,
      language === "en"
        ? "Confirm? Reply “confirm” for this operation and I will log it. Nothing is logged until you do."
        : "تأكيد؟ اكتب «تأكيد» للعملية دي وأنا أسجّلها. مفيش حاجة تتسجل قبل كده.",
      this.exclusionNote(state.excludedIngredientKeys, language),
    ].filter((line) => line !== "").join("\n\n");
    return response("ok", language, message, {
      intent: "meal_plan_selection",
      stage: "confirmation_summary",
      ceilingMode: state.ceilingMode,
      ceilingKcal: state.ceilingKcal,
      totalCaloriesKcal: total,
      pendingOperationId: operation.pendingOperationId,
      pendingOperationTtlSeconds: PENDING_MEAL_CONFIRMATION_TTL_SECONDS,
      idempotencyKey: operation.pendingOperationId,
      selections: frozen.map((selection) => this.selectionPayload(selection, state.includeSodium)),
      safetyDisclaimer: state.excludedIngredientKeys.length === 0 ? null : this.exclusionDisclaimer(state.excludedIngredientKeys, language),
      conversationContext: this.contextOf(next),
    }, [], [], frozen.flatMap((selection) => selection.recipes.map((recipe) => `DEMO-${recipe.recipeId}`)));
  }

  private renderSelectionLines(selections: readonly FrozenMealSelection[], language: Language, includeSodium: boolean): string {
    return selections.map((selection) => {
      const body = selection.recipes.map((recipe) => this.renderNutritionLine(recipe.name, recipe.nutrition, language, includeSodium)).join(language === "en" ? "\n    + " : "\n    + ");
      const subtotal = selection.recipes.length > 1
        ? language === "en" ? ` (subtotal ${selection.subtotalCaloriesKcal} kcal)` : ` (إجمالي القسم ${selection.subtotalCaloriesKcal} سعر حراري)`
        : "";
      return `• ${label(selection.mealCategory, language)} — ${body}${subtotal}`;
    }).join("\n");
  }

  private selectionPayload(selection: FrozenMealSelection, includeSodium: boolean): Record<string, unknown> {
    return {
      mealCategory: selection.mealCategory,
      optionIndex: selection.optionIndex,
      subtotalCaloriesKcal: selection.subtotalCaloriesKcal,
      recipes: selection.recipes.map((recipe) => ({
        recipeId: recipe.recipeId,
        name: recipe.name,
        caloriesKcal: recipe.nutrition.caloriesKcal,
        proteinG: recipe.nutrition.proteinG,
        carbsG: recipe.nutrition.carbsG,
        fatG: recipe.nutrition.fatG,
        ...(includeSodium ? { sodiumMg: recipe.nutrition.sodiumMg } : {}),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Confirmation
  // -------------------------------------------------------------------------

  private async confirm(state: MealSelectionState, language: Language): Promise<ExpandedAgentResponse> {
    const pendingOperationId = state.pendingOperationId;
    if (!pendingOperationId) return this.confirmationExpired(null, "unknown", language);
    const result = await this.dependencies.tools.confirmAndLogMealSelection({ pendingOperationId });
    if (!result.ok) {
      return response("no_result", language, language === "en"
        ? "I could not submit that confirmation, so nothing was logged."
        : "ما قدرتش أبعت التأكيد، فمفيش حاجة اتسجلت.", {
        intent: "meal_plan_selection",
        stage: "failed",
        reasonCode: result.errors[0]?.code ?? "unknown",
        pendingOperationId,
        conversationContext: this.contextOf(state),
      }, [{ tool: "confirm_and_log_meal_selection", ok: false, code: result.errors[0]?.code ?? "unknown" }]);
    }
    const outcome = result.data;
    const usesMockDashboard = (this.dependencies.tools.implementationId ?? "").startsWith("MOCK-");
    const dashboardNotice = usesMockDashboard
      ? language === "en"
        ? "Note: the dashboard link is a local deterministic mock. No request left this process and no real account was changed."
        : "ملاحظة: الربط بالداشبورد mock محلي حتمي. مفيش أي طلب خرج من العملية دي ومفيش حساب حقيقي اتغير."
      : language === "en"
        ? "The meal was submitted to the real dashboard endpoint."
        : "الوجبة اتبعتت فعليًا إلى endpoint تسجيل الوجبات في الداشبورد.";
    const dashboardImplementation = usesMockDashboard ? "mock" : "http";

    if (outcome.outcome === "confirmation_expired") {
      return this.confirmationExpired(pendingOperationId, outcome.reason, language);
    }
    if (outcome.outcome === "dashboard_error") {
      const reason = this.errorReason(outcome.response.error_code, language);
      const message = [
        language === "en" ? "Nothing was added." : "ما اتسجلش أي حاجة.",
        language === "en" ? `Reason: ${reason}` : `السبب: ${reason}`,
        language === "en"
          ? `The same operation id ${pendingOperationId} is still the key, so retrying cannot double-count anything.`
          : `نفس رقم العملية ${pendingOperationId} لسه هو المفتاح، فإعادة المحاولة ما تقدرش تخصم مرتين.`,
        dashboardNotice,
      ].join("\n\n");
      return response("no_result", language, message, {
        intent: "meal_plan_selection",
        stage: "failed",
        applied: false,
        errorCode: outcome.response.error_code,
        pendingOperationId,
        idempotencyKey: pendingOperationId,
        dashboardImplementation,
        conversationContext: this.contextOf(state),
      }, [{ tool: "confirm_and_log_meal_selection", ok: false, code: outcome.response.error_code }]);
    }
    if (outcome.outcome === "already_logged") {
      const remaining = outcome.response.daily_calories_remaining;
      const message = [
        language === "en"
          ? "This exact operation was already logged, so I did not deduct anything again."
          : "العملية دي كانت مسجلة قبل كده بنفس رقم العملية، فما حصلش أي خصم جديد.",
        ...(remaining === null ? [] : [language === "en"
          ? `Remaining daily calories: ${remaining} kcal.`
          : `المتبقي من سعرات اليوم: ${remaining} سعر حراري.`]),
        dashboardNotice,
      ].join("\n\n");
      return response("ok", language, message, {
        intent: "meal_plan_selection",
        stage: "already_logged",
        applied: false,
        reason: outcome.response.reason,
        dailyCaloriesRemaining: outcome.response.daily_calories_remaining,
        pendingOperationId,
        idempotencyKey: pendingOperationId,
        dashboardImplementation,
        conversationContext: this.contextOf({ ...state, phase: "completed" }),
      }, [{ tool: "confirm_and_log_meal_selection", ok: true, code: "already_logged" }]);
    }

    const message = [
      language === "en" ? "Logged. Here is exactly what was recorded:" : "تم التسجيل. ده بالظبط اللي اتسجل:",
      this.renderSelectionLines(outcome.selections, language, state.includeSodium),
      language === "en" ? `Total logged: ${outcome.loggedCaloriesKcal} kcal.` : `إجمالي المسجّل: ${outcome.loggedCaloriesKcal} سعر حراري.`,
      ...(outcome.response.daily_calories_remaining === null ? [] : [language === "en"
        ? `Remaining daily calories: ${outcome.response.daily_calories_remaining} kcal.`
        : `المتبقي من سعرات اليوم: ${outcome.response.daily_calories_remaining} سعر حراري.`]),
      dashboardNotice,
    ].join("\n\n");
    return response("ok", language, message, {
      intent: "meal_plan_selection",
      stage: "logged",
      applied: true,
      totalCaloriesKcal: outcome.loggedCaloriesKcal,
      dailyCaloriesRemaining: outcome.response.daily_calories_remaining,
      loggedSelectionIds: outcome.response.logged_selection_ids,
      pendingOperationId,
      idempotencyKey: pendingOperationId,
      dashboardImplementation,
      selections: outcome.selections.map((selection) => this.selectionPayload(selection, state.includeSodium)),
      conversationContext: this.contextOf({ ...state, phase: "completed" }),
    }, [{ tool: "confirm_and_log_meal_selection", ok: true, code: null }]);
  }

  private confirmationExpired(
    pendingOperationId: string | null,
    reason: "unknown" | "expired" | "invalidated" | "resolved",
    language: Language,
  ): ExpandedAgentResponse {
    const explanation = language === "en"
      ? reason === "expired"
        ? `the ${PENDING_MEAL_CONFIRMATION_TTL_SECONDS / 60}-minute confirmation window had already passed`
        : reason === "invalidated" ? "the selection changed after that summary was shown"
          : reason === "resolved" ? "that operation was already resolved" : "there is no pending operation to confirm"
      : reason === "expired"
        ? `مهلة التأكيد (${PENDING_MEAL_CONFIRMATION_TTL_SECONDS / 60} دقيقة) كانت خلصت`
        : reason === "invalidated" ? "الاختيار اتغير بعد ما الملخص اتعرض"
          : reason === "resolved" ? "العملية دي كانت اتحسمت خلاص" : "مفيش عملية معلّقة أأكدها";
    const message = language === "en"
      ? `confirmation_expired — ${explanation}, so nothing was logged. Ask for the plan again and I will show a fresh summary with a new operation id.`
      : `confirmation_expired — ${explanation}، فمفيش حاجة اتسجلت. اطلب الخطة تاني وأنا أعرض ملخص جديد برقم عملية جديد.`;
    return response("no_result", language, message, {
      intent: "meal_plan_selection",
      stage: "confirmation_expired",
      applied: false,
      errorCode: "confirmation_expired",
      reasonCode: reason,
      pendingOperationId,
    }, [{ tool: "confirm_and_log_meal_selection", ok: false, code: "confirmation_expired" }]);
  }

  private confirmationIntentUnclear(state: MealSelectionState, language: Language): ExpandedAgentResponse {
    const message = language === "en"
      ? "I am not sure whether that is a confirmation. Reply “confirm” to log the summary exactly as shown, or tell me what to change. Nothing was logged."
      : "مش متأكد لو ده تأكيد ولا لأ. اكتب «تأكيد» علشان أسجّل الملخص زي ما هو، أو قولي عايز تغيّر إيه. مفيش حاجة اتسجلت.";
    return response("clarification", language, message, {
      intent: "meal_plan_selection",
      stage: "confirmation_intent_unclear",
      pendingOperationId: state.pendingOperationId,
      conversationContext: this.contextOf(state),
    });
  }

  private cancel(state: MealSelectionState, language: Language): ExpandedAgentResponse {
    this.dependencies.pendingOperations.invalidate(state.pendingOperationId);
    const message = language === "en"
      ? "Cancelled. Nothing was logged and the pending operation is no longer valid."
      : "تم الإلغاء. مفيش حاجة اتسجلت والعملية المعلّقة بقت غير صالحة.";
    return response("ok", language, message, {
      intent: "meal_plan_selection",
      stage: "cancelled",
      applied: false,
      pendingOperationId: state.pendingOperationId,
      conversationContext: this.contextOf({ ...state, phase: "completed", pendingOperationId: null }),
    });
  }

  private errorReason(code: string, language: Language): string {
    const reasons: Record<string, { ar: string; en: string }> = {
      invalid_token: { ar: "التوثيق مع الداشبورد مرفوض، فما وصلناش لحسابك.", en: "the dashboard rejected the credentials, so your account was never reached." },
      recipe_not_found: { ar: "الداشبورد مش عارف واحدة من الوصفات المختارة.", en: "the dashboard does not recognise one of the selected recipes." },
      rate_limited: { ar: "عدد الطلبات كبير، جرّب تأكيد تاني بعد شوية.", en: "too many requests; confirm again in a moment." },
      server_error: { ar: "عطل في الداشبورد نفسه.", en: "the dashboard itself failed." },
      insufficient_calories: { ar: "رصيد سعرات اليوم مش كفاية للاختيار ده.", en: "your remaining daily calorie balance is not enough for this selection." },
      validation_failed: { ar: "الداشبورد رفض شكل البيانات المرسلة.", en: "the dashboard rejected the shape of the submitted data." },
      confirmation_expired: { ar: "صلاحية التأكيد خلصت أو الخطة اتغيرت.", en: "the confirmation expired or the plan changed." },
    };
    const entry = reasons[code];
    if (!entry) return language === "en" ? `an unexpected dashboard error (${code}).` : `خطأ غير متوقع من الداشبورد (${code}).`;
    return language === "en" ? entry.en : entry.ar;
  }

  private contextOf(state: MealSelectionState): MealSelectionContextEnvelope {
    return { schemaVersion: "1.0", lastIntent: "meal_selection", selection: state };
  }
}
