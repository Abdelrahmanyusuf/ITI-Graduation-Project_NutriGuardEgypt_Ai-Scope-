import { cosineSimilarity, validateEmbeddingBatch } from "./embeddings.js";
import type { EmbeddingProvider } from "./types.js";

export interface EmbeddingBenchmarkDocument {
  id: string;
  text: string;
}

export interface EmbeddingBenchmarkQuery {
  id: string;
  text: string;
  relevantDocumentIds: string[];
}

export interface EmbeddingBenchmarkDataset {
  schemaVersion: "1.0";
  title: string;
  language: "ar-EG" | "ar" | "mixed";
  synthetic: boolean;
  documents: EmbeddingBenchmarkDocument[];
  queries: EmbeddingBenchmarkQuery[];
}

export interface EmbeddingModelBenchmarkResult {
  modelId: string;
  dimension: number | null;
  recallAtK: number | null;
  meanReciprocalRank: number | null;
  queryCount: number;
  error: string | null;
}

export interface EmbeddingBenchmarkReport {
  schemaVersion: "1.0";
  datasetTitle: string;
  datasetSynthetic: boolean;
  k: number;
  results: EmbeddingModelBenchmarkResult[];
  selectedModelId: string | null;
  selectionStatus: "selected" | "synthetic_dataset_only" | "threshold_not_met" | "tie_requires_review" | "all_models_failed";
  minimumRecallAtK: number;
}

function validateDataset(dataset: EmbeddingBenchmarkDataset): void {
  if (dataset.schemaVersion !== "1.0") throw new Error("unsupported embedding benchmark schemaVersion");
  if (dataset.documents.length === 0 || dataset.queries.length === 0) throw new Error("benchmark needs documents and queries");
  const documentIds = new Set<string>();
  for (const document of dataset.documents) {
    if (document.id.trim() === "" || document.text.trim() === "") throw new Error("benchmark documents require id and text");
    if (documentIds.has(document.id)) throw new Error(`duplicate benchmark document id: ${document.id}`);
    documentIds.add(document.id);
  }
  const queryIds = new Set<string>();
  for (const query of dataset.queries) {
    if (query.id.trim() === "" || query.text.trim() === "" || query.relevantDocumentIds.length === 0) {
      throw new Error("benchmark queries require id, text and relevantDocumentIds");
    }
    if (queryIds.has(query.id)) throw new Error(`duplicate benchmark query id: ${query.id}`);
    queryIds.add(query.id);
    for (const id of query.relevantDocumentIds) if (!documentIds.has(id)) throw new Error(`query ${query.id} references unknown document ${id}`);
  }
}

async function benchmarkOne(
  provider: EmbeddingProvider,
  dataset: EmbeddingBenchmarkDataset,
  k: number
): Promise<EmbeddingModelBenchmarkResult> {
  try {
    const documentVectors = await provider.embed(dataset.documents.map((document) => document.text));
    const queryVectors = await provider.embed(dataset.queries.map((query) => query.text));
    const dimension = validateEmbeddingBatch(documentVectors, dataset.documents.length);
    if (validateEmbeddingBatch(queryVectors, dataset.queries.length) !== dimension) throw new Error("query/document dimensions differ");
    let recallTotal = 0;
    let reciprocalRankTotal = 0;
    dataset.queries.forEach((query, queryIndex) => {
      const relevant = new Set(query.relevantDocumentIds);
      const ranked = dataset.documents
        .map((document, documentIndex) => ({
          id: document.id,
          score: cosineSimilarity(queryVectors[queryIndex] ?? [], documentVectors[documentIndex] ?? []),
        }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      const firstRelevant = ranked.findIndex((entry) => relevant.has(entry.id));
      const relevantInTopK = ranked.slice(0, k).filter((entry) => relevant.has(entry.id)).length;
      recallTotal += relevantInTopK / relevant.size;
      if (firstRelevant >= 0) reciprocalRankTotal += 1 / (firstRelevant + 1);
    });
    return {
      modelId: provider.modelId,
      dimension,
      recallAtK: recallTotal / dataset.queries.length,
      meanReciprocalRank: reciprocalRankTotal / dataset.queries.length,
      queryCount: dataset.queries.length,
      error: null,
    };
  } catch (error) {
    return {
      modelId: provider.modelId,
      dimension: null,
      recallAtK: null,
      meanReciprocalRank: null,
      queryCount: dataset.queries.length,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function benchmarkEmbeddingModels(
  providers: readonly EmbeddingProvider[],
  dataset: EmbeddingBenchmarkDataset,
  options: { k?: number; minimumRecallAtK?: number; allowSyntheticSelection?: boolean } = {}
): Promise<EmbeddingBenchmarkReport> {
  validateDataset(dataset);
  if (providers.length < 2 || providers.length > 3) throw new Error("Step 8 requires exactly two or three embedding models");
  if (new Set(providers.map((provider) => provider.modelId)).size !== providers.length) throw new Error("embedding model IDs must be unique");
  const k = options.k ?? 5;
  const minimumRecallAtK = options.minimumRecallAtK ?? 0.9;
  if (!Number.isInteger(k) || k < 1) throw new Error("benchmark k must be a positive integer");
  if (minimumRecallAtK < 0 || minimumRecallAtK > 1) throw new Error("minimumRecallAtK must be between 0 and 1");
  const results = await Promise.all(providers.map((provider) => benchmarkOne(provider, dataset, k)));
  const successful = results
    .filter((result): result is EmbeddingModelBenchmarkResult & { recallAtK: number; meanReciprocalRank: number } =>
      result.error === null && result.recallAtK !== null && result.meanReciprocalRank !== null)
    .sort((a, b) => b.recallAtK - a.recallAtK || b.meanReciprocalRank - a.meanReciprocalRank || a.modelId.localeCompare(b.modelId));
  let selectedModelId: string | null = null;
  let selectionStatus: EmbeddingBenchmarkReport["selectionStatus"] = "all_models_failed";
  if (successful.length > 0) {
    const best = successful[0];
    if (best.recallAtK < minimumRecallAtK) selectionStatus = "threshold_not_met";
    else {
      const tied = successful.filter((entry) => entry.recallAtK === best.recallAtK && entry.meanReciprocalRank === best.meanReciprocalRank);
      if (tied.length > 1) selectionStatus = "tie_requires_review";
      else if (dataset.synthetic && options.allowSyntheticSelection !== true) {
        selectionStatus = "synthetic_dataset_only";
      } else {
        selectionStatus = "selected";
        selectedModelId = best.modelId;
      }
    }
  }
  return {
    schemaVersion: "1.0",
    datasetTitle: dataset.title,
    datasetSynthetic: dataset.synthetic,
    k,
    results,
    selectedModelId,
    selectionStatus,
    minimumRecallAtK,
  };
}
