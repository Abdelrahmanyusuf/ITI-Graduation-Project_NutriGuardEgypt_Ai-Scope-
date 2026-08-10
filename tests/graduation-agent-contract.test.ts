import assert from "node:assert/strict";
import test from "node:test";
import { buildGraduationRetrievalCorpus, loadUnifiedEgyptianDemoDataset } from "../src/demo/unified-egyptian-dataset.js";
import { ingestRetrievalCorpus } from "../src/retrieval/ingestion.js";
import { InMemoryVectorStore } from "../src/retrieval/vector-store.js";
import { buildGraduationDemoAgent, GraduationDemoEmbeddingProvider, type GraduationConversationContext } from "../src/runtime/graduation-demo-agent.js";

const agent = await buildGraduationDemoAgent("test", null);

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

test("contract 1 find_recipe: known Egyptian dish resolves once, unknown dishes fail closed, production ingestion rejects candidates", async () => {
  const known = await agent.invoke({ message: "عايز وصفة فول", language: "ar-EG" });
  assert.equal(known.status, "ok");
  assert.equal(record(known.data).reviewStatus, "needs_review", "graduation data must not masquerade as production-approved");
  assert.equal(record(record(known.data).recipe).recipeId, "EGY-RCP-002");
  assert.match(known.message, /فول مدمس/);
  assert.doesNotMatch(known.message, /كشري|ملوخية/);
  assert.equal(known.provenance.length > 0, true);

  const unknown = await agent.invoke({ message: "عايز وصفة سوشي", language: "ar-EG" });
  assert.equal(unknown.status, "no_result");
  assert.equal(record(unknown.data).intent, "find_recipe");
  assert.doesNotMatch(unknown.message, /فول|كشري|طعمية/);

  const corpus = buildGraduationRetrievalCorpus(await loadUnifiedEgyptianDemoDataset());
  const recipe = corpus.documents.find((document) => document.kind === "recipe")!;
  await assert.rejects(
    ingestRetrievalCorpus({ ...corpus, documents: [{ ...recipe, egyptianVerificationStatus: "candidate" }] }, new GraduationDemoEmbeddingProvider(), new InMemoryVectorStore()),
    /not human-verified Egyptian/,
  );
});

test("contract 2 recipe_nutrition: all numerical bases and nullable nutrients remain structured", async () => {
  const response = await agent.invoke({ message: "القيمة الغذائية الكاملة للكشري", language: "ar-EG" });
  assert.equal(response.status, "ok");
  assert.equal(record(response.data).intent, "recipe_nutrition");
  for (const basis of ["fullRecipe", "perServing", "per100g"] as const) {
    const values = record(record(response.data)[basis]);
    for (const nutrient of ["kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodium"]) {
      assert.equal(typeof values[nutrient], "number", `${basis}.${nutrient} must be numerical for Koshary`);
      assert.equal((values[nutrient] as number) >= 0, true);
    }
  }
  assert.equal(record(response.data).saturatedFat, null, "missing saturated fat must remain null, never zero");
  assert.equal(response.provenance.length, 1);
  assert.match(response.message, /الوصفة كاملة/);
  assert.match(response.message, /للحصة الواحدة/);
  assert.match(response.message, /لكل 100 جرام/);
});

test("contract 3 ingredient_nutrition: weighted known ingredients calculate and unknown ingredients do not fabricate", async () => {
  const known = await agent.invoke({ message: "كام سعرة في 100 جرام أرز؟", language: "ar-EG" });
  assert.equal(known.status, "ok");
  assert.equal(record(known.data).intent, "ingredient_nutrition");
  assert.equal(record(known.data).calculationType, "ingredient_weights");
  assert.equal(typeof record(known.data).totalCaloriesKcal, "number");
  assert.equal(record(known.data).partial, false);
  assert.equal(known.provenance.length > 0, true);

  const unknown = await agent.invoke({ message: "كام سعرة في 100 جرام حجر؟", language: "ar-EG" });
  assert.equal(unknown.status, "clarification");
  assert.equal(record(unknown.data).intent, "ingredient_nutrition");
  assert.equal(record(unknown.data).totalCaloriesKcal, undefined);
});

