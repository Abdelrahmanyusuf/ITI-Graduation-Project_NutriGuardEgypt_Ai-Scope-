import assert from "node:assert/strict";
import test from "node:test";
import {
  MealSelectionFlow,
  PENDING_OPERATION_TTL_SECONDS,
  type DisplayedMealCandidateSnapshot,
  type DisplayedMealSessionInput,
  type MealSelectionConversationContext,
  type VerifiedMealRecipeRepository,
} from "../src/agent/meal-selection-flow.js";
import type { DashboardClient, DashboardErrorCode, LogMealSelectionsRequest } from "../src/services/dashboard/dashboard-client.js";
import { MockDashboardClient, type MockDashboardScenario } from "../src/services/dashboard/mock-dashboard-client.js";

// SYNTHETIC STATE-MACHINE FIXTURES ONLY. These never enter catalog search,
// never represent repository recipes, and exist only to test orchestration.
const TEST_FIXTURE_CANDIDATES: DisplayedMealCandidateSnapshot[] = [
  {
    recipeId: "TEST_FIXTURE_BREAKFAST_1",
    nameAr: "TEST FIXTURE BREAKFAST ONE",
    nameEn: "Test Fixture Breakfast One",
    mealCategory: "breakfast",
    nutritionSnapshot: { calories: 111, protein_g: 11, carbs_g: 21, fat_g: 4, sodium_mg: 101 },
  },
  {
    recipeId: "TEST_FIXTURE_BREAKFAST_2",
    nameAr: "TEST FIXTURE BREAKFAST TWO",
    nameEn: "Test Fixture Breakfast Two",
    mealCategory: "breakfast",
    nutritionSnapshot: { calories: 122, protein_g: 12, carbs_g: 22, fat_g: 5, sodium_mg: 102 },
  },
  {
    recipeId: "TEST_FIXTURE_LUNCH_1",
    nameAr: "TEST FIXTURE LUNCH ONE",
    nameEn: "Test Fixture Lunch One",
    mealCategory: "lunch",
    nutritionSnapshot: { calories: 211, protein_g: 21, carbs_g: 31, fat_g: 6, sodium_mg: 201 },
  },
  {
    recipeId: "TEST_FIXTURE_LUNCH_2",
    nameAr: "TEST FIXTURE LUNCH TWO",
    nameEn: "Test Fixture Lunch Two",
    mealCategory: "lunch",
    nutritionSnapshot: { calories: 222, protein_g: 22, carbs_g: 32, fat_g: 7, sodium_mg: 202 },
  },
];

const EMPTY_REPOSITORY: VerifiedMealRecipeRepository = { list: async () => [] };

class TestFixtureMealSelectionFlow extends MealSelectionFlow {
  public beginFixtureSession(input: DisplayedMealSessionInput) {
    return this.beginDisplayedCandidateSession(input);
  }
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object");
  return value as Record<string, unknown>;
}

function responseContext(response: { data: Record<string, unknown> | null }): MealSelectionConversationContext {
  return object(response.data).conversationContext as MealSelectionConversationContext;
}

function deterministicIds(): () => string {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}

function buildFixtureFlow(
  scenarios: readonly MockDashboardScenario[] = [],
  now: () => number = () => Date.parse("2026-08-12T09:00:00Z"),
) {
  const markers: string[] = [];
  const dashboard = new MockDashboardClient({ scenarios, log: (marker) => markers.push(marker) });
  const flow = new TestFixtureMealSelectionFlow(EMPTY_REPOSITORY, dashboard, { now, idFactory: deterministicIds() });
  const context = beginFixtureSession(flow);
  return { flow, dashboard, markers, context };
}

function beginFixtureSession(flow: TestFixtureMealSelectionFlow) {
  return flow.beginFixtureSession({
    categories: ["breakfast", "lunch"],
    candidates: TEST_FIXTURE_CANDIDATES,
    ceilingMode: "total_across_plan_equal_split",
    totalCeiling: 1000,
    categoryCeilings: { breakfast: 500, lunch: 500 },
  });
}

