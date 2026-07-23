import type Database from 'better-sqlite3';
import { cleanupTaskExecutionLinkageForStatus } from './taskLifecycle';
import { canonicalOutcomeRoute, requireReleaseGate, resolveSprintWorkflowOutcome } from './taskRelease';
import { notifyTaskStatusChange } from './taskNotifications';
import { isTerminalOutcome, closeInstance } from '../domains/runs/instanceClose';
import { emitIntegrityEvent, writeTaskLifecycleOutcomeHistory, writeTaskStatusChange } from '../domains/tasks/history';
import { getCanonicalTaskRecord } from '../domains/tasks/evidence';
import { resolveSprintTaskRoutingAssignment } from '../domains/routing/policy/statuses';
import { resolveSprintOutcomeMap } from '../domains/sprint-definitions/outcomes';
import {
  isBlockerLikeOutcome,
  isFailureLikeOutcome,
  isRuntimeFailureOutcome,
} from './outcomeCatalog';
import { syncTaskActiveAgentFromInstance } from '../domains/tasks/ownership';
import { insertRuntimeLog, resolveRuntimeTenantId, tenantInsertColumns } from './runtimeTenantScope';
import { assertTaskStatusDefinedForWorkflow, WorkflowAllowedValuesError } from './taskStatusValidation';

export interface ApplyTaskOutcomeInput {
  taskId: number;
  outcome: string;
  changedBy?: string;
  summary?: string | null;
  instanceId?: number | null;
  failureDetail?: string | null;
  dryRun?: boolean;
}

export interface ApplyTaskOutcomeResult {
  ok: true;
  applied: boolean;
  ignored: boolean;
  reason?: 'task_terminal' | 'instance_not_authoritative' | 'missing_authoritative_instance';
  priorStatus: string;
  nextStatus: string;
  outcome: string;
  /** True when the instance was automatically closed as part of a terminal outcome. */
  instanceClosed?: boolean;
  /** Whether the system auto-recovered (routed to a non-failed state). */
  autoRecovered?: boolean;
  /** Human-readable recovery description. */
  recoveryDescription?: string;
}

export class RefusedTaskOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedTaskOutcomeError';
  }
}

type TaskOutcomeTaskRow = {
  id: number;
  status: string;
  project_id: number | null;
  sprint_id: number | null;
  task_type: string | null;
  sprint_type: string | null;
  agent_id: number | null;
  assigned_agent_id: number | null;
  active_instance_id: number | null;
  review_owner_agent_id: number | null;
  review_branch: string | null;
  review_commit: string | null;
  review_url: string | null;
  qa_verified_commit: string | null;
  qa_tested_url: string | null;
  merged_commit: string | null;
  deployed_commit: string | null;
  deployed_at: string | null;
  live_verified_at: string | null;
  live_verified_by: string | null;
  deploy_target: string | null;
  evidence_json: string | null;
  custom_fields_json: string | null;
  previous_status?: string | null;
};

type InstanceAuthorityRow = {
  id: number;
  agent_id: number;
  task_id: number | null;
  status: string;
};

type OutcomeAuthorityDecision =
  | { kind: 'allow'; mode: 'active_instance' | 'linked_instance' }
  | { kind: 'ignore'; reason: ApplyTaskOutcomeResult['reason']; auditMessage: string; auditNote: string };

function logHistory(
  db: Database.Database,
  taskId: number,
  changedBy: string,
  field: string,
  oldValue: unknown,
  newValue: unknown,
): void {
  const tenantId = resolveRuntimeTenantId(db, { taskId });
  const tenant = tenantInsertColumns(db, 'task_history', tenantId);
  db.prepare(`
    INSERT INTO task_history (${tenant.columnSql}task_id, changed_by, field, old_value, new_value)
    VALUES (${tenant.valueSql}?, ?, ?, ?, ?)
  `).run(...tenant.values, taskId, changedBy, field, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue));
}

function insertAuditLog(db: Database.Database, message: string, taskId?: number | null, instanceId?: number | null): void {
  insertRuntimeLog(db, {
    taskId: taskId ?? null,
    instanceId: instanceId ?? null,
    jobTitle: 'outcome-api',
    level: 'info',
    message,
  });
}

