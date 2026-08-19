/**
 * Step 16 — Dashboard integration port (contract-shaped, NOT connected).
 *
 * This module is the ONLY place that describes the wire contract agreed with the
 * dashboard/backend team in `NutriGuard_Dashboard_Integration_Contract.md` (v2).
 * Nothing here performs I/O: it declares the request payload, the three response
 * shapes, and the `DashboardClient` port.
 *
 * Real integration status: NOT IMPLEMENTED and blocked. Section 1 of the
 * contract records that cross-team auth linkage (how an authenticated `user_id`
 * or bearer token reaches the AI layer, and whether a separate service-to-service
 * token exists) is still an open question owned by the backend team. Until that is
 * answered no HTTP implementation of this port may be written or shipped.
 *
 * Swapping the mock for a real HTTP client means adding a second implementation
 * of `DashboardClient` in this folder and constructing it instead of
 * `MockDashboardClient`. That is the intended seam, but it is NOT guaranteed to be
 * a pure drop-in swap: real auth plumbing, the backend's actual schema, and the
 * unresolved items in `NutriGuard_Open_Questions_Backend_Privacy.md` (privacy /
 * consent / retention, server-side `nutrition_snapshot` validation, batch
 * atomicity, audit / correction / reversal, negative-balance policy, and
 * timestamp / timezone semantics) may each force changes in calling code too.
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
  daily_calories_remaining: number;
  logged_selection_ids: string[];
}

export interface DashboardIdempotentReplayResponse {
  status: "success";
  applied: false;
  reason: "already_logged";
  daily_calories_remaining: number;
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
