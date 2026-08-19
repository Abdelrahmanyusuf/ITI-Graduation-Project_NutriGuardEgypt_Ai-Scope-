import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { loadClaudeLayerConfig, CLAUDE_LAYER_VERSION } from "../src/llm/claude-config.js";
import { ClaudeLayer } from "../src/llm/claude-layer.js";
import { ClaudeObservabilityStore, newTrace, redactTraceForDebugPanel } from "../src/llm/observability.js";
import {
  InstrumentedEmbeddingProvider,
  InstrumentedVectorStore,
  recordHybridRetrievalEvent,
  summarizeRetrieval,
  withRetrievalCollection,
} from "../src/llm/retrieval-observer.js";
import { HybridRetrievalTools } from "../src/runtime/hybrid-retrieval-tools.js";
import { buildGraduationDemoAgent } from "../src/runtime/graduation-demo-agent.js";
import { createNutriGuardHttpServer } from "../src/server/http-app.js";
import { InMemoryPilotFeedbackStore } from "../src/pilot/feedback.js";
import type { NutriGuardToolset, SearchToolOutput, ToolResult } from "../src/tools/nutriguard-tools.js";
import type { EmbeddedRetrievalDocument, RetrievalSearchHit, VectorStore } from "../src/retrieval/types.js";
import { ScriptedFormatterClient, StubClaudeClient } from "./helpers/claude-stubs.js";
import { classification } from "./helpers/claude-stubs.js";

function hit(id: string): RetrievalSearchHit {
  return {
    document: {
      id, kind: "guideline", title: id, text: id, language: "en",
      status: "approved", licenseStatus: "approved", sourceId: id, versionId: "1",
      sourceTitle: id, sourceUrl: `https://example.com/${id}`, sourceAccessedAt: "2026-08-11",
      sourceLocator: id, metadata: {},
    },
    score: 1,
    provenance: { sourceId: id, versionId: "1", title: id, url: `https://example.com/${id}`, accessedAt: "2026-08-11", locator: id },
  };
}

function toolset(search: () => Promise<ToolResult<SearchToolOutput>>): NutriGuardToolset {
  return {
    searchRecipes: search,
    searchGuidelines: search,
    calculateNutrition: async () => ({ ok: false, data: null, errors: [{ code: "test", message: "test" }], provenance: [] }),
    compareWithGuideline: async () => ({ ok: false, data: null, errors: [{ code: "test", message: "test" }], provenance: [] }),
  };
}

function searchOk(id: string): ToolResult<SearchToolOutput> {
  return { ok: true, data: { query: "q", hits: [hit(id)] }, errors: [], provenance: [] };
}

class FakeVectorStore implements VectorStore {
  public async replaceNamespace(_namespace: string, _documents: readonly EmbeddedRetrievalDocument[]): Promise<void> {
    void _namespace; void _documents;
  }
  public async search(): Promise<RetrievalSearchHit[]> {
    return [hit("remote")];
  }
}

test("C1: a request served entirely locally reports no external embedding call", async () => {
  const { collection } = await withRetrievalCollection(async () => {
    const hybrid = new HybridRetrievalTools(
      toolset(async () => { throw new Error("remote must not be reached"); }),
      toolset(async () => searchOk("local")),
      { timeoutMs: 5, circuitBreakerMs: 1_000, now: () => 10_000, observer: recordHybridRetrievalEvent },
    );
    // Force the circuit open so the remote path is skipped entirely.
    (hybrid as unknown as { circuitOpenUntil: number }).circuitOpenUntil = 20_000;
    return hybrid.searchGuidelines({ query: "q" });
  });
  const summary = summarizeRetrieval(collection, true);
  assert.equal(summary.route, "local_only");
  assert.equal(summary.geminiEmbeddingsCalled, false);
  assert.equal(summary.qdrantReturnedResult, null);
  assert.equal(summary.localFallbackSearchUsed, true);
  assert.equal(summary.embeddingCallMs, null, "no embedding stage ran");
  assert.equal(summary.vectorSearchMs, null, "no vector search ran");
});