function resolveAgentName(db: Database.Database, agentId: number | null): string | null {
  if (agentId == null) return null;
  const row = db.prepare(`SELECT name, job_title FROM agents WHERE id = ?`).get(agentId) as { name: string; job_title: string | null } | undefined;
  return row?.job_title || row?.name || String(agentId);
}

function addAuditNote(db: Database.Database, taskId: number, author: string, content: string): void {
  const tenantId = resolveRuntimeTenantId(db, { taskId });
  const tenant = tenantInsertColumns(db, 'task_notes', tenantId);
  db.prepare(`
    INSERT INTO task_notes (${tenant.columnSql}task_id, author, content)
    VALUES (${tenant.valueSql}?, ?, ?)
  `).run(...tenant.values, taskId, author, content);
}

function withCanonicalFieldValues(task: TaskOutcomeTaskRow): TaskOutcomeTaskRow {
  return getCanonicalTaskRecord(task as unknown as Record<string, unknown>) as TaskOutcomeTaskRow;
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(col => col.name === column);
}

function selectTaskEvidenceColumns(db: Database.Database): string {
  const columns = [
    'review_branch',
    'review_commit',
    'review_url',
    'qa_verified_commit',
    'qa_tested_url',
    'merged_commit',
    'deployed_commit',
    'deployed_at',
    'live_verified_at',
    'live_verified_by',
    'deploy_target',
    'evidence_json',
    'previous_status',
  ];
  return columns
    .map((column) => (tableHasColumn(db, 'tasks', column) ? column : `NULL AS ${column}`))
    .join(',\n      ');
}

function selectTaskColumnOrNull(db: Database.Database, column: string): string {
  return tableHasColumn(db, 'tasks', column) ? column : `NULL AS ${column}`;
}

export function resolveRefusedTaskOutcome(
  db: Database.Database,
  input: {
    taskId: number;
    outcome: string;
    changedBy: string;
    reason: string;
    summary?: string | null;
    instanceId?: number | null;
  },
): void {
  const task = db.prepare(`
    SELECT id
    FROM tasks
    WHERE id = ?
  `).get(input.taskId) as { id: number } | undefined;

  if (!task) return;

  insertAuditLog(db, `Refused outcome for task #${input.taskId}: outcome="${input.outcome}", actor="${input.changedBy}", reason="${input.reason}"`, input.taskId, input.instanceId);
  addAuditNote(db, input.taskId, input.changedBy, `Outcome refused: ${input.outcome} — ${input.reason}`);
}

function buildMissingRouteErrorMessage(priorStatus: string, outcome: string, taskType: string | null, sprintId: number | null): string {
  const scope: string[] = [];
  if (sprintId != null) scope.push(`sprint_id="${sprintId}"`);
  scope.push(`task_type="${taskType ?? 'default'}"`);
  return `Cannot apply outcome "${outcome}" from "${priorStatus}": no explicit sprint_task_transitions route is configured (${scope.join(', ')})`;
}

function resolveTaskRoutingAssignment(
  db: Database.Database,
  sprintId: number | null,
  _projectId: number | null,
  taskType: string | null,
  status: string,
): { agent_id: number | null } {
  if (!taskType) return { agent_id: null };

  try {
    return resolveSprintTaskRoutingAssignment(db, sprintId, taskType, status);
  } catch {
    return { agent_id: null };
  }
}

function loadInstanceAuthorityRow(db: Database.Database, instanceId: number): InstanceAuthorityRow | null {
  return db.prepare(`
    SELECT id, agent_id, task_id, status
    FROM job_instances
    WHERE id = ?
  `).get(instanceId) as InstanceAuthorityRow | undefined ?? null;
}

function buildIgnoredOutcomeDecision(
  reason: ApplyTaskOutcomeResult['reason'],
  auditMessage: string,
  auditNote: string,
): OutcomeAuthorityDecision {
  return {
    kind: 'ignore',
    reason,
    auditMessage,
    auditNote,
  };
}

