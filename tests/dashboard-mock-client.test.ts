import assert from "node:assert/strict";
import test from "node:test";
import {
  DASHBOARD_ERROR_CODES,
  type DashboardClient,
  type DashboardLogMealsRequest,
  type DashboardLogMealsResponse,
} from "../src/services/dashboard/dashboard-client.js";
import {
  MOCK_DASHBOARD_CALL_MARKER,
  MockDashboardClient,
  type MockDashboardScenario,
} from "../src/services/dashboard/mock-dashboard-client.js";
import {
  InMemoryPendingMealOperationStore,
  PENDING_MEAL_CONFIRMATION_TTL_SECONDS,
  type FrozenMealSelection,
} from "../src/services/dashboard/pending-meal-operations.js";
import {
  MEAL_SELECTION_MAX_SEND_ATTEMPTS,
  MealSelectionTools,
  type MealCategoryRecipeRecord,
  type MealCategoryRecipeSource,
} from "../src/tools/meal-selection-tools.js";
import type { DashboardMealCategory } from "../src/services/dashboard/dashboard-client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface LogLine { line: string; detail: Record<string, unknown> }

function recorder(): { lines: LogLine[]; log: (line: string, detail: Record<string, unknown>) => void } {
  const lines: LogLine[] = [];
  return { lines, log: (line, detail) => lines.push({ line, detail }) };
}

function record(
  recipeId: string,
  calories: number,
  options: { verificationStatus?: string; ingredientKeys?: string[]; sodiumMg?: number | null } = {},
): MealCategoryRecipeRecord {
  return {
    recipeId,
    name: `recipe ${recipeId}`,
    datasetCategory: "main_dish",
    verificationStatus: options.verificationStatus ?? "verified",
    ingredientKeys: options.ingredientKeys ?? ["rice_white_raw"],
    nutrition: { caloriesKcal: calories, proteinG: 10, carbsG: 20, fatG: 5, sodiumMg: options.sodiumMg ?? 100 },
    provenance: { sourceId: "TEST", versionId: "v1", title: recipeId, url: null, accessedAt: null, locator: recipeId },
  };
}

class StubRecipeSource implements MealCategoryRecipeSource {
  public constructor(private readonly byCategory: Partial<Record<DashboardMealCategory, MealCategoryRecipeRecord[]>>) {}
  public listByMealCategory(category: DashboardMealCategory): readonly MealCategoryRecipeRecord[] {
    return this.byCategory[category] ?? [];
  }
}

function selection(recipeId: string, calories: number, category: DashboardMealCategory = "lunch"): FrozenMealSelection {
  return {
    mealCategory: category,
    optionIndex: 1,
    recipes: [{ recipeId, name: `recipe ${recipeId}`, nutrition: { caloriesKcal: calories, proteinG: 10, carbsG: 20, fatG: 5, sodiumMg: 100 } }],
    subtotalCaloriesKcal: calories,
  };
}

function payload(key: string, calories = 100): DashboardLogMealsRequest {
  return {
    idempotency_key: key,
    selections: [{
      recipe_id: "EGY-RCP-001",
      meal_category: "lunch",
      nutrition_snapshot: { calories, protein_g: 10, fat_g: 5, carbs_g: 20 },
      timestamp: "2026-08-19T09:00:00.000Z",
    }],
  };
}

function buildTools(options: {
  scenarios?: MockDashboardScenario[];
  dashboard?: DashboardClient;
  now?: () => number;
  source?: MealCategoryRecipeSource;
} = {}) {
  const pendingOperations = new InMemoryPendingMealOperationStore({ now: options.now });
  const dashboard = options.dashboard ?? new MockDashboardClient({ scenarios: options.scenarios, log: recorder().log });
  const tools = new MealSelectionTools({
    recipes: options.source ?? new StubRecipeSource({}),
    dashboard,
    pendingOperations,
    now: () => new Date("2026-08-19T09:00:00.000Z"),
  });
  return { tools, pendingOperations, dashboard };
}

// ---------------------------------------------------------------------------
// Mock dashboard client — response shapes
// ---------------------------------------------------------------------------

