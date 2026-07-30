import { type Db } from "../../db/adapter/types";

export async function getTaskInstanceAuthorityFailure(
  db: Db,
  taskId: number,
  callbackInstanceId: number,
  writeLabel: string,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const task = await db.get(`
    SELECT id, agent_id, active_instance_id
    FROM tasks
    WHERE id = ?
  `, taskId) as {
    id: number;
    agent_id: number | null;
    active_instance_id: number | null;
  } | undefined;

  if (!task) {
    return { status: 404, body: { error: 'Task not found' } };
  }

  const callbackInstance = await db.get(`
    SELECT id, agent_id, task_id
    FROM job_instances
    WHERE id = ?
  `, callbackInstanceId) as {
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
