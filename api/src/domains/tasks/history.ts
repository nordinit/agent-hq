import { resolveRuntimeTenantId, tenantInsertColumns } from '../../lib/runtimeTenantScope';
import { type Db } from "../../db/adapter/types";

// ── Move type classification ──────────────────────────────────────────────────

/**
 * Classify a status change actor into a move_type for task_events.
 *
 * move_type taxonomy (from spec #585 / schema #586):
 *   'automatic'  — system-driven (reconciler, eligibility, watchdog, lifecycle, scheduler)
 *   'outcome'    — agent callback via POST /tasks/:id/outcome
 *   'manual'     — direct human/API move without an active instance
 *   'rescue'     — operator intervention to unblock/reset a stuck task
 *   'dispatch'   — dispatcher setting dispatched status
 */
export type MoveType = 'automatic' | 'outcome' | 'manual' | 'rescue' | 'dispatch';

const AUTOMATIC_ACTORS = new Set([
  'eligibility', 'reconciler', 'watchdog', 'task_lifecycle', 'scheduler', 'system',
]);
const OUTCOME_ACTORS = new Set(['task_outcome']);
const DISPATCH_ACTORS = new Set(['dispatcher']);

export function classifyMoveType(changedBy: string): MoveType {
  if (AUTOMATIC_ACTORS.has(changedBy)) return 'automatic';
  if (OUTCOME_ACTORS.has(changedBy)) return 'outcome';
  if (DISPATCH_ACTORS.has(changedBy)) return 'dispatch';
  if (changedBy && changedBy !== 'system' && changedBy !== 'Atlas') return 'outcome';
  return 'manual';
}

// ── task_events emission ──────────────────────────────────────────────────────

interface TaskEventInput {
  taskId: number;
  fromStatus: string | null;
  toStatus: string;
  movedBy: string;
  moveType?: MoveType;
  instanceId?: number | null;
  reason?: string | null;
  projectId?: number | null;
  agentId?: number | null;
}

/**
 * Write a task_events row for every status transition.
 * Non-fatal: silently swallows errors to avoid disrupting primary mutations.
 */
