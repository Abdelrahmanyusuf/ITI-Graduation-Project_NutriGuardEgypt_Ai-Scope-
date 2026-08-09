import type {
  EmbeddedRetrievalDocument,
  RetrievalDocument,
  RetrievalSearchHit,
  RetrievalSearchOptions,
  VectorStore,
} from "./types.js";

type FetchLike = typeof fetch;

export interface QdrantVectorStoreOptions {
  baseUrl: string;
  collection: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
}

interface QdrantSearchResponse {
  result?: Array<{ score?: number; payload?: unknown }>;
}

interface QdrantCollectionResponse {
  result?: { config?: { params?: { vectors?: { size?: number } } } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDocument(payload: unknown): RetrievalDocument | null {
  if (!isObject(payload) || !isObject(payload.document)) return null;
  const document = payload.document;
  if (
    typeof document.id !== "string" ||
    (document.kind !== "recipe" && document.kind !== "guideline") ||
    typeof document.title !== "string" ||
    typeof document.text !== "string" ||
    (document.language !== "ar-EG" && document.language !== "ar" && document.language !== "en") ||
    document.status !== "approved" ||
    document.licenseStatus !== "approved" ||
    typeof document.sourceId !== "string" ||
    typeof document.versionId !== "string" ||
    typeof document.sourceTitle !== "string" ||
    typeof document.sourceUrl !== "string" ||
    typeof document.sourceAccessedAt !== "string" ||
    typeof document.sourceLocator !== "string" ||
    !isObject(document.metadata)
  ) return null;
  const egyptianVerificationStatus = document.egyptianVerificationStatus;
  if (
    egyptianVerificationStatus !== undefined &&
    egyptianVerificationStatus !== "verified" &&
    egyptianVerificationStatus !== "candidate" &&
    egyptianVerificationStatus !== "pending" &&
    egyptianVerificationStatus !== "rejected"
  ) return null;
  if (document.kind === "recipe" && egyptianVerificationStatus !== "verified") return null;
  return document as unknown as RetrievalDocument;
}

export class QdrantVectorStore implements VectorStore {
  private readonly baseUrl: string;
  private readonly collection: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;

  public constructor(options: QdrantVectorStoreOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.collection = options.collection.trim();
    this.apiKey = options.apiKey?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (this.baseUrl === "" || this.collection === "") throw new Error("Qdrant base URL and collection are required");
    try {
      const url = new URL(this.baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      throw new Error("Qdrant base URL must be a valid http(s) URL");
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { "api-key": this.apiKey } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`Qdrant ${init.method ?? "GET"} ${path} returned HTTP ${response.status}`);
    return response;
  }

  private async ensureCollection(dimension: number): Promise<void> {
    const existing = await this.fetchImpl(`${this.baseUrl}/collections/${encodeURIComponent(this.collection)}`, {
      headers: this.apiKey ? { "api-key": this.apiKey } : {},
    });
    if (existing.ok) {
      const body = (await existing.json()) as QdrantCollectionResponse;
      const existingSize = body.result?.config?.params?.vectors?.size;
      if (typeof existingSize === "number" && existingSize !== dimension) {
        throw new Error(`Qdrant collection dimension ${existingSize} does not match embedding dimension ${dimension}`);
      }
      return;
    }
    if (existing.status !== 404) throw new Error(`Qdrant collection lookup returned HTTP ${existing.status}`);
    await this.request(`/collections/${encodeURIComponent(this.collection)}`, {
      method: "PUT",
      body: JSON.stringify({ vectors: { size: dimension, distance: "Cosine" } }),
    });
  }

  public async replaceNamespace(namespace: string, documents: readonly EmbeddedRetrievalDocument[]): Promise<void> {
    if (namespace.trim() === "") throw new Error("vector namespace is required");
    if (documents.length === 0) throw new Error("refusing to replace a namespace with an empty corpus");
    const dimension = documents[0]?.vector.length ?? 0;
    if (dimension === 0 || documents.some((document) => document.vector.length !== dimension)) {
      throw new Error("all Qdrant vectors must share a non-zero dimension");
    }
    await this.ensureCollection(dimension);
    await this.request(`/collections/${encodeURIComponent(this.collection)}/points?wait=true`, {
      method: "PUT",
      body: JSON.stringify({
        points: documents.map((document) => ({
          id: document.pointId,
          vector: document.vector,
          payload: {
            namespace,
            kind: document.kind,
            status: document.status,
            licenseStatus: document.licenseStatus,
            egyptianVerificationStatus: document.egyptianVerificationStatus ?? null,
            document: {
              id: document.id,
              kind: document.kind,
              title: document.title,
              text: document.text,
              language: document.language,
              status: document.status,
              licenseStatus: document.licenseStatus,
              egyptianVerificationStatus: document.egyptianVerificationStatus,
              sourceId: document.sourceId,
              versionId: document.versionId,
              sourceTitle: document.sourceTitle,
              sourceUrl: document.sourceUrl,
              sourceAccessedAt: document.sourceAccessedAt,
              sourceLocator: document.sourceLocator,
              metadata: document.metadata,
            },
          },
        })),
      }),
    });
    await this.request(`/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`, {
      method: "POST",
      body: JSON.stringify({
        filter: {
          must: [{ key: "namespace", match: { value: namespace } }],
          must_not: [{ has_id: documents.map((document) => document.pointId) }],
        },
      }),
    });
  }

  public async search(namespace: string, vector: readonly number[], options: RetrievalSearchOptions): Promise<RetrievalSearchHit[]> {
    if (namespace.trim() === "") throw new Error("vector namespace is required");
    if (vector.length === 0 || vector.some((value) => !Number.isFinite(value)) || vector.every((value) => value === 0)) {
      throw new Error("search vector must be finite, non-empty and non-zero");
    }
    if (options.limit < 1 || !Number.isInteger(options.limit)) throw new Error("search limit must be a positive integer");
    if (options.minScore !== undefined && (!Number.isFinite(options.minScore) || options.minScore < -1 || options.minScore > 1)) {
      throw new Error("search minScore must be between -1 and 1");
    }
    const must: unknown[] = [
      { key: "namespace", match: { value: namespace } },
      { key: "kind", match: { value: options.kind } },
      { key: "status", match: { value: "approved" } },
      { key: "licenseStatus", match: { value: "approved" } },
    ];
    if (options.kind === "recipe") must.push({ key: "egyptianVerificationStatus", match: { value: "verified" } });
    const response = await this.request(`/collections/${encodeURIComponent(this.collection)}/points/search`, {
      method: "POST",
      body: JSON.stringify({ vector, limit: options.limit, score_threshold: options.minScore, filter: { must }, with_payload: true }),
    });
    const body = (await response.json()) as QdrantSearchResponse;
    return (body.result ?? []).flatMap((entry) => {
      const document = parseDocument(entry.payload);
      if (!document || typeof entry.score !== "number" || !Number.isFinite(entry.score)) return [];
      return [{
        document,
        score: entry.score,
        provenance: {
          sourceId: document.sourceId,
          versionId: document.versionId,
          title: document.sourceTitle,
          url: document.sourceUrl,
          accessedAt: document.sourceAccessedAt,
          locator: document.sourceLocator,
        },
      }];
    });
  }
}
