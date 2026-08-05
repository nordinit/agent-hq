/** Jest global setup for the PostgreSQL-only suite. */
export default async function globalSetup(): Promise<void> {
  const url = process.env.AGENT_HQ_TEST_PG_URL;
  if (!url) {
    throw new Error(
      'AGENT_HQ_TEST_PG_URL is required. Agent HQ tests run on PostgreSQL and have no SQLite fallback.',
    );
  }
  if (!process.env.PORT) process.env.PORT = '0';
  const { templateDatabaseName } = await import('./pg/testFixture');
  await reapStaleTestDatabases(url, templateDatabaseName());
}

/**
 * Test databases include a process id and migration fingerprint. Anything not connected belongs
 * to an interrupted or completed run and can be removed without touching a live Jest worker.
 */
async function reapStaleTestDatabases(connectionString: string, currentTemplate: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require('pg') as typeof import('pg');
  const admin = new URL(connectionString);
  admin.pathname = '/postgres';
  const pool = new Pool({ connectionString: admin.toString() });
  try {
    const { rows } = await pool.query<{ datname: string }>(`
      SELECT d.datname
        FROM pg_database d
       WHERE (d.datname LIKE 'agent_hq_test_w%'
              OR (d.datname LIKE 'agent_hq_test_template_%' AND d.datname <> $1))
         AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)
    `, [currentTemplate]);
    for (const { datname } of rows) {
      await pool.query(`DROP DATABASE IF EXISTS "${datname}"`).catch(() => { /* raced another run */ });
    }
    if (rows.length) console.log(`[test-db] reaped ${rows.length} stale database(s)`);
  } finally {
    await pool.end();
  }
}
