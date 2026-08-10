import type { EmbeddingProvider } from "./types.js";

export interface OpenAICompatibleEmbeddingOptions {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  timeoutMs?: number;
  batchSize?: number;
  batchDelayMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  dimensions?: number;
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
  private readonly batchSize: number;
  private readonly batchDelayMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly dimensions: number | undefined;
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
    this.batchSize = options.batchSize ?? 32;
    this.batchDelayMs = options.batchDelayMs ?? 0;
    this.maxRetries = options.maxRetries ?? 0;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    this.dimensions = options.dimensions;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("embedding timeoutMs must be positive");
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 2_048) throw new Error("embedding batchSize must be an integer between 1 and 2048");
    if (!Number.isFinite(this.batchDelayMs) || this.batchDelayMs < 0 || this.batchDelayMs > 60_000) throw new Error("embedding batchDelayMs must be between 0 and 60000");
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 8) throw new Error("embedding maxRetries must be an integer between 0 and 8");
    if (!Number.isFinite(this.retryBaseDelayMs) || this.retryBaseDelayMs < 100 || this.retryBaseDelayMs > 60_000) throw new Error("embedding retryBaseDelayMs must be between 100 and 60000");
    if (this.dimensions !== undefined && (!Number.isInteger(this.dimensions) || this.dimensions < 1 || this.dimensions > 65_536)) throw new Error("embedding dimensions must be an integer between 1 and 65536");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.some((text) => text.trim() === "")) throw new Error("embedding text must be non-empty");
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      if (start > 0 && this.batchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.batchDelayMs));
      vectors.push(...await this.embedBatch(texts.slice(start, start + this.batchSize)));
    }
    validateEmbeddingBatch(vectors, texts.length);
    return vectors;
  }

  private async embedBatch(texts: readonly string[]): Promise<number[][]> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestBatch(texts);
      } catch (error) {
        const retryable = error instanceof Error && /HTTP (?:429|503)$/.test(error.message);
        if (!retryable || attempt >= this.maxRetries) throw error;
        const delayMs = Math.min(60_000, this.retryBaseDelayMs * (2 ** attempt));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private async requestBatch(texts: readonly string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.modelId, input: texts, ...(this.dimensions ? { dimensions: this.dimensions } : {}) }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`embedding endpoint returned HTTP ${response.status}`);
      const body = (await response.json()) as EmbeddingResponse;
      if (!Array.isArray(body.data)) throw new Error("embedding endpoint response has no data array");
      if (body.data.length !== texts.length) {
        throw new Error(`embedding provider returned ${body.data.length} vectors for ${texts.length} texts`);
      }
      const indices = body.data.map((entry) => entry.index);
      const allIndicesOmitted = indices.every((index) => index === undefined);
      const normalizedIndices = indices.map((index) => index ?? 0);
      if (!allIndicesOmitted) {
        if (normalizedIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= texts.length)) {
          throw new Error("embedding endpoint returned an invalid index");
        }
        if (new Set(normalizedIndices).size !== texts.length) throw new Error("embedding endpoint returned duplicate or missing indices");
      }
      // Gemini's protobuf-backed OpenAI endpoint omits the default numeric
      // value for index 0. Other compatible endpoints may omit all indices
      // while preserving order. Both complete shapes are deterministic;
      // duplicates, gaps and out-of-range indices still fail closed.
      const ordered = allIndicesOmitted
        ? [...body.data]
        : [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
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
