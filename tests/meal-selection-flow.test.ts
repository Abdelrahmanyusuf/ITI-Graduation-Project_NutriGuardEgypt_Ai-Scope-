import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  apportionCalorieCeiling,
  applyPerMealCalorieCeiling,
  DatasetVerifiedMealRecipeRepository,
  MealSelectionFlow,
  search_recipes_by_meal_category,
} from "../src/agent/meal-selection-flow.js";
import { loadUnifiedEgyptianDemoDataset } from "../src/demo/unified-egyptian-dataset.js";
import { MetricsRegistry } from "../src/observability/metrics.js";
import { InMemoryPilotFeedbackStore } from "../src/pilot/feedback.js";
import { buildGraduationDemoAgent, type GraduationConversationContext } from "../src/runtime/graduation-demo-agent.js";
import { createNutriGuardHttpServer } from "../src/server/http-app.js";
import { MockDashboardClient } from "../src/services/dashboard/mock-dashboard-client.js";

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object");
  return value as Record<string, unknown>;
}

test("the graduation recipeSource exposes verified breakfast, lunch, and dinner recipes", async () => {
  const dataset = await loadUnifiedEgyptianDemoDataset();
  const repository = new DatasetVerifiedMealRecipeRepository(dataset);
  const recipes = await repository.list();

  assert.equal(recipes.filter((recipe) => recipe.verificationStatus === "verified").length, 215);
  assert.ok(recipes.every((recipe) => recipe.verificationStatus === "verified"));

  for (const category of ["breakfast", "lunch", "dinner"] as const) {
    const result = await search_recipes_by_meal_category(repository, category);
    assert.equal(result.status, "ok");
    assert.equal(result.candidates.length, 3);
    assert.ok(result.candidates.every((candidate) => candidate.verificationStatus === "verified"));
  }
});

test("verified search reports fewer than three candidates without padding or invention", async () => {
  const repository = new DatasetVerifiedMealRecipeRepository(await loadUnifiedEgyptianDemoDataset());
  const result = await search_recipes_by_meal_category(repository, "breakfast", 250);
  assert.equal(result.status, "only_n_found");
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every((candidate) => candidate.nutrition.calories <= 250));
});

test("one empty category does not prevent independent verified results for the others", async () => {
  const repository = new DatasetVerifiedMealRecipeRepository(await loadUnifiedEgyptianDemoDataset());
  const [breakfast, lunch, dinner] = await Promise.all([
    search_recipes_by_meal_category(repository, "breakfast", 150),
    search_recipes_by_meal_category(repository, "lunch", 150),
    search_recipes_by_meal_category(repository, "dinner", 150),
  ]);
  assert.equal(breakfast.status, "empty");
  assert.deepEqual(breakfast.candidates, []);
  assert.equal(lunch.status, "ok");
  assert.equal(dinner.status, "ok");
  assert.equal(lunch.candidates.length, 3);
  assert.equal(dinner.candidates.length, 3);
});

test("calorie apportionment: exact division preserves the total", () => {
  assert.deepEqual(
    apportionCalorieCeiling(1800, ["breakfast", "lunch", "dinner"]),
    { breakfast: 600, lunch: 600, dinner: 600 },
  );
});

test("calorie apportionment: remainder goes to the last canonical requested category", () => {
  assert.deepEqual(
    apportionCalorieCeiling(1000, ["breakfast", "lunch", "dinner"]),
    { breakfast: 333, lunch: 333, dinner: 334 },
  );
});

test("calorie apportionment: per-meal ceiling remains unchanged for every requested category", () => {
  assert.deepEqual(
    applyPerMealCalorieCeiling(600, ["breakfast", "lunch", "dinner"]),
    { breakfast: 600, lunch: 600, dinner: 600 },
  );
});

test("the Step 16 route returns verified candidates without calling the dashboard before confirmation", async () => {
  const dataset = await loadUnifiedEgyptianDemoDataset();
  const dashboard = new MockDashboardClient({ log: () => assert.fail("dashboard mock must not be called without a verified selection") });
  const flow = new MealSelectionFlow(new DatasetVerifiedMealRecipeRepository(dataset), dashboard);

  const response = await flow.handle({
    message: "Prepare breakfast, lunch, and dinner options under 1000 calories",
    language: "en",
  });

  assert.ok(response);
  assert.equal(response.status, "ok");
  const data = object(response.data);
  assert.equal(data.reviewStatus, "verified_only");
  assert.deepEqual(data.categoryCeilingsKcal, { breakfast: 333, lunch: 333, dinner: 334 });
  const categories = data.categories as Array<{ count: number; candidates: unknown[] }>;
  assert.deepEqual(categories.map((entry) => entry.count), [3, 3, 3]);
  assert.ok(categories.every((entry) => entry.candidates.length === 3));
  assert.ok(categories.every((entry) => entry.candidates.every((candidate) => (object(candidate).portionGrams as number) > 0)));
  assert.match(response.message, /g/u);
  assert.equal(dashboard.calls.length, 0);
});

