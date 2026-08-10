import assert from "node:assert/strict";
import test from "node:test";
import { HybridRetrievalTools } from "../src/runtime/hybrid-retrieval-tools.js";
import type { NutriGuardToolset, SearchToolOutput, ToolResult } from "../src/tools/nutriguard-tools.js";

function searchResult(source: "remote" | "local" | "empty"): ToolResult<SearchToolOutput> {
  if (source === "empty") return { ok: true, data: { query: "q", hits: [] }, errors: [], provenance: [] };
  return {
    ok: true,
    data: {
      query: "q",
      hits: [{
        document: {
          id: source, kind: "guideline", title: source, text: source, language: "en",
          status: "approved", licenseStatus: "approved", sourceId: source, versionId: "1",
          sourceTitle: source, sourceUrl: `https://example.com/${source}`, sourceAccessedAt: "2026-08-11",
          sourceLocator: source, metadata: {},
        },
        score: 1,
        provenance: { sourceId: source, versionId: "1", title: source, url: `https://example.com/${source}`, accessedAt: "2026-08-11", locator: source },
      }],
    },
    errors: [],
    provenance: [],
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

test("hybrid retrieval uses a healthy remote result", async () => {
  let localCalls = 0;
  const hybrid = new HybridRetrievalTools(
    toolset(async () => searchResult("remote")),
    toolset(async () => { localCalls += 1; return searchResult("local"); }),
    { timeoutMs: 50, circuitBreakerMs: 1_000 },
  );
  const result = await hybrid.searchGuidelines({ query: "q" });
  assert.equal(result.ok && result.data.hits[0]?.document.id, "remote");
  assert.equal(localCalls, 0);
  assert.equal(hybrid.state().mode, "remote_available");
});

test("hybrid retrieval falls back on remote errors and opens the circuit", async () => {
  let now = 1_000;
  let remoteCalls = 0;
  let localCalls = 0;
  const remote = toolset(async () => {
    remoteCalls += 1;
    return { ok: false, data: null, errors: [{ code: "retrieval_failed", message: "unavailable" }], provenance: [] };
  });
  const local = toolset(async () => { localCalls += 1; return searchResult("local"); });
  const hybrid = new HybridRetrievalTools(remote, local, { timeoutMs: 50, circuitBreakerMs: 500, now: () => now });

  assert.equal((await hybrid.searchRecipes({ query: "q" })).ok, true);
  assert.equal((await hybrid.searchRecipes({ query: "q" })).ok, true);
  assert.equal(remoteCalls, 1);
  assert.equal(localCalls, 2);
  assert.equal(hybrid.state().mode, "local_fallback");

  now = 1_501;
  await hybrid.searchRecipes({ query: "q" });
  assert.equal(remoteCalls, 2, "remote is retried after the cooldown");
});

test("hybrid retrieval falls back after a bounded timeout", async () => {
  const never = new Promise<ToolResult<SearchToolOutput>>(() => undefined);
  const hybrid = new HybridRetrievalTools(
    toolset(() => never),
    toolset(async () => searchResult("local")),
    { timeoutMs: 5, circuitBreakerMs: 1_000 },
  );
  const started = Date.now();
  const result = await hybrid.searchGuidelines({ query: "q" });
  assert.equal(result.ok && result.data.hits[0]?.document.id, "local");
  assert.equal(Date.now() - started < 250, true);
  assert.equal(hybrid.state().lastFailure, "timeout");
});

test("an empty remote search uses the local corpus without declaring an outage", async () => {
  const hybrid = new HybridRetrievalTools(
    toolset(async () => searchResult("empty")),
    toolset(async () => searchResult("local")),
    { timeoutMs: 50, circuitBreakerMs: 1_000 },
  );
  const result = await hybrid.searchRecipes({ query: "q" });
  assert.equal(result.ok && result.data.hits[0]?.document.id, "local");
  assert.equal(hybrid.state().mode, "remote_available");
  assert.equal(hybrid.state().lastFailure, null);
});
