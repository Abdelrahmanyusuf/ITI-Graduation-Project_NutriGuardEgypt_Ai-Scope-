import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { loadUnifiedEgyptianDemoDataset } from "../src/demo/unified-egyptian-dataset.js";
import { MetricsRegistry } from "../src/observability/metrics.js";
import { InMemoryPilotFeedbackStore } from "../src/pilot/feedback.js";
import { buildGraduationDemoAgent, type GraduationConversationContext } from "../src/runtime/graduation-demo-agent.js";
import { createNutriGuardHttpServer } from "../src/server/http-app.js";

const agent = await buildGraduationDemoAgent("test", null);
const dataset = await loadUnifiedEgyptianDemoDataset();
const object = (value: unknown): Record<string, unknown> => {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
};

test("BUG-01 and BUG-10: builds a deterministic three-meal plan around a supplied daily target", async () => {
  const response = await agent.invoke({ message: "عاوز 3 وجبات طول اليوم على 2000 سعر حراري", language: "ar-EG" });
  assert.equal(response.status, "ok");
  const data = object(response.data);
  assert.equal(data.intent, "meal_plan");
  assert.equal(data.targetCaloriesKcal, 2000);
  assert.equal((data.meals as unknown[]).length, 3);
  assert.equal(typeof data.totalCaloriesKcal, "number");
  assert.match(response.message, /الإجمالي المحسوب/u);
});

test("BUG-02: ingredient calculation discloses the food state", async () => {
  const response = await agent.invoke({ message: "كام سعرة في 100 جرام رز؟", language: "ar-EG" });
  assert.equal(response.status, "ok");
  assert.match(response.message, /نيء|مطبوخ/u);
  const ingredients = object(response.data).ingredients as Array<Record<string, unknown>>;
  assert.equal(ingredients[0]?.foodState, "raw");
});

test("BUG-03: an exclusion removes the matched ingredient instead of returning the original recipe", async () => {
  const response = await agent.invoke({ message: "عايز فول بدون زيت خالص", language: "ar-EG" });
  assert.equal(response.status, "ok");
  const data = object(response.data);
  assert.equal(object(data.removedIngredient).key, "olive_oil");
  assert.ok((data.caloriesSavedPerServingKcal as number) > 0);
  assert.ok(!(data.remainingIngredients as Array<{ ingredient: string }>).some((item) => item.ingredient === "olive_oil"));
});

test("BUG-03 round 2: a generic dairy-allergy exclusion recommends an already matching recipe with nutrition and disclaimer", async () => {
  const response = await agent.invoke({ message: "عندي حساسية من الالبان عاوز وجبه من غير منتجات ألبان", language: "ar-EG" });
  assert.equal(response.status, "ok");
  const data = object(response.data);
  assert.equal(data.modificationType, "ingredient_exclusion_filter");
  assert.equal(data.recipeWasModified, false);
  assert.ok((data.excludedIngredientKeys as string[]).includes("yogurt_plain"));
  assert.doesNotMatch(response.message, /(?:yogurt_plain|yogurt plain|tahini|_[a-z])/iu);
  assert.match(response.message, /سعر حراري/u);
  assert.match(response.message, /جم بروتين/u);
  assert.match(response.message, /جم كربوهيدرات/u);
  assert.match(response.message, /جم دهون كلية/u);
  assert.match(response.message, /تم استبعاد منتجات الألبان المسجلة بناءً على طلبك/u);
  assert.match(response.message, /لا يضمن خلو الطعام من التلوث التبادلي/u);
});

