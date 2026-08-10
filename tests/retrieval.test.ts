import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkEmbeddingModels, type EmbeddingBenchmarkDataset } from "../src/retrieval/benchmark.js";
import { OpenAICompatibleEmbeddingProvider } from "../src/retrieval/embeddings.js";
import { ingestRetrievalCorpus, type RetrievalCorpus } from "../src/retrieval/ingestion.js";
import { QdrantVectorStore } from "../src/retrieval/qdrant.js";
import type { EmbeddingProvider } from "../src/retrieval/types.js";
import { InMemoryVectorStore } from "../src/retrieval/vector-store.js";

class MappedEmbeddingProvider implements EmbeddingProvider {
  public constructor(public readonly modelId: string, private readonly values: ReadonlyMap<string, number[]>) {}

  public async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => [...(this.values.get(text) ?? [0.1, 0.1, 0.1])]);
  }
}

test("OpenAI-compatible embeddings accept Gemini's ordered response without index fields", async () => {
  const provider = new OpenAICompatibleEmbeddingProvider({
    baseUrl: "https://embedding.example.test/v1",
    modelId: "synthetic-gemini-compatible",
    fetchImpl: async () => Response.json({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }),
  });
  assert.deepEqual(await provider.embed(["first", "second"]), [[1, 0], [0, 1]]);
});

test("OpenAI-compatible embeddings accept Gemini's omitted protobuf default index zero", async () => {
  const provider = new OpenAICompatibleEmbeddingProvider({
    baseUrl: "https://embedding.example.test/v1",
    modelId: "synthetic-gemini-compatible",
    fetchImpl: async () => Response.json({ data: [{ embedding: [1, 0] }, { index: 1, embedding: [0, 1] }] }),
  });
  assert.deepEqual(await provider.embed(["first", "second"]), [[1, 0], [0, 1]]);
});

test("OpenAI-compatible embeddings reject ambiguous duplicate indexing", async () => {
  const provider = new OpenAICompatibleEmbeddingProvider({
    baseUrl: "https://embedding.example.test/v1",
    modelId: "synthetic-invalid",
    fetchImpl: async () => Response.json({ data: [{ index: 0, embedding: [1, 0] }, { embedding: [0, 1] }] }),
  });
  await assert.rejects(() => provider.embed(["first", "second"]), /duplicate or missing indices/);
});

test("OpenAI-compatible embeddings split large corpora into ordered bounded batches", async () => {
  const batchSizes: number[] = [];
  const requestedDimensions: number[] = [];
  const provider = new OpenAICompatibleEmbeddingProvider({
    baseUrl: "https://embedding.example.test/v1",
    modelId: "synthetic-batched",
    batchSize: 2,
    dimensions: 768,
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { input: string[]; dimensions?: number };
      batchSizes.push(request.input.length);
      requestedDimensions.push(request.dimensions ?? 0);
      return Response.json({ data: request.input.map((text, index) => ({ index: index || undefined, embedding: [Number(text), 1] })) });
    },
  });
  assert.deepEqual(await provider.embed(["1", "2", "3", "4", "5"]), [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]]);
  assert.deepEqual(batchSizes, [2, 2, 1]);
  assert.deepEqual(requestedDimensions, [768, 768, 768]);
});

test("OpenAI-compatible embeddings retry only bounded transient provider failures", async () => {
  let attempts = 0;
  const provider = new OpenAICompatibleEmbeddingProvider({
    baseUrl: "https://embedding.example.test/v1",
    modelId: "synthetic-retry",
    maxRetries: 2,
    retryBaseDelayMs: 100,
    fetchImpl: async () => {
      attempts += 1;
      return attempts < 3 ? new Response("", { status: 429 }) : Response.json({ data: [{ embedding: [1, 1] }] });
    },
  });
  assert.deepEqual(await provider.embed(["one"]), [[1, 1]]);
  assert.equal(attempts, 3);
});

const dataset: EmbeddingBenchmarkDataset = {
  schemaVersion: "1.0",
  title: "SYNTHETIC TEST ONLY",
  language: "mixed",
  synthetic: true,
  documents: [
    { id: "doc-a", text: "koshari document" },
    { id: "doc-b", text: "molokhia document" },
    { id: "doc-c", text: "sodium document" },
  ],
  queries: [
    { id: "q-a", text: "عايز كشري", relevantDocumentIds: ["doc-a"] },
    { id: "q-b", text: "طريقة ملوخية", relevantDocumentIds: ["doc-b"] },
    { id: "q-c", text: "إرشادات الصوديوم", relevantDocumentIds: ["doc-c"] },
  ],
};

