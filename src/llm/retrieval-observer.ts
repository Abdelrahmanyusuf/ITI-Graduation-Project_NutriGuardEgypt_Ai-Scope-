/**
 * Per-request retrieval instrumentation (Part C1).
 *
 * The prior review flagged that a request could not be shown to have used the
 * external embedding provider, the vector store, or the deterministic local
 * corpus. This module closes that gap without touching the retrieval code:
 * `AsyncLocalStorage` scopes events to the request that caused them, so
 * concurrent requests cannot be attributed to each other, and thin decorators
 * time the embedding and vector-search stages separately.
 *
 * Only structural and timing data is captured — never query text, never
 * document content.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  EmbeddedRetrievalDocument,
  EmbeddingProvider,
  RetrievalSearchHit,
  RetrievalSearchOptions,
  VectorStore,
} from "../retrieval/types.js";
import type { HybridRetrievalEvent } from "../runtime/hybrid-retrieval-tools.js";

export interface RetrievalStageEvent {
  stage: "embedding_call" | "vector_search";
  ok: boolean;
  latencyMs: number;
  /** Hit count for a vector search; null for an embedding call. */
  hitCount: number | null;
}

export interface RetrievalCollection {
  hybridEvents: HybridRetrievalEvent[];
  stageEvents: RetrievalStageEvent[];
}

const storage = new AsyncLocalStorage<RetrievalCollection>();

/** Run `operation` with a fresh, request-scoped retrieval collection. */
export async function withRetrievalCollection<T>(
  operation: () => Promise<T>,
): Promise<{ result: T; collection: RetrievalCollection }> {
  const collection: RetrievalCollection = { hybridEvents: [], stageEvents: [] };
  const result = await storage.run(collection, operation);
  return { result, collection };
}

export function recordHybridRetrievalEvent(event: HybridRetrievalEvent): void {
  storage.getStore()?.hybridEvents.push(event);
}

export function recordRetrievalStageEvent(event: RetrievalStageEvent): void {
  storage.getStore()?.stageEvents.push(event);
}

/** Times `embed` calls without altering behaviour or results. */
export class InstrumentedEmbeddingProvider implements EmbeddingProvider {
  public constructor(private readonly inner: EmbeddingProvider) {}

  public get modelId(): string {
    return this.inner.modelId;
  }

  public async embed(texts: readonly string[]): Promise<number[][]> {
    const startedAt = performance.now();
    try {
      const vectors = await this.inner.embed(texts);
      recordRetrievalStageEvent({ stage: "embedding_call", ok: true, latencyMs: Math.round(performance.now() - startedAt), hitCount: null });
      return vectors;
    } catch (error) {
      recordRetrievalStageEvent({ stage: "embedding_call", ok: false, latencyMs: Math.round(performance.now() - startedAt), hitCount: null });
      throw error;
    }
  }
}

/** Times vector `search` calls without altering behaviour or results. */
export class InstrumentedVectorStore implements VectorStore {
  public constructor(private readonly inner: VectorStore) {}

  public replaceNamespace(namespace: string, documents: readonly EmbeddedRetrievalDocument[]): Promise<void> {
    return this.inner.replaceNamespace(namespace, documents);
  }

  public async search(namespace: string, vector: readonly number[], options: RetrievalSearchOptions): Promise<RetrievalSearchHit[]> {
    const startedAt = performance.now();
    try {
      const hits = await this.inner.search(namespace, vector, options);
      recordRetrievalStageEvent({ stage: "vector_search", ok: true, latencyMs: Math.round(performance.now() - startedAt), hitCount: hits.length });
      return hits;
    } catch (error) {
      recordRetrievalStageEvent({ stage: "vector_search", ok: false, latencyMs: Math.round(performance.now() - startedAt), hitCount: null });
      throw error;
    }
  }
}

function sum(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
}

export interface RetrievalSummary {
  route: "not_invoked" | "local_only" | "remote_embeddings_and_vector_store" | "remote_attempted_local_fallback";
  geminiEmbeddingsCalled: boolean;
  qdrantReturnedResult: boolean | null;
  localFallbackSearchUsed: boolean;
  embeddingCallMs: number | null;
  vectorSearchMs: number | null;
  localFallbackSearchMs: number | null;
}

/**
 * Summarize one request's retrieval activity.
 *
 * `searchToolInvoked` comes from the response's own tool trace, so a purely
 * local deployment — which has no hybrid wrapper at all — is still reported as
 * `local_only` rather than `not_invoked`.
 */
export function summarizeRetrieval(collection: RetrievalCollection, searchToolInvoked: boolean): RetrievalSummary {
  const { hybridEvents, stageEvents } = collection;
  const remoteAttempted = hybridEvents.some((event) => event.remoteAttempted);
  const remoteReturnedResult = hybridEvents.some((event) => event.remoteReturnedResult);
  const localFallbackUsed = hybridEvents.some((event) => event.localFallbackUsed);
  const embeddingCallMs = sum(stageEvents.filter((event) => event.stage === "embedding_call").map((event) => event.latencyMs));
  const vectorSearchMs = sum(stageEvents.filter((event) => event.stage === "vector_search").map((event) => event.latencyMs));
  const localFallbackSearchMs = sum(hybridEvents.filter((event) => event.localFallbackUsed).map((event) => event.localLatencyMs ?? 0));

  const route: RetrievalSummary["route"] = remoteAttempted
    ? remoteReturnedResult ? "remote_embeddings_and_vector_store" : "remote_attempted_local_fallback"
    : hybridEvents.length > 0 || searchToolInvoked ? "local_only" : "not_invoked";

  return {
    route,
    geminiEmbeddingsCalled: remoteAttempted,
    qdrantReturnedResult: remoteAttempted ? remoteReturnedResult : null,
    localFallbackSearchUsed: localFallbackUsed,
    embeddingCallMs,
    vectorSearchMs,
    localFallbackSearchMs,
  };
}
