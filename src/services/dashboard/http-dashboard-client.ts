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
  /** Base URL of the dashboard/backend, without `/api/Tracking/meals`. */
  baseUrl: string;
  /** Optional service-to-service bearer token accepted by the backend. */
  bearerToken?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

/** Real dashboard client for POST /api/Tracking/meals. */
export class HttpDashboardClient implements DashboardClient {
  public readonly implementationId = "HTTP-DASHBOARD-CLIENT";
  private readonly endpoint: string;
  private readonly bearerToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  public constructor(options: HttpDashboardClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
    if (!baseUrl) throw new Error("dashboard base URL is required");
    this.endpoint = `${baseUrl}/api/Tracking/meals`;
    this.bearerToken = options.bearerToken?.trim() || undefined;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async logMealSelections(request: DashboardLogMealsRequest): Promise<DashboardLogMealsResponse> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": request.idempotency_key,
    };
    if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) return this.errorResponse(response.status, body);
      return this.successResponse(body);
    } catch (error) {
      throw new Error(error instanceof Error && error.name === "AbortError" ? "dashboard request timed out" : `dashboard request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private successResponse(body: unknown): DashboardLogMealsResponse {
    if (!body || typeof body !== "object") return { status: "error", error_code: "server_error", message: "dashboard returned an invalid response" };
    const value = body as Record<string, unknown>;
    if (value.status === "success" && value.applied === true && typeof value.daily_calories_remaining === "number" && Array.isArray(value.logged_selection_ids)) {
      return { status: "success", applied: true, daily_calories_remaining: value.daily_calories_remaining, logged_selection_ids: value.logged_selection_ids.filter((id): id is string => typeof id === "string") };
    }
    if (value.status === "success" && value.applied === false && value.reason === "already_logged" && typeof value.daily_calories_remaining === "number") {
      return { status: "success", applied: false, reason: "already_logged", daily_calories_remaining: value.daily_calories_remaining };
    }
    return { status: "error", error_code: "validation_failed", message: "dashboard returned an unsupported success response" };
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
