import type {
  DashboardClient,
  DashboardErrorResponse,
  DashboardIdempotentReplayResponse,
  DashboardLogMealsRequest,
  DashboardLogMealsResponse,
  DashboardMealCategory,
  DashboardSelectionPayload,
  DashboardSuccessResponse,
} from "../services/dashboard/dashboard-client.js";
import type {
  FrozenMealNutrition,
  FrozenMealSelection,
  PendingMealOperationStore,
} from "../services/dashboard/pending-meal-operations.js";
import type { ToolResult } from "./nutriguard-tools.js";

export const MEAL_SELECTION_TOOL_NAMES = [
  "search_recipes_by_meal_category",
  "confirm_and_log_meal_selection",
] as const;

export type MealSelectionToolName = (typeof MEAL_SELECTION_TOOL_NAMES)[number];

/** How many options one category may offer. Never padded to reach this number. */
export const MEAL_CATEGORY_OPTION_LIMIT = 3;

/**
 * Total send attempts for one confirmed batch, including the first.
 *
 * Every attempt reuses the same `pending_operation_id` as the idempotency key, so
 * a retry can never produce a second logical write. This is the contract's actual
 * guarantee: "call exactly once" is not achievable, "retry only ever with the same
 * key, applied at most once" is.
 */
export const MEAL_SELECTION_MAX_SEND_ATTEMPTS = 2;

/**
 * Error codes worth an automatic retry with the same key.
 *
 * Deliberately excludes `invalid_token`, `validation_failed`,
 * `insufficient_calories`, `recipe_not_found` and `confirmation_expired`: those
 * are decisions, not transient faults, and retrying them only wastes a call.
 */
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set(["server_error", "rate_limited"]);

export interface MealCategoryProvenance {
  sourceId: string;
  versionId: string;
  title: string | null;
  url: string | null;
  accessedAt: string | null;
  locator: string | null;
}

/**
 * One candidate recipe as supplied by the recipe source.
 *
 * `verificationStatus` is carried explicitly instead of being assumed: the tool
 * re-filters on it, so a source that ever starts leaking unverified rows cannot
 * put them in front of a user.
 */
export interface MealCategoryRecipeRecord {
  recipeId: string;
  name: string;
  datasetCategory: string;
  verificationStatus: string;
  ingredientKeys: readonly string[];
  nutrition: FrozenMealNutrition;
  provenance: MealCategoryProvenance;
}

export interface MealCategoryRecipeSource {
  listByMealCategory(category: DashboardMealCategory): readonly MealCategoryRecipeRecord[];
}

export interface SearchRecipesByMealCategoryInput {
  category: DashboardMealCategory;
  calorieCeilingKcal?: number | null;
  exclusions?: readonly string[];
}

export interface MealCategoryOptionRecipe {
  recipeId: string;
  name: string;
  nutrition: FrozenMealNutrition;
}

/**
 * One selectable option.
 *
 * For breakfast, lunch and dinner an option always holds exactly one recipe. For
 * snacks an option may hold two light snacks as an explicitly offered set, which
 * the user still has to select and confirm exactly like any other option.
 */
export interface MealCategoryOption {
  optionIndex: number;
  recipes: MealCategoryOptionRecipe[];
  subtotalCaloriesKcal: number;
  isSnackSet: boolean;
}

export interface MealCategorySearchOutput {
  mealCategory: DashboardMealCategory;
  /** `complete` = 3 verified matches, `partial` = 1–2, `empty` = 0. */
  status: "complete" | "partial" | "empty";
  optionLimit: number;
  /** Real count of verified recipes satisfying every constraint. Never inflated. */
  verifiedMatchCount: number;
  options: MealCategoryOption[];
  calorieCeilingKcal: number | null;
  excludedIngredientKeys: string[];
}

export type ConfirmAndLogOutcome =
  | { outcome: "logged"; pendingOperationId: string; response: DashboardSuccessResponse; loggedCaloriesKcal: number; selections: readonly FrozenMealSelection[] }
  | { outcome: "already_logged"; pendingOperationId: string; response: DashboardIdempotentReplayResponse; selections: readonly FrozenMealSelection[] }
  | { outcome: "dashboard_error"; pendingOperationId: string; response: DashboardErrorResponse; selections: readonly FrozenMealSelection[] }
  | { outcome: "confirmation_expired"; pendingOperationId: string; reason: "unknown" | "expired" | "invalidated" | "resolved" };

export interface MealSelectionToolset {
  searchRecipesByMealCategory(input: SearchRecipesByMealCategoryInput): Promise<ToolResult<MealCategorySearchOutput>>;
  confirmAndLogMealSelection(input: { pendingOperationId: string }): Promise<ToolResult<ConfirmAndLogOutcome>>;
}

