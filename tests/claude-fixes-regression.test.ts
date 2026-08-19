import assert from "node:assert/strict";
import test from "node:test";
import { clampStageTimeouts, loadClaudeLayerConfig, NON_LLM_TIME_RESERVE_MS } from "../src/llm/claude-config.js";
import { ClaudeLayer } from "../src/llm/claude-layer.js";
import { validateGrounding } from "../src/llm/grounding-validator.js";
import { buildGraduationDemoAgent, type GraduationConversationContext } from "../src/runtime/graduation-demo-agent.js";
import { RecordingLogger, ScriptedFormatterClient, StubClaudeClient, classification } from "./helpers/claude-stubs.js";

// ---------------------------------------------------------------------------
// Fix 1 — stage timeouts must fit inside the HTTP request budget.
//
// Regression guard for a reported production failure: 30 s stage timeouts with a
// 15 s server request timeout made the request itself time out, and http-app
// maps any status >= 500 onto "The service could not complete the request." The
// user saw an error instead of a correct deterministic meal plan.
// ---------------------------------------------------------------------------

test("timeout budget: generous stage timeouts are clamped to fit the request budget", () => {
  const clamped = clampStageTimeouts(30_000, 30_000, 15_000);
  assert.equal(clamped.clamped, true);
  assert.ok(clamped.classifierTimeoutMs + clamped.formatterTimeoutMs + NON_LLM_TIME_RESERVE_MS <= 15_000);
  assert.equal(clamped.classifierTimeoutMs, 5_000);
  assert.equal(clamped.formatterTimeoutMs, 5_000);
});

test("timeout budget: timeouts that already fit are left untouched", () => {
  const clamped = clampStageTimeouts(3_000, 6_000, 15_000);
  assert.equal(clamped.clamped, false);
  assert.equal(clamped.classifierTimeoutMs, 3_000);
  assert.equal(clamped.formatterTimeoutMs, 6_000);
});

test("timeout budget: proportional scaling preserves the operator's relative weighting", () => {
  const clamped = clampStageTimeouts(4_000, 16_000, 15_000);
  assert.equal(clamped.clamped, true);
  assert.ok(clamped.formatterTimeoutMs > clamped.classifierTimeoutMs, "the formatter keeps the larger share");
  assert.ok(clamped.classifierTimeoutMs + clamped.formatterTimeoutMs + NON_LLM_TIME_RESERVE_MS <= 15_000);
});

test("timeout budget: a tiny request budget still leaves a usable floor", () => {
  const clamped = clampStageTimeouts(30_000, 30_000, 1_000);
  assert.ok(clamped.classifierTimeoutMs >= 250);
  assert.ok(clamped.formatterTimeoutMs >= 250);
});

test("timeout budget: the reported 30s/30s + 15s misconfiguration is clamped by the loader", () => {
  const config = loadClaudeLayerConfig({
    CLAUDE_CLASSIFIER_MODEL: "m",
    CLAUDE_FORMATTER_MODEL: "m",
    CLAUDE_CLASSIFIER_TIMEOUT_SECONDS: "30",
    CLAUDE_FORMATTER_TIMEOUT_SECONDS: "30",
    REQUEST_TIMEOUT_SECONDS: "15",
  });
  assert.equal(config.requestedClassifierTimeoutMs, 30_000);
  assert.equal(config.requestedFormatterTimeoutMs, 30_000);
  assert.equal(config.stageTimeoutsClamped, true);
  assert.ok(config.classifierTimeoutMs + config.formatterTimeoutMs + NON_LLM_TIME_RESERVE_MS <= config.requestBudgetMs);
});

test("timeout budget: clamping is logged as a warning rather than applied silently", () => {
  const logger = new RecordingLogger();
  const config = loadClaudeLayerConfig({
    CLAUDE_CLASSIFIER_MODEL: "m",
    CLAUDE_FORMATTER_MODEL: "m",
    CLAUDE_CLASSIFIER_TIMEOUT_SECONDS: "30",
    CLAUDE_FORMATTER_TIMEOUT_SECONDS: "30",
  });
  new ClaudeLayer({
    config,
    classifierClient: new StubClaudeClient({ structured: classification() }),
    formatterClient: null,
    logger,
  });
  const warnings = logger.find("nutriguard_claude_stage_timeouts_clamped");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.level, "warn");
  assert.equal(warnings[0]!.fields.requestedFormatterTimeoutMs, 30_000);
});

// ---------------------------------------------------------------------------
// Fix 2 — deterministic conversational memory for a bare definite reference.
// ---------------------------------------------------------------------------

