import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import type { ExpandedAgentResponse } from "../agent/expanded-agent.js";
import { NUTRIGUARD_SYSTEM_PROMPT_VERSION } from "../agent/system-prompt.js";
import { parsePilotFeedbackSubmission, type PilotFeedbackStore } from "../pilot/feedback.js";
import { renderChatPage } from "../web/chat-page.js";
import type { StructuredLogger } from "../observability/logger.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import { redactTraceForDebugPanel, type ClaudeRequestTrace } from "../llm/observability.js";

/**
 * Part C1 — internal observability panel for the Claude layer.
 *
 * Not a user-facing surface: the route only exists when `enabled` is true and
 * a token is configured, and every record is passed through
 * `redactTraceForDebugPanel` so raw user messages can never be served here.
 */
export interface ClaudeDebugPanelOptions {
  enabled: boolean;
  token: string;
  list(limit: number): ClaudeRequestTrace[];
}

const RecipeIdSchema = z.string().regex(/^EGY-RCP-[0-9]{3}$/u);
const IngredientKeySchema = z.string().trim().min(1).max(100);
/**
 * Step 16 selection state at the API boundary.
 *
 * Everything here is an identifier, a bounded enum, or a bounded number. No
 * nutrition value crosses this boundary, because every displayed number is
 * recalculated server-side from the dataset. `pendingOperationId` is validated as
 * a uuid so a forged value cannot be used to probe the server-side pending
 * operation table with arbitrary strings.
 */
const MealSelectionStateSchema = z.object({
  schemaVersion: z.literal("1.0"),
  phase: z.enum(["awaiting_selection", "awaiting_confirmation", "completed"]),
  ceilingMode: z.enum(["total", "per_meal", "none"]),
  ceilingKcal: z.number().min(50).max(5_000).nullable(),
  includeSodium: z.boolean(),
  excludedIngredientKeys: z.array(IngredientKeySchema).max(30),
  categories: z.array(z.object({
    mealCategory: z.enum(["breakfast", "lunch", "dinner", "snacks"]),
    options: z.array(z.object({
      optionIndex: z.number().int().min(1).max(3),
      recipeIds: z.array(RecipeIdSchema).min(1).max(2),
    }).strict()).max(3),
    verifiedMatchCount: z.number().int().min(0).max(500),
    selectedOptionIndex: z.number().int().min(1).max(3).nullable(),
  }).strict()).min(1).max(4),
  pendingOperationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u).nullable(),
}).strict();
const NutritionMemorySchema = z.object({
  schemaVersion: z.literal("1.0"),
  turnCount: z.number().int().min(1).max(100),
  activeRecipeId: RecipeIdSchema.nullable(),
  recentRecipeIds: z.array(RecipeIdSchema).max(8),
  mealPlan: z.object({
    phase: z.enum(["draft", "ready"]), mealCount: z.number().int().min(1).max(10), calorieTargetKcal: z.number().min(300).max(5_000).nullable(), calorieConstraint: z.enum(["target", "maximum"]),
    excludedIngredientKeys: z.array(IngredientKeySchema).max(30), recipeIds: z.array(RecipeIdSchema).max(10),
  }).strict().nullable(),
  singleMealTarget: z.object({
    calorieTargetKcal: z.number().min(50).max(5_000), category: z.string().trim().min(1).max(40).nullable(), relation: z.enum(["closest", "below", "above"]),
    lastRecommendationCaloriesKcal: z.number().positive().max(5_000), excludedIngredientKeys: z.array(IngredientKeySchema).max(30), recipeId: RecipeIdSchema.nullable(),
  }).strict().nullable(),
  lighterModification: z.object({ recipeId: RecipeIdSchema, ingredient: IngredientKeySchema, originalGrams: z.number().positive().max(10_000), proposedGrams: z.number().positive().max(10_000) }).strict().nullable(),
  comparison: z.object({
    firstRecipeId: RecipeIdSchema,
    secondRecipeId: RecipeIdSchema,
    basis: z.enum(["per_serving", "per_100g"]),
    nutrient: z.string().trim().min(1).max(20).nullable(),
  }).strict().nullable().optional(),
  mealSelection: MealSelectionStateSchema.nullable().optional(),
}).strict();