test("C1: a request that used the external embedding provider and vector store is reported with separate stage timings", async () => {
  const { collection } = await withRetrievalCollection(async () => {
    const provider = new InstrumentedEmbeddingProvider({ modelId: "fake-embedding-model", embed: async (texts) => texts.map(() => [0.1, 0.2]) });
    const store = new InstrumentedVectorStore(new FakeVectorStore());
    const hybrid = new HybridRetrievalTools(
      toolset(async () => {
        await provider.embed(["q"]);
        const hits = await store.search("ns", [0.1, 0.2], { kind: "guideline", limit: 1 });
        return { ok: true, data: { query: "q", hits }, errors: [], provenance: [] };
      }),
      toolset(async () => searchOk("local")),
      { timeoutMs: 5_000, circuitBreakerMs: 1_000, observer: recordHybridRetrievalEvent },
    );
    return hybrid.searchGuidelines({ query: "q" });
  });
  const summary = summarizeRetrieval(collection, true);
  assert.equal(summary.route, "remote_embeddings_and_vector_store");
  assert.equal(summary.geminiEmbeddingsCalled, true);
  assert.equal(summary.qdrantReturnedResult, true);
  assert.equal(summary.localFallbackSearchUsed, false);
  assert.equal(typeof summary.embeddingCallMs, "number");
  assert.equal(typeof summary.vectorSearchMs, "number");
});

test("C1: a remote attempt that returns nothing is reported as a local fallback", async () => {
  const { collection } = await withRetrievalCollection(async () => {
    const hybrid = new HybridRetrievalTools(
      toolset(async () => ({ ok: true, data: { query: "q", hits: [] }, errors: [], provenance: [] })),
      toolset(async () => searchOk("local")),
      { timeoutMs: 5_000, circuitBreakerMs: 1_000, observer: recordHybridRetrievalEvent },
    );
    return hybrid.searchGuidelines({ query: "q" });
  });
  const summary = summarizeRetrieval(collection, true);
  assert.equal(summary.route, "remote_attempted_local_fallback");
  assert.equal(summary.geminiEmbeddingsCalled, true);
  assert.equal(summary.qdrantReturnedResult, false);
  assert.equal(summary.localFallbackSearchUsed, true);
});

test("C1: concurrent requests do not attribute retrieval events to each other", async () => {
  const hybrid = new HybridRetrievalTools(
    toolset(async () => ({ ok: true, data: { query: "q", hits: [] }, errors: [], provenance: [] })),
    toolset(async () => searchOk("local")),
    { timeoutMs: 5_000, circuitBreakerMs: 0, observer: recordHybridRetrievalEvent },
  );
  const [first, second] = await Promise.all([
    withRetrievalCollection(async () => hybrid.searchGuidelines({ query: "a" })),
    withRetrievalCollection(async () => hybrid.searchRecipes({ query: "b" })),
  ]);
  assert.equal(first.collection.hybridEvents.length, 1);
  assert.equal(second.collection.hybridEvents.length, 1);
  assert.equal(first.collection.hybridEvents[0]!.operation, "search_guidelines");
  assert.equal(second.collection.hybridEvents[0]!.operation, "search_recipes");
});

test("C1: the trace records the model used at each stage and a latency breakdown", async () => {
  const layer = new ClaudeLayer({
    config: {
      ...loadClaudeLayerConfig({}),
      classifierEnabled: true,
      classifierModel: "classifier-model-a",
      formatterEnabled: true,
      formatterModel: "formatter-model-b",
    },
    classifierClient: new StubClaudeClient({ model: "classifier-model-a", structured: classification({ intent: "recipe_nutrition" }) }),
    formatterClient: new ScriptedFormatterClient(() => "كشري: 543.7 سعر حراري للحصة.", "formatter-model-b"),
  });
  const agent = await buildGraduationDemoAgent("test", null, layer);
  await agent.invoke({ message: "سعرات الكشري", language: "ar-EG" });
  const trace = agent.claudeLayer.store.latest()!;

  assert.equal(trace.classifierModel, "classifier-model-a");
  assert.equal(trace.formatterModel, "formatter-model-b");
  assert.equal(trace.nluRoute, "rule_based_and_claude_agreement");
  assert.equal(trace.formatterRoute, "formatter_used_validation_passed");
  assert.equal(trace.groundingPassed, true);
  assert.equal(typeof trace.latencies.claudeClassifierMs, "number");
  assert.equal(typeof trace.latencies.claudeFormatterMs, "number");
  assert.equal(typeof trace.latencies.groundingValidationMs, "number");
  assert.equal(typeof trace.latencies.deterministicCalculationMs, "number");
  assert.equal(typeof trace.latencies.totalMs, "number");
  assert.equal(trace.layerVersion, CLAUDE_LAYER_VERSION);
  // A purely local demo build performs no external embedding call.
  assert.equal(trace.geminiEmbeddingsCalled, false);
  assert.equal(trace.retrievalRoute, "not_invoked");
});

