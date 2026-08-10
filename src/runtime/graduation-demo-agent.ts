import type { ExpandedAgentResponse } from "../agent/expanded-agent.js";
import { InMemoryAlternativeRuleRepository, NutriGuardExpandedAgent } from "../agent/expanded-agent.js";
import { NUTRIGUARD_SYSTEM_PROMPT_VERSION } from "../agent/system-prompt.js";
import {
  buildGraduationRetrievalCorpus,
  GRADUATION_DEMO_CORPUS_ID,
  loadUnifiedEgyptianDemoDataset,
  toRecipeNutritionResult,
} from "../demo/unified-egyptian-dataset.js";
import { ingestRetrievalCorpus } from "../retrieval/ingestion.js";
import type { EmbeddingProvider } from "../retrieval/types.js";
import { InMemoryVectorStore } from "../retrieval/vector-store.js";
import { InMemoryGuidelineRuleRepository, NutriGuardTools } from "../tools/nutriguard-tools.js";

const DIMENSIONS = 16_384;

function normalizedTokens(value: string): string[] {
  const normalized = value.normalize("NFKD").toLocaleLowerCase("ar-EG").replace(/[\u064B-\u065F\u0670]/gu, "").replace(/[^\p{L}\p{N}\n]+/gu, " ");
  const baseTokens = normalized.split(/\s+/u).filter(Boolean);
  const tokens = baseTokens.map((token) => /^ال[\p{L}]{3,}$/u.test(token) ? token.slice(2) : token);
  const grams = tokens.flatMap((token) => token.length < 3 ? [] : Array.from({ length: token.length - 2 }, (_, index) => `#${token.slice(index, index + 3)}`));
  return [...tokens, ...grams];
}

function hash(value: string): number {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

/** Local deterministic retrieval for the graduation demo; never selected as a production embedding model. */
export class GraduationDemoEmbeddingProvider implements EmbeddingProvider {
  public readonly modelId = "LOCAL-HASHED-NGRAM-GRADUATION-DEMO";

  public async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = Array<number>(DIMENSIONS).fill(0);
      const [title = "", ...rest] = text.split("\n");
      let tokenCount = 0;
      const add = (token: string, weight: number) => { vector[hash(token) % DIMENSIONS] = (vector[hash(token) % DIMENSIONS] ?? 0) + weight; };
      for (const token of normalizedTokens(title)) { add(token, 20); tokenCount += 1; }
      for (const token of normalizedTokens(rest.join(" "))) { add(token, token.startsWith("#") ? 0.35 : 1); tokenCount += 1; }
      if (tokenCount === 0) vector[0] = 0.0001;
      return vector;
    });
  }
}

class GraduationDemoAgent {
  public constructor(
    private readonly base: NutriGuardExpandedAgent,
    private readonly tools: NutriGuardTools,
  ) {}

  public async invoke(input: { message: string; language?: "ar-EG" | "ar" | "en" }): Promise<ExpandedAgentResponse> {
    const result = await this.base.invoke(input);
    if (result.status !== "unsupported" && result.status !== "no_result") return this.decorate(result);
    if (result.safetyFlags.length > 0 || result.integrityFlags.length > 0) return result;
    const query = input.message.trim();
    const guidelineIntent = /(?:صوديوم|ملح|سكر|دهون|إرشاد|guideline|sodium|salt|sugar|fat)/iu.test(query) && !/(?:كشري|ملوخية|طعمية|koshari|molokhia|ta.?meya)/iu.test(query);
    const search = guidelineIntent
      ? await this.tools.searchGuidelines({ query, limit: 3, minScore: 0.01 })
      : await this.tools.searchRecipes({ query, limit: 3, minScore: 0.01 });
    if (!search.ok || search.data.hits.length === 0) return result;
    const passages = search.data.hits.map((hit) => ({ documentId: hit.document.id, title: hit.document.title, text: hit.document.text.slice(0, 2_500), score: Number(hit.score.toFixed(4)) }));
    const language = input.language ?? "ar-EG";
    return {
      status: "ok", primaryIntent: "general_guidance", language, safetyFlags: [], integrityFlags: [],
      message: language === "en"
        ? "Graduation-demo results from the unreviewed Egyptian dataset. Values are estimates, not medical advice."
        : "دي نتائج تجريبية لمشروع التخرج من قاعدة الأكل المصري غير المراجعة بشريًا. الأرقام تقديرية ومش نصيحة طبية.",
      data: { demoOnly: true, reviewStatus: "needs_review", passages }, evidenceDocumentIds: passages.map((passage) => passage.documentId),
      provenance: search.provenance, toolTrace: [{ tool: guidelineIntent ? "search_guidelines" : "search_recipes", ok: true, code: null }], promptVersion: NUTRIGUARD_SYSTEM_PROMPT_VERSION,
    };
  }

  private decorate(result: ExpandedAgentResponse): ExpandedAgentResponse {
    if (result.status !== "ok") return result;
    const message = result.language === "en"
      ? result.message.replace("Verified sodium is", "Graduation-demo estimated sodium is").replaceAll("approved", "demo")
      : result.message.replace("القيمة المعتمدة للصوديوم هي", "القيمة التقديرية للصوديوم في بيانات مشروع التخرج هي").replaceAll("المعتمدة", "التجريبية");
    return { ...result, message, data: { ...(result.data ?? {}), demoOnly: true, reviewStatus: "needs_review" } };
  }
}

export async function buildGraduationDemoAgent(nodeEnv: "development" | "test"): Promise<GraduationDemoAgent> {
  if (nodeEnv !== "development" && nodeEnv !== "test") throw new Error("graduation demo agent is forbidden outside development/test");
  const dataset = await loadUnifiedEgyptianDemoDataset();
  const recipes = new Map(dataset.recipes.map((recipe) => [recipe.recipe_id, recipe]));
  const embeddingProvider = new GraduationDemoEmbeddingProvider();
  const vectorStore = new InMemoryVectorStore();
  await ingestRetrievalCorpus(buildGraduationRetrievalCorpus(dataset), embeddingProvider, vectorStore);
  const tools = new NutriGuardTools({
    embeddingProvider, vectorStore, corpusId: GRADUATION_DEMO_CORPUS_ID,
    calculateNutrition: async (recipeId) => {
      const recipe = recipes.get(recipeId);
      if (!recipe) throw new Error(`graduation demo recipe not found: ${recipeId}`);
      return toRecipeNutritionResult(dataset, recipe);
    },
    guidelineRules: new InMemoryGuidelineRuleRepository([]),
  });
  return new GraduationDemoAgent(new NutriGuardExpandedAgent(tools, new InMemoryAlternativeRuleRepository([])), tools);
}
