import { createHash } from "node:crypto";
import type {
  DashboardClient,
  DashboardErrorCode,
  DashboardResponse,
  LogMealSelectionsRequest,
  MealCategory,
} from "./dashboard-client.js";
import type {
  CreateCustomMealRequest,
  GraduationBackendDataSource,
} from "../../runtime/graduation-backend-client.js";

export interface CustomMealRecipeIdentity {
  nameAr: string;
  nameEn: string;
}

export interface NutriGuardCustomMealDashboardClientOptions {
  backend: GraduationBackendDataSource;
  resolveRecipe(recipeId: string): CustomMealRecipeIdentity | null;
  language?: "ar-EG" | "ar" | "en";
  timeZone?: string;
}

interface AppliedOperation {
  requestHash: string;
  dailyCaloriesRemaining: number | null;
  loggedSelectionIds: string[];
}

interface InFlightOperation {
  requestHash: string;
  promise: Promise<DashboardResponse>;
}

/**
 * Graduation integration for the Backend's custom-meal API.
 *
 * The real Backend path uses one atomic batch request and forwards the Step 16
 * pending-operation ID as its durable idempotency key. The single-record path
 * remains only as a compatibility fallback for injected legacy data sources.
 */
export class NutriGuardCustomMealDashboardClient implements DashboardClient {
  private readonly applied = new Map<string, AppliedOperation>();
  private readonly inFlight = new Map<string, InFlightOperation>();
  private readonly backend: GraduationBackendDataSource;
  private readonly resolveRecipe: NutriGuardCustomMealDashboardClientOptions["resolveRecipe"];
  private readonly language: "ar-EG" | "ar" | "en";
  private readonly timeZone: string;

  public constructor(options: NutriGuardCustomMealDashboardClientOptions) {
    this.backend = options.backend;
    this.resolveRecipe = options.resolveRecipe;
    this.language = options.language ?? "ar-EG";
    this.timeZone = options.timeZone ?? "Africa/Cairo";
    if (!this.backend.createCustomMealBatch && (!this.backend.createCustomMeal || !this.backend.deleteCustomMeal)) {
      throw new Error("Backend data source does not implement custom-meal tracking");
    }
  }

  public async logMealSelections(request: LogMealSelectionsRequest): Promise<DashboardResponse> {
    const requestHash = hashRequest(request);
    if (!this.backend.createCustomMealBatch) {
      const prior = this.applied.get(request.idempotency_key);
      if (prior) {
        if (prior.requestHash !== requestHash) return error("idempotency_conflict", "The idempotency key was reused with different selections.");
        return { status: "success", applied: false, reason: "already_logged", daily_calories_remaining: prior.dailyCaloriesRemaining };
      }
    }
    const pending = this.inFlight.get(request.idempotency_key);
    if (pending) {
      if (pending.requestHash !== requestHash) {
        return error("idempotency_conflict", "The idempotency key is already being used for different selections.");
      }
      const response = await pending.promise;
      return response.status === "success" && response.applied
        ? { status: "success", applied: false, reason: "already_logged", daily_calories_remaining: response.daily_calories_remaining }
        : response;
    }
    const operation = this.apply(request, requestHash).finally(() => this.inFlight.delete(request.idempotency_key));
    this.inFlight.set(request.idempotency_key, { requestHash, promise: operation });
    return operation;
  }

  private async apply(request: LogMealSelectionsRequest, requestHash: string): Promise<DashboardResponse> {
    if (request.selections.length === 0) return error("validation_failed", "At least one meal selection is required.");
    let payloads: CreateCustomMealRequest[];
    try {
      payloads = request.selections.map((selection) => {
        const recipe = this.resolveRecipe(selection.recipe_id);
        if (!recipe) throw Object.assign(new Error(`Unknown verified recipe: ${selection.recipe_id}`), { code: "recipe_not_found" });
        return {
          name: this.language === "en" ? recipe.nameEn : recipe.nameAr,
          externalReferenceId: selection.recipe_id,
          source: "AI",
          mealType: backendMealType(selection.meal_category),
          date: dateInTimeZone(selection.timestamp, this.timeZone),
          servings: selection.serving_fraction ?? 1,
          energyKcal: selection.nutrition_snapshot.calories,
          proteinG: selection.nutrition_snapshot.protein_g,
          carbohydrateG: selection.nutrition_snapshot.carbs_g,
          fatG: selection.nutrition_snapshot.fat_g,
        };
      });
    } catch (cause) {
      return mapError(cause);
    }
    return this.backend.createCustomMealBatch
      ? this.applyBatch(request, payloads)
      : this.applyLegacy(request, requestHash, payloads);
  }

