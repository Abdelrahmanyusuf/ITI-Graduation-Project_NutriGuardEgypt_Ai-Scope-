import { ClaudeLayer } from "./src/llm/claude-layer.js";
import { JsonStructuredLogger } from "./src/observability/logger.js";
import { MetricsRegistry } from "./src/observability/metrics.js";
import { InMemoryPilotFeedbackStore } from "./src/pilot/feedback.js";
import { buildGraduationDemoAgent } from "./src/runtime/graduation-demo-agent.js";
import { createNutriGuardHttpServer } from "./src/server/http-app.js";

const agent = await buildGraduationDemoAgent(
  "development",
  null,
  new ClaudeLayer(),
);
const logger = new JsonStructuredLogger();
const metrics = new MetricsRegistry();
const debugToken = process.env.CLAUDE_DEBUG_PANEL_TOKEN?.trim();
const allowedOrigins = [process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]
  .map((value) => value?.trim())
  .filter((value): value is string => Boolean(value))
  .map((host) => `https://${host.replace(/^https?:\/\//u, "")}`);
const claudeDebugPanel = debugToken && agent.claudeLayer.config.debugPanelEnabled
  ? { enabled: true, token: debugToken, list: (limit: number) => agent.claudeLayer.store.list(limit) }
  : undefined;

const server = createNutriGuardHttpServer({
  agent,
  feedbackStore: new InMemoryPilotFeedbackStore(),
  // The data is the labelled graduation demo corpus, never approved production data.
  mode: "production",
  releaseId: `vercel-graduation-demo-${process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || "local"}`,
  allowedOrigins,
  readiness: async () => ({ ready: true, blockers: [] }),
  pilotConsentReference: "VERCEL-GRADUATION-DEMO-CONSENT",
  privacyNoticeVersion: "graduation-demo-v1",
  requestTimeoutMs: 55_000,
  logger,
  metrics,
  ...(claudeDebugPanel ? { claudeDebugPanel } : {}),
});

server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () => {
  logger.log("info", "server_started", {
    host: "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
    mode: "graduation_demo",
  });
});
