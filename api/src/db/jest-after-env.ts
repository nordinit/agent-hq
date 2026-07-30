afterEach(() => {
  const taskLifecycle = require('../lib/taskLifecycle') as Partial<typeof import('../lib/taskLifecycle')>;
  taskLifecycle.clearPendingEndedActiveInstanceLinkageCleanupTimers?.();
});

// Releases this worker's PostgreSQL pool once the FILE is done, rather than after each test.
//
// The pool has to outlive individual tests: testFixture keeps one database per worker and resets it
// by truncation, so closing the pool per test sends the next setup back through DROP DATABASE +
// CREATE DATABASE ... TEMPLATE and blows jest's 5s hook timeout. Releasing it here keeps jest from
// reporting an open handle after a worker's last file, while leaving the database itself for global
// teardown to drop.
//
// A no-op on SQLite runs — closeTestDb() returns immediately when no pool was opened.
afterAll(async () => {
  if (!process.env.AGENT_HQ_TEST_PG_URL) return;
  const fixture = require('./pg/testFixture') as Partial<typeof import('./pg/testFixture')>;
  await fixture.closeTestDb?.();
});
