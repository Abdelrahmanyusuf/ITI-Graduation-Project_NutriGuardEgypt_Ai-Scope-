import type {
  CalculateNutritionToolInput,
  CompareWithGuidelineInput,
  GuidelineComparison,
  NutriGuardToolset,
  SearchToolInput,
  SearchToolOutput,
  ToolResult,
} from "../tools/nutriguard-tools.js";
import type { RecipeNutritionResult } from "../domain/nutrition.js";

export interface HybridRetrievalOptions {
  timeoutMs: number;
  circuitBreakerMs: number;
  now?: () => number;
}

export interface HybridRetrievalState {
  mode: "remote_available" | "local_fallback";
  circuitOpenUntil: number | null;
  lastFailure: "timeout" | "remote_error" | null;
}

type SearchOperation = (input: SearchToolInput) => Promise<ToolResult<SearchToolOutput>>;

/**
 * Remote-first retrieval with a deterministic local safety net. Nutrition and
 * guideline arithmetic always remain local/deterministic; only document search
 * is eligible for the remote path.
 */
export class HybridRetrievalTools implements NutriGuardToolset {
  private circuitOpenUntil = 0;
  private lastFailure: HybridRetrievalState["lastFailure"] = null;
  private readonly now: () => number;

  public constructor(
    private readonly remote: NutriGuardToolset,
    private readonly local: NutriGuardToolset,
    private readonly options: HybridRetrievalOptions,
  ) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("hybrid timeoutMs must be positive");
    if (!Number.isFinite(options.circuitBreakerMs) || options.circuitBreakerMs < 0) throw new Error("hybrid circuitBreakerMs must be non-negative");
    this.now = options.now ?? Date.now;
  }

  public state(): HybridRetrievalState {
    const open = this.now() < this.circuitOpenUntil;
    return {
      mode: open ? "local_fallback" : "remote_available",
      circuitOpenUntil: open ? this.circuitOpenUntil : null,
      lastFailure: this.lastFailure,
    };
  }

  private async withTimeout(operation: SearchOperation, input: SearchToolInput): Promise<ToolResult<SearchToolOutput>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(input),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("hybrid remote retrieval timed out")), this.options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async search(remoteOperation: SearchOperation, localOperation: SearchOperation, input: SearchToolInput): Promise<ToolResult<SearchToolOutput>> {
    if (this.now() >= this.circuitOpenUntil) {
      try {
        const result = await this.withTimeout(remoteOperation, input);
        if (result.ok) {
          this.lastFailure = null;
          if (result.data.hits.length > 0) return result;
        } else {
          this.lastFailure = "remote_error";
          this.circuitOpenUntil = this.now() + this.options.circuitBreakerMs;
        }
      } catch {
        this.lastFailure = "timeout";
        this.circuitOpenUntil = this.now() + this.options.circuitBreakerMs;
      }
    }
    return localOperation(input);
  }

  public searchRecipes(input: SearchToolInput): Promise<ToolResult<SearchToolOutput>> {
    return this.search(
      (value) => this.remote.searchRecipes(value),
      (value) => this.local.searchRecipes(value),
      input,
    );
  }

  public searchGuidelines(input: SearchToolInput): Promise<ToolResult<SearchToolOutput>> {
    return this.search(
      (value) => this.remote.searchGuidelines(value),
      (value) => this.local.searchGuidelines(value),
      input,
    );
  }

  public calculateNutrition(input: CalculateNutritionToolInput): Promise<ToolResult<RecipeNutritionResult>> {
    return this.local.calculateNutrition(input);
  }

  public compareWithGuideline(input: CompareWithGuidelineInput): Promise<ToolResult<GuidelineComparison>> {
    return this.local.compareWithGuideline(input);
  }
}
