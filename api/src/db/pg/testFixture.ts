import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { PostgresAdapter } from '../adapter/PostgresAdapter';
import type { Db } from '../adapter/types';

/**
 * PostgreSQL fixtures for the test suite, replacing initSchema()-built SQLite databases.
 *
 * THE COST THIS EXISTS TO AVOID
 * Building the schema per test file means 71 tables, 192 indexes and 130 foreign keys —
 * seconds each, times 130 suites. Instead the schema is built ONCE into a template
 * database, and each worker clones it with CREATE DATABASE ... TEMPLATE, which PostgreSQL
 * implements as a file copy. Within a worker, tests reset by truncating rather than
 * rebuilding.
 *
 * ISOLATION MODEL
 * One database per jest WORKER, not per test file. Workers run in parallel and would race
 * on a shared database; test files within a worker run sequentially, so truncation between
 * them is sufficient and is far cheaper than another clone.
 *
 * Requires AGENT_HQ_TEST_PG_URL. There is no SQLite fallback: a fallback would mean the
 * suite silently exercising a different engine than production, which is precisely the
 * class of gap this migration exists to close.
 */

const BASELINE_DIR = path.resolve(__dirname, '../../../../db/pg-baseline');
const TEMPLATE_DB = 'agent_hq_test_template';

function adminUrl(): string {
  const url = process.env.AGENT_HQ_TEST_PG_URL;
  if (!url) {
    throw new Error(
      'AGENT_HQ_TEST_PG_URL is not set. The test suite requires a PostgreSQL server; ' +
      'there is deliberately no SQLite fallback, because a fallback would exercise a ' +
      'different engine than production.'
    );
  }
  return url;
}

/** Swaps the database name in a connection URL, keeping host, port and credentials. */
function urlFor(database: string): string {
  const u = new URL(adminUrl());
  u.pathname = `/${database}`;
  return u.toString();
}

function baselineFiles(): string[] {
  // Only the structural files. The rename migration is applied too, so tests exercise the
  // SAME vocabulary as production rather than the pre-rename names.
  return ['01-tables.sql', '02-indexes.sql', '03-foreign-keys.sql', '10-rename-legacy-terminology.sql']
    .map((f) => path.join(BASELINE_DIR, f))
    .filter((f) => fs.existsSync(f));
}

/**
 * Builds the template database. Safe to call concurrently: the advisory lock serialises
 * competing workers, and the second one finds the template already present.
 */
export async function ensureTemplateDatabase(): Promise<void> {
  const admin = new Pool({ connectionString: urlFor('postgres') });
  try {
    // A plain "does it exist? then create it" race between parallel workers produces
    // duplicate-database errors, so creation is serialised behind an advisory lock.
    const client = await admin.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [847362891]);
      const { rows } = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [TEMPLATE_DB]);
      if (!rows.length) {
        await client.query(`CREATE DATABASE ${TEMPLATE_DB}`);
        const build = new Pool({ connectionString: urlFor(TEMPLATE_DB) });
        try {
          for (const file of baselineFiles()) {
            await build.query(fs.readFileSync(file, 'utf8'));
          }
        } finally {
          await build.end();
        }
      }
      await client.query('SELECT pg_advisory_unlock($1)', [847362891]);
    } finally {
      client.release();
    }
  } finally {
    await admin.end();
  }
}

let workerPool: Pool | null = null;
let workerDb: string | null = null;
let cachedTables: string[] | null = null;

function workerDatabaseName(): string {
  // JEST_WORKER_ID is 1-based and stable for the life of a worker.
  const worker = process.env.JEST_WORKER_ID ?? '1';
  return `agent_hq_test_w${worker}`;
}

/**
 * The connection URL for this worker's database.
 *
 * Exported so a test harness can put it in DATABASE_URL. That matters because the code under
 * test calls db/client.ts's own getDb() rather than receiving a handle, and getDb() selects the
 * engine from DATABASE_URL — so setting it is what makes the application itself run on
 * PostgreSQL, with no module mocking. Only valid after getTestDb() has run.
 */
export function workerDatabaseUrl(): string {
  if (!workerDb) throw new Error('workerDatabaseUrl() called before getTestDb()');
  return urlFor(workerDb);
}

/**
 * Returns this worker's database, creating it from the template on first use.
 */
export async function getTestDb(): Promise<Db> {
  if (workerPool) return new PostgresAdapter(workerPool);

  await ensureTemplateDatabase();
  workerDb = workerDatabaseName();

  const admin = new Pool({ connectionString: urlFor('postgres') });
  try {
    // CREATE DATABASE ... TEMPLATE fails if anything is connected to the template, and
    // rejects being run inside a transaction — hence a bare query on a fresh connection.
    await admin.query(`DROP DATABASE IF EXISTS ${workerDb}`);
    await admin.query(`CREATE DATABASE ${workerDb} TEMPLATE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }

  workerPool = new Pool({ connectionString: urlFor(workerDb) });
  return new PostgresAdapter(workerPool);
}

/**
 * Empties every table, for use between test files.
 *
 * TRUNCATE ... CASCADE in one statement rather than per-table DELETE: it ignores foreign
 * keys within the truncated set, so no dependency ordering is needed, and RESTART IDENTITY
 * resets sequences so ids are deterministic per test — several suites assert on id 1.
 */
export async function resetTestDb(): Promise<void> {
  if (!workerPool) return;
  if (!cachedTables) {
    const { rows } = await workerPool.query(`
      SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
    `);
    cachedTables = rows.map((r) => `"${r.tablename}"`);
  }
  if (!cachedTables.length) return;
  await workerPool.query(`TRUNCATE ${cachedTables.join(', ')} RESTART IDENTITY CASCADE`);
}

export async function closeTestDb(): Promise<void> {
  if (workerPool) {
    await workerPool.end();
    workerPool = null;
  }
  cachedTables = null;
}

/** Drops this worker's database. For global teardown. */
export async function dropWorkerDatabase(): Promise<void> {
  await closeTestDb();
  if (!workerDb) return;
  const admin = new Pool({ connectionString: urlFor('postgres') });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${workerDb}`);
  } finally {
    await admin.end();
    workerDb = null;
  }
}
