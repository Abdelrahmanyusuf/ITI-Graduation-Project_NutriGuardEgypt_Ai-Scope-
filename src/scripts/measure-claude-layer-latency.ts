/**
 * Step 17b latency measurement (acceptance criterion 4).
 *
 * Measures the layer's own overhead per intent: baseline (layer inert) versus
 * layer enabled with zero-latency local stand-ins for the two Claude stages.
 * That isolates the cost this step adds in-process — the dual-run planner call,
 * entity validation, grounding validation and trace capture — from provider
 * network time.
 *
 * Provider network time is NOT estimated here. With no OPENROUTER_API_KEY
 * configured it cannot be measured, and inventing a figure would be worse than
 * reporting its absence.
 *
 * Run with: npm run measure:claude-layer
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../config/load-local-env.js";
import { loadClaudeLayerConfig } from "../llm/claude-config.js";
import { ClaudeLayer } from "../llm/claude-layer.js";
import { claudeClientFromEnv, type ClaudeCallResult, type ClaudeMessagesClient } from "../llm/claude-client.js";
import { buildGraduationDemoAgent } from "../runtime/graduation-demo-agent.js";

loadLocalEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, "..", "..");
const OUTPUT_PATH = path.join(PROJECT_ROOT, "data", "reports", "step17b-latency.json");

const ITERATIONS = 20;
const WARMUP = 3;

/** Zero-latency local stand-in: isolates in-process overhead from network time. */
class ZeroLatencyClient implements ClaudeMessagesClient {
  public constructor(public readonly model: string, private readonly structured: unknown, private readonly text: string) {}

  public async callStructured(): Promise<ClaudeCallResult<unknown>> {
    return { ok: true, value: this.structured, model: this.model, latencyMs: 0 };
  }

  public async callText(): Promise<ClaudeCallResult<string>> {
    return { ok: true, value: this.text, model: this.model, latencyMs: 0 };
  }
}

interface Probe {
  intent: string;
  message: string;
}

const probes: Probe[] = [
  { intent: "recipe_nutrition", message: "القيمة الغذائية الكاملة للكشري" },
  { intent: "ingredient_nutrition", message: "احسب 150 جرام رز + 100 جرام صدور فراخ" },
  { intent: "compare_recipes", message: "الفول ولا الكشري أقل صوديوم؟" },
  { intent: "lighter_modification", message: "عايز كشري دايت" },
  { intent: "find_recipe", message: "طريقة عمل الكشري المصري" },
  { intent: "general_guideline", message: "ما توصيات منظمة الصحة العالمية عن الصوديوم؟" },
  { intent: "meal_plan", message: "عاوز 3 وجبات اليوم 1800 سعر" },
  { intent: "medical_safety", message: "اكتبلي دواء للضغط" },
];

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Math.round((sorted[index] ?? 0) * 100) / 100;
}

async function measure(agent: { invoke(input: { message: string; language: "ar-EG" }): Promise<unknown> }, message: string): Promise<{ medianMs: number; p95Ms: number; meanMs: number }> {
  for (let index = 0; index < WARMUP; index += 1) await agent.invoke({ message, language: "ar-EG" });
  const samples: number[] = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const startedAt = performance.now();
    await agent.invoke({ message, language: "ar-EG" });
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  return {
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    meanMs: Math.round((samples.reduce((total, value) => total + value, 0) / samples.length) * 100) / 100,
  };
}

const config = {
  ...loadClaudeLayerConfig({}),
  classifierEnabled: true,
  classifierModel: "zero-latency-classifier-stub",
  formatterEnabled: true,
  formatterModel: "zero-latency-formatter-stub",
};

// The formatter stub returns text that cannot pass grounding validation, so the
// measured path always includes a full validation pass plus template fallback —
// the most expensive Part B route, not the cheapest.
const stubClassification = {
  intent: "recipe_nutrition",
  confidence: 0.9,
  entities: { recipe_or_ingredient_name: null, meal_category: null, calorie_ceiling: null, calorie_ceiling_mode: null, exclusions: [], comparison_targets: [] },
  raw_reasoning_note: "latency probe",
};

const baseline = await buildGraduationDemoAgent("test", null);
const instrumented = await buildGraduationDemoAgent("test", null, new ClaudeLayer({
  config,
  classifierClient: new ZeroLatencyClient("zero-latency-classifier-stub", stubClassification, ""),
  formatterClient: new ZeroLatencyClient("zero-latency-formatter-stub", stubClassification, "صياغة بديلة برقم 999999 غير قابل للتتبع"),
}));

const rows: Array<Record<string, unknown>> = [];
for (const probe of probes) {
  const before = await measure(baseline, probe.message);
  const after = await measure(instrumented, probe.message);
  rows.push({
    intent: probe.intent,
    baselineMedianMs: before.medianMs,
    layerMedianMs: after.medianMs,
    deltaMedianMs: Math.round((after.medianMs - before.medianMs) * 100) / 100,
    baselineP95Ms: before.p95Ms,
    layerP95Ms: after.p95Ms,
    baselineMeanMs: before.meanMs,
    layerMeanMs: after.meanMs,
    deltaMeanMs: Math.round((after.meanMs - before.meanMs) * 100) / 100,
  });
}

const report = {
  schemaVersion: "1.0",
  title: "Step 17b Claude layer latency impact",
  generatedAt: new Date().toISOString(),
  iterationsPerCase: ITERATIONS,
  warmupIterations: WARMUP,
  measurementScope: "in-process overhead only",
  providerNetworkLatencyMeasured: false,
  providerNetworkLatencyNote:
    "No OPENROUTER_API_KEY is configured, so real Claude round-trip time is unmeasured and deliberately not estimated. "
    + "Configured stage timeouts bound it: "
    + `${loadClaudeLayerConfig().classifierTimeoutMs}ms for the classifier and ${loadClaudeLayerConfig().formatterTimeoutMs}ms for the formatter, `
    + "after which the deterministic fallback runs.",
  claudeCredentialsPresent: claudeClientFromEnv("probe-model", 1_000) !== null,
  notes: [
    "Baseline is the agent with the Claude layer inert, which is the pre-Step-17b code path.",
    "The instrumented run exercises the classifier stage, the formatter stage, a full grounding validation pass, and the template fallback.",
    "medical_safety is included to show the safety pre-screen short-circuits before any Claude stage.",
  ],
  perIntent: rows,
};

await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
