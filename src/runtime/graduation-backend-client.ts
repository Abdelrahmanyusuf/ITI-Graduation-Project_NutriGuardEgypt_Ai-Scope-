import { z } from "zod";
import { currentBackendAccessToken } from "./backend-request-context.js";

const FoodSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1),
  foodCategoryId: z.number().int().positive(),
  category: z.string().trim().min(1),
  energy: z.number().nonnegative().nullable(),
  protein: z.number().nonnegative().nullable(),
  carbohydrate: z.number().nonnegative().nullable(),
  fat: z.number().nonnegative().nullable(),
  fiber: z.number().nonnegative().nullable(),
  sodium: z.number().nonnegative().nullable(),
  aliases: z.array(z.string()),
});

const RecipeIngredientSchema = z.object({
  foodId: z.number().int().positive(),
  foodName: z.string().trim().min(1),
  quantity: z.number().positive(),
  unit: z.string().trim().min(1),
});

const RecipeSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1),
  description: z.string().nullable().default(null),
  instructions: z.string().nullable().optional(),
  servings: z.number().int().positive(),
  preparationTimeMinutes: z.number().int().nonnegative(),
  aliases: z.array(z.string()),
  ingredients: z.array(RecipeIngredientSchema),
});

const FoodSearchSchema = z.object({
  items: z.array(FoodSchema),
  totalCount: z.number().int().nonnegative(),
});

const RecipeSearchSchema = z.object({
  isSuccess: z.literal(true),
  data: z.array(RecipeSchema),
  totalCount: z.number().int().nonnegative(),
});

const RecipeDetailSchema = z.object({ isSuccess: z.literal(true), data: RecipeSchema });
const FoodDetailSchema = z.object({ isSuccess: z.literal(true), data: FoodSchema });

export type BackendFood = z.infer<typeof FoodSchema>;
export type BackendRecipe = z.infer<typeof RecipeSchema>;

const MealTypeSchema = z.enum(["Breakfast", "Lunch", "Dinner", "Snack"]);
const CustomMealRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  externalReferenceId: z.string().trim().min(1).max(100),
  source: z.enum(["AI", "NutriGuardAI"]),
  mealType: MealTypeSchema,
  date: z.iso.date(),
  servings: z.number().finite().positive().max(100),
  energyKcal: z.number().finite().nonnegative(),
  proteinG: z.number().finite().nonnegative(),
  carbohydrateG: z.number().finite().nonnegative(),
  fatG: z.number().finite().nonnegative(),
}).strict();

export type BackendMealType = z.infer<typeof MealTypeSchema>;
export type CreateCustomMealRequest = z.infer<typeof CustomMealRequestSchema>;

const BatchCustomMealResultSchema = z.object({
  applied: z.boolean(),
  reason: z.string().nullable(),
  operationId: z.string().trim().min(1).nullable(),
  loggedSelectionIds: z.array(z.number().int().positive()).nullable(),
  dailyCaloriesRemaining: z.number().finite().nonnegative(),
}).strict();

const BatchCustomMealResponseSchema = z.object({
  isSuccess: z.literal(true),
  message: z.string().nullable(),
  data: BatchCustomMealResultSchema,
}).strict();

export interface BatchCustomMealResult {
  applied: boolean;
  reason: string | null;
  operationId: string | null;
  loggedSelectionIds: number[];
  dailyCaloriesRemaining: number;
  raw: unknown;
}

export interface CreatedCustomMeal {
  id: number;
  raw: unknown;
}

export interface GraduationBackendDataSource {
  searchFoods(term: string, limit?: number): Promise<BackendFood[]>;
  getFood(id: number): Promise<BackendFood>;
  searchRecipes(term: string, limit?: number): Promise<BackendRecipe[]>;
  getRecipe(id: number): Promise<BackendRecipe>;
  getHealthProfile?(): Promise<unknown>;
  getFoodPreferences?(): Promise<unknown>;
  getNutritionTargets?(): Promise<unknown>;
  getUserRules?(): Promise<unknown>;
  getDailySummary?(date: string): Promise<unknown>;
  createCustomMealBatch?(idempotencyKey: string, requests: readonly CreateCustomMealRequest[]): Promise<BatchCustomMealResult>;
  createCustomMeal?(request: CreateCustomMealRequest): Promise<CreatedCustomMeal>;
  deleteCustomMeal?(id: number): Promise<void>;
}

