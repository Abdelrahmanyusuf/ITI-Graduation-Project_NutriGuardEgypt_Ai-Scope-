/**
 * NutriGuard Step 4 — real PostgreSQL schema verification.
 *
 * Replaces the previous DB-less substring validator. These checks connect to a
 * live database and verify the ACTUAL catalog (tables, columns, constraints,
 * indexes, foreign keys) instead of matching fragments of SQL text. They are
 * used by `npm run db:validate` and by the database integration tests.
 *
 * Everything here is read-only: it never creates, drops, or mutates anything.
 */

import { Pool } from "pg";

import {
  FOOD_STATE_PAIR_TABLES,
  FOOD_STATES,
  FOOD_STATE_TABLES,
  GUIDELINE_RULE_COLUMNS,
  NUMERIC_CHECKS,
  ORIGINAL_PRESERVING_TABLES,
  PROVENANCE_BEARING_TABLES,
  PROVENANCE_COLUMNS,
  REQUIRED_TABLES,
  REVIEW_TARGET_COLUMNS,
} from "./schema.js";

async function allColumns(pool: Pool): Promise<Map<string, Set<string>>> {
  const res = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
      ORDER BY table_name, ordinal_position`
  );
  const map = new Map<string, Set<string>>();
  for (const r of res.rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, new Set());
    map.get(r.table_name)!.add(r.column_name);
  }
  return map;
}

async function allTables(pool: Pool): Promise<Set<string>> {
  const res = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`
  );
  return new Set(res.rows.map((r) => r.table_name));
}

async function constraintDefs(pool: Pool): Promise<Map<string, string[]>> {
  const res = await pool.query<{ table_name: string; condef: string }>(
    `SELECT c.relname AS table_name, pg_get_constraintdef(con.oid) AS condef
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
      ORDER BY c.relname, con.oid`
  );
  const map = new Map<string, string[]>();
  for (const r of res.rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, []);
    map.get(r.table_name)!.push(r.condef);
  }
  return map;
}

async function indexDefs(pool: Pool): Promise<Map<string, string[]>> {
  const res = await pool.query<{ table_name: string; indexdef: string }>(
    `SELECT tablename AS table_name, indexdef
       FROM pg_indexes
      WHERE schemaname = current_schema()
      ORDER BY tablename, indexname`
  );
  const map = new Map<string, string[]>();
  for (const r of res.rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, []);
    map.get(r.table_name)!.push(r.indexdef);
  }
  return map;
}

/**
 * Normalize a constraint expression so that equivalent forms written
 * differently by Postgres (type casts, nested parentheses, whitespace,
 * `::numeric` on literals) compare equal. Lowercases, strips casts and
 * parentheses, and collapses all whitespace.
 */
