import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadMigrations, migrationStatus, verifyMigrationsCurrent } from './migrationRunner';

/**
 * The boot gate must refuse to serve on a schema that is behind the code.
 *
 * It did not. verifyStartupSchema passed db/pg-baseline, which holds only 01-03, so
 * db/pg-migrations was never verified and a pending migration started cleanly. That happened
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

/** A ledger stub: enough of Db for the runner's two reads, with no engine behind it. */
function ledgerStub(applied: Array<{ id: string; checksum: string }>) {
  return {
    dialect: 'postgres' as const,
    inTransaction: false,
    exec: async () => {},
    all: async () => applied,
    get: async () => undefined,
    run: async () => ({ changes: 0, lastInsertId: 0 }),
    value: async () => undefined,
    withTransaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn({}),
    close: async () => {},
  };
}

describe('migration loading', () => {
  it('reads several directories and orders them by numeric prefix, not by directory', () => {
    // The baseline and the migrations live apart until the fold, and concatenating two sorted
    // lists is not a sorted list.
    const baseline = writeDir({ '01-tables.sql': 'SELECT 1;', '03-foreign-keys.sql': 'SELECT 3;' });
    const migrations = writeDir({ '02-indexes.sql': 'SELECT 2;', '14-audit.sql': 'SELECT 14;' });
    expect(loadMigrations([baseline, migrations]).map((m) => m.id))
      .toEqual(['01-tables.sql', '02-indexes.sql', '03-foreign-keys.sql', '14-audit.sql']);
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

  it('serves when every migration across both directories is applied', async () => {
    const baseline = writeDir({ '01-tables.sql': 'SELECT 1;' });
    const migrations = writeDir({ '14-audit.sql': 'SELECT 14;' });
    const all = loadMigrations([baseline, migrations]);
    const db = ledgerStub(all.map((m) => ({ id: m.id, checksum: m.checksum })));

    await expect(verifyMigrationsCurrent(db as never, [baseline, migrations])).resolves.toBeUndefined();
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
