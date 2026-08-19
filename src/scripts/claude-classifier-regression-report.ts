/**
 * Part A4 — classifier regression comparison report.
 *
 * Runs BOTH rule-based classifiers and the Claude classifier over the same
 * corpus and reports, per case: the rule-based label, the coarse planner label,
 * Claude's label, whether they agree, and which was correct according to the
 * repository's own expected-answer fixtures.
 *
 * Every case is reported — favourable or not. When Claude is not configured the
 * report says so explicitly and leaves the agreement rate null rather than
 * implying a result that was never measured.
 *
 * Run with: npm run report:claude-classifier
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../config/load-local-env.js";
import { RuleBasedExpandedAgentPlanner } from "../agent/expanded-agent.js";
import { NUTRIGUARD_SYSTEM_PROMPT, NUTRIGUARD_SYSTEM_PROMPT_VERSION } from "../agent/system-prompt.js";
import { loadUnifiedEgyptianDemoDataset } from "../demo/unified-egyptian-dataset.js";
import { ClaudeIntentClassifier } from "../llm/claude-classifier.js";
import { claudeClientFromEnv } from "../llm/claude-client.js";
import { loadClaudeLayerConfig } from "../llm/claude-config.js";
import { expandedPlannerIntentOf } from "../llm/nlu-arbitration.js";
import { safetyPreScreen } from "../llm/claude-layer.js";
import { classifyRuleBasedGraduationIntent, buildGraduationDemoAgent, type GraduationIntent } from "../runtime/graduation-demo-agent.js";
import {
  BEHAVIOUR_GROUPS,
  graduationIntentToPrimaryIntent,
  loadFixtureCorpus,
} from "../evaluation/claude-classifier-corpus.js";

loadLocalEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, "..", "..");
const OUTPUT_PATH = path.join(PROJECT_ROOT, "data", "reports", "step17b-claude-classifier-regression.json");

const config = loadClaudeLayerConfig();
const client = claudeClientFromEnv(config.classifierModel, config.classifierTimeoutMs);
const classifier = client ? new ClaudeIntentClassifier(client) : null;
const planner = new RuleBasedExpandedAgentPlanner();
const dataset = await loadUnifiedEgyptianDemoDataset();
// Used to establish authoritative correctness: the fixture grades the response
// the pipeline actually produces, not a router label taken in isolation.
const agent = await buildGraduationDemoAgent("test", null);

type ClaudeVerdict = string;

interface CaseRow {
  id: string;
  group: string;
  source: string;
  /**
   * Included because this report is the separate, explicitly-scoped A4 artifact
   * permitted by C2. Every question here comes from a synthetic repository
   * fixture or an existing test file — never from live user traffic.
   */
  question: string;
  language: string;
  requiresSessionContext: boolean;
  ruleBasedGraduationIntent: GraduationIntent;
  expandedPlannerIntent: string;
  safetyRouted: boolean;
  claudeIntent: ClaudeVerdict;
  claudeConfidence: number | null;
  claudeFailureReason: string | null;
  agreed: boolean | null;
  expected: string;
  expectedBasis: "fixture_primary_intent" | "existing_regression_test_graduation_intent";
  /**
   * Authoritative signal for fixture cases: the primaryIntent of the response
   * the deterministic pipeline actually produced, compared with the fixture.
   */
  observedResponsePrimaryIntent: string | null;
  pipelineMatchesFixture: boolean | null;
  /**
   * Symmetric head-to-head grading. Both labels are projected onto the
   * fixture's coarser primaryIntent space by the same function, so the two
   * columns are directly comparable to each other.
   */
  ruleBasedLabelCorrect: boolean | null;
  claudeLabelCorrect: boolean | null;
  note?: string;
}

async function claudeLabel(message: string, language: "ar-EG" | "ar" | "en"): Promise<{
  intent: ClaudeVerdict;
  confidence: number | null;
  failureReason: string | null;
}> {
  if (!classifier) return { intent: "not_configured", confidence: null, failureReason: "no_openrouter_credentials" };
  const outcome = await classifier.classify({ message, language, context: null });
  if (!outcome.ok) return { intent: "call_failed", confidence: null, failureReason: outcome.failureReason };
  return { intent: outcome.classification.intent, confidence: outcome.classification.confidence, failureReason: null };
}

