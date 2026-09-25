/**
 * Every Jest worker is PostgreSQL-only. setupTestDb() assigns a cloned worker database before
 * application code opens a connection; keeping the base URL separate prevents a test from ever
 * writing to the administrative database by accident.
 */
if (!process.env.AGENT_HQ_TEST_PG_URL) {
  throw new Error(
    'AGENT_HQ_TEST_PG_URL is required. Agent HQ tests run on PostgreSQL.',
  );
}

delete process.env.DATABASE_URL;
delete process.env.AGENT_HQ_DATABASE_URL;

if (!process.env.PORT) process.env.PORT = '0';

// /api/v1 authentication is enforced under test exactly as in production. Every worker uses this
// fixed operator token, never one from the developer's environment; lib/testApiAuth.ts builds the
// authenticator and operator clients from it.
process.env.AGENT_HQ_OPERATOR_TOKEN = 'test-operator-token-0123456789abcdef0123456789abcdef';
delete process.env.AGENT_HQ_AUTH_MODE;
