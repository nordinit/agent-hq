import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export function createDurableRunId(): string {
  return randomUUID();
}

export function tableHasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
    .some((col) => col.name === columnName);
}

export function ensureJobInstanceDurableRunId(
  db: Database.Database,
  instanceId: number,
): string {
  if (!tableHasColumn(db, 'job_instances', 'durable_run_id')) return '';

  const row = db.prepare(`SELECT durable_run_id FROM job_instances WHERE id = ?`)
    .get(instanceId) as { durable_run_id: string | null } | undefined;
  const existing = typeof row?.durable_run_id === 'string' ? row.durable_run_id.trim() : '';
  if (existing) return existing;

  const durableRunId = createDurableRunId();
  db.prepare(`UPDATE job_instances SET durable_run_id = ? WHERE id = ?`).run(durableRunId, instanceId);
  return durableRunId;
}

