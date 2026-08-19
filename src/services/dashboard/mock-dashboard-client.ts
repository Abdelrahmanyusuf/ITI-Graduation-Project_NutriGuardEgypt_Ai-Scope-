import type {
  DashboardClient,
  DashboardErrorCode,
  DashboardLogMealsRequest,
  DashboardLogMealsResponse,
} from "./dashboard-client.js";
import { DASHBOARD_ERROR_CODES, DASHBOARD_MEAL_CATEGORIES } from "./dashboard-client.js";

/**
 * The marker every mock call emits.
 *
 * It exists so a mock call can never be mistaken for a real dashboard
 * integration in a log file, a demo, or a screenshot.
 */
export const MOCK_DASHBOARD_CALL_MARKER = "[MOCK DASHBOARD CALL]";

/**
 * A scripted outcome for one *attempt* that reaches the scenario queue.
 *
 * There is no randomness anywhere in this module. The contract's v1 draft
 * allowed "random or controlled"; section 5 of the v2 contract resolved that to
 * deterministic-only, which is what this implements.
 */
export type MockDashboardScenario =
  | { kind: "success" }
  | { kind: "error"; errorCode: DashboardErrorCode; message?: string };

export interface MockDashboardClientOptions {
  /**
   * Consumed in order, one entry per attempt that actually reaches the queue.
   * An attempt only reaches the queue when the key has not already applied a
   * write and the payload passed the structural guard.
   */
  scenarios?: readonly MockDashboardScenario[];
  /** Used for a brand-new key once `scenarios` is exhausted. */
  defaultScenario?: MockDashboardScenario;
  /** Starting daily budget used to compute `daily_calories_remaining`. */
  dailyCalorieBudgetKcal?: number;
  /** Injected so tests can capture the marker instead of writing to stdout. */
  log?: (line: string, detail: Record<string, unknown>) => void;
}

interface KeyState {
  /** Did a previous call for this key actually apply the write? */
  applied: boolean;
  /** The scenario last consumed for this key, replayed when the queue is empty. */
  lastScenario: MockDashboardScenario | null;
  /** The response to replay verbatim once the write has been applied. */
  appliedResponse: { dailyCaloriesRemaining: number } | null;
  attempts: number;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/**
 * Deterministic, local, no-network stand-in for the dashboard meal-log endpoint.
 *
 * WHAT THIS IS NOT: it is not the real integration and never performs a network
 * call. Real integration is blocked on the cross-team auth linkage recorded in
 * section 1 of `NutriGuard_Dashboard_Integration_Contract.md`.
 *
 * IDEMPOTENCY SEMANTICS (contract v2 + Step 16 v3 correction). The mock tracks,
 * per `idempotency_key`, not merely "have I seen this key" but "did the previous
 * call for this key actually apply the write":
 *
 * - previous call APPLIED  -> every later call returns the idempotent replay
 *   (`applied: false`, `reason: "already_logged"`) with the same
 *   `daily_calories_remaining`. This is the only situation in which
 *   `already_logged` is correct, and it holds even when a test scripted nothing
 *   for the second call.
 * - previous call did NOT apply (error, or a structural-guard rejection) -> the
 *   next call with the same key re-attempts. It returns a fresh scripted result
 *   if one was injected, otherwise the same error again. It must never claim
 *   `already_logged`, because nothing was logged.
 *
 * DELIBERATELY NOT SIMULATED: the ambiguous third category, where a call fails
 * after the write was already committed (for example a timeout arriving after
 * the backend applied it), so the caller cannot tell whether the effect
 * happened. This mock is fully deterministic and local, so that state cannot
 * arise here. It is a REAL unresolved question for the eventual backend and is
 * already recorded as item 7 of
 * `NutriGuard_Open_Questions_Backend_Privacy.md`. No resolution is invented
 * here.
 *
 * IN-MEMORY LIMITATION: the per-key table below lives in process memory only.
 * The idempotency guarantee therefore holds only within one running process. A
 * crash or restart between the first call and a later retry loses this table, and
 * the guarantee does NOT survive that boundary. This is not crash-safe. Making
 * it durable is deliberately out of scope for this step.
 */
export class MockDashboardClient implements DashboardClient {
  public readonly implementationId = "MOCK-DASHBOARD-CLIENT-STEP16";

  private readonly scenarios: MockDashboardScenario[];
  private readonly defaultScenario: MockDashboardScenario;
  private readonly log: (line: string, detail: Record<string, unknown>) => void;
  private readonly keys = new Map<string, KeyState>();
  private dailyCaloriesRemaining: number;
  private callCount = 0;

