import assert from "node:assert/strict";
import test from "node:test";
import { buildGraduationDemoAgent, type GraduationConversationContext } from "../src/runtime/graduation-demo-agent.js";

const agent = await buildGraduationDemoAgent("test", null);
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

test("BUG-09 and BUG-10: a constrained single meal remains the subject of a pronoun follow-up", async () => {
  const first = await agent.invoke({ message: "عاوز وجبة إفطار 500 سعر ومفيهاش منتجات ألبان عشان عندي حساسية منها", language: "ar-EG" });
  assert.equal(first.status, "ok");
  const firstData = object(first.data);
  assert.ok((firstData.excludedIngredientKeys as string[]).includes("milk_whole"));
  const followup = await agent.invoke({ message: "هل هي صحية؟", language: "ar-EG", context: firstData.conversationContext as GraduationConversationContext });
  assert.equal(followup.status, "ok");
  assert.equal(object(followup.data).assessmentType, "recipe_numeric_context");
});