const CalorieTargetContextSchema = z.object({
  schemaVersion: z.literal("1.0"),
  lastIntent: z.literal("meal_calorie_target"),
  calorieTargetKcal: z.number().min(50).max(5_000),
  category: z.string().trim().min(1).max(40).nullable(),
  relation: z.enum(["closest", "below", "above"]),
  lastRecommendationCaloriesKcal: z.number().positive().max(5_000),
  excludedIngredientKeys: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  recipeId: z.string().regex(/^EGY-RCP-[0-9]{3}$/u).optional(),
  memory: NutritionMemorySchema.optional(),
}).strict();
const LighterModificationContextSchema = z.object({
  schemaVersion: z.literal("1.0"),
  lastIntent: z.literal("lighter_modification"),
  recipeId: z.string().regex(/^EGY-RCP-[0-9]{3}$/u),
  ingredient: z.string().trim().min(1).max(100),
  originalGrams: z.number().positive().max(10_000),
  proposedGrams: z.number().positive().max(10_000),
  memory: NutritionMemorySchema.optional(),
}).strict().refine((value) => value.proposedGrams <= value.originalGrams, { message: "proposedGrams must not exceed originalGrams" });
const RecipeReferenceContextSchema = z.object({ schemaVersion: z.literal("1.0"), lastIntent: z.literal("recipe_reference"), recipeId: RecipeIdSchema, memory: NutritionMemorySchema.optional() }).strict();
const MealPlanContextSchema = z.object({ schemaVersion: z.literal("1.0"), lastIntent: z.literal("meal_plan"), calorieTargetKcal: z.number().min(300).max(5_000), excludedIngredientKeys: z.array(IngredientKeySchema).max(30), recipeIds: z.array(RecipeIdSchema).min(1).max(10), mealCount: z.number().int().min(1).max(10).optional(), calorieConstraint: z.enum(["target", "maximum"]).optional(), memory: NutritionMemorySchema.optional() }).strict();
const MealPlanDraftContextSchema = z.object({ schemaVersion: z.literal("1.0"), lastIntent: z.literal("meal_plan_draft"), mealCount: z.number().int().min(1).max(10), excludedIngredientKeys: z.array(IngredientKeySchema).max(30), calorieConstraint: z.enum(["target", "maximum"]), memory: NutritionMemorySchema.optional() }).strict();
const ComparisonContextSchema = z.object({
  schemaVersion: z.literal("1.0"),
  lastIntent: z.literal("compare_recipes"),
  firstRecipeId: RecipeIdSchema,
  secondRecipeId: RecipeIdSchema,
  basis: z.enum(["per_serving", "per_100g"]),
  nutrient: z.string().trim().min(1).max(20).nullable(),
  memory: NutritionMemorySchema.optional(),
}).strict();
const MealSelectionContextSchema = z.object({
  schemaVersion: z.literal("1.0"),
  lastIntent: z.literal("meal_selection"),
  selection: MealSelectionStateSchema,
  memory: NutritionMemorySchema.optional(),
}).strict();
const ConversationContextSchema = z.discriminatedUnion("lastIntent", [CalorieTargetContextSchema, LighterModificationContextSchema, RecipeReferenceContextSchema, MealPlanContextSchema, MealPlanDraftContextSchema, ComparisonContextSchema, MealSelectionContextSchema]);
const ChatSchema = z.object({ message: z.string().trim().min(1).max(2_000), language: z.enum(["ar-EG", "ar", "en"]).default("ar-EG"), context: ConversationContextSchema.optional() }).strict();
type ChatInput = z.infer<typeof ChatSchema>;

