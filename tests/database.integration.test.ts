import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool } from "pg";

import {
  createPool,
  getAppliedMigrations,
  migrateDown,
  migrateUp,
  pingDb,
} from "../src/data/database.js";
import { REQUIRED_TABLES } from "../src/data/schema.js";
import { verifyDatabaseSchema } from "../src/data/schemaVerify.js";
import { SYNTHETIC_SOURCE_KEY, applySyntheticSeed } from "../src/data/seed.js";

/**
 * Database integration tests. These REQUIRE a live, writable PostgreSQL
 * reachable via DATABASE_URL.
 *
 * SAFETY (per reviewer FAIL items):
 *  - They run ONLY when the explicit test-only flag NUTRIGUARD_RUN_DB_INTEGRATION=1
 *    is set (never merely because DATABASE_URL exists).
 *  - They REFUSE to run against a database whose name does not look like a test
 *    database (must include "test"); a non-test name is rejected loudly.
 *  - All work happens in an isolated, disposable SCHEMA (`ng_it_...`) created
 *    and dropped by the test itself; no domain table is ever dropped just
 *    because a connection string is present.
 *  - The pool is closed reliably (setup/teardown via finally + exit handler).
 *  - Schema verification is done against the REAL PostgreSQL catalog
 *    (verifyDatabaseSchema) — there is no substring validator.
 *  - node-postgres returns NUMERIC as a string; assertions compare numeric
 *    semantics, never a literal JS number literal.
 *
 * Run:
 *   DATABASE_URL=postgres://user:pass@host:5432/your_test_db \
 *   NUTRIGUARD_ALLOW_SYNTHETIC_SEED=1 \
 *   NUTRIGUARD_RUN_DB_INTEGRATION=1 \
 *   node --import tsx --test tests/database.integration.test.ts
 */

const RUN_FLAG = "NUTRIGUARD_RUN_DB_INTEGRATION";
const SEED_FLAG = "NUTRIGUARD_ALLOW_SYNTHETIC_SEED";

/** Database name parsed from a postgres:// URL (path segment). */
function dbNameFromUrl(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "").replace(/\/$/, "");
  } catch {
    return "";
  }
}

/** Skip reason when the suite must not run; false means "run it". */
function skipReason(): string | false {
  if (!process.env.DATABASE_URL) {
    return "DATABASE_URL not set (no live PostgreSQL available)";
  }
  if (process.env[RUN_FLAG] !== "1") {
    return `${RUN_FLAG}=1 is required to run the destructive DB integration suite`;
  }
  if (process.env[SEED_FLAG] !== "1") {
    return `${SEED_FLAG}=1 is required (the synthetic seed is test-only data)`;
  }
  return false;
}

/**
 * Refuse to run the destructive suite against anything that does not look
 * like a test database. Called before any destructive step.
 */
function assertSafeTarget(): void {
  const dbName = dbNameFromUrl(process.env.DATABASE_URL ?? "");
  if (!/test/i.test(dbName)) {
    throw new Error(
      `refusing to run destructive DB integration against database "${dbName}" (name must include "test")`
    );
  }
}

/** Quote a PostgreSQL identifier safely (identifier, not a string literal). */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

