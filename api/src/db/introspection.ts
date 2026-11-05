import type { Db } from './adapter/types';

/** PostgreSQL catalog helpers, always scoped to the active schema. */
export async function tableExists(db: Db, table: string): Promise<boolean> {
  return Boolean(await db.get(
    `SELECT 1 AS found FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = ? LIMIT 1`,
    table,
  ));
}

export async function tableColumns(db: Db, table: string): Promise<string[]> {
  const rows = await db.all<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ?
      ORDER BY ordinal_position`,
    table,
  );
  return rows.map((row) => row.column_name);
}

export async function columnExists(db: Db, table: string, column: string): Promise<boolean> {
  return Boolean(await db.get(
    `SELECT 1 AS found FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ? AND column_name = ? LIMIT 1`,
    table,
    column,
  ));
}

export async function indexExists(db: Db, index: string): Promise<boolean> {
  return Boolean(await db.get(
    `SELECT 1 AS found FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = ? LIMIT 1`,
    index,
  ));
}

export async function listTables(db: Db): Promise<string[]> {
  const rows = await db.all<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

export const tableHasColumn = columnExists;