test("BUG-03 round 2: a modified recipe gets a truthful regenerated Arabic name, four recalculated macros, and safety wording", async () => {
  const response = await agent.invoke({ message: "عاوز فول بالزبادي والطحينة من غير ألبان", language: "ar-EG" });
  assert.equal(response.status, "ok");
  const data = object(response.data);
  assert.equal(data.modificationType, "ingredient_exclusion");
  assert.equal(data.displayName, "فول بالطحينة — وصفة معدّلة");
  assert.doesNotMatch(response.message.split("\n", 1)[0]!, /زبادي|بدون/u);
  assert.doesNotMatch(response.message, /(?:yogurt_plain|yogurt plain|tahini|_[a-z])/iu);
  assert.match(response.message, /سعر حراري/u);
  assert.match(response.message, /جم بروتين/u);
  assert.match(response.message, /جم كربوهيدرات/u);
  assert.match(response.message, /جم دهون كلية/u);
  assert.match(response.message, /تم استبعاد زبادي بناءً على طلبك/u);
  const modified = object(data.modifiedNutrition);
  const perServing = object(modified.perServing);
  for (const nutrient of ["kcal", "protein", "carbs", "fat"]) assert.equal(typeof perServing[nutrient], "number", nutrient);
});

test("BUG-03 round 2: every dataset ingredient has an Arabic display name in recipe responses", async () => {
  for (const recipe of dataset.recipes) {
    const response = await agent.invoke({ message: `مكونات ${recipe.name_ar}`, language: "ar-EG" });
    assert.equal(response.status, "ok", recipe.name_ar);
    const ingredientSection = response.message.split("طريقة التحضير:", 1)[0] ?? "";
    assert.doesNotMatch(ingredientSection, /[A-Za-z_]/u, recipe.name_ar);
  }
});

for (const wording of [
  "عاوز منك وجبه فول خاليه من الزيت خالص",
  "عاوز منك وجبة فول خالية من الزيت خالص",
  "عايز فول خالي تماما من الزيت",
  "فول من دون زيت",
  "شيل زيت الزيتون من الفول",
  "احذف الزيت من وصفة الفول",
  "بلاش زيت في الفول",
  "ما تحطش زيت في الفول",
  "عايز فول مافيهاش نقطة زيت",
  "Ful without oil",
  "oil-free Ful",
]) {
  test(`BUG-03 exclusion wording: ${wording}`, async () => {
    const language = /\p{Script=Arabic}/u.test(wording) ? "ar-EG" : "en";
    const response = await agent.invoke({ message: wording, language });
    assert.equal(response.status, "ok");
    const data = object(response.data);
    assert.equal(data.modificationType, "ingredient_exclusion");
    assert.ok(!(data.remainingIngredients as Array<{ ingredient: string }>).some((item) => item.ingredient === "olive_oil"));
    assert.ok((data.caloriesSavedPerServingKcal as number) > 0);
  });
}

test("BUG-03: multiple exclusions are all applied in one deterministic recalculation", async () => {
  const response = await agent.invoke({ message: "عايز كشري من غير زيت وبصل", language: "ar-EG" });
  assert.equal(response.status, "ok");
  const data = object(response.data);
  const removed = data.removedIngredients as Array<{ key: string }>;
  assert.ok(removed.some((item) => item.key === "vegetable_oil"));
  assert.ok(removed.some((item) => item.key === "onion_raw"));
  const remaining = data.remainingIngredients as Array<{ ingredient: string }>;
  assert.ok(!remaining.some((item) => item.ingredient === "vegetable_oil" || item.ingredient === "onion_raw"));
});

test("BUG-03: asking for less oil reduces it instead of treating it as a zero-oil guarantee", async () => {
  const response = await agent.invoke({ message: "عايز فول بزيت أقل", language: "ar-EG" });
  assert.equal(response.status, "ok");
  assert.equal(object(response.data).modificationType, undefined);
  assert.equal(object(object(response.data).modification).ingredient, "olive_oil");
  assert.equal(object(object(response.data).modification).proposedGrams, 20);
});

