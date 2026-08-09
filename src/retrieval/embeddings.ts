import type { EmbeddingProvider } from "./types.js";

export interface OpenAICompatibleEmbeddingOptions {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface EmbeddingResponse {
  data?: Array<{ index?: number; embedding?: unknown }>;
}

function validateVector(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} is not a non-empty vector`);
  const vector = value.map((entry) => Number(entry));
  if (vector.some((entry) => !Number.isFinite(entry))) throw new Error(`${label} contains a non-finite value`);
  if (vector.every((entry) => entry === 0)) throw new Error(`${label} is an all-zero vector`);
  return vector;
}

export function validateEmbeddingBatch(vectors: readonly number[][], expectedCount: number): number {
  if (vectors.length !== expectedCount) {
    throw new Error(`embedding provider returned ${vectors.length} vectors for ${expectedCount} texts`);
  }
  let dimension = 0;
  vectors.forEach((value, index) => {
    const vector = validateVector(value, `embedding[${index}]`);
    if (dimension === 0) dimension = vector.length;
    if (vector.length !== dimension) throw new Error("embedding provider returned inconsistent dimensions");
  });
  return dimension;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  public readonly modelId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: OpenAICompatibleEmbeddingOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (baseUrl === "") throw new Error("embedding baseUrl is required");
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      throw new Error("embedding baseUrl must be a valid http(s) URL");
    }
    if (options.modelId.trim() === "") throw new Error("embedding modelId is required");
    this.baseUrl = baseUrl;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.modelId = options.modelId.trim();
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("embedding timeoutMs must be positive");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.some((text) => text.trim() === "")) throw new Error("embedding text must be non-empty");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.modelId, input: texts }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`embedding endpoint returned HTTP ${response.status}`);
      const body = (await response.json()) as EmbeddingResponse;
      if (!Array.isArray(body.data)) throw new Error("embedding endpoint response has no data array");
      const indices = body.data.map((entry) => entry.index);
      if (indices.some((index) => !Number.isInteger(index) || (index ?? -1) < 0 || (index ?? -1) >= texts.length)) {
        throw new Error("embedding endpoint returned an invalid index");
      }
      if (new Set(indices).size !== texts.length) throw new Error("embedding endpoint returned duplicate or missing indices");
      const ordered = [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const vectors = ordered.map((entry, index) => validateVector(entry.embedding, `embedding[${index}]`));
      validateEmbeddingBatch(vectors, texts.length);
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) throw new Error("cosine vectors must have the same non-zero dimension");
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("cosine vectors must contain finite numbers");
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) throw new Error("cosine vectors must not be all zero");
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
