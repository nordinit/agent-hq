/**
 * PM2 config for the PostgreSQL test instance.
 *
 * Runs Agent HQ from THIS worktree against the provisioned PostgreSQL database, on ports
 * that do not collide with anything already running (production is 3501/3500; the dev
 * instances occupy 3510/3511 and 3520/3521).
 *
 * Deliberately isolated from production in three separate ways, because any one of them
 * failing alone would be enough to touch live data:
 *   - a different DATABASE (PostgreSQL, not ~/.agent-hq/agent-hq.db)
 *   - different PORTS
 *   - different PM2 PROCESS NAMES, so `pm2 restart agent-hq-api` can never hit these
 *
 * AGENT_HQ_DB_PATH is deliberately NOT set. db/client.ts selects PostgreSQL purely on
 * DATABASE_URL being present, and leaving the SQLite path unset means a misconfiguration
 * that dropped DATABASE_URL would fail to find a database rather than silently opening one.
 *
 * Usage:
 *   node scripts/pg/provision.mjs <snapshot> agent_hq_pgtest
 *   pm2 start ecosystem.pgtest.config.js
 *   pm2 logs agent-hq-pgtest-api
 */
const fs = require('fs');
const path = require('path');

const repoRoot = __dirname;

const apiPort = process.env.AGENT_HQ_PGTEST_API_PORT || '3531';
const uiPort = process.env.AGENT_HQ_PGTEST_UI_PORT || '3530';
// agent_hq_pgtest_LEGACY, deliberately — the one provisioned with --keep-legacy-names.
//
// The application's SQL still says sprint_id / sprints. Pointing this at the RENAMED database
// (agent_hq_pgtest) would change two variables at once, and a failure could be either the
// engine swap or the rename. The renamed database exists and is smoke-tested separately; it
// becomes the target once the application speaks the new vocabulary.
const databaseUrl = process.env.AGENT_HQ_PGTEST_DATABASE_URL
  || 'postgresql://localhost/agent_hq_pgtest_legacy';

const nodeBin = [
  process.env.AGENT_HQ_NODE_BIN,
  '/opt/homebrew/opt/node@24/bin/node',
  '/usr/local/opt/node@24/bin/node',
  process.execPath,
].find((candidate) => candidate && fs.existsSync(candidate)) || 'node';

module.exports = {
  apps: [
    {
      name: 'agent-hq-pgtest-api',
      cwd: path.join(repoRoot, 'api'),
      script: nodeBin,
      args: 'dist/index.js',
      env: {
        NODE_ENV: 'production',
        PORT: apiPort,
        DATABASE_URL: databaseUrl,
        // Workspaces are scoped to this instance so a test run cannot reuse or reclaim a
        // workspace directory that the production instance is actively using.
        WORKSPACE_PARENT: path.join(repoRoot, '.pgtest-workspaces'),
        WORKSPACE_ROOT: path.join(repoRoot, '.pgtest-workspaces'),
      },
      autorestart: false, // a crash should stay visible during testing, not restart-loop
      watch: false,
      merge_logs: true,
    },
    {
      name: 'agent-hq-pgtest-ui',
      cwd: path.join(repoRoot, 'ui'),
      script: 'npm',
      args: 'run start',
      env: {
        NODE_ENV: 'production',
        PORT: uiPort,
        AGENT_HQ_INTERNAL_BASE_URL: `http://127.0.0.1:${apiPort}`,
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${apiPort}`,
      },
      autorestart: false,
      watch: false,
      merge_logs: true,
    },
  ],
};