const agent = await buildGraduationDemoAgent("test", null);

async function recommendationContext(): Promise<{ context: GraduationConversationContext; recipeId: string }> {
  const first = await agent.invoke({ message: "عاوز منك وجبه فطار تتكون من 500 سعر حراري", language: "ar-EG" });
  const data = first.data as Record<string, unknown>;
  return { context: data.conversationContext as GraduationConversationContext, recipeId: data.recipeId as string };
}

function resolvedRecipeId(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const nested = (data.recipe as { recipeId?: string } | undefined)?.recipeId;
  return (data.recipeId as string | undefined) ?? nested ?? null;
}

test("memory: a bare definite reference resolves to the recommended recipe without any LLM", async () => {
  const { context, recipeId } = await recommendationContext();
  const response = await agent.invoke({ message: "تمام اعرضلي مكونات الوصفه", language: "ar-EG", context });
  assert.equal(response.status, "ok");
  assert.equal((response.data as Record<string, unknown>).intent, "find_recipe");
  assert.equal(resolvedRecipeId(response.data), recipeId);
  // The old behaviour asked for gram weights, which is the symptom to guard.
  assert.doesNotMatch(response.message, /اكتب كل مكوّن ووزنه بالجرام/u);
});

test("memory: definite-reference synonyms all keep the active recipe", async () => {
  const { context, recipeId } = await recommendationContext();
  const cases: Array<{ message: string; intent: string }> = [
    { message: "اعرضلي مكونات الطبق", intent: "find_recipe" },
    { message: "ايه سعرات الوصفه", intent: "recipe_nutrition" },
    { message: "خفف الوصفه", intent: "lighter_modification" },
    { message: "show me the recipe ingredients", intent: "find_recipe" },
  ];
  for (const entry of cases) {
    const response = await agent.invoke({ message: entry.message, language: /[A-Za-z]/u.test(entry.message) ? "en" : "ar-EG", context });
    assert.equal(response.status, "ok", entry.message);
    assert.equal((response.data as Record<string, unknown>).intent, entry.intent, entry.message);
    assert.equal(resolvedRecipeId(response.data), recipeId, entry.message);
  }
});

test("memory: a bare reference with no session context still fails closed", async () => {
  const response = await agent.invoke({ message: "اعرضلي مكونات الوصفه", language: "ar-EG" });
  assert.notEqual(response.status, "ok");
});

// ---------------------------------------------------------------------------
// Fix 3 — model-assisted reference resolution over a CLOSED candidate set.
// ---------------------------------------------------------------------------

function layerResolving(referencedRecipeId: string | null, logger?: RecordingLogger): ClaudeLayer {
  const config = {
    ...loadClaudeLayerConfig({}),
    classifierEnabled: true,
    classifierModel: "stub-classifier",
    formatterEnabled: false,
    formatterModel: null,
    referenceResolutionEnabled: true,
  };
  return new ClaudeLayer({
    config,
    classifierClient: new StubClaudeClient({
      model: "stub-classifier",
      structured: classification({ intent: "find_recipe", referenced_recipe_id: referencedRecipeId }),
    }),
    formatterClient: null,
    ...(logger ? { logger } : {}),
  });
}

test("reference resolution: a candidate-set member is accepted and answers the question", async () => {
  const { context, recipeId } = await recommendationContext();
  const resolving = await buildGraduationDemoAgent("test", null, layerResolving(recipeId));
  // Phrasing with no deterministic cue: only the model can resolve it.
  const response = await resolving.invoke({ message: "طيب وريني مكوناتها ايه", language: "ar-EG", context });
  assert.equal(response.status, "ok");
  assert.equal(resolvedRecipeId(response.data), recipeId);
  const trace = resolving.claudeLayer.store.latest()!;
  assert.equal(trace.referenceResolution, "accepted");
  assert.equal(trace.referenceResolvedRecipeId, recipeId);
});

test("reference resolution: an id outside the candidate set is rejected and never used", async () => {
  const { context } = await recommendationContext();
  // EGY-RCP-001 is a real recipe but was never discussed in this session.
  const resolving = await buildGraduationDemoAgent("test", null, layerResolving("EGY-RCP-001"));
  const response = await resolving.invoke({ message: "طيب وريني مكوناتها ايه", language: "ar-EG", context });
  const trace = resolving.claudeLayer.store.latest()!;
  assert.equal(trace.referenceResolution, "rejected_outside_candidate_set");
  assert.equal(trace.referenceResolvedRecipeId, null);
  assert.notEqual(resolvedRecipeId(response.data), "EGY-RCP-001", "a non-candidate recipe must never be substituted");
});

