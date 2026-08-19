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

/**
 * Per-search observability event (Step 17b, Part C1).
 *
 * Reports which retrieval path actually served one search so the debug panel
 * can state whether remote embeddings and the vector store were used or the
 * deterministic local corpus answered instead. Structural data only — no query
 * text and no document content.
 */
export interface HybridRetrievalEvent {
  operation: "search_recipes" | "search_guidelines";
  /** True when the remote toolset (external embeddings + vector store) ran. */
  remoteAttempted: boolean;
  /** True when the remote path returned at least one usable hit. */
  remoteReturnedResult: boolean;
  remoteFailure: "timeout" | "remote_error" | null;
  /** True when the deterministic local corpus produced the served result. */
  localFallbackUsed: boolean;
  remoteLatencyMs: number | null;
  localLatencyMs: number | null;
}

export interface HybridRetrievalOptions {
  timeoutMs: number;
  circuitBreakerMs: number;
  now?: () => number;
  /** Optional observer. Never affects retrieval behaviour or results. */
  observer?: (event: HybridRetrievalEvent) => void;
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

  private async search(
    remoteOperation: SearchOperation,
    localOperation: SearchOperation,
    input: SearchToolInput,
    operation: HybridRetrievalEvent["operation"],
  ): Promise<ToolResult<SearchToolOutput>> {
    const event: HybridRetrievalEvent = {
      operation,
      remoteAttempted: false,
      remoteReturnedResult: false,
      remoteFailure: null,
      localFallbackUsed: false,
      remoteLatencyMs: null,
      localLatencyMs: null,
    };
    const emit = (): void => {
      if (this.options.observer) this.options.observer(event);
    };
    if (this.now() >= this.circuitOpenUntil) {
      event.remoteAttempted = true;
      const startedAt = performance.now();
      try {
        const result = await this.withTimeout(remoteOperation, input);
        event.remoteLatencyMs = Math.round(performance.now() - startedAt);
        if (result.ok) {
          this.lastFailure = null;
          if (result.data.hits.length > 0) {
            event.remoteReturnedResult = true;
            emit();
            return result;
          }
        } else {
          this.lastFailure = "remote_error";
          event.remoteFailure = "remote_error";
          this.circuitOpenUntil = this.now() + this.options.circuitBreakerMs;
        }
      } catch {
        event.remoteLatencyMs = Math.round(performance.now() - startedAt);
        this.lastFailure = "timeout";
        event.remoteFailure = "timeout";
        this.circuitOpenUntil = this.now() + this.options.circuitBreakerMs;
      }
    }
    event.localFallbackUsed = true;
    const localStartedAt = performance.now();
    try {
      return await localOperation(input);
    } finally {
      event.localLatencyMs = Math.round(performance.now() - localStartedAt);
      emit();
    }
  }

  public searchRecipes(input: SearchToolInput): Promise<ToolResult<SearchToolOutput>> {
    return this.search(
      (value) => this.remote.searchRecipes(value),
      (value) => this.local.searchRecipes(value),
      input,
      "search_recipes",
    );
  }

  public searchGuidelines(input: SearchToolInput): Promise<ToolResult<SearchToolOutput>> {
    return this.search(
      (value) => this.remote.searchGuidelines(value),
      (value) => this.local.searchGuidelines(value),
      input,
      "search_guidelines",
    );
  }

  public calculateNutrition(input: CalculateNutritionToolInput): Promise<ToolResult<RecipeNutritionResult>> {
    return this.local.calculateNutrition(input);
  }

  public compareWithGuideline(input: CompareWithGuidelineInput): Promise<ToolResult<GuidelineComparison>> {
    return this.local.compareWithGuideline(input);
  }
}