test("C1: the trace store is bounded and returns the newest record first", () => {
  const store = new ClaudeObservabilityStore(3);
  for (const intent of ["a", "b", "c", "d"]) {
    store.record(newTrace({ traceId: intent, language: "ar-EG", ruleBasedIntent: intent }));
  }
  assert.equal(store.size(), 3);
  assert.deepEqual(store.list().map((trace) => trace.traceId), ["d", "c", "b"]);
});

test("C2: redaction strips the raw message and rejected payloads even when they were captured", () => {
  const trace = newTrace({ traceId: "t", language: "ar-EG", ruleBasedIntent: "recipe_nutrition" });
  trace.rawMessage = "سعرات الكشري";
  trace.rejectedFormatterOutput = "رقم مخترع 99999";
  trace.rejectedFormatterFacts = "{}";
  const redacted = redactTraceForDebugPanel(trace);
  assert.equal(redacted.rawMessage, undefined);
  assert.equal(redacted.rejectedFormatterOutput, undefined);
  assert.equal(redacted.rejectedFormatterFacts, undefined);
  assert.equal(redacted.traceId, "t", "structural data survives");
});

async function withServer(
  options: Parameters<typeof createNutriGuardHttpServer>[0],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createNutriGuardHttpServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

const baseServerOptions = {
  feedbackStore: new InMemoryPilotFeedbackStore(),
  mode: "test" as const,
  releaseId: "test-release",
  allowedOrigins: [],
  readiness: async () => ({ ready: true, blockers: [] }),
  pilotConsentReference: null,
  privacyNoticeVersion: null,
};

test("C1: the debug route does not exist unless it is explicitly enabled", async () => {
  const agent = await buildGraduationDemoAgent("test", null);
  await withServer({ ...baseServerOptions, agent }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/v1/claude-trace`);
    assert.equal(response.status, 404, "an ordinary deployment cannot discover the route");
  });
});

test("C1: the enabled debug route requires its token and serves redacted traces", async () => {
  const store = new ClaudeObservabilityStore(5);
  const trace = newTrace({ traceId: "trace-1", language: "ar-EG", ruleBasedIntent: "recipe_nutrition" });
  trace.rawMessage = "سعرات الكشري";
  trace.nluRoute = "rule_based_and_claude_agreement";
  trace.classifierModel = "classifier-model-a";
  trace.formatterRoute = "formatter_used_validation_passed";
  trace.groundingPassed = true;
  trace.latencies.totalMs = 42;
  store.record(trace);

  const agent = await buildGraduationDemoAgent("test", null);
  await withServer({
    ...baseServerOptions,
    agent,
    claudeDebugPanel: { enabled: true, token: "debug-token", list: (limit) => store.list(limit) },
  }, async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/internal/v1/claude-trace`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${baseUrl}/internal/v1/claude-trace?limit=5`, { headers: { authorization: "Bearer debug-token" } });
    assert.equal(authorized.status, 200);
    const body = await authorized.json() as { traceCount: number; traces: Array<Record<string, unknown>> };
    assert.equal(body.traceCount, 1);
    const served = body.traces[0]!;
    assert.equal(served.nluRoute, "rule_based_and_claude_agreement");
    assert.equal(served.classifierModel, "classifier-model-a");
    assert.equal(served.groundingPassed, true);
    assert.equal(served.rawMessage, undefined, "the raw user message never reaches the panel");
    assert.ok(!JSON.stringify(body).includes("سعرات الكشري"));
  });
});