export interface HttpAppOptions {
  agent: { invoke(input: ChatInput): Promise<ExpandedAgentResponse> };
  feedbackStore: PilotFeedbackStore;
  mode: "development" | "test" | "staging" | "production";
  releaseId: string;
  allowedOrigins: readonly string[];
  readiness: () => Promise<{ ready: boolean; blockers: string[] }>;
  pilotConsentReference: string | null;
  privacyNoticeVersion: string | null;
  requestTimeoutMs?: number;
  rateLimit?: { windowMs: number; maxRequests: number };
  logger?: StructuredLogger;
  metrics?: MetricsRegistry;
  metricsToken?: string;
  claudeDebugPanel?: ClaudeDebugPanelOptions;
}

interface Bucket { start: number; count: number }

function securityHeaders(response: ServerResponse, mode: HttpAppOptions["mode"], nonce: string): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
  if (mode === "production") response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, maximumBytes = 16_384): Promise<unknown> {
  const type = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw Object.assign(new Error("Content-Type must be application/json"), { status: 415 });
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBytes) throw Object.assign(new Error("request body is too large"), { status: 413 });
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw Object.assign(new Error("request body must be valid JSON"), { status: 400 }); }
}

function publicError(error: unknown): { status: number; code: string; message: string } {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 500;
  if (status >= 500) return { status: 500, code: "internal_error", message: "The service could not complete the request." };
  return { status, code: status === 413 ? "payload_too_large" : status === 415 ? "unsupported_media_type" : "invalid_request", message: error instanceof Error ? error.message : "Invalid request" };
}

