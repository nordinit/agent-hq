import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, closeDbAsync, getDb } from './client';
import { initSchema } from './schema';
import { closeTestDb, getTestDb, resetTestDb, workerDatabaseUrl } from './pg/testFixture';
import type { Db } from './adapter/types';

/**
 * One database-per-test helper that serves BOTH engines, so a single test file can be run against
 * SQLite and against PostgreSQL without being written twice.
 *
 * WHY THIS EXISTS
 * The suite built its fixtures with initSchema() (SQLite) or with hand-written CREATE TABLEs on an
 * in-memory better-sqlite3 connection. Either way it only ever exercised SQLite, while production
 * now runs PostgreSQL — so a PostgreSQL-only defect passed every test. That is not hypothetical:
 * unquoted camelCase SQL aliases fold to lower case on PostgreSQL, which turned every id in an MCP
 * authorization scope set into NaN and denied every agent lifecycle callbacks on its own run. The
 * query succeeded, the row count was right, nothing threw, and 971 tests stayed green.
 *
 * api/src/db/pg/testFixture.ts was built for exactly this and then never adopted — zero importers.
 * The reason it stalled is worth recording: initSchema() does three jobs at once (create the
 * schema, run data migrations, seed defaults), whereas the fixture template carries DDL only and
 * is truncated between tests. So a converted test cannot simply swap one for the other; it has to
 * seed what it actually depends on. That is real per-file work, which is why this helper does not
 * pretend to be a drop-in replacement.
 *
 * HOW THE ENGINE IS CHOSEN
 * AGENT_HQ_TEST_PG_URL selects PostgreSQL. It is deliberately a DIFFERENT variable from the
 * DATABASE_URL the application reads, so setting it cannot accidentally repoint a developer's or
 * production process — this helper is the only thing that copies one to the other, and only for
 * the lifetime of a test.
 */
export function usingPostgres(): boolean {
  return Boolean(process.env.AGENT_HQ_TEST_PG_URL);
}

/** Skips a describe block that can only be meaningful on one engine. */
export const describeSqliteOnly = usingPostgres() ? describe.skip : describe;

let tempDir = '';

export interface SetupTestDbOptions {
  /** Passed to initSchema on SQLite. Ignored on PostgreSQL, where the schema comes from the template. */
  tenantMode?: 'repair' | 'verify';
}

/**
 * A fresh, empty database on whichever engine the run targets, with the application's own getDb()
 * pointed at it.
 */
export async function setupTestDb(options: SetupTestDbOptions = {}): Promise<Db> {
  if (usingPostgres()) {
    // Clone-from-template first: workerDatabaseUrl() is only valid once the database exists.
    await getTestDb();
    process.env.DATABASE_URL = workerDatabaseUrl();
    // closeDbAsync(), not closeDb(). closeDb() is synchronous so it deliberately does NOT end the
    // PostgreSQL pool — and it does not null it either, so getDb() then builds a BRAND-NEW Pool
    // and orphans the previous one. Called per test that leaks ten connections at a time until the
    // server queues every request and whole files fail on jest's 5s timeout, with no "too many
    // clients" error to point at it because a saturated pool waits rather than throwing.
    await closeDbAsync();
    await resetTestDb();

    const db = getDb();
    // Hard invariant, because "the suite is green under AGENT_HQ_TEST_PG_URL" is NOT evidence that
    // anything ran on PostgreSQL. A file that still calls initSchema() builds SQLite whatever this
    // variable says, then passes — a false green that looks exactly like a successful conversion.
    // Two conversions were correctly abandoned after their own agent spotted precisely this.
    //
    // Failing here means the run asked for PostgreSQL and got something else, which is never a
    // result worth reporting as a pass.
    if (db.dialect !== 'postgres') {
      throw new Error(
        `setupTestDb() was asked for PostgreSQL (AGENT_HQ_TEST_PG_URL is set) but getDb() returned `
        + `a '${db.dialect}' handle. Something else in this file is configuring the engine — most `
        + `often a leftover initSchema() call or an AGENT_HQ_DB_PATH assignment. Passing tests in `
        + `this state prove nothing about PostgreSQL.`,
      );
    }
    return db;
  }

  // SQLite: a real temp file rather than :memory:, because initSchema reopens the connection and
  // an in-memory database does not survive that.
  delete process.env.DATABASE_URL;
  closeDb();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-test-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  await initSchema(options);
  return getDb();
}

export async function teardownTestDb(): Promise<void> {
  if (usingPostgres()) {
    // Deliberately does NOT close the pool or drop the database.
    //
    // The fixture's model is one database per jest WORKER, reset by truncation. Closing the pool
    // here resets testFixture's cached handle, so the next beforeEach re-enters the clone path and
    // runs DROP DATABASE + CREATE DATABASE ... TEMPLATE again — per test. That is slow enough to
    // blow jest's 5s hook timeout, which is exactly how this was found: the second test in a file
    // failed with "Exceeded timeout of 5000 ms for a hook" rather than any assertion.
    //
    // setupTestDb() already truncates at the start of each test, so isolation does not depend on
    // anything happening here. The pool is closed by closeTestDb() in per-file teardown, and the
    // worker database is dropped by dropWorkerDatabase() in global teardown.
    //
    // DATABASE_URL *is* cleared, which is separate from the pool: a jest worker runs many files in
    // sequence, and leaving it set would silently move every not-yet-converted file in that worker
    // onto PostgreSQL against a truncated database. Clearing it costs nothing — the pool stays
    // open, and the next setupTestDb() sets it again.
    // Ends the pool this test opened, for the same reason: leaving it to closeDb() elsewhere
    // orphans it. The worker DATABASE is untouched and is reused by the next test via truncation.
    await closeDbAsync();
    delete process.env.DATABASE_URL;
    return;
  }
  closeDb();
  delete process.env.AGENT_HQ_DB_PATH;
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
}
