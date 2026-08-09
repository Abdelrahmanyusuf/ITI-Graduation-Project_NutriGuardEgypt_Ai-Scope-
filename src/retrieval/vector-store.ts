import type {
  EmbeddedRetrievalDocument,
  RetrievalDocument,
  RetrievalSearchHit,
  RetrievalSearchOptions,
  VectorStore,
} from "./types.js";
import { cosineSimilarity } from "./embeddings.js";

function publicDocument(document: EmbeddedRetrievalDocument): RetrievalDocument {
  const { pointId, contentHash, embeddingModel, vector, ...rest } = document;
  void pointId;
  void contentHash;
  void embeddingModel;
  void vector;
  return rest;
}

export class InMemoryVectorStore implements VectorStore {
  private readonly namespaces = new Map<string, EmbeddedRetrievalDocument[]>();

  public async replaceNamespace(namespace: string, documents: readonly EmbeddedRetrievalDocument[]): Promise<void> {
    if (namespace.trim() === "") throw new Error("vector namespace is required");
    this.namespaces.set(namespace, documents.map((document) => structuredClone(document)));
  }

  public async search(
    namespace: string,
    vector: readonly number[],
    options: RetrievalSearchOptions
  ): Promise<RetrievalSearchHit[]> {
    const records = this.namespaces.get(namespace) ?? [];
    return records
      .filter((record) => record.kind === options.kind && record.status === "approved" && record.licenseStatus === "approved")
      .filter((record) => record.kind !== "recipe" || record.egyptianVerificationStatus === "verified")
      .map((record) => ({ record, score: cosineSimilarity(vector, record.vector) }))
      .filter((entry) => options.minScore === undefined || entry.score >= options.minScore)
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
      .slice(0, options.limit)
      .map(({ record, score }) => ({
        document: publicDocument(record),
        score,
        provenance: {
          sourceId: record.sourceId,
          versionId: record.versionId,
          title: record.sourceTitle,
          url: record.sourceUrl,
          accessedAt: record.sourceAccessedAt,
          locator: record.sourceLocator,
        },
      }));
  }
}
