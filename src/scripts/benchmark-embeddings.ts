import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { benchmarkEmbeddingModels, type EmbeddingBenchmarkDataset } from "../retrieval/benchmark.js";
import { OpenAICompatibleEmbeddingProvider } from "../retrieval/embeddings.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (value === "") throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const baseUrl = requiredEnvironment("EMBEDDING_BASE_URL");
  const models = requiredEnvironment("EMBEDDING_MODELS").split(",").map((value) => value.trim()).filter(Boolean);
  if (models.length < 2 || models.length > 3) throw new Error("EMBEDDING_MODELS must contain two or three unique model IDs");
  const datasetPath = path.resolve(process.env.EMBEDDING_BENCHMARK_DATASET?.trim() || "tests/fixtures/retrieval/embedding-eval.synthetic.json");
  const outputPath = path.resolve(process.env.EMBEDDING_BENCHMARK_OUTPUT?.trim() || "data/reports/embedding-benchmark.json");
  const dataset = JSON.parse(await readFile(datasetPath, "utf8")) as EmbeddingBenchmarkDataset;
  const providers = models.map((modelId) => new OpenAICompatibleEmbeddingProvider({
    baseUrl,
    apiKey: process.env.EMBEDDING_API_KEY,
    modelId,
  }));
  const report = await benchmarkEmbeddingModels(providers, dataset);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`embedding benchmark: ${report.selectionStatus}; selected=${report.selectedModelId ?? "none"}; output=${outputPath}`);
  if (report.selectionStatus !== "selected") process.exitCode = 1;
}

await main().catch((error: unknown) => {
  console.error(`embedding benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