function resolveOutcomeAuthority(
  db: Database.Database,
  task: TaskOutcomeTaskRow,
  input: ApplyTaskOutcomeInput,
  changedBy: string,
): OutcomeAuthorityDecision {
  if (task.active_instance_id != null && input.instanceId == null) {
    return buildIgnoredOutcomeDecision(
      'missing_authoritative_instance',
      `Ignored unauthoritative outcome for task #${input.taskId}: active_instance_id=${task.active_instance_id}, callback_instance_id=missing, outcome="${input.outcome}", actor="${changedBy}"${input.summary ? `, summary: ${input.summary}` : ''}`,
      `Ignored outcome without authoritative instance: ${input.outcome}${input.summary ? ` — ${input.summary}` : ''}`,
    );
  }

  if (input.instanceId == null) {
    return { kind: 'allow', mode: 'linked_instance' };
  }

  const callbackInstance = loadInstanceAuthorityRow(db, input.instanceId);
  if (!callbackInstance) {
    return buildIgnoredOutcomeDecision(
      'instance_not_authoritative',
      `Ignored stale outcome for task #${input.taskId}: callback_instance_id=${input.instanceId} not found, outcome="${input.outcome}", actor="${changedBy}"${input.summary ? `, summary: ${input.summary}` : ''}`,
      `Ignored stale outcome from instance #${input.instanceId}: ${input.outcome}${input.summary ? ` — ${input.summary}` : ''}`,
    );
  }

  if (task.active_instance_id === callbackInstance.id) {
    return { kind: 'allow', mode: 'active_instance' };
  }

  if (task.active_instance_id != null && task.active_instance_id !== callbackInstance.id) {
    return buildIgnoredOutcomeDecision(
      'instance_not_authoritative',
      `Ignored stale outcome for task #${input.taskId}: active_instance_id=${task.active_instance_id}, callback_instance_id=${callbackInstance.id}, callback_agent_id=${callbackInstance.agent_id}, outcome="${input.outcome}", actor="${changedBy}"${input.summary ? `, summary: ${input.summary}` : ''}`,
      `Ignored stale outcome from instance #${callbackInstance.id}: task is now owned by active instance #${task.active_instance_id}${input.summary ? ` — ${input.summary}` : ''}`,
    );
  }

  if (
    task.agent_id != null
    && task.agent_id === callbackInstance.agent_id
    && callbackInstance.task_id === task.id
  ) {
    return { kind: 'allow', mode: 'linked_instance' };
  }

  if (task.agent_id != null && task.agent_id === callbackInstance.agent_id) {
    return buildIgnoredOutcomeDecision(
      'instance_not_authoritative',
      `Ignored stale outcome for task #${input.taskId}: task_agent_id=${task.agent_id}, callback_instance_id=${callbackInstance.id}, callback_agent_id=${callbackInstance.agent_id}, callback_task_id=${callbackInstance.task_id ?? 'none'}, outcome="${input.outcome}", actor="${changedBy}"${input.summary ? `, summary: ${input.summary}` : ''}`,
      `Ignored stale outcome from instance #${callbackInstance.id}: task is no longer linked to that run${input.summary ? ` — ${input.summary}` : ''}`,
    );
  }

  return buildIgnoredOutcomeDecision(
    'instance_not_authoritative',
    `Ignored stale outcome for task #${input.taskId}: task_agent_id=${task.agent_id ?? 'none'}, callback_instance_id=${callbackInstance.id}, callback_agent_id=${callbackInstance.agent_id}, outcome="${input.outcome}", actor="${changedBy}"${input.summary ? `, summary: ${input.summary}` : ''}`,
    `Ignored stale outcome from instance #${callbackInstance.id}: task is no longer assigned to that active instance${input.summary ? ` — ${input.summary}` : ''}`,
  );
}

function reloadTaskOutcomeTaskRow(db: Database.Database, taskId: number): TaskOutcomeTaskRow {
  const customFieldsSelect = tableHasColumn(db, 'tasks', 'custom_fields_json') ? 'custom_fields_json' : 'NULL AS custom_fields_json';
  const assignedAgentSelect = tableHasColumn(db, 'tasks', 'assigned_agent_id') ? 'assigned_agent_id' : 'agent_id AS assigned_agent_id';
  const evidenceSelect = selectTaskEvidenceColumns(db);
  const reloaded = db.prepare(`
    SELECT
      id,
      status,
      project_id,
      sprint_id,
      task_type,
      (SELECT sprint_type FROM sprints WHERE id = tasks.sprint_id) as sprint_type,
      agent_id,
      ${assignedAgentSelect},
      active_instance_id,
      ${selectTaskColumnOrNull(db, 'review_owner_agent_id')},
      ${evidenceSelect},
      ${customFieldsSelect}
    FROM tasks
    WHERE id = ?
  `).get(taskId) as TaskOutcomeTaskRow | undefined;

  if (!reloaded) throw new Error('Task not found');
  return withCanonicalFieldValues(reloaded);
}

