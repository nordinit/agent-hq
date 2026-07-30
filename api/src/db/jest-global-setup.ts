/**
 * jest-global-setup.ts — Isolate test suite from Dev and Production DBs.
 *
 * Jest runs this once before the entire test suite (globalSetup).
 * It sets AGENT_HQ_DB_PATH to :memory: so every test process gets a fresh
 * in-memory SQLite DB that is completely separate from:
 *   - agent-hq.db    (production)
 *   - agent-hq-dev.db (dev)
 *
 * Registered in package.json under jest.globalSetup.
 */

export default async function globalSetup(): Promise<void> {
  process.env.AGENT_HQ_DB_PATH = ':memory:';
  // Also ensure PORT is 0 so no real network listener blocks test runs
  if (!process.env.PORT) {
    process.env.PORT = '0';
  }
  await reapStaleWorkerDatabases();
}

/**
 * Drops per-worker PostgreSQL test databases left behind by earlier runs.
 *
 * The worker database name carries a process id so that concurrent jest invocations cannot fight
 * over one database. The cost of that is accumulation: a run killed before teardown leaves its
 * databases behind, and without this they pile up indefinitely (each is a full clone of the
 * template). Reaping at the start of a run is safer than at the end, because it also cleans up
 * after a run that was interrupted.
 *
 * Anything still connected is skipped rather than force-dropped — that connection belongs to a jest
 * process running right now, and killing its database out from under it is exactly the failure this
 * naming scheme was introduced to prevent.
 */
async function reapStaleWorkerDatabases(): Promise<void> {
  const url = process.env.AGENT_HQ_TEST_PG_URL;
  if (!url) return;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require('pg') as typeof import('pg');
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const pool = new Pool({ connectionString: admin.toString() });
  try {
    const { rows } = await pool.query<{ datname: string }>(`
      SELECT d.datname
        FROM pg_database d
       WHERE d.datname LIKE 'agent_hq_test_w%'
         AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)
    `);
    for (const { datname } of rows) {
      // Identifier comes from pg_database and matched a restrictive LIKE, so it cannot be injected.
      await pool.query(`DROP DATABASE IF EXISTS "${datname}"`).catch(() => { /* raced another reaper */ });
    }
    if (rows.length) console.log(`[test-db] reaped ${rows.length} stale worker database(s)`);
  } catch (err) {
    // Never fail the run over cleanup: a missing or unreachable server is the gated suite's problem
    // to report, not global setup's.
    console.warn('[test-db] could not reap stale worker databases:', err instanceof Error ? err.message : err);
  } finally {
    await pool.end();
  }
}
