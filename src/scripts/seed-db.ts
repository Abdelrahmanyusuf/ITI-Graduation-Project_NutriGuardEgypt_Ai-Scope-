/**
 * NutriGuard Step 4 — synthetic seed CLI (TEST-ONLY).
 *
 * Usage: node --import tsx src/scripts/seed-db.ts
 *
 * Applies the synthetic fixture rows to a live database. Requires:
 *   - a live PostgreSQL via DATABASE_URL, and
 *   - NUTRIGUARD_ALLOW_SYNTHETIC_SEED=1 (explicit test-only opt-in).
 *
 * This script must NEVER be used to load real, user-facing data. Exit codes:
 *   0 success; 1 seed/connect/fixture failure; 2 flag not set (safety refusal).
 */

import { createPool, pingDb } from "../data/database.js";
import {
  SYNTHETIC_SEED_FLAG,
  applySyntheticSeed,
  syntheticSeedAllowed,
} from "../data/seed.js";

async function main(): Promise<void> {
  if (!syntheticSeedAllowed()) {
    console.error(`${SYNTHETIC_SEED_FLAG}=1 is required (synthetic seed is test-only data; refusing)`);
    process.exit(2);
    return;
  }
  const pool = createPool();
  try {
    await pingDb(pool);
  } catch (err) {
    console.error(`cannot reach PostgreSQL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }
  try {
    await applySyntheticSeed(pool);
    console.log("synthetic seed applied (test-only data).");
  } catch (err) {
    console.error(`synthetic seed failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

await main();