export interface MealSelectionToolDependencies {
  recipes: MealCategoryRecipeSource;
  dashboard: DashboardClient;
  pendingOperations: PendingMealOperationStore;
  now?: () => Date;
}

function failure<T>(code: string, message: string): ToolResult<T> {
  return { ok: false, data: null, errors: [{ code, message }], provenance: [] };
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/**
 * The two Step 16 tools.
 *
 * `search_recipes_by_meal_category` is read-only. `confirm_and_log_meal_selection`
 * is the ONLY code path in the project allowed to reach a dashboard client, and it
 * builds its payload exclusively from the server-side frozen snapshot identified
 * by `pending_operation_id`. No caller — and in particular no language model —
 * can hand it selections or nutrition numbers.
 */
export class MealSelectionTools implements MealSelectionToolset {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: MealSelectionToolDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async searchRecipesByMealCategory(input: SearchRecipesByMealCategoryInput): Promise<ToolResult<MealCategorySearchOutput>> {
    const ceiling = input.calorieCeilingKcal ?? null;
    if (ceiling !== null && (!Number.isFinite(ceiling) || ceiling <= 0)) {
      return failure("invalid_calorie_ceiling", "calorieCeilingKcal must be a positive number when supplied");
    }
    const exclusions = new Set(input.exclusions ?? []);
    const matching = this.dependencies.recipes.listByMealCategory(input.category)
      // Verified-only gate, re-applied here rather than trusted from the source.
      .filter((record) => record.verificationStatus === "verified")
      .filter((record) => !record.ingredientKeys.some((key) => exclusions.has(key)))
      .filter((record) => Number.isFinite(record.nutrition.caloriesKcal))
      .filter((record) => ceiling === null || record.nutrition.caloriesKcal <= ceiling);

    // Deterministic ordering. Snacks are ordered lightest-first because a snack
    // should stay small; the three main meals are ordered closest-below-ceiling so
    // a stated ceiling is used rather than undershot, and by calories ascending
    // when no ceiling was given. `recipeId` is the final tie-break in both cases,
    // so repeated identical requests are byte-identical.
    const ordered = [...matching].sort((left, right) => {
      if (input.category !== "snacks" && ceiling !== null) {
        const leftGap = ceiling - left.nutrition.caloriesKcal;
        const rightGap = ceiling - right.nutrition.caloriesKcal;
        if (leftGap !== rightGap) return leftGap - rightGap;
      } else if (left.nutrition.caloriesKcal !== right.nutrition.caloriesKcal) {
        return left.nutrition.caloriesKcal - right.nutrition.caloriesKcal;
      }
      return left.recipeId.localeCompare(right.recipeId);
    });

    const singles = ordered.slice(0, MEAL_CATEGORY_OPTION_LIMIT);
    const options: MealCategoryOption[] = singles.map((record, index) => ({
      optionIndex: index + 1,
      recipes: [{ recipeId: record.recipeId, name: record.name, nutrition: record.nutrition }],
      subtotalCaloriesKcal: round(record.nutrition.caloriesKcal),
      isSnackSet: false,
    }));

    // Snacks-only: offer one explicit two-item set when a ceiling is known and the
    // two lightest verified snacks fit under it together. Both items are real
    // verified recipes already shown as single options above, so nothing is
    // fabricated; the set simply says "you can have both". It occupies the last of
    // the three slots, so the total number of distinct recipes shown stays within
    // the three-recipe limit, and it must still be selected and confirmed exactly
    // like any other option.
    if (input.category === "snacks" && ceiling !== null && ordered.length >= 2) {
      const [first, second] = ordered;
      if (first && second) {
        const pairCalories = round(first.nutrition.caloriesKcal + second.nutrition.caloriesKcal);
        if (pairCalories <= ceiling) {
          const setOption: MealCategoryOption = {
            optionIndex: 0,
            recipes: [first, second].map((record) => ({ recipeId: record.recipeId, name: record.name, nutrition: record.nutrition })),
            subtotalCaloriesKcal: pairCalories,
            isSnackSet: true,
          };
          const trimmed = options.slice(0, MEAL_CATEGORY_OPTION_LIMIT - 1);
          trimmed.push(setOption);
          options.length = 0;
          options.push(...trimmed.map((option, index) => ({ ...option, optionIndex: index + 1 })));
        }
      }
    }

    const verifiedMatchCount = matching.length;
    return {
      ok: true,
      data: {
        mealCategory: input.category,
        status: verifiedMatchCount === 0 ? "empty" : verifiedMatchCount >= MEAL_CATEGORY_OPTION_LIMIT ? "complete" : "partial",
        optionLimit: MEAL_CATEGORY_OPTION_LIMIT,
        verifiedMatchCount,
        options,
        calorieCeilingKcal: ceiling,
        excludedIngredientKeys: [...exclusions],
      },
      errors: [],
      provenance: singles.map((record) => record.provenance),
    };
  }

  /**
   * Confirm-and-log, using ONLY `pendingOperationId`.
   *
   * The v3 correction removed the older `selections[]` parameter because it made
   * it structurally possible to submit values other than the ones the user
   * confirmed. Everything sent to the dashboard below is read from the frozen
   * server-side snapshot.
   *
   * `ok: true` is returned for every fully determined outcome, including a
   * dashboard error and an expired confirmation, because those are legitimate
   * results of a correct call rather than tool failures. The caller decides how to
   * report them and records the tool trace accordingly. `ok: false` is reserved
   * for a malformed call.
   */
  public async confirmAndLogMealSelection(input: { pendingOperationId: string }): Promise<ToolResult<ConfirmAndLogOutcome>> {
    const pendingOperationId = typeof input?.pendingOperationId === "string" ? input.pendingOperationId.trim() : "";
    if (pendingOperationId === "") return failure("invalid_pending_operation_id", "pendingOperationId is required");
    const operation = this.dependencies.pendingOperations.peek(pendingOperationId);
    if (!operation || operation.status !== "active") {
      const reason = !operation ? "unknown" : operation.status === "expired" ? "expired" : operation.status === "resolved" ? "resolved" : "invalidated";
      return {
        ok: true,
        data: { outcome: "confirmation_expired", pendingOperationId, reason },
        errors: [],
        provenance: [],
      };
    }

    const timestamp = this.now().toISOString();
    const selections: DashboardSelectionPayload[] = operation.selections.flatMap((selection) => selection.recipes.map((recipe) => ({
      recipe_id: recipe.recipeId,
      meal_category: selection.mealCategory as DashboardMealCategory,
      // Only the four contract fields are sent. Sodium is shown to the user when
      // asked for but is not part of the agreed snapshot, so it is not invented
      // into the payload.
      nutrition_snapshot: {
        calories: recipe.nutrition.caloriesKcal,
        protein_g: recipe.nutrition.proteinG,
        fat_g: recipe.nutrition.fatG,
        carbs_g: recipe.nutrition.carbsG,
      },
      timestamp,
    })));

    const response = await this.send({ idempotency_key: operation.pendingOperationId, selections });

    if (response.status === "error") {
      // Nothing was applied, so the operation stays active and the very same key
      // can be retried. Marking it resolved here would turn a failed write into a
      // false `already_logged` on the next attempt.
      return { ok: true, data: { outcome: "dashboard_error", pendingOperationId, response, selections: operation.selections }, errors: [], provenance: [] };
    }
    this.dependencies.pendingOperations.resolve(pendingOperationId);
    if (response.applied) {
      return {
        ok: true,
        data: {
          outcome: "logged",
          pendingOperationId,
          response,
          loggedCaloriesKcal: operation.totalCaloriesKcal,
          selections: operation.selections,
        },
        errors: [],
        provenance: [],
      };
    }
    return { ok: true, data: { outcome: "already_logged", pendingOperationId, response, selections: operation.selections }, errors: [], provenance: [] };
  }

  /**
   * Send the batch, retrying transient faults with the SAME idempotency key.
   *
   * The retry loop is the reason the key is generated at summary time rather than
   * per send attempt: a thrown transport error (a timeout in a real HTTP client)
   * or a retryable status leaves the caller unable to tell whether the write
   * landed, and the only safe response is to resend the identical key and let the
   * server decide. The dashboard is then responsible for applying it at most once.
   *
   * Whether a real backend can always answer that question truthfully — the case
   * where the write committed and only the response was lost — is item 7 in
   * `NutriGuard_Open_Questions_Backend_Privacy.md` and is NOT resolved here.
   */
  private async send(request: DashboardLogMealsRequest): Promise<DashboardLogMealsResponse> {
    let lastError: DashboardErrorResponse = { status: "error", error_code: "server_error", message: "the dashboard client did not return a response" };
    for (let attempt = 1; attempt <= MEAL_SELECTION_MAX_SEND_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.dependencies.dashboard.logMealSelections(request);
        if (response.status !== "error" || !RETRYABLE_ERROR_CODES.has(response.error_code)) return response;
        lastError = response;
      } catch (error) {
        lastError = { status: "error", error_code: "server_error", message: error instanceof Error ? error.message : String(error) };
      }
    }
    return lastError;
  }
}

export const MEAL_SELECTION_TOOL_DEFINITIONS = [
  {
    name: "search_recipes_by_meal_category",
    description: "Return up to three verified Egyptian recipe options for one meal category, honouring an optional calorie ceiling and ingredient exclusions. Reports the real match count and never pads the list.",
  },
  {
    name: "confirm_and_log_meal_selection",
    description: "Send a user-confirmed meal selection to the dashboard client using only a pending_operation_id. Loads the frozen selections server-side and is the only tool permitted to reach the dashboard.",
  },
] as const;