test("reference resolution: a fabricated id is rejected", async () => {
  const { context } = await recommendationContext();
  const resolving = await buildGraduationDemoAgent("test", null, layerResolving("EGY-RCP-999"));
  await resolving.invoke({ message: "طيب وريني مكوناتها ايه", language: "ar-EG", context });
  const trace = resolving.claudeLayer.store.latest()!;
  assert.equal(trace.referenceResolution, "rejected_outside_candidate_set");
  assert.equal(trace.referenceResolvedRecipeId, null);
});

test("reference resolution: never runs on a safety-routed request", async () => {
  const { context } = await recommendationContext();
  const client = new StubClaudeClient({ model: "stub-classifier", structured: classification({ referenced_recipe_id: "EGY-RCP-001" }) });
  const config = {
    ...loadClaudeLayerConfig({}),
    classifierEnabled: true,
    classifierModel: "stub-classifier",
    formatterEnabled: false,
    formatterModel: null,
    referenceResolutionEnabled: true,
  };
  const resolving = await buildGraduationDemoAgent("test", null, new ClaudeLayer({ config, classifierClient: client, formatterClient: null }));
  const response = await resolving.invoke({ message: "اكتبلي دواء للضغط", language: "ar-EG", context });
  assert.equal(response.status, "refused");
  assert.equal(client.callCount, 0);
  const trace = resolving.claudeLayer.store.latest()!;
  assert.equal(trace.safetyRouted, true);
  assert.equal(trace.referenceResolution, "not_proposed");
});

test("reference resolution: the deterministic path wins and the model is not consulted for it", async () => {
  const { context, recipeId } = await recommendationContext();
  // The model proposes a different session recipe, but "الوصفه" already resolves
  // deterministically, so the deterministic answer must stand.
  const resolving = await buildGraduationDemoAgent("test", null, layerResolving("EGY-RCP-001"));
  const response = await resolving.invoke({ message: "اعرضلي مكونات الوصفه", language: "ar-EG", context });
  assert.equal(resolvedRecipeId(response.data), recipeId);
  const trace = resolving.claudeLayer.store.latest()!;
  assert.equal(trace.referenceResolution, "resolved_deterministically");
});

test("reference resolution: can be disabled independently by configuration", async () => {
  const { context } = await recommendationContext();
  const config = {
    ...loadClaudeLayerConfig({}),
    classifierEnabled: true,
    classifierModel: "stub-classifier",
    formatterEnabled: false,
    formatterModel: null,
    referenceResolutionEnabled: false,
  };
  const resolving = await buildGraduationDemoAgent("test", null, new ClaudeLayer({
    config,
    classifierClient: new StubClaudeClient({ model: "stub-classifier", structured: classification({ referenced_recipe_id: "EGY-RCP-093" }) }),
    formatterClient: null,
  }));
  const response = await resolving.invoke({ message: "طيب وريني مكوناتها ايه", language: "ar-EG", context });
  assert.notEqual(response.status, "ok", "without reference resolution the request stays unresolved");
});

// ---------------------------------------------------------------------------
// Fix 5 — a single-meal request must not be absorbed into an earlier day plan.
//
// Pre-existing bug, exposed once the meal-plan turn started succeeding: any
// exclusion phrase made a fresh single-meal request rebuild the whole plan, so
// "وجبة فطار 500 سعر" returned three meals totalling 500 kcal.
// ---------------------------------------------------------------------------

test("meal plan: a single-meal request after a day plan is not treated as a plan follow-up", async () => {
  const plan = await agent.invoke({ message: "حضرلي وجبات اليوم 2000 سعر حراري", language: "ar-EG" });
  assert.equal((plan.data as Record<string, unknown>).intent, "meal_plan");
  const context = (plan.data as Record<string, unknown>).conversationContext as GraduationConversationContext;

  const single = await agent.invoke({
    message: "عاوز منك وجبه فطار تتكون من 500 سعر حراري وميكنش فيها منتجات ألبان عشان عندي حساسيه من الالبان",
    language: "ar-EG",
    context,
  });
  const data = single.data as Record<string, unknown>;
  assert.equal(single.status, "ok");
  assert.equal(data.intent, "find_recipe", "one meal was requested, so no day plan may be rebuilt");
  assert.equal(data.mealCount, undefined);
  assert.ok(resolvedRecipeId(single.data) !== null);
});