function loadOutcomeMeta(
  db: Database.Database,
  task: TaskOutcomeTaskRow,
  outcome: string,
) {
  return resolveSprintOutcomeMap(db, {
    sprintId: task.sprint_id,
    sprintType: task.sprint_type,
    taskType: task.task_type,
    fallbackOutcomes: [outcome],
  }).get(outcome) ?? null;
}

function routeFallbackOutcomes(outcome: string, semantics: { failureLike: boolean; blockedLike: boolean }): string[] {
  const fallbacks: string[] = [];
  if (outcome === 'release_failed') fallbacks.push('qa_fail');
  if (semantics.blockedLike && outcome !== 'blocked') fallbacks.push('blocked');
  if (semantics.failureLike && outcome !== 'failed') fallbacks.push('failed');
  return [...new Set(fallbacks)];
}

export async function applyTaskOutcome(db: Database.Database, input: ApplyTaskOutcomeInput): Promise<ApplyTaskOutcomeResult> {
  const changedBy = input.changedBy ?? 'system';
  const customFieldsSelect = tableHasColumn(db, 'tasks', 'custom_fields_json') ? 'custom_fields_json' : 'NULL AS custom_fields_json';
  const hasAssignedAgentColumn = tableHasColumn(db, 'tasks', 'assigned_agent_id');
  const assignedAgentSelect = hasAssignedAgentColumn ? 'assigned_agent_id' : 'agent_id AS assigned_agent_id';
  const evidenceSelect = selectTaskEvidenceColumns(db);
  const existing = db.prepare(`
    SELECT
      id,
      status,
      project_id,
      sprint_id,
      task_type,
      (SELECT sprint_type FROM sprints WHERE id = tasks.sprint_id) as sprint_type,
      agent_id,
      ${assignedAgentSelect},
      active_instance_id,
      ${selectTaskColumnOrNull(db, 'review_owner_agent_id')},
      ${evidenceSelect},
      ${customFieldsSelect}
    FROM tasks
    WHERE id = ?
  `).get(input.taskId) as TaskOutcomeTaskRow | undefined;

  if (!existing) {
    throw new Error('Task not found');
  }

  const priorStatus = existing.status;
  const routingBaseStatus = priorStatus === 'needs_attention' && existing.previous_status
    ? existing.previous_status
    : priorStatus;

  if (priorStatus === 'cancelled' || priorStatus === 'done') {
    const message = `Ignored stale outcome for task #${input.taskId}: task is ${priorStatus}, outcome="${input.outcome}", actor="${changedBy}"${input.instanceId != null ? `, instance_id=${input.instanceId}` : ''}${input.summary ? `, summary: ${input.summary}` : ''}`;
    insertAuditLog(db, message, input.taskId, input.instanceId);
    if (input.summary) {
      addAuditNote(db, input.taskId, changedBy, `Ignored stale outcome: ${input.outcome} — ${input.summary}`);
    }

    return {
      ok: true,
      applied: false,
      ignored: true,
      reason: 'task_terminal',
      priorStatus,
      nextStatus: priorStatus,
      outcome: input.outcome,
    };
  }

  const authorityDecision = resolveOutcomeAuthority(db, existing, input, changedBy);
  if (authorityDecision.kind === 'ignore') {
    insertAuditLog(db, authorityDecision.auditMessage, input.taskId, input.instanceId);
    if (input.summary) {
      addAuditNote(db, input.taskId, changedBy, authorityDecision.auditNote);
    }

    // Emit stale_outcome_write integrity event for instance_not_authoritative cases
    if (authorityDecision.reason === 'instance_not_authoritative') {
      emitIntegrityEvent(db, {
        taskId: input.taskId,
        anomalyType: 'stale_outcome_write',
        detail: `${authorityDecision.auditNote}${input.instanceId != null ? ` (instance #${input.instanceId})` : ''}`,
        instanceId: input.instanceId ?? null,
        projectId: existing.project_id,
        agentId: existing.agent_id,
      });
    }

    return {
      ok: true,
      applied: false,
      ignored: true,
      reason: authorityDecision.reason,
      priorStatus,
      nextStatus: priorStatus,
      outcome: input.outcome,
    };
  }

  const reloadedExisting = reloadTaskOutcomeTaskRow(db, input.taskId);
  const projectId = reloadedExisting.project_id;

  // ── Outcome semantics ─────────────────────────────────────────────────────
  // Failure/blocker behavior is owned by the configured outcome vocabulary.
  const effectiveOutcome = input.outcome;
  const outcomeMeta = loadOutcomeMeta(db, reloadedExisting, effectiveOutcome);
  const outcomeSemantics = {
    failureLike: isFailureLikeOutcome(effectiveOutcome, outcomeMeta),
    blockedLike: isBlockerLikeOutcome(effectiveOutcome, outcomeMeta),
  };
  let autoRecovered = false;
  let recoveryDescription: string | undefined;
  let routingOutcome = effectiveOutcome;
  const isUnsuccessfulOutcome = outcomeSemantics.failureLike || outcomeSemantics.blockedLike;

  let sprintWorkflowRoute: ReturnType<typeof resolveSprintWorkflowOutcome> = null;
  try {
    sprintWorkflowRoute = resolveSprintWorkflowOutcome(db, {
      status: routingBaseStatus,
      task_type: reloadedExisting.task_type,
      sprint_id: reloadedExisting.sprint_id,
      sprint_type: reloadedExisting.sprint_type,
    }, routingOutcome);
  } catch (error) {
    let fallbackRoute: ReturnType<typeof resolveSprintWorkflowOutcome> = null;
    for (const fallbackOutcome of routeFallbackOutcomes(effectiveOutcome, outcomeSemantics)) {
      try {
        fallbackRoute = resolveSprintWorkflowOutcome(db, {
          status: routingBaseStatus,
          task_type: reloadedExisting.task_type,
          sprint_id: reloadedExisting.sprint_id,
          sprint_type: reloadedExisting.sprint_type,
        }, fallbackOutcome);
        if (fallbackRoute) {
          routingOutcome = fallbackOutcome;
          break;
        }
      } catch {
        // Try the next fallback below.
      }
    }
    if (!fallbackRoute) throw error;
    sprintWorkflowRoute = fallbackRoute;
  }

  const gateResult = requireReleaseGate(db, { ...reloadedExisting, status: routingBaseStatus }, routingOutcome, reloadedExisting.task_type);
  if (gateResult.errors.length > 0) {
    const refusal = gateResult.errors[0];
    resolveRefusedTaskOutcome(db, {
      taskId: input.taskId,
      outcome: input.outcome,
      changedBy,
      reason: refusal,
      summary: input.summary ?? null,
      instanceId: input.instanceId ?? reloadedExisting.active_instance_id,
    });
    throw new RefusedTaskOutcomeError(refusal);
  }

  let canonicalNextStatus = sprintWorkflowRoute?.nextStatus
    ?? canonicalOutcomeRoute(db, routingBaseStatus, routingOutcome, reloadedExisting.task_type, reloadedExisting.sprint_id, reloadedExisting.sprint_type);
  if (!canonicalNextStatus) {
    for (const fallbackOutcome of routeFallbackOutcomes(effectiveOutcome, outcomeSemantics)) {
      const fallbackNextStatus = canonicalOutcomeRoute(db, routingBaseStatus, fallbackOutcome, reloadedExisting.task_type, reloadedExisting.sprint_id, reloadedExisting.sprint_type);
      if (fallbackNextStatus) {
        canonicalNextStatus = fallbackNextStatus;
        routingOutcome = fallbackOutcome;
        break;
      }
    }
  }

  let route: { to_status: string } | undefined;
  if (!canonicalNextStatus) {
    route = db.prepare(`
      SELECT to_status
      FROM routing_config
      WHERE from_status = ? AND outcome = ? AND enabled = 1
        AND project_id = ?
      LIMIT 1
    `).get(routingBaseStatus, routingOutcome, projectId) as { to_status: string } | undefined;

    if (!route) {
      for (const fallbackOutcome of routeFallbackOutcomes(effectiveOutcome, outcomeSemantics)) {
        if (fallbackOutcome === routingOutcome) continue;
        route = db.prepare(`
          SELECT to_status
          FROM routing_config
          WHERE from_status = ? AND outcome = ? AND enabled = 1
            AND project_id = ?
          LIMIT 1
        `).get(routingBaseStatus, fallbackOutcome, projectId) as { to_status: string } | undefined;
        if (route) {
          routingOutcome = fallbackOutcome;
          break;
        }
      }
    }

    if (!route && effectiveOutcome !== input.outcome) {
      route = db.prepare(`
        SELECT to_status
        FROM routing_config
        WHERE from_status = ? AND outcome = ? AND enabled = 1
          AND project_id = ?
        LIMIT 1
      `).get(routingBaseStatus, input.outcome, projectId) as { to_status: string } | undefined;

      if (route) routingOutcome = input.outcome;
    }
  }

  if (!canonicalNextStatus && !route) {
    const refusal = buildMissingRouteErrorMessage(routingBaseStatus, effectiveOutcome, reloadedExisting.task_type, reloadedExisting.sprint_id);
    resolveRefusedTaskOutcome(db, {
      taskId: input.taskId,
      outcome: input.outcome,
      changedBy,
      reason: refusal,
      summary: input.summary ?? null,
      instanceId: input.instanceId ?? reloadedExisting.active_instance_id,
    });
    throw new WorkflowAllowedValuesError({
      message: refusal,
      code: 'task_outcome_not_allowed_for_workflow',
      field: 'outcome',
      attemptedValue: effectiveOutcome,
      allowedValues: [],
      scope: {
        sprintId: reloadedExisting.sprint_id,
        sprintType: reloadedExisting.sprint_type,
        taskType: reloadedExisting.task_type,
        fromStatus: routingBaseStatus,
      },
    });
  }

  const nextStatus = canonicalNextStatus ?? route!.to_status;
  assertTaskStatusDefinedForWorkflow(db, nextStatus, {
    sprintId: reloadedExisting.sprint_id,
    sprintType: reloadedExisting.sprint_type,
  });
  if (isUnsuccessfulOutcome) {
    autoRecovered = outcomeSemantics.failureLike && nextStatus !== 'failed' && nextStatus !== 'stalled' && nextStatus !== 'blocked';
    recoveryDescription = outcomeSemantics.blockedLike
      ? 'Blocked-like outcome, keep task blocked until the blocker is resolved'
      : autoRecovered
        ? 'Failure-like outcome routed to remediation instead of terminal failure'
        : 'Failure-like outcome routed to failure triage';
  }
  const reviewOwnerAgentId = reloadedExisting.review_owner_agent_id ?? reloadedExisting.agent_id ?? null;
  const routedAssignment = resolveTaskRoutingAssignment(db, reloadedExisting.sprint_id, reloadedExisting.project_id, reloadedExisting.task_type, nextStatus);
  const nextAssignedAgentId = routingOutcome === 'qa_fail' || effectiveOutcome === 'qa_fail'
    ? (reviewOwnerAgentId ?? reloadedExisting.assigned_agent_id ?? null)
    : (routedAssignment.agent_id ?? reloadedExisting.assigned_agent_id);
  const nextReviewOwnerAgentId = routingOutcome === 'qa_fail' || effectiveOutcome === 'qa_fail'
    ? reviewOwnerAgentId
    : (effectiveOutcome === 'completed_for_review' ? reviewOwnerAgentId : reloadedExisting.review_owner_agent_id ?? null);

  // Store failure or blocker detail on the task when failing.
  // Also capture previous_status so retry or reopen can restore workflow
  // position instead of always resetting to 'ready'.
  const preserveFailureMetadata = isUnsuccessfulOutcome || nextStatus === 'failed' || nextStatus === 'stalled';
  const assignmentColumn = hasAssignedAgentColumn ? 'assigned_agent_id' : 'agent_id';
  if (isUnsuccessfulOutcome) {
    db.prepare(`
      UPDATE tasks
      SET status = ?,
          ${assignmentColumn} = ?,
          review_owner_agent_id = ?,
          failure_detail = ?,
          previous_status = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(nextStatus, nextAssignedAgentId, nextReviewOwnerAgentId, input.failureDetail ?? input.summary ?? null,
           preserveFailureMetadata ? priorStatus : null,
           input.taskId);
  } else {
    db.prepare(`
      UPDATE tasks
      SET status = ?,
          ${assignmentColumn} = ?,
          review_owner_agent_id = ?,
          failure_detail = NULL,
          previous_status = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(nextStatus, nextAssignedAgentId, nextReviewOwnerAgentId,
           input.taskId);
  }
  syncTaskActiveAgentFromInstance(db, input.taskId);

  // Record the task outcome on the authoritative instance so the Jobs UI can
  // distinguish execution status (done/failed) from task workflow outcome.
  const lifecyclePostedAt = new Date().toISOString();
  let runtimeEndedBeforeOutcome = false;
  if (input.instanceId != null) {
    const runtimeState = db.prepare(`SELECT runtime_ended_at FROM job_instances WHERE id = ?`).get(input.instanceId) as { runtime_ended_at: string | null } | undefined;
    runtimeEndedBeforeOutcome = Boolean(runtimeState?.runtime_ended_at);
    db.prepare(`
      UPDATE job_instances
      SET task_outcome = ?,
          lifecycle_outcome_posted_at = COALESCE(lifecycle_outcome_posted_at, datetime('now')),
          lifecycle_handoff_status = CASE
            WHEN runtime_ended_at IS NOT NULL THEN 'reconciled'
            ELSE 'posted'
          END,
          semantic_outcome_missing = 0,
          runtime_completed_at = COALESCE(runtime_completed_at, runtime_ended_at)
      WHERE id = ?
    `).run(effectiveOutcome, input.instanceId);
  } else if (reloadedExisting.active_instance_id != null) {
    const runtimeState = db.prepare(`SELECT runtime_ended_at FROM job_instances WHERE id = ?`).get(reloadedExisting.active_instance_id) as { runtime_ended_at: string | null } | undefined;
    runtimeEndedBeforeOutcome = Boolean(runtimeState?.runtime_ended_at);
    db.prepare(`
      UPDATE job_instances
      SET task_outcome = ?,
          lifecycle_outcome_posted_at = COALESCE(lifecycle_outcome_posted_at, datetime('now')),
          lifecycle_handoff_status = CASE
            WHEN runtime_ended_at IS NOT NULL THEN 'reconciled'
            ELSE 'posted'
          END,
          semantic_outcome_missing = 0,
          runtime_completed_at = COALESCE(runtime_completed_at, runtime_ended_at)
      WHERE id = ?
    `).run(effectiveOutcome, reloadedExisting.active_instance_id);
  }

  cleanupTaskExecutionLinkageForStatus(db, input.taskId, nextStatus, {
    authoritativeInstanceId: input.instanceId ?? reloadedExisting.active_instance_id,
    changedBy: 'task_outcome',
  });
  writeTaskLifecycleOutcomeHistory(db, input.taskId, changedBy, {
    outcome: effectiveOutcome,
    postedAt: lifecyclePostedAt,
    postedAfterRuntimeEnd: runtimeEndedBeforeOutcome,
  });
  if (nextAssignedAgentId !== reloadedExisting.assigned_agent_id) {
    logHistory(
      db,
      input.taskId,
      changedBy,
      'assigned_agent_id',
      resolveAgentName(db, reloadedExisting.assigned_agent_id),
      resolveAgentName(db, nextAssignedAgentId),
    );
  }

  // ── Emit task_event for this outcome-driven status transition (#586) ─────
  writeTaskStatusChange(db, input.taskId, changedBy, priorStatus, nextStatus, {
    instanceId: input.instanceId ?? reloadedExisting.active_instance_id,
    reason: input.summary ?? null,
    projectId: reloadedExisting.project_id,
    agentId: reloadedExisting.agent_id,
  });

  // ── Record failure_stage on instance (#586) ──────────────────────────────
  if (isUnsuccessfulOutcome || effectiveOutcome.startsWith('failed:')) {
    const failInstanceId = input.instanceId ?? reloadedExisting.active_instance_id;
    if (failInstanceId != null) {
      try {
        db.prepare(`UPDATE job_instances SET failure_stage = ? WHERE id = ?`)
          .run(priorStatus, failInstanceId);
      } catch { /* non-fatal */ }
    }
  }

  // ── Integrity anomaly detection (#586) ───────────────────────────────────
  const finalTaskState = reloadTaskOutcomeTaskRow(db, input.taskId);
  const iProjectId = finalTaskState.project_id;
  const iInstanceId = input.instanceId ?? finalTaskState.active_instance_id;
  const iAgentId = finalTaskState.agent_id;

  if (nextStatus === 'review' && !finalTaskState.review_branch && !finalTaskState.review_commit) {
    emitIntegrityEvent(db, {
      taskId: input.taskId, anomalyType: 'missing_review_evidence',
      detail: `Task moved to review (outcome: ${effectiveOutcome}) with no review_branch or review_commit`,
      instanceId: iInstanceId, projectId: iProjectId, agentId: iAgentId,
    });
  }

  if (effectiveOutcome === 'qa_pass' && !finalTaskState.qa_verified_commit) {
    emitIntegrityEvent(db, {
      taskId: input.taskId, anomalyType: 'missing_qa_evidence',
      detail: `Task posted qa_pass (next status: ${nextStatus}) with no qa_verified_commit`,
      instanceId: iInstanceId, projectId: iProjectId, agentId: iAgentId,
    });
  }

  if (effectiveOutcome === 'qa_pass' && finalTaskState.review_commit && finalTaskState.qa_verified_commit
    && finalTaskState.review_commit !== finalTaskState.qa_verified_commit) {
    emitIntegrityEvent(db, {
      taskId: input.taskId, anomalyType: 'commit_mismatch',
      detail: `review_commit=${finalTaskState.review_commit} ≠ qa_verified_commit=${finalTaskState.qa_verified_commit}`,
      instanceId: iInstanceId, projectId: iProjectId, agentId: iAgentId,
    });
  }

  if (nextStatus === 'done' && finalTaskState.deployed_at && !finalTaskState.live_verified_at) {
    emitIntegrityEvent(db, {
      taskId: input.taskId, anomalyType: 'deployed_not_verified',
      detail: `Task reached done without live_verified_at being set`,
      instanceId: iInstanceId, projectId: iProjectId, agentId: iAgentId,
    });
  }

  const failureInfo = isUnsuccessfulOutcome ? `${autoRecovered ? ', auto-recovered' : ''}` : '';
  const message = `Outcome transition: task #${input.taskId} (${priorStatus} → ${nextStatus}), outcome="${effectiveOutcome}"${input.outcome !== effectiveOutcome ? `, requested_outcome="${input.outcome}"` : ''}${failureInfo}, actor="${changedBy}"${finalTaskState.agent_id ? `, agent_id=${finalTaskState.agent_id}` : ''}${input.instanceId != null ? `, instance_id=${input.instanceId}` : ''}${input.summary ? `, summary: ${input.summary}` : ''}`;
  insertAuditLog(db, message, input.taskId, input.instanceId);

  if (input.summary) {
    addAuditNote(db, input.taskId, changedBy, `Outcome: ${effectiveOutcome} — ${input.summary}`);
  }

  if (!input.dryRun) {
    notifyTaskStatusChange(db, {
      taskId: input.taskId,
      fromStatus: priorStatus,
      toStatus: nextStatus,
      source: changedBy,
    });
  }

  // ── Auto-close instance on terminal outcomes ──────────────────────────────
  // When an outcome is accepted, automatically mark the instance done/failed
  // and terminate the agent session. This makes POST /tasks/:id/outcome the
  // single exit step.
  // The separate PUT /instances/:id/complete remains for backward compat but is
  // no longer required.
  let instanceClosed = false;
  const authoritativeInstanceId = input.instanceId ?? finalTaskState.active_instance_id;
  if (!input.dryRun && authoritativeInstanceId != null && isTerminalOutcome(effectiveOutcome)) {
    const instanceStatus = effectiveOutcome === 'failed' || effectiveOutcome === 'infra_failed' || isRuntimeFailureOutcome(effectiveOutcome) ? 'failed' : 'done';
    try {
      const closeResult = await closeInstance({
        db,
        instanceId: authoritativeInstanceId,
        status: instanceStatus,
        summary: input.summary ?? null,
        outcome: effectiveOutcome,
        skipIfAlreadyDone: true,
        recordCompletionNote: false,
      });
      instanceClosed = closeResult.closed;
    } catch (closeErr) {
      // Non-fatal: log and continue. Task status was already updated.
      console.warn(`[taskOutcome] Auto-close failed for instance ${authoritativeInstanceId} (non-fatal):`, closeErr instanceof Error ? closeErr.message : closeErr);
    }
  }

  return {
    ok: true,
    applied: true,
    ignored: false,
    priorStatus,
    nextStatus,
    outcome: effectiveOutcome,
    instanceClosed,
    autoRecovered,
    recoveryDescription,
  };
}
