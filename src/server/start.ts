import { loadConfig, loadProductionConfig } from "../config/env.js";
import { loadLocalEnv } from "../config/load-local-env.js";
import { InMemoryPilotFeedbackStore } from "../pilot/feedback.js";
import { buildGraduationDemoAgent } from "../runtime/graduation-demo-agent.js";
import { createNutriGuardHttpServer } from "./http-app.js";
import { buildProductionRuntime } from "../runtime/production.js";
import { JsonStructuredLogger } from "../observability/logger.js";
import { MetricsRegistry } from "../observability/metrics.js";

loadLocalEnv();

const demo = process.argv.includes("--demo");
const config = demo ? loadConfig() : loadProductionConfig();
if (demo && config.nodeEnv === "production") throw new Error("synthetic demo mode is forbidden in production");
const runtime = demo ? null : await buildProductionRuntime(config as ReturnType<typeof loadProductionConfig>);
const agent = runtime?.agent ?? await buildGraduationDemoAgent(config.nodeEnv as "development" | "test");
const releaseId = runtime ? (config as ReturnType<typeof loadProductionConfig>).releaseId : `local-demo-${process.env.npm_package_version ?? "0.1.0"}`;
const logger = new JsonStructuredLogger(); const metrics = new MetricsRegistry();
const server = createNutriGuardHttpServer({
  agent,
  feedbackStore: runtime?.feedbackStore ?? new InMemoryPilotFeedbackStore(),
  mode: runtime ? (config as ReturnType<typeof loadProductionConfig>).deploymentTarget : config.nodeEnv,
  releaseId,
  allowedOrigins: runtime ? (config as ReturnType<typeof loadProductionConfig>).allowedOrigins : [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`],
  readiness: runtime?.readiness ?? (async () => ({ ready: true, blockers: [] })),
  pilotConsentReference: runtime ? (config as ReturnType<typeof loadProductionConfig>).pilotConsentReference : "LOCAL-GRADUATION-DEMO-CONSENT",
  privacyNoticeVersion: runtime ? (config as ReturnType<typeof loadProductionConfig>).privacyNoticeVersion : "local-demo-v1",
  logger, metrics, metricsToken: runtime ? (config as ReturnType<typeof loadProductionConfig>).metricsToken : undefined,
});
const host = runtime ? (config as ReturnType<typeof loadProductionConfig>).host : "127.0.0.1";
server.listen(config.port, host, () => logger.log("info", "server_started", { host, port: config.port, releaseId, mode: runtime ? "production" : "graduation_demo" }));
const shutdown = () => server.close(() => { if (runtime) void runtime.close().finally(() => process.exit(0)); else process.exit(0); });
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
