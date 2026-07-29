import Database from 'better-sqlite3';
import fs from 'fs';
import { getDb, getDbPath } from './client';
import { foreignKeyEnforcementIntentionallyDisabled } from './foreignKeyGuard';

export const STARTUP_SCHEMA_LEDGER_ID = 'init_schema';
export const STARTUP_SCHEMA_LEDGER_CHECKSUM = 'initSchema';

export class SchemaMigrationRequiredError extends Error {
  readonly code = 'SCHEMA_MIGRATION_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'SchemaMigrationRequiredError';
  }
}

export class ForeignKeyEnforcementDisabledError extends Error {
  readonly code = 'FOREIGN_KEY_ENFORCEMENT_DISABLED';

  constructor(message: string) {
    super(message);
    this.name = 'ForeignKeyEnforcementDisabledError';
  }
}

export interface ForeignKeyEnforcementOptions {
  /** Throw ForeignKeyEnforcementDisabledError when enforcement is off. Default true. */
  throwOnViolation?: boolean;
  /** Force enforcement back ON before reporting, stopping further orphan creation. Default false. */
  restore?: boolean;
}

/**
 * Asserts foreign-key enforcement is still ON for the shared application connection.
 *
 * The connection is a process-wide singleton, so a single leaked
 * `PRAGMA foreign_keys = OFF` in schema/tenant migration code disables ON DELETE
 * CASCADE for the whole process and silently accumulates orphan rows. This is the
 * tripwire that makes such a regression impossible to miss.
 *
 * Returns true when enforcement is on. When it is off, it always logs an unmissable
 * error, optionally forces enforcement back on, and (by default) throws.
 */
export function assertForeignKeyEnforcementEnabled(
  db: Database.Database = getDb(),
  context = 'startup',
  options: ForeignKeyEnforcementOptions = {},
): boolean {
  const enforced = (): boolean => Number(db.pragma('foreign_keys', { simple: true })) === 1;
  if (enforced()) return true;

  // Schema and tenant migrations disable enforcement on purpose while rebuilding
  // tables, and they re-enter this code path: initSchema() opens a disable window for
  // its legacy workflow-policy DDL and then calls ensureTenantSchema() inside it.
  // Reporting there would be a false alarm, and force-restoring would switch
  // enforcement back ON in the middle of DDL that requires it OFF. Only a pragma that
  // is off with no tracked window open is a leak.
  if (foreignKeyEnforcementIntentionallyDisabled()) return false;

  const throwOnViolation = options.throwOnViolation !== false;
  const message =
    `SQLite foreign-key enforcement is OFF after ${context}. ` +
    `ON DELETE CASCADE is not running, so deletes are silently orphaning child rows. ` +
    `A migration disabled 'PRAGMA foreign_keys' on the shared connection and never restored it — ` +
    `route every rebuild through withForeignKeysDisabled() in api/src/lib/tenantContext.ts.`;

  console.error('='.repeat(100));
  console.error(`[db] FATAL DATA INTEGRITY DEFECT: ${message}`);
  console.error('='.repeat(100));

  if (options.restore) {
    db.pragma('foreign_keys = ON');
    const restored = enforced();
    console.error(
      restored
        ? '[db] Foreign-key enforcement was force-restored to ON. Find and fix the leaking migration.'
        : '[db] Foreign-key enforcement could NOT be force-restored; the connection is still unsafe.'
    );
  }

  if (throwOnViolation) throw new ForeignKeyEnforcementDisabledError(message);
  return false;
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

  // The handle above is a throwaway read-only connection; foreign-key enforcement
  // only matters on the shared application connection the API actually writes through.
  if (dbPath === getDbPath()) {
    assertForeignKeyEnforcementEnabled(getDb(), 'startup schema verification');
  }
}
