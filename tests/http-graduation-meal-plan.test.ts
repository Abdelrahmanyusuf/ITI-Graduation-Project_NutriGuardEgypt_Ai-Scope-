import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { InMemoryPilotFeedbackStore } from "../src/pilot/feedback.js";
import type { GraduationBackendDataSource } from "../src/runtime/graduation-backend-client.js";
import { currentBackendAccessToken } from "../src/runtime/backend-request-context.js";
import { buildGraduationDemoAgent } from "../src/runtime/graduation-demo-agent.js";
import { createNutriGuardHttpServer } from "../src/server/http-app.js";

test("Postman-like first request forwards auth and returns a Backend-sized three-meal plan", async () => {
  const backend: GraduationBackendDataSource = {
    searchFoods: async () => [], getFood: async () => { throw new Error(); },
    searchRecipes: async () => [], getRecipe: async () => { throw new Error(); },
    getNutritionTargets: async () => {
      assert.equal(currentBackendAccessToken(), "short-lived-request-token");
      return { data: { energyKcal: 2_000 } };
    },
    getDailySummary: async () => {
      assert.equal(currentBackendAccessToken(), "short-lived-request-token");
      return { data: { energyKcal: 800 } };
    },
  };
  const agent = await buildGraduationDemoAgent("test", backend);
  const server = createNutriGuardHttpServer({
    agent,
    feedbackStore: new InMemoryPilotFeedbackStore(),
    mode: "test",
    releaseId: "POSTMAN-MEAL-PLAN-TEST",
    allowedOrigins: ["http://localhost:5173", "https://nutri-guard-frontend.vercel.app/"],
    readiness: async () => ({ ready: true, blockers: [] }),
    pilotConsentReference: null,
    privacyNoticeVersion: null,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer short-lived-request-token",
        origin: "http://localhost:5173",
      },
      body: JSON.stringify({ message: "Suggest three meals for me today", language: "en" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
    const body = await response.json() as { result: { status: string; data?: Record<string, unknown>; message: string } };
    assert.equal(body.result.status, "ok");
    assert.equal(body.result.data?.calorieTargetSource, "backend_remaining_calories");
    assert.equal(body.result.data?.remainingCaloriesKcal, 1_200);
    const meals = body.result.data?.meals as Array<{ portionGrams?: number }>;
    assert.equal(meals.length, 3);
    assert.ok(meals.every((meal) => typeof meal.portionGrams === "number" && meal.portionGrams > 0));
    assert.doesNotMatch(body.result.message, /could not find.*recipe/iu);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
