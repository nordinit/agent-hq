import type { Pool, PoolClient } from 'pg';
import type { Db, Dialect, RunResult, SqlParam } from './types';
import { TransactionClosedError } from './types';
import { translateToPostgres } from './dialect';

/**
 * Db implementation over node-postgres.
 *
 * CONNECTION SCOPING
 * ------------------
 * Outside a transaction, statements go to the pool and may each land on a different
 * connection. Inside a transaction they MUST all use the one connection that issued
 * BEGIN, so withTransaction() checks out a dedicated client and hands back a handle
 * bound to it. A statement issued through the outer handle while a transaction is open
 * would run on another connection, outside the transaction — it would not see uncommitted
 * work and would not roll back. That is the most dangerous mistake available here, so
 * finished transaction handles are poisoned rather than left usable.
 */
/**
 * Return int8 (bigint) as a NUMBER, not a string.
 *
 * node-postgres decodes int8 as a string by default, because PostgreSQL's range exceeds
 * IEEE-754. That default is wrong for this application and silently corrosive: the baseline
 * maps every SQLite INTEGER to bigint, so EVERY id, count and foreign key comes back as
 * "99" instead of 99. Nothing throws — JSON responses just change shape, `id === 99` starts
 * failing, arithmetic silently concatenates, and the UI compares strings to numbers.
 *
 * Agent HQ ids are sequence-generated and nowhere near 2^53, so the precision the string
 * form protects is precision this schema cannot reach. Registered once at module load,
 * because the parser table is global to the pg driver.
 *
 * numeric (1700) is parsed for the same reason, and it is NOT reachable only in theory: the
 * schema declares no numeric column anywhere — 554 text, 323 bigint, 2 double precision — so
 * every numeric value the driver ever sees is the result of an aggregate. PostgreSQL widens
 * SUM(bigint) to numeric to avoid overflow and AVG() likewise, so leaving it as a string turned
 * sprints.total_story_points into "13" and telemetry's first_pass_rate_pct into "0.0" while the
 * SQLite build returned numbers. Since no column carries the type, there is no column precision
 * to protect by keeping the string form.
 */
const PG_INT8_OID = 20;
const PG_NUMERIC_OID = 1700;
let numberParsersRegistered = false;
function registerInt8Parser(): void {
  if (numberParsersRegistered) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { types } = require('pg') as typeof import('pg');
  const toNumber = (label: string) => (value: string) => {
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) {
      // Louder than a silent precision loss, and unreachable for sequence-generated ids.
      console.warn(`[pg] ${label} value ${value} exceeds safe integer range; returning as number anyway`);
    }
    return asNumber;
  };
  types.setTypeParser(PG_INT8_OID, toNumber('int8'));
  // Fractional aggregates are expected here, so only a magnitude beyond 2^53 is worth warning
  // about — Number.isSafeInteger would fire on every ordinary average.
  types.setTypeParser(PG_NUMERIC_OID, (value: string) => {
    const asNumber = Number(value);
    if (!Number.isFinite(asNumber) || Math.abs(asNumber) > Number.MAX_SAFE_INTEGER) {
      console.warn(`[pg] numeric value ${value} exceeds safe range; returning as number anyway`);
    }
    return asNumber;
  });
  numberParsersRegistered = true;
}

export class PostgresAdapter implements Db {
  readonly dialect: Dialect = 'postgres';

  /**
   * Primary key column per table, resolved lazily from the catalog and cached.
   * Needed to synthesise RETURNING for inserts — see run().
   */
  private static primaryKeyCache = new Map<string, string | null>();

  constructor(
    private readonly pool: Pool,
    /** Set when this handle is bound to a transaction's connection. */
    private readonly client: PoolClient | null = null,
    private readonly depth = 0,
    private readonly state: { closed: boolean } = { closed: false },
  ) {
    registerInt8Parser();
  }

  get inTransaction(): boolean {
    return this.client !== null;
  }

