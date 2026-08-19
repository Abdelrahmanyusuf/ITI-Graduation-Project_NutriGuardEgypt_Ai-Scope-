import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { loadUnifiedEgyptianDemoDataset } from "../src/demo/unified-egyptian-dataset.js";
import { InMemoryPilotFeedbackStore } from "../src/pilot/feedback.js";
import { buildGraduationDemoAgent, type GraduationConversationContext } from "../src/runtime/graduation-demo-agent.js";
import { createNutriGuardHttpServer } from "../src/server/http-app.js";
import { MockDashboardClient, type MockDashboardScenario } from "../src/services/dashboard/mock-dashboard-client.js";
import { InMemoryPendingMealOperationStore, PENDING_MEAL_CONFIRMATION_TTL_SECONDS } from "../src/services/dashboard/pending-meal-operations.js";
import type { ExpandedAgentResponse } from "../src/agent/expanded-agent.js";

const dataset = await loadUnifiedEgyptianDemoDataset();

interface LogLine { line: string; detail: Record<string, unknown> }

function data(response: ExpandedAgentResponse): Record<string, unknown> {
  assert.equal(typeof response.data, "object");
  assert.notEqual(response.data, null);
  return response.data as Record<string, unknown>;
}

function context(response: ExpandedAgentResponse): GraduationConversationContext {
  return data(response).conversationContext as GraduationConversationContext;
}

interface CategoryPayload {
  mealCategory: string;
  status: "complete" | "partial" | "empty";
  verifiedMatchCount: number;
  options: Array<{ optionIndex: number; isSnackSet: boolean; subtotalCaloriesKcal: number; recipes: Array<{ recipeId: string; name: string; caloriesKcal: number; proteinG: number; carbsG: number; fatG: number; sodiumMg?: number | null }> }>;
}

function categories(response: ExpandedAgentResponse): CategoryPayload[] {
  return data(response).categories as CategoryPayload[];
}

interface SelectionPayload {
  mealCategory: string;
  optionIndex: number;
  subtotalCaloriesKcal: number;
  recipes: Array<{ recipeId: string; name: string; caloriesKcal: number; proteinG: number; carbsG: number; fatG: number }>;
}

function selections(response: ExpandedAgentResponse): SelectionPayload[] {
  return data(response).selections as SelectionPayload[];
}

async function newAgent(options: { scenarios?: MockDashboardScenario[]; now?: () => number; budgetKcal?: number } = {}) {
  const lines: LogLine[] = [];
  const dashboard = new MockDashboardClient({
    scenarios: options.scenarios,
    dailyCalorieBudgetKcal: options.budgetKcal ?? 2_000,
    log: (line, detail) => lines.push({ line, detail }),
  });
  const pendingOperations = new InMemoryPendingMealOperationStore({ now: options.now });
  const agent = await buildGraduationDemoAgent("test", null, null, { dashboard, pendingOperations });
  return { agent, dashboard, pendingOperations, lines };
}

/** Three categories, one option each, stopping at the confirmation summary. */
async function reachSummary(agent: { invoke(input: { message: string; language: "ar-EG"; context?: GraduationConversationContext }): Promise<ExpandedAgentResponse> }) {
  const listing = await agent.invoke({ message: "حضرلي فطار وغدا وعشا", language: "ar-EG" });
  const summary = await agent.invoke({ message: "الأول في الفطار والتاني في الغدا والتالت في العشا", language: "ar-EG", context: context(listing) });
  assert.equal(data(summary).stage, "confirmation_summary", summary.message);
  return { listing, summary };
}

// A single read-only agent is shared by every test that never confirms anything,
// so the mock is provably never called in any of them.
const readOnly = await newAgent();

// ---------------------------------------------------------------------------
// Step 1–2 — candidate options per category
// ---------------------------------------------------------------------------

