/**
 * Step 17b live verification harness.
 *
 * Exercises the real request path and prints the resulting debug-panel traces
 * so the Part C claims can be checked against an actual run rather than a
 * description. Nothing here is synthetic: whichever providers are configured in
 * the environment are the ones that get called.
 *
 * Run with: npm run verify:claude-layer
 *
 * Reports honestly when a provider is absent — a missing OPENROUTER_API_KEY
 * yields `claudeConfigured: false` and the Claude stages simply do not run.
 */

import { loadLocalEnv } from "../config/load-local-env.js";
import { loadClaudeLayerConfig } from "../llm/claude-config.js";
import { ClaudeLayer } from "../llm/claude-layer.js";
import { claudeClientFromEnv } from "../llm/claude-client.js";
import { redactTraceForDebugPanel } from "../llm/observability.js";
import { JsonStructuredLogger } from "../observability/logger.js";
import { buildGraduationDemoAgent } from "../runtime/graduation-demo-agent.js";

loadLocalEnv();

const baseConfig = loadClaudeLayerConfig();
// Force tracing on for this harness so Part C data is captured even when no
// Claude credentials exist. This does not enable any Claude call by itself.
const config = { ...baseConfig, debugPanelEnabled: true };

const classifierClient = claudeClientFromEnv(config.classifierModel, config.classifierTimeoutMs);
const formatterClient = claudeClientFromEnv(config.formatterModel, config.formatterTimeoutMs);

const layer = new ClaudeLayer({
  config,
  classifierClient,
  formatterClient,
  logger: new JsonStructuredLogger(),
});

const hybridConfigured = Boolean(
  (process.env.GEMINI_API_KEY?.trim() || process.env.EMBEDDING_API_KEY?.trim())
  && process.env.QDRANT_URL?.trim()
  && process.env.QDRANT_COLLECTION?.trim(),
);

console.log(JSON.stringify({
  event: "verification_environment",
  claudeClassifierConfigured: classifierClient !== null,
  claudeFormatterConfigured: formatterClient !== null,
  claudeClassifierModel: config.classifierModel,
  claudeFormatterModel: config.formatterModel,
  hybridRetrievalConfigured: hybridConfigured,
  embeddingModel: process.env.EMBEDDING_MODEL?.trim() || "gemini-embedding-2",
  qdrantCollection: process.env.QDRANT_COLLECTION?.trim() || null,
}, null, 2));

// `development` lets the factory read the configured hybrid retrieval providers.
const agent = await buildGraduationDemoAgent("development", null, layer);

interface Probe {
  label: string;
  message: string;
  expectation: string;
}

const probes: Probe[] = [
  {
    label: "local_only_recipe_nutrition",
    message: "القيمة الغذائية الكاملة للكشري",
    expectation: "deterministic calculation only; no retrieval call at all",
  },
  {
    label: "retrieval_guideline",
    message: "ما توصيات منظمة الصحة العالمية عن الدهون؟",
    expectation: "guideline retrieval; uses external embeddings + vector store when configured",
  },
  {
    label: "medical_safety_refusal",
    message: "اكتبلي دواء للضغط",
    expectation: "fixed rule-based refusal; zero Claude invocations",
  },
];

for (const probe of probes) {
  const startedAt = performance.now();
  const response = await agent.invoke({ message: probe.message, language: "ar-EG" });
  const wallClockMs = Math.round(performance.now() - startedAt);
  const trace = agent.claudeLayer.store.latest();
  console.log(JSON.stringify({
    event: "verification_probe",
    label: probe.label,
    expectation: probe.expectation,
    wallClockMs,
    responseStatus: response.status,
    responsePrimaryIntent: response.primaryIntent,
    messagePreviewLength: response.message.length,
    trace: trace ? redactTraceForDebugPanel(trace) : null,
  }, null, 2));
}

console.log(JSON.stringify({ event: "verification_complete", tracesCaptured: agent.claudeLayer.store.size() }, null, 2));
