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
}