test("BUG-03: zero-oil wording removes every recorded added-fat ingredient across the corpus", async () => {
  const oilKeys = new Set(["vegetable_oil", "olive_oil", "ghee", "butter_raw"]);
  const recipesWithOil = dataset.recipes.filter((recipe) => recipe.ingredients.some((item) => oilKeys.has(item.ingredient)));
  assert.ok(recipesWithOil.length > 20);
  for (const recipe of recipesWithOil) {
    const response = await agent.invoke({ message: `عايز ${recipe.name_ar} خالية من الزيت خالص`, language: "ar-EG" });
    assert.equal(response.status, "ok", recipe.name_ar);
    const data = object(response.data);
    assert.equal(data.recipeId, recipe.recipe_id, recipe.name_ar);
    assert.ok(!(data.remainingIngredients as Array<{ ingredient: string }>).some((item) => oilKeys.has(item.ingredient)), recipe.name_ar);
  }
});

test("BUG-04 and BUG-09: recipe reference context keeps consistent health follow-ups", async () => {
  const first = await agent.invoke({ message: "طريقة عمل الفتة", language: "ar-EG" });
  const context = object(first.data).conversationContext as GraduationConversationContext;
  const followup = await agent.invoke({ message: "هل هي صحية؟", language: "ar-EG", context });
  assert.equal(followup.status, "ok");
  assert.equal(object(followup.data).assessmentType, "recipe_numeric_context");
  assert.match(followup.message, /الدهون المشبعة غير متوفرة/u);
});

test("BUG-05: general WHO sodium guidance does not invent a classification for ful", async () => {
  const response = await agent.invoke({ message: "ما هي إرشادات منظمة الصحة العالمية للصوديوم؟", language: "ar-EG" });
  assert.equal(response.status, "ok");
  assert.match(response.message, /2000/u);
  assert.doesNotMatch(response.message, /فول/u);
});

test("BUG-06: elongated Arabic spelling resolves to the intended recipe", async () => {
  const response = await agent.invoke({ message: "عايز وصفة فووول", language: "ar-EG" });
  assert.equal(response.status, "ok");
  assert.equal(object(object(response.data).recipe).recipeId, "EGY-RCP-002");
});

test("BUG-07: unknown recipe and out-of-scope requests use distinct reason codes", async () => {
  const missing = await agent.invoke({ message: "عايز وصفة زركشية مصرية", language: "ar-EG" });
  const unsupported = await agent.invoke({ message: "اكتب لي كود لعبة سيارات", language: "ar-EG" });
  assert.equal(object(missing.data).reasonCode, "recipe_not_in_verified_dataset");
  assert.equal(object(unsupported.data).reasonCode, "out_of_scope");
});

test("BUG-08: personal calorie requirement is not confused with ingredient arithmetic", async () => {
  const response = await agent.invoke({ message: "احسبلي احتياجي اليومي من السعرات", language: "ar-EG" });
  assert.equal(response.status, "unsupported");
  assert.equal(object(response.data).reasonCode, "personal_calorie_requirement_not_supported");
  assert.doesNotMatch(response.message, /وزنه بالجرام/u);
});

test("BUG-09: recipe context supports compare and lighter follow-ups but a new session does not inherit it", async () => {
  const first = await agent.invoke({ message: "مكونات الفول", language: "ar-EG" });
  const context = object(first.data).conversationContext as GraduationConversationContext;
  const comparison = await agent.invoke({ message: "قارنها بالكشري في السعرات", language: "ar-EG", context });
  assert.equal(comparison.primaryIntent, "compare_recipes");
  assert.match(comparison.message, /فول مدمس/u);
  const lighter = await agent.invoke({ message: "خففها", language: "ar-EG", context });
  assert.equal(lighter.primaryIntent, "lighter_recipe");
  const cleanSession = await agent.invoke({ message: "خففها", language: "ar-EG" });
  assert.notEqual(cleanSession.status, "ok");
});