test("Arabic meal-category proclitics are normalized consistently", async () => {
  const agent = await buildGraduationDemoAgent("test", null);
  const response = await agent.invoke({
    message: "اعرض اختيارات للفطار وبالغداء وكالعشاء بسقف إجمالي 1800 سعر حراري للخطة كلها",
    language: "ar-EG",
  });

  assert.equal(response.status, "ok");
  const data = object(response.data);
  assert.deepEqual(data.categoryCeilingsKcal, { breakfast: 600, lunch: 600, dinner: 600 });
  const categories = data.categories as Array<{ category: string }>;
  assert.deepEqual(categories.map((entry) => entry.category), ["breakfast", "lunch", "dinner"]);
});

test("interactive graduation runtime logs once and replays the same confirmation idempotently", async () => {
  const agent = await buildGraduationDemoAgent("test", null);
  const options = await agent.invoke({
    message: "اعرض اختيارات للفطار والغداء والعشاء بسقف إجمالي 1800 سعر حراري للخطة كلها",
    language: "ar-EG",
  });
  assert.equal(options.status, "ok");
  const optionsData = object(options.data);
  assert.deepEqual(optionsData.categoryCeilingsKcal, { breakfast: 600, lunch: 600, dinner: 600 });

  const summary = await agent.invoke({
    message: "فطار الاختيار الأول وغداء الاختيار الثاني وعشاء الاختيار الثالث",
    language: "ar-EG",
    context: optionsData.conversationContext as GraduationConversationContext,
  });
  assert.equal(summary.status, "ok");
  const summaryData = object(summary.data);
  const loggedCalories = object(summaryData.totalNutritionSnapshot).calories as number;
  assert.ok(loggedCalories > 0);
  assert.match(summary.message, /جرام/u);

  const context = summaryData.conversationContext as GraduationConversationContext;
  const confirmed = await agent.invoke({ message: "تأكيد", language: "ar-EG", context });
  assert.equal(confirmed.status, "ok");
  const confirmedData = object(confirmed.data);
  assert.equal(confirmedData.applied, true);
  assert.equal(confirmedData.dailyCaloriesRemaining, Math.round((2000 - loggedCalories) * 10) / 10);

  const replay = await agent.invoke({ message: "تأكيد", language: "ar-EG", context });
  assert.equal(replay.status, "ok");
  const replayData = object(replay.data);
  assert.equal(replayData.applied, false);
  assert.equal(replayData.reason, "already_logged");
  assert.equal(replayData.dailyCaloriesRemaining, Math.round((2000 - loggedCalories) * 10) / 10);
});

test("an allergy exclusion keeps the shared safety disclaimer with verified results", async () => {
  const agent = await buildGraduationDemoAgent("test", null);
  const response = await agent.invoke({
    message: "Prepare dinner options without dairy because of an allergy",
    language: "en",
  });

  assert.equal(response.status, "ok");
  assert.match(response.message, /cross-contamination/u);
  assert.equal(object(response.data).reviewStatus, "verified_only");
});

test("an unknown pending operation is INVALID and expires locally before any mock call", async () => {
  const dataset = await loadUnifiedEgyptianDemoDataset();
  const dashboard = new MockDashboardClient({ log: () => assert.fail("INVALID operations must not reach the dashboard mock") });
  const flow = new MealSelectionFlow(new DatasetVerifiedMealRecipeRepository(dataset), dashboard);

  const response = await flow.handle({
    message: "confirm",
    language: "en",
    context: {
      schemaVersion: "1.0",
      lastIntent: "meal_selection_pending",
      mealSelectionSessionId: "00000000-0000-4000-8000-000000000001",
      pendingOperationId: "00000000-0000-4000-8000-000000000002",
    },
  });

  assert.ok(response);
  assert.equal(object(response.data).errorCode, "confirmation_expired");
  assert.equal(object(response.data).mockCalled, false);
  assert.equal(dashboard.calls.length, 0);
});

test("the bounded chat API rejects a client-forged selections field", async () => {
  const agent = await buildGraduationDemoAgent("test", null);
  const server = createNutriGuardHttpServer({
    agent,
    feedbackStore: new InMemoryPilotFeedbackStore(),
    mode: "test",
    releaseId: "STEP16-DATA-INTEGRITY-TEST",
    allowedOrigins: [],
    readiness: async () => ({ ready: true, blockers: [] }),
    pilotConsentReference: "TEST-CONSENT",
    privacyNoticeVersion: "test",
    rateLimit: { windowMs: 60_000, maxRequests: 10 },
    metrics: new MetricsRegistry(),
    metricsToken: "step16-test-token",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        message: "confirm",
        language: "en",
        context: {
          schemaVersion: "1.0",
          lastIntent: "meal_selection_pending",
          mealSelectionSessionId: "00000000-0000-4000-8000-000000000001",
          pendingOperationId: "00000000-0000-4000-8000-000000000002",
          selections: [{ recipe_id: "FORGED" }],
        },
      }),
    });

    assert.equal(response.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