  public constructor(options: MockDashboardClientOptions = {}) {
    this.scenarios = [...options.scenarios ?? []];
    this.defaultScenario = options.defaultScenario ?? { kind: "success" };
    this.dailyCaloriesRemaining = options.dailyCalorieBudgetKcal ?? 2_000;
    this.log = options.log ?? ((line, detail) => console.info(line, JSON.stringify(detail)));
  }

  /** Total calls received, including replays and rejected payloads. */
  public get totalCalls(): number {
    return this.callCount;
  }

  /** Number of calls that actually applied a write. Never more than one per key. */
  public get appliedCalls(): number {
    return [...this.keys.values()].filter((state) => state.applied).length;
  }

  public async logMealSelections(request: DashboardLogMealsRequest): Promise<DashboardLogMealsResponse> {
    this.callCount += 1;
    const key = typeof request?.idempotency_key === "string" ? request.idempotency_key : "";
    const state = this.keys.get(key) ?? { applied: false, lastScenario: null, appliedResponse: null, attempts: 0 };
    state.attempts += 1;
    if (key !== "") this.keys.set(key, state);

    // Applied-before wins over everything: this is the one true replay case.
    if (state.applied && state.appliedResponse) {
      return this.emit(key, state.attempts, "idempotent_replay", {
        status: "success",
        applied: false,
        reason: "already_logged",
        daily_calories_remaining: state.appliedResponse.dailyCaloriesRemaining,
      });
    }

    // Structural guard. Payload-derived and therefore deterministic; it consumes
    // no scenario and records no applied write, so a corrected retry with the
    // same key still gets a real attempt instead of a false `already_logged`.
    const invalid = this.validate(request, key);
    if (invalid) {
      return this.emit(key, state.attempts, "validation_guard", { status: "error", error_code: "validation_failed", message: invalid });
    }

    const scenario = this.scenarios.shift() ?? state.lastScenario ?? this.defaultScenario;
    state.lastScenario = scenario;

    if (scenario.kind === "error") {
      return this.emit(key, state.attempts, "scripted_error", {
        status: "error",
        error_code: scenario.errorCode,
        message: scenario.message ?? `mock dashboard scripted ${scenario.errorCode}`,
      });
    }

    const calories = request.selections.reduce((sum, selection) => sum + selection.nutrition_snapshot.calories, 0);
    this.dailyCaloriesRemaining = round(this.dailyCaloriesRemaining - calories);
    state.applied = true;
    state.appliedResponse = { dailyCaloriesRemaining: this.dailyCaloriesRemaining };
    return this.emit(key, state.attempts, "applied", {
      status: "success",
      applied: true,
      daily_calories_remaining: this.dailyCaloriesRemaining,
      logged_selection_ids: request.selections.map((_selection, index) => `log_${key}_${index + 1}`),
    });
  }

  private validate(request: DashboardLogMealsRequest, key: string): string | null {
    if (key.trim() === "") return "idempotency_key is required";
    if (!Array.isArray(request.selections) || request.selections.length === 0) return "selections must contain at least one entry";
    if (request.selections.length > 10) return "selections must contain at most 10 entries";
    for (const selection of request.selections) {
      if (typeof selection?.recipe_id !== "string" || selection.recipe_id.trim() === "") return "recipe_id is required";
      if (!(DASHBOARD_MEAL_CATEGORIES as readonly string[]).includes(selection.meal_category)) return `unsupported meal_category: ${String(selection.meal_category)}`;
      if (typeof selection.timestamp !== "string" || Number.isNaN(Date.parse(selection.timestamp))) return "timestamp must be an ISO 8601 instant";
      const snapshot = selection.nutrition_snapshot;
      if (!snapshot || typeof snapshot !== "object") return "nutrition_snapshot is required";
      for (const field of ["calories", "protein_g", "fat_g", "carbs_g"] as const) {
        const value = snapshot[field];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return `nutrition_snapshot.${field} must be a finite non-negative number`;
      }
    }
    return null;
  }

  private emit(
    key: string,
    attempt: number,
    outcome: "applied" | "idempotent_replay" | "scripted_error" | "validation_guard",
    response: DashboardLogMealsResponse,
  ): DashboardLogMealsResponse {
    this.log(MOCK_DASHBOARD_CALL_MARKER, {
      implementationId: this.implementationId,
      note: "no real dashboard request was made; this is a local deterministic mock",
      idempotencyKey: key,
      attempt,
      outcome,
      status: response.status,
      applied: response.status === "success" ? response.applied : false,
      errorCode: response.status === "error" ? response.error_code : null,
    });
    return response;
  }
}

/** Exported so tests can assert the mock covers every contract error code. */
export const MOCK_DASHBOARD_SUPPORTED_ERROR_CODES: readonly DashboardErrorCode[] = DASHBOARD_ERROR_CODES;
