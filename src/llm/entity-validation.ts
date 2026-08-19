/**
 * Part A5 — independent validation of Claude-extracted entities.
 *
 * A string Claude produced is inert until it resolves against real data by
 * exactly the same path a user-typed string would take. Two resolvers run:
 *
 *   1. the agent's own live path (`explicitlyNamedRecipes` for dishes and the
 *      demo `INGREDIENT_ALIASES` table for ingredients) — this is the path
 *      that actually governs downstream calculation, so it is authoritative;
 *   2. the Step 2 dictionary resolver `resolveIngredient` — an additional,
 *      stricter cross-check recorded for observability.
 *
 * The two dictionaries are not identical, so a value can resolve on the agent
 * path and fail the Step 2 path. Both results are reported. Nothing here
 * writes to a database, triggers an action, or feeds a calculation: callers
 * receive resolved identifiers and decide, and in Step 17b no caller uses them
 * for routing at all.
 */

import { buildIndex, parseIngredientDictionary, resolveIngredient, type DictionaryIndex } from "../domain/ingredients.js";
import type { ClaudeClassification } from "./claude-classifier.js";

export type EntityKind = "recipe_or_ingredient_name" | "exclusion" | "comparison_target";

export interface EntityResolutionRecord {
  kind: EntityKind;
  /** Verbatim string Claude produced. Never used downstream unresolved. */
  candidate: string;
  /** Agent-path resolution: the identifier the pipeline would actually use. */
  agentPathResolved: boolean;
  agentPathRecipeId: string | null;
  agentPathIngredientKey: string | null;
  /** Step 2 dictionary cross-check. */
  dictionaryStatus: "resolved" | "ambiguous" | "unresolved" | "not_checked";
  dictionaryKey: string | null;
  /** True only when the agent path resolved; gates any downstream use. */
  accepted: boolean;
  rejectionReason: string | null;
}

export interface EntityValidationReport {
  records: EntityResolutionRecord[];
  acceptedCount: number;
  rejectedCount: number;
}

/**
 * Resolution hooks supplied by the agent so this module stays free of any
 * dependency on the demo dataset's internals.
 */
export interface AgentEntityResolvers {
  /** Resolve a dish name exactly as a user-typed name resolves. */
  resolveRecipeId(name: string): string | null;
  /** Resolve an ingredient name against the agent's alias table. */
  resolveIngredientKey(name: string): string | null;
}

let cachedIndex: DictionaryIndex | null = null;
let dictionaryLoadFailed = false;

/**
 * Lazily build the Step 2 dictionary index. A failure here degrades the
 * cross-check to `not_checked`; it never blocks validation, because the
 * authoritative decision comes from the agent path.
 */
async function dictionaryIndex(): Promise<DictionaryIndex | null> {
  if (cachedIndex) return cachedIndex;
  if (dictionaryLoadFailed) return null;
  try {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = path.resolve(here, "..", "..", "data", "dictionary", "ingredients.json");
    const parsed = parseIngredientDictionary(JSON.parse(await readFile(file, "utf8")) as unknown);
    cachedIndex = buildIndex(parsed.entries);
    return cachedIndex;
  } catch {
    dictionaryLoadFailed = true;
    return null;
  }
}

async function crossCheckDictionary(candidate: string): Promise<{ status: EntityResolutionRecord["dictionaryStatus"]; key: string | null }> {
  const index = await dictionaryIndex();
  if (!index) return { status: "not_checked", key: null };
  try {
    const resolution = resolveIngredient(candidate, { index });
    return { status: resolution.status, key: resolution.canonicalKey };
  } catch {
    return { status: "not_checked", key: null };
  }
}

async function validateOne(kind: EntityKind, candidate: string, resolvers: AgentEntityResolvers): Promise<EntityResolutionRecord> {
  const trimmed = candidate.trim();
  const recipeId = trimmed ? resolvers.resolveRecipeId(trimmed) : null;
  const ingredientKey = trimmed ? resolvers.resolveIngredientKey(trimmed) : null;
  const dictionary = trimmed ? await crossCheckDictionary(trimmed) : { status: "not_checked" as const, key: null };
  const agentPathResolved = recipeId !== null || ingredientKey !== null;
  return {
    kind,
    candidate: trimmed,
    agentPathResolved,
    agentPathRecipeId: recipeId,
    agentPathIngredientKey: ingredientKey,
    dictionaryStatus: dictionary.status,
    dictionaryKey: dictionary.key,
    accepted: agentPathResolved,
    rejectionReason: agentPathResolved ? null : "did_not_resolve_to_a_known_recipe_or_ingredient",
  };
}

/**
 * Validate every entity string in a Claude classification.
 *
 * Returns a report only. It is the caller's responsibility never to use a
 * record whose `accepted` flag is false — and in Step 17b no Claude entity
 * reaches a calculation, filter or write at all.
 */
export async function validateClaudeEntities(
  classification: ClaudeClassification,
  resolvers: AgentEntityResolvers,
): Promise<EntityValidationReport> {
  const candidates: Array<{ kind: EntityKind; value: string }> = [];
  if (classification.entities.recipe_or_ingredient_name) {
    candidates.push({ kind: "recipe_or_ingredient_name", value: classification.entities.recipe_or_ingredient_name });
  }
  for (const exclusion of classification.entities.exclusions) candidates.push({ kind: "exclusion", value: exclusion });
  for (const target of classification.entities.comparison_targets) candidates.push({ kind: "comparison_target", value: target });

  const records: EntityResolutionRecord[] = [];
  for (const candidate of candidates) records.push(await validateOne(candidate.kind, candidate.value, resolvers));
  return {
    records,
    acceptedCount: records.filter((record) => record.accepted).length,
    rejectedCount: records.filter((record) => !record.accepted).length,
  };
}

/** Reset the cached dictionary index. Test-only helper. */
export function resetEntityValidationCache(): void {
  cachedIndex = null;
  dictionaryLoadFailed = false;
}