  private assertUsable(): void {
    if (this.state.closed) throw new TransactionClosedError();
  }

  private async query(sql: string, params: SqlParam[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    this.assertUsable();
    const text = translateToPostgres(sql);
    const executor = this.client ?? this.pool;
    const result = await executor.query(text, params as unknown[]);
    return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
    const { rows } = await this.query(sql, params);
    return rows[0] as T | undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T[]> {
    const { rows } = await this.query(sql, params);
    return rows as T[];
  }

  async value<T = unknown>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
    const { rows } = await this.query(sql, params);
    if (!rows.length) return undefined;
    const first = rows[0];
    const key = Object.keys(first)[0];
    return (key === undefined ? undefined : first[key]) as T | undefined;
  }

  /**
   * PostgreSQL has no lastInsertRowid. The value is only available through RETURNING, so
   * an INSERT that lacks one gets a `RETURNING <pk>` appended, letting the 106 existing
   * lastInsertRowid call sites keep working unchanged.
   *
   * This is only done when it is unambiguous: a single-table INSERT, with no existing
   * RETURNING, into a table whose primary key is a single column. Multi-column keys,
   * views and anything already returning are left exactly as written and simply report
   * lastInsertId: null, which is the honest answer rather than a guessed one.
   */
  async run(sql: string, ...params: SqlParam[]): Promise<RunResult> {
    this.assertUsable();

    const insertTarget = /^\s*INSERT\s+INTO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(sql);
    const alreadyReturning = /\bRETURNING\b/i.test(sql);

    if (insertTarget && !alreadyReturning) {
      const pk = await this.primaryKeyOf(insertTarget[1]);
      if (pk) {
        const { rows, rowCount } = await this.query(`${sql.replace(/;\s*$/, '')} RETURNING "${pk}"`, params);
        const value = rows[0]?.[pk];
        return {
          changes: rowCount,
          lastInsertId: value === undefined || value === null ? null : Number(value),
        };
      }
    }

    const { rowCount } = await this.query(sql, params);
    return { changes: rowCount, lastInsertId: null };
  }

  private async primaryKeyOf(table: string): Promise<string | null> {
    const cached = PostgresAdapter.primaryKeyCache.get(table);
    if (cached !== undefined) return cached;

    const executor = this.client ?? this.pool;
    const result = await executor.query(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = to_regclass($1) AND i.indisprimary`,
      [table],
    );
    // Only a single-column primary key can be returned unambiguously.
    const pk = result.rows.length === 1 ? String(result.rows[0].column_name) : null;
    PostgresAdapter.primaryKeyCache.set(table, pk);
    return pk;
  }

  async exec(sql: string): Promise<void> {
    this.assertUsable();
    const executor = this.client ?? this.pool;
    // No parameters here, so only the safe rewrites apply; placeholder translation would
    // be meaningless and could corrupt DDL containing a literal '?'.
    await executor.query(translateToPostgres(sql));
  }

  async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    this.assertUsable();

    // Already inside a transaction: reuse the same connection and nest with a savepoint,
    // so an inner failure does not discard the outer transaction's work.
    if (this.client) {
      const savepoint = `agenthq_sp_${this.depth + 1}`;
      await this.client.query(`SAVEPOINT ${savepoint}`);
      const state = { closed: false };
      const tx = new PostgresAdapter(this.pool, this.client, this.depth + 1, state);
      try {
        const result = await fn(tx);
        await this.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (err) {
        try { await this.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); } catch { /* keep original error */ }
        throw err;
      } finally {
        state.closed = true;
      }
    }

    const client = await this.pool.connect();
    const state = { closed: false };
    const tx = new PostgresAdapter(this.pool, client, this.depth + 1, state);
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* keep original error */ }
      throw err;
    } finally {
      state.closed = true;
      // The connection must go back to the pool on every path, or the pool leaks a
      // connection per failed transaction and eventually deadlocks.
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.client) return; // a transaction handle does not own the pool
    await this.pool.end();
  }
}
