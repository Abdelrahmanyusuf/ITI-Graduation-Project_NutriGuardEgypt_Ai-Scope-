import type {
  DashboardClient,
  DashboardErrorCode,
  DashboardLogMealsRequest,
  DashboardLogMealsResponse,
} from "./dashboard-client.js";

const ERROR_CODES = new Set<DashboardErrorCode>([
  "invalid_token",
  "recipe_not_found",
  "rate_limited",
  "server_error",
  "insufficient_calories",
  "validation_failed",
  "confirmation_expired",
]);

export interface HttpDashboardClientOptions {
  /** Base URL of the dashboard/backend, without `/api/Tracking/custom-meals`. */
  baseUrl: string;
  /** Optional service-to-service bearer token accepted by the backend. */
  bearerToken?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

/** Real dashboard client for POST /api/Tracking/custom-meals. */
export class HttpDashboardClient implements DashboardClient {
  public readonly implementationId = "HTTP-DASHBOARD-CLIENT";
  private readonly endpoint: string;
  private readonly bearerToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  public constructor(options: HttpDashboardClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
    if (!baseUrl) throw new Error("dashboard base URL is required");
    this.endpoint = `${baseUrl}/api/Tracking/custom-meals`;
    this.bearerToken = options.bearerToken?.trim() || undefined;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async logMealSelections(request: DashboardLogMealsRequest): Promise<DashboardLogMealsResponse> {
    if (request.selections.length === 0) return { status: "error", error_code: "validation_failed", message: "at least one meal selection is required" };
    const loggedSelectionIds: string[] = [];
    for (const [index, selection] of request.selections.entries()) {
      const result = await this.postCustomMeal(request.idempotency_key, selection, index);
      if (result.status === "error") return result;
      if ("loggedId" in result && result.loggedId) loggedSelectionIds.push(result.loggedId);
    }
    return { status: "success", applied: true, daily_calories_remaining: null, logged_selection_ids: loggedSelectionIds };
  }

  private async postCustomMeal(idempotencyKey: string, selection: DashboardLogMealsRequest["selections"][number], index: number): Promise<{ status: "success"; loggedId: string | null } | DashboardLogMealsResponse> {
    const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": idempotencyKey };
    if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: selection.name || selection.recipe_id,
          externalReferenceId: `${idempotencyKey}:${index + 1}`,
          source: "NutriGuard AI",
          mealType: this.mealType(selection.meal_category),
          date: selection.timestamp.slice(0, 10),
          servings: 1,
          energyKcal: selection.nutrition_snapshot.calories,
          proteinG: selection.nutrition_snapshot.protein_g,
          carbohydrateG: selection.nutrition_snapshot.carbs_g,
          fatG: selection.nutrition_snapshot.fat_g,
        }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) return this.errorResponse(response.status, body);
      return this.successResponse(body, `${idempotencyKey}:${index + 1}`);
    } catch (error) {
      throw new Error(error instanceof Error && error.name === "AbortError" ? "dashboard request timed out" : `dashboard request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private mealType(category: DashboardLogMealsRequest["selections"][number]["meal_category"]): "Breakfast" | "Lunch" | "Dinner" | "Snack" {
    return category === "breakfast" ? "Breakfast" : category === "lunch" ? "Lunch" : category === "dinner" ? "Dinner" : "Snack";
  }

  private successResponse(body: unknown, fallbackId: string): { status: "success"; loggedId: string | null } | DashboardLogMealsResponse {
    if (body === null || body === undefined) return { status: "success", loggedId: fallbackId };
    const value = body as Record<string, unknown>;
    if (typeof value !== "object") return { status: "success", loggedId: fallbackId };
    if (value.isSuccess === false) {
      return { status: "error", error_code: "validation_failed", message: typeof value.message === "string" ? value.message : "dashboard rejected the custom meal" };
    }
    const data = value.data && typeof value.data === "object" ? value.data as Record<string, unknown> : value;
    const id = typeof data.id === "number" || typeof data.id === "string" ? String(data.id) : fallbackId;
    return { status: "success", loggedId: id };
  }

  private errorResponse(status: number, body: unknown): DashboardLogMealsResponse {
    const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const rawCode = typeof value.error_code === "string" ? value.error_code : undefined;
    const errorCode = rawCode && ERROR_CODES.has(rawCode as DashboardErrorCode) ? rawCode as DashboardErrorCode
      : status === 401 || status === 403 ? "invalid_token"
        : status === 429 ? "rate_limited"
          : status >= 500 ? "server_error" : "validation_failed";
    return { status: "error", error_code: errorCode, message: typeof value.message === "string" ? value.message : `dashboard rejected the meal log (HTTP ${status})` };
  }
}
