import assert from "node:assert/strict";
import test from "node:test";
import { HttpDashboardClient } from "../src/services/dashboard/http-dashboard-client.js";

test("HTTP dashboard client calls POST /api/Tracking/meals with idempotency and auth", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const client = new HttpDashboardClient({
    baseUrl: "https://dashboard.example.test/",
    bearerToken: "token-123",
    fetchImplementation: async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({
        status: "success",
        applied: true,
        daily_calories_remaining: 1_500,
        logged_selection_ids: ["meal-log-1"],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.logMealSelections({
    idempotency_key: "operation-1",
    selections: [{
      recipe_id: "EGY-RCP-001",
      meal_category: "lunch",
      nutrition_snapshot: { calories: 500, protein_g: 20, fat_g: 10, carbs_g: 70 },
      timestamp: "2026-08-20T10:00:00.000Z",
    }],
  });

  assert.equal(capturedUrl, "https://dashboard.example.test/api/Tracking/meals");
  assert.equal(capturedInit?.method, "POST");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("Authorization"), "Bearer token-123");
  assert.equal(headers.get("Idempotency-Key"), "operation-1");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    idempotency_key: "operation-1",
    selections: [{
      recipe_id: "EGY-RCP-001",
      meal_category: "lunch",
      nutrition_snapshot: { calories: 500, protein_g: 20, fat_g: 10, carbs_g: 70 },
      timestamp: "2026-08-20T10:00:00.000Z",
    }],
  });
  assert.deepEqual(result, { status: "success", applied: true, daily_calories_remaining: 1_500, logged_selection_ids: ["meal-log-1"] });
});
