import assert from "node:assert/strict";
import test from "node:test";
import { loadUnifiedEgyptianDemoDataset } from "../src/demo/unified-egyptian-dataset.js";
import { buildGraduationDemoAgent, type GraduationConversationContext } from "../src/runtime/graduation-demo-agent.js";

const agent = await buildGraduationDemoAgent("test", null);
const dataset = await loadUnifiedEgyptianDemoDataset();

function object(data: Record<string, unknown> | null): Record<string, unknown> {
  return data ?? {};
}

async function koshariContext(): Promise<GraduationConversationContext> {
  const first = await agent.invoke({ message: "سعرات الكشري", language: "ar-EG" });
  return object(first.data).conversationContext as GraduationConversationContext;
}

// ---------------------------------------------------------------------------
// BUG-12 — a nutrient-specific question must never be answered with a
// different nutrient's value.
// ---------------------------------------------------------------------------

test("BUG-12 premise: koshari has a recorded total fat but no saturated fat", async () => {
  const response = await agent.invoke({ message: "الدهون الكلية في الكشري", language: "ar-EG" });
  assert.match(response.message, /16\.8/u, "total fat per serving is recorded");
  assert.equal(object(response.data).saturatedFat, null, "saturated fat is null, not zero");
});

test("BUG-12: saturated-fat questions never return the total-fat value", async () => {
  const context = await koshariContext();
  // Phrasings that target the recipe in context must state unavailability.
  const recipeTargeted = [
    "إيه هي الدهون المشبعة؟",
    "إيه هي الدهون المشبعه؟",
    "الدهون المشبعه في الكشري",
    "ايه هي الدهون المشبّعة؟",
    "الدهون المشبعة كام",
    "كام الدهون المشبعة في الكشري",
    "saturated fat in koshary",
  ];
  for (const message of recipeTargeted) {
    const response = await agent.invoke({
      message,
      language: /[A-Za-z]/u.test(message) ? "en" : "ar-EG",
      context,
    });
    assert.doesNotMatch(response.message, /16\.8|67\.2/u, `${message}: total fat must not be substituted`);
    assert.match(
      response.message,
      /(?:الدهون المشبعة غير متوفرة|saturated fat is not available)/u,
      `${message}: unavailability must be stated explicitly`,
    );
  }

  // A bare nutrient phrase names no dish, so it is answered as general guidance
  // about saturated fat. The invariant that still matters is that the recipe's
  // TOTAL fat is never presented as the answer.
  const bare = await agent.invoke({ message: "دهون مشبعه", language: "ar-EG", context });
  assert.doesNotMatch(bare.message, /16\.8|67\.2/u, "bare phrasing must not substitute total fat");
  assert.equal(object(bare.data).intent, "general_guideline");
  assert.match(bare.message, /المشبعة/u, "the answer is about saturated fat, not another nutrient");
});

test("BUG-12: other nutrient-specific lookups still return their own field", async () => {
  const context = await koshariContext();
  const cases: Array<{ message: string; expected: RegExp }> = [
    { message: "الصوديوم في الكشري", expected: /246\.9/u },
    { message: "البروتين في الكشري", expected: /16/u },
    { message: "الالياف في الكشري", expected: /11\.8/u },
    { message: "الدهون الكلية في الكشري", expected: /16\.8/u },
  ];
  for (const entry of cases) {
    const response = await agent.invoke({ message: entry.message, language: "ar-EG", context });
    assert.match(response.message, entry.expected, entry.message);
  }
});

test("BUG-12: spelling variants of other nutrients also resolve to the right field", async () => {
  const context = await koshariContext();
  // "الألياف" written without hamza, and sodium via the colloquial "ملح".
  const fiber = await agent.invoke({ message: "الياف الكشري كام", language: "ar-EG", context });
  assert.match(fiber.message, /11\.8/u);
  const sodium = await agent.invoke({ message: "الملح في الكشري", language: "ar-EG", context });
  assert.match(sodium.message, /246\.9/u);
});

