import assert from "node:assert/strict";
import test from "node:test";
import { loadClaudeLayerConfig } from "../src/llm/claude-config.js";
import { ClaudeLayer } from "../src/llm/claude-layer.js";
import { buildGraduationDemoAgent, type GraduationConversationContext } from "../src/runtime/graduation-demo-agent.js";
import { StubClaudeClient, classification } from "./helpers/claude-stubs.js";

const agent = await buildGraduationDemoAgent("test", null);

const FUL = "EGY-RCP-002";
const KOSHARI = "EGY-RCP-001";

function object(data: Record<string, unknown> | null): Record<string, unknown> {
  return data ?? {};
}

function resolvedRecipeId(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const nested = (data.recipe as { recipeId?: string } | undefined)?.recipeId;
  return (data.recipeId as string | undefined) ?? nested ?? null;
}

async function comparison(message = "اعمل مقارنة بين الفول والكشري"): Promise<GraduationConversationContext> {
  const response = await agent.invoke({ message, language: "ar-EG" });
  assert.equal(object(response.data).intent, "compare_recipes", message);
  return object(response.data).conversationContext as GraduationConversationContext;
}

test("BUG-16 root cause: a comparison now persists both recipes and its basis", async () => {
  const context = await comparison();
  assert.equal(context.lastIntent, "compare_recipes", "the comparison is no longer downgraded to a single-recipe reference");
  const comparisonContext = context as Extract<GraduationConversationContext, { lastIntent: "compare_recipes" }>;
  assert.equal(comparisonContext.firstRecipeId, FUL);
  assert.equal(comparisonContext.secondRecipeId, KOSHARI);
  assert.ok(["per_serving", "per_100g"].includes(comparisonContext.basis));
  // Both compared recipes survive in memory, not just the first.
  assert.deepEqual(context.memory?.comparison, { firstRecipeId: FUL, secondRecipeId: KOSHARI, basis: comparisonContext.basis, nutrient: null });
  assert.ok((context.memory?.recentRecipeIds ?? []).includes(KOSHARI), "the second recipe is remembered too");
});

