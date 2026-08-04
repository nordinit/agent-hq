import { closeDb, getDb, getDbPath, getEngine } from './client';
import { ensureConfiguredRuntimeMcpApiKey } from '../lib/mcpApiAuth';
import { initSchema } from './schema';
import { bootstrapRoutingAndWorkflowDefaults } from './bootstrapDefaults';
import { migrationStatus, runMigrations } from './pg/migrationRunner';
import { POSTGRES_MIGRATION_DIRS } from './pg/migrationDirs';
import { STARTUP_SCHEMA_LEDGER_CHECKSUM, STARTUP_SCHEMA_LEDGER_ID } from './startupVerifier';

/**
 * `npm run db:install` / `db:migrate` — the only supported way to create or upgrade a schema.
 *
 * Engine-aware, because the two do genuinely different things. SQLite has no migration system:
 * `initSchema()` is a 6,000-line idempotent repair engine that introspects the live file and
 * patches whatever it finds, and its ledger is one row whose "checksum" is the literal string
 * 'initSchema'. PostgreSQL has an ordered set of numbered SQL files, each checksummed, applied
 * once, and verified at boot.
 *
 * Until this existed the Postgres branch did not: `initSchema()` acquires the raw better-sqlite3
 * handle regardless of DATABASE_URL, so running db:install against a Postgres URL silently
 * initialised a SQLite file and then failed on the first query against the untouched target.
 * Postgres schemas were built by `scripts/pg/provision.mjs` shelling out to `psql -f`, and
 * `runMigrations()` — which applies each migration in its own transaction and records the ledger
 * correctly — had no caller anywhere in the repo.
 *
 * Both paths keep the non-mutating startup contract intact: this command migrates, and nothing
 * else does. See docs/database-migration-runbook.md.
 */

async function migratePostgres(): Promise<void> {
  const db = getDb();

  const before = await migrationStatus(db, POSTGRES_MIGRATION_DIRS);
  if (before.drifted.length > 0) {
    // Applying more migrations on top of an edited one buries the problem. An applied migration
    // whose text changed means the database and the repo disagree about what was run, and no
    // amount of forward migration resolves that.
    throw new Error(
      `Schema drift: ${before.drifted.map((entry) => entry.id).join(', ')} changed after being applied. `
      + 'Restore the file to what was applied, or record a new migration for the difference.',
    );
  }

  const applied = await runMigrations(db, POSTGRES_MIGRATION_DIRS);

  // Seeding is deliberately after the schema and deliberately part of install, not of boot.
  await bootstrapRoutingAndWorkflowDefaults(db);
  const runtimeMcpKey = await ensureConfiguredRuntimeMcpApiKey(db);

  const after = await migrationStatus(db, POSTGRES_MIGRATION_DIRS);
  if (after.pending.length > 0) {
    throw new Error(`Migrations still pending after apply: ${after.pending.join(', ')}`);
  }

  console.log(JSON.stringify({
    ok: true,
    engine: 'postgres',
    applied,
    already_applied: before.applied.length,
    runtime_mcp_api_key: runtimeMcpKey.status,
  }));
}

async function migrateSqlite(): Promise<void> {
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
    engine: 'sqlite',
    db_path: getDbPath(),
    integrity,
    runtime_mcp_api_key: runtimeMcpKey.status,
  }));
}

async function main(): Promise<void> {
  if (getEngine() === 'postgres') return await migratePostgres();
  return await migrateSqlite();
}

// main() is async, so `try { main() } finally { closeDb() }` was actively harmful: the finally
// ran on the very next tick and closed the database while the migration was still in flight,
// and a synchronous catch can never see an async rejection, so a failed migration printed its
// success JSON and exited 0. Chaining restores the intended order — migrate, then report the
// failure, then tear down — which is the best shape available under `module: commonjs`, where
// top-level await does not exist.
void main()
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