async function plannerLabel(message: string, language: "ar-EG" | "ar" | "en"): Promise<string> {
  try {
    const plan = await planner.plan({
      systemPrompt: NUTRIGUARD_SYSTEM_PROMPT,
      promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
      userMessage: message,
      language,
    });
    return expandedPlannerIntentOf(plan) ?? "none";
  } catch {
    return "error";
  }
}

const rows: CaseRow[] = [];

// ---------------------------------------------------------------------------
// Source 1: the 60-case evaluation fixture, graded by its own expectedIntent.
// ---------------------------------------------------------------------------
for (const entry of await loadFixtureCorpus()) {
  const ruleBased = classifyRuleBasedGraduationIntent(dataset, entry.question);
  const preScreen = safetyPreScreen(entry.question, ruleBased);
  const claude = preScreen.safetyRouted
    ? { intent: "not_invoked_safety_routed" as ClaudeVerdict, confidence: null, failureReason: null }
    : await claudeLabel(entry.question, entry.language);
  const claudeComparable = !["not_configured", "call_failed", "not_invoked_safety_routed"].includes(claude.intent);
  const response = await agent.invoke({ message: entry.question, language: entry.language });
  // Safety-routed cases are graded only by the pipeline: the router label is
  // deliberately bypassed there, so scoring it head-to-head would be meaningless.
  const labelGradable = !preScreen.safetyRouted;
  rows.push({
    id: entry.id,
    group: `fixture:${entry.category}`,
    source: entry.source,
    question: entry.question,
    language: entry.language,
    requiresSessionContext: false,
    ruleBasedGraduationIntent: ruleBased,
    expandedPlannerIntent: await plannerLabel(entry.question, entry.language),
    safetyRouted: preScreen.safetyRouted,
    claudeIntent: claude.intent,
    claudeConfidence: claude.confidence,
    claudeFailureReason: claude.failureReason,
    agreed: claudeComparable ? claude.intent === ruleBased : null,
    expected: entry.expectedPrimaryIntent,
    expectedBasis: "fixture_primary_intent",
    observedResponsePrimaryIntent: response.primaryIntent,
    pipelineMatchesFixture: response.primaryIntent === entry.expectedPrimaryIntent,
    ruleBasedLabelCorrect: labelGradable ? graduationIntentToPrimaryIntent(ruleBased) === entry.expectedPrimaryIntent : null,
    claudeLabelCorrect: labelGradable && claudeComparable
      ? graduationIntentToPrimaryIntent(claude.intent as GraduationIntent) === entry.expectedPrimaryIntent
      : null,
  });
}

// ---------------------------------------------------------------------------
// Source 2: the two behaviour groups, graded against the exact 8-intent label
// that this repository's existing passing tests assert.
// ---------------------------------------------------------------------------
for (const group of BEHAVIOUR_GROUPS) {
  for (const entry of group.cases) {
    const ruleBased = classifyRuleBasedGraduationIntent(dataset, entry.question);
    const preScreen = safetyPreScreen(entry.question, ruleBased);
    const claude = preScreen.safetyRouted
      ? { intent: "not_invoked_safety_routed" as ClaudeVerdict, confidence: null, failureReason: null }
      : await claudeLabel(entry.question, entry.language);
    const claudeComparable = !["not_configured", "call_failed", "not_invoked_safety_routed"].includes(claude.intent);
    rows.push({
      id: entry.id,
      group: group.key,
      source: entry.source,
      question: entry.question,
      language: entry.language,
      requiresSessionContext: entry.requiresSessionContext === true,
      ruleBasedGraduationIntent: ruleBased,
      expandedPlannerIntent: await plannerLabel(entry.question, entry.language),
      safetyRouted: preScreen.safetyRouted,
      claudeIntent: claude.intent,
      claudeConfidence: claude.confidence,
      claudeFailureReason: claude.failureReason,
      agreed: claudeComparable ? claude.intent === ruleBased : null,
      expected: entry.expectedGraduationIntent,
      expectedBasis: "existing_regression_test_graduation_intent",
      observedResponsePrimaryIntent: null,
      pipelineMatchesFixture: null,
      ruleBasedLabelCorrect: ruleBased === entry.expectedGraduationIntent,
      claudeLabelCorrect: claudeComparable ? claude.intent === entry.expectedGraduationIntent : null,
      note: entry.note,
    });
  }
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10;
}