async function showFixtureSummary(built: ReturnType<typeof buildFixtureFlow>) {
  const summary = await built.flow.handle({
    message: "first breakfast and second lunch",
    language: "en",
    context: built.context,
  });
  assert.ok(summary);
  assert.match(summary.message, /Confirmation summary/u);
  return summary;
}

test("state machine: ambiguous fixture selection asks for clarification instead of guessing", async () => {
  const flow = new TestFixtureMealSelectionFlow(EMPTY_REPOSITORY, new MockDashboardClient({ log: () => undefined }), { idFactory: deterministicIds() });
  const shared = TEST_FIXTURE_CANDIDATES[0]!;
  const context = flow.beginFixtureSession({
    categories: ["lunch", "dinner"],
    ceilingMode: "none",
    candidates: [
      { ...shared, recipeId: "TEST_FIXTURE_SHARED", nameEn: "Test Fixture Shared", mealCategory: "lunch" },
      { ...shared, recipeId: "TEST_FIXTURE_SHARED", nameEn: "Test Fixture Shared", mealCategory: "dinner" },
    ],
  });
  const response = await flow.handle({ message: "Test Fixture Shared", language: "en", context });
  assert.ok(response);
  assert.equal(response.status, "clarification");
  assert.equal(object(response.data).reasonCode, "ambiguous");
});

test("state machine: fixture-shown selections resolve through session context across consecutive turns", async () => {
  const built = buildFixtureFlow();
  const first = await built.flow.handle({ message: "first breakfast", language: "en", context: built.context });
  assert.ok(first);
  assert.equal(first.status, "clarification");
  assert.deepEqual(object(first.data).remainingCategories, ["lunch"]);
  const summary = await built.flow.handle({ message: "second lunch", language: "en", context: responseContext(first) });
  assert.ok(summary);
  assert.match(summary.message, /Test Fixture Breakfast One/u);
  assert.match(summary.message, /Test Fixture Lunch Two/u);
});

test("state machine: no mock call occurs before a whitelisted confirmation with no modification", async () => {
  const built = buildFixtureFlow([{ kind: "success", dailyCaloriesRemaining: 777 }]);
  const summary = await showFixtureSummary(built);
  assert.equal(built.dashboard.calls.length, 0);
  const unclear = await built.flow.handle({ message: "yes", language: "en", context: responseContext(summary) });
  assert.ok(unclear);
  assert.equal(unclear.status, "clarification");
  assert.equal(built.dashboard.calls.length, 0);
  await built.flow.handle({ message: "confirm", language: "en", context: responseContext(summary) });
  assert.equal(built.dashboard.calls.length, 1);
});

test("state machine: affirmative plus selection change is modification and invalidates the stale pending id", async () => {
  const built = buildFixtureFlow([{ kind: "success", dailyCaloriesRemaining: 777 }]);
  const summary = await showFixtureSummary(built);
  const staleContext = responseContext(summary);
  const changed = await built.flow.handle({ message: "confirm but first lunch", language: "en", context: staleContext });
  assert.ok(changed);
  assert.match(changed.message, /Confirmation summary/u);
  assert.equal(built.dashboard.calls.length, 0);
  const stale = await built.flow.handle({ message: "confirm", language: "en", context: staleContext });
  assert.ok(stale);
  assert.equal(object(stale.data).errorCode, "confirmation_expired");
  assert.equal(object(stale.data).mockCalled, false);
  assert.equal(built.dashboard.calls.length, 0);
});