test("meal plan: legitimate plan follow-ups still modify the plan", async () => {
  const plan = await agent.invoke({ message: "حضرلي وجبات اليوم 2000 سعر حراري", language: "ar-EG" });
  const context = (plan.data as Record<string, unknown>).conversationContext as GraduationConversationContext;
  const cases: Array<{ message: string; mealCount?: number; target?: number }> = [
    { message: "خليهم 5 وجبات", mealCount: 5, target: 2_000 },
    { message: "زود وجبة", mealCount: 4, target: 2_000 },
    { message: "قلل 200 سعر", mealCount: 3, target: 1_800 },
    { message: "من غير ألبان", mealCount: 3, target: 2_000 },
  ];
  for (const entry of cases) {
    const response = await agent.invoke({ message: entry.message, language: "ar-EG", context });
    const data = response.data as Record<string, unknown>;
    assert.equal(data.intent, "meal_plan", entry.message);
    assert.equal(data.mealCount, entry.mealCount, entry.message);
    assert.equal(data.targetCaloriesKcal, entry.target, entry.message);
  }
});

test("meal plan: a single-meal request with an exclusion and no context is unchanged", async () => {
  const response = await agent.invoke({
    message: "عاوز وجبة افطار تكون من 500 سعر حراري بس ميكنش فيها منتجات البان",
    language: "ar-EG",
  });
  assert.equal(response.status, "ok");
  assert.equal((response.data as Record<string, unknown>).intent, "find_recipe");
});


test("grounding: ingredient display names present in the deterministic text are traceable", () => {
  // The structured payload stores ingredient KEYS, while the template renders
  // Arabic display names. Without the reference text these were wrongly flagged.
  const result = validateGrounding({
    text: "الكشري فيه أرز أبيض وعدس بني ومكرونة، وسعراته 543.7 سعر حراري للحصة.",
    facts: { recipeName: "كشري", caloriesPerServingKcal: 543.7, ingredients: [{ ingredient: "rice_white_raw" }, { ingredient: "lentils_brown_dry" }, { ingredient: "macaroni_dry" }] },
    referenceText: "كشري\n\nالمكونات: أرز أبيض، عدس بني، مكرونة.\nالسعرات: 543.7 سعر حراري للحصة.",
    allowedEntityNames: ["كشري"],
    knownEntityVocabulary: ["كشري", "أرز أبيض", "عدس بني", "مكرونة", "ملوخية"],
  });
  assert.equal(result.passed, true, JSON.stringify(result.violations));
});

test("grounding: the reference text does not excuse a fabricated entity or number", () => {
  const fabricatedEntity = validateGrounding({
    text: "الكشري فيه أرز أبيض، وكذلك الملوخية.",
    facts: { recipeName: "كشري" },
    referenceText: "كشري\n\nالمكونات: أرز أبيض.",
    allowedEntityNames: ["كشري"],
    knownEntityVocabulary: ["كشري", "أرز أبيض", "ملوخية"],
  });
  assert.equal(fabricatedEntity.passed, false);
  assert.equal(fabricatedEntity.violations[0]!.code, "untraceable_entity");

  const fabricatedNumber = validateGrounding({
    text: "سعراته 12345 سعر حراري.",
    facts: { caloriesPerServingKcal: 543.7 },
    referenceText: "السعرات: 543.7 سعر حراري للحصة.",
    allowedEntityNames: [],
    knownEntityVocabulary: [],
  });
  assert.equal(fabricatedNumber.passed, false);
  assert.equal(fabricatedNumber.violations[0]!.code, "untraceable_number");
});

test("grounding: a formatter rephrasing of a full recipe passes end to end", async () => {
  const plain = await buildGraduationDemoAgent("test", null);
  const template = await plain.invoke({ message: "طريقة عمل الكشري المصري", language: "ar-EG" });
  // Echo the deterministic text back: a faithful rephrasing must never be rejected.
  const echo = await buildGraduationDemoAgent("test", null, new ClaudeLayer({
    config: {
      ...loadClaudeLayerConfig({}),
      classifierEnabled: false,
      classifierModel: null,
      formatterEnabled: true,
      formatterModel: "stub-formatter",
    },
    classifierClient: null,
    formatterClient: new ScriptedFormatterClient(() => template.message, "stub-formatter"),
  }));
  const response = await echo.invoke({ message: "طريقة عمل الكشري المصري", language: "ar-EG" });
  const trace = echo.claudeLayer.store.latest()!;
  assert.equal(trace.formatterRoute, "formatter_used_validation_passed");
  assert.equal(trace.groundingPassed, true);
  assert.equal(response.message, template.message);
});
