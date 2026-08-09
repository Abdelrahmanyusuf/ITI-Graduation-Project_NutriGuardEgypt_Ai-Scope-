/**
 * NutriGuard Step 4 — PostgreSQL connection and migration runner.
 *
 * Uses the `pg` driver. The connection string is read ONLY from the DATABASE_URL
 * environment variable (or the standard PG* variables that `pg` reads natively).
 * No credentials are stored in source control; a real database connection is
 * required only for the migration runner and the integration tests.
 *
 * Migrations live under migrations/NNNN_<name>.{up,down}.sql. The runner keeps
 * a schema_migrations ledger so each up/down is applied exactly once and in
 * order.
 *
 * Transaction-ownership rule: the runner is the SINGLE owner of every
 * transaction. Migration .sql files contain only DDL/DML (they must NOT wrap
 * themselves in BEGIN/COMMIT). The runner:
 *   1. bootstraps the schema_migrations ledger first (so an entirely empty
 *      PostgreSQL database is a valid starting point), then
 *   2. opens one BEGIN/COMMIT, applies the file, and records the ledger row
 *      inside that same transaction.
 * Down migrations are resolved from the actual *.down.sql filenames present on
 * disk (never from a hard-coded convention), so a migration can be rolled back
 * even if it is not named "<NNNN>_init".
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(currentDir, "..", "..", "migrations");

export interface AppliedMigration {
  version: string;
  name: string;
  appliedAt: Date;
}

export interface DbConfig {
  /** Full PostgreSQL connection string, e.g. postgres://user:pass@host:5432/db. */
  databaseUrl: string | undefined;
}

/** Read connection config from the environment; DATABASE_URL is optional here. */
export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return { databaseUrl: env.DATABASE_URL };
}

/**
 * A pool factory bound to DATABASE_URL (or the PG* env vars pg reads).
 * `pg` does not read DATABASE_URL on its own, so we pass it explicitly when
 * present; otherwise the standard PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
 * variables are used.
 */
export function createPool(): Pool {
  const databaseUrl = process.env.DATABASE_URL;
  return databaseUrl ? new Pool({ connectionString: databaseUrl }) : new Pool();
}

/** Read the ordered list of migration file names for a direction from disk. */
export async function listMigrationFiles(
  dir = MIGRATIONS_DIR,
  direction: "up" | "down" = "up"
): Promise<string[]> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => new RegExp(`\\.${direction}\\.sql$`).test(f) && /^\d{4}_/.test(f))
    .sort((a, b) => a.localeCompare(b));
}

/** E.g. `0001` from `0001_init.up.sql`. */
export function versionOf(fileName: string): string {
  const m = /^(\d{4})_/.exec(fileName);
  return m ? m[1] : "";
}

/**
 * Resolve the down migration file for a given version from the files actually
 * present on disk. Returns the full filename, or null when no *.down.sql file
 * declares that version.
 */
export async function resolveDownMigrationFile(
  version: string,
  dir = MIGRATIONS_DIR
): Promise<string | null> {
  const downFiles = await listMigrationFiles(dir, "down");
  return downFiles.find((f) => versionOf(f) === version) ?? null;
}

async function loadSql(dir: string, fileName: string): Promise<string> {
  return fs.readFile(path.join(dir, fileName), "utf8");
}

/** DDL that the runner uses to bootstrap the ledger on a completely empty DB. */
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  name       text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`;

/**
 * Ensure the schema_migrations ledger table exists. Called before any query in
 * the truthful integration tests as well as by migrateUp so that running
 * migrations against a brand-new, empty PostgreSQL is valid.
 */
export async function ensureLedgerTable(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_MIGRATIONS_DDL);
}

/**
 * Load the schema_migrations ledger (newest first). Bootstraps the ledger
 * first so a `db:status` run against a brand-new, empty PostgreSQL is safe.
 */
export async function getAppliedMigrations(pool: Pool): Promise<AppliedMigration[]> {
  await ensureLedgerTable(pool);
  const res = await pool.query<{ version: string; name: string; applied_at: string }>(
    "SELECT version, name, applied_at FROM schema_migrations ORDER BY version"
  );
  return res.rows.map((r) => ({
    version: r.version,
    name: r.name,
    appliedAt: new Date(r.applied_at),
  }));
}

/**
 * Apply all pending up migrations in order; returns the applied versions.
 * The ledger is bootstrapped first, and each migration runs inside a single
 * BEGIN/COMMIT owned by the runner (the .sql files do not wrap themselves).
 */
export async function migrateUp(pool: Pool): Promise<string[]> {
  await ensureLedgerTable(pool);
  const files = await listMigrationFiles(MIGRATIONS_DIR, "up");
  const applied = new Set((await getAppliedMigrations(pool)).map((m) => m.version));
  const appliedNow: string[] = [];
  for (const f of files) {
    const version = versionOf(f);
    if (applied.has(version)) continue;
    const sql = await loadSql(MIGRATIONS_DIR, f);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
        [version, f]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${f} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
    appliedNow.push(version);
  }
  return appliedNow;
}

/**
 * Roll back applied migrations using the matching down files, newest first.
 * Down file names are resolved from the actual *.down.sql files on disk, never
 * from a hard-coded naming convention. Returns the versions rolled back.
 */
export async function migrateDown(pool: Pool): Promise<string[]> {
  await ensureLedgerTable(pool);
  const filesUp = await listMigrationFiles(MIGRATIONS_DIR, "up");
  const available = new Set(filesUp.map((f) => versionOf(f)));
  const appliedOrder = (await getAppliedMigrations(pool)).map((m) => m.version);
  const toRollBack = appliedOrder.filter((v) => available.has(v)).reverse();
  const rolledBack: string[] = [];
  for (const version of toRollBack) {
    const downFile = await resolveDownMigrationFile(version);
    if (downFile === null) {
      const downFiles = await listMigrationFiles(MIGRATIONS_DIR, "down");
      throw new Error(
        `no *.down.sql file found for version ${version}; cannot roll it back (down files present: ${downFiles.join(", ") || "none"})`
      );
    }
    let sql: string;
    try {
      sql = await loadSql(MIGRATIONS_DIR, downFile);
    } catch {
      throw new Error(`down migration file unreadable: ${downFile} (cannot roll back ${version})`);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("DELETE FROM schema_migrations WHERE version = $1", [version]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(
        `rollback of ${version} (${downFile}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      client.release();
    }
    rolledBack.push(version);
  }
  return rolledBack;
}

/** Run a quick health check: SELECT 1 against the pool (fails loudly if no DB). */
export async function pingDb(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}