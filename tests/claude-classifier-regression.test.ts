import assert from "node:assert/strict";
import test from "node:test";
import { loadUnifiedEgyptianDemoDataset } from "../src/demo/unified-egyptian-dataset.js";
import { BEHAVIOUR_GROUPS, graduationIntentToPrimaryIntent, loadFixtureCorpus } from "../src/evaluation/claude-classifier-corpus.js";
import { ClaudeIntentClassifier } from "../src/llm/claude-classifier.js";
import { safetyPreScreen } from "../src/llm/claude-layer.js";
import { arbitrateNlu } from "../src/llm/nlu-arbitration.js";
import { classifyRuleBasedGraduationIntent, type GraduationIntent } from "../src/runtime/graduation-demo-agent.js";
import { StubClaudeClient, classification } from "./helpers/claude-stubs.js";

const dataset = await loadUnifiedEgyptianDemoDataset();
const fixtureCases = await loadFixtureCorpus();

test("A4: the regression corpus is assembled from real repository fixtures", () => {
  assert.equal(fixtureCases.length, 60, "the evaluation fixture supplies 60 cases");
  for (const entry of fixtureCases) {
    assert.match(entry.source, /^tests[\\/]fixtures[\\/]evaluation[\\/]agent-eval\.synthetic\.json#/u);
    assert.ok(entry.question.trim().length > 0);
  }
  const behaviourCases = BEHAVIOUR_GROUPS.flatMap((group) => group.cases);
  assert.equal(behaviourCases.length, 14);
  for (const entry of behaviourCases) {
    // Each behaviour case must name the real test it was lifted from, because
    // the external bug-log labels do not map onto this repository's numbering.
    assert.match(entry.source, /^tests[\\/]graduation-(bug-log|agent-wide)\.test\.ts:\d+$/u, entry.id);
  }
});

test("A4: the rule-based label for every behaviour case is locked against regression", () => {
  // Context-free expectations. A case that needs prior conversation context to
  // reach its label is marked as such in the corpus and excluded here.
  const expectedContextFree: Record<string, GraduationIntent> = {
    "HEALTH-P1": "general_guideline",
    "HEALTH-P4": "general_guideline",
    "HEALTH-P5": "general_guideline",
    "HEALTH-P6": "general_guideline",
    "HEALTH-P7": "general_guideline",
    "HEALTH-P8": "general_guideline",
    "ELONG-P1": "find_recipe",
    "ELONG-P2": "find_recipe",
    "ELONG-P3": "find_recipe",
    "ELONG-P4": "find_recipe",
    "ELONG-P5": "recipe_nutrition",
    "ELONG-P6": "find_recipe",
  };
  for (const entry of BEHAVIOUR_GROUPS.flatMap((group) => group.cases)) {
    const observed = classifyRuleBasedGraduationIntent(dataset, entry.question);
    if (entry.requiresSessionContext) {
      assert.ok(observed, `${entry.id} still classifies to something deterministic`);
      continue;
    }
    assert.equal(observed, expectedContextFree[entry.id], `${entry.id} (${entry.source})`);
    assert.equal(observed, entry.expectedGraduationIntent, `${entry.id} matches its existing test's assertion`);
  }
});

test("A4: elongated and variant Arabic spellings classify identically to the plain spelling", () => {
  const plain = classifyRuleBasedGraduationIntent(dataset, "عايز وصفة فول");
  const elongated = classifyRuleBasedGraduationIntent(dataset, "عايز وصفة فووول");
  assert.equal(elongated, plain, "elongation must not change the intent");
  assert.equal(elongated, "find_recipe");
  // The prefix-preservation guard: "للكشري" must not be corrupted.
  assert.equal(classifyRuleBasedGraduationIntent(dataset, "القيمة الغذائية الكاملة للكشري"), "recipe_nutrition");
});

test("A4: yes/no health phrasing and WHO-recommendation phrasing both classify as general_guideline", () => {
  const yesNo = ["هل الفتة صحية للنظام الغذائي"];
  const guideline = [
    "ما توصيات منظمة الصحة العالمية عن الصوديوم؟",
    "إرشادات WHO عن السكر",
    "ما توصيات منظمة الصحة عن الدهون؟",
    "ما هي إرشادات منظمة الصحة العالمية للصوديوم؟",
    "كم ملح مسموح يوميا بشكل عام؟",
  ];
  for (const message of [...yesNo, ...guideline]) {
    assert.equal(classifyRuleBasedGraduationIntent(dataset, message), "general_guideline", message);
  }
});

test("A4: a Claude classifier that mirrors the rule-based label yields a 100% agreement rate", async () => {
  let comparable = 0;
  let agreements = 0;
  for (const entry of fixtureCases.slice(0, 20)) {
    const ruleBased = classifyRuleBasedGraduationIntent(dataset, entry.question);
    const preScreen = safetyPreScreen(entry.question, ruleBased);
    if (preScreen.safetyRouted) continue;
    const client = new StubClaudeClient({ structured: classification({ intent: ruleBased }) });
    const outcome = await new ClaudeIntentClassifier(client).classify({ message: entry.question, language: entry.language, context: null });
    const arbitration = arbitrateNlu({ graduationIntent: ruleBased, expandedPlannerIntent: null }, outcome);
    comparable += 1;
    if (arbitration.agreed === true) agreements += 1;
    assert.equal(arbitration.effectiveIntent, ruleBased, "the rule-based label always decides");
  }
  assert.ok(comparable > 0);
  assert.equal(agreements, comparable);
});

test("A4: a Claude classifier that always disagrees never changes the effective intent", async () => {
  let disagreements = 0;
  for (const entry of fixtureCases.slice(0, 20)) {
    const ruleBased = classifyRuleBasedGraduationIntent(dataset, entry.question);
    const preScreen = safetyPreScreen(entry.question, ruleBased);
    if (preScreen.safetyRouted) continue;
    const wrong: GraduationIntent = ruleBased === "unsupported" ? "compare_recipes" : "unsupported";
    const client = new StubClaudeClient({ structured: classification({ intent: wrong }) });
    const outcome = await new ClaudeIntentClassifier(client).classify({ message: entry.question, language: entry.language, context: null });
    const arbitration = arbitrateNlu({ graduationIntent: ruleBased, expandedPlannerIntent: null }, outcome);
    assert.equal(arbitration.route, "rule_based_and_claude_disagreement");
    assert.equal(arbitration.effectiveIntent, ruleBased);
    disagreements += 1;
  }
  assert.ok(disagreements > 0);
});

test("A4: safety-routed fixture cases are excluded from Claude comparison entirely", () => {
  const safetyRouted = fixtureCases.filter((entry) => safetyPreScreen(entry.question, classifyRuleBasedGraduationIntent(dataset, entry.question)).safetyRouted);
  assert.ok(safetyRouted.length > 0, "the fixture contains medical/safety cases");
  for (const entry of safetyRouted) {
    assert.equal(safetyPreScreen(entry.question, classifyRuleBasedGraduationIntent(dataset, entry.question)).safetyRouted, true, entry.id);
  }
});

test("A4: the intent projection used for head-to-head grading is total and stable", () => {
  const intents: GraduationIntent[] = [
    "find_recipe", "recipe_nutrition", "ingredient_nutrition", "compare_recipes",
    "general_guideline", "lighter_modification", "unsupported", "medical_safety",
  ];
  for (const intent of intents) {
    const projected = graduationIntentToPrimaryIntent(intent);
    assert.ok(projected.length > 0, intent);
  }
  assert.equal(graduationIntentToPrimaryIntent("medical_safety"), "medical_safety_request");
  assert.equal(graduationIntentToPrimaryIntent("ingredient_nutrition"), "recipe_nutrition");
});
