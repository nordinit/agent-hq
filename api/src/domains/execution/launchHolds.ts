import type { Db } from '../../db/adapter/types';
import { writeTaskHistory } from '../tasks/history';
import { ExecutionDenied, type ExecutionDeniedReason } from './authority';

/**
 * A launch Agent HQ refused because the agent may not run on this machine or its setup is not
 * approved. The refusal happens before a run exists, so this is what the task page shows.
 */
export interface LaunchHold {
  task_id: number;
  agent_id: number;
  agent_name: string | null;
  resource_kind: 'agent_runtime' | 'workflow_setup';
  resource_id: number;
  reason_code: ExecutionDeniedReason;
  reason: string;
  detail: string;
  attempts: number;
  first_refused_at: string;
  last_refused_at: string;
}

/**
 * Dispatch retries a refused task every reconciler tick (about 12 seconds) and refreshes its hold.
 * A hold not refreshed for this long belongs to a task nothing is trying to start any more, for
 * example one moved to another status, so it is no longer shown.
 */
const HOLD_FRESHNESS = "interval '10 minutes'";

export function launchHoldReason(
  reason: ExecutionDeniedReason,
  kind: 'agent_runtime' | 'workflow_setup',
  agentName: string,
): string {
  if (reason === 'host_execute_missing') {
    return `${agentName} is not allowed to run on this machine yet. It needs the host.execute permission.`;
  }
  if (kind === 'workflow_setup') {
    if (reason === 'changed_since_approval') return `This workflow's repository or environment setup changed after it was approved for ${agentName}.`;
    if (reason === 'not_approved') return `This workflow's repository and environment setup has not been approved for ${agentName}.`;
  }
  if (reason === 'changed_since_approval') return `${agentName}'s setup changed after it was approved, so it waits for you to review the change.`;
  if (reason === 'not_approved') return `${agentName}'s setup has not been approved yet.`;
  if (reason === 'dependency_changed') return `A file that ${agentName}'s approved setup depends on changed or is missing.`;
  if (reason === 'integrity_failed') return `${agentName}'s approved setup failed its integrity check.`;
  return `Agent HQ could not start ${agentName}.`;
}

/**
 * Records why a task's launch was refused. The task gets a note the first time, and again only
 * when the reason changes; retries refresh the hold silently. Never throws: recording a refusal
 * must not change how dispatch handles it.
 */
export async function recordLaunchHold(db: Db, input: {
  taskId: number;
  agentId: number;
  kind: 'agent_runtime' | 'workflow_setup';
  resourceId: number;
  error: unknown;
}): Promise<void> {
  try {
    const reasonCode: ExecutionDeniedReason = input.error instanceof ExecutionDenied ? input.error.reason : 'other';
    const detail = input.error instanceof Error ? input.error.message : String(input.error);
    const task = await db.get<{ tenant_id: number }>('SELECT tenant_id FROM tasks WHERE id = ?', input.taskId);
    if (!task) return;
    const agent = await db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', input.agentId);
    const reason = launchHoldReason(reasonCode, input.kind, agent?.name ?? `Agent #${input.agentId}`);
    const existing = await db.get<{ agent_id: number; resource_kind: string; resource_id: number; reason_code: string }>(
      'SELECT agent_id, resource_kind, resource_id, reason_code FROM execution_launch_holds WHERE task_id = ?', input.taskId,
    );
    const same = existing != null
      && Number(existing.agent_id) === input.agentId
      && existing.resource_kind === input.kind
      && Number(existing.resource_id) === input.resourceId
      && existing.reason_code === reasonCode;
    if (same) {
      await db.run(`UPDATE execution_launch_holds SET attempts = attempts + 1, last_refused_at = now(), reason = ?, detail = ?
        WHERE task_id = ?`, reason, detail, input.taskId);
      return;
    }
    await db.run(`
      INSERT INTO execution_launch_holds (task_id, tenant_id, agent_id, resource_kind, resource_id, reason_code, reason, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (task_id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id, agent_id = EXCLUDED.agent_id, resource_kind = EXCLUDED.resource_kind,
        resource_id = EXCLUDED.resource_id, reason_code = EXCLUDED.reason_code, reason = EXCLUDED.reason,
        detail = EXCLUDED.detail, attempts = 1, first_refused_at = now(), last_refused_at = now()
    `, input.taskId, Number(task.tenant_id), input.agentId, input.kind, input.resourceId, reasonCode, reason, detail);
    await db.run(`INSERT INTO task_notes (tenant_id, task_id, author, content) VALUES (?, ?, 'Agent HQ', ?)`,
      Number(task.tenant_id), input.taskId,
      `Summary: Can't start\nBlocker: ${reason}\nNext owner: Operator. Review and approve it on the Approvals page; Agent HQ starts the task on its next check.`);
    await writeTaskHistory(db, input.taskId, 'Agent HQ', 'launch_hold', null,
      JSON.stringify({ agent_id: input.agentId, resource_kind: input.kind, resource_id: input.resourceId, reason_code: reasonCode }));
  } catch (error) {
    console.warn('[launch-holds] Could not record a refused launch:', error instanceof Error ? error.message : error);
  }
}