test("Step 16 mock: the success response reproduces the contract shape exactly", async () => {
  const log = recorder();
  const mock = new MockDashboardClient({ scenarios: [{ kind: "success" }], dailyCalorieBudgetKcal: 2_000, log: log.log });
  const response = await mock.logMealSelections(payload("key-success", 358.7));
  assert.equal(response.status, "success");
  assert.ok(response.status === "success" && response.applied === true);
  if (response.status === "success" && response.applied) {
    assert.equal(response.daily_calories_remaining, 1_641.3);
    assert.deepEqual(response.logged_selection_ids, ["log_key-success_1"]);
  }
});

test("Step 16 mock: every contract error code can be produced and reports nothing applied", async () => {
  for (const errorCode of DASHBOARD_ERROR_CODES) {
    const mock = new MockDashboardClient({ scenarios: [{ kind: "error", errorCode }], log: recorder().log });
    const response = await mock.logMealSelections(payload(`key-${errorCode}`));
    assert.equal(response.status, "error", errorCode);
    if (response.status === "error") assert.equal(response.error_code, errorCode);
    assert.equal(mock.appliedCalls, 0, errorCode);
  }
});

test("Step 16 mock: insufficient_calories, validation_failed and confirmation_expired are all reachable", async () => {
  const mock = new MockDashboardClient({
    scenarios: [
      { kind: "error", errorCode: "insufficient_calories" },
      { kind: "error", errorCode: "validation_failed" },
      { kind: "error", errorCode: "confirmation_expired" },
    ],
    log: recorder().log,
  });
  const codes: string[] = [];
  for (const key of ["a-key", "b-key", "c-key"]) {
    const response = await mock.logMealSelections(payload(key));
    if (response.status === "error") codes.push(response.error_code);
  }
  assert.deepEqual(codes, ["insufficient_calories", "validation_failed", "confirmation_expired"]);
});

// ---------------------------------------------------------------------------
// Mock dashboard client — idempotency, the part the v3 correction tightened
// ---------------------------------------------------------------------------

test("Step 16 mock: the same key after an applied write replays already_logged without a new deduction", async () => {
  const mock = new MockDashboardClient({ scenarios: [{ kind: "success" }], dailyCalorieBudgetKcal: 1_000, log: recorder().log });
  const first = await mock.logMealSelections(payload("replay-key", 250));
  // The second call is NOT scripted anywhere; the mock must still refuse to apply.
  const second = await mock.logMealSelections(payload("replay-key", 250));
  assert.ok(first.status === "success" && first.applied === true);
  assert.ok(second.status === "success" && second.applied === false);
  if (second.status === "success" && !second.applied) {
    assert.equal(second.reason, "already_logged");
    assert.equal(second.daily_calories_remaining, 750);
  }
  assert.equal(mock.appliedCalls, 1);
  assert.equal(mock.totalCalls, 2);
});

test("Step 16 mock: a retry after a NOT-applied failure never claims already_logged", async () => {
  const mock = new MockDashboardClient({
    scenarios: [{ kind: "error", errorCode: "invalid_token" }],
    log: recorder().log,
  });
  const first = await mock.logMealSelections(payload("failed-key"));
  const retry = await mock.logMealSelections(payload("failed-key"));
  assert.equal(first.status, "error");
  assert.equal(retry.status, "error", "nothing was logged, so a replay claim would be a lie");
  if (retry.status === "error") assert.equal(retry.error_code, "invalid_token");
  assert.equal(mock.appliedCalls, 0);
});

test("Step 16 mock: a scripted recovery lets the same key succeed on the retry and apply exactly once", async () => {
  const mock = new MockDashboardClient({
    scenarios: [{ kind: "error", errorCode: "server_error" }, { kind: "success" }],
    dailyCalorieBudgetKcal: 900,
    log: recorder().log,
  });
  const first = await mock.logMealSelections(payload("recovering-key", 300));
  const second = await mock.logMealSelections(payload("recovering-key", 300));
  const third = await mock.logMealSelections(payload("recovering-key", 300));
  assert.equal(first.status, "error");
  assert.ok(second.status === "success" && second.applied === true);
  assert.ok(third.status === "success" && third.applied === false);
  assert.equal(mock.appliedCalls, 1);
  if (third.status === "success" && !third.applied) assert.equal(third.daily_calories_remaining, 600);
});

