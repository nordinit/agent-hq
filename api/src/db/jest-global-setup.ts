/** Jest global setup for the PostgreSQL-only suite. */
export default async function globalSetup(): Promise<void> {
  const url = process.env.AGENT_HQ_TEST_PG_URL;
  if (!url) {
    throw new Error(
      'AGENT_HQ_TEST_PG_URL is required. Agent HQ tests run on PostgreSQL.',
    );
  }
  if (!process.env.PORT) process.env.PORT = '0';
  await cleanupExitedWorkers(url);
}

/**
 * A worker can have no open database connection between tests or while its
 * admin connection creates a clone. Ownership, not connection idleness, proves
 * whether cleanup is safe across concurrent Jest invocations.
 */
async function cleanupExitedWorkers(connectionString: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require('pg') as typeof import('pg');
  const admin = new URL(connectionString);
  admin.pathname = '/postgres';
  const pool = new Pool({ connectionString: admin.toString() });
  try {
    const {reapStaleTestDatabases}=await import('./pg/testDatabaseCleanup');
    const removed=await reapStaleTestDatabases(pool);
    if (removed) console.log(`[test-db] reaped ${removed} exited-worker database(s)`);
  } finally {
    await pool.end();
  }
}
