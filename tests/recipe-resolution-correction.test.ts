import assert from "node:assert/strict";
import test from "node:test";
import { loadClaudeLayerConfig } from "../src/llm/claude-config.js";
import { ClaudeLayer } from "../src/llm/claude-layer.js";
import { loadUnifiedEgyptianDemoDataset } from "../src/demo/unified-egyptian-dataset.js";
import { buildGraduationDemoAgent, type GraduationConversationContext } from "../src/runtime/graduation-demo-agent.js";
import { StubClaudeClient, classification } from "./helpers/claude-stubs.js";

const agent = await buildGraduationDemoAgent("test", null);
const dataset = await loadUnifiedEgyptianDemoDataset();

/** EGY-RCP-174's canonical name literally contains "الكشري" in a parenthetical. */
const DECOY_ID = "EGY-RCP-174";
const KOSHARI_ID = "EGY-RCP-001";

function resolvedRecipeId(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const nested = (data.recipe as { recipeId?: string } | undefined)?.recipeId;
  return (data.recipeId as string | undefined) ?? nested ?? null;
}

function object(data: Record<string, unknown> | null): Record<string, unknown> {
  return data ?? {};
}

test("BUG-10 dataset premise: a decoy recipe's canonical name contains the target dish name", () => {
  const decoy = dataset.recipes.find((recipe) => recipe.recipe_id === DECOY_ID);
  const koshari = dataset.recipes.find((recipe) => recipe.recipe_id === KOSHARI_ID);
  assert.ok(decoy, "the decoy recipe exists");
  assert.ok(koshari, "the koshari recipe exists");
  assert.match(decoy.name_ar, /الكشري/u, "the decoy name contains the target dish name");
  assert.equal(koshari.name_ar, "كشري", "koshari's canonical name is exactly the dish name");
});

test("BUG-10: nutrition and recipe phrasings resolve to the same recipe_id", async () => {
  const nutrition = await agent.invoke({ message: "كام سعرات وجبة الكشري", language: "ar-EG" });
  const recipe = await agent.invoke({ message: "عايز وصفة الكشري", language: "ar-EG" });
  assert.equal(resolvedRecipeId(nutrition.data), KOSHARI_ID);
  assert.equal(resolvedRecipeId(recipe.data), KOSHARI_ID);
  assert.equal(resolvedRecipeId(nutrition.data), resolvedRecipeId(recipe.data));
});

test("BUG-10: the originally reported phrasing resolves to koshari, not the decoy", async () => {
  const response = await agent.invoke({ message: "كام السعرات الحرارية لوجبة الكشري؟", language: "ar-EG" });
  assert.equal(response.status, "ok");
  assert.equal(object(response.data).intent, "recipe_nutrition");
  assert.equal(resolvedRecipeId(response.data), KOSHARI_ID);
  assert.doesNotMatch(response.message, /طاجن مكرونة/u, "the decoy recipe must not be reported");
});

test("BUG-10: every recorded recipe resolves to itself through BOTH paths", async () => {
  const disagreements: string[] = [];
  const wrong: string[] = [];
  for (const recipe of dataset.recipes) {
    const nutrition = await agent.invoke({ message: `كام سعرات ${recipe.name_ar}`, language: "ar-EG" });
    const details = await agent.invoke({ message: `عايز وصفة ${recipe.name_ar}`, language: "ar-EG" });
    const nutritionId = resolvedRecipeId(nutrition.data);
    const detailsId = resolvedRecipeId(details.data);
    if (nutritionId && detailsId && nutritionId !== detailsId) disagreements.push(recipe.recipe_id);
    if (nutritionId && nutritionId !== recipe.recipe_id) wrong.push(`${recipe.recipe_id}->${nutritionId}`);
  }
  assert.deepEqual(disagreements, [], "recipe_nutrition and find_recipe must never disagree");
  assert.deepEqual(wrong, [], "an exact canonical name must resolve to its own recipe");
});

test("BUG-10 root cause: a model-resolved reference must never outrank an explicitly named dish", async () => {
  // The model proposes the decoy, which is a legitimate member of the closed
  // candidate set, while the user explicitly names الكشري.
  const config = {
    ...loadClaudeLayerConfig({}),
    classifierEnabled: true,
    classifierModel: "stub-classifier",
    formatterEnabled: false,
    formatterModel: null,
    referenceResolutionEnabled: true,
  };
  const overriding = await buildGraduationDemoAgent("test", null, new ClaudeLayer({
    config,
    classifierClient: new StubClaudeClient({ model: "stub-classifier", structured: classification({ intent: "recipe_nutrition", referenced_recipe_id: DECOY_ID }) }),
    formatterClient: null,
  }));
  const context: GraduationConversationContext = {
    schemaVersion: "1.0",
    lastIntent: "recipe_reference",
    recipeId: DECOY_ID,
    memory: { schemaVersion: "1.0", turnCount: 2, activeRecipeId: DECOY_ID, recentRecipeIds: [DECOY_ID], mealPlan: null, singleMealTarget: null, lighterModification: null },
  };
  const response = await overriding.invoke({ message: "كام السعرات الحرارية لوجبة الكشري؟", language: "ar-EG", context });
  assert.equal(resolvedRecipeId(response.data), KOSHARI_ID, "the explicitly named dish wins");
  assert.equal(overriding.claudeLayer.store.latest()?.referenceResolution, "skipped_explicit_recipe_named");
});

