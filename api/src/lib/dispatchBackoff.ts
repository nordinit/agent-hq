import { type Db } from '../db/adapter/types';

// Failed dispatches retry indefinitely, never stopping: 2, 4, 6, 8, then every 10 minutes by
// default. The configured base interval is also the increment; the cap is always 10 minutes.
// tasks.retry_count and tasks.dispatched_at persist the cooldown across API restarts.
export const MAX_DISPATCH_FAILURE_BACKOFF_SECONDS = 600;
const configuredDispatchBackoff = Number(process.env.DISPATCH_FAILURE_BACKOFF_SECONDS ?? 120);
export const DISPATCH_FAILURE_BACKOFF_SECONDS: number =
  Number.isFinite(configuredDispatchBackoff) && configuredDispatchBackoff >= 1
    ? Math.min(Math.floor(configuredDispatchBackoff), MAX_DISPATCH_FAILURE_BACKOFF_SECONDS)
    : 120;

export function dispatchFailureBackoffSeconds(retryCount: number): number {
  return Math.min(
    DISPATCH_FAILURE_BACKOFF_SECONDS * Math.max(1, retryCount),
    MAX_DISPATCH_FAILURE_BACKOFF_SECONDS,
  );
}

/** Enough history to see a streak long enough to reach the cap, with room to report it. */
const RUNTIME_FAILURE_STREAK_LOOKBACK = 100;

export interface RuntimeFailureBackoff {
  /** Failed runs in a row for the task, ending with the run that just failed. */
  retryCount: number;
  backoffSeconds: number;
}

/**
 * A run that started and then died at runtime gets the same increasing cooldown as a run that
 * failed to start. The dispatcher clears retry_count whenever a run starts, so the streak cannot
 * be carried in that counter across runs. It is recounted here from the task's run history
 * instead: the run that just failed plus every failed run directly before it.
 *
 * The cooldown is anchored at the failure (dispatched_at), as startup failures anchor it, so a
 * run that failed after a long time still waits before the next one. Nothing is changed when a
 * later run already owns or has started on the task.
 */
export async function recordRuntimeFailureBackoff(
  db: Db,
  params: { taskId: number; instanceId: number },
): Promise<RuntimeFailureBackoff | null> {
  const prior = await db.all<{ status: string }>(`
    SELECT status
    FROM job_instances
    WHERE task_id = ? AND id < ?
    ORDER BY id DESC
    LIMIT ?
  `, params.taskId, params.instanceId, RUNTIME_FAILURE_STREAK_LOOKBACK);
  const priorFailures = prior.findIndex(row => row.status !== 'failed');
  const retryCount = 1 + (priorFailures === -1 ? prior.length : priorFailures);

  const updated = await db.run(`
    UPDATE tasks
    SET retry_count = ?,
        dispatched_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
      AND (active_instance_id IS NULL OR active_instance_id = ?)
      AND NOT EXISTS (SELECT 1 FROM job_instances WHERE task_id = ? AND id > ?)
  `, retryCount, params.taskId, params.instanceId, params.taskId, params.instanceId);
  if (updated.changes === 0) return null;

  return { retryCount, backoffSeconds: dispatchFailureBackoffSeconds(retryCount) };
}
