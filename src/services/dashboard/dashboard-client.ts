/**
 * Step 16 — Dashboard integration port.
 *
 * The local mock and the opt-in HTTP implementation both satisfy this port.
 * `HttpDashboardClient` maps the internal selection snapshot to the backend's
 * `CreateCustomMealLogRequestDto` and calls `/api/Tracking/custom-meals`.
 * Authentication and per-user routing still depend on the backend token flow.
 */

/** Meal categories the dashboard accepts for a logged selection. */
export const DASHBOARD_MEAL_CATEGORIES = ["breakfast", "lunch", "dinner", "snacks"] as const;

export type DashboardMealCategory = (typeof DASHBOARD_MEAL_CATEGORIES)[number];

/**
 * Error codes from section 2 of the contract.
 *
 * `insufficient_calories`, `validation_failed` and `confirmation_expired` were
 * added by the contract's v2 correction.
 */
export const DASHBOARD_ERROR_CODES = [
  "invalid_token",
  "recipe_not_found",
  "rate_limited",
  "server_error",
  "insufficient_calories",
  "validation_failed",
  "confirmation_expired",
] as const;

export type DashboardErrorCode = (typeof DASHBOARD_ERROR_CODES)[number];

/**
 * The exact nutrition snapshot field names the contract specifies. The AI sends
 * these values, but the contract's open question 2 records that the backend has
 * NOT yet decided whether it trusts them, re-validates them against its own
 * `recipe_id`, or re-derives them and ignores what it received. Nothing here
 * assumes an answer.
 */
export interface DashboardNutritionSnapshot {
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
}

export interface DashboardSelectionPayload {
  /** Display name sent to the custom-meals endpoint. */
  name?: string;
  recipe_id: string;
  meal_category: DashboardMealCategory;
  nutrition_snapshot: DashboardNutritionSnapshot;
  /**
   * Submission time, per the contract's v2 note. Whether the backend prefers the
   * actual eating time, and which side owns the clock and timezone, is open
   * question 5 and is deliberately not resolved here.
   */
  timestamp: string;
}

export interface DashboardLogMealsRequest {
  /**
   * Equals the `pending_operation_id` generated once when the confirmation
   * summary was shown. It is never regenerated per send attempt or per retry.
   */
  idempotency_key: string;
  selections: readonly DashboardSelectionPayload[];
}

export interface DashboardSuccessResponse {
  status: "success";
  applied: true;
  daily_calories_remaining: number | null;
  logged_selection_ids: string[];
}

export interface DashboardIdempotentReplayResponse {
  status: "success";
  applied: false;
  reason: "already_logged";
  daily_calories_remaining: number | null;
}

export interface DashboardErrorResponse {
  status: "error";
  error_code: DashboardErrorCode;
  message: string;
}

export type DashboardLogMealsResponse =
  | DashboardSuccessResponse
  | DashboardIdempotentReplayResponse
  | DashboardErrorResponse;

/**
 * The port every dashboard implementation must satisfy.
 *
 * Callers must treat all three response shapes as expected outcomes. They must
 * never infer success from the absence of a thrown error.
 */
export interface DashboardClient {
  /** Human-readable implementation label used in logs and completion reports. */
  readonly implementationId: string;
  logMealSelections(request: DashboardLogMealsRequest): Promise<DashboardLogMealsResponse>;
}
