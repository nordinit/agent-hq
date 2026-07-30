import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { SqliteAdapter } from './SqliteAdapter';
import { runDbContractTests } from './contract';
import type { Db } from './types';
import { applySafeRewrites, findIncompatibilities, toPositionalParams, translateToPostgres } from './dialect';

/**
 * The adapter's whole purpose is that both engines behave identically, so the contract
 * tests are written once and are engine-agnostic. The PostgreSQL run of this same suite
 * lives in adapter.postgres.test.ts, which is skipped unless a database is configured.
 */
describe('dialect translation', () => {
  it('rewrites placeholders to $n', () => {
    expect(toPositionalParams('SELECT * FROM t WHERE a = ? AND b = ?'))
      .toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
  });

  it('never rewrites a ? inside a string literal', () => {
    // Agent HQ stores prose and JSON; a naive replace corrupts real data.
    expect(toPositionalParams(`SELECT * FROM t WHERE msg = 'why?' AND id = ?`))
      .toBe(`SELECT * FROM t WHERE msg = 'why?' AND id = $1`);
  });

  it('handles escaped quotes inside literals', () => {
    expect(toPositionalParams(`SELECT 'it''s a ? here', ? FROM t`))
      .toBe(`SELECT 'it''s a ? here', $1 FROM t`);
  });

  it('never rewrites a ? inside a comment or quoted identifier', () => {
    expect(toPositionalParams('SELECT "we?ird" FROM t -- what?\nWHERE a = ?'))
      .toBe('SELECT "we?ird" FROM t -- what?\nWHERE a = $1');
    expect(toPositionalParams('SELECT /* ? */ a FROM t WHERE b = ?'))
      .toBe('SELECT /* ? */ a FROM t WHERE b = $1');
  });

  it("keeps datetime('now') byte-identical in format", () => {
    // Migrated timestamp columns are still text. now()::text would emit a different
    // format and silently break ordering for every row written after the migration.
    const out = applySafeRewrites(`INSERT INTO t (created_at) VALUES (datetime('now'))`);
    expect(out).toContain(`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`);
    expect(out).not.toContain("datetime('now')");
  });

  it('does not rewrite SQL keywords appearing inside string literals', () => {
    const sql = `SELECT * FROM t WHERE note = 'call datetime(''now'') later'`;
    expect(applySafeRewrites(sql)).toBe(sql);
  });

  it('reports constructs it refuses to translate rather than guessing', () => {
    // A wrong rewrite that still parses is worse than a loud failure.
    expect(findIncompatibilities('SELECT * FROM t WHERE a IS ?')
      .map((i) => i.construct)).toContain('IS ?');
    expect(findIncompatibilities('SELECT rowid FROM t')
      .map((i) => i.construct)).toContain('rowid');
    expect(findIncompatibilities('INSERT OR REPLACE INTO t VALUES (1)')
      .map((i) => i.construct)).toContain('INSERT OR REPLACE / INSERT OR IGNORE');
  });

  it('does not flag an incompatibility that only appears inside a literal', () => {
    expect(findIncompatibilities(`SELECT * FROM t WHERE note = 'uses rowid internally'`))
      .toEqual([]);
  });

  it('applies rewrites and placeholders together', () => {
    expect(translateToPostgres(`UPDATE t SET updated_at = datetime('now') WHERE id = ?`))
      .toBe(`UPDATE t SET updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1`);
  });
});

runDbContractTests({
  name: 'SqliteAdapter',
  setup: async () => {
    // Resources are owned by this fixture rather than by module-level variables, so a
    // later test can never operate on a connection an earlier teardown already replaced.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-'));
    const raw = new Database(path.join(dir, 'test.db'));
    raw.pragma('foreign_keys = ON');
    // The contract asserts cascade behaviour, which silently degrades to a no-op if the
    // pragma did not take. Fail here with the real cause rather than three assertions later.
    const enforced = Number(raw.pragma('foreign_keys', { simple: true }));
    if (enforced !== 1) throw new Error(`test harness: foreign_keys is ${enforced}, expected 1`);
    raw.exec(`
      CREATE TABLE parents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
        label TEXT
      );
    `);
    return {
      db: new SqliteAdapter(raw),
      cleanup: async () => {
        if (raw.open) raw.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  },
});
