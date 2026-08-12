import type {
  DashboardClient,
  DashboardErrorCode,
  DashboardReplayResponse,
  DashboardResponse,
  LogMealSelectionsRequest,
} from "./dashboard-client.js";

export type MockDashboardScenario =
  | { kind: "success"; dailyCaloriesRemaining: number; loggedSelectionIds?: readonly string[] }
  | { kind: "error"; errorCode: DashboardErrorCode; message?: string };

export interface MockDashboardClientOptions {
  scenarios?: readonly MockDashboardScenario[];
  log?: (marker: string, request: LogMealSelectionsRequest) => void;
}

/**
 * Deterministic, process-local dashboard double. It never performs network I/O.
 * Only successful keys enter the applied map; failed keys remain retryable.
 */
export class MockDashboardClient implements DashboardClient {
  private readonly applied = new Map<string, { dailyCaloriesRemaining: number }>();
  private readonly lastErrors = new Map<string, Extract<MockDashboardScenario, { kind: "error" }>>();
  private readonly scenarios: MockDashboardScenario[];
  private readonly log: (marker: string, request: LogMealSelectionsRequest) => void;
  public readonly calls: LogMealSelectionsRequest[] = [];

  public constructor(options: MockDashboardClientOptions = {}) {
    this.scenarios = [...options.scenarios ?? []];
    this.log = options.log ?? ((marker) => console.info(marker));
  }

  public enqueue(scenario: MockDashboardScenario): void {
    this.scenarios.push(scenario);
  }

  public async logMealSelections(request: LogMealSelectionsRequest): Promise<DashboardResponse> {
    const copy = structuredClone(request);
    this.calls.push(copy);
    this.log("[MOCK DASHBOARD CALL]", copy);

    const prior = this.applied.get(request.idempotency_key);
    if (prior) {
      const replay: DashboardReplayResponse = {
        status: "success",
        applied: false,
        reason: "already_logged",
        daily_calories_remaining: prior.dailyCaloriesRemaining,
      };
      return replay;
    }

    const scenario = this.scenarios.shift()
      ?? this.lastErrors.get(request.idempotency_key)
      ?? {
        kind: "error" as const,
        errorCode: "server_error" as const,
        message: "No deterministic mock scenario was configured.",
      };
    if (scenario.kind === "error") {
      this.lastErrors.set(request.idempotency_key, scenario);
      return {
        status: "error",
        error_code: scenario.errorCode,
        message: scenario.message ?? scenario.errorCode,
      };
    }

    const loggedSelectionIds = scenario.loggedSelectionIds
      ? [...scenario.loggedSelectionIds]
      : request.selections.map((_, index) => `mock-log-${index + 1}`);
    this.lastErrors.delete(request.idempotency_key);
    this.applied.set(request.idempotency_key, { dailyCaloriesRemaining: scenario.dailyCaloriesRemaining });
    return {
      status: "success",
      applied: true,
      daily_calories_remaining: scenario.dailyCaloriesRemaining,
      logged_selection_ids: loggedSelectionIds,
    };
  }
}
