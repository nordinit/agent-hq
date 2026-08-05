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

export async function columnIsNotNull(db: Db, table: string, column: string): Promise<boolean> {
  const row = await db.get<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ? AND column_name = ? LIMIT 1`,
    table,
    column,
  );
  return row?.is_nullable === 'NO';
}

export async function foreignKeyTargets(
  db: Db,
  table: string,
): Promise<Array<{ column: string; targetTable: string }>> {
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
  return rows.map((row) => ({ column: row.column_name, targetTable: row.target_table }));
}

export const tableHasColumn = columnExists;
