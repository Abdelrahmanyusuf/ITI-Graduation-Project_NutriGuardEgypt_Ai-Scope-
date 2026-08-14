/* global console, fetch, process, structuredClone */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { runWithBackendAccessToken } from "../src/runtime/backend-request-context.ts";
import { NutriGuardBackendClient } from "../src/runtime/graduation-backend-client.ts";
import { NutriGuardCustomMealDashboardClient } from "../src/services/dashboard/nutriguard-custom-meal-dashboard-client.ts";

const envPath = resolve(process.argv[2] ?? ".env.backend.local.txt");
const localEnv = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }),
);

const email = localEnv.NUTRIGUARD_TEST_EMAIL;
const password = localEnv.NUTRIGUARD_TEST_PASSWORD;
if (!email || !password) throw new Error("The local Backend test credential file is incomplete.");

const baseUrl = "https://nutriguard.runasp.net";
const loginResponse = await fetch(`${baseUrl}/api/Auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ email, password }),
});
const loginBody = await readJson(loginResponse);
const token = findString(loginBody, ["accessToken", "token", "jwt"]);
if (!loginResponse.ok || !token) throw new Error(`Backend login failed with HTTP ${loginResponse.status}.`);

const suffix = randomUUID();
const key = `qa-batch-${suffix}`;
const selections = [
  selection("Breakfast", 400, 20, 50, 10),
  selection("Lunch", 600, 30, 70, 20),
  selection("Dinner", 500, 25, 60, 15),
];
const dashboardRequest = {
  idempotency_key: key,
  selections: selections.map((item) => ({
    recipe_id: item.externalReferenceId,
    meal_category: item.mealType.toLowerCase(),
    nutrition_snapshot: {
      calories: item.energyKcal,
      protein_g: item.proteinG,
      carbs_g: item.carbohydrateG,
      fat_g: item.fatG,
    },
    timestamp: "2026-08-14T08:00:00.000Z",
  })),
};
let loggedIds = [];
const backend = new NutriGuardBackendClient(baseUrl, fetch, 10_000);
const identities = new Map(selections.map((item) => [item.externalReferenceId, item.name]));
const dashboard = new NutriGuardCustomMealDashboardClient({
  backend,
  resolveRecipe: (recipeId) => {
    const name = identities.get(recipeId);
    return name ? { nameAr: name, nameEn: name } : null;
  },
});

await runWithBackendAccessToken(token, async () => {
  try {
    const first = await dashboard.logMealSelections(dashboardRequest);
    loggedIds = first.status === "success" && first.applied
      ? first.logged_selection_ids.map(Number)
      : [];
    const replay = await dashboard.logMealSelections(dashboardRequest);
    const backendReplay = await backend.createCustomMealBatch(key, selections);
    const changed = structuredClone(dashboardRequest);
    changed.selections[0].nutrition_snapshot.calories += 1;
    const conflict = await dashboard.logMealSelections(changed);

    const evidence = {
      login: { status: loginResponse.status, accessTokenPresent: true },
      adapterFirst: first,
      adapterReplay: replay,
      backendReplay: summarize(backendReplay),
      adapterChangedPayloadSameKey: conflict,
      assertions: {
        firstAppliedOnce: first.status === "success" && first.applied === true,
        threeIdsReturned: loggedIds.length === 3,
        replayNotApplied: replay.status === "success" && replay.applied === false && replay.reason === "already_logged",
        durableBackendReplayReached: backendReplay.applied === false && backendReplay.reason === "already_logged",
        replaySameIds: JSON.stringify(backendReplay.loggedSelectionIds) === JSON.stringify(loggedIds),
        changedPayloadConflicts: conflict.status === "error" && conflict.error_code === "idempotency_conflict",
      },
    };
    console.log(JSON.stringify(evidence, null, 2));
    if (Object.values(evidence.assertions).some((passed) => !passed)) process.exitCode = 1;
  } finally {
    const cleanup = [];
    for (const id of loggedIds) {
      await backend.deleteCustomMeal(id);
      cleanup.push({ id, deleted: true });
    }
    console.log(JSON.stringify({ cleanup }, null, 2));
  }
});

function selection(mealType, energyKcal, proteinG, carbohydrateG, fatG) {
  return {
    name: `NutriGuard AI batch QA ${mealType} ${suffix}`,
    externalReferenceId: `qa-${mealType.toLowerCase()}-${suffix}`,
    source: "AI",
    mealType,
    date: "2026-08-14",
    servings: 1,
    energyKcal,
    proteinG,
    carbohydrateG,
    fatG,
  };
}

function summarize(result) {
  return {
    applied: result.applied,
    reason: result.reason,
    operationId: result.operationId,
    loggedSelectionIds: result.loggedSelectionIds,
    dailyCaloriesRemaining: result.dailyCaloriesRemaining,
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { nonJsonBody: true }; }
}

function findString(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].length > 0) return value[key];
  }
  for (const nested of Object.values(value)) {
    const found = findString(nested, keys);
    if (found) return found;
  }
  return null;
}
