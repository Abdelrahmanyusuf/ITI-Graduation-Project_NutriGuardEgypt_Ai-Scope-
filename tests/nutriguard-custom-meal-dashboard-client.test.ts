import assert from "node:assert/strict";
import test from "node:test";
import { NutriGuardCustomMealDashboardClient } from "../src/services/dashboard/nutriguard-custom-meal-dashboard-client.js";
import { runWithBackendAccessToken } from "../src/runtime/backend-request-context.js";
import { NutriGuardBackendClient, type CreateCustomMealRequest, type GraduationBackendDataSource } from "../src/runtime/graduation-backend-client.js";

const request = {
  idempotency_key: "48ef7bab-49ec-4d71-a90b-a47978f8e329",
  selections: [{
    recipe_id: "EGY-RCP-001" as const,
    meal_category: "lunch" as const,
    nutrition_snapshot: { calories: 543.7, protein_g: 16, carbs_g: 77.6, fat_g: 16.8 },
    timestamp: "2026-08-13T08:30:00.000Z",
  }],
};

test("authenticated backend methods forward the request-scoped bearer token and validate custom meals", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({ isSuccess: true, data: { customMealLogId: 901 } }), { status: 200 });
  };
  const client = new NutriGuardBackendClient("http://backend.test", fetcher, 4_000, true);
  const created = await runWithBackendAccessToken("short-lived-test-token", () => client.createCustomMeal({
    name: "كشري", externalReferenceId: "EGY-RCP-001", source: "AI",
    mealType: "Lunch", date: "2026-08-13", servings: 1,
    energyKcal: 543.7, proteinG: 16, carbohydrateG: 77.6, fatG: 16.8,
  }));
  assert.equal(created.id, 901);
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer short-lived-test-token");
  assert.equal(calls[0]?.url.pathname, "/api/Tracking/custom-meals");
  await assert.rejects(() => client.createCustomMeal({
    name: "كشري", externalReferenceId: "EGY-RCP-001", source: "AI",
    mealType: "Lunch", date: "2026-08-13", servings: 1,
    energyKcal: -1, proteinG: 16, carbohydrateG: 77.6, fatG: 16.8,
  }));
});

test("authenticated backend batch forwards one durable idempotency key and parses the authoritative result", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({
      isSuccess: true,
      message: null,
      data: {
        applied: true,
        reason: null,
        operationId: "operation-001",
        loggedSelectionIds: [901],
        dailyCaloriesRemaining: 1456.3,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new NutriGuardBackendClient("http://backend.test", fetcher, 4_000, true);
  const result = await runWithBackendAccessToken("short-lived-test-token", () => client.createCustomMealBatch(
    "48ef7bab-49ec-4d71-a90b-a47978f8e329",
    [{
      name: "كشري", externalReferenceId: "EGY-RCP-001", source: "AI",
      mealType: "Lunch", date: "2026-08-13", servings: 1,
      energyKcal: 543.7, proteinG: 16, carbohydrateG: 77.6, fatG: 16.8,
    }],
  ));
  assert.equal(result.applied, true);
  assert.deepEqual(result.loggedSelectionIds, [901]);
  assert.equal(result.dailyCaloriesRemaining, 1456.3);
  assert.equal(calls[0]?.url.pathname, "/api/Tracking/custom-meals/batch");
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer short-lived-test-token");
  assert.equal(headers.get("Idempotency-Key"), "48ef7bab-49ec-4d71-a90b-a47978f8e329");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    selections: [{
      name: "كشري", externalReferenceId: "EGY-RCP-001", source: "AI",
      mealType: "Lunch", date: "2026-08-13", servings: 1,
      energyKcal: 543.7, proteinG: 16, carbohydrateG: 77.6, fatG: 16.8,
    }],
  });
});