export function createNutriGuardHttpServer(options: HttpAppOptions): Server {
  if (!options.releaseId.trim()) throw new Error("releaseId is required");
  const buckets = new Map<string, Bucket>();
  const rate = options.rateLimit ?? { windowMs: 60_000, maxRequests: 30 };
  const timeoutMs = options.requestTimeoutMs ?? 15_000;
  return createServer(async (request, response) => {
    const startedAt = performance.now();
    const requestId = randomUUID();
    const nonce = randomBytes(18).toString("base64");
    response.setHeader("X-Request-Id", requestId);
    securityHeaders(response, options.mode, nonce);
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = ["/", "/health", "/ready", "/metrics", "/api/v1/chat", "/api/v1/feedback", "/internal/v1/claude-trace"].includes(url.pathname) ? url.pathname : "other";
    response.once("finish", () => {
      options.metrics?.increment("nutriguard_http_requests_total", { route, method: request.method ?? "UNKNOWN", status: String(response.statusCode) });
      options.metrics?.increment("nutriguard_http_duration_milliseconds_total", { route }, Math.max(0, Math.round(performance.now() - startedAt)));
      options.logger?.log("info", "http_request_completed", { requestId, route, method: request.method ?? "UNKNOWN", status: response.statusCode, durationMs: Math.round(performance.now() - startedAt) });
    });
    const origin = request.headers.origin;
    if (origin) {
      if (!options.allowedOrigins.includes(origin)) return json(response, 403, { error: { code: "origin_forbidden", message: "Origin is not allowed." }, requestId });
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.statusCode = 204;
      return response.end();
    }
    if (request.method === "GET" && url.pathname === "/") {
      response.statusCode = 200; response.setHeader("Content-Type", "text/html; charset=utf-8"); response.setHeader("Cache-Control", "no-store"); return response.end(renderChatPage(nonce));
    }
    if (request.method === "GET" && url.pathname === "/favicon.ico") { response.statusCode = 204; return response.end(); }
    if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { status: "ok", releaseId: options.releaseId });
    if (request.method === "GET" && url.pathname === "/metrics") {
      if (!options.metrics || !options.metricsToken) return json(response, 404, { error: { code: "not_found", message: "Route not found." }, requestId });
      if (request.headers.authorization !== `Bearer ${options.metricsToken}`) return json(response, 401, { error: { code: "unauthorized", message: "Authentication required." }, requestId });
      response.statusCode = 200; response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8"); response.setHeader("Cache-Control", "no-store"); return response.end(options.metrics.render());
    }
    if (request.method === "GET" && url.pathname === "/internal/v1/claude-trace") {
      const panel = options.claudeDebugPanel;
      // Absent or disabled behaves as if the route does not exist, so an
      // ordinary deployment cannot discover it.
      if (!panel?.enabled || !panel.token) return json(response, 404, { error: { code: "not_found", message: "Route not found." }, requestId });
      if (request.headers.authorization !== `Bearer ${panel.token}`) return json(response, 401, { error: { code: "unauthorized", message: "Authentication required." }, requestId });
      const requestedLimit = Number(url.searchParams.get("limit") ?? "20");
      const limit = Number.isInteger(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 20;
      const traces = panel.list(limit).map(redactTraceForDebugPanel);
      return json(response, 200, { requestId, releaseId: options.releaseId, traceCount: traces.length, traces });
    }
    if (request.method === "GET" && url.pathname === "/ready") {
      const state = await options.readiness();
      return json(response, state.ready ? 200 : 503, { status: state.ready ? "ready" : "blocked", blockers: state.blockers, releaseId: options.releaseId });
    }
    if (request.method === "POST" && (url.pathname === "/api/v1/chat" || url.pathname === "/api/v1/feedback")) {
      const key = request.socket.remoteAddress ?? "unknown";
      const now = Date.now();
      const current = buckets.get(key);
      const bucket = !current || now - current.start >= rate.windowMs ? { start: now, count: 0 } : current;
      bucket.count += 1; buckets.set(key, bucket);
      if (bucket.count > rate.maxRequests) { options.metrics?.increment("nutriguard_rate_limited_total", { route }); return json(response, 429, { error: { code: "rate_limited", message: "Too many requests. Try again later." }, requestId }); }
      try {
        const body = await readJson(request);
        if (url.pathname === "/api/v1/feedback") {
          if (!options.pilotConsentReference || !options.privacyNoticeVersion) throw Object.assign(new Error("pilot feedback collection is not configured"), { status: 503 });
          const submission = parsePilotFeedbackSubmission(body);
          const { consentAccepted: _consentAccepted, ...fields } = submission;
          void _consentAccepted;
          const saved = await options.feedbackStore.save({ ...fields, consentReference: options.pilotConsentReference, privacyNoticeVersion: options.privacyNoticeVersion }, { releaseId: options.releaseId, promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION });
          return json(response, 201, { feedbackId: saved.id, requestId });
        }
        const parsed = ChatSchema.safeParse(body);
        if (!parsed.success) throw Object.assign(new Error("message must contain 1–2000 characters and no unknown fields"), { status: 400 });
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("agent timeout"), { status: 504 })), timeoutMs); });
        const result = await Promise.race([options.agent.invoke(parsed.data), timeout]).finally(() => { if (timer) clearTimeout(timer); });
        options.metrics?.increment("nutriguard_agent_outcomes_total", { outcome: result.status });
        if (result.status === "no_result" || result.status === "clarification") options.metrics?.increment("nutriguard_retrieval_quality_events_total", { outcome: result.status });
        for (const flag of result.safetyFlags) options.metrics?.increment("nutriguard_safety_routes_total", { outcome: flag });
        for (const flag of result.integrityFlags) options.metrics?.increment("nutriguard_integrity_routes_total", { outcome: flag });
        for (const trace of result.toolTrace) {
          if (!trace.ok) options.metrics?.increment("nutriguard_tool_failures_total", { dependency: trace.tool, outcome: trace.code ?? "unknown" });
          if (trace.tool === "calculate_nutrition") options.metrics?.increment("nutriguard_calculation_availability_total", { outcome: trace.ok ? "available" : "unavailable" });
        }
        return json(response, 200, { requestId, result });
      } catch (error) {
        const safe = publicError(error);
        return json(response, safe.status, { error: { code: safe.code, message: safe.message }, requestId });
      }
    }
    if (["/api/v1/chat", "/api/v1/feedback"].includes(url.pathname)) return json(response, 405, { error: { code: "method_not_allowed", message: "Method not allowed." }, requestId });
    if (url.pathname === "/internal/v1/claude-trace" && options.claudeDebugPanel?.enabled) return json(response, 405, { error: { code: "method_not_allowed", message: "Method not allowed." }, requestId });
    return json(response, 404, { error: { code: "not_found", message: "Route not found." }, requestId });
  });
}