test("BUG-09: repeated health and diet-suitability follow-ups retain the active recipe", async () => {
  const first = await agent.invoke({ message: "هل الفتة صحية للنظام الغذائي", language: "ar-EG" });
  const firstContext = object(first.data).conversationContext as GraduationConversationContext;
  assert.equal(firstContext.lastIntent, "recipe_reference");

  const second = await agent.invoke({ message: "يعني هي مش صحية؟", language: "ar-EG", context: firstContext });
  assert.equal(second.status, "ok");
  assert.equal(second.primaryIntent, "general_guidance");
  assert.match(second.message, /فتة/u);
  const secondContext = object(second.data).conversationContext as GraduationConversationContext;
  assert.equal(secondContext.lastIntent, "recipe_reference");

  const third = await agent.invoke({ message: "طب هل هي في النظام الغذائي", language: "ar-EG", context: secondContext });
  assert.equal(third.status, "ok");
  assert.equal(third.primaryIntent, "general_guidance");
  assert.match(third.message, /فتة/u);
  assert.doesNotMatch(third.message, /اكتب كل مكوّن ووزنه/u);
});

test("BUG-10: calorie and dairy rules are applied and retained in follow-up plans", async () => {
  const first = await agent.invoke({ message: "عاوز 3 وجبات اليوم 1800 سعر ومن غير ألبان", language: "ar-EG" });
  assert.equal(first.status, "ok");
  const firstData = object(first.data);
  const exclusions = firstData.excludedIngredientKeys as string[];
  assert.ok(exclusions.includes("milk_whole"));
  assert.match(first.message, /مش ضمان/u);
  const context = firstData.conversationContext as GraduationConversationContext;
  const second = await agent.invoke({ message: "قللها 200 سعر", language: "ar-EG", context });
  assert.equal(second.status, "ok");
  assert.equal(object(second.data).targetCaloriesKcal, 1600);
  assert.deepEqual(object(second.data).excludedIngredientKeys, exclusions);
});

test("BUG-01 and BUG-10: a direct ten-meal maximum request is parsed and every rule is enforced", async () => {
  const response = await agent.invoke({ message: "عاوزك تحضرلي 10 وجبات اليوم بس لا يتخطو 3000 سعرة حراري", language: "ar-EG" });
  assert.equal(response.status, "ok");
  const data = object(response.data);
  assert.equal(data.intent, "meal_plan");
  assert.equal(data.mealCount, 10);
  assert.equal(data.calorieConstraint, "maximum");
  assert.equal((data.meals as unknown[]).length, 10);
  assert.ok((data.totalCaloriesKcal as number) <= 3000);
  const meals = data.meals as Array<{ slot: string; recipeId: string }>;
  assert.equal(new Set(meals.map((meal) => meal.recipeId)).size, 10);
  assert.deepEqual(object(data.mealDistribution), { breakfast: 3, lunch: 4, dinner: 3 });
  assert.deepEqual(meals.reduce<Record<string, number>>((counts, meal) => ({ ...counts, [meal.slot]: (counts[meal.slot] ?? 0) + 1 }), {}), { breakfast: 3, lunch: 4, dinner: 3 });
  assert.match(response.message, /الفطار \(3\)[\s\S]*الغداء \(4\)[\s\S]*العشاء \(3\)/u);
  assert.match(response.message, /داخل الحد الأقصى/u);
});

test("BUG-01 round 2: the reported ten-meal ceiling phrasing reaches the plan and has sufficient coverage", async () => {
  const response = await agent.invoke({ message: "حضرلي 10 وجبات لليوم بس لا يتخطوا 3000 سعرة", language: "ar-EG" });
  assert.equal(response.status, "ok");
  const data = object(response.data);
  assert.equal(data.intent, "meal_plan");
  assert.equal(data.mealCount, 10);
  assert.equal(data.calorieConstraint, "maximum");
  assert.equal(data.targetCaloriesKcal, 3000);
  assert.equal((data.meals as unknown[]).length, 10);
  assert.ok((data.totalCaloriesKcal as number) <= 3000);
  const meals = data.meals as Array<{ slot: string; recipeId: string }>;
  assert.equal(new Set(meals.map((meal) => meal.recipeId)).size, 10);
  assert.deepEqual(object(data.mealDistribution), { breakfast: 3, lunch: 4, dinner: 3 });
  for (const meal of meals) {
    const category = dataset.recipes.find((recipe) => recipe.recipe_id === meal.recipeId)?.category;
    assert.ok(category, meal.recipeId);
    if (meal.slot === "breakfast") assert.ok(category === "breakfast" || category === "bread", `${meal.recipeId}: ${category}`);
    if (meal.slot === "lunch") assert.equal(category, "main_dish", meal.recipeId);
    if (meal.slot === "dinner") assert.ok(category === "main_dish" || category === "soup" || category === "salad", `${meal.recipeId}: ${category}`);
  }
});

