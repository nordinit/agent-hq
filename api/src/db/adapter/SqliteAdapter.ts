import type Database from 'better-sqlite3';
import type { Db, Dialect, RunResult, SqlParam } from './types';
import { TransactionClosedError } from './types';

/**
 * Db implementation over better-sqlite3.
 *
 * Every method is async to satisfy the interface, but the work underneath is still
 * synchronous — better-sqlite3 has no async mode. That is deliberate and is the whole
 * point of the migration sequence: the codebase converts to the async interface FIRST,
 * while the engine and its semantics are unchanged, so the existing test suite validates
 * the conversion in isolation. Only afterwards does the engine change.
 *
 * One caveat this shape introduces, which is real even before PostgreSQL arrives:
 * `await` yields to the event loop. A read-modify-write sequence that was previously
 * uninterruptible because better-sqlite3 blocks the thread can now interleave with other
 * handlers between its statements. Sequences that must be atomic have to say so by
 * running inside withTransaction(), rather than relying on the engine's blocking
 * behaviour as they did before.
 */
export class SqliteAdapter implements Db {
  readonly dialect: Dialect = 'sqlite';

  constructor(
    private readonly db: Database.Database,
    /** Depth of nested withTransaction() calls, used to pick BEGIN vs SAVEPOINT. */
    private readonly depth = 0,
    private readonly parentState: { closed: boolean } = { closed: false },
  ) {}

  get inTransaction(): boolean {
    return this.db.inTransaction;
  }

  private assertUsable(): void {
    if (this.parentState.closed) throw new TransactionClosedError();
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
    this.assertUsable();
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T[]> {
    this.assertUsable();
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  async value<T = unknown>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
    this.assertUsable();
    return this.db.prepare(sql).pluck().get(...(params as never[])) as T | undefined;
  }

  async run(sql: string, ...params: SqlParam[]): Promise<RunResult> {
    this.assertUsable();
    const info = this.db.prepare(sql).run(...(params as never[]));
    // lastInsertRowid is per-connection and reflects the most recent insert on it, so it
    // is only meaningful when this statement actually inserted something.
    const inserted = info.changes > 0 && /^\s*INSERT\b/i.test(sql);
    return {
      changes: info.changes,
      lastInsertId: inserted ? Number(info.lastInsertRowid) : null,
    };
  }

  async exec(sql: string): Promise<void> {
    this.assertUsable();
    this.db.exec(sql);
  }

  async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    this.assertUsable();

    // better-sqlite3's own db.transaction() cannot be used here: it requires a
    // synchronous callback and throws "Transaction function cannot return a promise" at
    // runtime when handed an async one. The transaction is therefore driven manually.
    const nested = this.db.inTransaction;
    const savepoint = `agenthq_sp_${this.depth + 1}`;

    if (nested) this.db.exec(`SAVEPOINT ${savepoint}`);
    else this.db.exec('BEGIN');

    const state = { closed: false };
    const tx = new SqliteAdapter(this.db, this.depth + 1, state);

    try {
      const result = await fn(tx);
      if (nested) this.db.exec(`RELEASE ${savepoint}`);
      else this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        if (nested) {
          this.db.exec(`ROLLBACK TO ${savepoint}`);
          this.db.exec(`RELEASE ${savepoint}`);
        } else if (this.db.inTransaction) {
          this.db.exec('ROLLBACK');
        }
      } catch {
        // Preserve the original failure; a rollback error would otherwise mask it.
      }
      throw err;
    } finally {
      // Any statement issued through `tx` after this point would run outside the
      // transaction, so the handle is poisoned rather than left silently usable.
      state.closed = true;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /** Escape hatch for the remaining SQLite-only code (PRAGMA, schema introspection). */
  get raw(): Database.Database {
    return this.db;
  }
}