test("Step 16 flow: several categories in one turn each return their own candidates", async () => {
  const response = await readOnly.agent.invoke({ message: "حضرلي وجبات اليوم فطار وغدا وعشا وسناكس", language: "ar-EG" });
  assert.equal(response.status, "ok");
  assert.equal(data(response).intent, "meal_plan_selection");
  assert.equal(data(response).stage, "candidates");
  const shown = categories(response);
  assert.deepEqual(shown.map((entry) => entry.mealCategory), ["breakfast", "lunch", "dinner", "snacks"]);
  for (const entry of shown) {
    assert.ok(entry.options.length >= 1 && entry.options.length <= 3, entry.mealCategory);
    for (const option of entry.options) {
      for (const recipe of option.recipes) {
        assert.match(recipe.recipeId, /^EGY-RCP-[0-9]{3}$/u);
        for (const field of ["caloriesKcal", "proteinG", "carbsG", "fatG"] as const) {
          assert.equal(typeof recipe[field], "number", `${entry.mealCategory} ${recipe.recipeId} ${field}`);
        }
      }
    }
  }
  // Each category is searched independently, so a category tag drives its own list.
  const breakfastIds = shown[0]!.options.flatMap((option) => option.recipes.map((recipe) => recipe.recipeId));
  for (const recipeId of breakfastIds) {
    const category = dataset.recipes.find((recipe) => recipe.recipe_id === recipeId)?.category;
    assert.ok(category === "breakfast" || category === "bread", `${recipeId}: ${String(category)}`);
  }
  assert.equal(readOnly.dashboard.totalCalls, 0);
});

test("Step 16 flow: fewer than three verified matches reports the real count and never pads", async () => {
  const response = await readOnly.agent.invoke({ message: "حضرلي فطار وغدا وكل وجبة متتخطاش 200 سعرة", language: "ar-EG" });
  assert.equal(response.status, "ok");
  const breakfast = categories(response).find((entry) => entry.mealCategory === "breakfast");
  assert.ok(breakfast);
  assert.equal(breakfast.status, "partial");
  assert.equal(breakfast.verifiedMatchCount, 2);
  assert.equal(breakfast.options.length, 2);
  assert.match(response.message, /وصفة متحققة بس مطابقة، فده كل اللي موجود/u);
  const lunch = categories(response).find((entry) => entry.mealCategory === "lunch");
  assert.equal(lunch?.status, "complete");
  assert.equal(readOnly.dashboard.totalCalls, 0);
});

test("Step 16 flow: a category with zero matches is stated explicitly and the rest of the plan continues", async () => {
  const response = await readOnly.agent.invoke({ message: "حضرلي فطار وغدا وكل وجبة متتخطاش 90 سعرة", language: "ar-EG" });
  const lunch = categories(response).find((entry) => entry.mealCategory === "lunch");
  const breakfast = categories(response).find((entry) => entry.mealCategory === "breakfast");
  assert.equal(lunch?.status, "empty");
  assert.equal(lunch?.verifiedMatchCount, 0);
  assert.equal(lunch?.options.length, 0);
  assert.match(response.message, /مفيش أي وصفة متحققة مطابقة للشروط دي/u);
  assert.ok((breakfast?.options.length ?? 0) >= 1, "the remaining categories still proceed");
  assert.equal(readOnly.dashboard.totalCalls, 0);
});

