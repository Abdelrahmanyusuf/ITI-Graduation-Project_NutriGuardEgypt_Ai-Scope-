/**
 * Minimal OpenRouter Chat Completions client for the Step 17b Claude layer.
 *
 * Deliberately dependency-free: it mirrors the injectable-`fetch` pattern used
 * by `src/retrieval/embeddings.ts` so every call is testable without network
 * access and without adding a package to the supply chain.
 *
 * Structured output is obtained through the OpenAI-compatible tool-use
 * mechanism with a forced `tool_choice`, never by parsing free text out of
 * prose. The model can still be Claude; OpenRouter is the transport provider.
 */

export interface ClaudeClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  siteUrl?: string;
  appName?: string;
  fetchImpl?: typeof fetch;
}

export interface ClaudeToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ClaudeStructuredRequest {
  system: string;
  userContent: string;
  tool: ClaudeToolDefinition;
}

export interface ClaudeTextRequest {
  system: string;
  userContent: string;
}

export type ClaudeFailureReason =
  | "timeout"
  | "transport_error"
  | "http_error"
  | "malformed_response"
  | "tool_output_missing"
  | "empty_text";

export type ClaudeCallResult<T> =
  | { ok: true; value: T; model: string; latencyMs: number }
  | { ok: false; reason: ClaudeFailureReason; detail: string; model: string; latencyMs: number };

/** Structured-output and text-output surface used by the Step 17b stages. */
export interface ClaudeMessagesClient {
  readonly model: string;
  callStructured(request: ClaudeStructuredRequest): Promise<ClaudeCallResult<unknown>>;
  callText(request: ClaudeTextRequest): Promise<ClaudeCallResult<string>>;
}

interface OpenRouterToolCall {
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
}

interface OpenRouterMessage {
  content?: unknown;
  tool_calls?: unknown;
}

interface OpenRouterChoice {
  message?: OpenRouterMessage;
}

interface OpenRouterResponseBody {
  choices?: unknown;
}

function responseChoices(body: unknown): OpenRouterChoice[] {
  if (typeof body !== "object" || body === null) return [];
  const choices = (body as OpenRouterResponseBody).choices;
  if (!Array.isArray(choices)) return [];
  return choices.filter((choice): choice is OpenRouterChoice => typeof choice === "object" && choice !== null);
}

function messageOf(body: unknown): OpenRouterMessage | null {
  const message = responseChoices(body)[0]?.message;
  return message && typeof message === "object" ? message : null;
}