function normExpr(s: string): string {
  return s
    .toLowerCase()
    .replace(/::(bigint|int|integer|numeric|text|jsonb|boolean|date|timestamp[^ ,)]*)/g, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/**
 * Lightweight normalizer for index definitions: lowercases, strips casts and
 * collapses whitespace but KEEPS parentheses so expression-bearing index
 * columns (e.g. COALESCE(food_state, '')) stay recognizable.
 */
function normIndexExpr(s: string): string {
  return s
    .toLowerCase()
    .replace(/::(bigint|int|integer|numeric|text|jsonb|boolean|date|timestamp[^ ,)]*)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Verify the live database's schema against the canonical constants in
 * schema.ts. Returns a list of human-readable problems; an empty array means
 * the live catalog fully matches the contract.
 */
export async function verifyDatabaseSchema(pool: Pool): Promise<string[]> {
  const problems: string[] = [];
  const tables = await allTables(pool);
  const columns = await allColumns(pool);
  const constraints = await constraintDefs(pool);
  const indexes = await indexDefs(pool);

  for (const t of REQUIRED_TABLES) {
    if (!tables.has(t)) problems.push(`missing table: ${t}`);
  }

  for (const t of PROVENANCE_BEARING_TABLES) {
    const cols = columns.get(t) ?? new Set<string>();
    for (const c of PROVENANCE_COLUMNS) {
      if (!cols.has(c)) problems.push(`table ${t} is missing provenance column: ${c}`);
    }
    // Version must be pinned to the row's own source via a composite FK that
    // also uses MATCH FULL so a partially-null provenance pair is rejected.
    const fks = constraints.get(t) ?? [];
    const pinned = fks.some(
      (d) =>
        normExpr(d).includes("foreignkeysource_id,data_version_id") &&
        normExpr(d).includes("data_versions") &&
        normExpr(d).includes("matchfull")
    );
    if (!pinned) {
      problems.push(
        `table ${t} lacks MATCH FULL composite FK (source_id, data_version_id) -> data_versions (source_id, id)`
      );
    }
    // Either both provenance columns are NULL or both are non-NULL. This is the
    // explicit pair-nullability guard (belt-and-braces next to MATCH FULL).
    const pairOk = (constraints.get(t) ?? []).some((d) => {
      const n = normExpr(d);
      return (
        n.includes("source_idisnullanddata_version_idisnull") &&
        n.includes("source_idisnotnullanddata_version_idisnotnull")
      );
    });
    if (!pairOk) {
      problems.push(
        `table ${t} lacks the source_id/data_version_id pair-nullability CHECK`
      );
    }
  }

  for (const t of FOOD_STATE_TABLES) {
    const cols = columns.get(t) ?? new Set<string>();
    if (!cols.has("food_state")) problems.push(`table ${t} is missing the food_state column`);
  }
  for (const t of FOOD_STATE_PAIR_TABLES) {
    const cols = columns.get(t) ?? new Set<string>();
    for (const c of ["food_state_from", "food_state_to"]) {
      if (!cols.has(c)) problems.push(`table ${t} is missing the ${c} column`);
    }
  }

  // Every food-state-constrained table must keep ONLY the supported states.
  const foodStateTables = [...FOOD_STATE_TABLES, ...FOOD_STATE_PAIR_TABLES];
  for (const t of foodStateTables) {
    const cdefs = constraints.get(t) ?? [];
    const constrained = cdefs.some((d) => {
      const n = normExpr(d);
      return n.includes("=anyarray[") && FOOD_STATES.every((s) => n.includes(`'${s}'`));
    });
    if (!constrained) {
      problems.push(`table ${t} has no food-state CHECK constraint`);
    }
  }

  const rulesCols = columns.get("guideline_rules") ?? new Set<string>();
  for (const col of GUIDELINE_RULE_COLUMNS) {
    if (!rulesCols.has(col)) problems.push(`guideline_rules is missing column: ${col}`);
  }

  // A guideline rule's chunk must belong to the rule's OWN document: the
  // composite FK (document_id, chunk_id) -> guideline_chunks (document_id, id)
  // rejects cross-document references.
  const ruleDefs = constraints.get("guideline_rules") ?? [];
  const chunkDocFk = ruleDefs.some(
    (d) =>
      normExpr(d).includes("foreignkeydocument_id,chunk_idreferences") &&
      normExpr(d).includes("guideline_chunksdocument_id,id")
  );
  if (!chunkDocFk) {
    problems.push(
      "guideline_rules lacks composite FK (document_id, chunk_id) -> guideline_chunks (document_id, id) for same-document chunks"
    );
  }

  for (const [table, cols] of Object.entries(ORIGINAL_PRESERVING_TABLES)) {
    const present = columns.get(table) ?? new Set<string>();
    for (const c of cols) {
      if (!present.has(c)) {
        problems.push(`table ${table} is missing original-preserving column: ${c}`);
      }
    }
  }

  // Numeric CHECKs (real measured zero allowed where `>= 0`; NULL always ok).
  for (const { table, expression } of NUMERIC_CHECKS) {
    if (!tables.has(table)) continue; // missing table already reported
    const cdefs = constraints.get(table) ?? [];
    const expr = normExpr(expression);
    const hit = cdefs.some((d) => normExpr(d).includes(expr));
    if (!hit) problems.push(`table ${table} lacks CHECK: ${expression}`);
  }

  // Nullable-food_state uniqueness must be an expression index (COALESCE).
  const nullableStateUniques: Array<{ table: string; fragment: string }> = [
    { table: "ingredients", fragment: "coalesce(food_state," },
    { table: "nutrient_values", fragment: "coalesce(food_state," },
    { table: "ingredient_unit_conversions", fragment: "coalesce(food_state," },
  ];
  for (const { table, fragment } of nullableStateUniques) {
    const idefs = indexes.get(table) ?? [];
    const hit = idefs.some((d) => normIndexExpr(d).includes(fragment));
    if (!hit) problems.push(`table ${table} lacks a COALESCE-unique index covering nullable food_state`);
  }

  // typed, enforceable review targets (exactly-one CHECK + one FK per target).
  const reviewCols = columns.get("review_records") ?? new Set<string>();
  for (const c of REVIEW_TARGET_COLUMNS) {
    if (!reviewCols.has(c)) problems.push(`review_records is missing target column: ${c}`);
  }
  const reviewDefs = constraints.get("review_records") ?? [];
  const exactlyOne = reviewDefs.some((d) => normExpr(d).includes("=1"));
  if (!exactlyOne) {
    problems.push("review_records lacks the exactly-one-target CHECK constraint");
  }
  for (const c of REVIEW_TARGET_COLUMNS) {
    // normExpr strips parens, so a FK on a single column renders like
    // "foreignkeyingredient_idreferencesingredients…".
    const fk = reviewDefs.some(
      (d) => normExpr(d).startsWith("foreignkey") && normExpr(d).includes(`foreignkey${c}references`)
    );
    if (!fk) problems.push(`review_records.${c} lacks a FOREIGN KEY to its target table`);
  }

  return problems;
}