const strongVectors = new Map<string, number[]>([
  ["koshari document", [1, 0, 0]], ["molokhia document", [0, 1, 0]], ["sodium document", [0, 0, 1]],
  ["عايز كشري", [1, 0, 0]], ["طريقة ملوخية", [0, 1, 0]], ["إرشادات الصوديوم", [0, 0, 1]],
]);

test("Step 8 benchmark compares 2–3 models and selects the unique model meeting the threshold", async () => {
  const weakVectors = new Map<string, number[]>(strongVectors);
  weakVectors.set("عايز كشري", [0, 1, 0]);
  weakVectors.set("طريقة ملوخية", [1, 0, 0]);
  const report = await benchmarkEmbeddingModels(
    [new MappedEmbeddingProvider("synthetic-strong", strongVectors), new MappedEmbeddingProvider("synthetic-weak", weakVectors)],
    dataset,
    { k: 1, minimumRecallAtK: 0.9, allowSyntheticSelection: true }
  );
  assert.equal(report.selectionStatus, "selected");
  assert.equal(report.selectedModelId, "synthetic-strong");
  assert.equal(report.results.find((result) => result.modelId === "synthetic-strong")?.recallAtK, 1);
});

test("Step 8 benchmark does not silently choose tied models", async () => {
  const report = await benchmarkEmbeddingModels(
    [new MappedEmbeddingProvider("model-a", strongVectors), new MappedEmbeddingProvider("model-b", strongVectors)],
    dataset,
    { k: 1, allowSyntheticSelection: true }
  );
  assert.equal(report.selectionStatus, "tie_requires_review");
  assert.equal(report.selectedModelId, null);
});

test("Step 8 Recall@K measures all relevant documents rather than only one hit", async () => {
  const multiRelevant: EmbeddingBenchmarkDataset = {
    ...dataset,
    documents: [
      { id: "relevant-a", text: "relevant a" },
      { id: "relevant-b", text: "relevant b" },
      { id: "other", text: "other" },
    ],
    queries: [{ id: "multi", text: "multi query", relevantDocumentIds: ["relevant-a", "relevant-b"] }],
  };
  const vectors = new Map<string, number[]>([
    ["relevant a", [1, 0]], ["relevant b", [0.8, 0.2]], ["other", [0, 1]], ["multi query", [1, 0]],
  ]);
  const report = await benchmarkEmbeddingModels(
    [new MappedEmbeddingProvider("model-a", vectors), new MappedEmbeddingProvider("model-b", vectors)],
    multiRelevant,
    { k: 1, minimumRecallAtK: 0.5, allowSyntheticSelection: true }
  );
  assert.equal(report.results[0]?.recallAtK, 0.5);
});

test("Step 8 synthetic evaluation can test code but cannot select a production model", async () => {
  const weakVectors = new Map<string, number[]>(strongVectors);
  weakVectors.set("عايز كشري", [0, 1, 0]);
  weakVectors.set("طريقة ملوخية", [1, 0, 0]);
  const report = await benchmarkEmbeddingModels(
    [new MappedEmbeddingProvider("model-a", strongVectors), new MappedEmbeddingProvider("model-b", weakVectors)],
    dataset,
    { k: 1 }
  );
  assert.equal(report.selectionStatus, "synthetic_dataset_only");
  assert.equal(report.selectedModelId, null);
});

function approvedCorpus(): RetrievalCorpus {
  return {
    schemaVersion: "1.0",
    corpusId: "TEST-CORPUS",
    documents: [
      {
        id: "TEST-RECIPE", kind: "recipe", title: "Synthetic koshari", text: "Test recipe retrieval text", language: "en",
        status: "approved", licenseStatus: "approved", egyptianVerificationStatus: "verified",
        sourceId: "TEST-SOURCE", versionId: "TEST-V1", sourceTitle: "SYNTHETIC TEST ONLY", sourceUrl: "https://example.test/recipe",
        sourceAccessedAt: "2026-08-09", sourceLocator: "synthetic recipe fixture",
        metadata: { recipeId: "TEST-RECIPE" },
      },
      {
        id: "TEST-GUIDELINE", kind: "guideline", title: "Synthetic sodium guidance", text: "Fictional test guideline prose", language: "en",
        status: "approved", licenseStatus: "approved",
        sourceId: "TEST-GUIDE", versionId: "TEST-V1", sourceTitle: "SYNTHETIC TEST ONLY", sourceUrl: "https://example.test/guideline",
        sourceAccessedAt: "2026-08-09", sourceLocator: "synthetic guideline fixture",
        metadata: { chunkId: "TEST-CHUNK" },
      },
    ],
  };
}

