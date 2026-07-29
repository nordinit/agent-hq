import { scheduleEndedActiveInstanceLinkageCleanup } from '../../lib/taskLifecycle';
import { resolveWorkflow } from '../../services/contracts/workflowContract';
import { getCanonicalTaskRecord } from '../tasks/evidence';
import { markTaskNeedsAttentionForMissingSemanticHandoff, taskRequiresSemanticOutcome } from './lifecycleHandoff';
import { recordRunCheckIn } from './observability';
import { applyConfiguredRuntimeFailedEvent } from './runtimeFailureEvent';
import { normalizeTokenUsage } from './tokenUsage';
import { toCanonicalTimestampOrNow } from '../../lib/timestamps';
import { tableHasColumn } from '../../lib/durableRunIdentity';
import { type Db } from "../../db/adapter/types";

export interface TerminalRuntimeEndEvent {
  type: string;
  source?: string | null;
  sessionKey: string;
  runId?: string;
  success: boolean;
  endedAt: string;
  reason?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeEndEvidenceFields {
  review_branch?: string | null;
  review_commit?: string | null;
  review_url?: string | null;
  qa_verified_commit?: string | null;
  qa_tested_url?: string | null;
  merged_commit?: string | null;
  deployed_commit?: string | null;
  deploy_target?: string | null;
  deployed_at?: string | null;
  custom_fields_json?: string | null;
}

export function derivePostRuntimeInstanceStatus(
  status: string,
  runtimeEndedAt: string | null | undefined,
  lifecycleOutcomePostedAt: string | null | undefined,
  taskOutcome: string | null | undefined,
  runtimeEndSuccess: boolean,
  requiresSemanticOutcome: boolean,
): string {
  if (runtimeEndedAt && !lifecycleOutcomePostedAt && !taskOutcome && (status === 'running' || status === 'dispatched' || status === 'queued')) {
    if (requiresSemanticOutcome) return 'failed';
    return runtimeEndSuccess ? 'done' : 'failed';
  }
  return status;
}

export function determineRuntimeEndEvidenceRecorded(
  workflowPhase: string | null | undefined,
  row: RuntimeEndEvidenceFields | null | undefined,
): 'yes' | 'no' {
  if (!row) return 'no';
  const canonicalRow = getCanonicalTaskRecord(row as Record<string, unknown>);

  if (workflowPhase === 'review') {
    return canonicalRow.qa_verified_commit ? 'yes' : 'no';
  }

  if (workflowPhase === 'release') {
    return (canonicalRow.merged_commit || canonicalRow.deployed_commit || canonicalRow.deploy_target || canonicalRow.deployed_at) ? 'yes' : 'no';
  }

  return (canonicalRow.review_branch || canonicalRow.review_commit || canonicalRow.review_url) ? 'yes' : 'no';
}

export async function markRuntimeEnded(
  db: Db,
  params: {
    instanceId: number;
    nextStatus: string;
    endedAt: string;
    success: boolean;
    error?: string | null;
    source: string;
    tokenInput?: number | null;
    tokenOutput?: number | null;
    tokenTotal?: number | null;
  },
): Promise<void> {
  await db.run(`
    UPDATE job_instances
    SET status = ?,
        started_at = COALESCE(started_at, ?),
        completed_at = COALESCE(completed_at, ?),
        runtime_ended_at = COALESCE(runtime_ended_at, ?),
        runtime_end_success = COALESCE(runtime_end_success, ?),
        runtime_end_error = COALESCE(?, runtime_end_error),
        runtime_end_source = COALESCE(?, runtime_end_source),
        token_input = COALESCE(?, token_input),
        token_output = COALESCE(?, token_output),
        token_total = COALESCE(?, token_total)
    WHERE id = ?
  `, params.nextStatus, params.endedAt, params.endedAt, params.endedAt, params.success ? 1 : 0, params.error ?? null, params.source, params.tokenInput ?? null, params.tokenOutput ?? null, params.tokenTotal ?? null, params.instanceId);
}

export async function applyRuntimeEndToJobInstance(
  db: Db,
  params: {
    instanceId: number;
    event: TerminalRuntimeEndEvent;
    runtimeName: string;
    runtimeEndSource?: string | null;
    changedBy?: string | null;
  },
): Promise<{ changed: boolean; nextStatus?: string; missingRequiredLifecycleOutcome?: boolean }> {
  const existing = await db.get(`
    SELECT status, lifecycle_outcome_posted_at, task_outcome, task_id, session_key
    FROM job_instances
    WHERE id = ?
  `, params.instanceId) as {
    status: string;
    lifecycle_outcome_posted_at: string | null;
    task_outcome: string | null;
    task_id: number | null;
    session_key: string | null;
  } | undefined;
  if (!existing) return { changed: false };

  const requiresSemanticOutcome = await taskRequiresSemanticOutcome(db, existing.task_id);
  const runtimeEndError = params.event.error ?? (params.event.success ? null : (params.event.reason ?? 'error'));
  const runtimeEndSource = params.runtimeEndSource ?? params.event.source ?? 'instance_complete';
  const endedAt = toCanonicalTimestampOrNow(params.event.endedAt);
  const tokenUsage = normalizeTokenUsage(params.event.metadata, params.event);
  const nextStatus = derivePostRuntimeInstanceStatus(
    existing.status,
    endedAt,
    existing.lifecycle_outcome_posted_at,
    existing.task_outcome,
    params.event.success,
    requiresSemanticOutcome,
  );

  const claim = await db.run(`
    UPDATE job_instances
    SET status = ?,
        started_at = COALESCE(started_at, ?),
        completed_at = COALESCE(completed_at, ?),
        runtime_ended_at = COALESCE(runtime_ended_at, ?),
        runtime_end_success = COALESCE(runtime_end_success, ?),
        runtime_end_error = COALESCE(?, runtime_end_error),
        runtime_end_source = COALESCE(?, runtime_end_source),
        token_input = COALESCE(?, token_input),
        token_output = COALESCE(?, token_output),
        token_total = COALESCE(?, token_total)
    WHERE id = ?
      AND status IN ('queued', 'dispatched', 'running')
      AND runtime_ended_at IS NULL
  `, nextStatus, endedAt, endedAt, endedAt, params.event.success ? 1 : 0, runtimeEndError, runtimeEndSource, tokenUsage.input, tokenUsage.output, tokenUsage.total, params.instanceId);
  if (!claim.changes) return { changed: false, nextStatus };

  if (existing.task_id) {
    await scheduleEndedActiveInstanceLinkageCleanup(db, existing.task_id, params.instanceId, {
            changedBy: 'task_lifecycle',
          });
  }

  const missingRequiredLifecycleOutcome = Boolean(
    requiresSemanticOutcome
      && params.event.success
      && !existing.lifecycle_outcome_posted_at
      && !existing.task_outcome,
  );
  const shouldPostTerminalFailureOutcome = Boolean(
    !missingRequiredLifecycleOutcome
      && !existing.lifecycle_outcome_posted_at
      && !existing.task_outcome
      && !params.event.success,
  );
  const failureSummary = missingRequiredLifecycleOutcome
    ? `${params.runtimeName} runtime ended without required lifecycle outcome`
    : shouldPostTerminalFailureOutcome
      ? params.event.error
        ? `${params.runtimeName} runtime failed: ${params.event.error}`
        : `${params.runtimeName} runtime failed (${params.event.reason ?? 'error'})`
      : null;

  await recordRunCheckIn(db, {
        instanceId: params.instanceId,
        stage: 'completion',
        summary: failureSummary
          ?? `${params.runtimeName} runtime ${params.event.type} (${params.event.reason ?? (params.event.success ? 'completed' : 'error')})`,
        outcome: shouldPostTerminalFailureOutcome
          ? 'failed'
          : (params.event.reason ?? (params.event.success ? 'completed' : 'error')),
        runtimeEndSuccess: params.event.success,
        runtimeEndError: missingRequiredLifecycleOutcome ? failureSummary : runtimeEndError,
        runtimeEndSource,
        meaningfulOutput: true,
        forceNote: true,
      });

  if (shouldPostTerminalFailureOutcome || missingRequiredLifecycleOutcome) {
    const hasTaskCustomFields = await tableHasColumn(db, 'tasks', 'custom_fields_json');
    const taskRow = await db.get(`
      SELECT ji.task_id, ji.agent_id,
             t.status AS task_status,
             t.project_id,
             t.agent_id AS task_agent_id,
             t.task_type,
             t.sprint_id,
             s.sprint_type,
             ${hasTaskCustomFields ? 't.custom_fields_json' : 'NULL AS custom_fields_json'}
      FROM job_instances ji
      LEFT JOIN tasks t ON t.id = ji.task_id
      LEFT JOIN sprints s ON s.id = t.sprint_id
      WHERE ji.id = ?
    `, params.instanceId) as {
      task_id: number | null;
      agent_id: number | null;
      task_status: string | null;
      project_id: number | null;
      task_agent_id: number | null;
      task_type: string | null;
      sprint_id: number | null;
      sprint_type: string | null;
      custom_fields_json: string | null;
    } | undefined;

    if (taskRow?.task_id) {
      const canonicalTaskRow = getCanonicalTaskRecord(taskRow as unknown as Record<string, unknown>);
      const resolvedWorkflow = taskRow.task_status ? await resolveWorkflow({
              taskStatus: taskRow.task_status,
              taskType: taskRow.task_type,
              sprintId: taskRow.sprint_id,
              sprintType: taskRow.sprint_type,
              db,
            }) : null;
      const changedBy = params.changedBy ?? (taskRow.agent_id ? `agent:${taskRow.agent_id}` : `${params.event.source ?? params.runtimeName.toLowerCase()}-runtime`);

      if (missingRequiredLifecycleOutcome) {
        await markTaskNeedsAttentionForMissingSemanticHandoff(db, {
                    taskId: taskRow.task_id,
                    instanceId: params.instanceId,
                    changedBy,
                    workflowPhase: resolvedWorkflow?.workflowPhase ?? null,
                    priorTaskStatus: taskRow.task_status ?? existing.status,
                    sessionKey: existing.session_key,
                    reviewQaDeployEvidenceRecorded: determineRuntimeEndEvidenceRecorded(resolvedWorkflow?.workflowPhase ?? null, canonicalTaskRow),
                    runtimeEnd: {
                      source: runtimeEndSource,
                      success: params.event.success,
                      endedAt,
                      error: failureSummary,
                    },
                  });
      } else if (shouldPostTerminalFailureOutcome) {
        await applyConfiguredRuntimeFailedEvent(db, {
          taskId: taskRow.task_id,
          changedBy,
          instanceId: params.instanceId,
          priorTaskStatus: taskRow.task_status ?? existing.status,
          projectId: taskRow.project_id,
          taskType: taskRow.task_type,
          agentId: taskRow.task_agent_id,
          summary: failureSummary ?? `${params.runtimeName} runtime failed`,
          runtimeEndSource,
          runtimeEndError: params.event.error ?? null,
        });
      }
    }
  }

  return { changed: true, nextStatus, missingRequiredLifecycleOutcome };
}