test("state machine: simulated timeout retry reuses one pending_operation_id and returns idempotent replay", async () => {
  const innerMock = new MockDashboardClient({
    scenarios: [{ kind: "success", dailyCaloriesRemaining: 777 }],
    log: () => undefined,
  });
  let loseFirstResponse = true;
  const timeoutWrapper: DashboardClient = {
    async logMealSelections(request) {
      const response = await innerMock.logMealSelections(request);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new Error("TEST_FIXTURE_SIMULATED_TIMEOUT_AFTER_APPLY");
      }
      return response;
    },
  };
  const flow = new TestFixtureMealSelectionFlow(EMPTY_REPOSITORY, timeoutWrapper, { idFactory: deterministicIds() });
  const built = { flow, dashboard: innerMock, markers: [], context: beginFixtureSession(flow) };
  const summary = await showFixtureSummary(built);
  const pendingId = object(summary.data).pendingOperationId;
  await assert.rejects(
    built.flow.confirm_and_log_meal_selection(String(pendingId), "en"),
    /TEST_FIXTURE_SIMULATED_TIMEOUT_AFTER_APPLY/u,
  );
  const replay = await built.flow.confirm_and_log_meal_selection(String(pendingId), "en");
  assert.equal(object(replay.data).reason, "already_logged");
  assert.equal(built.dashboard.calls.length, 2);
  assert.equal(built.dashboard.calls[0]?.idempotency_key, pendingId);
  assert.equal(built.dashboard.calls[1]?.idempotency_key, pendingId);
  assert.deepEqual(built.dashboard.calls[0], built.dashboard.calls[1]);
});

test("state machine: formerly ACTIVE operation past 600 seconds becomes INVALID without a mock call", async () => {
  let now = Date.parse("2026-08-12T09:00:00Z");
  const built = buildFixtureFlow([{ kind: "success", dailyCaloriesRemaining: 777 }], () => now);
  const summary = await showFixtureSummary(built);
  now += PENDING_OPERATION_TTL_SECONDS * 1000 + 1;
  const response = await built.flow.handle({ message: "confirm", language: "en", context: responseContext(summary) });
  assert.ok(response);
  assert.equal(object(response.data).errorCode, "confirmation_expired");
  assert.equal(object(response.data).mockCalled, false);
  assert.equal(built.dashboard.calls.length, 0);
});

test("state machine: mock success applies once and returns the scripted remaining calories", async () => {
  const now = Date.parse("2026-08-12T09:00:00Z");
  const expectedTimestamp = new Date(now).toISOString();
  const built = buildFixtureFlow([{ kind: "success", dailyCaloriesRemaining: 777 }], () => now);
  const summary = await showFixtureSummary(built);
  const response = await built.flow.handle({ message: "confirm", language: "en", context: responseContext(summary) });
  assert.ok(response);
  assert.equal(object(response.data).applied, true);
  assert.equal(object(response.data).dailyCaloriesRemaining, 777);
  assert.deepEqual(object(response.data).selections, object(summary.data).selections);
  assert.deepEqual(object(response.data).totalNutritionSnapshot, object(summary.data).totalNutritionSnapshot);
  assert.deepEqual(built.dashboard.calls[0]?.selections, (object(summary.data).selections as Array<Record<string, unknown>>).map((selection) => ({
    recipe_id: selection.recipeId,
    meal_category: selection.mealCategory,
    nutrition_snapshot: selection.nutritionSnapshot,
    timestamp: expectedTimestamp,
  })));
  assert.ok(built.dashboard.calls[0]!.selections.every((selection) => selection.timestamp === expectedTimestamp));
  assert.deepEqual(built.markers, ["[MOCK DASHBOARD CALL]"]);
});

test("state machine: user resend after success reaches mock with the same key and returns already_logged", async () => {
  const built = buildFixtureFlow([{ kind: "success", dailyCaloriesRemaining: 777 }]);
  const summary = await showFixtureSummary(built);
  const applied = await built.flow.handle({ message: "confirm", language: "en", context: responseContext(summary) });
  assert.ok(applied);
  const replay = await built.flow.handle({ message: "تأكيد", language: "ar-EG", context: responseContext(applied) });
  assert.ok(replay);
  assert.equal(object(replay.data).reason, "already_logged");
  assert.equal(built.dashboard.calls.length, 2);
  assert.equal(built.dashboard.calls[0]?.idempotency_key, built.dashboard.calls[1]?.idempotency_key);
});

const ALL_MOCK_ERRORS: DashboardErrorCode[] = [
  "invalid_token",
  "recipe_not_found",
  "rate_limited",
  "server_error",
  "insufficient_calories",
  "idempotency_conflict",
  "validation_failed",
  "confirmation_expired",
];