function normalized(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase("ar-EG")
    .replace(/[\u064B-\u065F\u0670]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().replace(/\s+/gu, " ");
}

export function rankBackendFoods(term: string, foods: readonly BackendFood[]): BackendFood[] {
  const target = normalized(term);
  return [...foods].sort((a, b) => {
    const score = (food: BackendFood) => {
      const name = normalized(food.name);
      const aliases = food.aliases.map(normalized);
      if (name === target) return 4;
      if (aliases.includes(target)) return 3;
      if (name.includes(target) || target.includes(name)) return 2;
      if (aliases.some((alias) => alias.includes(target) || target.includes(alias))) return 1;
      return 0;
    };
    return score(b) - score(a) || a.id - b.id;
  });
}

export class NutriGuardBackendClient implements GraduationBackendDataSource {
  public constructor(
    private readonly baseUrl = "http://nutriguard.runasp.net",
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 4_000,
    private readonly allowInsecureAuthenticatedHttp = false,
  ) {}

  public async searchFoods(term: string, limit = 8): Promise<BackendFood[]> {
    const query = new URLSearchParams({ SearchTerm: term, PageNumber: "1", PageSize: String(limit) });
    const parsed = FoodSearchSchema.parse(await this.request(`/api/Foods/search?${query}`));
    return rankBackendFoods(term, parsed.items);
  }

  public async searchRecipes(term: string, limit = 5): Promise<BackendRecipe[]> {
    const query = new URLSearchParams({ SearchTerm: term, PageNumber: "1", PageSize: String(limit) });
    return RecipeSearchSchema.parse(await this.request(`/api/Recipes/search?${query}`)).data;
  }

  public async getFood(id: number): Promise<BackendFood> {
    return FoodDetailSchema.parse(await this.request(`/api/Foods/${id}`)).data;
  }

  public async getRecipe(id: number): Promise<BackendRecipe> {
    return RecipeDetailSchema.parse(await this.request(`/api/Recipes/${id}`)).data;
  }

  public async getHealthProfile(): Promise<unknown> {
    return this.authenticatedRequest("/api/HealthProfile");
  }

  public async getNutritionTargets(): Promise<unknown> {
    return this.authenticatedRequest("/api/Nutrition/targets");
  }

  public async getUserRules(): Promise<unknown> {
    return this.authenticatedRequest("/api/Nutrition/user-rules");
  }

  public async getDailySummary(date: string): Promise<unknown> {
    return this.authenticatedRequest(`/api/Tracking/summary/${z.iso.date().parse(date)}`);
  }

  public async createCustomMeal(request: CreateCustomMealRequest): Promise<CreatedCustomMeal> {
    const body = CustomMealRequestSchema.parse(request);
    const raw = await this.authenticatedRequest("/api/Tracking/custom-meals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const id = findPositiveInteger(raw, ["customMealLogId", "mealLogId", "id"]);
    if (id === null) throw new Error("NutriGuard Backend custom-meal response did not contain a log ID");
    return { id, raw };
  }

  public async createCustomMealBatch(
    idempotencyKey: string,
    requests: readonly CreateCustomMealRequest[],
  ): Promise<BatchCustomMealResult> {
    const key = z.string().trim().min(1).max(200).parse(idempotencyKey);
    const selections = z.array(CustomMealRequestSchema).min(1).max(20).parse(requests);
    const raw = await this.authenticatedRequest("/api/Tracking/custom-meals/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ selections }),
    });
    const parsed = BatchCustomMealResponseSchema.parse(raw).data;
    return {
      ...parsed,
      loggedSelectionIds: parsed.loggedSelectionIds ?? [],
      raw,
    };
  }

  public async deleteCustomMeal(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("custom meal ID must be a positive integer");
    await this.authenticatedRequest(`/api/Tracking/custom-meals/${id}`, { method: "DELETE" });
  }

  private async request(path: string): Promise<unknown> {
    return this.performRequest(path, { headers: { accept: "application/json" } });
  }

  private async authenticatedRequest(path: string, init: RequestInit = {}): Promise<unknown> {
    if (new URL(this.baseUrl).protocol !== "https:" && !this.allowInsecureAuthenticatedHttp) {
      throw Object.assign(new Error("Authenticated Backend requests require HTTPS"), { code: "insecure_transport" });
    }
    const token = currentBackendAccessToken();
    if (!token) throw Object.assign(new Error("Backend authentication is required"), { code: "invalid_token" });
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${token}`);
    return this.performRequest(path, { ...init, headers });
  }

  private async performRequest(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(new URL(path, this.baseUrl), { ...init, signal: controller.signal });
      if (!response.ok) throw Object.assign(new Error(`NutriGuard backend returned HTTP ${response.status}`), { status: response.status });
      if (response.status === 204) return null;
      return await response.json() as unknown;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function findPositiveInteger(value: unknown, keys: readonly string[]): number | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) return candidate;
  }
  return findPositiveInteger(record.data, keys);
}