test("BUG-01 round 2 HTTP: the exact ten-meal phrase is wired through /api/v1/chat, not only the direct agent", async () => {
  const server = createNutriGuardHttpServer({
    agent, feedbackStore: new InMemoryPilotFeedbackStore(), mode: "test", releaseId: "BUG-ROUND-2",
    allowedOrigins: [], readiness: async () => ({ ready: true, blockers: [] }), pilotConsentReference: "TEST-CONSENT",
    privacyNoticeVersion: "test", rateLimit: { windowMs: 60_000, maxRequests: 5 }, metrics: new MetricsRegistry(), metricsToken: "test-token-value-123",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/chat`, {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ message: "حضرلي 10 وجبات لليوم بس لا يتخطوا 3000 سعرة", language: "ar-EG" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { result: { status: string; message: string; data: { intent: string; mealCount: number; totalCaloriesKcal: number; mealDistribution: Record<string, number> } } };
    assert.equal(body.result.status, "ok");
    assert.equal(body.result.data.intent, "meal_plan");
    assert.equal(body.result.data.mealCount, 10);
    assert.ok(body.result.data.totalCaloriesKcal <= 3000);
    assert.deepEqual(body.result.data.mealDistribution, { breakfast: 3, lunch: 4, dinner: 3 });
    assert.match(body.result.message, /الفطار \(3\)[\s\S]*الغداء \(4\)[\s\S]*العشاء \(3\)/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("BUG-09 and BUG-10: a meal-plan draft remembers count and exclusions until the calorie target arrives", async () => {
  const first = await agent.invoke({ message: "عاوزك تحضرلي وجبات اليوم من غير منتجات ألبان", language: "ar-EG" });
  assert.equal(first.status, "clarification");
  const draft = object(first.data).conversationContext as GraduationConversationContext;
  assert.equal(draft.lastIntent, "meal_plan_draft");
  assert.ok(draft.lastIntent === "meal_plan_draft" && draft.excludedIngredientKeys.includes("yogurt_plain"));

  const second = await agent.invoke({ message: "هدفي في السعرات اليوميه 2000 سعره", language: "ar-EG", context: draft });
  assert.equal(second.status, "ok");
  const secondData = object(second.data);
  assert.equal(secondData.mealCount, 3);
  assert.equal((secondData.meals as unknown[]).length, 3);
  assert.ok((secondData.excludedIngredientKeys as string[]).includes("yogurt_plain"));

  const five = await agent.invoke({ message: "خليهم 5 وجبات", language: "ar-EG", context: secondData.conversationContext as GraduationConversationContext });
  assert.equal(five.status, "ok");
  assert.equal(object(five.data).mealCount, 5);
  assert.equal((object(five.data).meals as unknown[]).length, 5);

  const six = await agent.invoke({ message: "زود وجبة", language: "ar-EG", context: object(five.data).conversationContext as GraduationConversationContext });
  assert.equal(six.status, "ok");
  assert.equal(object(six.data).mealCount, 6);
  assert.equal((object(six.data).meals as unknown[]).length, 6);
});

test("BUG-09 shared memory keeps recipe and meal-plan state together and routes back to the plan", async () => {
  const plan = await agent.invoke({ message: "جهزلي 3 وجبات اليوم 1800 سعر ومن غير ألبان", language: "ar-EG" });
  const planContext = object(plan.data).conversationContext as GraduationConversationContext;
  assert.ok(planContext.memory?.mealPlan);
  assert.ok(planContext.memory?.mealPlan?.excludedIngredientKeys.includes("yogurt_plain"));

  const recipe = await agent.invoke({ message: "مكونات الكشري", language: "ar-EG", context: planContext });
  const recipeContext = object(recipe.data).conversationContext as GraduationConversationContext;
  assert.equal(recipeContext.lastIntent, "recipe_reference");
  assert.equal(recipeContext.memory?.activeRecipeId, "EGY-RCP-001");
  assert.equal(recipeContext.memory?.mealPlan?.calorieTargetKcal, 1800);

  const resumed = await agent.invoke({ message: "ارجع لخطة الوجبات وخليهم 5 وجبات", language: "ar-EG", context: recipeContext });
  assert.equal(resumed.status, "ok");
  const resumedData = object(resumed.data);
  assert.equal(resumedData.mealCount, 5);
  assert.equal(resumedData.targetCaloriesKcal, 1800);
  assert.ok((resumedData.excludedIngredientKeys as string[]).includes("yogurt_plain"));
  const resumedContext = resumedData.conversationContext as GraduationConversationContext;
  assert.equal(resumedContext.memory?.activeRecipeId, "EGY-RCP-001", "resuming a plan must not erase the active recipe");
  assert.ok((resumedContext.memory?.recentRecipeIds.length ?? 0) <= 8);
});

test("BUG-10: colloquial 'must not contain dairy' excludes yogurt and every dairy ingredient", async () => {
  const response = await agent.invoke({ message: "عاوز وجبة افطار تكون من 500 سعر حراري بس ميكنش فيها منتجات البان", language: "ar-EG" });
  assert.equal(response.status, "ok");
  const data = object(response.data);
  const excluded = new Set(data.excludedIngredientKeys as string[]);
  assert.ok(excluded.has("yogurt_plain"), "yogurt must be treated as dairy");
  assert.ok(excluded.has("milk_whole"));
  assert.ok(excluded.has("cheese_feta"));
  const recipe = dataset.recipes.find((candidate) => candidate.recipe_id === data.recipeId);
  assert.ok(recipe);
  assert.ok(!recipe.ingredients.some((item) => excluded.has(item.ingredient)), "recommended recipe must contain no excluded dairy ingredient");
  assert.doesNotMatch(response.message, /بالزبادي/u);
});

test("critical audit: breakfast, dairy allergy, recipe identity, oil exclusion, and energy basis stay synchronized", async () => {
  const breakfast = await agent.invoke({
    message: "عاوز وجبة افطار من 500 سعر حراري بس ميكنش فيها منتجات ألبان لأنى عندى حساسية منها",
    language: "ar-EG",
  });
  assert.equal(breakfast.status, "ok");
  const breakfastData = object(breakfast.data);
  const breakfastRecipe = dataset.recipes.find((recipe) => recipe.recipe_id === breakfastData.recipeId);
  assert.ok(breakfastRecipe);
  assert.equal(breakfastRecipe.category, "breakfast");
  const excludedDairy = new Set(breakfastData.excludedIngredientKeys as string[]);
  assert.ok(excludedDairy.has("yogurt_plain"));
  assert.ok(excludedDairy.has("milk_whole"));
  assert.ok(!breakfastRecipe.ingredients.some((item) => excludedDairy.has(item.ingredient)));
  assert.doesNotMatch(breakfast.message, /بالزبادي/u);

  const oilFree = await agent.invoke({ message: "عاوز منك وجبه فول خاليه من الزيت خالص", language: "ar-EG" });
  assert.equal(oilFree.status, "ok");
  const oilFreeData = object(oilFree.data);
  const remaining = oilFreeData.remainingIngredients as Array<{ ingredient: string }>;
  assert.ok(!remaining.some((item) => ["olive_oil", "vegetable_oil", "ghee", "butter_raw"].includes(item.ingredient)));
  assert.equal(object(object(oilFreeData.modifiedNutrition).perServing).fat, 1.4);
  assert.ok(object(object(oilFreeData.modifiedNutrition).perServing));

  const ful = await agent.invoke({ message: "عايز وصفة فول", language: "ar-EG" });
  assert.equal(ful.status, "ok");
  assert.match(ful.message, /^فول مدمس/u);

  const saturated = await agent.invoke({ message: "هل الدهون المشبعة مضرة؟", language: "ar-EG" });
  assert.equal(saturated.status, "ok");
  assert.equal(object(saturated.data).concept, "saturated_fat");
  assert.match(saturated.message, /10%/u);

  const target = await agent.invoke({ message: "عاوز وجبة غداء 600 سعر حراري", language: "ar-EG" });
  assert.equal(target.status, "ok");
  const targetData = object(target.data);
  assert.equal(targetData.recipeName, "فتة");
  assert.doesNotMatch(target.message, /هي فئة/u);
  assert.equal(object(targetData.energyReconciliation).macroEstimateKcal, 566);
  assert.equal(targetData.macroDifferenceFromTargetKcal, 34);
  assert.match(target.message, /4\/4\/9/u);
  assert.match(target.message, /حسب طاقة المكونات المسجلة/u);
});

test("critical audit: a short dairy follow-up updates the previous meal target instead of losing context", async () => {
  const first = await agent.invoke({ message: "عاوز وجبة افطار من 500 سعر حراري", language: "ar-EG" });
  assert.equal(first.status, "ok");
  const context = object(first.data).conversationContext as GraduationConversationContext;
  const followup = await agent.invoke({
    message: "بس ميكنش فيها منتجات ألبان لأنى عندى حساسية منها",
    language: "ar-EG",
    context,
  });
  assert.equal(followup.status, "ok");
  const data = object(followup.data);
  assert.equal(data.targetCaloriesKcal, 500);
  const excluded = new Set(data.excludedIngredientKeys as string[]);
  assert.ok(excluded.has("yogurt_plain"));
  const recipe = dataset.recipes.find((candidate) => candidate.recipe_id === data.recipeId);
  assert.ok(recipe);
  assert.equal(recipe.category, "breakfast");
  assert.ok(!recipe.ingredients.some((item) => excluded.has(item.ingredient)));

  const explicitOilFreeFul = await agent.invoke({
    message: "عاوز منك وجبه فول خاليه من الزيت خالص",
    language: "ar-EG",
    context: object(followup.data).conversationContext as GraduationConversationContext,
  });
  assert.equal(explicitOilFreeFul.status, "ok");
  const oilData = object(explicitOilFreeFul.data);
  assert.equal(oilData.modificationType, "ingredient_exclusion");
  assert.equal(oilData.recipeId, "EGY-RCP-002");
  const remaining = oilData.remainingIngredients as Array<{ ingredient: string }>;
  assert.ok(!remaining.some((item) => ["olive_oil", "vegetable_oil", "flaxseed_oil", "ghee", "butter_raw"].includes(item.ingredient)));
});

test("BUG-09 and BUG-10: a constrained single meal remains the subject of a pronoun follow-up", async () => {
  const first = await agent.invoke({ message: "عاوز وجبة إفطار 500 سعر ومفيهاش منتجات ألبان عشان عندي حساسية منها", language: "ar-EG" });
  assert.equal(first.status, "ok");
  const firstData = object(first.data);
  assert.ok((firstData.excludedIngredientKeys as string[]).includes("milk_whole"));
  const followup = await agent.invoke({ message: "هل هي صحية؟", language: "ar-EG", context: firstData.conversationContext as GraduationConversationContext });
  assert.equal(followup.status, "ok");
  assert.equal(object(followup.data).assessmentType, "recipe_numeric_context");
});
