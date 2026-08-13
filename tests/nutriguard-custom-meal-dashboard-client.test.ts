import assert from "node:assert/strict";
import test from "node:test";
import { NutriGuardCustomMealDashboardClient } from "../src/services/dashboard/nutriguard-custom-meal-dashboard-client.js";
import { runWithBackendAccessToken } from "../src/runtime/backend-request-context.js";
import { NutriGuardBackendClient, type GraduationBackendDataSource } from "../src/runtime/graduation-backend-client.js";

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
    name: "كشري", externalReferenceId: "EGY-RCP-001", source: "NutriGuardAI",
    mealType: "Lunch", date: "2026-08-13", servings: 1,
    energyKcal: 543.7, proteinG: 16, carbohydrateG: 77.6, fatG: 16.8,
  }));
  assert.equal(created.id, 901);
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer short-lived-test-token");
  assert.equal(calls[0]?.url.pathname, "/api/Tracking/custom-meals");
  await assert.rejects(() => client.createCustomMeal({
    name: "كشري", externalReferenceId: "EGY-RCP-001", source: "NutriGuardAI",
    mealType: "Lunch", date: "2026-08-13", servings: 1,
    energyKcal: -1, proteinG: 16, carbohydrateG: 77.6, fatG: 16.8,
  }));
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
    name: "كشري", externalReferenceId: "EGY-RCP-001", source: "NutriGuardAI",
    mealType: "Lunch", date: "2026-08-13", servings: 1,
    energyKcal: 543.7, proteinG: 16, carbohydrateG: 77.6, fatG: 16.8,
  });
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
