import type { DispatchParams, RuntimeEndEvent } from '../types';
import { getDb } from '../../db/client';
import { ensureCanonicalSessionForInstance } from '../../lib/canonicalSessions';
import { scheduleEndedActiveInstanceLinkageCleanup } from '../../lib/taskLifecycle';
import { recordRunCheckIn } from '../../domains/runs/observability';
import { derivePostRuntimeInstanceStatus, determineRuntimeEndEvidenceRecorded } from '../../domains/runs/runtimeEnd';
import { markTaskNeedsAttentionForMissingSemanticHandoff, taskRequiresSemanticOutcome } from '../../domains/runs/lifecycleHandoff';
import { applyConfiguredRuntimeFailedEvent } from '../../domains/runs/runtimeFailureEvent';
import { normalizeTokenUsage } from '../../domains/runs/tokenUsage';
import { getCanonicalTaskRecord } from '../../domains/tasks/evidence';
import { resolveWorkflow } from '../../services/contracts/workflowContract';
import { isProviderLimitFailureText, trimProviderLimitFailureText } from '../providerLimitFailure';
import {
  evaluateOpenClawInstanceSessionState,
  OPENCLAW_TERMINAL_QUIESCENCE_MS,
  type OpenClawInstanceSessionStateResult,
} from '../../domains/runs/openclawSessionState';
import { stopOpenClawRawSessionTerminalPoll } from './transcript';
import { nowTimestamp } from '../../lib/timestamps';
import { type Db } from "../../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../../db/introspection";

const deferredRuntimeEndRetries = new Map<number, NodeJS.Timeout>();

async function tableHasColumn(db: Db, table: string, column: string): Promise<boolean> {
    return await sharedColumnExists(db, table, column);
}

function isOpenClawPreReplyFailure(content: string): boolean {
  const haystack = content.toLowerCase();
  if (haystack.includes('agent failed before reply')) return true;
  return haystack.includes('all models failed')
    && (
      haystack.includes('no api key found')
      || haystack.includes('oauth token refresh failed')
      || haystack.includes('(auth)')
      || isProviderLimitFailureText(content)
      || haystack.includes('billing')
    );
}

function trimRuntimeError(content: string): string {
  return trimProviderLimitFailureText(content);
}

export async function detectOpenClawPreReplyFailure(db: Db, instanceId: number): Promise<string | null> {
  const rows = await db.all(`
    SELECT content
    FROM chat_messages
    WHERE instance_id = ?
      AND role = 'assistant'
    ORDER BY timestamp DESC
    LIMIT 8
  `, instanceId) as Array<{ content: string | null }>;

  for (const row of rows) {
    const content = row.content ?? '';
    if (isOpenClawPreReplyFailure(content)) {
      return trimRuntimeError(content);
    }
  }
  return null;
}

export function stopDeferredRuntimeEndRetry(instanceId: number): void {
  const timer = deferredRuntimeEndRetries.get(instanceId);
  if (timer) {
    clearTimeout(timer);
    deferredRuntimeEndRetries.delete(instanceId);
  }
}

function scheduleDeferredRuntimeEndRetry(
  instanceId: number,
  event: RuntimeEndEvent,
  onRuntimeEnd?: DispatchParams['onRuntimeEnd'],
  retryAfterMs = OPENCLAW_TERMINAL_QUIESCENCE_MS,
): void {
  if (deferredRuntimeEndRetries.has(instanceId)) return;
  const delayMs = Math.max(1000, Math.min(retryAfterMs + 500, OPENCLAW_TERMINAL_QUIESCENCE_MS));
  const timer = setTimeout(() => {
    deferredRuntimeEndRetries.delete(instanceId);
    void handleOpenClawRuntimeEnd(instanceId, event, onRuntimeEnd);
  }, delayMs);
  deferredRuntimeEndRetries.set(instanceId, timer);
}

