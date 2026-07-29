/**
 * The database access interface Agent HQ code depends on, instead of better-sqlite3.
 *
 * WHY THIS EXISTS
 * ---------------
 * better-sqlite3 is synchronous — `db.prepare(sql).get(id)` returns a row. Every Node
 * PostgreSQL driver is asynchronous and returns a Promise, and Node cannot synchronously
 * await one. So the engine swap is not a driver substitution: the SHAPE of every call
 * site changes, and `async` propagates up the call graph to the route handlers.
 *
 * Depending on this interface rather than on better-sqlite3 buys three things:
 *
 *   1. The 711 `Database.Database` signatures stop naming a concrete engine, so the
 *      implementation can be swapped without touching application code.
 *   2. `withTransaction` is async-correct by construction. better-sqlite3's
 *      `db.transaction(fn)` requires a SYNCHRONOUS callback and throws
 *      "Transaction function cannot return a promise" at RUNTIME if given an async one —
 *      a failure TypeScript cannot catch, waiting at all 83 existing call sites.
 *   3. The codebase can be converted to async while still running on SQLite, so the
 *      existing test suite validates the refactor with no PostgreSQL involved. Any
 *      failure after the implementation is swapped is then unambiguously engine-specific.
 *
 * PARAMETER STYLE
 * ---------------
 * Callers always write positional `?`, matching the existing 4,030 call sites. The
 * PostgreSQL adapter rewrites those to `$1..$n`. Named and object-style binding are
 * deliberately unsupported: the codebase uses neither, and allowing them would mean
 * maintaining two binding models across both engines.
 */

export type SqlParam = string | number | bigint | boolean | null | undefined | Buffer | Date;

export interface RunResult {
  /** Rows created, updated or deleted. */
  changes: number;
  /**
   * Primary key of the row an INSERT created, or null when the statement was not a
   * single-row insert into a table with a generated key.
   *
   * SQLite exposes this for free as lastInsertRowid. PostgreSQL has no equivalent —
   * the value only comes back via RETURNING — so the PostgreSQL adapter appends a
   * RETURNING clause to inserts that lack one. See PostgresAdapter for the details and
   * the cases where it deliberately does not.
   */
  lastInsertId: number | null;
}

/** Engine identity, for the few places that legitimately need to branch. */
export type Dialect = 'sqlite' | 'postgres';

export interface Db {
  readonly dialect: Dialect;

  /** First row, or undefined when the query matched nothing. */
  get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T | undefined>;

  /** All matching rows. */
  all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T[]>;

  /** A statement that changes data. */
  run(sql: string, ...params: SqlParam[]): Promise<RunResult>;

  /**
   * A single scalar — the first column of the first row. Replaces better-sqlite3's
   * `.pluck().get()`.
   */
  value<T = unknown>(sql: string, ...params: SqlParam[]): Promise<T | undefined>;

  /**
   * Runs one or more statements with no parameters, for DDL and migrations.
   * Parameters are unsupported here on purpose: multi-statement parameter binding
   * behaves differently across the two engines, and every such site is DDL.
   */
  exec(sql: string): Promise<void>;

  /**
   * Runs `fn` inside a transaction, committing on return and rolling back on throw.
   *
   * The `tx` handle passed to `fn` MUST be used for every statement inside the
   * transaction. On PostgreSQL a transaction is bound to a single pooled connection;
   * issuing a statement through the outer handle would run it on a DIFFERENT connection,
   * outside the transaction, where it would neither see uncommitted work nor roll back.
   * That is the single easiest way to silently corrupt data during this migration.
   *
   * Nested calls are mapped to savepoints, so an inner rollback does not discard the
   * outer transaction's work.
   */
  withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;

  /** True while this handle is inside an open transaction. */
  readonly inTransaction: boolean;

  /** Releases underlying resources. */
  close(): Promise<void>;
}

/**
 * Thrown when a statement is issued through a handle whose transaction has already
 * finished. Without this the statement would silently execute outside the transaction.
 */
export class TransactionClosedError extends Error {
  readonly code = 'TRANSACTION_CLOSED';
  constructor() {
    super(
      'This transaction handle is no longer usable: its transaction has already ' +
      'committed or rolled back. A statement issued through it would run outside the ' +
      'transaction. Make sure every statement inside withTransaction() uses the `tx` ' +
      'handle and is awaited before the callback returns.'
    );
    this.name = 'TransactionClosedError';
  }
}
