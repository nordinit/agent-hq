import { writeTaskStatusChange } from '../tasks/history';
import { type Db } from "../../db/adapter/types";

export const STOP_BEHAVIORS = ['stop', 'park', 'requeue'] as const;

export type StopBehavior = typeof STOP_BEHAVIORS[number];

export interface StopBehaviorResult {
  behavior: StopBehavior;
  taskId: number | null;
  taskStatusBefore: string | null;
  taskStatusAfter: string | null;
  clearedTaskLinkage: boolean;
}

export function normalizeStopBehavior(input: unknown): StopBehavior {
  if (typeof input !== 'string') return 'park';

  const normalized = input.trim().toLowerCase().replace(/[_\s-]+/g, '_');
  if (normalized === 'stop') return 'stop';
  if (normalized === 'park' || normalized === 'stop_only_safe') return 'park';
  if (normalized === 'requeue' || normalized === 'resume_queue') return 'requeue';

  return 'park';
}

function nextTaskStatus(currentStatus: string, behavior: StopBehavior): string {
  switch (behavior) {
    case 'stop':
      return currentStatus;
    case 'park':
      return 'cancelled';
    case 'requeue':
      return 'ready';
  }
}

export async function applyStopBehavior(
  db: Db,
  instanceId: number,
  tenantId: number,
  behavior: StopBehavior,
): Promise<StopBehaviorResult> {
  const instance = await db.get(`
    SELECT id, task_id
    FROM job_instances
    WHERE id = ? AND tenant_id = ?
  `, instanceId, tenantId) as { id: number; task_id: number | null } | undefined;

  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }

  const taskId = instance.task_id ?? null;
  if (!taskId) {
    await db.run(`UPDATE job_instances SET task_id = NULL WHERE id = ? AND tenant_id = ?`, instanceId, tenantId);
    return {
      behavior,
      taskId: null,
      taskStatusBefore: null,
      taskStatusAfter: null,
      clearedTaskLinkage: false,
    };
  }

  const task = await db.get(`
    SELECT id, status, active_instance_id
    FROM tasks
    WHERE id = ? AND tenant_id = ?
  `, taskId, tenantId) as { id: number; status: string; active_instance_id: number | null } | undefined;

  const taskStatusBefore = task?.status ?? null;
  const taskStatusAfter = taskStatusBefore ? nextTaskStatus(taskStatusBefore, behavior) : null;
  const clearedTaskLinkage = task?.active_instance_id === instanceId;
  const scopedTaskId = task?.id ?? null;

  await db.withTransaction(async (db) => {
    await db.run(`UPDATE job_instances SET task_id = NULL WHERE id = ? AND tenant_id = ?`, instanceId, tenantId);

    if (!task) return;

    if (task.active_instance_id === instanceId) {
      await db.run(`
        UPDATE tasks
        SET status = ?,
            active_instance_id = NULL,
            agent_id = NULL,
            updated_at = datetime('now')
        WHERE id = ? AND tenant_id = ? AND active_instance_id = ?
      `, taskStatusAfter, taskId, tenantId, instanceId);
      if (taskStatusBefore && taskStatusAfter && taskStatusAfter !== taskStatusBefore) {
        await writeTaskStatusChange(db, taskId, 'instance_stop', taskStatusBefore, taskStatusAfter);
      }
      return;
    }

    // Stale/ghost instance still pointed at the task, but the task has already
    // moved on to a different active instance (or no active instance at all).
    // Clear only the instance-side linkage; do not mutate the task lifecycle.
  });

  return {
    behavior,
    taskId: scopedTaskId,
    taskStatusBefore,
    taskStatusAfter,
    clearedTaskLinkage,
  };
}
