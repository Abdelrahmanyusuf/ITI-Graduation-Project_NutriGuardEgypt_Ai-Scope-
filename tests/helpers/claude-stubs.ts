import type { ClaudeCallResult, ClaudeFailureReason, ClaudeMessagesClient, ClaudeStructuredRequest, ClaudeTextRequest } from "../../src/llm/claude-client.js";
import type { ClaudeClassification } from "../../src/llm/claude-classifier.js";

export interface StubCall {
  kind: "structured" | "text";
  system: string;
  userContent: string;
}

export interface StubClaudeClientOptions {
  model?: string;
  /** Structured payload returned by `callStructured`. */
  structured?: unknown;
  /** Text returned by `callText`. */
  text?: string;
  structuredFailure?: { reason: ClaudeFailureReason; detail?: string };
  textFailure?: { reason: ClaudeFailureReason; detail?: string };
  latencyMs?: number;
}

/**
 * Deterministic stand-in for the OpenRouter Claude client.
 *
 * Records every call so a test can prove a stage ran — or, for the
 * medical_safety invariant, prove that it never ran.
 */
export class StubClaudeClient implements ClaudeMessagesClient {
  public readonly model: string;
  public readonly calls: StubCall[] = [];

  public constructor(private readonly options: StubClaudeClientOptions = {}) {
    this.model = options.model ?? "stub-claude-model";
  }

  public get callCount(): number {
    return this.calls.length;
  }

  public async callStructured(request: ClaudeStructuredRequest): Promise<ClaudeCallResult<unknown>> {
    this.calls.push({ kind: "structured", system: request.system, userContent: request.userContent });
    const latencyMs = this.options.latencyMs ?? 1;
    if (this.options.structuredFailure) {
      return { ok: false, reason: this.options.structuredFailure.reason, detail: this.options.structuredFailure.detail ?? "stub", model: this.model, latencyMs };
    }
    return { ok: true, value: this.options.structured, model: this.model, latencyMs };
  }

  public async callText(request: ClaudeTextRequest): Promise<ClaudeCallResult<string>> {
    this.calls.push({ kind: "text", system: request.system, userContent: request.userContent });
    const latencyMs = this.options.latencyMs ?? 1;
    if (this.options.textFailure) {
      return { ok: false, reason: this.options.textFailure.reason, detail: this.options.textFailure.detail ?? "stub", model: this.model, latencyMs };
    }
    return { ok: true, value: this.options.text ?? "", model: this.model, latencyMs };
  }
}

/** A client whose text stage echoes a template supplied per call. */
export class ScriptedFormatterClient implements ClaudeMessagesClient {
  public readonly model: string;
  public readonly calls: StubCall[] = [];

  public constructor(private readonly respond: (userContent: string) => string, model = "stub-formatter-model") {
    this.model = model;
  }

  public async callStructured(): Promise<ClaudeCallResult<unknown>> {
    throw new Error("scripted formatter client does not support structured calls");
  }

  public async callText(request: ClaudeTextRequest): Promise<ClaudeCallResult<string>> {
    this.calls.push({ kind: "text", system: request.system, userContent: request.userContent });
    return { ok: true, value: this.respond(request.userContent), model: this.model, latencyMs: 1 };
  }
}

export function classification(
  overrides: Partial<Omit<ClaudeClassification, "entities">> & { entities?: Partial<ClaudeClassification["entities"]> } = {},
): ClaudeClassification {
  const { entities, ...rest } = overrides;
  return {
    intent: "recipe_nutrition",
    confidence: 0.9,
    referenced_recipe_id: null,
    raw_reasoning_note: "stub note",
    ...rest,
    entities: {
      recipe_or_ingredient_name: null,
      meal_category: null,
      calorie_ceiling: null,
      calorie_ceiling_mode: null,
      exclusions: [],
      comparison_targets: [],
      ...entities,
    },
  };
}

/** Collects structured log lines for assertions about logging requirements. */
export class RecordingLogger {
  public readonly entries: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];

  public log(level: string, event: string, fields: Record<string, unknown> = {}): void {
    this.entries.push({ level, event, fields });
  }

  public find(event: string): Array<{ level: string; event: string; fields: Record<string, unknown> }> {
    return this.entries.filter((entry) => entry.event === event);
  }
}