test("Step 16 mock: a structurally invalid payload fails validation without marking the key applied", async () => {
  const mock = new MockDashboardClient({ scenarios: [{ kind: "success" }], log: recorder().log });
  const empty = await mock.logMealSelections({ idempotency_key: "guard-key", selections: [] });
  assert.equal(empty.status, "error");
  if (empty.status === "error") assert.equal(empty.error_code, "validation_failed");
  assert.equal(mock.appliedCalls, 0);
  // The scenario queue was untouched, so a corrected retry with the SAME key still
  // gets a real attempt instead of a false already_logged.
  const corrected = await mock.logMealSelections(payload("guard-key"));
  assert.ok(corrected.status === "success" && corrected.applied === true);
});

// ---------------------------------------------------------------------------
// Mock dashboard client — visibility and determinism
// ---------------------------------------------------------------------------

test("Step 16 mock: every call emits the [MOCK DASHBOARD CALL] marker", async () => {
  const log = recorder();
  const mock = new MockDashboardClient({ scenarios: [{ kind: "success" }, { kind: "error", errorCode: "server_error" }], log: log.log });
  await mock.logMealSelections(payload("marker-1"));
  await mock.logMealSelections(payload("marker-1"));
  await mock.logMealSelections(payload("marker-2"));
  assert.equal(log.lines.length, 3);
  for (const entry of log.lines) {
    assert.equal(entry.line, MOCK_DASHBOARD_CALL_MARKER);
    assert.equal(entry.detail.implementationId, "MOCK-DASHBOARD-CLIENT-STEP16");
  }
  assert.deepEqual(log.lines.map((entry) => entry.detail.outcome), ["applied", "idempotent_replay", "scripted_error"]);
});

test("Step 16 mock: the default logger writes the marker to the console, so a demo run cannot hide it", async () => {
  const original = console.info;
  const captured: unknown[][] = [];
  console.info = (...args: unknown[]) => { captured.push(args); };
  try {
    const mock = new MockDashboardClient({ scenarios: [{ kind: "success" }] });
    await mock.logMealSelections(payload("default-logger-key"));
  } finally {
    console.info = original;
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.[0], MOCK_DASHBOARD_CALL_MARKER);
  assert.match(String(captured[0]?.[1]), /no real dashboard request was made/u);
});

test("Step 16 mock: identical scenarios and calls produce byte-identical results, with no randomness", async () => {
  const run = async (): Promise<DashboardLogMealsResponse[]> => {
    const mock = new MockDashboardClient({
      scenarios: [{ kind: "error", errorCode: "rate_limited" }, { kind: "success" }],
      dailyCalorieBudgetKcal: 1_500,
      log: recorder().log,
    });
    return [
      await mock.logMealSelections(payload("fixed-key", 120)),
      await mock.logMealSelections(payload("fixed-key", 120)),
      await mock.logMealSelections(payload("fixed-key", 120)),
    ];
  };
  assert.deepEqual(await run(), await run());
});

// ---------------------------------------------------------------------------
// Pending operation store
// ---------------------------------------------------------------------------

test("Step 16 pending operations: the TTL is the specified 600 seconds and expiry is explicit", () => {
  assert.equal(PENDING_MEAL_CONFIRMATION_TTL_SECONDS, 600);
  let now = 1_000_000;
  const store = new InMemoryPendingMealOperationStore({ now: () => now });
  const operation = store.create({ selections: [selection("EGY-RCP-001", 300)], totalCaloriesKcal: 300, ceilingMode: "none", ceilingKcal: null, language: "ar-EG" });
  assert.equal(store.peek(operation.pendingOperationId)?.status, "active");
  now += (PENDING_MEAL_CONFIRMATION_TTL_SECONDS - 1) * 1_000;
  assert.equal(store.peek(operation.pendingOperationId)?.status, "active");
  now += 2_000;
  assert.equal(store.peek(operation.pendingOperationId)?.status, "expired");
});

test("Step 16 pending operations: invalidate and resolve are distinct terminal states", () => {
  const store = new InMemoryPendingMealOperationStore();
  const first = store.create({ selections: [selection("EGY-RCP-001", 300)], totalCaloriesKcal: 300, ceilingMode: "none", ceilingKcal: null, language: "ar-EG" });
  const second = store.create({ selections: [selection("EGY-RCP-002", 400)], totalCaloriesKcal: 400, ceilingMode: "none", ceilingKcal: null, language: "ar-EG" });
  store.invalidate(first.pendingOperationId);
  store.resolve(second.pendingOperationId);
  assert.equal(store.peek(first.pendingOperationId)?.status, "invalidated");
  assert.equal(store.peek(second.pendingOperationId)?.status, "resolved");
  assert.equal(store.peek("00000000-0000-0000-0000-000000000000"), null);
  assert.notEqual(first.pendingOperationId, second.pendingOperationId);
});

