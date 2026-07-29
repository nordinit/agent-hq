import type { Db } from './types';
import { TransactionClosedError } from './types';

/**
 * The Db contract, written once and executed against every implementation.
 *
 * The adapter only earns its keep if both engines behave identically, so asserting that
 * has to be a single shared suite rather than two suites that can drift. Anywhere the
 * engines genuinely cannot agree, the difference belongs here as an explicit, documented
 * assertion rather than as a silent gap in coverage.
 *
 * `setup` returns a Db whose schema is:
 *   parents  (id pk, name not null)
 *   children (id pk, parent_id not null -> parents.id on delete cascade, label nullable)
 * and which starts empty.
 */
export interface ContractFixture {
  db: Db;
  /** Releases everything this fixture created. */
  cleanup: () => Promise<void>;
}

export interface ContractHarness {
  name: string;
  /**
   * Builds a fresh, empty database and returns it together with its own cleanup.
   *
   * Returning the cleanup alongside the handle — rather than having the harness stash
   * connections in module-level variables — keeps each test's resources bound to that
   * test. Shared mutable harness state is reassigned by the next beforeEach and produces
   * genuinely baffling cross-test failures, where a test operates on a connection that
   * teardown has already replaced.
   */
  setup: () => Promise<ContractFixture>;
}

