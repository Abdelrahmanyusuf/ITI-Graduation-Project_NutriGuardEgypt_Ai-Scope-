import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { buildGraduationDemoAgent } from "../src/runtime/graduation-demo-agent.js";
import { buildProductionRuntime, type ProductionRuntime } from "../src/runtime/production.js";
import { loadProductionConfig } from "../src/config/env.js";
import { ClaudeLayer } from "../src/llm/claude-layer.js";
import { JsonStructuredLogger } from "../src/observability/logger.js";
import { MetricsRegistry } from "../src/observability/metrics.js";
import { InMemoryPilotFeedbackStore } from "../src/pilot/feedback.js";
import { createNutriGuardHttpServer } from "../src/server/http-app.js";
import { FRONTEND_ORIGINS } from "../src/config/frontend-origins.js";

type VercelMode = "graduation_demo" | "production";

interface ServerlessRuntime {
  server: Server;
  production: ProductionRuntime | null;
}

function deploymentMode(): VercelMode {
  return process.env.NUTRIGUARD_VERCEL_MODE?.trim() === "production" ? "production" : "graduation_demo";
}

function configuredOrigins(): string[] {
  const explicit = process.env.ALLOWED_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const vercelHosts = [process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map((host) => `https://${host.replace(/^https?:\/\//u, "")}`);
  return [...new Set([...FRONTEND_ORIGINS, ...explicit, ...vercelHosts])];
}

function requestTimeoutMs(): number {
  const seconds = Number(process.env.REQUEST_TIMEOUT_SECONDS ?? "15");
  return Math.round(Math.min(55, Math.max(1, Number.isFinite(seconds) ? seconds : 15)) * 1_000);
}

async function createServerlessRuntime(): Promise<ServerlessRuntime> {
  const mode = deploymentMode();
  const logger = new JsonStructuredLogger();
  const metrics = new MetricsRegistry();

  if (mode === "production") {
    const config = loadProductionConfig();
    const production = await buildProductionRuntime(config);
    return {
      production,
      server: createNutriGuardHttpServer({
        agent: production.agent,
        feedbackStore: production.feedbackStore,
        mode: config.deploymentTarget,
        releaseId: config.releaseId,
        allowedOrigins: config.allowedOrigins,
        readiness: production.readiness,
        pilotConsentReference: config.pilotConsentReference,
        privacyNoticeVersion: config.privacyNoticeVersion,
        requestTimeoutMs: requestTimeoutMs(),
        logger,
        metrics,
        metricsToken: config.metricsToken,
      }),
    };
  }

  // The hosted graduation mode serves the complete local Agent and its visible
  // demo/needs-review labels. It is never represented as approved production data.
  const agent = await buildGraduationDemoAgent("development", null, new ClaudeLayer());
  const debugToken = process.env.CLAUDE_DEBUG_PANEL_TOKEN?.trim();
  const claudeDebugPanel = debugToken && agent.claudeLayer.config.debugPanelEnabled
    ? { enabled: true, token: debugToken, list: (limit: number) => agent.claudeLayer.store.list(limit) }
    : undefined;
  return {
    production: null,
    server: createNutriGuardHttpServer({
      agent,
      feedbackStore: new InMemoryPilotFeedbackStore(),
      mode: "production",
      releaseId: `vercel-graduation-demo-${process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || "local"}`,
      allowedOrigins: configuredOrigins(),
      readiness: async () => ({ ready: true, blockers: [] }),
      pilotConsentReference: "VERCEL-GRADUATION-DEMO-CONSENT",
      privacyNoticeVersion: "graduation-demo-v1",
      requestTimeoutMs: requestTimeoutMs(),
      logger,
      metrics,
      ...(claudeDebugPanel ? { claudeDebugPanel } : {}),
    }),
  };
}

// Vercel reuses the module between warm requests, so the dataset and local vector
// index are built once per warm function instance rather than once per message.
const runtimePromise = createServerlessRuntime();

export const config = { maxDuration: 60 };

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const runtime = await runtimePromise;
    await new Promise<void>((resolve) => {
      const complete = () => resolve();
      response.once("finish", complete);
      response.once("close", complete);
      runtime.server.emit("request", request, response);
    });
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify({
      error: {
        code: "serverless_initialization_failed",
        message: "NutriGuard could not initialize. Check the deployment environment variables and function logs.",
      },
    }));
    console.error("nutriguard_serverless_initialization_failed", error instanceof Error ? error.message : "unknown error");
  }
}
