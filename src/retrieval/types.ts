export type RetrievalDocumentKind = "recipe" | "guideline";

export interface RetrievalProvenance {
  sourceId: string;
  versionId: string;
  title: string;
  url: string;
  accessedAt: string;
  locator: string;
}

export interface RetrievalDocument {
  id: string;
  kind: RetrievalDocumentKind;
  title: string;
  text: string;
  language: "ar-EG" | "ar" | "en";
  status: "approved" | "pending" | "rejected";
  licenseStatus: "approved" | "pending" | "rejected";
  egyptianVerificationStatus?: "verified" | "candidate" | "pending" | "rejected";
  sourceId: string;
  versionId: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceAccessedAt: string;
  sourceLocator: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface EmbeddedRetrievalDocument extends RetrievalDocument {
  pointId: string;
  contentHash: string;
  embeddingModel: string;
  vector: number[];
}

export interface RetrievalSearchHit {
  document: RetrievalDocument;
  score: number;
  provenance: RetrievalProvenance;
}

export interface RetrievalSearchOptions {
  kind: RetrievalDocumentKind;
  limit: number;
  minScore?: number;
}

export interface VectorStore {
  replaceNamespace(namespace: string, documents: readonly EmbeddedRetrievalDocument[]): Promise<void>;
  search(namespace: string, vector: readonly number[], options: RetrievalSearchOptions): Promise<RetrievalSearchHit[]>;
}

export interface EmbeddingProvider {
  readonly modelId: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}
