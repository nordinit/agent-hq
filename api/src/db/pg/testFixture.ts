import crypto from 'crypto';
import { Pool } from 'pg';
import { PostgresAdapter } from '../adapter/PostgresAdapter';
import type { Db } from '../adapter/types';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { loadMigrations, runMigrations, verifyMigrationsCurrent } from './migrationRunner';

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

/** A schema-content fingerprint prevents a stale template from surviving a migration change. */
export function migrationFingerprint(): string {
  const migrations = loadMigrations(POSTGRES_MIGRATION_DIRS);
  if (!migrations.length) throw new Error('Cannot build PostgreSQL test template: no migrations found');
  return crypto.createHash('sha256')
    .update(migrations.map(({ id, checksum }) => `${id}:${checksum}`).join('\n'))
    .digest('hex')
    .slice(0, 12);
}

export function templateDatabaseName(): string {
  return `agent_hq_test_template_${migrationFingerprint()}`;
}

/**
 * Builds the template database. Safe to call concurrently: the advisory lock serialises
 * competing workers, and the second one finds the template already present.
 */
export async function ensureTemplateDatabase(): Promise<void> {
  const templateDb = templateDatabaseName();
  const admin = new Pool({ connectionString: urlFor('postgres') });
  try {
    // A plain "does it exist? then create it" race between parallel workers produces
    // duplicate-database errors, so creation is serialised behind an advisory lock.
    const client = await admin.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [847362891]);
      const { rows } = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [templateDb]);
      let needsBuild = rows.length === 0;
      if (!needsBuild) {
        // A process can die between CREATE DATABASE and the final migration. The fingerprint
        // prevents old schemas from being reused; if the current template is incomplete, rebuild
        // it under the same lock instead of leaving every future run permanently broken.
        const existing = new Pool({ connectionString: urlFor(templateDb) });
        try {
          await verifyMigrationsCurrent(new PostgresAdapter(existing), POSTGRES_MIGRATION_DIRS);
        } catch {
          needsBuild = true;
        } finally {
          await existing.end();
        }
        if (needsBuild) await client.query(`DROP DATABASE "${templateDb}"`);
      }
      if (needsBuild) {
        await client.query(`CREATE DATABASE "${templateDb}"`);
        const build = new Pool({ connectionString: urlFor(templateDb) });
        try {
          await runMigrations(new PostgresAdapter(build), POSTGRES_MIGRATION_DIRS);
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
/** In-flight worker-database creation, so concurrent callers await one clone. */
let workerInit: Promise<Db> | null = null;
let workerDb: string | null = null;
let cachedTables: string[] | null = null;

function workerDatabaseName(): string {
  // JEST_WORKER_ID is 1-based and stable for the life of a worker, but it is NOT unique across
  // concurrent jest invocations — two runs on the same machine both have a worker 1, and each
  // would DROP and re-CREATE the other's database mid-test. The process id disambiguates them
  // while staying stable for the worker's lifetime, which is what the per-worker reuse relies on.
  const worker = process.env.JEST_WORKER_ID ?? '1';
  return `agent_hq_test_w${worker}_p${process.pid}_${migrationFingerprint()}`;
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
  // Memoised on the in-flight PROMISE, not just the resolved pool. Two callers arriving before
  // the first finishes both saw workerPool === null and both entered the clone path, and the
  // second one's DROP DATABASE then hit the connection the first had just opened —
  // "database ... is being accessed by other users", from a race inside one worker rather than
  // between workers. ensureTemplateDatabase() already holds an advisory lock for the
  // cross-process case; this is the in-process equivalent.
  if (!workerInit) {
    workerInit = createWorkerDatabase().catch((err) => {
      // A failed init must not be cached, or every later file in this worker inherits it.
      workerInit = null;
      throw err;
    });
  }
  return await workerInit;
}

async function createWorkerDatabase(): Promise<Db> {
  await ensureTemplateDatabase();
  workerDb = workerDatabaseName();
  const templateDb = templateDatabaseName();

  const admin = new Pool({ connectionString: urlFor('postgres') });
  try {
    // CREATE DATABASE ... TEMPLATE fails if anything is connected to the template, and
    // rejects being run inside a transaction — hence a bare query on a fresh connection.
    //
    // Reuse an existing worker database rather than recreating it. The "one clone per worker"
    // design assumed this module's state survives the worker's lifetime, and it does not: jest
    // gives every TEST FILE a fresh module registry, so workerPool is null again at the start of
    // each file and every file re-entered the clone path. DROP DATABASE then failed with "is
    // being accessed by other users" whenever the previous file's db/client.ts pool still held a
    // connection — which is why --runInBand made it WORSE, not better: one worker means more
    // files sharing one database, so more chances to collide.
    //
    // Isolation does not depend on the clone. setupTestDb() truncates every table at the start of
    // each test, so an existing database is as clean as a fresh one and costs a truncate instead
    // of a file copy.
    //
    // Deliberately no pg_terminate_backend as a workaround: the holder is usually the pool serving
    // the test running right now, so killing it turns a setup failure into "terminating connection
    // due to administrator command" in the middle of an unrelated assertion.
    const { rows } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [workerDb]);
    if (rows.length === 0) {
      // CREATE DATABASE ... TEMPLATE fails if anything is connected to the template, and rejects
      // being run inside a transaction — hence a bare query on a fresh connection.
      await admin.query(`CREATE DATABASE "${workerDb}" TEMPLATE "${templateDb}"`);
    }
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
  // Cleared alongside the pool. Leaving it set would hand the next getTestDb() a resolved
  // promise wrapping a pool that has already been ended, which fails on first query rather
  // than re-cloning as intended.
  workerInit = null;
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