// ---------------------------------------------------------------------------
// BUG-13 — definitional questions are general guidance, not recipe lookups.
// ---------------------------------------------------------------------------

test("BUG-13: definitional questions route to general_guideline, never a recipe lookup", async () => {
  const context = await koshariContext();
  const definitional = [
    "ما المقصود بالدهون المشبعة؟",
    "إيه معنى الدهون المشبعة",
    "ما تعريف الألياف",
    "عايز أفهم إيه هو الصوديوم",
    "ما تعريف البروتين",
    "what does saturated fat mean",
    "definition of saturated fat",
  ];
  for (const message of definitional) {
    const response = await agent.invoke({
      message,
      language: /[A-Za-z]/u.test(message) ? "en" : "ar-EG",
      context,
    });
    assert.equal(object(response.data).intent, "general_guideline", message);
    assert.notEqual(object(response.data).intent, "recipe_nutrition", message);
    // The recipe in context must not leak a value into a definitional answer.
    assert.doesNotMatch(response.message, /543\.7|246\.9|16\.8/u, `${message}: no recipe-specific number`);
  }
});

test("BUG-13: a concept with an approved source is explained; one without fails closed", async () => {
  // WHO-FAT-2024 covers saturated fat, so it can be explained from a source.
  const covered = await agent.invoke({ message: "ما المقصود بالدهون المشبعة؟", language: "ar-EG" });
  assert.equal(covered.status, "ok");
  assert.equal(object(covered.data).intent, "general_guideline");
  assert.match(covered.message, /10\s*%/u, "WHO's saturated-fat ceiling is stated");
  assert.ok(covered.evidenceDocumentIds.length > 0, "the answer carries evidence");

  // There is no approved fibre guideline, so the honest result is to fail closed
  // rather than invent a definition.
  const uncovered = await agent.invoke({ message: "ما تعريف الألياف", language: "ar-EG" });
  assert.equal(object(uncovered.data).intent, "general_guideline");
  assert.notEqual(uncovered.status, "ok");
  assert.equal(uncovered.evidenceDocumentIds.length, 0, "nothing is cited when nothing is approved");
});

test("BUG-13: measurement questions are NOT captured by the definitional route", async () => {
  const context = await koshariContext();
  const measurement = [
    "كام الدهون المشبعة في الكشري",
    "إيه قيمة الصوديوم في الكشري",
    "سعرات الكشري",
    "الصوديوم في الكشري",
  ];
  for (const message of measurement) {
    const response = await agent.invoke({ message, language: "ar-EG", context });
    assert.equal(object(response.data).intent, "recipe_nutrition", message);
  }
});

test("BUG-13: health-suitability follow-ups keep their existing numeric-context behaviour", async () => {
  const context = await koshariContext();
  for (const message of ["هل هي صحية؟", "يعني هي مش صحية؟"]) {
    const response = await agent.invoke({ message, language: "ar-EG", context });
    assert.equal(response.status, "ok", message);
    assert.equal(object(response.data).assessmentType, "recipe_numeric_context", message);
  }
});

// ---------------------------------------------------------------------------
// BUG-14 — per-serving vs whole-recipe reductions must be labelled explicitly.
// ---------------------------------------------------------------------------

test("BUG-14: each reduction figure is labelled with its own basis", async () => {
  const response = await agent.invoke({ message: "عاوز اقلل السعرات الحراريه لوجبه الكشري", language: "ar-EG" });
  assert.equal(response.status, "ok");
  assert.match(response.message, /للحصة الواحدة: -66\.3 سعر حراري/u, "per-serving reduction is labelled");
  assert.match(response.message, /لإجمالي الوصفة \(4 حصص\): -265\.2 سعر حراري/u, "whole-recipe reduction names its basis and serving count");
  assert.match(response.message, /مضروبًا في 4 حصص/u, "the relationship between the two figures is stated");
  const saved = object(object(response.data).caloriesSaved as Record<string, unknown> | null);
  assert.equal(saved.perServing, 66.3);
  assert.equal(saved.fullRecipe, 265.2);
  assert.equal(saved.fullRecipe as number, (saved.perServing as number) * 4);
  assert.match(String(saved.basisNote), /not an additional saving/u, "structured data is self-describing for the formatter");
});