export async function emitTaskEvent(db: Db, input: TaskEventInput): Promise<void> {
  try {
    const moveType = input.moveType ?? classifyMoveType(input.movedBy);
    const tenantId = await resolveRuntimeTenantId(db, {
          taskId: input.taskId,
          instanceId: input.instanceId,
          agentId: input.agentId,
          projectId: input.projectId,
        });
    const tenant = await tenantInsertColumns(db, 'task_events', tenantId);
    await db.run(`
      INSERT INTO task_events
        (${tenant.columnSql}task_id, project_id, agent_id, from_status, to_status, moved_by, move_type, instance_id, reason)
      VALUES (${tenant.valueSql}?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, ...tenant.values, input.taskId, input.projectId ?? null, input.agentId ?? null, input.fromStatus ?? null, input.toStatus, input.movedBy, moveType, input.instanceId ?? null, input.reason ?? null);
  } catch {
    // task_events may not exist yet (migration pending or test DB) — non-fatal
  }
}

// ── integrity_events emission ─────────────────────────────────────────────────

interface IntegrityEventInput {
  taskId: number;
  anomalyType:
    | 'missing_review_evidence'
    | 'missing_qa_evidence'
    | 'commit_mismatch'
    | 'deployed_not_verified'
    | 'stale_outcome_write'
    | 'branch_missing_on_origin'
    | 'evidence_placeholder'
    | 'missing_lifecycle_handoff';
  detail?: string | null;
  instanceId?: number | null;
  projectId?: number | null;
  agentId?: number | null;
}

/**
 * Write an integrity_events row for a handoff/evidence anomaly.
 * Non-fatal: silently swallows errors.
 */
export async function emitIntegrityEvent(db: Db, input: IntegrityEventInput): Promise<void> {
  try {
    const tenantId = await resolveRuntimeTenantId(db, {
          taskId: input.taskId,
          instanceId: input.instanceId,
          agentId: input.agentId,
          projectId: input.projectId,
        });
    const tenant = await tenantInsertColumns(db, 'integrity_events', tenantId);
    await db.run(`
      INSERT INTO integrity_events
        (${tenant.columnSql}task_id, project_id, agent_id, instance_id, anomaly_type, detail)
      VALUES (${tenant.valueSql}?, ?, ?, ?, ?, ?)
    `, ...tenant.values, input.taskId, input.projectId ?? null, input.agentId ?? null, input.instanceId ?? null, input.anomalyType, input.detail ?? null);
  } catch {
    // integrity_events may not exist yet (migration pending or test DB) — non-fatal
  }
}

// ── task_history helpers ──────────────────────────────────────────────────────

/**
 * Write a single task_history row.  Silently skips if old === new (no-op).
 * Pass `skipIfNoop = false` to force-write even for identical values.
 */
export async function writeTaskHistory(
  db: Db,
  taskId: number,
  changedBy: string,
  field: string,
  oldValue: unknown,
  newValue: unknown,
  skipIfNoop = true,
): Promise<void> {
  const oldStr = oldValue == null ? null : String(oldValue);
  const newStr = newValue == null ? null : String(newValue);
  if (skipIfNoop && oldStr === newStr) return;

  const tenantId = await resolveRuntimeTenantId(db, { taskId });
  const tenant = await tenantInsertColumns(db, 'task_history', tenantId);
  await db.run(`
    INSERT INTO task_history (${tenant.columnSql}task_id, changed_by, field, old_value, new_value)
    VALUES (${tenant.valueSql}?, ?, ?, ?, ?)
  `, ...tenant.values, taskId, changedBy, field, oldStr, newStr);
}

/**
 * Convenience: record a status transition (task_history + task_events).
 * Noop if old === new.
 */
export async function writeTaskStatusChange(
  db: Db,
  taskId: number,
  changedBy: string,
  oldStatus: string,
  newStatus: string,
  opts?: {
    instanceId?: number | null;
    reason?: string | null;
    projectId?: number | null;
    agentId?: number | null;
  },
): Promise<void> {
  await writeTaskHistory(db, taskId, changedBy, 'status', oldStatus, newStatus);
  if (oldStatus !== newStatus) {
    await emitTaskEvent(db, {
            taskId,
            fromStatus: oldStatus,
            toStatus: newStatus,
            movedBy: changedBy,
            instanceId: opts?.instanceId,
            reason: opts?.reason,
            projectId: opts?.projectId,
            agentId: opts?.agentId,
          });
  }
}

interface RuntimeEndHistoryInput {
  endedAt?: string | null;
  success?: boolean | null;
  source?: string | null;
  error?: string | null;
  lifecycleHandoff?: 'pending' | 'posted' | 'missing_after_runtime_end' | 'posted_after_runtime_end' | null;
}

export async function writeTaskRuntimeEndHistory(
  db: Db,
  taskId: number,
  changedBy: string,
  input: RuntimeEndHistoryInput,
): Promise<void> {
  if (input.endedAt !== undefined) {
    await writeTaskHistory(db, taskId, changedBy, 'runtime_ended_at', null, input.endedAt, false);
  }
  if (input.success !== undefined && input.success !== null) {
    await writeTaskHistory(db, taskId, changedBy, 'runtime_end_success', null, input.success ? '1' : '0', false);
  }
  if (input.source !== undefined) {
    await writeTaskHistory(db, taskId, changedBy, 'runtime_end_source', null, input.source ?? null, false);
  }
  if (input.error !== undefined && input.error !== null) {
    await writeTaskHistory(db, taskId, changedBy, 'runtime_end_error', null, input.error, false);
  }
  if (input.lifecycleHandoff !== undefined && input.lifecycleHandoff !== null) {
    await writeTaskHistory(db, taskId, changedBy, 'runtime_lifecycle_handoff', null, input.lifecycleHandoff, false);
  }
}

export async function writeTaskLifecycleOutcomeHistory(
  db: Db,
  taskId: number,
  changedBy: string,
  input: {
    outcome: string;
    postedAt?: string | null;
    postedAfterRuntimeEnd?: boolean;
  },
): Promise<void> {
  await writeTaskHistory(db, taskId, changedBy, 'lifecycle_outcome', null, input.outcome, false);
  if (input.postedAt) {
    await writeTaskHistory(db, taskId, changedBy, 'lifecycle_outcome_posted_at', null, input.postedAt, false);
  }
  await writeTaskHistory(
        db,
        taskId,
        changedBy,
        'runtime_lifecycle_handoff',
        null,
        input.postedAfterRuntimeEnd ? 'posted_after_runtime_end' : 'posted',
        false,
      );
}