test("Step 9 ingestion is deterministic and searches only the requested approved kind", async () => {
  const store = new InMemoryVectorStore();
  const provider = new MappedEmbeddingProvider("synthetic-model", new Map([
    ["Synthetic koshari\n\nTest recipe retrieval text", [1, 0]],
    ["Synthetic sodium guidance\n\nFictional test guideline prose", [0, 1]],
    ["كشري", [1, 0]],
  ]));
  const first = await ingestRetrievalCorpus(approvedCorpus(), provider, store);
  const second = await ingestRetrievalCorpus(approvedCorpus(), provider, store);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.recipeCount, 1);
  assert.equal(first.guidelineCount, 1);
  const hits = await store.search("TEST-CORPUS", (await provider.embed(["كشري"]))[0] ?? [], { kind: "recipe", limit: 5 });
  assert.deepEqual(hits.map((hit) => hit.document.id), ["TEST-RECIPE"]);
});

test("Step 9 ingestion rejects unapproved and non-Egyptian recipe records", async () => {
  const corpus = approvedCorpus();
  corpus.documents[0] = { ...corpus.documents[0]!, status: "pending" };
  await assert.rejects(() => ingestRetrievalCorpus(corpus, new MappedEmbeddingProvider("test", strongVectors), new InMemoryVectorStore()), /not backed by an approved/);
  const candidate = approvedCorpus();
  candidate.documents[0] = { ...candidate.documents[0]!, egyptianVerificationStatus: "candidate" };
  await assert.rejects(() => ingestRetrievalCorpus(candidate, new MappedEmbeddingProvider("test", strongVectors), new InMemoryVectorStore()), /not human-verified/);
  const incompleteProvenance = approvedCorpus();
  incompleteProvenance.documents[0] = { ...incompleteProvenance.documents[0]!, sourceLocator: "" };
  await assert.rejects(() => ingestRetrievalCorpus(incompleteProvenance, new MappedEmbeddingProvider("test", strongVectors), new InMemoryVectorStore()), /complete provenance/);
});

test("Qdrant adapter replaces a namespace and sends approved-only search filters", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/collections/test_collection") && (!init || init.method === undefined)) return new Response("", { status: 404 });
    if (url.endsWith("/points/search")) {
      const forgedCandidate = { ...approvedCorpus().documents[0], egyptianVerificationStatus: "candidate" };
      return Response.json({ result: [{ score: 0.99, payload: { document: forgedCandidate } }] });
    }
    return Response.json({ result: true });
  };
  const store = new QdrantVectorStore({ baseUrl: "https://qdrant.example.test", collection: "test_collection", fetchImpl: fakeFetch });
  const memory = new InMemoryVectorStore();
  const provider = new MappedEmbeddingProvider("synthetic-model", new Map([
    ["Synthetic koshari\n\nTest recipe retrieval text", [1, 0]],
    ["Synthetic sodium guidance\n\nFictional test guideline prose", [0, 1]],
  ]));
  const corpus = approvedCorpus();
  await ingestRetrievalCorpus(corpus, provider, memory);
  const vectors = await provider.embed(corpus.documents.map((document) => `${document.title}\n\n${document.text}`));
  await store.replaceNamespace("TEST-CORPUS", corpus.documents.map((document, index) => ({
    ...document, pointId: `00000000-0000-5000-8000-00000000000${index}`, contentHash: "a".repeat(64), embeddingModel: provider.modelId, vector: vectors[index] ?? [],
  })));
  const indexBodies = requests
    .filter((request) => request.url.includes("/index?wait=true"))
    .map((request) => JSON.parse(String(request.init?.body)) as { field_name: string; field_schema: string });
  assert.deepEqual(indexBodies, ["namespace", "kind", "status", "licenseStatus", "egyptianVerificationStatus"].map((field_name) => ({ field_name, field_schema: "keyword" })));
  const hits = await store.search("TEST-CORPUS", [1, 0], { kind: "recipe", limit: 5 });
  assert.deepEqual(hits, [], "client-side validation also drops a forged non-verified recipe response");
  const searchBody = JSON.parse(String(requests.find((request) => request.url.endsWith("/points/search"))?.init?.body)) as { filter: { must: unknown[] } };
  assert.ok(searchBody.filter.must.length >= 5, "recipe filter includes namespace, kind, source/license approval and verified Egyptian status");
});