test("contract 4 compare_recipes: explicit nutrient uses one numerical basis and never substitutes opinion", async () => {
  const response = await agent.invoke({ message: "الفول ولا الكشري أقل صوديوم؟", language: "ar-EG" });
  assert.equal(response.status, "ok");
  const data = record(response.data);
  assert.equal(data.intent, "compare_recipes");
  assert.equal(data.basis, "per_100g");
  assert.equal(data.nutrient, "sodium");
  assert.equal(typeof record(data.first).value, "number");
  assert.equal(typeof record(data.second).value, "number");
  assert.equal(data.unit, "مجم");
  assert.match(response.message, /99\.6 مجم/);
  assert.match(response.message, /11\.4 مجم/);
  assert.equal(response.provenance.length, 2);
});

test("contract 5 general_guideline: WHO guidance carries an exact public source and stays non-personalized", async () => {
  const pyramid = await agent.invoke({ message: "ما هو الهرم الغذائي؟", language: "ar-EG" });
  assert.equal(pyramid.status, "ok");
  assert.equal(record(pyramid.data).intent, "general_guideline");
  assert.match(pyramid.message, /الكفاية/);
  assert.match(pyramid.message, /التوازن/);
  assert.match(pyramid.message, /إرشاد عام/);
  assert.equal(pyramid.provenance[0]?.url, "https://www.who.int/news-room/fact-sheets/detail/healthy-diet");

  const sodium = await agent.invoke({ message: "ما توصيات منظمة الصحة العالمية عن الصوديوم؟", language: "ar-EG" });
  assert.equal(sodium.status, "ok");
  assert.equal(record(sodium.data).intent, "general_guideline");
  assert.equal(sodium.provenance.some((item) => item.url?.includes("who.int") === true), true);
  assert.doesNotMatch(sodium.message, /أنت لازم|حسب وزنك|لحالتك/);
});

test("contract 6 lighter_modification: deterministic evidence-based reduction preserves context and stops at its limit", async () => {
  const first = await agent.invoke({ message: "عايز نسخة أخف من الكشري", language: "ar-EG" });
  assert.equal(first.status, "ok");
  assert.equal(record(first.data).intent, "lighter_modification");
  assert.deepEqual(record(record(first.data).modification), { ingredient: "vegetable_oil", originalGrams: 60, proposedGrams: 30 });
  assert.equal(typeof record(record(first.data).caloriesSaved).perServing, "number");
  assert.equal(first.toolTrace.some((item) => item.tool === "calculate_nutrition" && item.ok), true);

  let context = record(first.data).conversationContext as GraduationConversationContext;
  for (const message of ["عاوز أقلل تاني", "أقل كمان", "مش ممكن أقلل أكتر؟"]) {
    const next = await agent.invoke({ message, language: "ar-EG", context });
    assert.notEqual(next.status, "clarification");
    context = record(next.data).conversationContext as GraduationConversationContext;
  }
  const limit = await agent.invoke({ message: "أقل كمان", language: "ar-EG", context });
  assert.equal(limit.status, "no_result");
  assert.equal(record(limit.data).limitReached, true);
});

test("contract 7 unsupported: out-of-scope and ungrounded substitutions return a bounded refusal", async () => {
  for (const message of ["ما حالة الطقس؟", "اكتب لي برنامج بايثون", "استبدل مكون في الكشري بأي حاجة من عندك"]) {
    const response = await agent.invoke({ message, language: "ar-EG" });
    assert.equal(response.status, "unsupported", message);
    assert.equal(response.primaryIntent, "unsupported_request", message);
    assert.equal(response.evidenceDocumentIds.length, 0, message);
  }
});

test("contract 8 medical_safety: emergencies outrank food intents and diagnosis/medication stay refused", async () => {
  const emergency = await agent.invoke({ message: "واحد مش بيتنفس بعد ما أكل كشري، أعمل إيه؟", language: "ar-EG" });
  assert.equal(emergency.status, "emergency");
  assert.equal(emergency.primaryIntent, "medical_safety_request");
  assert.equal(emergency.safetyFlags.includes("emergency"), true);
  assert.equal(emergency.evidenceDocumentIds.length, 0);

  for (const message of ["شخّص لي ألم المعدة", "اخد دواء إيه بعد الأكل؟"]) {
    const response = await agent.invoke({ message, language: "ar-EG" });
    assert.equal(response.status, "refused", message);
    assert.equal(response.primaryIntent, "medical_safety_request", message);
    assert.equal(response.evidenceDocumentIds.length, 0, message);
  }
});