test("BUG-14: a follow-up reduction distinguishes this step from the cumulative total", async () => {
  const first = await agent.invoke({ message: "عاوز اقلل السعرات الحراريه لوجبه الكشري", language: "ar-EG" });
  const second = await agent.invoke({
    message: "قلل تاني",
    language: "ar-EG",
    context: object(first.data).conversationContext as GraduationConversationContext,
  });
  assert.match(second.message, /التخفيض من الخطوة دي — للحصة الواحدة: -33\.2/u);
  assert.match(second.message, /إجمالي التخفيض عن الوصفة المسجلة — للحصة الواحدة: -99\.5/u);
  assert.match(second.message, /لإجمالي الوصفة \(4 حصص\): -397\.8/u);
  const saved = object(object(second.data).caloriesSaved as Record<string, unknown> | null);
  assert.equal(saved.additionalPerServing, 33.2);
  assert.equal(saved.perServing, 99.5);
  assert.equal(saved.fullRecipe, 397.8);
});

// ---------------------------------------------------------------------------
// BUG-15 — no unapproved external source may be cited to users.
// ---------------------------------------------------------------------------

test("BUG-15 premise: the demo dataset records unapproved Wikipedia culinary sources", () => {
  const wikipedia = dataset.recipes.filter((recipe) => /wikipedia\.org/iu.test(recipe.source_url));
  assert.ok(wikipedia.length > 200, "the premise holds: most recipes point at Wikipedia");
  assert.equal(dataset.metadata.review_status, "needs_review", "the dataset is not approved");
});

test("BUG-15: no user-facing response cites a Wikipedia URL", async () => {
  const messages = [
    "سعرات الكشري",
    "عايز وصفة الكشري",
    "رشحلي فطار مصري",
    "عاوز اقلل السعرات الحراريه لوجبه الكشري",
    "الفول ولا الكشري أقل صوديوم؟",
    "عاوز 3 وجبات اليوم 2000 سعر",
    "عايز وصفة الكشري من غير حمص",
    "هل الكشري صحي؟",
  ];
  let checked = 0;
  for (const message of messages) {
    const response = await agent.invoke({ message, language: "ar-EG" });
    for (const entry of response.provenance) {
      checked += 1;
      assert.doesNotMatch(entry.url ?? "", /wikipedia/iu, `${message}: unapproved source cited`);
    }
  }
  assert.ok(checked > 0, "provenance entries were actually inspected");
});

test("BUG-15: recipe provenance withholds the link but keeps honest attribution", async () => {
  const response = await agent.invoke({ message: "سعرات الكشري", language: "ar-EG" });
  const entry = response.provenance[0]!;
  assert.equal(entry.url, null, "no clickable link for an unapproved source");
  assert.equal(entry.sourceId, "DEMO-UNIFIED-EGYPTIAN-DATASET");
  assert.equal(entry.locator, "EGY-RCP-001");
  assert.match(entry.title ?? "", /غير معتمد/u, "the title discloses the unapproved status");
  assert.match(entry.title ?? "", /محسوبة من مرجع المكونات/u, "nutrition attribution is not misassigned");
});

test("BUG-15: approved WHO guideline links are still cited normally", async () => {
  const response = await agent.invoke({ message: "ما توصيات منظمة الصحة العالمية عن الصوديوم؟", language: "ar-EG" });
  assert.equal(response.status, "ok");
  assert.ok(
    response.provenance.some((entry) => (entry.url ?? "").includes("who.int")),
    "suppression is scoped to unapproved sources only",
  );
});
