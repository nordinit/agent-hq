/**
 * Every Jest worker is PostgreSQL-only. setupTestDb() assigns a cloned worker database before
 * application code opens a connection; keeping the base URL separate prevents a test from ever
 * writing to the administrative database by accident.
 */
if (!process.env.AGENT_HQ_TEST_PG_URL) {
  throw new Error(
    'AGENT_HQ_TEST_PG_URL is required. Agent HQ tests run on PostgreSQL and have no SQLite fallback.',
  );
}

delete process.env.AGENT_HQ_DB_PATH;
delete process.env.DATABASE_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENT_HQ_DATABASE_URL;

if (!process.env.PORT) process.env.PORT = '0';
