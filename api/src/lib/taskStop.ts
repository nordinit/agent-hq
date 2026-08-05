import { stopInstanceExecution, type StopInstanceExecutionResult } from '../domains/runs/stopInstanceExecution';
import { writeTaskHistory } from '../domains/tasks/history';
import { type Db } from "../db/adapter/types";

export interface StopTaskActiveInstanceResult {
  had_active_run: boolean;
  task_was_paused: boolean;
  no_op: boolean;
  stop_result: StopInstanceExecutionResult | null;
}

export async function stopTaskActiveInstance(
  db: Db,
  taskId: number,
  tenantId: number,
  changedBy: string,
  stopReason: string | null,
): Promise<StopTaskActiveInstanceResult> {
  const existing = await db.get(`
    SELECT id, status, active_instance_id, paused_at, pause_reason
    FROM tasks
    WHERE id = ? AND tenant_id = ?
  `, taskId, tenantId) as {
    id: number;
    status: string;
    active_instance_id: number | null;
    paused_at: string | null;
    pause_reason: string | null;
  } | undefined;
  if (!existing) throw new Error('Task not found');

  const terminalStatuses = ['done', 'cancelled', 'failed'];
  if (terminalStatuses.includes(existing.status) && !existing.active_instance_id) {
    throw new Error(`Cannot stop a task in terminal status '${existing.status}'`);
  }

  let stopResult: StopInstanceExecutionResult | null = null;
  let hadActiveRun = false;

  if (existing.active_instance_id != null) {
    const instance = await db.get(`
      SELECT id, status
      FROM job_instances
      WHERE id = ? AND tenant_id = ?
    `, existing.active_instance_id, tenantId) as { id: number; status: string } | undefined;

    if (instance && !['done', 'failed', 'cancelled'].includes(instance.status)) {
      hadActiveRun = true;
      stopResult = await stopInstanceExecution(db, instance.id, tenantId, 'stop');
    } else {
      await db.run(`
        UPDATE tasks
        SET active_instance_id = NULL,
            agent_id = NULL,
            updated_at = datetime('now')
        WHERE id = ? AND tenant_id = ? AND active_instance_id = ?
      `, taskId, tenantId, existing.active_instance_id);
      // A manual stop is one of the likeliest ways the link disappears, so it is one of the
      // most important to record — otherwise the next refused lifecycle write looks unexplained.
      await writeTaskHistory(db, taskId, 'task_stop', 'active_instance_id', existing.active_instance_id, null);
    }
  }

  const wasPaused = Boolean(existing.paused_at);
  if (hadActiveRun) {
    const note = stopReason
      ? `Active instance manually stopped by ${changedBy}: ${stopReason}`
      : `Active instance manually stopped by ${changedBy}.`;
    await db.run(`
      INSERT INTO task_notes (task_id, author, content)
      VALUES (?, ?, ?)
    `, taskId, changedBy, note);
  }

  return {
    had_active_run: hadActiveRun,
    task_was_paused: wasPaused,
    no_op: !hadActiveRun,
    stop_result: stopResult,
  };
}
