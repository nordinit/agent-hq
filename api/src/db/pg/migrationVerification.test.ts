import fs from 'fs';
import os from 'os';
import path from 'path';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { loadMigrations, migrationStatus, runMigrations, verifyMigrationsCurrent } from './migrationRunner';

/**
 * The boot gate must refuse to serve on a schema that is behind the code.
 *
 * It did not. verifyStartupSchema once checked only the detached baseline, so numbered
 * migrations were never verified and a pending migration started cleanly. That happened
 * because migrations 10 and 11 sat in the sequence deliberately unapplied — verifying the real
 * directory would have refused to boot production, so the check was aimed where it could not
 * fail. Those two now live in db/pg-migrations/staged.
 */

function writeDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-migrations-'));
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql);
  }
  return dir;
}

/**
 * A ledger stub: enough of Db for the runner's reads, with no engine behind it.
 *
 * `exists` models whether schema_migrations is there yet, which the runner now asks before
 * reading — on a fresh database the first migration is the one that creates it.
 */
function ledgerStub(applied: Array<{ id: string; checksum: string }>, exists = true) {
  return {
    dialect: 'postgres' as const,
    inTransaction: false,
    exec: async () => {},
    all: async () => applied,
    get: async () => (exists ? { present: 1 } : undefined),
    run: async () => ({ changes: 0, lastInsertId: 0 }),
    value: async () => undefined,
    withTransaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn({}),
    close: async () => {},
  };
}

type RunnerEvent = {
  kind: 'tx:start' | 'tx:commit' | 'tx:rollback' | 'exec' | 'run';
  sql?: string;
  params?: unknown[];
};

/** Stateful enough to prove ledger adoption and transaction ordering without PostgreSQL. */
function runnerStub(applied: Array<{ id: string; checksum: string }> = [], exists = true) {
  const ledger = new Map(applied.map((row) => [row.id, row.checksum]));
  const events: RunnerEvent[] = [];
  let hasLedger = exists;
  const rows = () => [...ledger].map(([id, checksum]) => ({ id, checksum }));

  const exec = async (sql: string) => {
    events.push({ kind: 'exec', sql });
    if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) hasLedger = true;
  };
  const run = async (sql: string, ...params: unknown[]) => {
    events.push({ kind: 'run', sql, params });
    if (/INSERT INTO schema_migrations/i.test(sql)) {
      ledger.set(String(params[0]), String(params[1]));
    }
    return { changes: 1, lastInsertId: null };
  };

  const tx = {
    dialect: 'postgres' as const,
    inTransaction: true,
    exec,
    run,
    all: async () => rows(),
    get: async () => (hasLedger ? { present: 1 } : undefined),
    value: async () => undefined,
    withTransaction: async <T,>(fn: (nested: unknown) => Promise<T>) => fn(tx),
    close: async () => {},
  };
  const db = {
    ...tx,
    inTransaction: false,
    withTransaction: async <T,>(fn: (transaction: unknown) => Promise<T>) => {
      events.push({ kind: 'tx:start' });
      try {
        const result = await fn(tx);
        events.push({ kind: 'tx:commit' });
        return result;
      } catch (error) {
        events.push({ kind: 'tx:rollback' });
        throw error;
      }
    },
  };

  return { db, events, rows };
}