// ---------------------------------------------------------------------------
// search_recipes_by_meal_category
// ---------------------------------------------------------------------------

test("Step 16 search tool: only verified recipes are ever returned", async () => {
  const { tools } = buildTools({
    source: new StubRecipeSource({
      lunch: [
        record("EGY-RCP-001", 100),
        record("EGY-RCP-002", 110, { verificationStatus: "needs_review" }),
        record("EGY-RCP-003", 120, { verificationStatus: "rejected" }),
      ],
    }),
  });
  const result = await tools.searchRecipesByMealCategory({ category: "lunch" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.verifiedMatchCount, 1);
  assert.deepEqual(result.data.options.flatMap((option) => option.recipes.map((recipe) => recipe.recipeId)), ["EGY-RCP-001"]);
});

test("Step 16 search tool: fewer than three matches reports the real count and is never padded", async () => {
  const { tools } = buildTools({ source: new StubRecipeSource({ lunch: [record("EGY-RCP-001", 100), record("EGY-RCP-002", 200)] }) });
  const result = await tools.searchRecipesByMealCategory({ category: "lunch" });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.data.status, "partial");
  assert.equal(result.data.verifiedMatchCount, 2);
  assert.equal(result.data.options.length, 2);
});

test("Step 16 search tool: zero matches reports an explicit empty status", async () => {
  const { tools } = buildTools({ source: new StubRecipeSource({ lunch: [record("EGY-RCP-001", 900)] }) });
  const result = await tools.searchRecipesByMealCategory({ category: "lunch", calorieCeilingKcal: 300 });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.data.status, "empty");
  assert.equal(result.data.verifiedMatchCount, 0);
  assert.equal(result.data.options.length, 0);
});

test("Step 16 search tool: exclusions remove matching recipes before the count is reported", async () => {
  const { tools } = buildTools({
    source: new StubRecipeSource({
      breakfast: [
        record("EGY-RCP-001", 100, { ingredientKeys: ["milk_whole"] }),
        record("EGY-RCP-002", 150, { ingredientKeys: ["fava_beans_dry"] }),
      ],
    }),
  });
  const result = await tools.searchRecipesByMealCategory({ category: "breakfast", exclusions: ["milk_whole"] });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.data.verifiedMatchCount, 1);
  assert.deepEqual(result.data.excludedIngredientKeys, ["milk_whole"]);
});

test("Step 16 search tool: snacks may offer an explicit two-item set built only from shown recipes", async () => {
  const { tools } = buildTools({
    source: new StubRecipeSource({ snacks: [record("EGY-RCP-101", 20), record("EGY-RCP-102", 25), record("EGY-RCP-103", 40)] }),
  });
  const withCeiling = await tools.searchRecipesByMealCategory({ category: "snacks", calorieCeilingKcal: 100 });
  assert.ok(withCeiling.ok);
  if (!withCeiling.ok) return;
  const set = withCeiling.data.options.find((option) => option.isSnackSet);
  assert.ok(set, "a set option must be offered when the budget allows two light snacks");
  assert.equal(set.recipes.length, 2);
  assert.equal(set.subtotalCaloriesKcal, 45);
  assert.deepEqual(set.recipes.map((recipe) => recipe.recipeId), ["EGY-RCP-101", "EGY-RCP-102"]);
  assert.ok(withCeiling.data.options.length <= 3);

  const noCeiling = await tools.searchRecipesByMealCategory({ category: "snacks" });
  assert.ok(noCeiling.ok);
  if (!noCeiling.ok) return;
  assert.equal(noCeiling.data.options.some((option) => option.isSnackSet), false, "no ceiling means no known budget for a set");
});