export function runDbContractTests(harness: ContractHarness): void {
  describe(`Db contract: ${harness.name}`, () => {
    let db: Db;
    let cleanup: () => Promise<void>;

    beforeEach(async () => { ({ db, cleanup } = await harness.setup()); });
    afterEach(async () => { await cleanup(); });

    it('returns a row, a list, a scalar and a run result', async () => {
      const inserted = await db.run(`INSERT INTO parents (name) VALUES (?)`, 'alpha');
      expect(inserted.changes).toBe(1);
      expect(inserted.lastInsertId).toBe(1);

      await db.run(`INSERT INTO parents (name) VALUES (?)`, 'beta');

      expect(await db.get(`SELECT name FROM parents WHERE id = ?`, 1)).toEqual({ name: 'alpha' });
      expect(await db.all(`SELECT name FROM parents ORDER BY id`))
        .toEqual([{ name: 'alpha' }, { name: 'beta' }]);
      expect(Number(await db.value(`SELECT COUNT(*) FROM parents`))).toBe(2);
      expect(await db.get(`SELECT name FROM parents WHERE id = ?`, 999)).toBeUndefined();
    });

    it('reports lastInsertId as null for statements that are not inserts', async () => {
      await db.run(`INSERT INTO parents (name) VALUES (?)`, 'alpha');
      const updated = await db.run(`UPDATE parents SET name = ? WHERE id = ?`, 'renamed', 1);
      expect(updated.changes).toBe(1);
      expect(updated.lastInsertId).toBeNull();
    });

    it('reports the number of rows a statement changed', async () => {
      await db.run(`INSERT INTO parents (name) VALUES (?)`, 'a');
      await db.run(`INSERT INTO parents (name) VALUES (?)`, 'b');
      expect((await db.run(`UPDATE parents SET name = ?`, 'x')).changes).toBe(2);
      expect((await db.run(`DELETE FROM parents WHERE name = ?`, 'nope')).changes).toBe(0);
      expect((await db.run(`DELETE FROM parents`)).changes).toBe(2);
    });

    it('distinguishes NULL from empty string', async () => {
      // CSV-based loading collapses these two, so the distinction is asserted explicitly.
      await db.run(`INSERT INTO parents (name) VALUES (?)`, 'p');
      await db.run(`INSERT INTO children (parent_id, label) VALUES (?, ?)`, 1, null);
      await db.run(`INSERT INTO children (parent_id, label) VALUES (?, ?)`, 1, '');
      expect(Number(await db.value(`SELECT COUNT(*) FROM children WHERE label IS NULL`))).toBe(1);
      expect(Number(await db.value(`SELECT COUNT(*) FROM children WHERE label = ''`))).toBe(1);
    });

    it('round-trips text that would break naive escaping', async () => {
      const nasty = `quote ' double " back\\slash\ttab\nnewline ? param {"json":"x"}`;
      await db.run(`INSERT INTO parents (name) VALUES (?)`, nasty);
      expect(await db.value(`SELECT name FROM parents WHERE id = ?`, 1)).toBe(nasty);
    });

    it('commits on success and rolls back on throw', async () => {
      await db.withTransaction(async (tx) => {
        await tx.run(`INSERT INTO parents (name) VALUES (?)`, 'committed');
      });
      expect(Number(await db.value(`SELECT COUNT(*) FROM parents`))).toBe(1);

      await expect(db.withTransaction(async (tx) => {
        await tx.run(`INSERT INTO parents (name) VALUES (?)`, 'discarded');
        throw new Error('boom');
      })).rejects.toThrow('boom');

      expect(Number(await db.value(`SELECT COUNT(*) FROM parents`))).toBe(1);
      expect(await db.get(`SELECT name FROM parents WHERE name = ?`, 'discarded')).toBeUndefined();
    });

    it('supports an async callback, which better-sqlite3 transactions cannot', async () => {
      // db.transaction(async () => {}) throws "Transaction function cannot return a
      // promise" at runtime. This is the whole reason withTransaction exists.
      await db.withTransaction(async (tx) => {
        await tx.run(`INSERT INTO parents (name) VALUES (?)`, 'a');
        await new Promise((resolve) => setImmediate(resolve));
        await tx.run(`INSERT INTO parents (name) VALUES (?)`, 'b');
      });
      expect(Number(await db.value(`SELECT COUNT(*) FROM parents`))).toBe(2);
    });

    it('sees its own uncommitted writes inside the transaction', async () => {
      await db.withTransaction(async (tx) => {
        await tx.run(`INSERT INTO parents (name) VALUES (?)`, 'pending');
        // On PostgreSQL this only holds if the read uses the transaction's own
        // connection; a pooled read would land elsewhere and see nothing.
        expect(Number(await tx.value(`SELECT COUNT(*) FROM parents`))).toBe(1);
      });
    });

    it('rolls back only the inner scope when a nested transaction fails', async () => {
      await db.withTransaction(async (tx) => {
        await tx.run(`INSERT INTO parents (name) VALUES (?)`, 'outer');
        await expect(tx.withTransaction(async (inner) => {
          await inner.run(`INSERT INTO parents (name) VALUES (?)`, 'inner');
          throw new Error('inner fails');
        })).rejects.toThrow('inner fails');
      });

      const names = (await db.all<{ name: string }>(`SELECT name FROM parents ORDER BY id`))
        .map((r) => r.name);
      expect(names).toEqual(['outer']);
    });

    it('commits a nested transaction that succeeds', async () => {
      await db.withTransaction(async (tx) => {
        await tx.run(`INSERT INTO parents (name) VALUES (?)`, 'outer');
        await tx.withTransaction(async (inner) => {
          await inner.run(`INSERT INTO parents (name) VALUES (?)`, 'inner');
        });
      });
      expect(Number(await db.value(`SELECT COUNT(*) FROM parents`))).toBe(2);
    });

    it('poisons a transaction handle once its transaction has finished', async () => {
      let escaped: Db | undefined;
      await db.withTransaction(async (tx) => { escaped = tx; });
      // Without this guard the statement would run OUTSIDE the transaction, silently.
      await expect(escaped!.run(`INSERT INTO parents (name) VALUES (?)`, 'late'))
        .rejects.toBeInstanceOf(TransactionClosedError);
      expect(Number(await db.value(`SELECT COUNT(*) FROM parents`))).toBe(0);
    });

    it('enforces foreign keys and cascades deletes', async () => {
      // SQLite's foreign_keys pragma is per-connection and silently degrades cascade to a
      // no-op when off, so confirm it here rather than misreporting that as a cascade bug.
      if (db.dialect === 'sqlite') {
        expect(Number(await db.value(`PRAGMA foreign_keys`))).toBe(1);
      }
      const parent = await db.run(`INSERT INTO parents (name) VALUES (?)`, 'p');
      await db.run(`INSERT INTO children (parent_id, label) VALUES (?, ?)`, parent.lastInsertId, 'c');

      let rejected = false;
      try {
        await db.run(`INSERT INTO children (parent_id, label) VALUES (?, ?)`, 999, 'x');
      } catch {
        rejected = true;
      }
      if (!rejected) {
        // Capture why rather than just asserting: a violating insert that succeeds means
        // either enforcement is off or the constraint is not on the table, and those need
        // different fixes.
        const pragma = db.dialect === 'sqlite' ? await db.value(`PRAGMA foreign_keys`) : 'n/a';
        const ddl = db.dialect === 'sqlite'
          ? await db.value(`SELECT sql FROM sqlite_master WHERE name = 'children'`)
          : 'n/a';
        const parents = await db.all(`SELECT id FROM parents ORDER BY id`);
        throw new Error(
          `violating INSERT succeeded. foreign_keys=${String(pragma)} ` +
          `parents=${JSON.stringify(parents)} ddl=${String(ddl)}`
        );
      }
      await db.run(`DELETE FROM parents WHERE id = ?`, 1);
      expect(Number(await db.value(`SELECT COUNT(*) FROM children`))).toBe(0);
    });
  });
}
