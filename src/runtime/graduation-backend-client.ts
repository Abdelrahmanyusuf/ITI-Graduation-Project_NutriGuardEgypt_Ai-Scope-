import { z } from "zod";

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

export interface GraduationBackendDataSource {
  searchFoods(term: string, limit?: number): Promise<BackendFood[]>;
  getFood(id: number): Promise<BackendFood>;
  searchRecipes(term: string, limit?: number): Promise<BackendRecipe[]>;
  getRecipe(id: number): Promise<BackendRecipe>;
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

  private async request(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(new URL(path, this.baseUrl), { headers: { accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(`NutriGuard backend returned HTTP ${response.status}`);
      return await response.json() as unknown;
    } finally {
      clearTimeout(timeout);
    }
  }
}