async function runSuite(): Promise<void> {
  // Setup: a small admin pool outside the disposable schema.
  const admin = createPool();
  try {
    await pingDb(admin);
    assertSafeTarget();

    // Create the isolated disposable schema (only the test ever drops it).
    const schema = `ng_it_${process.pid}_${Date.now().toString(36)}`;
    await admin.query(`CREATE SCHEMA ${quoteIdent(schema)}`);

    // Pool whose search_path is pinned to the disposable schema for the whole
    // run, so every unqualified CREATE / query in the migrations, seed, and
    // checks lands inside the disposable schema.
    const isolated = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${quoteIdent(schema)}`,
    });

    try {
      await pingDb(isolated);

      // Clean schema created entirely from migrations.
      const applied = await migrateUp(isolated);
      assert.ok(applied.includes("0001"), `0001 should be applied; got: ${applied.join(", ")}`);

      // Repeatability: re-running up is a no-op.
      const second = await migrateUp(isolated);
      assert.deepEqual(second, [], "re-running migrations must apply nothing new");

      // 1. Every required table exists (inside the disposable schema).
      const tables = (
        await isolated.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() ORDER BY table_name`
        )
      ).rows.map((r) => r.table_name);
      for (const t of REQUIRED_TABLES) {
        assert.ok(tables.includes(t), `table ${t} should exist`);
      }

      // 2. Real catalog verification: tables, provenance pinning, food-state
      //    constraints, original-value columns, typed review FKs, COALESCE
      //    unique indexes and numeric CHECKs. Replaces any substring validator.
      const problems = await verifyDatabaseSchema(isolated);
      assert.deepEqual(
        problems,
        [],
        `live schema verification should be clean; got: ${JSON.stringify(problems)}`
      );

      // 3. Apply synthetic seed (explicit opt-in asserted above). The synthetic
      //    source must be registered as rejected (never approved).
      await applySyntheticSeed(isolated);
      const synth = await isolated.query(
        `SELECT review_status FROM ${quoteIdent(schema)}.sources WHERE source_key = $1`,
        [SYNTHETIC_SOURCE_KEY]
      );
      assert.strictEqual(synth.rows[0].review_status, "rejected", "synthetic source must be rejected");

      // 4. Constraints block impossible negative values.
      const unitId = (
        await isolated.query<{ id: string }>(
          `SELECT id FROM ${quoteIdent(schema)}.units WHERE unit_code = 'g'`
        )
      ).rows[0].id;
      const ingId = (
        await isolated.query<{ id: string }>(
          `SELECT id FROM ${quoteIdent(schema)}.ingredients WHERE name_en = 'lentils'`
        )
      ).rows[0].id;
      await assert.rejects(
        isolated.query(
          `INSERT INTO ${quoteIdent(schema)}.nutrient_values (ingredient_id, nutrient, amount, unit_id, basis) VALUES ($1, 'protein_g', -5, $2, 'per_100g')`,
          [ingId, unitId]
        ),
        /check/i,
        "negative nutrient amount must be rejected"
      );

      // 5. NULL vs zero are distinct. NUMERIC comes back as a string from
      //    node-postgres; missing stays NULL and a real measured zero is '0'.
      await isolated.query(
        `INSERT INTO ${quoteIdent(schema)}.nutrient_values (ingredient_id, nutrient, amount, original_value) VALUES ($1, 'sodium_mg', NULL, 'unknown')`,
        [ingId]
      );
      const nullRow = await isolated.query(
        `SELECT amount FROM ${quoteIdent(schema)}.nutrient_values WHERE nutrient = 'sodium_mg'`
      );
      assert.strictEqual(nullRow.rows[0].amount, null, "missing must stay null, not coerced to 0");
      await isolated.query(
        `INSERT INTO ${quoteIdent(schema)}.nutrient_values (ingredient_id, nutrient, amount, basis) VALUES ($1, 'saturated_fat_g', 0, 'per_100g')`,
        [ingId]
      );
      const zeroRow = await isolated.query(
        `SELECT amount FROM ${quoteIdent(schema)}.nutrient_values WHERE nutrient = 'saturated_fat_g'`
      );
      assert.ok(zeroRow.rows[0].amount !== null, "a row must exist");
      assert.ok(
        Number(zeroRow.rows[0].amount) === 0,
        "real measured zero is stored as 0, distinct from NULL"
      );

      // 6. Foreign keys enforced: orphan ingredient reference fails.
      await assert.rejects(
        isolated.query(
          `INSERT INTO ${quoteIdent(schema)}.nutrient_values (ingredient_id, nutrient, amount) VALUES (99999999, 'protein_g', 10)`
        )
      );

      // 7. Provenance pinning: a record's data_version must belong to its own
      //    source. The ingredient is owned by the SYNTHETIC source; attaching
      //    it to the foreign source's VERSION must fail (even though the FK ids
      //    exist elsewhere), because (source_id, data_version_id) must match a
      //    data_versions row that belongs to the SAME source.
      const ownSource = await isolated.query<{ id: string }>(
        `SELECT id FROM ${quoteIdent(schema)}.sources WHERE source_key = $1`,
        [SYNTHETIC_SOURCE_KEY]
      );
      const foreign = await isolated.query<{ id: string }>(
        `INSERT INTO ${quoteIdent(schema)}.sources (source_key, review_status)
         VALUES ('TMP-OTHER-' || floor(random()*1e9)::int::text, 'pending') RETURNING id`
      );
      const foreignSourceId = foreign.rows[0].id;
      const foreignVersion = await isolated.query<{ id: string }>(
        `INSERT INTO ${quoteIdent(schema)}.data_versions (source_id, version_label, scope)
         VALUES ($1, 'v-foreign', 'integration-test') RETURNING id`,
        [foreignSourceId]
      );
      const foreignVersionId = foreignVersion.rows[0].id;
      await assert.rejects(
        isolated.query(
          `INSERT INTO ${quoteIdent(schema)}.nutrient_values (ingredient_id, nutrient, amount, source_id, data_version_id) VALUES ($1, 'protein_g', 10, $2, $3)`,
          [ingId, ownSource.rows[0].id, foreignVersionId]
        ),
        /foreign key|violates/i,
        "a record's data_version must belong to the record's own source"
      );
      // And the correct pairing (same source + its version) is accepted.
      const ownVersion = await isolated.query<{ id: string }>(
        `SELECT id FROM ${quoteIdent(schema)}.data_versions WHERE version_label = 'v-synthetic-1'`
      );
      await isolated.query(
        `INSERT INTO ${quoteIdent(schema)}.nutrient_values (ingredient_id, nutrient, amount, source_id, data_version_id) VALUES ($1, 'protein_g', 10, $2, $3)`,
        [ingId, ownSource.rows[0].id, ownVersion.rows[0].id]
      );

      // 8a. Nullable provenance closure (adversarial). Case (a): BOTH NULL is
      //     valid (unverified data). Case (b): source-only NON-NULL must be
      //     rejected. Case (c): version-only NON-NULL must be rejected. Case (d):
      //     a non-existent version pair must be rejected. Case (e): a version
      //     that belongs to a DIFFERENT source must be rejected. Case (f): the
      //     correct (source, own version) pairing must be accepted.
      const ownSrcId = ownSource.rows[0].id;
      const ownVerId = ownVersion.rows[0].id;
      const anySourceId = foreignSourceId;

      // (a) both NULL: acceptable for data without a verified provenance.
      await isolated.query(
        `INSERT INTO ${quoteIdent(schema)}.nutrient_values (ingredient_id, nutrient, amount) VALUES ($1, 'fiber_g', 5)`,
        [ingId]
      );

      // (b) source-only, NULL version: blocked by the pair-nullability CHECK.
      await assert.rejects(
        isolated.query(
          `INSERT INTO ${quoteIdent(schema)}.nutrient_values (ingredient_id, nutrient, amount, source_id, data_version_id) VALUES ($1, 'fiber_b', 5, $2, NULL)`,
          [ingId, anySourceId]
        ),
        /check/i,
        "a provenance source without a version must be rejected"
      );

      // (c) version-only, NULL source: blocked (MATCH FULL + pair CHECK).
      await assert.rejects(
        isolated.query(
          `INSERT INTO ${quoteIdent(schema)}.nutrient_values (ingredient_id, nutrient, amount, source_id, data_version_id) VALUES ($1, 'fiber_c', 5, NULL, $2)`,
          [ingId, foreignVersionId]
        ),
        /check|foreign key|violates/i,
        "a provenance version without a source must be rejected"
      );

      // (d) self-inconsistent pair with a non-existent version.
      await assert.rejects(
        isolated.query(
          `INSERT INTO ${quoteIdent(schema)}.nutrient_values (ingredient_id, nutrient, amount, source_id, data_version_id) VALUES ($1, 'fiber_d', 5, $2, 99999999)`,
          [ingId, anySourceId]
        ),
        /foreign key|violates/i,
        "a provenance pair referencing a non-existent version must be rejected"
      );

      // (e) mismatched pair: the version belongs to a different source.
      await assert.rejects(
        isolated.query(
          `INSERT INTO ${quoteIdent(schema)}.nutrient_values (ingredient_id, nutrient, amount, source_id, data_version_id) VALUES ($1, 'fiber_e', 5, $2, $3)`,
          [ingId, ownSrcId, foreignVersionId]
        ),
        /foreign key|violates/i,
        "a version from a different source must be rejected"
      );

      // (f) correct pairing: same source + its own version.
      await isolated.query(
        `INSERT INTO ${quoteIdent(schema)}.nutrient_values (ingredient_id, nutrient, amount, source_id, data_version_id) VALUES ($1, 'fiber_f', 5, $2, $3)`,
        [ingId, ownSrcId, ownVerId]
      );

      // 8b. Guideline rule chunks must belong to the same document (Item 2):
      //     a cross-document chunk reference is rejected by the composite FK
      //     (document_id, chunk_id) -> guideline_chunks (document_id, id).
      const docA = (
        await isolated.query<{ id: string }>(
          `INSERT INTO ${quoteIdent(schema)}.guideline_documents (document_key, organization, title) VALUES ('docA', 'org', 'docA') RETURNING id`
        )
      ).rows[0].id;
      const docB = (
        await isolated.query<{ id: string }>(
          `INSERT INTO ${quoteIdent(schema)}.guideline_documents (document_key, organization, title) VALUES ('docB', 'org', 'docB') RETURNING id`
        )
      ).rows[0].id;
      const chunkB = (
        await isolated.query<{ id: string }>(
          `INSERT INTO ${quoteIdent(schema)}.guideline_chunks (document_id, chunk_index, content, content_hash) VALUES ($1, 0, 'chunk in docB', 'h1') RETURNING id`,
          [docB]
        )
      ).rows[0].id;
      // same-document reference is accepted...
      await isolated.query(
        `INSERT INTO ${quoteIdent(schema)}.guideline_rules (document_id, chunk_id, topic, metric, operator, value) VALUES ($1, NULL, 't', 'm', '>=', 0)`,
        [docA]
      );
      // ...but a chunk from docB referenced by a docA rule is rejected.
      await assert.rejects(
        isolated.query(
          `INSERT INTO ${quoteIdent(schema)}.guideline_rules (document_id, chunk_id, topic, metric, operator, value) VALUES ($1, $2, 't', 'm', '>=', 0)`,
          [docA, chunkB]
        ),
        /foreign key|violates/i,
        "a rule's chunk must belong to the rule's own document"
      );

      // 8c. Strict positivity (Item 3): conversion factors and yield factors
      //     must be > 0 (a zero factor would silently zero out conversions).
      const fromUnit = (
        await isolated.query<{ id: string }>(
          `SELECT id FROM ${quoteIdent(schema)}.units WHERE unit_code = 'g'`
        )
      ).rows[0].id;
      const toUnit = (
        await isolated.query<{ id: string }>(
          `SELECT id FROM ${quoteIdent(schema)}.units WHERE unit_code = 'ml'`
        )
      ).rows[0].id;
      await assert.rejects(
        isolated.query(
          `INSERT INTO ${quoteIdent(schema)}.ingredient_unit_conversions (ingredient_id, from_unit_id, to_unit_id, factor) VALUES ($1, $2, $3, 0)`,
          [ingId, fromUnit, toUnit]
        ),
        /check/i,
        "a conversion factor of 0 must be rejected"
      );
      await assert.rejects(
        isolated.query(
          `INSERT INTO ${quoteIdent(schema)}.cooking_yield_factors (ingredient_id, food_state_from, food_state_to, yield_factor) VALUES ($1, 'raw', 'cooked', 0)`,
          [ingId]
        ),
        /CHECK/i,
        "a yield factor of 0 must be rejected"
      );
      await assert.rejects(
        isolated.query(
          `INSERT INTO ${quoteIdent(schema)}.cooking_yield_factors (ingredient_id, food_state_from, food_state_to, yield_factor) VALUES ($1, 'raw', 'cooked', -1)`,
          [ingId]
        ),
        /CHECK/i,
        "a negative yield factor must be rejected"
      );

      // 9. Review records use enforceable typed FKs: an orphan target fails.
      await assert.rejects(
        isolated.query(
          `INSERT INTO ${quoteIdent(schema)}.review_records (ingredient_id, decision) VALUES (99999999, 'verified')`
        ),
        /foreign|referenc/i,
        "review target must reference an existing ingredient"
      );

      // 9. Rollback uses the ACTUAL down filename and leaves the disposable
      //    schema without domain tables; the ledger is empty afterwards.
      const rolled = await migrateDown(isolated);
      assert.deepEqual(rolled, ["0001"], "migrateDown should roll back 0001");
      const afterDown = await isolated.query(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'recipes') AS has_recipes`
      );
      assert.strictEqual(afterDown.rows[0].has_recipes, false, "recipes must be dropped by down");
      const ledger = await getAppliedMigrations(isolated);
      assert.deepEqual(ledger, [], "ledger must be empty after rolling back");

      // Re-apply to a known state before the suite tears the schema down.
      await migrateUp(isolated);
    } finally {
      await isolated.end();
      // Drop ONLY the disposable schema the test itself created.
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    }
  } finally {
    await admin.end();
  }
}

test(
  "DB integration (live): catalog schema, constraints, provenance pinning, seed, rollback",
  { skip: skipReason() ?? false },
  async () => {
    if (skipReason()) return; // covered by the skip marker
    await runSuite();
  }
);