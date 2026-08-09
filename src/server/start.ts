import { loadConfig } from "../config/env.js";
import { InMemoryPilotFeedbackStore } from "../pilot/feedback.js";
import { buildSyntheticDemoAgent } from "../runtime/synthetic-demo-agent.js";
import { createNutriGuardHttpServer } from "./http-app.js";

const config = loadConfig();
const demo = process.argv.includes("--demo");
if (!demo) throw new Error("No approved production agent wiring is configured. Use --demo only for local synthetic testing.");
if (config.nodeEnv === "production") throw new Error("synthetic demo mode is forbidden in production");
const agent = await buildSyntheticDemoAgent(config.nodeEnv);
const releaseId = `local-demo-${process.env.npm_package_version ?? "0.1.0"}`;
const server = createNutriGuardHttpServer({
  agent,
  feedbackStore: new InMemoryPilotFeedbackStore(),
  mode: config.nodeEnv,
  releaseId,
  allowedOrigins: [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`],
  readiness: async () => ({ ready: true, blockers: [] }),
  pilotConsentReference: "LOCAL-SYNTHETIC-DEMO-CONSENT",
  privacyNoticeVersion: "local-demo-v1",
});
server.listen(config.port, "127.0.0.1", () => console.log(`[NutriGuard] Synthetic demo listening on http://127.0.0.1:${config.port}`));
const shutdown = () => server.close(() => process.exit(0));
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
