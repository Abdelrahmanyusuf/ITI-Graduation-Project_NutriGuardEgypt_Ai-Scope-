import { createHash } from "node:crypto";
import { validateEmbeddingBatch } from "./embeddings.js";
import type { EmbeddedRetrievalDocument, EmbeddingProvider, RetrievalDocument, VectorStore } from "./types.js";

export interface RetrievalCorpus {
  schemaVersion: "1.0";
  corpusId: string;
  documents: RetrievalDocument[];
}

export interface IngestionResult {
  corpusId: string;
  embeddingModel: string;
  documentCount: number;
  recipeCount: number;
  guidelineCount: number;
  dimension: number;
  contentHash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stablePointId(value: string): string {
  const hex = sha256(value).slice(0, 32).split("");
  hex[12] = "5";
  const variant = Number.parseInt(hex[16] ?? "0", 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function documentWithoutVector(document: EmbeddedRetrievalDocument): Omit<EmbeddedRetrievalDocument, "vector"> {
  const { vector, ...rest } = document;
  void vector;
  return rest;
}

function validateCorpus(corpus: RetrievalCorpus): RetrievalDocument[] {
  if (corpus.schemaVersion !== "1.0") throw new Error("unsupported retrieval corpus schemaVersion");
  if (corpus.corpusId.trim() === "") throw new Error("retrieval corpusId is required");
  if (corpus.documents.length === 0) throw new Error("retrieval corpus is empty; no production data is fabricated");
  const ids = new Set<string>();
  return corpus.documents.map((document, index) => {
    const label = `documents[${index}]`;
    if (document.id.trim() === "" || document.title.trim() === "" || document.text.trim() === "") {
      throw new Error(`${label} requires id, title and text`);
    }
    if (ids.has(document.id)) throw new Error(`duplicate retrieval document id: ${document.id}`);
    ids.add(document.id);
    if (document.status !== "approved" || document.licenseStatus !== "approved") {
      throw new Error(`${label} is not backed by an approved active source and license`);
    }
    if (document.kind === "recipe" && document.egyptianVerificationStatus !== "verified") {
      throw new Error(`${label} recipe is not human-verified Egyptian`);
    }
    if (document.sourceId.trim() === "" || document.versionId.trim() === "" || document.sourceTitle.trim() === "" || document.sourceUrl.trim() === "" || document.sourceAccessedAt.trim() === "" || document.sourceLocator.trim() === "") {
      throw new Error(`${label} requires complete provenance`);
    }
    try {
      const url = new URL(document.sourceUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      throw new Error(`${label} sourceUrl must be a valid http(s) URL`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(document.sourceAccessedAt) || Number.isNaN(Date.parse(`${document.sourceAccessedAt}T00:00:00Z`))) {
      throw new Error(`${label} sourceAccessedAt must be an ISO calendar date`);
    }
    return structuredClone(document);
  });
}

/**
 * Select documents that already satisfy the production ingestion gates.
 * This never upgrades a document's status; demo callers use it to keep
 * pending candidate documents out of the approved retrieval namespace.
 */
export function ingestionEligibleCorpus(corpus: RetrievalCorpus): RetrievalCorpus {
  return {
    ...corpus,
    documents: corpus.documents.filter((document) =>
      document.status === "approved"
      && document.licenseStatus === "approved"
      && (document.kind !== "recipe" || document.egyptianVerificationStatus === "verified")
    ),
  };
}

export async function ingestRetrievalCorpus(
  corpus: RetrievalCorpus,
  provider: EmbeddingProvider,
  store: VectorStore
): Promise<IngestionResult> {
  const documents = validateCorpus(corpus).sort((a, b) => a.id.localeCompare(b.id));
  const vectors = await provider.embed(documents.map((document) => `${document.title}\n\n${document.text}`));
  const dimension = validateEmbeddingBatch(vectors, documents.length);
  const embedded: EmbeddedRetrievalDocument[] = documents.map((document, index) => {
    const contentHash = sha256(JSON.stringify(document));
    return {
      ...document,
      pointId: stablePointId(`${corpus.corpusId}|${provider.modelId}|${document.id}|${document.versionId}|${contentHash}`),
      contentHash,
      embeddingModel: provider.modelId,
      vector: vectors[index] ?? [],
    };
  });
  await store.replaceNamespace(corpus.corpusId, embedded);
  return {
    corpusId: corpus.corpusId,
    embeddingModel: provider.modelId,
    documentCount: embedded.length,
    recipeCount: embedded.filter((document) => document.kind === "recipe").length,
    guidelineCount: embedded.filter((document) => document.kind === "guideline").length,
    dimension,
    contentHash: sha256(JSON.stringify(embedded.map(documentWithoutVector))),
  };
}