describe('migration loading', () => {
  it('orders files by numeric prefix', () => {
    const migrations = writeDir({
      '03-foreign-keys.sql': 'SELECT 3;',
      '01-tables.sql': 'SELECT 1;',
      '14-audit.sql': 'SELECT 14;',
      '02-indexes.sql': 'SELECT 2;',
    });
    expect(loadMigrations(migrations).map((m) => m.id))
      .toEqual(['01-tables.sql', '02-indexes.sql', '03-foreign-keys.sql', '14-audit.sql']);
  });

  it('ships one authoritative directory whose first migration is the folded baseline', () => {
    expect(POSTGRES_MIGRATION_DIRS).toHaveLength(1);
    expect(path.basename(POSTGRES_MIGRATION_DIRS[0])).toBe('pg-migrations');

    const [baseline] = loadMigrations(POSTGRES_MIGRATION_DIRS);
    expect(baseline.id).toBe('00-baseline.sql');
    expect(baseline.sql).not.toMatch(/CREATE TABLE schema_migrations/i);
    const sections = ['tables', 'indexes', 'foreign-keys']
      .map((name) => baseline.sql.indexOf(`-- === BASELINE SECTION: ${name} ===`));
    expect(sections[0]).toBeGreaterThanOrEqual(0);
    expect(sections[0]).toBeLessThan(sections[1]);
    expect(sections[1]).toBeLessThan(sections[2]);
  });

  it('ignores subdirectories, so a staged migration is not pending', () => {
    // db/pg-migrations/staged holds migrations written for a project that has not started.
    // If they counted as pending the API would refuse to boot on a correct schema.
    const dir = writeDir({ '12-real.sql': 'SELECT 1;' });
    fs.mkdirSync(path.join(dir, 'staged'));
    fs.writeFileSync(path.join(dir, 'staged', '10-rename.sql'), 'SELECT 10;');
    expect(loadMigrations(dir).map((m) => m.id)).toEqual(['12-real.sql']);
  });

  it('still refuses a file with no numeric prefix', () => {
    const dir = writeDir({ 'rename-things.sql': 'SELECT 1;' });
    expect(() => loadMigrations(dir)).toThrow(/no numeric prefix/);
  });
});

describe('verifyMigrationsCurrent', () => {
  it('refuses to serve when a migration has not been applied', async () => {
    const dir = writeDir({ '12-applied.sql': 'SELECT 1;', '13-pending.sql': 'SELECT 2;' });
    const [applied] = loadMigrations(dir);
    const db = ledgerStub([{ id: applied.id, checksum: applied.checksum }]);

    await expect(verifyMigrationsCurrent(db as never, dir))
      .rejects.toThrow(/13-pending\.sql/);
  });

  it('refuses to serve when an applied migration has been edited', async () => {
    const dir = writeDir({ '12-applied.sql': 'SELECT 1;' });
    const db = ledgerStub([{ id: '12-applied.sql', checksum: 'a-checksum-from-before-the-edit' }]);

    await expect(verifyMigrationsCurrent(db as never, dir))
      .rejects.toThrow(/drift/i);
  });

  it('serves when every migration in the authoritative directory is applied', async () => {
    const migrations = writeDir({ '00-baseline.sql': 'SELECT 1;', '14-audit.sql': 'SELECT 14;' });
    const all = loadMigrations(migrations);
    const db = ledgerStub(all.map((m) => ({ id: m.id, checksum: m.checksum })));

    await expect(verifyMigrationsCurrent(db as never, migrations)).resolves.toBeUndefined();
  });

  it('refuses a ledger migration that is absent from this release', async () => {
    const dir = writeDir({ '00-baseline.sql': 'SELECT 1;' });
    const [baseline] = loadMigrations(dir);
    const db = ledgerStub([
      { id: baseline.id, checksum: baseline.checksum },
      { id: '99-from-a-newer-release.sql', checksum: 'future-checksum' },
    ]);

    const status = await migrationStatus(db as never, dir);
    expect(status.unexpected).toEqual([{
      id: '99-from-a-newer-release.sql',
      recorded: 'future-checksum',
    }]);
    await expect(verifyMigrationsCurrent(db as never, dir))
      .rejects.toThrow(/recorded but absent.*99-from-a-newer-release\.sql/i);
    await expect(runMigrations(db as never, dir))
      .rejects.toThrow(/ledger migration.*99-from-a-newer-release\.sql/is);
  });

  it('accepts only the exact retained legacy ledger entries', async () => {
    const dir = writeDir({ '00-baseline.sql': 'SELECT 1;' });
    const [baseline] = loadMigrations(dir);
    const legacy = [
      { id: '01-tables.sql', checksum: '55312bc3474ba438' },
      { id: '02-indexes.sql', checksum: 'c5ca4ac7657a4b47' },
      { id: '03-foreign-keys.sql', checksum: '6adec7d22ec4e219' },
      { id: 'init_schema', checksum: 'initSchema' },
    ];

    await expect(verifyMigrationsCurrent(ledgerStub([
      { id: baseline.id, checksum: baseline.checksum },
      ...legacy,
    ]) as never, dir)).resolves.toBeUndefined();

    const changed = legacy.map((row) => row.id === 'init_schema'
      ? { ...row, checksum: 'not-the-known-provenance-value' }
      : row);
    const status = await migrationStatus(ledgerStub([
      { id: baseline.id, checksum: baseline.checksum },
      ...changed,
    ]) as never, dir);
    expect(status.unexpected).toEqual([{
      id: 'init_schema',
      recorded: 'not-the-known-provenance-value',
      expected: 'initSchema',
    }]);
  });

  it('treats a missing ledger as nothing applied rather than creating one', async () => {
    // Reading must not create. A fresh database has no ledger until explicit db:install applies
    // migration 00 and records it in the runner-owned table.
    const dir = writeDir({ '00-baseline.sql': 'SELECT 1;' });
    const status = await migrationStatus(ledgerStub([], false) as never, dir);
    expect(status.pending).toEqual(['00-baseline.sql']);
    expect(status.applied).toEqual([]);
  });

  it('reports a migration missing from the ledger as pending, not as drift', async () => {
    // The two failures need different remedies — apply it, versus work out who edited it — so
    // collapsing them into one message would send the operator down the wrong path.
    const dir = writeDir({ '12-a.sql': 'SELECT 1;', '13-b.sql': 'SELECT 2;' });
    const status = await migrationStatus(ledgerStub([]) as never, dir);
    expect(status.pending).toEqual(['12-a.sql', '13-b.sql']);
    expect(status.drifted).toEqual([]);
  });
});