export async function evaluateRawSessionEndCandidate(
  db: Db,
  instanceId: number,
): Promise<OpenClawInstanceSessionStateResult | null> {
  try {
    const evaluation = await evaluateOpenClawInstanceSessionState(db, instanceId);
    if (!evaluation.state || !evaluation.decision) return null;
    return evaluation;
  } catch (err) {
    console.warn(
      `[OpenClawRuntime] Failed to evaluate raw OpenClaw session state for instance #${instanceId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export function applyRawSessionTerminalDecision(
  event: RuntimeEndEvent,
  evaluation: OpenClawInstanceSessionStateResult | null,
): RuntimeEndEvent {
  const decision = evaluation?.decision;
  if (!decision?.terminal) return event;

  return {
    ...event,
    success: decision.success,
    reason: decision.reason,
    error: decision.error ?? (decision.success ? undefined : event.error),
    endedAt: evaluation?.state?.lastEventAt ?? event.endedAt,
    metadata: {
      ...(event.metadata ?? {}),
      raw_jsonl_terminal_authority: true,
      ...(decision.metadata ?? {}),
    },
  };
}

export async function handleOpenClawRuntimeEnd(
  instanceId: number,
  event: RuntimeEndEvent,
  onRuntimeEnd?: DispatchParams['onRuntimeEnd'],
): Promise<void> {
  try {
    const db = getDb();
    const existing = await db.get(`
        SELECT status, lifecycle_outcome_posted_at, task_outcome, task_id, session_key
        FROM job_instances
        WHERE id = ?
      `, instanceId) as {
      status: string;
      lifecycle_outcome_posted_at: string | null;
      task_outcome: string | null;
      task_id: number | null;
      session_key: string | null;
    } | undefined;
    if (!existing) return;

    const rawEvaluation = await evaluateRawSessionEndCandidate(db, instanceId);
    if (rawEvaluation?.decision && !rawEvaluation.decision.terminal) {
      const retryAfterMs = rawEvaluation.decision.retryAfterMs ?? OPENCLAW_TERMINAL_QUIESCENCE_MS;
      console.info(
        `[OpenClawRuntime] Deferring runtime end for instance #${instanceId}` +
        ` while raw JSONL state is ${rawEvaluation.state?.kind ?? 'unknown'}` +
        ` (${rawEvaluation.decision.deferReason ?? 'not_terminal'}); retrying in ${Math.ceil(retryAfterMs / 1000)}s`,
      );
      scheduleDeferredRuntimeEndRetry(instanceId, event, onRuntimeEnd, retryAfterMs);
      return;
    }

    const requiresSemanticOutcome = await taskRequiresSemanticOutcome(db, existing.task_id);
    let normalizedEvent = applyRawSessionTerminalDecision(event, rawEvaluation);
    if (normalizedEvent.success) {
      const failureText = await detectOpenClawPreReplyFailure(db, instanceId);
      if (failureText) {
        normalizedEvent = {
          ...normalizedEvent,
          success: false,
          reason: 'error',
          error: failureText,
          metadata: {
            ...(event.metadata ?? {}),
            openclaw_pre_reply_failure_detected: true,
            gateway_terminal_success: event.success,
            gateway_terminal_reason: event.reason ?? null,
          },
        };
      }
    }

    const runtimeEndError = normalizedEvent.error ?? (normalizedEvent.success ? null : (normalizedEvent.reason ?? 'error'));
    const runtimeEndSource = 'instance_complete';
    const tokenUsage = normalizeTokenUsage(normalizedEvent.metadata, normalizedEvent);
    const nowIso = nowTimestamp();
    const nextStatus = derivePostRuntimeInstanceStatus(
      existing.status,
      nowIso,
      existing.lifecycle_outcome_posted_at,
      existing.task_outcome,
      normalizedEvent.success,
      requiresSemanticOutcome,
    );
    // The status list includes 'queued' deliberately, matching the shared helper
    // in domains/runs/runtimeEnd.ts. Omitting it meant an instance that
    // terminated while still queued matched zero rows here, so the runtime
    // persisted no terminal state at all and the run fell through to the
    // watchdog. (Kept out of the SQL itself — this statement is string-matched
    // by tests and shipped into logs.)
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
          AND status IN ('queued', 'running', 'dispatched')
          AND runtime_ended_at IS NULL
      `, nextStatus, nowIso, nowIso, nowIso, normalizedEvent.success ? 1 : 0, runtimeEndError, runtimeEndSource, tokenUsage.input, tokenUsage.output, tokenUsage.total, instanceId);
    if (!claim.changes) {
      return;
    }
    stopDeferredRuntimeEndRetry(instanceId);
    stopOpenClawRawSessionTerminalPoll(instanceId);

    if (existing.task_id) {
      await scheduleEndedActiveInstanceLinkageCleanup(db, existing.task_id, instanceId, {
                changedBy: 'task_lifecycle',
              });
    }

    const eventId = `oc-turn-end-${instanceId}`;
    await db.run(`
        INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type, event_meta)
        SELECT ?, agent_id, id, 'system', ?, ?, 'turn_end', ?
        FROM job_instances
        WHERE id = ?
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          timestamp = excluded.timestamp,
          event_type = excluded.event_type,
          event_meta = excluded.event_meta
      `, eventId, `Run ${normalizedEvent.reason ?? (normalizedEvent.success ? 'completed' : 'ended')}`, normalizedEvent.endedAt, JSON.stringify({
              runtime_end_type: normalizedEvent.type,
              terminal_reason: normalizedEvent.reason ?? (normalizedEvent.success ? 'completed' : 'error'),
              session_key: normalizedEvent.sessionKey,
              run_id: normalizedEvent.runId ?? null,
              success: normalizedEvent.success,
              error: normalizedEvent.error ?? null,
              ...(normalizedEvent.metadata ?? {}),
            }), instanceId);

    try {
      await ensureCanonicalSessionForInstance(instanceId, {
        forceIngest: true,
        sessionKey: existing.session_key,
      });
    } catch (canonicalErr) {
      console.warn(
        `[OpenClawRuntime] Failed to repair canonical transcript for instance #${instanceId}:`,
        canonicalErr instanceof Error ? canonicalErr.message : String(canonicalErr),
      );
    }

    const missingRequiredLifecycleOutcome = requiresSemanticOutcome
      && normalizedEvent.success
      && !existing.lifecycle_outcome_posted_at
      && !existing.task_outcome;

    const shouldPostTerminalFailureOutcome = !missingRequiredLifecycleOutcome
      && !existing.lifecycle_outcome_posted_at
      && !existing.task_outcome
      && !normalizedEvent.success;

    let failureSummary: string | null = null;
    if (shouldPostTerminalFailureOutcome || missingRequiredLifecycleOutcome) {
      failureSummary = missingRequiredLifecycleOutcome
        ? 'OpenClaw runtime ended without required lifecycle outcome'
        : normalizedEvent.error
          ? `OpenClaw runtime failed: ${normalizedEvent.error}`
          : `OpenClaw runtime failed (${normalizedEvent.reason ?? 'error'})`;
    }

    await recordRunCheckIn(db, {
            instanceId,
            stage: 'completion',
            summary: failureSummary
              ?? `OpenClaw runtime ${normalizedEvent.type} (${normalizedEvent.reason ?? (normalizedEvent.success ? 'completed' : 'error')})`,
            outcome: shouldPostTerminalFailureOutcome
              ? 'failed'
              : (normalizedEvent.reason ?? (normalizedEvent.success ? 'completed' : 'error')),
            runtimeEndSuccess: normalizedEvent.success,
            runtimeEndError: missingRequiredLifecycleOutcome ? failureSummary : runtimeEndError,
            runtimeEndSource,
            meaningfulOutput: true,
            forceNote: true,
          });

    await db.run(`
        UPDATE job_instances
        SET response = jsonb_set((COALESCE(response, '{}'))::jsonb, '{runtimeEnd}', (?)::jsonb)
        WHERE id = ?
      `, JSON.stringify(normalizedEvent), instanceId);

    if (shouldPostTerminalFailureOutcome || missingRequiredLifecycleOutcome) {
      const taskRow = await db.get(`
          SELECT ji.task_id, ji.agent_id,
                 t.status AS task_status,
                 t.project_id,
                 t.agent_id AS task_agent_id,
                 t.task_type,
                 t.sprint_id,
                 s.sprint_type,
                 ${await tableHasColumn(db, 'tasks', 'custom_fields_json') ? 't.custom_fields_json' : 'NULL AS custom_fields_json'}
          FROM job_instances ji
          LEFT JOIN tasks t ON t.id = ji.task_id
          LEFT JOIN sprints s ON s.id = t.sprint_id
          WHERE ji.id = ?
        `, instanceId) as {
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
        const resolvedWorkflow = taskRow.task_status ? await resolveWorkflow({
                  taskStatus: taskRow.task_status,
                  taskType: taskRow.task_type,
                  sprintId: taskRow.sprint_id,
                  sprintType: taskRow.sprint_type,
                  db,
                }) : null;
        const evidenceRecorded = determineRuntimeEndEvidenceRecorded(
          resolvedWorkflow?.workflowPhase ?? null,
          getCanonicalTaskRecord(taskRow as unknown as Record<string, unknown>),
        );
        if (missingRequiredLifecycleOutcome) {
          console.warn(`[OpenClawRuntime] Missing lifecycle outcome after runtime end, quarantining task #${taskRow.task_id} instance #${instanceId}`);
          await markTaskNeedsAttentionForMissingSemanticHandoff(db, {
                        taskId: taskRow.task_id,
                        instanceId,
                        changedBy: taskRow.agent_id ? `agent:${taskRow.agent_id}` : 'openclaw-runtime',
                        workflowPhase: resolvedWorkflow?.workflowPhase ?? null,
                        priorTaskStatus: taskRow.task_status ?? existing.status,
                        sessionKey: existing.session_key,
                        reviewQaDeployEvidenceRecorded: evidenceRecorded,
                        runtimeEnd: {
                          source: runtimeEndSource,
                          success: normalizedEvent.success,
                          endedAt: normalizedEvent.endedAt,
                          error: failureSummary,
                        },
                      });
        }
        if (!missingRequiredLifecycleOutcome) {
          await applyConfiguredRuntimeFailedEvent(db, {
            taskId: taskRow.task_id,
            changedBy: taskRow.agent_id ? `agent:${taskRow.agent_id}` : 'openclaw-runtime',
            instanceId,
            priorTaskStatus: taskRow.task_status ?? existing.status,
            projectId: taskRow.project_id,
            taskType: taskRow.task_type,
            agentId: taskRow.task_agent_id,
            summary: failureSummary ?? 'OpenClaw runtime failed',
            runtimeEndSource,
            runtimeEndError: normalizedEvent.error ?? null,
          });
        }
      }
    }

    if (missingRequiredLifecycleOutcome) {
      console.info(`[OpenClawRuntime] Prevented automatic failed outcome/redispatch for instance #${instanceId} because runtime ended without required lifecycle outcome`);
    }

    await onRuntimeEnd?.(normalizedEvent);
  } catch (err) {
    console.warn(
      `[OpenClawRuntime] Failed to persist turn-end event for instance #${instanceId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
