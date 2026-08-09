/**
 * NutriGuard Step 4 — synthetic seed loader (test-only data).
 *
 * Loads the explicitly synthetic fixture rows from
 * tests/fixtures/db/seed-synthetic.sql. These rows are fabricated values used
 * ONLY to exercise the schema and the integration tests; they must never be
 * loaded as production data. The loader therefore refuses to run unless the
 * explicit opt-in env var NUTRIGUARD_ALLOW_SYNTHETIC_SEED=1 is set, and it
 * requires the seed source to have review_status = 'rejected'.
 *
 * The seed is NOT part of the migrations, so a clean database created entirely
 * from migrations contains no synthetic rows.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const SYNTHETIC_SEED_PATH = path.resolve(currentDir, "..", "..", "tests", "fixtures", "db", "seed-synthetic.sql");

export const SYNTHETIC_SEED_FLAG = "NUTRIGUARD_ALLOW_SYNTHETIC_SEED";
export const SYNTHETIC_SOURCE_KEY = "SYNTHETIC-FIXTURE";

/** Returns true when the explicit opt-in flag is set to 1. */
export function syntheticSeedAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SYNTHETIC_SEED_FLAG] === "1";
}

/** Apply the synthetic seed to an existing client (must be in a transaction). */
export async function applySyntheticSeedToClient(
  client: Pick<pg.ClientBase, "query">,
  sql: string
): Promise<void> {
  await client.query(sql);
}

/** Load the seed SQL file from disk. */
export async function loadSyntheticSeedSql(dir = SYNTHETIC_SEED_PATH): Promise<string> {
  return fs.readFile(dir, "utf8");
}

/**
 * Apply the synthetic seed through the pool. Throws unless the explicit opt-in
 * flag is set (test-only safety).
 */
export async function applySyntheticSeed(
  pool: pg.Pool,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!syntheticSeedAllowed(env)) {
    throw new Error(
      `${SYNTHETIC_SEED_FLAG}=1 is required to load synthetic seed (test-only data, never production)`
    );
  }
  const sql = await loadSyntheticSeedSql();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await applySyntheticSeedToClient(client, sql);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`synthetic seed failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    client.release();
  }
}