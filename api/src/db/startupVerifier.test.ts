import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SchemaMigrationRequiredError,
  STARTUP_SCHEMA_LEDGER_CHECKSUM,
  STARTUP_SCHEMA_LEDGER_ID,
  verifyStartupSchemaCurrent,
} from './startupVerifier';

function tempDbPath(prefix: string): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, dbPath: path.join(dir, 'agent-hq-test.db') };
}

describe('verifyStartupSchemaCurrent', () => {
  it('fails without creating a missing database', () => {
    const { dir, dbPath } = tempDbPath('agent-hq-missing-schema-');
    try {
      expect(() => verifyStartupSchemaCurrent(dbPath)).toThrow(SchemaMigrationRequiredError);
      expect(fs.existsSync(dbPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails against a legacy database without mutating schema or ledger state', () => {
    const { dir, dbPath } = tempDbPath('agent-hq-legacy-schema-');
    try {
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);`);
      const beforeTables = db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all();
      db.close();

      expect(() => verifyStartupSchemaCurrent(dbPath)).toThrow(/schema_migrations/);

      const after = new Database(dbPath, { readonly: true, fileMustExist: true });
      const afterTables = after.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all();
      after.close();
      expect(afterTables).toEqual(beforeTables);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when the explicit migration ledger is current', () => {
    const { dir, dbPath } = tempDbPath('agent-hq-current-schema-');
    try {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE schema_migrations (
          id         TEXT PRIMARY KEY,
          checksum   TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now')),
          applied_by TEXT NOT NULL DEFAULT 'agent-hq-api',
          app_commit TEXT NOT NULL DEFAULT ''
        );
      `);
      db.prepare(`INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)`).run(
        STARTUP_SCHEMA_LEDGER_ID,
        STARTUP_SCHEMA_LEDGER_CHECKSUM,
      );
      db.close();

      expect(() => verifyStartupSchemaCurrent(dbPath)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
