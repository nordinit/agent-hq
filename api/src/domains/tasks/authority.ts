import type Database from 'better-sqlite3';

export function getTaskInstanceAuthorityFailure(
  db: Database.Database,
  taskId: number,
  callbackInstanceId: number,
  writeLabel: string,
): { status: number; body: Record<string, unknown> } | null {
  const task = db.prepare(`
    SELECT id, agent_id, active_instance_id
    FROM tasks
    WHERE id = ?
  `).get(taskId) as {
    id: number;
    agent_id: number | null;
    active_instance_id: number | null;
  } | undefined;

  if (!task) {
    return { status: 404, body: { error: 'Task not found' } };
  }

  const callbackInstance = db.prepare(`
    SELECT id, agent_id, task_id
    FROM job_instances
    WHERE id = ?
  `).get(callbackInstanceId) as {
    id: number;
    agent_id: number;
    task_id: number | null;
  } | undefined;

  if (!callbackInstance) {
    return {
      status: 409,
      body: {
        error: `Stale instance: ${writeLabel} rejected`,
        reason: 'instance_not_authoritative',
        callback_instance_id: callbackInstanceId,
        active_instance_id: task.active_instance_id,
      },
    };
  }

  if (task.active_instance_id != null) {
    if (callbackInstance.id === task.active_instance_id) return null;
    return {
      status: 409,
      body: {
        error: `Stale instance: ${writeLabel} rejected`,
        reason: 'instance_not_authoritative',
        callback_instance_id: callbackInstanceId,
        active_instance_id: task.active_instance_id,
      },
    };
  }

  if (callbackInstance.task_id === task.id && task.agent_id === callbackInstance.agent_id) {
    return null;
  }

  return {
    status: 409,
    body: {
      error: `Stale instance: ${writeLabel} rejected`,
      reason: 'instance_not_authoritative',
      callback_instance_id: callbackInstanceId,
      active_instance_id: task.active_instance_id,
      callback_task_id: callbackInstance.task_id,
      callback_agent_id: callbackInstance.agent_id,
      task_agent_id: task.agent_id,
    },
  };
}
