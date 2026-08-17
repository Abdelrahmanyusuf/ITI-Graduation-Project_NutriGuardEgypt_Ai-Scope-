/* global console, fetch, process */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { once } from "node:events";
import { URL } from "node:url";
import { NutriGuardBackendClient } from "../src/runtime/graduation-backend-client.ts";
import { buildGraduationDemoAgent } from "../src/runtime/graduation-demo-agent.ts";
import { InMemoryPilotFeedbackStore } from "../src/pilot/feedback.ts";
import { createNutriGuardHttpServer } from "../src/server/http-app.ts";

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
const configuredBackendUrl = new URL(localEnv.NUTRIGUARD_BACKEND_URL || "https://nutriguard.runasp.net");
if (configuredBackendUrl.hostname === "nutriguard.runasp.net") configuredBackendUrl.protocol = "https:";
if (configuredBackendUrl.protocol !== "https:") throw new Error("The live authenticated smoke test requires an HTTPS Backend URL.");
const backendUrl = configuredBackendUrl.origin;
if (!email || !password) throw new Error("The local Backend test credential file is incomplete.");

const loginResponse = await fetch(new URL("/api/Auth/login", backendUrl), {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ email, password }),
});
const loginBody = await readJson(loginResponse);
const token = findString(loginBody, ["accessToken", "token", "jwt"]);
if (!loginResponse.ok || !token) throw new Error(`Backend login failed with HTTP ${loginResponse.status}.`);

const cairoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const [targetProbe, summaryProbe] = await Promise.all([
  authenticatedGet("/api/Nutrition/targets"),
  authenticatedGet(`/api/Tracking/summary/${cairoDate}`),
]);

const backend = new NutriGuardBackendClient(backendUrl, fetch, 10_000);
const agent = await buildGraduationDemoAgent("test", backend);
const server = createNutriGuardHttpServer({
  agent,
  feedbackStore: new InMemoryPilotFeedbackStore(),
  mode: "test",
  releaseId: "LIVE-AI-MEAL-PLAN-SMOKE",
  allowedOrigins: ["https://nutri-guard-frontend.vercel.app", "http://localhost:5173"],
  readiness: async () => ({ ready: true, blockers: [] }),
  pilotConsentReference: null,
  privacyNoticeVersion: null,
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local AI smoke server did not expose a TCP port.");
  const aiResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      origin: "https://nutri-guard-frontend.vercel.app",
    },
    body: JSON.stringify({ message: "Suggest three meals for me today", language: "en" }),
  });
  const aiBody = await readJson(aiResponse);
  const result = aiBody?.result;
  const meals = Array.isArray(result?.data?.meals) ? result.data.meals : [];
  const explicitResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin: "https://nutri-guard-frontend.vercel.app" },
    body: JSON.stringify({ message: "Suggest three meals for me today using 1800 kcal", language: "en" }),
  });
  const explicitBody = await readJson(explicitResponse);
  const explicitResult = explicitBody?.result;
  const explicitMeals = Array.isArray(explicitResult?.data?.meals) ? explicitResult.data.meals : [];
  const summaryRemaining = findNumber(summaryProbe.body, ["caloriesRemaining", "remainingCalories", "remainingCaloriesKcal"]);
  const backendRemainingUsable = summaryRemaining !== null && summaryRemaining >= 300 && summaryRemaining <= 5_000;
  const assertions = {
    loginSucceeded: loginResponse.ok,
    aiHttpSucceeded: aiResponse.ok,
    corsAllowed: aiResponse.headers.get("access-control-allow-origin") === "https://nutri-guard-frontend.vercel.app",
    mealPlanSucceeded: result?.status === "ok" && result?.data?.intent === "meal_plan",
    backendTargetUsed: result?.data?.calorieTargetSource === "backend_remaining_calories",
    threeGramPortionsReturned: meals.length === 3 && meals.every((meal) => Number.isFinite(meal?.portionGrams) && meal.portionGrams > 0),
    explicitCaloriePlanWorks: explicitResponse.ok && explicitResult?.status === "ok" && explicitMeals.length === 3
      && explicitMeals.every((meal) => Number.isFinite(meal?.portionGrams) && meal.portionGrams > 0),
    explicitRecipesIncludeIngredientGrams: explicitMeals.length === 3 && explicitMeals.every((meal) => Array.isArray(meal?.ingredients)
      && meal.ingredients.length > 0 && meal.ingredients.every((ingredient) => Number.isFinite(ingredient?.grams) && ingredient.grams > 0)),
  };
  console.log(JSON.stringify({
    login: { status: loginResponse.status, accessTokenPresent: true },
    backendReadContract: {
      targets: { status: targetProbe.status, numericFieldPaths: numericPaths(targetProbe.body) },
      dailySummary: { status: summaryProbe.status, numericFieldPaths: numericPaths(summaryProbe.body), remainingCaloriesUsableForPlan: backendRemainingUsable },
    },
    ai: { status: aiResponse.status, outcome: result?.status ?? null, intent: result?.data?.intent ?? null, reason: result?.data?.reason ?? null, requiredInput: result?.data?.requiredInput ?? null, mealCount: meals.length },
    explicitCalorieControl: { status: explicitResponse.status, outcome: explicitResult?.status ?? null, mealCount: explicitMeals.length },
    assertions,
  }, null, 2));
  const personalizedExpected = backendRemainingUsable;
  if (!assertions.loginSucceeded || !assertions.aiHttpSucceeded || !assertions.corsAllowed || !assertions.explicitCaloriePlanWorks || !assertions.explicitRecipesIncludeIngredientGrams
    || personalizedExpected && (!assertions.mealPlanSucceeded || !assertions.backendTargetUsed || !assertions.threeGramPortionsReturned)) process.exitCode = 1;
} finally {
  server.close();
  await once(server, "close");
}

async function authenticatedGet(path) {
  const response = await fetch(new URL(path, backendUrl), { headers: { accept: "application/json", authorization: `Bearer ${token}` } });
  return { status: response.status, body: await readJson(response) };
}

function numericPaths(value, prefix = "", depth = 0) {
  if (depth > 5 || !value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof nested === "number" && Number.isFinite(nested)) return [path];
    return numericPaths(nested, path, depth + 1);
  });
}

function findNumber(value, keys, depth = 0) {
  if (depth > 5 || !value || typeof value !== "object") return null;
  for (const key of keys) if (typeof value[key] === "number" && Number.isFinite(value[key])) return value[key];
  for (const nested of Object.values(value)) {
    const found = findNumber(nested, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { nonJsonBody: true }; }
}

function findString(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) if (typeof value[key] === "string" && value[key].length > 0) return value[key];
  for (const nested of Object.values(value)) {
    const found = findString(nested, keys);
    if (found) return found;
  }
  return null;
}
