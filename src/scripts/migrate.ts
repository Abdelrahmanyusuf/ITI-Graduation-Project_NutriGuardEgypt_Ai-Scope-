/**
 * NutriGuard Step 4 — migration CLI.
 *
 * Usage: node --import tsx src/scripts/migrate.ts [up|down|status|validate]
 *
 * Requires a live PostgreSQL reachable via DATABASE_URL (or PG* env vars).
 * `validate` verifies the REAL database catalog against the canonical schema
 * contract (source/version pinning, food-state constraints, original-value
 * preservation, typed review FKs, nullable-food_state uniqueness). Exits
 * non-zero on failure so CI can gate on it. There is no DB-less SQL
 * substring validator: schema verification is always against a live database.
 */

import {
  createPool,
  getAppliedMigrations,
  migrateDown,
  migrateUp,
  pingDb,
} from "../data/database.js";
import { verifyDatabaseSchema } from "../data/schemaVerify.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "up";

  const pool = createPool();
  try {
    await pingDb(pool);
  } catch (err) {
    console.error(
      `cannot reach PostgreSQL (DATABASE_URL not set or server unreachable): ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(2);
    return;
  }

  try {
    if (command === "validate") {
      const problems = await verifyDatabaseSchema(pool);
      for (const p of problems) console.error(`schema problem: ${p}`);
      console.log(
        problems.length === 0
          ? "migration schema: valid (real PostgreSQL catalog checks passed)"
          : "migration schema: INVALID (problems above)"
      );
      process.exit(problems.length === 0 ? 0 : 1);
      return;
    }

    if (command === "up") {
      const applied = await migrateUp(pool);
      console.log(applied.length === 0 ? "migrations: up to date" : `migrations: applied ${applied.join(", ")}`);
    } else if (command === "down") {
      const rolled = await migrateDown(pool);
      console.log(rolled.length === 0 ? "migrations: nothing to roll back" : `migrations: rolled back ${rolled.join(", ")}`);
    } else if (command === "status") {
      const applied = await getAppliedMigrations(pool);
      console.log(applied.length === 0 ? "migrations: none applied" : `migrations: ${applied.map((m) => m.version).join(", ")}`);
    } else {
      console.error(`unknown command "${command}" (expected up|down|status|validate)`);
      process.exit(2);
    }
  } finally {
    await pool.end();
  }
}

await main();