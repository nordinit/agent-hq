import { closeDb, getDb, getDbPath } from './client';
import { ensureConfiguredRuntimeMcpApiKey } from '../lib/mcpApiAuth';
import { initSchema } from './schema';
import { bootstrapRoutingAndWorkflowDefaults } from './bootstrapDefaults';
import { STARTUP_SCHEMA_LEDGER_CHECKSUM, STARTUP_SCHEMA_LEDGER_ID } from './startupVerifier';

async function main(): Promise<void> {
  await initSchema();
  const db = getDb();
  await bootstrapRoutingAndWorkflowDefaults(db);
  const runtimeMcpKey = await ensureConfiguredRuntimeMcpApiKey(db);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      applied_by TEXT NOT NULL DEFAULT 'agent-hq-api',
      app_commit TEXT NOT NULL DEFAULT ''
    )
  `);
  await db.run(`
    INSERT INTO schema_migrations (id, checksum, applied_by, app_commit)
    VALUES (?, ?, 'agent-hq-api', ?)
    ON CONFLICT(id) DO UPDATE SET
      checksum = excluded.checksum,
      applied_at = datetime('now'),
      applied_by = excluded.applied_by,
      app_commit = excluded.app_commit
  `, STARTUP_SCHEMA_LEDGER_ID, STARTUP_SCHEMA_LEDGER_CHECKSUM, process.env.AGENT_HQ_APP_COMMIT ?? process.env.GIT_COMMIT ?? '');

  const integrity = await db.value(`PRAGMA integrity_check`);
  if (integrity !== 'ok') {
    throw new Error(`Database integrity check failed: ${String(integrity)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    db_path: getDbPath(),
    integrity,
    runtime_mcp_api_key: runtimeMcpKey.status,
  }));
}

try {
  main();
} finally {
  closeDb();
}
