import { readFile } from "node:fs/promises";
import path from "node:path";
import { OpenAICompatibleEmbeddingProvider } from "../retrieval/embeddings.js";
import { ingestRetrievalCorpus, type RetrievalCorpus } from "../retrieval/ingestion.js";
import { QdrantVectorStore } from "../retrieval/qdrant.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (value === "") throw new Error(`${name} is required; ingestion never invents a default production source`);
  return value;
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function main(): Promise<void> {
  const corpusPath = path.resolve(requiredEnvironment("RETRIEVAL_CORPUS_PATH"));
  if (isWithin(corpusPath, path.resolve("data/raw")) || isWithin(corpusPath, path.resolve("data/staging"))) {
    throw new Error("direct raw/staging ingestion is forbidden; provide an explicitly approved corpus export");
  }
  const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as RetrievalCorpus;
  const provider = new OpenAICompatibleEmbeddingProvider({
    baseUrl: requiredEnvironment("EMBEDDING_BASE_URL"),
    apiKey: process.env.EMBEDDING_API_KEY,
    modelId: requiredEnvironment("EMBEDDING_MODEL"),
  });
  const store = new QdrantVectorStore({
    baseUrl: requiredEnvironment("QDRANT_URL"),
    apiKey: process.env.QDRANT_API_KEY,
    collection: process.env.QDRANT_COLLECTION?.trim() || "nutriguard_retrieval",
  });
  const result = await ingestRetrievalCorpus(corpus, provider, store);
  console.log(`retrieval ingestion complete: corpus=${result.corpusId}, documents=${result.documentCount}, model=${result.embeddingModel}, hash=${result.contentHash}`);
}

await main().catch((error: unknown) => {
  console.error(`retrieval ingestion failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
