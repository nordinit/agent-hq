import { closeDb, getDb, getDbPath } from './client';
import fs from 'fs';

function main(): void {
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
  const hasMigrationsTable = Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'schema_migrations'
  `).get());
  const migrations = hasMigrationsTable
    ? db.prepare(`
        SELECT id, checksum, applied_at, applied_by, app_commit
        FROM schema_migrations
        ORDER BY applied_at ASC, id ASC
      `).all()
    : [];
  const integrity = db.prepare(`PRAGMA integrity_check`).pluck().get();
  console.log(JSON.stringify({
    ok: integrity === 'ok',
    db_path: dbPath,
    exists: true,
    integrity,
    migrations,
  }, null, 2));
  if (integrity !== 'ok') process.exitCode = 1;
}

try {
  main();
} finally {
  closeDb();
}
