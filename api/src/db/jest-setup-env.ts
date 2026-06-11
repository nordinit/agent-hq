/**
 * jest-setup-env.ts — Set DB env var for each test worker process.
 *
 * Jest's globalSetup runs in a separate Node process, so env changes there
 * don't propagate to test workers automatically. This file runs in every
 * test worker via jest.setupFiles and overrides AGENT_HQ_DB_PATH before
 * any module under test imports client.ts.
 *
 * Registered in package.json under jest.setupFiles.
 */

// Use :memory: for full isolation, or a per-worker temp file if shared state is needed.
process.env.AGENT_HQ_DB_PATH = ':memory:';
if (!process.env.PORT) {
  process.env.PORT = '0';
}