test("bare mock remains fail-closed when no scenario is configured", async () => {
  const dashboard = new MockDashboardClient({ log: () => undefined });
  const response = await dashboard.logMealSelections({
    idempotency_key: "TEST_FIXTURE_UNCONFIGURED_KEY",
    selections: [{
      recipe_id: "TEST_FIXTURE_RECIPE",
      meal_category: "breakfast",
      nutrition_snapshot: TEST_FIXTURE_CANDIDATES[0]!.nutritionSnapshot,
      timestamp: "2026-08-12T09:00:00.000Z",
    }],
  });
  assert.deepEqual(response, {
    status: "error",
    error_code: "server_error",
    message: "No deterministic mock scenario was configured.",
  });
});

for (const errorCode of ALL_MOCK_ERRORS) {
  test(`mock state: ${errorCode} leaves the key unapplied`, async () => {
    const dashboard = new MockDashboardClient({
      scenarios: [{ kind: "error", errorCode }, { kind: "success", dailyCaloriesRemaining: 777 }],
      log: () => undefined,
    });
    const request: LogMealSelectionsRequest = {
      idempotency_key: `TEST_FIXTURE_KEY_${errorCode}`,
      selections: [{
        recipe_id: "TEST_FIXTURE_RECIPE",
        meal_category: "breakfast",
        nutrition_snapshot: TEST_FIXTURE_CANDIDATES[0]!.nutritionSnapshot,
        timestamp: "2026-08-12T09:00:00.000Z",
      }],
    };
    const first = await dashboard.logMealSelections(request);
    const second = await dashboard.logMealSelections(request);
    assert.equal(first.status, "error");
    assert.equal(second.status, "success");
    assert.equal(second.applied, true);
  });
}

test("state machine: retry after a first-attempt error is never reported already_logged", async () => {
  const built = buildFixtureFlow([
    { kind: "error", errorCode: "validation_failed" },
    { kind: "success", dailyCaloriesRemaining: 777 },
  ]);
  const summary = await showFixtureSummary(built);
  const first = await built.flow.handle({ message: "confirm", language: "en", context: responseContext(summary) });
  assert.ok(first);
  assert.equal(object(first.data).errorCode, "validation_failed");
  const second = await built.flow.handle({ message: "confirm", language: "en", context: responseContext(first) });
  assert.ok(second);
  assert.equal(object(second.data).applied, true);
  assert.notEqual(object(second.data).reason, "already_logged");
  assert.equal(built.dashboard.calls[0]?.idempotency_key, built.dashboard.calls[1]?.idempotency_key);
});

test("state machine: confirmation summaries identify total-plan and per-meal ceiling modes", async () => {
  const total = buildFixtureFlow();
  const totalSummary = await showFixtureSummary(total);
  assert.match(totalSummary.message, /whole-plan ceiling \(equal split\)/u);

  const dashboard = new MockDashboardClient({ log: () => undefined });
  const perMeal = new TestFixtureMealSelectionFlow(EMPTY_REPOSITORY, dashboard, { idFactory: deterministicIds() });
  const context = perMeal.beginFixtureSession({
    categories: ["breakfast"],
    candidates: [TEST_FIXTURE_CANDIDATES[0]!],
    ceilingMode: "per_meal",
    categoryCeilings: { breakfast: 500 },
  });
  const perMealSummary = await perMeal.handle({ message: "first breakfast", language: "en", context });
  assert.ok(perMealSummary);
  assert.match(perMealSummary.message, /separate per-meal ceiling/u);
});

test("state machine: one intended batch never produces two idempotency keys", async () => {
  const built = buildFixtureFlow([{ kind: "success", dailyCaloriesRemaining: 777 }]);
  const summary = await showFixtureSummary(built);
  const pendingId = String(object(summary.data).pendingOperationId);
  await built.flow.confirm_and_log_meal_selection(pendingId, "en");
  await built.flow.confirm_and_log_meal_selection(pendingId, "en");
  await built.flow.confirm_and_log_meal_selection(pendingId, "en");
  assert.deepEqual(new Set(built.dashboard.calls.map((call) => call.idempotency_key)), new Set([pendingId]));
});