test("dashboard uses one atomic Backend batch and lets the Backend decide durable replay", async () => {
  const batchRequest = {
    ...request,
    selections: [
      { ...request.selections[0]!, recipe_id: "EGY-RCP-001", meal_category: "breakfast" as const },
      { ...request.selections[0]!, recipe_id: "EGY-RCP-002", meal_category: "lunch" as const },
      { ...request.selections[0]!, recipe_id: "EGY-RCP-003", meal_category: "dinner" as const },
    ],
  };
  const batches: Array<{ key: string; selections: readonly CreateCustomMealRequest[] }> = [];
  const backend: GraduationBackendDataSource = {
    searchFoods: async () => [], getFood: async () => { throw new Error(); },
    searchRecipes: async () => [], getRecipe: async () => { throw new Error(); },
    createCustomMealBatch: async (key, selections) => {
      batches.push({ key, selections });
      return batches.length === 1
        ? { applied: true, reason: null, operationId: "op-1", loggedSelectionIds: [901, 902, 903], dailyCaloriesRemaining: 456.3, raw: {} }
        : { applied: false, reason: "already_logged", operationId: "op-1", loggedSelectionIds: [901, 902, 903], dailyCaloriesRemaining: 456.3, raw: {} };
    },
  };
  const dashboard = new NutriGuardCustomMealDashboardClient({
    backend,
    resolveRecipe: (id) => ({ nameAr: id, nameEn: id }),
  });
  const first = await dashboard.logMealSelections(batchRequest);
  const replay = await dashboard.logMealSelections(batchRequest);
  assert.deepEqual(first, { status: "success", applied: true, daily_calories_remaining: 456.3, logged_selection_ids: ["901", "902", "903"] });
  assert.deepEqual(replay, { status: "success", applied: false, reason: "already_logged", daily_calories_remaining: 456.3 });
  assert.equal(batches.length, 2);
  assert.equal(batches[0]?.key, request.idempotency_key);
  assert.equal(batches[0]?.selections.length, 3);
  assert.deepEqual(batches[0]?.selections.map((selection) => selection.mealType), ["Breakfast", "Lunch", "Dinner"]);
  assert.ok(batches[0]?.selections.every((selection) => selection.source === "AI"));
});

test("dashboard persists the displayed portion as a fractional serving without requiring a Backend grams field", async () => {
  const batches: CreateCustomMealRequest[][] = [];
  const backend: GraduationBackendDataSource = {
    searchFoods: async () => [], getFood: async () => { throw new Error(); },
    searchRecipes: async () => [], getRecipe: async () => { throw new Error(); },
    createCustomMealBatch: async (_key, selections) => {
      batches.push([...selections]);
      return { applied: true, reason: null, operationId: "portion-op", loggedSelectionIds: [1], dailyCaloriesRemaining: 1700, raw: {} };
    },
  };
  const dashboard = new NutriGuardCustomMealDashboardClient({ backend, resolveRecipe: () => ({ nameAr: "كشري", nameEn: "Koshary" }) });
  const response = await dashboard.logMealSelections({
    ...request,
    selections: [{ ...request.selections[0]!, nutrition_snapshot: { calories: 300.3, protein_g: 8.8, carbs_g: 42.5, fat_g: 9.2 }, portion_grams: 137, serving_fraction: 0.5524 }],
  });
  assert.equal(response.status, "success");
  assert.equal(batches[0]?.[0]?.servings, 0.5524);
  assert.equal(batches[0]?.[0]?.energyKcal, 300.3);
});

test("dashboard maps Backend idempotency conflict and never falls back to sequential writes", async () => {
  let sequentialCalls = 0;
  const backend: GraduationBackendDataSource = {
    searchFoods: async () => [], getFood: async () => { throw new Error(); },
    searchRecipes: async () => [], getRecipe: async () => { throw new Error(); },
    createCustomMealBatch: async () => { throw Object.assign(new Error("conflict"), { status: 409 }); },
    createCustomMeal: async () => { sequentialCalls += 1; return { id: 1, raw: {} }; },
    deleteCustomMeal: async () => undefined,
  };
  const dashboard = new NutriGuardCustomMealDashboardClient({
    backend,
    resolveRecipe: () => ({ nameAr: "كشري", nameEn: "Koshary" }),
  });
  assert.deepEqual(await dashboard.logMealSelections(request), {
    status: "error",
    error_code: "idempotency_conflict",
    message: "The Backend rejected reuse of the idempotency key with different selections.",
  });
  assert.equal(sequentialCalls, 0);
});