function summarize(subset: CaseRow[]) {
  const comparable = subset.filter((row) => row.agreed !== null);
  const ruleGraded = subset.filter((row) => row.ruleBasedLabelCorrect !== null);
  const claudeGraded = subset.filter((row) => row.claudeLabelCorrect !== null);
  const pipelineGraded = subset.filter((row) => row.pipelineMatchesFixture !== null);
  return {
    total: subset.length,
    comparableWithClaude: comparable.length,
    agreements: comparable.filter((row) => row.agreed === true).length,
    disagreements: comparable.filter((row) => row.agreed === false).length,
    agreementRatePercent: rate(comparable.filter((row) => row.agreed === true).length, comparable.length),
    labelGradedCases: ruleGraded.length,
    ruleBasedLabelCorrectRatePercent: rate(ruleGraded.filter((row) => row.ruleBasedLabelCorrect === true).length, ruleGraded.length),
    claudeLabelCorrectRatePercent: rate(claudeGraded.filter((row) => row.claudeLabelCorrect === true).length, claudeGraded.length),
    pipelineMatchesFixtureRatePercent: rate(pipelineGraded.filter((row) => row.pipelineMatchesFixture === true).length, pipelineGraded.length),
    safetyRoutedCases: subset.filter((row) => row.safetyRouted).length,
  };
}

const report = {
  schemaVersion: "1.0",
  title: "Step 17b Claude classifier regression comparison (Part A4)",
  generatedAt: new Date().toISOString(),
  claudeConfigured: classifier !== null,
  claudeModel: config.classifierModel,
  honestyNotes: [
    "The rule-based label is always the one that decides routing (Part A3); Claude is advisory only.",
    "Safety-routed cases are reported with claudeIntent \"not_invoked_safety_routed\" because invariant I4 forbids any Claude call on those requests.",
    "expandedPlannerIntent comes from RuleBasedExpandedAgentPlanner, which has a coarser 5-outcome space and is therefore reported but never scored for agreement.",
    "The external bug-log labels BUG-04 and BUG-06 do not map onto this repository's numbering; each behaviour case records its real source test file and line instead.",
    "pipelineMatchesFixture is the authoritative correctness signal for fixture cases: it compares the primaryIntent of the response the deterministic pipeline actually produced against the fixture's expectation.",
    "ruleBasedLabelCorrect and claudeLabelCorrect grade the two 8-intent labels head-to-head by projecting both onto the fixture's coarser primaryIntent space with the same function. The projection is many-to-one, so these columns are a fair comparison between the two classifiers but are not a measure of end-to-end system correctness.",
    "Label grading is skipped for safety-routed fixture cases because the router label is intentionally bypassed there; only the pipeline column is meaningful for those.",
    "The 60-case fixture's expectations were authored for the synthetic expanded agent used by tests/synthetic-evaluation.integration.test.ts (buildSyntheticDemoAgent), not for the graduation router measured here. pipelineMatchesFixture below 100% is therefore a difference of subject under test, NOT a regression: that existing suite still passes unchanged.",
    "Cases marked requiresSessionContext reach their expected label in the existing tests only because a previous turn supplied conversation context. This report classifies every message context-free, so such a case may legitimately differ here.",
    "Every question in this report originates from a synthetic repository fixture or an existing test file. No live user message is included.",
  ],
  overall: summarize(rows),
  byGroup: Object.fromEntries(
    [...new Set(rows.map((row) => row.group))].map((group) => [group, summarize(rows.filter((row) => row.group === group))]),
  ),
  behaviourGroupDefinitions: BEHAVIOUR_GROUPS.map((group) => ({
    key: group.key,
    title: group.title,
    description: group.description,
    caseSources: group.cases.map((entry) => ({ id: entry.id, source: entry.source, note: entry.note })),
  })),
  cases: rows,
};

await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  event: "claude_classifier_regression_report",
  output: path.relative(PROJECT_ROOT, OUTPUT_PATH),
  claudeConfigured: report.claudeConfigured,
  claudeModel: report.claudeModel,
  overall: report.overall,
  byGroup: report.byGroup,
}, null, 2));

if (!report.claudeConfigured) {
  console.log(JSON.stringify({
    event: "claude_classifier_regression_report_incomplete",
    reason: "OPENROUTER_API_KEY and CLAUDE_CLASSIFIER_MODEL are required to measure a real agreement rate",
    ruleBasedBaselineStillMeasured: true,
  }, null, 2));
}