test("Step 16 flow: identical requests are byte-identical apart from the generated operation id", async () => {
  const first = await readOnly.agent.invoke({ message: "حضرلي فطار وغدا وعشا وسناكس", language: "ar-EG" });
  const second = await readOnly.agent.invoke({ message: "حضرلي فطار وغدا وعشا وسناكس", language: "ar-EG" });
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// Step 4 — selection resolution through the existing session context
// ---------------------------------------------------------------------------

test("Step 16 flow: a bare ordinal with several categories asks for clarification instead of guessing", async () => {
  const listing = await readOnly.agent.invoke({ message: "حضرلي فطار وغدا وعشا", language: "ar-EG" });
  const ambiguous = await readOnly.agent.invoke({ message: "الأول", language: "ar-EG", context: context(listing) });
  assert.equal(ambiguous.status, "clarification");
  assert.equal(data(ambiguous).stage, "ambiguous_reference");
  assert.equal(data(ambiguous).reasonCode, "bare_ordinal_with_several_categories");
  assert.equal(data(ambiguous).pendingOperationId, undefined);
  assert.equal(readOnly.dashboard.totalCalls, 0);
});

test("Step 16 flow: a dish name shown in two categories asks for clarification instead of guessing", async () => {
  const listing = await readOnly.agent.invoke({ message: "حضرلي غدا وعشا", language: "ar-EG" });
  const shown = categories(listing);
  const lunchIds = new Set(shown[0]!.options.flatMap((option) => option.recipes.map((recipe) => recipe.recipeId)));
  const dinnerIds = new Set(shown[1]!.options.flatMap((option) => option.recipes.map((recipe) => recipe.recipeId)));
  assert.ok([...lunchIds].some((id) => dinnerIds.has(id)), "this fixture relies on one dish appearing in both lists");
  const ambiguous = await readOnly.agent.invoke({ message: "المسقعة", language: "ar-EG", context: context(listing) });
  assert.equal(ambiguous.status, "clarification");
  assert.equal(data(ambiguous).stage, "ambiguous_reference");
  assert.equal(data(ambiguous).reasonCode, "matches_more_than_one_category");
  assert.equal(readOnly.dashboard.totalCalls, 0);
});

test("Step 16 flow: a reference that matches nothing currently displayed is not guessed", async () => {
  const listing = await readOnly.agent.invoke({ message: "حضرلي فطار وغدا", language: "ar-EG" });
  const missing = await readOnly.agent.invoke({ message: "اختار الملوخية", language: "ar-EG", context: context(listing) });
  assert.equal(missing.status, "clarification");
  assert.equal(data(missing).stage, "ambiguous_reference");
  assert.equal(data(missing).reasonCode, "no_currently_displayed_match");

  // A bare dish request that is not phrased as a pick keeps its existing route
  // instead of being forced into the selection flow.
  const different = await readOnly.agent.invoke({ message: "عايز وصفة الملوخية", language: "ar-EG", context: context(listing) });
  assert.notEqual(data(different).intent, "meal_plan_selection");
  assert.equal(readOnly.dashboard.totalCalls, 0);
});

test("Step 16 flow: selections resolve across consecutive turns and survive an unrelated turn in between", async () => {
  const listing = await readOnly.agent.invoke({ message: "حضرلي فطار وغدا وعشا", language: "ar-EG" });
  const first = await readOnly.agent.invoke({ message: "الأول في الفطار، التالت في الغدا", language: "ar-EG", context: context(listing) });
  assert.equal(data(first).stage, "awaiting_selection");
  assert.deepEqual(data(first).outstandingCategories, ["dinner"]);

  // A completely unrelated question must not disturb the selection state.
  const unrelated = await readOnly.agent.invoke({ message: "كام سعر حراري في الكشري؟", language: "ar-EG", context: context(first) });
  assert.equal(unrelated.status, "ok");
  assert.equal(data(unrelated).intent, "recipe_nutrition");
  const carried = context(unrelated);
  assert.equal(carried.memory?.mealSelection?.phase, "awaiting_selection", "the BUG-09 memory carries the selection through");

  const summary = await readOnly.agent.invoke({ message: "التاني في العشا", language: "ar-EG", context: carried });
  assert.equal(data(summary).stage, "confirmation_summary");
  const chosen = selections(summary);
  assert.deepEqual(chosen.map((entry) => entry.mealCategory), ["breakfast", "lunch", "dinner"]);
  assert.deepEqual(chosen.map((entry) => entry.optionIndex), [1, 3, 2]);
  assert.equal(readOnly.dashboard.totalCalls, 0);
});

// ---------------------------------------------------------------------------
// Step 5 — confirmation summary and pending operation identity
// ---------------------------------------------------------------------------

test("Step 16 flow: no dashboard call happens before a confirmation message arrives", async () => {
  const { agent, dashboard } = await newAgent();
  const { summary } = await reachSummary(agent);
  assert.equal(dashboard.totalCalls, 0, "showing the summary must not write anything");
  assert.match(summary.message, /مفيش حاجة تتسجل قبل كده/u);
  const confirmed = await agent.invoke({ message: "تأكيد", language: "ar-EG", context: context(summary) });
  assert.equal(data(confirmed).stage, "logged");
  assert.equal(dashboard.totalCalls, 1);
});

test("Step 16 flow: the pending operation id is generated once at summary time and reused on every retry", async () => {
  const { agent, dashboard, lines } = await newAgent({
    scenarios: [{ kind: "error", errorCode: "insufficient_calories" }, { kind: "success" }],
  });
  const { summary } = await reachSummary(agent);
  const pendingOperationId = data(summary).pendingOperationId as string;
  assert.match(pendingOperationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  assert.equal(data(summary).idempotencyKey, pendingOperationId);
  assert.equal(data(summary).pendingOperationTtlSeconds, PENDING_MEAL_CONFIRMATION_TTL_SECONDS);

  const failed = await agent.invoke({ message: "تأكيد", language: "ar-EG", context: context(summary) });
  assert.equal(data(failed).stage, "failed");
  assert.equal(data(failed).pendingOperationId, pendingOperationId);

  const retried = await agent.invoke({ message: "تأكيد", language: "ar-EG", context: context(failed) });
  assert.equal(data(retried).stage, "logged");
  assert.equal(data(retried).idempotencyKey, pendingOperationId, "a retry must never mint a new key");
  assert.deepEqual([...new Set(lines.map((entry) => entry.detail.idempotencyKey))], [pendingOperationId]);
  assert.equal(dashboard.appliedCalls, 1, "one confirmed batch, one applied write");
});

test("Step 16 flow: changing a selection invalidates the pending id and a stale confirmation expires", async () => {
  const { agent, dashboard } = await newAgent();
  const { summary } = await reachSummary(agent);
  const staleContext = context(summary);
  const staleId = data(summary).pendingOperationId as string;

  const modified = await agent.invoke({ message: "تمام بس غير الغدا", language: "ar-EG", context: staleContext });
  assert.equal(data(modified).stage, "awaiting_selection", "a modification is not a confirmation");
  assert.deepEqual(data(modified).outstandingCategories, ["lunch"]);
  assert.equal(dashboard.totalCalls, 0, "a modification must never write");

  const staleConfirmation = await agent.invoke({ message: "تأكيد", language: "ar-EG", context: staleContext });
  assert.equal(staleConfirmation.status, "no_result");
  assert.equal(data(staleConfirmation).stage, "confirmation_expired");
  assert.equal(data(staleConfirmation).errorCode, "confirmation_expired");
  assert.equal(data(staleConfirmation).reasonCode, "invalidated");
  assert.equal(dashboard.totalCalls, 0);

  const fresh = await agent.invoke({ message: "الأول في الغدا", language: "ar-EG", context: context(modified) });
  assert.equal(data(fresh).stage, "confirmation_summary");
  assert.notEqual(data(fresh).pendingOperationId, staleId, "a new summary needs a new operation id");
});

test("Step 16 flow: a confirmation after the 10-minute window expires instead of writing", async () => {
  let now = 4_000_000;
  const { agent, dashboard } = await newAgent({ now: () => now });
  const { summary } = await reachSummary(agent);
  now += (PENDING_MEAL_CONFIRMATION_TTL_SECONDS + 1) * 1_000;
  const expired = await agent.invoke({ message: "تأكيد", language: "ar-EG", context: context(summary) });
  assert.equal(expired.status, "no_result");
  assert.equal(data(expired).stage, "confirmation_expired");
  assert.equal(data(expired).reasonCode, "expired");
  assert.equal(dashboard.totalCalls, 0);
});

test("Step 16 flow: a confirmation with no pending operation is answered, not silently ignored", async () => {
  const response = await readOnly.agent.invoke({ message: "تأكيد", language: "ar-EG" });
  assert.equal(response.status, "no_result");
  assert.equal(data(response).stage, "confirmation_expired");
  assert.equal(data(response).reasonCode, "unknown");
  assert.match(response.message, /confirmation_expired/u);
  assert.equal(readOnly.dashboard.totalCalls, 0);
});

test("Step 16 flow: a repeated confirmation after a successful log never writes twice", async () => {
  const { agent, dashboard } = await newAgent();
  const { summary } = await reachSummary(agent);
  const logged = await agent.invoke({ message: "تأكيد", language: "ar-EG", context: context(summary) });
  assert.equal(data(logged).stage, "logged");
  const again = await agent.invoke({ message: "تأكيد", language: "ar-EG", context: context(logged) });
  assert.equal(data(again).stage, "confirmation_expired");
  assert.equal(data(again).reasonCode, "resolved");
  assert.equal(dashboard.appliedCalls, 1);
  assert.equal(dashboard.totalCalls, 1, "the resolved operation is not re-sent");
});

test("Step 16 flow: ambiguous agreement and unrelated messages neither confirm nor reject", async () => {
  const { agent, dashboard } = await newAgent();
  const { summary } = await reachSummary(agent);

  const weak = await agent.invoke({ message: "تمام", language: "ar-EG", context: context(summary) });
  assert.equal(weak.status, "clarification");
  assert.equal(data(weak).stage, "confirmation_intent_unclear");
  assert.equal(dashboard.totalCalls, 0);

  const unrelated = await agent.invoke({ message: "ما توصيات منظمة الصحة العالمية عن الصوديوم؟", language: "ar-EG", context: context(weak) });
  assert.equal(unrelated.status, "ok");
  assert.equal(data(unrelated).intent, "general_guideline");
  assert.equal(dashboard.totalCalls, 0);

  const stillValid = await agent.invoke({ message: "تأكيد", language: "ar-EG", context: context(unrelated) });
  assert.equal(data(stillValid).stage, "logged", "the pending operation stayed active through both turns");
  assert.equal(dashboard.appliedCalls, 1);
});

test("Step 16 flow: cancelling invalidates the pending operation without writing", async () => {
  const { agent, dashboard } = await newAgent();
  const { summary } = await reachSummary(agent);
  const cancelled = await agent.invoke({ message: "الغي", language: "ar-EG", context: context(summary) });
  assert.equal(data(cancelled).stage, "cancelled");
  assert.equal(dashboard.totalCalls, 0);
  const afterwards = await agent.invoke({ message: "تأكيد", language: "ar-EG", context: context(cancelled) });
  assert.equal(data(afterwards).stage, "confirmation_expired");
  assert.equal(dashboard.totalCalls, 0);
});

// ---------------------------------------------------------------------------
// Steps 6–8 — the mock's response types, end to end
// ---------------------------------------------------------------------------

test("Step 16 flow: the success path reports what was logged and the remaining daily calories", async () => {
  const { agent, dashboard } = await newAgent({ budgetKcal: 2_000 });
  const { summary } = await reachSummary(agent);
  const total = data(summary).totalCaloriesKcal as number;
  assert.equal(total, 258.9, "the summary total is deterministic");

  const logged = await agent.invoke({ message: "تأكيد", language: "ar-EG", context: context(summary) });
  assert.equal(logged.status, "ok");
  assert.equal(data(logged).stage, "logged");
  assert.equal(data(logged).applied, true);
  assert.equal(data(logged).totalCaloriesKcal, total, "what was logged equals what was shown");
  assert.equal(data(logged).dailyCaloriesRemaining, 1_741.1);
  assert.match(logged.message, /المتبقي من سعرات اليوم: 1741\.1 سعر حراري/u);
  assert.match(logged.message, /mock/u, "the user is told this is a mock, not a real dashboard");
  // Every nutrition number shown before confirmation is repeated identically.
  assert.deepEqual(selections(logged), selections(summary));
  assert.equal(dashboard.appliedCalls, 1);
});

for (const errorCode of ["invalid_token", "server_error", "insufficient_calories", "validation_failed", "confirmation_expired"] as const) {
  test(`Step 16 flow: the ${errorCode} error path states nothing was added and never claims success`, async () => {
    // `server_error` is retried once internally, so both attempts are scripted.
    const scenarios: MockDashboardScenario[] = errorCode === "server_error"
      ? [{ kind: "error", errorCode }, { kind: "error", errorCode }]
      : [{ kind: "error", errorCode }];
    const { agent, dashboard } = await newAgent({ scenarios });
    const { summary } = await reachSummary(agent);
    const failed = await agent.invoke({ message: "تأكيد", language: "ar-EG", context: context(summary) });
    assert.equal(failed.status, "no_result");
    assert.equal(data(failed).stage, "failed");
    assert.equal(data(failed).applied, false);
    assert.equal(data(failed).errorCode, errorCode);
    assert.match(failed.message, /ما اتسجلش أي حاجة/u);
    assert.doesNotMatch(failed.message, /تم التسجيل/u);
    assert.equal(dashboard.appliedCalls, 0);
    assert.equal(failed.toolTrace.some((entry) => entry.tool === "confirm_and_log_meal_selection" && entry.ok === false && entry.code === errorCode), true);
  });
}

test("Step 16 flow: an idempotent replay is reported as already logged with no new deduction", async () => {
  // The replay is reached the way it happens in production: the transport loses the
  // response after the write landed, so the tool retries with the SAME key.
  const inner = new MockDashboardClient({ scenarios: [{ kind: "success" }], dailyCalorieBudgetKcal: 2_000, log: () => {} });
  let attempts = 0;
  const pendingOperations = new InMemoryPendingMealOperationStore();
  const agent = await buildGraduationDemoAgent("test", null, null, {
    pendingOperations,
    dashboard: {
      implementationId: "flaky-transport",
      async logMealSelections(request) {
        attempts += 1;
        const response = await inner.logMealSelections(request);
        if (attempts === 1) throw new Error("socket hang up before the response was read");
        return response;
      },
    },
  });
  const { summary } = await reachSummary(agent);
  const replay = await agent.invoke({ message: "تأكيد", language: "ar-EG", context: context(summary) });
  assert.equal(replay.status, "ok");
  assert.equal(data(replay).stage, "already_logged");
  assert.equal(data(replay).applied, false);
  assert.equal(data(replay).reason, "already_logged");
  assert.equal(data(replay).dailyCaloriesRemaining, 1_741.1);
  assert.match(replay.message, /كانت مسجلة قبل كده/u);
  assert.doesNotMatch(replay.message, /تم التسجيل\. ده بالظبط/u, "a replay must not be reported as a fresh deduction");
  assert.equal(inner.appliedCalls, 1);
});

// ---------------------------------------------------------------------------
// Step 9 — calorie ceiling distribution
// ---------------------------------------------------------------------------

test("Step 16 ceiling: total-across-plan mode is stated and enforced only at the summary", async () => {
  const { agent, dashboard } = await newAgent();
  const listing = await agent.invoke({ message: "حضرلي فطار وغدا وعشا تحت سقف 1800 سعرة", language: "ar-EG" });
  assert.equal(data(listing).ceilingMode, "total");
  assert.equal(data(listing).ceilingKcal, 1_800);
  assert.match(listing.message, /سقف لكل الخطة/u);
  // In total mode the ceiling is NOT pushed into the per-category search.
  for (const entry of categories(listing)) assert.equal(entry.options.length, 3, entry.mealCategory);

  const summary = await agent.invoke({ message: "الأول في الفطار والتاني في الغدا والتالت في العشا", language: "ar-EG", context: context(listing) });
  assert.equal(data(summary).stage, "confirmation_summary");
  assert.equal(data(summary).ceilingMode, "total");
  assert.match(summary.message, /سقف لكل الخطة/u);
  assert.ok((data(summary).totalCaloriesKcal as number) <= 1_800);
  assert.equal(dashboard.totalCalls, 0);
});

test("Step 16 ceiling: total mode over budget refuses to create a pending operation", async () => {
  const { agent, dashboard } = await newAgent();
  const listing = await agent.invoke({ message: "حضرلي فطار وغدا وعشا تحت سقف 400 سعرة", language: "ar-EG" });
  assert.equal(data(listing).ceilingMode, "total");
  const overBudget = await agent.invoke({ message: "التالت في الفطار والتالت في الغدا والتالت في العشا", language: "ar-EG", context: context(listing) });
  assert.equal(overBudget.status, "no_result");
  assert.equal(data(overBudget).stage, "over_total_ceiling");
  assert.equal(data(overBudget).pendingOperationId, null);
  assert.equal(data(overBudget).totalCaloriesKcal, 486.8);
  assert.equal(data(overBudget).excessCaloriesKcal, 86.8);
  assert.match(overBudget.message, /زيادة 86\.8 سعر حراري/u);
  assert.match(overBudget.message, /مفيش حاجة اتسجلت/u);
  assert.equal(dashboard.totalCalls, 0);

  const swapped = await agent.invoke({ message: "الأول في الفطار", language: "ar-EG", context: context(overBudget) });
  assert.equal(data(swapped).stage, "confirmation_summary", "swapping one selection brings the plan back under the ceiling");
  assert.ok((data(swapped).totalCaloriesKcal as number) <= 400);
});

test("Step 16 ceiling: per-meal mode is stated and pushed into every category search", async () => {
  const { agent, dashboard } = await newAgent();
  const listing = await agent.invoke({ message: "حضرلي فطار وغدا وعشا وكل وجبة متتخطاش 300 سعرة", language: "ar-EG" });
  assert.equal(data(listing).ceilingMode, "per_meal");
  assert.equal(data(listing).ceilingKcal, 300);
  assert.match(listing.message, /سقف لكل وجبة على حدة/u);
  for (const entry of categories(listing)) {
    for (const option of entry.options) assert.ok(option.subtotalCaloriesKcal <= 300, `${entry.mealCategory} ${option.optionIndex}`);
  }
  const summary = await agent.invoke({ message: "الأول في الفطار والأول في الغدا والأول في العشا", language: "ar-EG", context: context(listing) });
  assert.equal(data(summary).ceilingMode, "per_meal");
  assert.match(summary.message, /سقف لكل وجبة على حدة/u);
  assert.equal(dashboard.totalCalls, 0);
});

// ---------------------------------------------------------------------------
// Step 3 — exclusions reuse the existing disclaimer
// ---------------------------------------------------------------------------

test("Step 16 exclusions: a stated dairy allergy filters candidates and carries the existing disclaimer", async () => {
  const listing = await readOnly.agent.invoke({
    message: "عندي حساسية من الألبان، حضرلي فطار وغدا من غير ألبان",
    language: "ar-EG",
  });
  assert.equal(listing.status, "ok");
  const excluded = new Set(data(listing).excludedIngredientKeys as string[]);
  assert.ok(excluded.has("milk_whole"));
  assert.ok(excluded.has("yogurt_plain"));
  assert.ok(excluded.has("cheese_feta"));
  for (const entry of categories(listing)) {
    for (const option of entry.options) {
      for (const shown of option.recipes) {
        const recipe = dataset.recipes.find((candidate) => candidate.recipe_id === shown.recipeId);
        assert.ok(recipe);
        assert.ok(!recipe.ingredients.some((item) => excluded.has(item.ingredient)), shown.recipeId);
      }
    }
  }
  // Exactly the disclaimer from the earlier exclusion fix, not a second variant.
  assert.match(listing.message, /تم استبعاد منتجات الألبان المسجلة بناءً على طلبك/u);
  assert.match(listing.message, /لا يضمن خلو الطعام من التلوث التبادلي/u);
  assert.equal(typeof data(listing).safetyDisclaimer, "string");

  const summary = await readOnly.agent.invoke({ message: "الأول في الفطار والأول في الغدا", language: "ar-EG", context: context(listing) });
  assert.equal(data(summary).stage, "confirmation_summary");
  assert.match(summary.message, /لا يضمن خلو الطعام من التلوث التبادلي/u, "the disclaimer survives to the confirmation summary");
});

// ---------------------------------------------------------------------------
// v3 snacks behaviour
// ---------------------------------------------------------------------------

test("Step 16 snacks: a two-item snack set is offered but still needs explicit selection and confirmation", async () => {
  const { agent, dashboard } = await newAgent();
  const listing = await agent.invoke({ message: "عايز سناكس تحت 100 سعرة", language: "ar-EG" });
  assert.equal(data(listing).stage, "candidates");
  const snacks = categories(listing).find((entry) => entry.mealCategory === "snacks");
  assert.ok(snacks);
  const set = snacks.options.find((option) => option.isSnackSet);
  assert.ok(set, "a remaining budget that fits two light snacks must offer them as one set");
  assert.equal(set.recipes.length, 2);
  assert.ok(set.subtotalCaloriesKcal <= 100);
  assert.match(listing.message, /الاتنين مع بعض كطقم سناكس واحد/u);
  assert.equal(dashboard.totalCalls, 0, "a snack is never auto-added");

  const summary = await agent.invoke({ message: `الاختيار ${set.optionIndex} في السناكس`, language: "ar-EG", context: context(listing) });
  assert.equal(data(summary).stage, "confirmation_summary");
  const chosen = selections(summary);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0]?.recipes.length, 2);
  assert.equal(dashboard.totalCalls, 0, "the set still waits for an explicit confirmation");

  const logged = await agent.invoke({ message: "تأكيد", language: "ar-EG", context: context(summary) });
  assert.equal(data(logged).stage, "logged");
  assert.equal((data(logged).loggedSelectionIds as string[]).length, 2, "both snacks are logged as separate entries in one batch");
});

// ---------------------------------------------------------------------------
// Regression guard — previously supported phrasings keep their old routes
// ---------------------------------------------------------------------------

for (const entry of [
  { message: "عاوز وجبة افطار تكون من 500 سعر حراري بس ميكنش فيها منتجات البان", intent: "find_recipe" },
  { message: "عاوز وجبة غداء تتكون من 500 سعر حراري", intent: "find_recipe" },
  { message: "عاوز 3 وجبات طول اليوم على 2000 سعر حراري", intent: "meal_plan" },
  { message: "حضرلي 10 وجبات لليوم بس لا يتخطوا 3000 سعرة", intent: "meal_plan" },
  { message: "رشحلي فطار مصري", intent: undefined },
  { message: "ما حالة الطقس غدًا؟", intent: "unsupported" },
]) {
  test(`Step 16 boundary: "${entry.message}" keeps its existing route`, async () => {
    const response = await readOnly.agent.invoke({ message: entry.message, language: "ar-EG" });
    assert.notEqual(data(response).intent, "meal_plan_selection");
    if (entry.intent) assert.equal(data(response).intent, entry.intent);
    assert.equal(readOnly.dashboard.totalCalls, 0);
  });
}

// ---------------------------------------------------------------------------
// API boundary
// ---------------------------------------------------------------------------

test("Step 16 API: the selection context round-trips through /api/v1/chat and forged state is rejected", async () => {
  const { agent } = await newAgent();
  const server = createNutriGuardHttpServer({
    agent, feedbackStore: new InMemoryPilotFeedbackStore(), mode: "test", releaseId: "STEP16",
    allowedOrigins: [], readiness: async () => ({ ready: true, blockers: [] }), pilotConsentReference: "TEST-CONSENT",
    privacyNoticeVersion: "test", rateLimit: { windowMs: 60_000, maxRequests: 20 },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const post = async (body: unknown) => fetch(`http://127.0.0.1:${port}/api/v1/chat`, {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body),
    });

    const first = await post({ message: "حضرلي فطار وغدا وعشا", language: "ar-EG" });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { result: ExpandedAgentResponse };
    assert.equal(data(firstBody.result).stage, "candidates");
    const chatContext = data(firstBody.result).conversationContext;

    const second = await post({ message: "الأول في الفطار والتاني في الغدا والتالت في العشا", language: "ar-EG", context: chatContext });
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { result: ExpandedAgentResponse };
    assert.equal(data(secondBody.result).stage, "confirmation_summary");
    assert.equal(data(secondBody.result).totalCaloriesKcal, 258.9);

    const forged = await post({
      message: "تأكيد",
      language: "ar-EG",
      context: { schemaVersion: "1.0", lastIntent: "meal_selection", selection: { ...(chatContext as { selection: Record<string, unknown> }).selection, pendingOperationId: "not-a-uuid" } },
    });
    assert.equal(forged.status, 400, "a forged pending operation id must not reach the agent");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
