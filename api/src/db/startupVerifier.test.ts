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
import { SqliteAdapter } from "./adapter/SqliteAdapter";

function tempDbPath(prefix: string): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, dbPath: path.join(dir, 'agent-hq-test.db') };
}

describe('verifyStartupSchemaCurrent', () => {
  it('fails without creating a missing database', async () => {
    const { dir, dbPath } = tempDbPath('agent-hq-missing-schema-');
    try {
      // expect(fn).toThrow() calls fn SYNCHRONOUSLY. An async fn returns a promise instead of
      // throwing, so not.toThrow() passed trivially while the call ran DETACHED — and then
      // rejected after teardown closed the connection, killing the jest worker. toThrow() on an
      // async fn simply never matched. Both forms must go through the promise.
      await expect(verifyStartupSchemaCurrent(dbPath)).rejects.toThrow(SchemaMigrationRequiredError);
      expect(fs.existsSync(dbPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails against a legacy database without mutating schema or ledger state', async () => {
    const { dir, dbPath } = tempDbPath('agent-hq-legacy-schema-');
    try {
      const dbRaw = new Database(dbPath);
        const db = new SqliteAdapter(dbRaw);
      await db.exec(`CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);`);
      const beforeTables = await db.all(`SELECT name, sql FROM sqlite_master ORDER BY name`);
      dbRaw.close();

      await expect(verifyStartupSchemaCurrent(dbPath)).rejects.toThrow(/schema_migrations/);

      const afterRaw = new Database(dbPath, { readonly: true, fileMustExist: true });
        const after = new SqliteAdapter(afterRaw);
      const afterTables = await after.all(`SELECT name, sql FROM sqlite_master ORDER BY name`);
      afterRaw.close();
      expect(afterTables).toEqual(beforeTables);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when the explicit migration ledger is current', async () => {
    const { dir, dbPath } = tempDbPath('agent-hq-current-schema-');
    try {
      const dbRaw = new Database(dbPath);
        const db = new SqliteAdapter(dbRaw);
      await db.exec(`
        CREATE TABLE schema_migrations (
          id         TEXT PRIMARY KEY,
          checksum   TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now')),
          applied_by TEXT NOT NULL DEFAULT 'agent-hq-api',
          app_commit TEXT NOT NULL DEFAULT ''
        );
      `);
      await db.run(`INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)`, STARTUP_SCHEMA_LEDGER_ID, STARTUP_SCHEMA_LEDGER_CHECKSUM);
      dbRaw.close();

      await verifyStartupSchemaCurrent(dbPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
