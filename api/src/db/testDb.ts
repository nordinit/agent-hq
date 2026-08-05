import { closeDb } from './client';
import { closeTestDb, getTestDb, resetTestDb, workerDatabaseUrl } from './pg/testFixture';
import type { Db } from './adapter/types';

/**
 * Resets the PostgreSQL database assigned to this Jest worker and points the application's
 * singleton client at it. Tests must use this helper instead of constructing an engine-specific
 * database or running schema creation code themselves.
 */
export async function setupTestDb(): Promise<Db> {
  // The clone has to exist before workerDatabaseUrl() can be resolved.
  const fixtureDb = await getTestDb();
  process.env.DATABASE_URL = workerDatabaseUrl();
  process.env.AGENT_HQ_DATABASE_URL = workerDatabaseUrl();

  // A previous test file may have opened the application singleton against this worker database.
  // Route tests sometimes mock db/client with only getDb(); then there is no singleton to close.
  if (typeof closeDb === 'function') await closeDb();
  await resetTestDb();

  // Do not call db/client.getDb() here. Jest hoists route-level mocks, whose getDb() may return
  // the suite's not-yet-assigned variable instead of the PostgreSQL fixture.
  return fixtureDb;
}

export async function teardownTestDb(): Promise<void> {
  if (typeof closeDb === 'function') await closeDb();
  await closeTestDb();
  delete process.env.DATABASE_URL;
  delete process.env.AGENT_HQ_DATABASE_URL;
}
