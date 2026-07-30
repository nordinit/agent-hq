import type { Db } from './adapter/types';

/**
 * Dialect-aware schema introspection.
 *
 * Agent HQ asks its own schema what exists before building a query — "does this table exist",
 * "does this column exist" — because the same code has to run against databases at different
 * migration states. On SQLite those answers come from `sqlite_master` and
 * `PRAGMA table_info`. Neither exists in PostgreSQL, so every one of those call sites fails
 * with `relation "sqlite_master" does not exist`.
 *
 * There were 40 local reimplementations of the same two helpers across ~30 files. This is the
 * single place they now delegate to, so adding a dialect means editing one file.
 *
 * WHY EVERY POSTGRESQL QUERY FILTERS BY SCHEMA
 * information_schema spans EVERY schema in the database. An unfiltered
 * `WHERE table_name = 'tasks'` will happily find a `tasks` table in some other schema and
 * answer "yes" with total confidence. That is the dangerous failure mode here: a wrong
 * "column exists" answer does not raise an error, it silently changes which columns a query
 * writes — so an INSERT quietly drops a field, or names one the real table does not have.
 * Every query below is constrained to `current_schema()`, which also keeps the test fixtures
 * working, since those isolate per worker by creating a schema and setting search_path.
 *
 * DELIBERATELY NOT CACHED
 * These run on the request path and caching is tempting. It is also a live hazard: several
 * code paths ALTER TABLE at runtime on SQLite, and a cached "column does not exist" would
 * silently drop data from every later INSERT. The pre-migration code queried every time, so
 * querying every time preserves behaviour exactly. Adding a cache is a separate change that
 * needs an invalidation hook wired into those ALTER sites first.
 */

/** True when `table` exists in the current schema. */
export async function tableExists(db: Db, table: string): Promise<boolean> {
  if (db.dialect === 'postgres') {
    const row = await db.get<{ found: number }>(
      `SELECT 1 AS found FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ? LIMIT 1`,
      table,
    );
    return Boolean(row);
  }
  const row = await db.get<{ name?: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    table,
  );
  return Boolean(row?.name);
}

/** Every column name on `table`, or an empty array when the table does not exist. */
export async function tableColumns(db: Db, table: string): Promise<string[]> {
  if (db.dialect === 'postgres') {
    const rows = await db.all<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ?
        ORDER BY ordinal_position`,
      table,
    );
    return rows.map((r) => r.column_name);
  }
  // No existence pre-check: PRAGMA table_info on a missing table returns an empty list
  // rather than throwing (verified), so the check would be a redundant extra round trip. It
  // also matters for behavioural equivalence — the 40 local helpers this replaces mostly did
  // NOT pre-check, and adding a query changes what SQL-keyed test mocks observe.
  //
  // PRAGMA takes no bound parameters, so the table name is interpolated. Every caller passes
  // an identifier from the codebase, never user input.
  const rows = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.map((r) => r.name);
}

/** True when `table` exists and has `column`. */
export async function columnExists(db: Db, table: string, column: string): Promise<boolean> {
  if (db.dialect === 'postgres') {
    const row = await db.get<{ found: number }>(
      `SELECT 1 AS found FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ? AND column_name = ? LIMIT 1`,
      table, column,
    );
    return Boolean(row);
  }
  return (await tableColumns(db, table)).includes(column);
}

/** True when an index named `index` exists. */
export async function indexExists(db: Db, index: string): Promise<boolean> {
  if (db.dialect === 'postgres') {
    const row = await db.get<{ found: number }>(
      `SELECT 1 AS found FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname = ? LIMIT 1`,
      index,
    );
    return Boolean(row);
  }
  const row = await db.get<{ name?: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1`,
    index,
  );
  return Boolean(row?.name);
}

/** Every base-table name in the current schema. */
export async function listTables(db: Db): Promise<string[]> {
  if (db.dialect === 'postgres') {
    const rows = await db.all<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    return rows.map((r) => r.table_name);
  }
  const rows = await db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  return rows.map((r) => r.name);
}

/**
 * True when `column` on `table` is declared NOT NULL.
 *
 * This replaces call sites that read `SELECT sql FROM sqlite_master` and pattern-matched the
 * DDL text. Those sites were not really asking for DDL — they were asking this question, and
 * a substring search for 'NOT NULL' cannot tell WHICH column it belongs to. Asking the
 * catalog is both portable and more precise than the check it replaces.
 */
export async function columnIsNotNull(db: Db, table: string, column: string): Promise<boolean> {
  if (db.dialect === 'postgres') {
    const row = await db.get<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ? AND column_name = ? LIMIT 1`,
      table, column,
    );
    return row?.is_nullable === 'NO';
  }
  const rows = await db.all<{ name: string; notnull: number }>(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column && Number(r.notnull) === 1);
}

/**
 * Foreign keys declared on `table`, as column -> target table.
 *
 * Also replaces a `SELECT sql` pattern: several sites checked whether the DDL text mentioned
 * `REFERENCES <table>`. That is fragile even on SQLite — it matches a reference inside a
 * comment or a differently-named column — and impossible on PostgreSQL.
 */
export async function foreignKeyTargets(
  db: Db,
  table: string,
): Promise<Array<{ column: string; targetTable: string }>> {
  if (db.dialect === 'postgres') {
    const rows = await db.all<{ column_name: string; target_table: string }>(
      `SELECT kcu.column_name, ccu.table_name AS target_table
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = current_schema()
          AND tc.table_name = ?`,
      table,
    );
    return rows.map((r) => ({ column: r.column_name, targetTable: r.target_table }));
  }
  const rows = await db.all<{ from: string; table: string }>(`PRAGMA foreign_key_list(${table})`);
  return rows.map((r) => ({ column: r.from, targetTable: r.table }));
}

/**
 * Historical alias. The codebase overwhelmingly spells this `tableHasColumn`, and keeping the
 * name means ~40 local definitions can delegate here without their call sites changing.
 */
export const tableHasColumn = columnExists;
