import Database from 'better-sqlite3';
import fs from 'fs';
import { getDbPath } from './client';

export const STARTUP_SCHEMA_LEDGER_ID = 'init_schema';
export const STARTUP_SCHEMA_LEDGER_CHECKSUM = 'initSchema';

export class SchemaMigrationRequiredError extends Error {
  readonly code = 'SCHEMA_MIGRATION_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'SchemaMigrationRequiredError';
  }
}

function migrationRequired(message: string): SchemaMigrationRequiredError {
  return new SchemaMigrationRequiredError(
    `${message}\n` +
    `Run the explicit database migration/install command before starting the API: cd api && npm run db:migrate.\n` +
    `Startup is intentionally non-mutating and will not create, alter, rebuild, backfill, repair, or seed the database.`
  );
}

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT 1 AS found
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ?
    LIMIT 1
  `).get(tableName) as { found?: number } | undefined;
  return row?.found === 1;
}

export function verifyStartupSchemaCurrent(dbPath: string = getDbPath()): void {
  if (!fs.existsSync(dbPath)) {
    throw migrationRequired(`Agent HQ database does not exist at ${dbPath}.`);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (!hasTable(db, 'schema_migrations')) {
      throw migrationRequired(`Agent HQ database at ${dbPath} has no schema_migrations ledger.`);
    }

    const row = db.prepare(`
      SELECT id, checksum
      FROM schema_migrations
      WHERE id = ?
      LIMIT 1
    `).get(STARTUP_SCHEMA_LEDGER_ID) as { id: string; checksum: string } | undefined;

    if (!row) {
      throw migrationRequired(`Agent HQ database at ${dbPath} is missing required schema migration '${STARTUP_SCHEMA_LEDGER_ID}'.`);
    }

    if (row.checksum !== STARTUP_SCHEMA_LEDGER_CHECKSUM) {
      throw migrationRequired(
        `Agent HQ database at ${dbPath} has schema migration '${STARTUP_SCHEMA_LEDGER_ID}' checksum '${row.checksum}', expected '${STARTUP_SCHEMA_LEDGER_CHECKSUM}'.`
      );
    }

    const integrity = db.prepare(`PRAGMA integrity_check`).pluck().get();
    if (integrity !== 'ok') {
      throw new Error(`Agent HQ database integrity check failed for ${dbPath}: ${String(integrity)}`);
    }
  } finally {
    db.close();
  }
}
