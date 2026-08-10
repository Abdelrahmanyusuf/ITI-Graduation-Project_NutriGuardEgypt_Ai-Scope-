import assert from "node:assert/strict";
import test from "node:test";
import { NutriGuardBackendClient, type BackendFood, type BackendRecipe, type GraduationBackendDataSource } from "../src/runtime/graduation-backend-client.js";
import { buildGraduationDemoAgent } from "../src/runtime/graduation-demo-agent.js";

const apple: BackendFood = {
  id: 181, name: "Apples", foodCategoryId: 2, category: "Fruits", energy: 57,
  protein: 0.4, carbohydrate: 13.5, fat: 0.2, fiber: 0.8, sodium: 5, aliases: ["تفاح"],
};

const backendRecipe: BackendRecipe = {
  id: 501, name: "Test Backend Dish", description: "Backend recipe description.", instructions: "Mix and cook.",
  servings: 2, preparationTimeMinutes: 20, aliases: ["أكلة باك إند تجريبية"],
  ingredients: [{ foodId: 181, foodName: "Apples", quantity: 100, unit: "Gram" }],
};

test("backend client validates and normalizes the public Foods and Recipes responses", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const body = url.pathname.includes("Foods/search")
      ? { items: [apple], totalCount: 1 }
      : url.pathname.includes("Recipes/search")
        ? { isSuccess: true, data: [backendRecipe], totalCount: 1 }
        : url.pathname.includes("Recipes/501")
          ? { isSuccess: true, data: backendRecipe }
          : { isSuccess: true, data: apple };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new NutriGuardBackendClient("http://backend.test", fetcher);
  assert.equal((await client.searchFoods("تفاح"))[0]?.id, 181);
  assert.equal((await client.searchRecipes("Test Backend Dish"))[0]?.id, 501);
  assert.equal((await client.getRecipe(501)).instructions, "Mix and cook.");
  assert.equal((await client.getFood(181)).energy, 57);
});

test("graduation agent augments local data with backend foods and recipes", async () => {
  const backend: GraduationBackendDataSource = {
    searchFoods: async () => [apple], getFood: async () => apple,
    searchRecipes: async () => [backendRecipe], getRecipe: async () => backendRecipe,
  };
  const agent = await buildGraduationDemoAgent("test", backend);

  const food = await agent.invoke({ message: "كم سعر حراري في التفاح؟", language: "ar-EG" });
  assert.equal(food.status, "ok");
  assert.equal(food.data?.backendFoodId, 181);
  assert.equal(food.data?.caloriesPer100gKcal, 57);
  assert.match(food.message, /57/);

  const ingredients = await agent.invoke({ message: "احسب سعرات 200 جرام تفاح", language: "ar-EG" });
  assert.equal(ingredients.status, "ok");
  assert.equal(ingredients.data?.backendFoodsUsed, 1);
  assert.equal(ingredients.data?.totalCaloriesKcal, 114);

  const recipe = await agent.invoke({ message: "How do I make Test Backend Dish?", language: "en" });
  assert.equal(recipe.status, "ok");
  assert.equal(recipe.data?.backendRecipeId, 501);
  assert.match(recipe.message, /Mix and cook/);
});

test("backend failures do not break the local graduation agent", async () => {
  const failing: GraduationBackendDataSource = {
    searchFoods: async () => { throw new Error("offline"); },
    getFood: async () => { throw new Error("offline"); },
    searchRecipes: async () => { throw new Error("offline"); },
    getRecipe: async () => { throw new Error("offline"); },
  };
  const agent = await buildGraduationDemoAgent("test", failing);
  const response = await agent.invoke({ message: "كام سعر حراري في الكشري؟", language: "ar-EG" });
  assert.equal(response.status, "ok");
  assert.equal(response.data?.recipeId, "EGY-RCP-001");
});