  private async applyBatch(
    request: LogMealSelectionsRequest,
    payloads: readonly CreateCustomMealRequest[],
  ): Promise<DashboardResponse> {
    try {
      const result = await this.backend.createCustomMealBatch!(request.idempotency_key, payloads);
      if (!result.applied) {
        return result.reason === "already_logged"
          ? { status: "success", applied: false, reason: "already_logged", daily_calories_remaining: result.dailyCaloriesRemaining }
          : error("server_error", "The Backend returned a non-applied batch without an idempotent replay reason.");
      }
      if (result.loggedSelectionIds.length !== payloads.length) {
        return error("server_error", "The Backend batch response did not identify every logged selection.");
      }
      return {
        status: "success",
        applied: true,
        daily_calories_remaining: result.dailyCaloriesRemaining,
        logged_selection_ids: result.loggedSelectionIds.map(String),
      };
    } catch (cause) {
      return mapError(cause);
    }
  }

  private async applyLegacy(
    request: LogMealSelectionsRequest,
    requestHash: string,
    payloads: readonly CreateCustomMealRequest[],
  ): Promise<DashboardResponse> {
    const createdIds: number[] = [];
    try {
      for (const payload of payloads) {
        const created = await this.backend.createCustomMeal!(payload);
        createdIds.push(created.id);
      }
      const dailyCaloriesRemaining = await this.readRemainingCalories(dateInTimeZone(request.selections[0]!.timestamp, this.timeZone));
      const applied: AppliedOperation = { requestHash, dailyCaloriesRemaining, loggedSelectionIds: createdIds.map(String) };
      this.applied.set(request.idempotency_key, applied);
      return { status: "success", applied: true, daily_calories_remaining: dailyCaloriesRemaining, logged_selection_ids: applied.loggedSelectionIds };
    } catch (cause) {
      const rollbackSucceeded = await this.rollback(createdIds);
      if (!rollbackSucceeded) return error("server_error", "Custom-meal logging failed and compensating rollback was incomplete.");
      return mapError(cause);
    }
  }

  private async rollback(ids: readonly number[]): Promise<boolean> {
    const results = await Promise.allSettled([...ids].reverse().map((id) => this.backend.deleteCustomMeal!(id)));
    return results.every((result) => result.status === "fulfilled");
  }

  private async readRemainingCalories(date: string): Promise<number | null> {
    if (!this.backend.getNutritionTargets || !this.backend.getDailySummary) return null;
    try {
      const [targets, summary] = await Promise.all([this.backend.getNutritionTargets(), this.backend.getDailySummary(date)]);
      const target = findNumber(targets, ["energyKcal", "calories", "dailyCalories", "calorieTarget"]);
      const consumed = findNumber(summary, ["energyKcal", "totalCalories", "calories", "consumedCalories"]);
      return target === null || consumed === null ? null : Math.max(0, Math.round((target - consumed) * 10) / 10);
    } catch {
      return null;
    }
  }
}

function backendMealType(category: MealCategory): "Breakfast" | "Lunch" | "Dinner" {
  return category === "breakfast" ? "Breakfast" : category === "lunch" ? "Lunch" : "Dinner";
}

function dateInTimeZone(timestamp: string, timeZone: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw Object.assign(new Error("Invalid meal timestamp"), { code: "validation_failed" });
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function hashRequest(request: LogMealSelectionsRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function findNumber(value: unknown, keys: readonly string[]): number | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  for (const key of ["data", "targets", "nutritionTargets", "summary", "totals"]) {
    const nested = findNumber(record[key], keys);
    if (nested !== null) return nested;
  }
  return null;
}

function error(errorCode: DashboardErrorCode, message: string): DashboardResponse {
  return { status: "error", error_code: errorCode, message };
}

function mapError(cause: unknown): DashboardResponse {
  const record = typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : {};
  const status = typeof record.status === "number" ? record.status : null;
  const explicit = typeof record.code === "string" ? record.code : null;
  if (explicit === "recipe_not_found") return error("recipe_not_found", "The selected verified recipe is unavailable.");
  if (explicit === "invalid_token" || status === 401 || status === 403) return error("invalid_token", "Backend authentication failed.");
  if (status === 429) return error("rate_limited", "The Backend rate limit was reached.");
  if (status === 409) return error("idempotency_conflict", "The Backend rejected reuse of the idempotency key with different selections.");
  if (status === 400 || status === 422) return error("validation_failed", "The Backend rejected the custom-meal request.");
  return error("server_error", "The Backend could not log the custom meal.");
}
