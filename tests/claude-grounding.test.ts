import assert from "node:assert/strict";
import test from "node:test";
import { loadClaudeLayerConfig, formatterIntentDecision } from "../src/llm/claude-config.js";
import { ClaudeLayer, type GroundingFailureRecord } from "../src/llm/claude-layer.js";
import { buildFormatterFacts, collectAllowedEntityNames, longestListLength } from "../src/llm/claude-formatter.js";
import { extractNumbers, normalizeDigits, validateGrounding } from "../src/llm/grounding-validator.js";
import { buildGraduationDemoAgent } from "../src/runtime/graduation-demo-agent.js";
import { RecordingLogger, ScriptedFormatterClient, StubClaudeClient } from "./helpers/claude-stubs.js";

const VOCABULARY = ["كشري", "فول مدمس", "طعمية", "ملوخية", "Koshary", "Ful Medames", "أرز أبيض", "زيت نباتي"];

function formatterConfig() {
  return {
    ...loadClaudeLayerConfig({}),
    classifierEnabled: false,
    classifierModel: null,
    formatterEnabled: true,
    formatterModel: "stub-formatter-model",
  };
}

function layerWithFormatter(
  respond: (userContent: string) => string,
  logger?: RecordingLogger,
  failures?: GroundingFailureRecord[],
): ClaudeLayer {
  return new ClaudeLayer({
    config: formatterConfig(),
    classifierClient: null,
    formatterClient: new ScriptedFormatterClient(respond),
    ...(logger ? { logger } : {}),
    ...(failures ? { onGroundingFailure: (record) => failures.push(record) } : {}),
  });
}

test("B2a: numeric extraction normalizes Arabic-Indic digits and thousands separators", () => {
  assert.equal(normalizeDigits("١٢٣٫٥"), "123.5");
  assert.deepEqual(extractNumbers("الكشري ٩٩٫٦ مجم و2,000 سعر"), [99.6, 2000]);
  assert.deepEqual(extractNumbers("no digits here"), []);
});

