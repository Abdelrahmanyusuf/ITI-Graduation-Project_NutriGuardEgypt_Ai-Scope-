import { randomUUID } from "node:crypto";
import type { DashboardMealCategory } from "./dashboard-client.js";

/**
 * Explicit, specified TTL for a shown-but-not-yet-confirmed meal selection.
 *
 * This is a specified default from the Step 16 v3 correction, not a value left to
 * the implementer's discretion: a pending operation expires exactly 600 seconds
 * (10 minutes) after the confirmation summary was shown. A confirmation arriving
 * after this window must be answered with `confirmation_expired`.
 */
export const PENDING_MEAL_CONFIRMATION_TTL_SECONDS = 600;

/**
 * Upper bound on how many pending operations the in-memory table keeps.
 *
 * Purely a memory guard for the mock stage. Oldest entries are evicted first, and
 * eviction is equivalent to expiry from the caller's point of view: the next
 * confirmation against an evicted id returns `confirmation_expired`.
 */
export const PENDING_MEAL_OPERATION_CAPACITY = 200;

/** A frozen nutrition snapshot, exactly as it was shown to the user. */
export interface FrozenMealNutrition {
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** Present only when the user asked about sodium; never invented. */
  sodiumMg: number | null;
}

/** One frozen recipe inside a frozen selection. */
export interface FrozenMealRecipe {
  recipeId: string;
  name: string;
  nutrition: FrozenMealNutrition;
}

/**
 * One frozen selection: a category plus the option the user picked.
 *
 * `recipes` normally holds exactly one recipe. It holds two only for the snacks
 * category, when the user explicitly picked an offered two-item snack set.
 */
export interface FrozenMealSelection {
  mealCategory: DashboardMealCategory;
  optionIndex: number;
  recipes: readonly FrozenMealRecipe[];
  subtotalCaloriesKcal: number;
}

export type PendingMealOperationStatus = "active" | "expired" | "invalidated" | "resolved";

/** The immutable record created at the moment the summary was displayed. */
export interface PendingMealOperation {
  pendingOperationId: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: PendingMealOperationStatus;
  selections: readonly FrozenMealSelection[];
  totalCaloriesKcal: number;
  ceilingMode: "total" | "per_meal" | "none";
  ceilingKcal: number | null;
  language: "ar-EG" | "ar" | "en";
}

export interface CreatePendingMealOperationInput {
  selections: readonly FrozenMealSelection[];
  totalCaloriesKcal: number;
  ceilingMode: "total" | "per_meal" | "none";
  ceilingKcal: number | null;
  language: "ar-EG" | "ar" | "en";
}

export interface PendingMealOperationStore {
  create(input: CreatePendingMealOperationInput): PendingMealOperation;
  /** Effective state now, applying the TTL. Never mutates. */
  peek(pendingOperationId: string | null | undefined): PendingMealOperation | null;
  /** Mark an operation resolved so a later confirmation cannot re-run it. */
  resolve(pendingOperationId: string): void;
  /** Invalidate an operation because a selection changed after the summary. */
  invalidate(pendingOperationId: string | null | undefined): void;
}

export interface InMemoryPendingMealOperationStoreOptions {
  now?: () => number;
  newId?: () => string;
  ttlSeconds?: number;
  capacity?: number;
}

/**
 * Server-side, in-memory pending-operation table.
 *
 * WHY SERVER-SIDE: the confirmation summary's numbers and the payload eventually
 * sent to the dashboard must be the same bytes the user saw. Freezing them here,
 * keyed by `pending_operation_id`, means `confirm_and_log_meal_selection` reads
 * them from this table and never from anything supplied at confirmation time.
 * That removes the TOCTOU hole the Step 16 v3 correction identified in the older
 * `confirm_and_log_meal_selection(selections[])` signature.
 *
 * IN-MEMORY LIMITATION, STATED RATHER THAN ASSUMED AWAY: this table lives in
 * process memory. Correct retry and expiry behaviour is therefore guaranteed only
 * within the same running process. A crash or restart between showing the summary
 * and a later confirmation or retry loses the table; the guarantee does NOT hold
 * across that boundary, and a confirmation arriving afterwards is answered with
 * `confirmation_expired`. This is not crash-safe across restarts. Persisting the
 * table durably is deliberately out of scope for this step.
 */
export class InMemoryPendingMealOperationStore implements PendingMealOperationStore {
  private readonly operations = new Map<string, PendingMealOperation>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly ttlMs: number;
  private readonly capacity: number;

  public constructor(options: InMemoryPendingMealOperationStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => randomUUID());
    this.ttlMs = Math.max(1, Math.round((options.ttlSeconds ?? PENDING_MEAL_CONFIRMATION_TTL_SECONDS) * 1_000));
    this.capacity = Math.max(1, Math.round(options.capacity ?? PENDING_MEAL_OPERATION_CAPACITY));
  }

  public create(input: CreatePendingMealOperationInput): PendingMealOperation {
    const createdAtMs = this.now();
    const operation: PendingMealOperation = {
      pendingOperationId: this.newId(),
      createdAtMs,
      expiresAtMs: createdAtMs + this.ttlMs,
      status: "active",
      // Deep-frozen copies: nothing outside this store can mutate what was shown.
      selections: input.selections.map((selection) => Object.freeze({
        mealCategory: selection.mealCategory,
        optionIndex: selection.optionIndex,
        subtotalCaloriesKcal: selection.subtotalCaloriesKcal,
        recipes: Object.freeze(selection.recipes.map((recipe) => Object.freeze({
          recipeId: recipe.recipeId,
          name: recipe.name,
          nutrition: Object.freeze({ ...recipe.nutrition }),
        }))),
      })),
      totalCaloriesKcal: input.totalCaloriesKcal,
      ceilingMode: input.ceilingMode,
      ceilingKcal: input.ceilingKcal,
      language: input.language,
    };
    this.prune();
    this.operations.set(operation.pendingOperationId, Object.freeze(operation));
    return operation;
  }

  public peek(pendingOperationId: string | null | undefined): PendingMealOperation | null {
    if (!pendingOperationId) return null;
    const operation = this.operations.get(pendingOperationId);
    if (!operation) return null;
    if (operation.status === "active" && this.now() > operation.expiresAtMs) {
      return { ...operation, status: "expired" };
    }
    return operation;
  }

  public resolve(pendingOperationId: string): void {
    const operation = this.operations.get(pendingOperationId);
    if (!operation) return;
    this.operations.set(pendingOperationId, Object.freeze({ ...operation, status: "resolved" }));
  }

  public invalidate(pendingOperationId: string | null | undefined): void {
    if (!pendingOperationId) return;
    const operation = this.operations.get(pendingOperationId);
    if (!operation || operation.status !== "active") return;
    this.operations.set(pendingOperationId, Object.freeze({ ...operation, status: "invalidated" }));
  }

  private prune(): void {
    const now = this.now();
    for (const [id, operation] of this.operations) {
      // Expired entries are dropped a full TTL after expiry, so a confirmation
      // arriving slightly late still gets an explicit `confirmation_expired`
      // instead of an "unknown id" that looks identical to a typo.
      if (now > operation.expiresAtMs + this.ttlMs) this.operations.delete(id);
    }
    while (this.operations.size >= this.capacity) {
      const oldest = this.operations.keys().next();
      if (oldest.done) break;
      this.operations.delete(oldest.value);
    }
  }
}
