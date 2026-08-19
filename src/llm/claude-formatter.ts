/**
 * Part B1 — Claude as a response formatter.
 *
 * The deterministic pipeline has already produced every number and every fact
 * before this module runs. Claude receives that finished structured payload and
 * nothing else: no database handle, no retrieval tool, no permission to add a
 * fact, and no way to request more data. Its only product is prose.
 *
 * The output is worthless until `grounding-validator.ts` clears it, and the
 * caller must fall back to the deterministic template on any failure.
 */

import type { ClaudeCallResult, ClaudeMessagesClient } from "./claude-client.js";

export type FormatterFailureReason =
  | "not_configured"
  | "timeout"
  | "transport_error"
  | "http_error"
  | "malformed_response"
  | "tool_output_missing"
  | "empty_text";

export type FormatterOutcome =
  | { ok: true; text: string; model: string; latencyMs: number }
  | { ok: false; failureReason: FormatterFailureReason; detail: string; model: string; latencyMs: number };

/**
 * The complete, self-contained fact payload handed to Claude.
 *
 * `allowedEntityNames` and `listItemOrdinals` are derived from the same facts,
 * so the grounding validator's permitted set is exactly what Claude was told.
 */
export interface FormatterFacts {
  intent: string;
  language: "ar-EG" | "ar" | "en";
  /** The deterministic template text, supplied as the reference wording. */
  deterministicText: string;
  /** Structured values computed by Steps 4–9. The only permitted numbers. */
  values: Record<string, unknown>;
  /** Entity names the reply may mention. */
  allowedEntityNames: string[];
  /** Ordinals a list may legitimately use, e.g. [1,2,3] for three items. */
  listItemOrdinals: number[];
}

const FORMATTER_SYSTEM_PROMPT = [
  "You are the wording layer of NutriGuard, a deterministic Egyptian-food nutrition assistant.",
  "",
  "A verified calculation engine has ALREADY produced every fact below. You are rewriting finished content, not answering a question.",
  "",
  "Absolute rules — a breach makes your entire output unusable:",
  "- Never perform arithmetic. Never add, convert, total, average or round a value beyond one decimal place.",
  "- Use ONLY the numbers present in the supplied facts. Introducing any other number is a critical failure.",
  "- Never name a dish, ingredient, brand or source that is not in the supplied facts.",
  "- Never add a nutritional claim, health claim, benefit, risk or recommendation that is not in the supplied facts.",
  "- Never remove a caveat, disclaimer, missing-data note or safety sentence. If the facts say a value is unknown, say it is unknown — never zero.",
  "- Never give medical advice and never address a medical condition.",
  "",
  "Your task: restate the reference text as warm, natural, fluent prose in the requested language.",
  "For ar-EG use everyday Egyptian Arabic; for ar use Modern Standard Arabic; for en use plain English.",
  "Keep every number, unit, entity name and caveat intact. Improve only the phrasing and flow.",
  "",
  "Reply with the finished user-facing text alone: no preamble, no explanation, no markdown fences.",
].join("\n");

function renderFacts(facts: FormatterFacts): string {
  return [
    `Intent: ${facts.intent}`,
    `Target language: ${facts.language}`,
    "",
    "Permitted entity names (you may mention no others):",
    facts.allowedEntityNames.length > 0 ? facts.allowedEntityNames.map((name) => `- ${name}`).join("\n") : "- (none)",
    "",
    "Structured facts computed by the deterministic engine (the only permitted numbers):",
    JSON.stringify(facts.values, null, 2),
    "",
    facts.listItemOrdinals.length > 0 ? `List ordinals you may use: ${facts.listItemOrdinals.join(", ")}` : "",
    "",
    "Reference text produced by the deterministic template — restate this, preserving every number and caveat:",
    facts.deterministicText,
  ].filter((line) => line !== "").join("\n");
}

function failureReason(result: Extract<ClaudeCallResult<string>, { ok: false }>): FormatterFailureReason {
  return result.reason;
}

export class ClaudeResponseFormatter {
  public constructor(private readonly client: ClaudeMessagesClient) {}

  public get model(): string {
    return this.client.model;
  }

  public async format(facts: FormatterFacts): Promise<FormatterOutcome> {
    const result = await this.client.callText({ system: FORMATTER_SYSTEM_PROMPT, userContent: renderFacts(facts) });
    if (!result.ok) {
      return { ok: false, failureReason: failureReason(result), detail: result.detail, model: result.model, latencyMs: result.latencyMs };
    }
    return { ok: true, text: result.value, model: result.model, latencyMs: result.latencyMs };
  }
}

/**
 * Collect the entity names a response payload is allowed to mention.
 *
 * Only string fields whose keys denote a name are harvested, so arbitrary
 * free text in the payload cannot silently widen the permitted set.
 */
const NAME_KEY = /(?:^|[._])(?:name|nameAr|nameEn|displayName|recipeName|title|suppliedName)$/iu;

export function collectAllowedEntityNames(payload: unknown, depth = 0): string[] {
  if (depth > 12) return [];
  if (Array.isArray(payload)) return payload.flatMap((entry) => collectAllowedEntityNames(entry, depth + 1));
  if (typeof payload !== "object" || payload === null) return [];
  const names: string[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value === "string" && NAME_KEY.test(key) && value.trim() !== "") names.push(value.trim());
    else if (typeof value === "object" && value !== null) names.push(...collectAllowedEntityNames(value, depth + 1));
  }
  return [...new Set(names)];
}

/** Count the longest list in the payload, to derive legitimate ordinals. */
export function longestListLength(payload: unknown, depth = 0): number {
  if (depth > 12) return 0;
  if (Array.isArray(payload)) {
    return Math.max(payload.length, ...payload.map((entry) => longestListLength(entry, depth + 1)), 0);
  }
  if (typeof payload !== "object" || payload === null) return 0;
  return Math.max(0, ...Object.values(payload as Record<string, unknown>).map((entry) => longestListLength(entry, depth + 1)));
}

/**
 * Build the formatter payload from a finished deterministic response.
 *
 * `values` is the response's own `data` object — already computed, already
 * rounded for display by the pipeline.
 */
export function buildFormatterFacts(input: {
  intent: string;
  language: "ar-EG" | "ar" | "en";
  deterministicText: string;
  data: Record<string, unknown>;
}): FormatterFacts {
  const ordinalCount = Math.min(20, longestListLength(input.data));
  return {
    intent: input.intent,
    language: input.language,
    deterministicText: input.deterministicText,
    values: input.data,
    allowedEntityNames: collectAllowedEntityNames(input.data),
    listItemOrdinals: Array.from({ length: ordinalCount }, (_, index) => index + 1),
  };
}
