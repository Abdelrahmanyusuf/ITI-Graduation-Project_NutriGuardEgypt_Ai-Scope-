import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { InMemoryPilotFeedbackStore } from "../src/pilot/feedback.js";
import { buildSyntheticDemoAgent } from "../src/runtime/synthetic-demo-agent.js";
import { createNutriGuardHttpServer } from "../src/server/http-app.js";
import { MetricsRegistry } from "../src/observability/metrics.js";

const agent = await buildSyntheticDemoAgent("test");
const feedback = new InMemoryPilotFeedbackStore();
const metrics = new MetricsRegistry();
const server = createNutriGuardHttpServer({ agent, feedbackStore: feedback, mode: "test", releaseId: "TEST-RELEASE", allowedOrigins: ["https://allowed.test"], readiness: async () => ({ ready: true, blockers: [] }), pilotConsentReference: "SERVER-CONSENT-001", privacyNoticeVersion: "v1", rateLimit: { windowMs: 60_000, maxRequests: 20 }, metrics, metricsToken: "test-metrics-token-value-123" });
let baseUrl = "";
before(async () => { await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

test("Step 18 serves accessible chat HTML and security headers", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /dir="rtl"/);
  assert.match(await (await fetch(baseUrl)).text(), /conversationContext/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
});

test("Step 18 health, readiness, and real Agent chat work end to end", async () => {
  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
  const response = await fetch(`${baseUrl}/api/v1/chat`, { method: "POST", headers: { "content-type": "application/json", origin: "https://allowed.test" }, body: JSON.stringify({ message: "الصوديوم في الكشري لكل 100 جرام", language: "ar-EG" }) });
  assert.equal(response.status, 200);
  const body = await response.json() as { requestId: string; result: { status: string; data: { sodiumMg: number } } };
  assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(body.result.status, "ok");
  assert.equal(body.result.data.sodiumMg, 700);
  assert.equal((await fetch(`${baseUrl}/metrics`)).status,401);
  const metricsResponse=await fetch(`${baseUrl}/metrics`,{headers:{authorization:"Bearer test-metrics-token-value-123"}});
  assert.equal(metricsResponse.status,200);
  const metricText=await metricsResponse.text();
  assert.match(metricText,/nutriguard_agent_outcomes_total\{outcome="ok"\}/);
  assert.match(metricText,/nutriguard_calculation_availability_total\{outcome="available"\}/);
});

test("Step 18 rejects foreign origins, wrong media types, unknown fields, and oversized bodies", async () => {
  const forbidden = await fetch(`${baseUrl}/api/v1/chat`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test" }, body: JSON.stringify({ message: "hello" }) });
  assert.equal(forbidden.status, 403);
  const media = await fetch(`${baseUrl}/api/v1/chat`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" });
  assert.equal(media.status, 415);
  const unknown = await fetch(`${baseUrl}/api/v1/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hello", admin: true }) });
  assert.equal(unknown.status, 400);
  const invalidContext = await fetch(`${baseUrl}/api/v1/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "less", context: { schemaVersion: "1.0", lastIntent: "meal_calorie_target", calorieTargetKcal: -1, category: "main_dish", relation: "below", lastRecommendationCaloriesKcal: 500 } }) });
  assert.equal(invalidContext.status, 400);
  const large = await fetch(`${baseUrl}/api/v1/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "x".repeat(20_000) }) });
  assert.equal(large.status, 413);
});

test("Step 19 feedback endpoint requires consent fields and stores no name, email, or question", async () => {
  const responseRequestId = randomUUID();
  const response = await fetch(`${baseUrl}/api/v1/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: randomUUID(), responseRequestId, rating: 5, understood: true, comment: "واضح", consentAccepted: true }) });
  assert.equal(response.status, 201);
  const records = feedback.list();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.responseRequestId, responseRequestId);
  assert.equal(records[0]?.consentReference, "SERVER-CONSENT-001");
  assert.equal("email" in (records[0] ?? {}), false);
  assert.equal("question" in (records[0] ?? {}), false);
  const duplicate = await fetch(`${baseUrl}/api/v1/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: randomUUID(), responseRequestId, rating: 1, understood: false, comment: null, consentAccepted: true }) });
  assert.equal(duplicate.status, 409);
});