test("BUG-10: reference resolution still fills a genuine gap when no dish is named", async () => {
  const config = {
    ...loadClaudeLayerConfig({}),
    classifierEnabled: true,
    classifierModel: "stub-classifier",
    formatterEnabled: false,
    formatterModel: null,
    referenceResolutionEnabled: true,
  };
  const resolving = await buildGraduationDemoAgent("test", null, new ClaudeLayer({
    config,
    classifierClient: new StubClaudeClient({ model: "stub-classifier", structured: classification({ intent: "find_recipe", referenced_recipe_id: DECOY_ID }) }),
    formatterClient: null,
  }));
  const context: GraduationConversationContext = {
    schemaVersion: "1.0",
    lastIntent: "recipe_reference",
    recipeId: DECOY_ID,
    memory: { schemaVersion: "1.0", turnCount: 2, activeRecipeId: DECOY_ID, recentRecipeIds: [DECOY_ID], mealPlan: null, singleMealTarget: null, lighterModification: null },
  };
  const response = await resolving.invoke({ message: "طيب وريني مكوناتها ايه", language: "ar-EG", context });
  assert.equal(resolvedRecipeId(response.data), DECOY_ID, "with no dish named the reference is still resolved");
  assert.equal(resolving.claudeLayer.store.latest()?.referenceResolution, "accepted");
});

// ---------------------------------------------------------------------------
// BUG-11 — explicit user correction must never be answered with the same result.
// ---------------------------------------------------------------------------

async function shownDecoy(): Promise<GraduationConversationContext> {
  const shown = await agent.invoke({ message: "سعرات طاجن مكرونة باللحمة المفرومة (مكرونة محلات الكشري)", language: "ar-EG" });
  assert.equal(resolvedRecipeId(shown.data), DECOY_ID);
  return object(shown.data).conversationContext as GraduationConversationContext;
}

test("BUG-11: a correction naming the intended dish re-resolves instead of repeating", async () => {
  const context = await shownDecoy();
  const response = await agent.invoke({ message: "دي مش وصفة كشري، دي مكرونة باللحمة المفرومة", language: "ar-EG", context });
  const data = object(response.data);
  assert.equal(response.status, "ok");
  assert.equal(data.correctionApplied, true);
  assert.equal(data.reasonCode, "user_rejected_previous_result");
  assert.equal(data.rejectedRecipeId, DECOY_ID);
  assert.equal(resolvedRecipeId(response.data), KOSHARI_ID, "resolution is re-attempted with the correction");
  assert.match(response.message, /معاك حق/u, "the mismatch is acknowledged");
});

test("BUG-11: a bare rejection asks for a precise name and never re-serves the rejected dish", async () => {
  const context = await shownDecoy();
  for (const message of ["غلط", "مش كده", "مش دا اللي طلبته", "that is wrong", "this is not what I asked"]) {
    const response = await agent.invoke({ message, language: /[A-Za-z]/u.test(message) ? "en" : "ar-EG", context });
    const data = object(response.data);
    assert.equal(response.status, "clarification", message);
    assert.equal(data.correctionApplied, true, message);
    assert.equal(data.rejectedRecipeId, DECOY_ID, message);
    assert.equal(data.requiredInput, "exact_recipe_name", message);
    assert.equal(resolvedRecipeId(response.data), null, `${message}: no recipe may be re-served`);
    assert.doesNotMatch(response.message, /المكونات \(|Ingredients \(/u, `${message}: the rejected recipe must not be repeated in detail`);
  }
});

test("BUG-11: the rejected recipe is purged from memory and cannot come back", async () => {
  const context = await shownDecoy();
  const rejection = await agent.invoke({ message: "غلط", language: "ar-EG", context });
  const nextContext = object(rejection.data).conversationContext as GraduationConversationContext | undefined;
  // Either no context at all, or one that no longer points at the rejected dish.
  if (nextContext) {
    assert.notEqual((nextContext as { recipeId?: string }).recipeId, DECOY_ID);
    assert.notEqual(nextContext.memory?.activeRecipeId, DECOY_ID);
    assert.ok(!(nextContext.memory?.recentRecipeIds ?? []).includes(DECOY_ID));
  }
  const followup = await agent.invoke({ message: "اعرضلي مكونات الوصفه", language: "ar-EG", ...(nextContext ? { context: nextContext } : {}) });
  assert.notEqual(resolvedRecipeId(followup.data), DECOY_ID, "a pronoun must not resolve back to the rejected dish");
});

test("BUG-11: detection does not misfire on ordinary attribute questions", async () => {
  const context = await shownDecoy();
  // "مش صحية" is a health question, not a complaint about the answer.
  const health = await agent.invoke({ message: "يعني هي مش صحية؟", language: "ar-EG", context });
  assert.equal(object(health.data).correctionApplied, undefined);
  assert.equal(object(health.data).assessmentType, "recipe_numeric_context");

  const suitability = await agent.invoke({ message: "هل هي صحية؟", language: "ar-EG", context });
  assert.equal(object(suitability.data).correctionApplied, undefined);
  assert.equal(suitability.status, "ok");
});

test("BUG-11: a rejection with no prior result does not claim a correction", async () => {
  const response = await agent.invoke({ message: "غلط", language: "ar-EG" });
  assert.equal(object(response.data).correctionApplied, undefined);
});

test("BUG-11 is independent of BUG-10: detection works for a mismatch the BUG-10 fix cannot cause", async () => {
  // Reaching the decoy by its own exact name is correct resolution, so the
  // BUG-10 fix is not involved. The user may still reject it, and the safety
  // net must engage on its own.
  const context = await shownDecoy();
  const response = await agent.invoke({ message: "مش كده", language: "ar-EG", context });
  assert.equal(object(response.data).correctionApplied, true);
  assert.equal(object(response.data).rejectedRecipeId, DECOY_ID);
  assert.equal(resolvedRecipeId(response.data), null);
});