/** The task's launch checks passed. */
export async function clearLaunchHold(db: Db, taskId: number): Promise<void> {
  try {
    await db.run('DELETE FROM execution_launch_holds WHERE task_id = ?', taskId);
  } catch (error) {
    console.warn('[launch-holds] Could not clear a launch hold:', error instanceof Error ? error.message : error);
  }
}

/** Holds for an agent are re-checked on the next dispatch tick after an approval. */
export async function clearAgentLaunchHolds(db: Db, tenantId: number, agentId: number): Promise<void> {
  await db.run('DELETE FROM execution_launch_holds WHERE tenant_id = ? AND agent_id = ?', tenantId, agentId);
}

function serialize(row: Record<string, unknown>): LaunchHold {
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
  return {
    task_id: Number(row.task_id),
    agent_id: Number(row.agent_id),
    agent_name: row.agent_name == null ? null : String(row.agent_name),
    resource_kind: row.resource_kind as LaunchHold['resource_kind'],
    resource_id: Number(row.resource_id),
    reason_code: row.reason_code as ExecutionDeniedReason,
    reason: String(row.reason),
    detail: String(row.detail),
    attempts: Number(row.attempts),
    first_refused_at: iso(row.first_refused_at),
    last_refused_at: iso(row.last_refused_at),
  };
}

/** Current holds for these tasks, keyed by task id. A task with a running instance has none. */
export async function getLaunchHolds(db: Db, taskIds: number[]): Promise<Map<number, LaunchHold>> {
  const holds = new Map<number, LaunchHold>();
  if (taskIds.length === 0) return holds;
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await db.all<Record<string, unknown>>(`
      SELECT h.*, a.name AS agent_name
      FROM execution_launch_holds h
      JOIN tasks t ON t.id = h.task_id AND t.tenant_id = h.tenant_id
      LEFT JOIN agents a ON a.id = h.agent_id
      WHERE h.task_id = ANY(?::bigint[]) AND t.active_instance_id IS NULL AND h.last_refused_at > now() - ${HOLD_FRESHNESS}
    `, taskIds);
  } catch (error) {
    // A database that predates migration 60 has no holds to show.
    if ((error as { code?: string }).code === '42P01') return holds;
    throw error;
  }
  for (const row of rows) holds.set(Number(row.task_id), serialize(row));
  return holds;
}

export async function getTaskLaunchHold(db: Db, taskId: number): Promise<LaunchHold | null> {
  return (await getLaunchHolds(db, [taskId])).get(taskId) ?? null;
}

/** Current holds for agents in a tenant, newest first. */
export async function listAgentLaunchHolds(db: Db, tenantId: number, agentId?: number): Promise<Array<LaunchHold & { task_title: string }>> {
  const rows = await db.all<Record<string, unknown>>(`
    SELECT h.*, a.name AS agent_name, t.title AS task_title
    FROM execution_launch_holds h
    JOIN tasks t ON t.id = h.task_id AND t.tenant_id = h.tenant_id
    LEFT JOIN agents a ON a.id = h.agent_id
    WHERE h.tenant_id = ? AND (?::bigint IS NULL OR h.agent_id = ?)
      AND t.active_instance_id IS NULL AND h.last_refused_at > now() - ${HOLD_FRESHNESS}
    ORDER BY h.last_refused_at DESC
  `, tenantId, agentId ?? null, agentId ?? null);
  return rows.map((row) => ({ ...serialize(row), task_title: String(row.task_title ?? '') }));
}
