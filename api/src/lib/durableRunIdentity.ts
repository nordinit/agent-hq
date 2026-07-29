import { randomUUID } from 'crypto';
import { type Db } from "../db/adapter/types";

export function createDurableRunId(): string {
  return randomUUID();
}

export async function tableHasColumn(db: Db, tableName: string, columnName: string): Promise<boolean> {
  return (await db.all(`PRAGMA table_info(${tableName})`) as Array<{ name: string }>)
    .some((col) => col.name === columnName);
}

export async function ensureJobInstanceDurableRunId(
  db: Db,
  instanceId: number,
): Promise<string> {
  if (!await tableHasColumn(db, 'job_instances', 'durable_run_id')) return '';

  const row = await db.get(`SELECT durable_run_id FROM job_instances WHERE id = ?`, instanceId) as { durable_run_id: string | null } | undefined;
  const existing = typeof row?.durable_run_id === 'string' ? row.durable_run_id.trim() : '';
  if (existing) return existing;

  const durableRunId = createDurableRunId();
  await db.run(`UPDATE job_instances SET durable_run_id = ? WHERE id = ?`, durableRunId, instanceId);
  return durableRunId;
}

