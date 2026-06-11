import type Database from 'better-sqlite3';
import { writeTaskStatusChange } from '../tasks/history';

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

export function applyStopBehavior(
  db: Database.Database,
  instanceId: number,
  behavior: StopBehavior,
): StopBehaviorResult {
  const instance = db.prepare(`
    SELECT id, task_id
    FROM job_instances
    WHERE id = ?
  `).get(instanceId) as { id: number; task_id: number | null } | undefined;

  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }

  const taskId = instance.task_id ?? null;
  if (!taskId) {
    db.prepare(`UPDATE job_instances SET task_id = NULL WHERE id = ?`).run(instanceId);
    return {
      behavior,
      taskId: null,
      taskStatusBefore: null,
      taskStatusAfter: null,
      clearedTaskLinkage: false,
    };
  }

  const task = db.prepare(`
    SELECT id, status, active_instance_id
    FROM tasks
    WHERE id = ?
  `).get(taskId) as { id: number; status: string; active_instance_id: number | null } | undefined;

  const taskStatusBefore = task?.status ?? null;
  const taskStatusAfter = taskStatusBefore ? nextTaskStatus(taskStatusBefore, behavior) : null;
  const clearedTaskLinkage = task?.active_instance_id === instanceId;

  const tx = db.transaction(() => {
    db.prepare(`UPDATE job_instances SET task_id = NULL WHERE id = ?`).run(instanceId);

    if (!task) return;

    if (task.active_instance_id === instanceId) {
      db.prepare(`
        UPDATE tasks
        SET status = ?,
            active_instance_id = NULL,
            agent_id = NULL,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(taskStatusAfter, taskId);
      if (taskStatusBefore && taskStatusAfter && taskStatusAfter !== taskStatusBefore) {
        writeTaskStatusChange(db, taskId, 'instance_stop', taskStatusBefore, taskStatusAfter);
      }
      return;
    }

    // Stale/ghost instance still pointed at the task, but the task has already
    // moved on to a different active instance (or no active instance at all).
    // Clear only the instance-side linkage; do not mutate the task lifecycle.
  });

  tx();

  return {
    behavior,
    taskId,
    taskStatusBefore,
    taskStatusAfter,
    clearedTaskLinkage,
  };
}
