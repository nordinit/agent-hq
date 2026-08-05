/**
 * The asynchronous PostgreSQL access contract used by application code.
 *
 * Keeping the driver behind this small interface makes transaction ownership explicit:
 * `withTransaction` supplies the connection-bound handle every statement must use, while
 * ordinary callers do not depend on node-postgres result objects or pool internals.
 *
 * PARAMETER STYLE
 * ---------------
 * Callers always write positional `?`, matching the existing 4,030 call sites. The
 * PostgreSQL adapter rewrites those to `$1..$n`. Named and object-style binding are
 * deliberately unsupported: the codebase uses neither, and one binding convention keeps
 * application SQL consistent.
 */

/**
 * A bound SQL parameter.
 *
 * Deliberately `unknown` rather than a union of the types a driver can serialise. The
 * union looks safer but is not: callers throughout Agent HQ build parameter lists as
 * `unknown[]` from parsed JSON, request bodies and dynamic column maps. Narrowing here would
 * not catch a single real bug — the value's runtime
 * type is not known at the call site either way — it would just force ~120 casts that
 * assert rather than verify, and casts are exactly where genuine type errors hide.
 *
 * Parameter type errors surface where they can actually be diagnosed: at the driver, which
 * reports the offending value.
 */
export type SqlParam = unknown;

export interface RunResult {
  /** Rows created, updated or deleted. */
  changes: number;
  /**
   * Primary key of the row an INSERT created, or null when the statement was not a
   * single-row insert into a table with a generated key.
   *
   * The value comes back via RETURNING, so the PostgreSQL adapter appends a
   * RETURNING clause to inserts that lack one. See PostgresAdapter for the details and
   * the cases where it deliberately does not.
   */
  lastInsertId: number | null;
}

export interface Db {
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
   * Runs one or more statements with no parameters, for migrations.
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
