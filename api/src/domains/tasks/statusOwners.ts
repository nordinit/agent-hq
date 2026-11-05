import { type Db } from '../../db/adapter/types';

/**
 * Status owners: the agent that has worked each status of a task.
 *
 * Backs the workflow type's "Keep same agent" setting. With it on, a task that comes back to a status
 * it has been worked in before is dispatched only to that status's owner, so the agent that already
 * has the context, worktree and branch is the one that continues. Owners are recorded whether or not
 * the setting is on, so turning it on later already knows who worked what.
 *
 * Nothing here names a status or an outcome. An agent owns the statuses its runs worked in: the status
 * a run was dispatched for, and any status the task moved to while that run was still going.
 */

export type TaskStatusOwnerSource = 'dispatch' | 'run';

export interface TaskStatusOwner {
  task_id: number;
  status: string;
  agent_id: number;
  agent_name: string | null;
  instance_id: number | null;
  source: TaskStatusOwnerSource;
  created_at: string;
  updated_at: string;
}

const OWNER_SELECT = `
  SELECT o.task_id, o.status, o.agent_id, a.name AS agent_name, o.instance_id, o.source, o.created_at, o.updated_at
  FROM task_status_owners o
  LEFT JOIN agents a ON a.id = o.agent_id
`;

export async function recordTaskStatusOwner(db: Db, input: {
  taskId: number;
  status: string;
  agentId: number;
  instanceId?: number | null;
  source: TaskStatusOwnerSource;
  /** Keep an existing owner instead of replacing it. */
  onlyIfUnowned?: boolean;
}): Promise<void> {
  const onConflict = input.onlyIfUnowned
    ? 'DO NOTHING'
    : `DO UPDATE SET agent_id = EXCLUDED.agent_id,
         instance_id = EXCLUDED.instance_id,
         source = EXCLUDED.source,
         updated_at = EXCLUDED.updated_at`;
  await db.run(`
    INSERT INTO task_status_owners (tenant_id, task_id, status, agent_id, instance_id, source)
    SELECT tenant_id, id, ?, ?, ?, ? FROM tasks WHERE id = ?
    ON CONFLICT (task_id, status) ${onConflict}
  `, input.status, input.agentId, input.instanceId ?? null, input.source, input.taskId);
}

export async function getTaskStatusOwner(db: Db, taskId: number, status: string): Promise<TaskStatusOwner | null> {
  return await db.get<TaskStatusOwner>(`${OWNER_SELECT} WHERE o.task_id = ? AND o.status = ?`, taskId, status) ?? null;
}

export async function listTaskStatusOwners(db: Db, taskId: number): Promise<TaskStatusOwner[]> {
  return await db.all<TaskStatusOwner>(`${OWNER_SELECT} WHERE o.task_id = ? ORDER BY o.created_at ASC, o.status ASC`, taskId);
}

/**
 * A task that changes status while its run is still going stays with that run's agent, who owns the
 * new status too. This is how the start callback's move into a working status is owned. A status
 * change made by an outcome is not: the outcome is recorded on the run before the move, which is
 * what ends it.
 */
export async function recordLiveRunStatusOwner(db: Db, taskId: number, status: string): Promise<void> {
  const run = await db.get<{ id: number; agent_id: number }>(`
    SELECT ji.id, ji.agent_id
    FROM tasks t
    JOIN job_instances ji ON ji.id = t.active_instance_id
    WHERE t.id = ?
      AND ji.status IN ('queued', 'dispatched', 'running')
      AND ji.task_outcome IS NULL
      AND ji.agent_id IS NOT NULL
  `, taskId);
  if (!run) return;
  await recordTaskStatusOwner(db, { taskId, status, agentId: run.agent_id, instanceId: run.id, source: 'run' });
}

/** Whether the workflow's type has Keep same agent on. A tenant's own definition wins over a global one. */
export async function isKeepSameAgentEnabled(db: Db, workflowId: number | null | undefined): Promise<boolean> {
  if (workflowId == null) return false;
  const row = await db.get<{ keep_same_agent: number | null }>(`
    SELECT wt.keep_same_agent
    FROM workflows w
    JOIN workflow_types wt
      ON wt.key = w.workflow_type
     AND (wt.tenant_id IS NULL OR wt.tenant_id = w.tenant_id)
    WHERE w.id = ?
    ORDER BY wt.tenant_id IS NULL ASC
    LIMIT 1
  `, workflowId);
  return Number(row?.keep_same_agent ?? 0) === 1;
}
