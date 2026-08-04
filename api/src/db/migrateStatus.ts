import { closeDb, getDb, getDbPath, getEngine } from './client';
import { migrationStatus } from './pg/migrationRunner';
import { POSTGRES_MIGRATION_DIRS } from './pg/migrationDirs';
import fs from 'fs';

/**
 * `npm run db:migrate:status` — what the database thinks it has, versus what the repo says.
 *
 * The two engines answer different questions. SQLite reports one ledger row and a PRAGMA
 * integrity check on a file. PostgreSQL reports the ordered migration set: applied, pending,
 * and drifted — the last being an applied migration whose text has since changed, which is the
 * failure that makes the database and the repo disagree about what was run.
 */
async function reportPostgres(): Promise<void> {
  const db = getDb();
  const status = await migrationStatus(db, POSTGRES_MIGRATION_DIRS);
  const ok = status.pending.length === 0 && status.drifted.length === 0;
  console.log(JSON.stringify({
    ok,
    engine: 'postgres',
    applied: status.applied,
    pending: status.pending,
    drifted: status.drifted,
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (getEngine() === 'postgres') return await reportPostgres();

  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.log(JSON.stringify({
      ok: true,
      db_path: dbPath,
      exists: false,
      integrity: null,
      migrations: [],
    }, null, 2));
    return;
  }

  const db = getDb();
  const hasMigrationsTable = Boolean(await db.get(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'schema_migrations'
  `));
  const migrations = hasMigrationsTable
    ? await db.all(`
        SELECT id, checksum, applied_at, applied_by, app_commit
        FROM schema_migrations
        ORDER BY applied_at ASC, id ASC
      `)
    : [];
  const integrity = await db.value(`PRAGMA integrity_check`);
  console.log(JSON.stringify({
    ok: integrity === 'ok',
    engine: 'sqlite',
    db_path: dbPath,
    exists: true,
    integrity,
    migrations,
  }, null, 2));
  if (integrity !== 'ok') process.exitCode = 1;
}

// See migrate.ts: main() is async, so the original try/finally closed the database before the
// work finished and let rejections pass silently with exit code 0.
void main()
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