test("Step 16 search tool: the same request twice returns byte-identical output", async () => {
  const { tools } = buildTools({ source: new StubRecipeSource({ dinner: [record("EGY-RCP-001", 100), record("EGY-RCP-002", 100), record("EGY-RCP-003", 300)] }) });
  const first = await tools.searchRecipesByMealCategory({ category: "dinner", calorieCeilingKcal: 400 });
  const second = await tools.searchRecipesByMealCategory({ category: "dinner", calorieCeilingKcal: 400 });
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// confirm_and_log_meal_selection
// ---------------------------------------------------------------------------

test("Step 16 confirm tool: the payload is built from the frozen snapshot, not from anything passed in", async () => {
  const sent: DashboardLogMealsRequest[] = [];
  const capturing: DashboardClient = {
    implementationId: "capture",
    async logMealSelections(request) {
      sent.push(structuredClone(request));
      return { status: "success", applied: true, daily_calories_remaining: 1_000, logged_selection_ids: ["log_1"] };
    },
  };
  const { tools, pendingOperations } = buildTools({ dashboard: capturing });
  const operation = pendingOperations.create({
    selections: [selection("EGY-RCP-001", 358.7, "breakfast"), selection("EGY-RCP-010", 240.5, "dinner")],
    totalCaloriesKcal: 599.2,
    ceilingMode: "total",
    ceilingKcal: 1_800,
    language: "ar-EG",
  });
  const result = await tools.confirmAndLogMealSelection({ pendingOperationId: operation.pendingOperationId });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.data.outcome, "logged");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.idempotency_key, operation.pendingOperationId, "the pending operation id IS the idempotency key");
  assert.deepEqual(sent[0]?.selections.map((entry) => entry.recipe_id), ["EGY-RCP-001", "EGY-RCP-010"]);
  assert.deepEqual(sent[0]?.selections.map((entry) => entry.meal_category), ["breakfast", "dinner"]);
  assert.deepEqual(sent[0]?.selections[0]?.nutrition_snapshot, { calories: 358.7, protein_g: 10, fat_g: 5, carbs_g: 20 });
  assert.equal(sent[0]?.selections[0]?.timestamp, "2026-08-19T09:00:00.000Z");
});

test("Step 16 confirm tool: an unknown, expired, invalidated or resolved operation returns confirmation_expired", async () => {
  let now = 5_000_000;
  const { tools, pendingOperations } = buildTools({ now: () => now, scenarios: [{ kind: "success" }] });
  const make = () => pendingOperations.create({ selections: [selection("EGY-RCP-001", 100)], totalCaloriesKcal: 100, ceilingMode: "none", ceilingKcal: null, language: "ar-EG" });

  const unknown = await tools.confirmAndLogMealSelection({ pendingOperationId: "11111111-2222-3333-4444-555555555555" });
  assert.ok(unknown.ok && unknown.data.outcome === "confirmation_expired" && unknown.data.reason === "unknown");

  const invalidated = make();
  pendingOperations.invalidate(invalidated.pendingOperationId);
  const invalidResult = await tools.confirmAndLogMealSelection({ pendingOperationId: invalidated.pendingOperationId });
  assert.ok(invalidResult.ok && invalidResult.data.outcome === "confirmation_expired" && invalidResult.data.reason === "invalidated");

  const resolved = make();
  await tools.confirmAndLogMealSelection({ pendingOperationId: resolved.pendingOperationId });
  const resolvedAgain = await tools.confirmAndLogMealSelection({ pendingOperationId: resolved.pendingOperationId });
  assert.ok(resolvedAgain.ok && resolvedAgain.data.outcome === "confirmation_expired" && resolvedAgain.data.reason === "resolved");

  const expiring = make();
  now += (PENDING_MEAL_CONFIRMATION_TTL_SECONDS + 1) * 1_000;
  const expired = await tools.confirmAndLogMealSelection({ pendingOperationId: expiring.pendingOperationId });
  assert.ok(expired.ok && expired.data.outcome === "confirmation_expired" && expired.data.reason === "expired");
});