export class OpenRouterClaudeClient implements ClaudeMessagesClient {
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly siteUrl: string | null;
  private readonly appName: string | null;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: ClaudeClientOptions) {
    if (!options.apiKey.trim()) throw new Error("claude apiKey is required");
    if (!options.model.trim()) throw new Error("claude model is required");
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    this.baseUrl = (options.baseUrl?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/u, "");
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.maxTokens = options.maxTokens ?? 1_024;
    this.siteUrl = options.siteUrl?.trim() || null;
    this.appName = options.appName?.trim() || null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("claude timeoutMs must be positive");
    if (!Number.isInteger(this.maxTokens) || this.maxTokens <= 0) throw new Error("claude maxTokens must be a positive integer");
    if (typeof this.fetchImpl !== "function") throw new Error("claude client requires a fetch implementation");
  }

  private async post(body: Record<string, unknown>): Promise<{ ok: true; json: unknown } | { ok: false; reason: ClaudeFailureReason; detail: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
       const headers: Record<string, string> = {
         "content-type": "application/json",
         authorization: `Bearer ${this.apiKey}`,
       };
       if (this.siteUrl) headers["HTTP-Referer"] = this.siteUrl;
       if (this.appName) headers["X-Title"] = this.appName;
       const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
         method: "POST",
         headers,
         body: JSON.stringify({ model: this.model, max_tokens: this.maxTokens, ...body }),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, reason: "http_error", detail: `status_${response.status}` };
      try {
        return { ok: true, json: (await response.json()) as unknown };
      } catch (error) {
        // An abort that lands while the body is still streaming must be reported
        // as a timeout, not as malformed content, or the trace misdiagnoses a
        // slow provider as a broken one.
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          return { ok: false, reason: "timeout", detail: `aborted_after_${this.timeoutMs}ms_while_reading_body` };
        }
        return { ok: false, reason: "malformed_response", detail: "response_body_is_not_json" };
      }
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      if (aborted) return { ok: false, reason: "timeout", detail: `aborted_after_${this.timeoutMs}ms` };
      return { ok: false, reason: "transport_error", detail: error instanceof Error ? error.name : "unknown_error" };
    } finally {
      clearTimeout(timer);
    }
  }

  public async callStructured(request: ClaudeStructuredRequest): Promise<ClaudeCallResult<unknown>> {
    const startedAt = performance.now();
    const elapsed = (): number => Math.round(performance.now() - startedAt);
    const posted = await this.post({
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.userContent },
      ],
      tools: [{
        type: "function",
        function: {
          name: request.tool.name,
          description: request.tool.description,
          parameters: request.tool.inputSchema,
        },
      }],
      tool_choice: { type: "function", function: { name: request.tool.name } },
    });
    if (!posted.ok) return { ok: false, reason: posted.reason, detail: posted.detail, model: this.model, latencyMs: elapsed() };
    const toolCall = messageOf(posted.json)?.tool_calls;
    const toolUse = Array.isArray(toolCall)
      ? toolCall.find((call): call is OpenRouterToolCall => {
        if (typeof call !== "object" || call === null) return false;
        const functionCall = (call as OpenRouterToolCall).function;
        return (call as OpenRouterToolCall).type === "function"
          && typeof functionCall === "object"
          && functionCall !== null
          && functionCall.name === request.tool.name;
      })
      : undefined;
    if (!toolUse || typeof toolUse.function?.arguments !== "string") {
      return { ok: false, reason: "tool_output_missing", detail: "no_tool_use_block_for_requested_tool", model: this.model, latencyMs: elapsed() };
    }
    try {
      const value: unknown = JSON.parse(toolUse.function.arguments);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, reason: "malformed_response", detail: "tool_arguments_are_not_an_object", model: this.model, latencyMs: elapsed() };
      }
      return { ok: true, value, model: this.model, latencyMs: elapsed() };
    } catch {
      return { ok: false, reason: "malformed_response", detail: "tool_arguments_are_not_json", model: this.model, latencyMs: elapsed() };
    }
  }

  public async callText(request: ClaudeTextRequest): Promise<ClaudeCallResult<string>> {
    const startedAt = performance.now();
    const elapsed = (): number => Math.round(performance.now() - startedAt);
    const posted = await this.post({
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.userContent },
      ],
    });
    if (!posted.ok) return { ok: false, reason: posted.reason, detail: posted.detail, model: this.model, latencyMs: elapsed() };
    const content = messageOf(posted.json)?.content;
    const text = typeof content === "string"
      ? content.trim()
      : Array.isArray(content)
        ? content
          .filter((part): part is { type?: unknown; text?: unknown } => typeof part === "object" && part !== null)
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("")
          .trim()
        : "";
    if (!text) return { ok: false, reason: "empty_text", detail: "no_text_block_in_response", model: this.model, latencyMs: elapsed() };
    return { ok: true, value: text, model: this.model, latencyMs: elapsed() };
  }
}

/**
 * Build a client from the environment, or return null when credentials are
 * absent. A null client keeps the whole Claude layer inert.
 */
export function claudeClientFromEnv(
  model: string | null,
  timeoutMs: number,
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): OpenRouterClaudeClient | null {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey || !model) return null;
  return new OpenRouterClaudeClient({
    apiKey,
    model,
    baseUrl: env.OPENROUTER_BASE_URL?.trim() || undefined,
    siteUrl: env.OPENROUTER_SITE_URL?.trim() || undefined,
    appName: env.OPENROUTER_APP_NAME?.trim() || undefined,
    timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
