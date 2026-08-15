export type MealCategory = "breakfast" | "lunch" | "dinner";

export interface NutritionSnapshot {
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  sodium_mg?: number;
}

export interface DashboardMealSelection {
  recipe_id: string;
  meal_category: MealCategory;
  nutrition_snapshot: NutritionSnapshot;
  /** Displayed cooked portion. The current Backend persists the equivalent serving fraction. */
  portion_grams?: number;
  serving_fraction?: number;
  timestamp: string;
}

export interface LogMealSelectionsRequest {
  idempotency_key: string;
  selections: DashboardMealSelection[];
}

export interface DashboardSuccessResponse {
  status: "success";
  applied: true;
  daily_calories_remaining: number | null;
  logged_selection_ids: string[];
}

export interface DashboardReplayResponse {
  status: "success";
  applied: false;
  reason: "already_logged";
  daily_calories_remaining: number | null;
}

export type DashboardErrorCode =
  | "invalid_token"
  | "recipe_not_found"
  | "rate_limited"
  | "server_error"
  | "insufficient_calories"
  | "idempotency_conflict"
  | "validation_failed"
  | "confirmation_expired";

export interface DashboardErrorResponse {
  status: "error";
  error_code: DashboardErrorCode;
  message: string;
}

export type DashboardResponse = DashboardSuccessResponse | DashboardReplayResponse | DashboardErrorResponse;

/** Port implemented by the deterministic mock and the graduation Backend adapter. */
export interface DashboardClient {
  logMealSelections(request: LogMealSelectionsRequest): Promise<DashboardResponse>;
}