test("Step 16 confirm tool: a dashboard error leaves the operation retryable under the same key", async () => {
  const log = recorder();
  const mock = new MockDashboardClient({
    scenarios: [{ kind: "error", errorCode: "insufficient_calories" }, { kind: "success" }],
    log: log.log,
  });
  const { tools, pendingOperations } = buildTools({ dashboard: mock });
  const operation = pendingOperations.create({ selections: [selection("EGY-RCP-001", 100)], totalCaloriesKcal: 100, ceilingMode: "none", ceilingKcal: null, language: "ar-EG" });

  const failed = await tools.confirmAndLogMealSelection({ pendingOperationId: operation.pendingOperationId });
  assert.ok(failed.ok && failed.data.outcome === "dashboard_error");
  if (failed.ok && failed.data.outcome === "dashboard_error") assert.equal(failed.data.response.error_code, "insufficient_calories");
  assert.equal(pendingOperations.peek(operation.pendingOperationId)?.status, "active", "nothing was applied, so the same key must stay usable");

  const retried = await tools.confirmAndLogMealSelection({ pendingOperationId: operation.pendingOperationId });
  assert.ok(retried.ok && retried.data.outcome === "logged");
  assert.equal(mock.appliedCalls, 1);
  const keys = new Set(log.lines.map((entry) => entry.detail.idempotencyKey));
  assert.deepEqual([...keys], [operation.pendingOperationId], "one confirmed batch must never produce two distinct idempotency keys");
});

test("Step 16 confirm tool: a retryable status is retried automatically with the same key", async () => {
  const log = recorder();
  const mock = new MockDashboardClient({ scenarios: [{ kind: "error", errorCode: "server_error" }, { kind: "success" }], log: log.log });
  const { tools, pendingOperations } = buildTools({ dashboard: mock });
  const operation = pendingOperations.create({ selections: [selection("EGY-RCP-001", 100)], totalCaloriesKcal: 100, ceilingMode: "none", ceilingKcal: null, language: "ar-EG" });
  const result = await tools.confirmAndLogMealSelection({ pendingOperationId: operation.pendingOperationId });
  assert.ok(result.ok && result.data.outcome === "logged", "one tool call may retry internally and still end applied");
  assert.equal(mock.totalCalls, MEAL_SELECTION_MAX_SEND_ATTEMPTS);
  assert.equal(mock.appliedCalls, 1);
  assert.deepEqual([...new Set(log.lines.map((entry) => entry.detail.idempotencyKey))], [operation.pendingOperationId]);
});

test("Step 16 confirm tool: an automatic retry after a lost response gets already_logged, never a second write", async () => {
  // This test deliberately constructs the ambiguous "applied, then the response
  // was lost" shape at the CLIENT WRAPPER level, purely to prove that the retry
  // reuses the same key and that the mock refuses to apply twice. The mock itself
  // does not simulate that case, and how a REAL backend should let a client tell
  // the difference remains item 7 of the open-questions document. Nothing here
  // resolves it.
  const log = recorder();
  const mock = new MockDashboardClient({ scenarios: [{ kind: "success" }], dailyCalorieBudgetKcal: 1_000, log: log.log });
  let attempts = 0;
  const flaky: DashboardClient = {
    implementationId: "flaky-transport",
    async logMealSelections(request): Promise<DashboardLogMealsResponse> {
      attempts += 1;
      const response = await mock.logMealSelections(request);
      if (attempts === 1) throw new Error("socket hang up before the response was read");
      return response;
    },
  };
  const { tools, pendingOperations } = buildTools({ dashboard: flaky });
  const operation = pendingOperations.create({ selections: [selection("EGY-RCP-001", 250)], totalCaloriesKcal: 250, ceilingMode: "none", ceilingKcal: null, language: "ar-EG" });
  const result = await tools.confirmAndLogMealSelection({ pendingOperationId: operation.pendingOperationId });
  assert.ok(result.ok && result.data.outcome === "already_logged");
  if (result.ok && result.data.outcome === "already_logged") {
    assert.equal(result.data.response.reason, "already_logged");
    assert.equal(result.data.response.daily_calories_remaining, 750);
  }
  assert.equal(mock.appliedCalls, 1, "at most one logical write for one idempotency key");
  assert.deepEqual([...new Set(log.lines.map((entry) => entry.detail.idempotencyKey))], [operation.pendingOperationId]);
});

test("Step 16 confirm tool: a malformed call is rejected without reaching the dashboard", async () => {
  const log = recorder();
  const mock = new MockDashboardClient({ log: log.log });
  const { tools } = buildTools({ dashboard: mock });
  const result = await tools.confirmAndLogMealSelection({ pendingOperationId: "   " });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errors[0]?.code, "invalid_pending_operation_id");
  assert.equal(mock.totalCalls, 0);
  assert.equal(log.lines.length, 0);
});
