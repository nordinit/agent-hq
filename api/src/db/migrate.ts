import { closeDb, getDb, getDbPath } from './client';
import { ensureConfiguredRuntimeMcpApiKey } from '../lib/mcpApiAuth';
import { initSchema } from './schema';
import { bootstrapRoutingAndWorkflowDefaults } from './bootstrapDefaults';
import { STARTUP_SCHEMA_LEDGER_CHECKSUM, STARTUP_SCHEMA_LEDGER_ID } from './startupVerifier';

function main(): void {
  initSchema();
  const db = getDb();
  bootstrapRoutingAndWorkflowDefaults(db);
  const runtimeMcpKey = ensureConfiguredRuntimeMcpApiKey(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      applied_by TEXT NOT NULL DEFAULT 'agent-hq-api',
      app_commit TEXT NOT NULL DEFAULT ''
    )
  `);
  db.prepare(`
    INSERT INTO schema_migrations (id, checksum, applied_by, app_commit)
    VALUES (?, ?, 'agent-hq-api', ?)
    ON CONFLICT(id) DO UPDATE SET
      checksum = excluded.checksum,
      applied_at = datetime('now'),
      applied_by = excluded.applied_by,
      app_commit = excluded.app_commit
  `).run(
    STARTUP_SCHEMA_LEDGER_ID,
    STARTUP_SCHEMA_LEDGER_CHECKSUM,
    process.env.AGENT_HQ_APP_COMMIT ?? process.env.GIT_COMMIT ?? '',
  );

  const integrity = db.prepare(`PRAGMA integrity_check`).pluck().get();
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
