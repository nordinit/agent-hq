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
    // `IS ?` is now rewritten to IS NOT DISTINCT FROM rather than merely reported, so the entry
    // that remains is a tripwire for one that somehow bypassed the rewrite.
    expect(findIncompatibilities('SELECT * FROM t WHERE a IS ?')
      .map((i) => i.construct)).toContain('IS ? / IS NOT ? (untranslated)');
    expect(findIncompatibilities('SELECT rowid FROM t')
      .map((i) => i.construct)).toContain('rowid');
    expect(findIncompatibilities('INSERT OR REPLACE INTO t VALUES (1)')
      .map((i) => i.construct)).toContain('INSERT OR REPLACE');
    // json_extract cannot be translated at all: PostgreSQL's equivalent takes bare key names
    // rather than SQLite's '$.a.b', so the caller has to change what it binds.
    expect(findIncompatibilities('SELECT json_extract(custom_fields_json, ?) FROM tasks')
      .map((i) => i.construct)).toContain('json_extract()');
  });

  it('translates INSERT OR IGNORE to ON CONFLICT DO NOTHING', () => {
    // PostgreSQL accepts a bare DO NOTHING — "any unique violation" — which is exactly what
    // OR IGNORE means, so no per-statement conflict target has to be inferred.
    expect(translateToPostgres('INSERT OR IGNORE INTO chat_messages (id, role) VALUES (?, ?)'))
      .toBe('INSERT INTO chat_messages (id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING');
  });

  it('places ON CONFLICT before a RETURNING clause', () => {
    // PostgresAdapter.run() appends RETURNING <pk> before translation runs, and ON CONFLICT
    // must precede it — appending blindly would produce invalid SQL for every insert that
    // needs lastInsertId.
    expect(translateToPostgres('INSERT OR IGNORE INTO t (a) VALUES (?) RETURNING "id"'))
      .toBe('INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING RETURNING "id"');
  });

  it('leaves an explicit ON CONFLICT alone rather than adding a second one', () => {
    const sql = 'INSERT OR IGNORE INTO t (a) VALUES (?) ON CONFLICT(a) DO UPDATE SET a = excluded.a';
    expect(translateToPostgres(sql))
      .toBe('INSERT INTO t (a) VALUES ($1) ON CONFLICT(a) DO UPDATE SET a = excluded.a');
  });

  it('casts a bare parameter used in IS NULL so PostgreSQL can type it', () => {
    // The optional-filter idiom. Without the cast PostgreSQL refuses the statement with
    // "could not determine data type of parameter $1" before it ever runs.
    expect(translateToPostgres('SELECT * FROM s WHERE (? IS NULL OR s.agent_id = ?)'))
      .toBe('SELECT * FROM s WHERE ($1::text IS NULL OR s.agent_id = $2)');
    expect(translateToPostgres('SELECT * FROM s WHERE ? IS NOT NULL'))
      .toBe('SELECT * FROM s WHERE $1::text IS NOT NULL');
  });

  it('casts round() to numeric, keeping nested calls intact', () => {
    // PostgreSQL has no round(double precision, int), which is what AVG()/division produces.
    // The nested parens and the top-level comma are why this cannot be a regex.
    // No cast back to float: PostgresAdapter's numeric type parser returns numbers.
    expect(applySafeRewrites('SELECT round(AVG(x) * 100.0 / COUNT(*), 1) FROM t'))
      .toBe('SELECT round((AVG(x) * 100.0 / COUNT(*))::numeric, 1) FROM t');
    // Single-argument round() is already valid for double precision.
    expect(applySafeRewrites('SELECT round(x) FROM t')).toBe('SELECT round(x) FROM t');
    // An identifier that merely ends in "round" must not be rewritten.
    expect(applySafeRewrites('SELECT my_round(x, 1) FROM t')).toBe('SELECT my_round(x, 1) FROM t');
  });

  it("translates strftime('%s', x) to an epoch extraction", () => {
    // strftime() does not exist in PostgreSQL, so the statement fails to parse outright:
    // "function strftime(unknown, text) does not exist". This is the exact expression from the
    // workflow detail read model, which made every workflow page in the UI error.
    expect(applySafeRewrites(
      "SELECT AVG((strftime('%s', updated_at) - strftime('%s', created_at)) * 1000) FROM tasks",
    )).toBe(
      'SELECT AVG((EXTRACT(EPOCH FROM (updated_at)::timestamp)'
      + ' - EXTRACT(EPOCH FROM (created_at)::timestamp)) * 1000) FROM tasks',
    );
    // Timestamps are stored as text, so the cast has to survive an expression argument too.
    expect(applySafeRewrites("SELECT strftime('%s', COALESCE(a, b)) FROM t"))
      .toBe('SELECT EXTRACT(EPOCH FROM (COALESCE(a, b))::timestamp) FROM t');
    // Any other format is left alone rather than guessed at — strftime and to_char do not share
    // a specifier language, so a mechanical mapping would silently change the output format.
    expect(applySafeRewrites("SELECT strftime('%Y-%m-%d', created_at) FROM t"))
      .toBe("SELECT strftime('%Y-%m-%d', created_at) FROM t");
    // An identifier merely ending in "strftime" must not be rewritten.
    expect(applySafeRewrites("SELECT my_strftime('%s', x) FROM t"))
      .toBe("SELECT my_strftime('%s', x) FROM t");
  });

  it('translates julianday() to an equivalent epoch expression', () => {
    // 2440587.5 is the Julian day of the Unix epoch, so this reproduces julianday() exactly
    // rather than only being correct inside a subtraction.
    expect(applySafeRewrites('SELECT julianday(created_at) FROM t'))
      .toBe('SELECT (EXTRACT(EPOCH FROM (created_at)::timestamp) / 86400.0 + 2440587.5) FROM t');
    // 'now' must resolve in UTC. PostgreSQL's own 'now'::timestamp is LOCAL time, which would
    // skew every age by the machine's UTC offset while still looking plausible.
    expect(applySafeRewrites("SELECT julianday('now') FROM t"))
      .toBe(`SELECT (EXTRACT(EPOCH FROM (now() AT TIME ZONE 'utc')) / 86400.0 + 2440587.5) FROM t`);
    // The argument may contain its own parens and commas.
    expect(applySafeRewrites('SELECT julianday(COALESCE(a, b)) FROM t'))
      .toBe('SELECT (EXTRACT(EPOCH FROM (COALESCE(a, b))::timestamp) / 86400.0 + 2440587.5) FROM t');
    // An identifier merely ending in "julianday" must not be rewritten.
    expect(applySafeRewrites('SELECT my_julianday(x) FROM t')).toBe('SELECT my_julianday(x) FROM t');
  });

  it("reports an untranslatable strftime format as an incompatibility", () => {
    const found = findIncompatibilities("SELECT strftime('%Y', created_at) FROM t");
    expect(found.map(entry => entry.construct)).toContain("strftime with a non-'%s' format");
    // The translated epoch form must not be reported — it is already valid PostgreSQL.
    expect(findIncompatibilities("SELECT strftime('%s', created_at) FROM t")).toEqual([]);
  });

  it('rewrites SQLite null-safe IS / IS NOT comparisons', () => {
    // SQLite overloads IS / IS NOT to accept any operand; PostgreSQL allows only NULL, TRUE,
    // FALSE, UNKNOWN or DISTINCT FROM, so a parameter there is a syntax error. Found by running
    // projectPortability against PostgreSQL, where every project import threw
    // `syntax error at or near "$3"`.
    expect(translateToPostgres(`UPDATE t SET a = ? WHERE b = ? AND (c IS NOT ?)`))
      .toBe(`UPDATE t SET a = $1 WHERE b = $2 AND (c IS DISTINCT FROM $3)`);
    expect(translateToPostgres(`SELECT * FROM t WHERE a IS ?`))
      .toBe(`SELECT * FROM t WHERE a IS NOT DISTINCT FROM $1`);
  });

  it('does not touch IS NULL or IS NOT NULL', () => {
    // The pattern requires a placeholder, so these cannot match.
    expect(applySafeRewrites(`SELECT * FROM t WHERE a IS NULL AND b IS NOT NULL`))
      .toBe(`SELECT * FROM t WHERE a IS NULL AND b IS NOT NULL`);
  });

  it('quotes mixed-case aliases so PostgreSQL does not fold them to lower case', () => {
    // Unquoted, `AS instanceId` returns a column named `instanceid`, row.instanceId reads
    // undefined, and Number(undefined) is NaN — which is how every id in an authorization scope
    // set became NaN in production and denied every agent lifecycle writes on its own run.
    expect(applySafeRewrites('SELECT ji.id AS instanceId, ji.task_id AS taskId FROM job_instances ji'))
      .toBe('SELECT ji.id AS "instanceId", ji.task_id AS "taskId" FROM job_instances ji');
  });

  it('leaves CAST type names and lower-case aliases alone when quoting aliases', () => {
    // The guard against quoting a type name: all-caps has no lower-case start, all-lower has no
    // upper-case letter, and a multi-word type is not a single identifier.
    expect(applySafeRewrites('SELECT CAST(x AS BIGINT) AS total FROM t'))
      .toBe('SELECT CAST(x AS BIGINT) AS total FROM t');
    expect(applySafeRewrites('SELECT CAST(x AS text) FROM t')).toBe('SELECT CAST(x AS text) FROM t');
    // An alias that is already quoted must not be double-quoted.
    expect(applySafeRewrites('SELECT a AS "keepMe" FROM t')).toBe('SELECT a AS "keepMe" FROM t');
  });

  it('translates json_set with a literal path to jsonb_set', () => {
    // The path notations differ ('$.runtimeEnd' vs '{runtimeEnd}'), and the nested COALESCE has
    // to survive as a single argument.
    expect(translateToPostgres(
      `UPDATE job_instances SET response = json_set(COALESCE(response, '{}'), '$.runtimeEnd', json(?)) WHERE id = ?`,
    )).toBe(
      `UPDATE job_instances SET response = jsonb_set((COALESCE(response, '{}'))::jsonb, '{runtimeEnd}', ($1)::jsonb) WHERE id = $2`,
    );
  });

  it('translates a nested json_set path to a text[] path', () => {
    expect(applySafeRewrites(`SELECT json_set(doc, '$.a.b', json('1'))`))
      .toBe(`SELECT jsonb_set((doc)::jsonb, '{a,b}', ('1')::jsonb)`);
  });

  it('leaves json_set with a bound-parameter path untranslated for reporting', () => {
    // Silently guessing a path here would corrupt the document rather than fail.
    const sql = `SELECT json_set(doc, ?, json('1'))`;
    expect(applySafeRewrites(sql)).toBe(sql);
    expect(findIncompatibilities(sql).map((i) => i.construct))
      .toContain('json_set() with a non-literal path');
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