test("custom-meal dashboard logs verified recipe snapshots once and replays locally", async () => {
  const created: unknown[] = [];
  const backend: GraduationBackendDataSource = {
    searchFoods: async () => [], getFood: async () => { throw new Error(); },
    searchRecipes: async () => [], getRecipe: async () => { throw new Error(); },
    createCustomMeal: async (payload) => { created.push(payload); return { id: 901, raw: {} }; },
    deleteCustomMeal: async () => undefined,
    getNutritionTargets: async () => ({ data: { energyKcal: 2_000 } }),
    getDailySummary: async () => ({ data: { energyKcal: 543.7 } }),
  };
  const dashboard = new NutriGuardCustomMealDashboardClient({
    backend,
    resolveRecipe: () => ({ nameAr: "كشري", nameEn: "Koshary" }),
  });
  const first = await dashboard.logMealSelections(request);
  const replay = await dashboard.logMealSelections(request);
  assert.deepEqual(first, { status: "success", applied: true, daily_calories_remaining: 1456.3, logged_selection_ids: ["901"] });
  assert.deepEqual(replay, { status: "success", applied: false, reason: "already_logged", daily_calories_remaining: 1456.3 });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0], {
    name: "كشري", externalReferenceId: "EGY-RCP-001", source: "AI",
    mealType: "Lunch", date: "2026-08-13", servings: 1,
    energyKcal: 543.7, proteinG: 16, carbohydrateG: 77.6, fatG: 16.8,
  });
});

test("concurrent confirmations create once and report duplicate callers as replays", async () => {
  let releases: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { releases = resolve; });
  let createCalls = 0;
  const backend: GraduationBackendDataSource = {
    searchFoods: async () => [], getFood: async () => { throw new Error(); },
    searchRecipes: async () => [], getRecipe: async () => { throw new Error(); },
    createCustomMeal: async () => {
      createCalls += 1;
      await gate;
      return { id: 902, raw: {} };
    },
    deleteCustomMeal: async () => undefined,
  };
  const dashboard = new NutriGuardCustomMealDashboardClient({
    backend,
    resolveRecipe: () => ({ nameAr: "كشري", nameEn: "Koshary" }),
  });
  const first = dashboard.logMealSelections(request);
  const second = dashboard.logMealSelections(request);
  const third = dashboard.logMealSelections(request);
  releases!();
  const responses = await Promise.all([first, second, third]);
  assert.equal(createCalls, 1);
  assert.equal(responses.filter((response) => response.status === "success" && response.applied).length, 1);
  assert.equal(responses.filter((response) => response.status === "success" && !response.applied && response.reason === "already_logged").length, 2);
});

test("custom-meal dashboard compensates earlier writes when a later selection fails", async () => {
  let call = 0;
  const deleted: number[] = [];
  const backend: GraduationBackendDataSource = {
    searchFoods: async () => [], getFood: async () => { throw new Error(); },
    searchRecipes: async () => [], getRecipe: async () => { throw new Error(); },
    createCustomMeal: async () => {
      call += 1;
      if (call === 2) throw Object.assign(new Error("rejected"), { status: 422 });
      return { id: 901, raw: {} };
    },
    deleteCustomMeal: async (id) => { deleted.push(id); },
  };
  const dashboard = new NutriGuardCustomMealDashboardClient({
    backend,
    resolveRecipe: (id) => ({ nameAr: id, nameEn: id }),
  });
  const response = await dashboard.logMealSelections({
    ...request,
    selections: [request.selections[0]!, { ...request.selections[0]!, recipe_id: "EGY-RCP-002", meal_category: "dinner" }],
  });
  assert.deepEqual(response, { status: "error", error_code: "validation_failed", message: "The Backend rejected the custom-meal request." });
  assert.deepEqual(deleted, [901]);
});