describe('folded baseline migration', () => {
  const legacyBaseline = [
    { id: '01-tables.sql', checksum: '55312bc3474ba438' },
    { id: '02-indexes.sql', checksum: 'c5ca4ac7657a4b47' },
    { id: '03-foreign-keys.sql', checksum: '6adec7d22ec4e219' },
  ];

  it('applies migration 00 and creates the runner-owned ledger on a fresh database', async () => {
    const dir = writeDir({ '00-baseline.sql': 'CREATE TABLE example (id bigint);' });
    const { db, events, rows } = runnerStub([], false);
    const [baseline] = loadMigrations(dir);

    await expect(runMigrations(db as never, dir)).resolves.toEqual(['00-baseline.sql']);
    expect(rows()).toEqual([{ id: baseline.id, checksum: baseline.checksum }]);
    expect(events.map(({ kind }) => kind)).toEqual([
      'tx:start', 'exec', 'exec', 'run', 'tx:commit',
    ]);
    expect(events[1].sql).toContain('CREATE TABLE example');
    expect(events[2].sql).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
  });

  it('adopts the exact legacy 01/02/03 ledger without executing migration 00', async () => {
    const dir = writeDir({ '00-baseline.sql': 'CREATE TABLE must_not_run (id bigint);' });
    const { db, events, rows } = runnerStub(legacyBaseline);
    const [baseline] = loadMigrations(dir);

    await expect(runMigrations(db as never, dir)).resolves.toEqual([]);
    expect(rows()).toEqual([...legacyBaseline, { id: baseline.id, checksum: baseline.checksum }]);
    expect(events.some(({ sql }) => sql?.includes('CREATE TABLE must_not_run'))).toBe(false);
    expect(events.map(({ kind }) => kind)).toEqual(['tx:start', 'exec', 'run', 'tx:commit']);
  });

  it('fails closed on a partial legacy baseline ledger', async () => {
    const dir = writeDir({ '00-baseline.sql': 'CREATE TABLE must_not_run (id bigint);' });
    const { db, events, rows } = runnerStub(legacyBaseline.slice(0, 1));

    await expect(runMigrations(db as never, dir)).rejects.toThrow(/partial.*missing 02-indexes\.sql, 03-foreign-keys\.sql/is);
    expect(rows()).toEqual(legacyBaseline.slice(0, 1));
    expect(events.some(({ sql }) => sql?.includes('CREATE TABLE must_not_run'))).toBe(false);
    expect(events.at(-1)?.kind).toBe('tx:rollback');
  });

  it('fails closed when a legacy baseline checksum does not match', async () => {
    const dir = writeDir({ '00-baseline.sql': 'CREATE TABLE must_not_run (id bigint);' });
    const changed = legacyBaseline.map((row, i) => i === 1 ? { ...row, checksum: 'changed' } : row);
    const { db, events, rows } = runnerStub(changed);

    await expect(runMigrations(db as never, dir)).rejects.toThrow(
      /02-indexes\.sql: recorded changed, expected c5ca4ac7657a4b47/,
    );
    expect(rows()).toEqual(changed);
    expect(events.some(({ sql }) => sql?.includes('CREATE TABLE must_not_run'))).toBe(false);
    // The status preflight recognizes the bad retained checksum before opening a transaction.
    expect(events).toEqual([]);
  });

  it('leaves adoption to the explicit migration command, never status or boot', async () => {
    const dir = writeDir({ '00-baseline.sql': 'CREATE TABLE must_not_run (id bigint);' });
    const { db, events, rows } = runnerStub(legacyBaseline);

    await expect(migrationStatus(db as never, dir)).resolves.toMatchObject({
      pending: ['00-baseline.sql'],
      drifted: [],
    });
    await expect(verifyMigrationsCurrent(db as never, dir)).rejects.toThrow(/00-baseline\.sql/);
    expect(rows()).toEqual(legacyBaseline);
    expect(events).toEqual([]);
  });

  it('strips file-level BEGIN/COMMIT only for execution and records atomically', async () => {
    const wrapped = [
      '-- wrapper test with a dollar-quoted body',
      'BEGIN;',
      'DO $body$ BEGIN RAISE NOTICE \'COMMIT; inside body\'; END $body$;',
      'CREATE TABLE wrapped_example (id bigint);',
      'COMMIT;',
      '',
    ].join('\n');
    const dir = writeDir({ '12-wrapped.sql': wrapped });
    const [migration] = loadMigrations(dir);
    const { db, events, rows } = runnerStub([]);

    await expect(runMigrations(db as never, dir)).resolves.toEqual(['12-wrapped.sql']);
    const executed = events.find(({ kind, sql }) => kind === 'exec' && sql?.includes('wrapped_example'))?.sql ?? '';
    expect(executed).not.toMatch(/^\s*(?:--[^\n]*\n\s*)*BEGIN\s*;/i);
    expect(executed).not.toMatch(/\bCOMMIT\s*;\s*$/i);
    expect(executed).toContain("RAISE NOTICE 'COMMIT; inside body'");
    expect(rows()).toEqual([{ id: migration.id, checksum: migration.checksum }]);
    expect(events.map(({ kind }) => kind)).toEqual([
      'tx:start', 'exec', 'exec', 'run', 'tx:commit',
    ]);
  });
});

