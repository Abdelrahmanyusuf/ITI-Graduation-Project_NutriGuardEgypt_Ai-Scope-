import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig } from "./config/env.js";

export {
  calculateRecipeNutrition,
  InMemoryNutritionCalculationRepository,
  JsonNutritionCalculationRepository,
  NutritionCalculator,
  parseNutritionRegistry,
  type RecipeNutritionResult,
  type ServingRequest,
} from "./domain/nutrition.js";

export {
  benchmarkEmbeddingModels,
  type EmbeddingBenchmarkDataset,
  type EmbeddingBenchmarkReport,
} from "./retrieval/benchmark.js";
export { OpenAICompatibleEmbeddingProvider } from "./retrieval/embeddings.js";
export { ingestRetrievalCorpus, type RetrievalCorpus, type IngestionResult } from "./retrieval/ingestion.js";
export { QdrantVectorStore } from "./retrieval/qdrant.js";
export { InMemoryVectorStore } from "./retrieval/vector-store.js";
export {
  InMemoryGuidelineRuleRepository,
  NUTRIGUARD_TOOL_DEFINITIONS,
  NUTRIGUARD_TOOL_NAMES,
  NutriGuardTools,
  type GuidelineRule,
  type ToolResult,
} from "./tools/nutriguard-tools.js";
export {
  NutriGuardSodiumPrototypeAgent,
  RuleBasedSodiumScenarioPlanner,
  type AgentLanguage,
  type SodiumAgentResponse,
  type SodiumScenarioPlanner,
} from "./agent/sodium-prototype.js";
export { classifySafetyFlags, type SafetyFlag } from "./agent/safety.js";
export { classifyRequestIntegrity, type RequestIntegrityFlag } from "./agent/request-integrity.js";
export { NUTRIGUARD_SYSTEM_PROMPT, NUTRIGUARD_SYSTEM_PROMPT_VERSION } from "./agent/system-prompt.js";
export {
  InMemoryAlternativeRuleRepository,
  NutriGuardExpandedAgent,
  RuleBasedExpandedAgentPlanner,
  type ApprovedAlternativeRule,
  type ExpandedAgentResponse,
} from "./agent/expanded-agent.js";
export {
  assertProductionEvaluationDataset,
  parseAgentEvaluationDataset,
  type AgentEvaluationDataset,
} from "./evaluation/dataset.js";
export {
  evaluateAgentDataset,
  type AgentEvaluationReport,
  type HumanWordingReview,
} from "./evaluation/evaluate.js";
export {
  evaluateAdversarialDataset,
  parseAdversarialDataset,
  type AdversarialDataset,
  type AdversarialEvaluationReport,
} from "./evaluation/adversarial.js";
export { buildIterationEvidence, type IterationEvidence } from "./evaluation/iteration.js";
export { parsePilotFeedback, parsePilotFeedbackSubmission, InMemoryPilotFeedbackStore, PostgresPilotFeedbackStore, type PilotFeedbackInput, type PilotFeedbackSubmission, type PilotFeedbackRecord, type PilotFeedbackStore } from "./pilot/feedback.js";
export { evaluateReleaseReadiness, parseReleaseEvidence, type ReadinessResult, type ReleaseEvidenceManifest, type ReleaseTarget } from "./release/readiness.js";
export { createNutriGuardHttpServer, type HttpAppOptions } from "./server/http-app.js";

/**
 * Application entry point. It validates environment configuration and exposes
 * deterministic domain operations as module exports. No HTTP server starts in
 * this foundation entry point. Console output stays minimal and secret-free.
 */
export function main(): void {
  const config = loadConfig();
  console.log(
    `[NutriGuard] Initialized (NODE_ENV=${config.nodeEnv}); serving port reserved as ${config.port}.`
  );
  console.log("[NutriGuard] Deterministic domain operations loaded; HTTP serving is not implemented.");
}

const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";
const moduleFile = resolve(fileURLToPath(import.meta.url));
if (invokedFile === moduleFile) {
  main();
}
