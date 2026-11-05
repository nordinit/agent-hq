import { type Db } from '../../db/adapter/types';

/**
 * Status owners: the agent that has worked each status of a task.
 *
 * Backs the workflow type's "Keep same agent" setting. With it on, a task that comes back to a status
 * it has been worked in before is dispatched only to that status's owner, so the agent that already
 * has the context, worktree and branch is the one that continues. Owners are recorded whether or not
 * the setting is on, so turning it on later already knows who worked what.
 *
 * Nothing here names a status or an outcome. Which statuses an agent owns comes from what happened:
 * the status a run was dispatched for, and the status an agent's own outcome moved the task to when
 * that agent can work that status too.
 */

export type TaskStatusOwnerSource = 'dispatch' | 'outcome';

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