describe('the status command does not migrate', () => {
  it('does not import the migrate entrypoint', () => {
    // migrate.ts ends in a top-level `void main()`, so importing anything from it RUNS a
    // migration. db:migrate:status briefly did exactly that by importing a path constant from
    // there — a command whose whole purpose is to report without touching anything applied
    // migrations as a side effect of being asked what was applied. The constant now lives in
    // pg/migrationDirs.ts, which imports nothing but `path`.
    const source = fs.readFileSync(path.join(__dirname, '../migrateStatus.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+'\.\/migrate'/);
    expect(source).toMatch(/from\s+'\.\/pg\/migrationDirs'/);
  });

  it('keeps the shared directory constant free of side effects', () => {
    const source = fs.readFileSync(path.join(__dirname, 'migrationDirs.ts'), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['path']);
  });
});

describe('an empty migration set is a missing schema, not a current one', () => {
  it('refuses status, explicit migration, and startup when migration directories are absent', async () => {
    // loadMigrations returns [] for a directory that does not exist, so without this check a
    // deployment that ships api/dist but not db/pg-migrations finds nothing pending and boots
    // against any schema at all, including an empty database. Found while containerising:
    // migrationDirs.ts resolves the repo root four levels up from its compiled location, which
    // lands outside the image unless db/ is copied in.
    const { db, events } = runnerStub([]);
    await expect(migrationStatus(db as never, '/nonexistent-migrations'))
      .rejects.toThrow(/No migrations found/);
    await expect(runMigrations(db as never, '/nonexistent-migrations'))
      .rejects.toThrow(/No migrations found/);
    await expect(verifyMigrationsCurrent(db as never, '/nonexistent-migrations'))
      .rejects.toThrow(/No migrations found/);
    expect(events).toEqual([]);
  });

  it('names the directories it looked in, so the fix is obvious', async () => {
    const db = ledgerStub([]);
    await expect(verifyMigrationsCurrent(db as never, ['/nope/a', '/nope/b']))
      .rejects.toThrow(/\/nope\/a, \/nope\/b/);
  });
});
