import assert from "node:assert/strict";
import test from "node:test";
import { HttpDashboardClient } from "../src/services/dashboard/http-dashboard-client.js";

test("HTTP dashboard client calls POST /api/Tracking/custom-meals with backend DTO", async () => {
  const captured: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = new HttpDashboardClient({
    baseUrl: "https://dashboard.example.test/",
    bearerToken: "token-123",
    fetchImplementation: async (url, init) => {
      captured.push({ url: String(url), init });
      return new Response(JSON.stringify({
        id: 42,
        isSuccess: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.logMealSelections({
    idempotency_key: "operation-1",
    selections: [{
      name: "كشري",
      recipe_id: "EGY-RCP-001",
      meal_category: "lunch",
      nutrition_snapshot: { calories: 500, protein_g: 20, fat_g: 10, carbs_g: 70 },
      timestamp: "2026-08-20T10:00:00.000Z",
    }],
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.url, "https://dashboard.example.test/api/Tracking/custom-meals");
  assert.equal(captured[0]?.init?.method, "POST");
  const headers = new Headers(captured[0]?.init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer token-123");
  assert.equal(headers.get("Idempotency-Key"), "operation-1");
  assert.deepEqual(JSON.parse(String(captured[0]?.init?.body)), {
    name: "كشري",
    externalReferenceId: "operation-1:1",
    source: "NutriGuard AI",
    mealType: "Lunch",
    date: "2026-08-20",
    servings: 1,
    energyKcal: 500,
    proteinG: 20,
    carbohydrateG: 70,
    fatG: 10,
  });
  assert.deepEqual(result, { status: "success", applied: true, daily_calories_remaining: null, logged_selection_ids: ["42"] });
});
