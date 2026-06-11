/**
 * taskHistory.ts — Central audit-log helper for task mutations
 *
 * Every system-driven change to tasks.status (or agent_id) MUST go through
 * writeTaskHistory so the audit trail is never accidentally skipped.
 *
 * Standardized reason strings (use these in `reason` / `changed_by` fields):
 *   'eligibility'      — eligibility pass (promotion/demotion/unclaim/stall)
 *   'reconciler'       — reconciler tick (review re-routing, runtime/orphan recovery)
 *   'watchdog'         — watchdog timeout handler
 *   'task_outcome'     — outcome API (agent callback)
 *   'task_lifecycle'   — lifecycle cleanup (impossible state repair)
 *   'dispatcher'       — dispatcher (dispatch + failure fallback)
 *   'instance_stop'    — stop/park/requeue via instance stop endpoint
 *   'scheduler'        — cron scheduler (recurring task reset)
 */

import type Database from 'better-sqlite3';
import { resolveRuntimeTenantId, tenantInsertColumns } from '../../lib/runtimeTenantScope';

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
export function emitTaskEvent(db: Database.Database, input: TaskEventInput): void {
  try {
    const moveType = input.moveType ?? classifyMoveType(input.movedBy);
    const tenantId = resolveRuntimeTenantId(db, {
      taskId: input.taskId,
      instanceId: input.instanceId,
      agentId: input.agentId,
      projectId: input.projectId,
    });
    const tenant = tenantInsertColumns(db, 'task_events', tenantId);
    db.prepare(`
      INSERT INTO task_events
        (${tenant.columnSql}task_id, project_id, agent_id, from_status, to_status, moved_by, move_type, instance_id, reason)
      VALUES (${tenant.valueSql}?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...tenant.values,
      input.taskId,
      input.projectId ?? null,
      input.agentId ?? null,
      input.fromStatus ?? null,
      input.toStatus,
      input.movedBy,
      moveType,
      input.instanceId ?? null,
      input.reason ?? null,
    );
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
export function emitIntegrityEvent(db: Database.Database, input: IntegrityEventInput): void {
  try {
    const tenantId = resolveRuntimeTenantId(db, {
      taskId: input.taskId,
      instanceId: input.instanceId,
      agentId: input.agentId,
      projectId: input.projectId,
    });
    const tenant = tenantInsertColumns(db, 'integrity_events', tenantId);
    db.prepare(`
      INSERT INTO integrity_events
        (${tenant.columnSql}task_id, project_id, agent_id, instance_id, anomaly_type, detail)
      VALUES (${tenant.valueSql}?, ?, ?, ?, ?, ?)
    `).run(
      ...tenant.values,
      input.taskId,
      input.projectId ?? null,
      input.agentId ?? null,
      input.instanceId ?? null,
      input.anomalyType,
      input.detail ?? null,
    );
  } catch {
    // integrity_events may not exist yet (migration pending or test DB) — non-fatal
  }
}

// ── task_history helpers ──────────────────────────────────────────────────────

/**
 * Write a single task_history row.  Silently skips if old === new (no-op).
 * Pass `skipIfNoop = false` to force-write even for identical values.
 */
export function writeTaskHistory(
  db: Database.Database,
  taskId: number,
  changedBy: string,
  field: string,
  oldValue: unknown,
  newValue: unknown,
  skipIfNoop = true,
): void {
  const oldStr = oldValue == null ? null : String(oldValue);
  const newStr = newValue == null ? null : String(newValue);
  if (skipIfNoop && oldStr === newStr) return;

  const tenantId = resolveRuntimeTenantId(db, { taskId });
  const tenant = tenantInsertColumns(db, 'task_history', tenantId);
  db.prepare(`
    INSERT INTO task_history (${tenant.columnSql}task_id, changed_by, field, old_value, new_value)
    VALUES (${tenant.valueSql}?, ?, ?, ?, ?)
  `).run(...tenant.values, taskId, changedBy, field, oldStr, newStr);
}

/**
 * Convenience: record a status transition (task_history + task_events).
 * Noop if old === new.
 */
export function writeTaskStatusChange(
  db: Database.Database,
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
): void {
  writeTaskHistory(db, taskId, changedBy, 'status', oldStatus, newStatus);
  if (oldStatus !== newStatus) {
    emitTaskEvent(db, {
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

export function writeTaskRuntimeEndHistory(
  db: Database.Database,
  taskId: number,
  changedBy: string,
  input: RuntimeEndHistoryInput,
): void {
  if (input.endedAt !== undefined) {
    writeTaskHistory(db, taskId, changedBy, 'runtime_ended_at', null, input.endedAt, false);
  }
  if (input.success !== undefined && input.success !== null) {
    writeTaskHistory(db, taskId, changedBy, 'runtime_end_success', null, input.success ? '1' : '0', false);
  }
  if (input.source !== undefined) {
    writeTaskHistory(db, taskId, changedBy, 'runtime_end_source', null, input.source ?? null, false);
  }
  if (input.error !== undefined && input.error !== null) {
    writeTaskHistory(db, taskId, changedBy, 'runtime_end_error', null, input.error, false);
  }
  if (input.lifecycleHandoff !== undefined && input.lifecycleHandoff !== null) {
    writeTaskHistory(db, taskId, changedBy, 'runtime_lifecycle_handoff', null, input.lifecycleHandoff, false);
  }
}

export function writeTaskLifecycleOutcomeHistory(
  db: Database.Database,
  taskId: number,
  changedBy: string,
  input: {
    outcome: string;
    postedAt?: string | null;
    postedAfterRuntimeEnd?: boolean;
  },
): void {
  writeTaskHistory(db, taskId, changedBy, 'lifecycle_outcome', null, input.outcome, false);
  if (input.postedAt) {
    writeTaskHistory(db, taskId, changedBy, 'lifecycle_outcome_posted_at', null, input.postedAt, false);
  }
  writeTaskHistory(
    db,
    taskId,
    changedBy,
    'runtime_lifecycle_handoff',
    null,
    input.postedAfterRuntimeEnd ? 'posted_after_runtime_end' : 'posted',
    false,
  );
}
