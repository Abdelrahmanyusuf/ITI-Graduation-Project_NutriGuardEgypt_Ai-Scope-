import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { NutriGuardExpandedAgent } from "../agent/expanded-agent.js";
import type { ProductionConfig } from "../config/env.js";
import { PostgresPilotFeedbackStore } from "../pilot/feedback.js";
import { evaluateReleaseReadiness, parseReleaseEvidence, verifyReleaseEvidenceFiles } from "../release/readiness.js";
import { OpenAICompatibleEmbeddingProvider } from "../retrieval/embeddings.js";
import { QdrantVectorStore } from "../retrieval/qdrant.js";
import { NutriGuardTools } from "../tools/nutriguard-tools.js";
import { PostgresAlternativeRuleRepository, PostgresGuidelineRuleRepository, PostgresNutritionService } from "./postgres-adapters.js";

export interface ProductionRuntime {
  agent: NutriGuardExpandedAgent;
  feedbackStore: PostgresPilotFeedbackStore;
  readiness(): Promise<{ ready: boolean; blockers: string[] }>;
  close(): Promise<void>;
}

async function evidenceState(config: ProductionConfig): Promise<{ ready:boolean; blockers:string[] }> {
  try {
    const value = JSON.parse(await readFile(config.releaseEvidencePath, "utf8")) as unknown;
    const state = evaluateReleaseReadiness(value, config.deploymentTarget);
    const fileIssues=state.ready?await verifyReleaseEvidenceFiles(parseReleaseEvidence(value),config.releaseEvidencePath):[];
    return { ready: state.ready && fileIssues.length===0 && state.releaseId === config.releaseId, blockers: [...state.blockers,...fileIssues, ...(state.releaseId !== config.releaseId ? ["release evidence ID does not match RELEASE_ID"] : [])] };
  } catch { return { ready:false, blockers:["release evidence is missing, unreadable, or invalid"] }; }
}

/** Compose real adapters. It never migrates, seeds, ingests, or approves data. */
export async function buildProductionRuntime(config: ProductionConfig): Promise<ProductionRuntime> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
    ssl: config.deploymentTarget === "production" ? { rejectUnauthorized: true } : undefined });
  const embeddings = new OpenAICompatibleEmbeddingProvider({ baseUrl: config.embeddingBaseUrl, apiKey: config.embeddingApiKey, modelId: config.embeddingModel, timeoutMs: 10_000 });
  const vectors = new QdrantVectorStore({ baseUrl: config.qdrantUrl, collection: config.qdrantCollection, apiKey: config.qdrantApiKey });
  const nutrition = new PostgresNutritionService(pool);
  const tools = new NutriGuardTools({ embeddingProvider: embeddings, vectorStore: vectors, corpusId: config.retrievalCorpusId,
    calculateNutrition: (recipeId, request) => nutrition.calculate(recipeId, request), guidelineRules: new PostgresGuidelineRuleRepository(pool) });
  const agent = new NutriGuardExpandedAgent(tools, new PostgresAlternativeRuleRepository(pool));
  const readiness = async () => {
    const blockers: string[] = [];
    const evidence = await evidenceState(config); blockers.push(...evidence.blockers);
    try { const result = await pool.query<{ version:string }>("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"); if (result.rows[0]?.version !== "0003") blockers.push("database migration 0003 is not applied"); } catch { blockers.push("postgresql dependency is unavailable"); }
    try { await embeddings.embed(["nutriguard readiness probe"]); } catch { blockers.push("embedding dependency is unavailable"); }
    try { const headers = config.qdrantApiKey ? { "api-key": config.qdrantApiKey } : undefined; const response = await fetch(`${config.qdrantUrl.replace(/\/+$/,"")}/collections/${encodeURIComponent(config.qdrantCollection)}`, { headers, signal: AbortSignal.timeout(5_000) }); if (!response.ok) throw new Error(); } catch { blockers.push("qdrant dependency or approved collection is unavailable"); }
    return { ready: blockers.length === 0, blockers };
  };
  return { agent, feedbackStore: new PostgresPilotFeedbackStore(pool), readiness, close: () => pool.end() };
}
