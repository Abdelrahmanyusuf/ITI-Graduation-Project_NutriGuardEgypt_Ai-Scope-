import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  MIGRATIONS_DIR,
  listMigrationFiles,
  resolveDownMigrationFile,
  versionOf,
} from "../src/data/database.js";
import { loadSyntheticSeedSql } from "../src/data/seed.js";
import { REQUIRED_TABLES } from "../src/data/schema.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("DB-less: migration runner can enumerate the up/down files", async () => {
  const up = await listMigrationFiles(MIGRATIONS_DIR, "up");
  const down = await listMigrationFiles(MIGRATIONS_DIR, "down");
  assert.ok(up.some((f) => /^0001_init.up.sql$/.test(f)), "up migration present");
  assert.ok(down.some((f) => /^0001_init.down.sql$/.test(f)), "down migration present");
  // Deterministic ordering.
  const upCopy = [...up];
  upCopy.sort();
  assert.deepEqual(up, upCopy);
});

test("DB-less: versions are parsed from the actual filename prefix", () => {
  assert.strictEqual(versionOf("0001_init.up.sql"), "0001");
  assert.strictEqual(versionOf("0002_seed_reference.down.sql"), "0002");
  assert.strictEqual(versionOf("README.md"), "");
});

test("DB-less: down migrations are resolved from actual filenames, not a convention", async () => {
  const down = await resolveDownMigrationFile("0001");
  assert.ok(down !== null, "a down file must exist for 0001");
  assert.match(down, /^0001_.*\.down\.sql$/, `resolved ${down} should keep the real file name`);
  const missing = await resolveDownMigrationFile("9999");
  assert.strictEqual(missing, null, "unknown version resolves to null");
});

test("DB-less: canonical schema contract names every required table", () => {
  assert.ok(REQUIRED_TABLES.includes("schema_migrations"));
  assert.ok(REQUIRED_TABLES.includes("data_versions"));
  assert.ok(REQUIRED_TABLES.includes("review_records"));
});

test("DB-less: the up migration and down migration contain no embedded SQL transactions", () => {
  for (const f of ["0001_init.up.sql", "0001_init.down.sql"]) {
    const sql = readFileSync(path.join(root, "migrations", f), "utf8");
    assert.ok(!/^\s*BEGIN\s*;?\s*$/m.test(sql), `${f} must not embed a BEGIN statement (runner owns the transaction)`);
    assert.ok(!/^\s*COMMIT\s*;?\s*$/m.test(sql), `${f} must not embed a COMMIT statement (runner owns the transaction)`);
  }
});

test("DB-less: 0001 up migration declares every required table", () => {
  const sql = readFileSync(path.join(root, "migrations", "0001_init.up.sql"), "utf8");
  for (const t of REQUIRED_TABLES) {
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`, "i"),
      `0001 should declare table ${t}`
    );
  }
});

test("DB-less: the synthetic seed is explicitly marked synthetic/rejected on a source", async () => {
  const sql = await loadSyntheticSeedSql(); // no DB needed, just reads the file
  assert.ok(sql.includes("SYNTHETIC-FIXTURE"), "seed registers a synthetic source");
  // Must not look like real, user-facing data.
  assert.ok(!/review_status\s*=\s*'approved'/i.test(sql), "synthetic source cannot be approved");
  // The seed loader is the single transaction owner; the fixture must not wrap itself.
  assert.ok(!/^\s*BEGIN\s*;?\s*$/m.test(sql), "seed fixture must not embed a BEGIN statement");
  assert.ok(!/^\s*COMMIT\s*;?\s*$/m.test(sql), "seed fixture must not embed a COMMIT statement");
});