test("B2b: a number absent from the structured input fails validation", () => {
  const result = validateGrounding({
    text: "الكشري فيه 512 سعر حراري و18 جم بروتين.",
    facts: { caloriesPerServingKcal: 512, perServing: { protein: 12.4 } },
    allowedEntityNames: ["الكشري"],
    knownEntityVocabulary: VOCABULARY,
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.violations.map((violation) => violation.code), ["untraceable_number"]);
  assert.equal(result.violations[0]!.token, "18");
});

test("B2b: display rounding to one decimal place is accepted, a material change is not", () => {
  const facts = { sodium: 99.63 };
  assert.equal(validateGrounding({ text: "الصوديوم 99.6 مجم.", facts, allowedEntityNames: [], knownEntityVocabulary: [] }).passed, true);
  assert.equal(validateGrounding({ text: "الصوديوم 100 مجم.", facts, allowedEntityNames: [], knownEntityVocabulary: [] }).passed, true, "integer display rounding of a permitted value is a restatement");
  const material = validateGrounding({ text: "الصوديوم 120 مجم.", facts, allowedEntityNames: [], knownEntityVocabulary: [] });
  assert.equal(material.passed, false);
  assert.equal(material.violations[0]!.code, "untraceable_number");
});

test("B2c: an entity absent from the structured input fails validation", () => {
  const result = validateGrounding({
    text: "الكشري فيه 512 سعر حراري، وكذلك الملوخية.",
    facts: { recipeName: "كشري", caloriesPerServingKcal: 512 },
    allowedEntityNames: ["كشري"],
    knownEntityVocabulary: VOCABULARY,
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.violations.map((violation) => violation.code), ["untraceable_entity"]);
  assert.equal(result.violations[0]!.token, "ملوخية");
});

test("B2: a fully traceable output passes", () => {
  const result = validateGrounding({
    text: "الكشري: حوالي 512 سعر حراري للحصة، و12.4 جم بروتين.",
    facts: { recipeName: "كشري", caloriesPerServingKcal: 512, perServing: { protein: 12.4 } },
    allowedEntityNames: ["كشري"],
    knownEntityVocabulary: VOCABULARY,
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.violations, []);
});

test("B2: empty formatter output fails rather than reaching the user", () => {
  const result = validateGrounding({ text: "   ", facts: {}, allowedEntityNames: [], knownEntityVocabulary: [] });
  assert.equal(result.passed, false);
  assert.equal(result.violations[0]!.code, "empty_output");
});

test("B1: the fact builder harvests only name-like keys and derives list ordinals", () => {
  const data = {
    recipeName: "كشري",
    meals: [{ name: "فول مدمس" }, { name: "طعمية" }],
    method: "تعليمات طويلة لا تُعد اسمًا",
  };
  assert.deepEqual(collectAllowedEntityNames(data).sort(), ["فول مدمس", "كشري", "طعمية"].sort());
  assert.equal(longestListLength(data), 2);
  const facts = buildFormatterFacts({ intent: "find_recipe", language: "ar-EG", deterministicText: "نص", data });
  assert.deepEqual(facts.listItemOrdinals, [1, 2]);
});

test("B3/B4: medical_safety is hard-disabled and cannot be enabled by configuration", () => {
  const forced = {
    ...formatterConfig(),
    formatterIntents: { ...formatterConfig().formatterIntents, medical_safety: true } as never,
  };
  assert.deepEqual(formatterIntentDecision(forced, "medical_safety"), { allowed: false, reason: "hard_disabled_medical_safety" });
  assert.deepEqual(formatterIntentDecision(forced, "recipe_nutrition"), { allowed: true, reason: "enabled_by_config" });
  assert.deepEqual(formatterIntentDecision(forced, "scoped_conversation"), { allowed: false, reason: "intent_out_of_formatter_scope" });
});

test("B4: an intent switched off by configuration is skipped", () => {
  const config = { ...formatterConfig() };
  config.formatterIntents = { ...config.formatterIntents, compare_recipes: false };
  assert.deepEqual(formatterIntentDecision(config, "compare_recipes"), { allowed: false, reason: "disabled_by_config" });
});

test("B2d integration: a fabricated number is rejected and the deterministic template is shown", async () => {
  const logger = new RecordingLogger();
  const failures: GroundingFailureRecord[] = [];
  // The formatter invents a calorie figure that the pipeline never produced.
  const agent = await buildGraduationDemoAgent("test", null, layerWithFormatter(
    () => "الكشري فيه 12345 سعر حراري للحصة، وهو رقم مخترع تمامًا.",
    logger,
    failures,
  ));
  const response = await agent.invoke({ message: "القيمة الغذائية الكاملة للكشري", language: "ar-EG" });

  const plain = await buildGraduationDemoAgent("test", null);
  const template = await plain.invoke({ message: "القيمة الغذائية الكاملة للكشري", language: "ar-EG" });

  assert.equal(response.status, "ok");
  assert.equal(response.message, template.message, "the user sees the unchanged deterministic template");
  assert.doesNotMatch(response.message, /12345/u);

  const trace = agent.claudeLayer.store.latest()!;
  assert.equal(trace.formatterRoute, "formatter_used_validation_failed_template_fallback");
  assert.equal(trace.groundingPassed, false);
  assert.deepEqual(trace.groundingFailureCodes, ["untraceable_number"]);

  assert.equal(failures.length, 1, "the failure sink received the full-fidelity record");
  assert.equal(failures[0]!.rejectedOutput, "الكشري فيه 12345 سعر حراري للحصة، وهو رقم مخترع تمامًا.");
  assert.ok(Object.keys(failures[0]!.structuredInput).length > 0, "the structured input is preserved alongside it");
  assert.equal(logger.find("nutriguard_claude_grounding_rejected").length, 1);
});

test("B2d integration: a fabricated entity name is rejected with the same fallback behaviour", async () => {
  const failures: GroundingFailureRecord[] = [];
  const agent = await buildGraduationDemoAgent("test", null, layerWithFormatter(
    (userContent) => {
      // Reuse a real number from the facts so only the entity is fabricated.
      const number = /"caloriesPerServingKcal": ([0-9.]+)/u.exec(userContent)?.[1] ?? "0";
      return `الملوخية فيها ${number} سعر حراري للحصة.`;
    },
    undefined,
    failures,
  ));
  const response = await agent.invoke({ message: "القيمة الغذائية الكاملة للكشري", language: "ar-EG" });

  const plain = await buildGraduationDemoAgent("test", null);
  const template = await plain.invoke({ message: "القيمة الغذائية الكاملة للكشري", language: "ar-EG" });

  assert.equal(response.message, template.message);
  assert.doesNotMatch(response.message, /الملوخية فيها/u);
  const trace = agent.claudeLayer.store.latest()!;
  assert.equal(trace.formatterRoute, "formatter_used_validation_failed_template_fallback");
  assert.ok(trace.groundingFailureCodes.includes("untraceable_entity"));
  assert.equal(failures.length, 1);
});

test("B1/B2 integration: a fully grounded rephrasing is shown to the user as-is", async () => {
  // Every number below is copied from the deterministic pipeline's own output,
  // asserted immediately underneath, so this test cannot pass on invented data.
  const grounded = "كشري: السعرات للحصة الواحدة (4 حصص مسجلة) هي 543.7 سعر حراري. وللمقارنة 219.2 سعر حراري لكل 100 جرام.";
  const agent = await buildGraduationDemoAgent("test", null, layerWithFormatter(() => grounded));
  const plain = await buildGraduationDemoAgent("test", null);
  const template = await plain.invoke({ message: "سعرات الكشري", language: "ar-EG" });
  assert.match(template.message, /543\.7/u);
  assert.match(template.message, /219\.2/u);
  assert.match(template.message, /4 حصص/u);

  const response = await agent.invoke({ message: "سعرات الكشري", language: "ar-EG" });
  assert.equal(response.status, "ok");
  assert.equal(response.message, grounded, "validated Claude prose replaces the template");
  const trace = agent.claudeLayer.store.latest()!;
  assert.equal(trace.formatterRoute, "formatter_used_validation_passed");
  assert.equal(trace.groundingPassed, true);
  // I1/I2: the structured data is untouched by the formatter.
  assert.deepEqual(response.data, template.data);
});

test("B2: a formatter call failure falls back to the template with no user-visible error", async () => {
  const agent = await buildGraduationDemoAgent("test", null, new ClaudeLayer({
    config: formatterConfig(),
    classifierClient: null,
    formatterClient: new StubClaudeClient({ model: "stub-formatter-model", textFailure: { reason: "timeout", detail: "aborted" } }),
  }));
  const response = await agent.invoke({ message: "سعرات الكشري", language: "ar-EG" });
  const plain = await buildGraduationDemoAgent("test", null);
  const template = await plain.invoke({ message: "سعرات الكشري", language: "ar-EG" });

  assert.equal(response.status, "ok");
  assert.deepEqual(response, template);
  const trace = agent.claudeLayer.store.latest()!;
  assert.equal(trace.formatterRoute, "formatter_call_failed_template_fallback");
  assert.equal(trace.formatterFailureReason, "timeout");
});

test("I4: medical_safety copy is never sent to the formatter", async () => {
  const client = new StubClaudeClient({ model: "stub-formatter-model", text: "أي صياغة بديلة" });
  const agent = await buildGraduationDemoAgent("test", null, new ClaudeLayer({
    config: formatterConfig(),
    classifierClient: null,
    formatterClient: client,
  }));
  const refusal = await agent.invoke({ message: "اكتبلي دواء للضغط", language: "ar-EG" });
  const emergency = await agent.invoke({ message: "شخص أغمي عليه ومش بيتنفس، أعمل إيه؟", language: "ar-EG" });
  assert.equal(refusal.status, "refused");
  assert.equal(emergency.status, "emergency");
  assert.equal(client.callCount, 0);
  for (const trace of agent.claudeLayer.store.list(5)) {
    assert.equal(trace.formatterRoute, "formatter_hard_disabled_medical_safety");
  }
});