test("BUG-16: \"مين الأفضل؟\" continues the comparison instead of returning one recipe", async () => {
  const context = await comparison();
  const response = await agent.invoke({ message: "مين الأفضل؟", language: "ar-EG", context });
  const data = object(response.data);
  assert.equal(data.intent, "compare_recipes");
  assert.equal(data.continuedComparison, true);
  assert.equal(data.comparisonType, "followup_criterion_required");
  assert.equal(response.status, "clarification");
  // It must restate the no-absolute-better guidance and offer the criteria.
  assert.match(response.message, /مفيش «أفضل» بشكل مطلق/u);
  assert.match(response.message, /الصوديوم/u, "the selectable criteria are listed");
  // It must NOT become a single-recipe result.
  assert.equal(resolvedRecipeId(response.data), null);
  assert.doesNotMatch(response.message, /المكونات \(/u, "no recipe ingredient list");
});

test("BUG-16: \"الأقل صوديوم؟\" resolves the comparison on that criterion with real numbers", async () => {
  const context = await comparison();
  const response = await agent.invoke({ message: "الأقل صوديوم؟", language: "ar-EG", context });
  const data = object(response.data);
  assert.equal(response.status, "ok");
  assert.equal(data.intent, "compare_recipes");
  assert.equal(data.continuedComparison, true);
  assert.equal(data.comparisonType, "followup_nutrient");
  assert.equal(data.nutrient, "sodium");
  const first = object(data.first as Record<string, unknown> | null);
  const second = object(data.second as Record<string, unknown> | null);
  assert.equal(first.recipeId, FUL);
  assert.equal(second.recipeId, KOSHARI);
  assert.equal(typeof first.value, "number");
  assert.equal(typeof second.value, "number");
  // Both dishes appear, and a verdict is given on the named criterion only.
  assert.match(response.message, /فول مدمس/u);
  assert.match(response.message, /كشري/u);
  assert.match(response.message, /الأقل في الصوديوم/u);
});

test("BUG-16: \"ليه؟\" stays inside the comparison", async () => {
  const context = await comparison();
  const response = await agent.invoke({ message: "ليه؟", language: "ar-EG", context });
  const data = object(response.data);
  assert.equal(data.intent, "compare_recipes");
  assert.equal(data.continuedComparison, true);
  assert.notEqual(response.status, "unsupported");
  assert.match(response.message, /لأن/u, "it answers the why");
  assert.equal(resolvedRecipeId(response.data), null);
});

test("BUG-16: higher/richer criterion follow-ups pick the correct direction", async () => {
  const context = await comparison();
  const higher = await agent.invoke({ message: "مين اكتر بروتين؟", language: "ar-EG", context });
  assert.equal(object(higher.data).comparisonType, "followup_nutrient");
  assert.equal(object(higher.data).nutrient, "protein");
  assert.match(higher.message, /الأعلى في البروتين/u);

  const lower = await agent.invoke({ message: "أقل سعرات؟", language: "ar-EG", context });
  assert.equal(object(lower.data).nutrient, "kcal");
  assert.match(lower.message, /الأقل في السعرات/u);
});

test("BUG-16: naming two dishes again starts a fresh comparison, not a continuation", async () => {
  const context = await comparison();
  const response = await agent.invoke({ message: "قارن الطعمية والحواوشي في البروتين", language: "ar-EG", context });
  const data = object(response.data);
  assert.equal(data.intent, "compare_recipes");
  assert.notEqual(data.continuedComparison, true, "an explicit new comparison is not a follow-up");
  const first = object(data.first as Record<string, unknown> | null);
  assert.notEqual(first.recipeId, FUL, "the new pair replaces the old one");
});

test("BUG-16: naming one dish after a comparison is a normal single-recipe request", async () => {
  const context = await comparison();
  const response = await agent.invoke({ message: "سعرات الكشري", language: "ar-EG", context });
  assert.equal(object(response.data).intent, "recipe_nutrition");
  assert.equal(resolvedRecipeId(response.data), KOSHARI);
});

test("BUG-16: the comparison survives an intervening unrelated turn", async () => {
  const context = await comparison();
  const guideline = await agent.invoke({ message: "ما توصيات منظمة الصحة العالمية عن الصوديوم؟", language: "ar-EG", context });
  const carried = object(guideline.data).conversationContext as GraduationConversationContext | undefined;
  const followupContext = carried ?? context;
  const response = await agent.invoke({ message: "مين الأفضل؟", language: "ar-EG", context: followupContext });
  assert.equal(object(response.data).intent, "compare_recipes", "the remembered comparison is re-focused");
  assert.equal(object(response.data).continuedComparison, true);
});

test("BUG-16: a follow-up with no prior comparison is unaffected", async () => {
  const response = await agent.invoke({ message: "مين الأفضل؟", language: "ar-EG" });
  assert.notEqual(object(response.data).continuedComparison, true);
  assert.notEqual(object(response.data).intent, "compare_recipes");
});

// ---------------------------------------------------------------------------
// The shared defect uncovered while fixing BUG-16: unanchored short pronouns.
// ---------------------------------------------------------------------------

test("BUG-16 shared defect: short pronoun cues no longer match inside ordinary words", async () => {
  // "صوديوم" contains "دي" and "دهون" contains "ده". Unanchored, these were read
  // as pronoun references to the active recipe, which silently redirected a
  // comparison follow-up into a single-recipe nutrition answer.
  const context = await comparison();
  const sodium = await agent.invoke({ message: "الأقل صوديوم؟", language: "ar-EG", context });
  assert.equal(object(sodium.data).intent, "compare_recipes", "صوديوم must not be read as the pronoun دي");

  // A genuine pronoun reference must still work.
  const recipe = await agent.invoke({ message: "سعرات الكشري", language: "ar-EG" });
  const recipeContext = object(recipe.data).conversationContext as GraduationConversationContext;
  const pronoun = await agent.invoke({ message: "هل هي صحية؟", language: "ar-EG", context: recipeContext });
  assert.equal(pronoun.status, "ok");
  assert.equal(object(pronoun.data).assessmentType, "recipe_numeric_context");
  const explicit = await agent.invoke({ message: "قارنها بالفول في السعرات", language: "ar-EG", context: recipeContext });
  assert.equal(explicit.primaryIntent, "compare_recipes", "قارنها still resolves the active recipe");
});

test("BUG-16: model reference resolution cannot hijack a comparison follow-up", async () => {
  // With the LLM layer active the model was asked to resolve the bare follow-up
  // and legitimately returned one of the two compared dishes, which turned
  // "مين الأفضل؟" into that dish's full recipe. The continuation must win, and
  // the model must not be consulted at all.
  const config = {
    ...loadClaudeLayerConfig({}),
    classifierEnabled: true,
    classifierModel: "stub-classifier",
    formatterEnabled: false,
    formatterModel: null,
    referenceResolutionEnabled: true,
  };
  const withModel = await buildGraduationDemoAgent("test", null, new ClaudeLayer({
    config,
    classifierClient: new StubClaudeClient({
      model: "stub-classifier",
      structured: classification({ intent: "find_recipe", referenced_recipe_id: FUL }),
    }),
    formatterClient: null,
  }));
  const cmp = await withModel.invoke({ message: "اعمل مقارنة بين الفول والكشري", language: "ar-EG" });
  const context = object(cmp.data).conversationContext as GraduationConversationContext;

  for (const message of ["مين الأفضل؟", "الأقل صوديوم؟", "ليه؟"]) {
    const response = await withModel.invoke({ message, language: "ar-EG", context });
    const data = object(response.data);
    assert.equal(data.intent, "compare_recipes", message);
    assert.equal(data.continuedComparison, true, message);
    assert.equal(resolvedRecipeId(response.data), null, `${message}: no single-recipe result`);
    assert.doesNotMatch(response.message, /المكونات \(/u, `${message}: no ingredient list`);
    assert.equal(
      withModel.claudeLayer.store.latest()?.referenceResolution,
      "skipped_comparison_continuation",
      `${message}: the model must not be consulted`,
    );
  }
});
