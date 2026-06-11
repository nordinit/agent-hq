import type Database from 'better-sqlite3';
import { createAgentContext, destroyAgentContext } from '../../services/browserPool';
import { resolveWorkflow } from '../../services/contracts/workflowContract';
import { upsertCanonicalSessionForInstance } from '../../lib/canonicalSessions';
import { insertRuntimeLog } from '../../lib/runtimeTenantScope';
import { resolveRuntimeAgentSlug } from '../../lib/sessionKeys';
import { scheduleEndedActiveInstanceLinkageCleanup } from '../../lib/taskLifecycle';
import { markTaskNeedsAttentionForMissingSemanticHandoff, taskRequiresSemanticOutcome } from './lifecycleHandoff';
import { recordRunCheckIn } from './observability';
import { determineRuntimeEndEvidenceRecorded } from './runtimeEnd';
import { normalizeTokenUsage } from './tokenUsage';
import { AGENT_HQ_RUNTIME_SOURCE, resolveWorkflowEventMapping } from '../routing/externalEventMappings';
import { notifyTaskStatusChange } from '../../lib/taskNotifications';
import { writeTaskHistory, writeTaskStatusChange } from '../tasks/history';
import { syncTaskActiveAgentFromInstance } from '../tasks/ownership';
import { applyConfiguredRuntimeFailedEvent } from './runtimeFailureEvent';

const START_EVENT_LIVE_INSTANCE_STATUSES = ['queued', 'dispatched', 'running'] as const;

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
  } catch {
    return false;
  }
}

function isStartEventLiveInstanceStatus(status: string | null | undefined): boolean {
  return Boolean(status && START_EVENT_LIVE_INSTANCE_STATUSES.includes(status as typeof START_EVENT_LIVE_INSTANCE_STATUSES[number]));
}

function applyConfiguredStartEvent(db: Database.Database, instanceId: number, changedBy: string): void {
  const task = db.prepare(`
    SELECT t.id,
           ${tableHasColumn(db, 'tasks', 'tenant_id') ? 't.tenant_id' : 'NULL'} AS tenant_id,
           t.status, t.task_type, t.project_id, t.agent_id, t.active_instance_id,
           t.sprint_id, s.sprint_type,
           ji.status AS instance_status
    FROM tasks t
    LEFT JOIN sprints s ON s.id = t.sprint_id
    JOIN job_instances ji ON ji.task_id = t.id
    WHERE ji.id = ?
    LIMIT 1
  `).get(instanceId) as {
    id: number;
    status: string;
    tenant_id: number | null;
    task_type: string | null;
    project_id: number | null;
    sprint_id: number | null;
    sprint_type: string | null;
    agent_id: number | null;
    active_instance_id: number | null;
    instance_status: string | null;
  } | undefined;
  if (!task) return;
  if (task.active_instance_id !== null && task.active_instance_id !== instanceId) return;

  if (task.active_instance_id === null) {
    if (!isStartEventLiveInstanceStatus(task.instance_status)) return;

    const result = db.prepare(`
      UPDATE tasks
      SET active_instance_id = ?, updated_at = datetime('now')
      WHERE id = ?
        AND active_instance_id IS NULL
    `).run(instanceId, task.id);

    if (result.changes === 0) return;
    task.active_instance_id = instanceId;
    syncTaskActiveAgentFromInstance(db, task.id);
    writeTaskHistory(db, task.id, changedBy, 'active_instance_id', null, instanceId);
  }

  writeTaskHistory(db, task.id, changedBy, 'workflow_event_source', null, AGENT_HQ_RUNTIME_SOURCE, false);
  writeTaskHistory(db, task.id, changedBy, 'workflow_event_source_kind', null, 'agent_hq_internal', false);
  writeTaskHistory(db, task.id, changedBy, 'workflow_event_name', null, 'agent_started', false);
  writeTaskHistory(db, task.id, changedBy, 'workflow_event_instance_id', null, instanceId, false);

  const mapping = resolveWorkflowEventMapping(db, {
    source: AGENT_HQ_RUNTIME_SOURCE,
    eventName: 'agent_started',
    tenantId: task.tenant_id,
    projectId: task.project_id,
    sprintId: task.sprint_id,
    sprintType: task.sprint_type,
    taskType: task.task_type,
    currentStatus: task.status,
  }) ?? resolveWorkflowEventMapping(db, {
    source: changedBy,
    eventName: 'agent_started',
    tenantId: task.tenant_id,
    projectId: task.project_id,
    sprintId: task.sprint_id,
    sprintType: task.sprint_type,
    taskType: task.task_type,
    currentStatus: task.status,
  }) ?? resolveWorkflowEventMapping(db, {
    source: 'system',
    eventName: 'agent_started',
    tenantId: task.tenant_id,
    projectId: task.project_id,
    sprintId: task.sprint_id,
    sprintType: task.sprint_type,
    taskType: task.task_type,
    currentStatus: task.status,
  }) ?? resolveWorkflowEventMapping(db, {
    source: '',
    eventName: 'agent_started',
    tenantId: task.tenant_id,
    projectId: task.project_id,
    sprintId: task.sprint_id,
    sprintType: task.sprint_type,
    taskType: task.task_type,
    currentStatus: task.status,
  });

  if (!mapping || mapping.action_kind !== 'status' || !mapping.action_target || mapping.action_target === task.status) return;

  db.prepare(`
    UPDATE tasks
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(mapping.action_target, task.id);

  writeTaskStatusChange(db, task.id, changedBy, task.status, mapping.action_target, {
    instanceId,
    reason: `Workflow event agent_started mapped to ${mapping.action_target}`,
    projectId: task.project_id,
    agentId: task.agent_id,
  });
  notifyTaskStatusChange(db, {
    taskId: task.id,
    fromStatus: task.status,
    toStatus: mapping.action_target,
    source: changedBy,
  });
}

function getInstanceOrThrow(db: Database.Database, instanceId: number): Record<string, unknown> {
  const instance = db.prepare('SELECT * FROM job_instances WHERE id = ?').get(instanceId) as Record<string, unknown> | undefined;
  if (!instance) {
    const error = new Error('Instance not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  return instance;
}

export function startRunInstance(
  db: Database.Database,
  instanceId: number,
  sessionKey: string | null,
) {
  const instance = getInstanceOrThrow(db, instanceId);
  const changedBy = db.prepare(`SELECT name FROM agents WHERE id = ?`).get(instance.agent_id) as { name?: string } | undefined;
  const eventSource = changedBy?.name ?? 'Agent HQ';

  recordRunCheckIn(db, {
    instanceId,
    stage: 'start',
    sessionKey,
    summary: 'Agent session started',
    statusLabel: 'running',
    forceNote: true,
  });

  if (sessionKey) {
    insertRuntimeLog(db, {
      instanceId,
      agentId: instance.agent_id as number | null,
      jobTitle: instance.agent_id as number | null,
      level: 'info',
      message: `Agent started — session key: ${sessionKey}`,
    });
  }

  const agentRow = db.prepare(`
    SELECT a.session_key as agent_session_key, a.openclaw_agent_id, a.name
    FROM job_instances ji
    JOIN agents a ON a.id = ji.agent_id
    WHERE ji.id = ?
  `).get(instanceId) as {
    agent_session_key: string | null;
    openclaw_agent_id: string | null;
    name: string | null;
  } | undefined;
  const agentSlug = resolveRuntimeAgentSlug({
    session_key: agentRow?.agent_session_key ?? null,
    openclaw_agent_id: agentRow?.openclaw_agent_id ?? null,
    name: agentRow?.name ?? null,
  });
  if (agentSlug) {
    createAgentContext(agentSlug, instanceId).catch(err => {
      console.warn(`[instances] Browser context creation failed for instance ${instanceId} (non-fatal):`, err instanceof Error ? err.message : err);
    });
  }

  upsertCanonicalSessionForInstance(db, instanceId, sessionKey);
  applyConfiguredStartEvent(db, instanceId, eventSource);

  const durableRunId = typeof instance.durable_run_id === 'string' && instance.durable_run_id.trim()
    ? instance.durable_run_id.trim()
    : null;
  console.log(`[instances] Instance ${instanceId} started — session: ${sessionKey ?? 'unknown'} durableRunId=${durableRunId ?? 'unknown'}`);
  return durableRunId
    ? { ok: true, id: instanceId, durable_run_id: durableRunId, session_key: sessionKey }
    : { ok: true, id: instanceId, session_key: sessionKey };
}

export function recordInstanceCheckIn(
  db: Database.Database,
  instanceId: number,
  body: Record<string, unknown>,
) {
  const instance = getInstanceOrThrow(db, instanceId);

  const stage = (body.stage as 'heartbeat' | 'progress' | 'blocker' | 'completion' | undefined) ?? 'heartbeat';
  const summary = typeof body.summary === 'string' ? body.summary : undefined;
  const commitHash = typeof body.commit_hash === 'string' ? body.commit_hash : undefined;
  const branchName = typeof body.branch_name === 'string' ? body.branch_name : undefined;
  const blockerReason = typeof body.blocker_reason === 'string' ? body.blocker_reason : undefined;
  const outcome = typeof body.outcome === 'string' ? body.outcome : undefined;
  const sessionKey = typeof body.session_key === 'string' ? body.session_key : null;
  const meaningfulOutput = typeof body.meaningful_output === 'boolean'
    ? body.meaningful_output
    : (stage === 'progress' || Boolean(summary || commitHash || branchName || (Array.isArray(body.changed_files) && body.changed_files.length > 0) || blockerReason));

  const tokenUsage = normalizeTokenUsage(
    {
      input_tokens: typeof body.token_input === 'number' ? body.token_input : null,
      output_tokens: typeof body.token_output === 'number' ? body.token_output : null,
      total_tokens: typeof body.token_total === 'number' ? body.token_total : null,
    },
    body.usage,
    body,
    instance.response ? (() => { try { return JSON.parse(String(instance.response)); } catch { return null; } })() : null,
  );

  if (tokenUsage.input !== null || tokenUsage.output !== null || tokenUsage.total !== null) {
    db.prepare(`
      UPDATE job_instances
      SET token_input = COALESCE(?, token_input),
          token_output = COALESCE(?, token_output),
          token_total = COALESCE(?, token_total)
      WHERE id = ?
    `).run(tokenUsage.input, tokenUsage.output, tokenUsage.total, instanceId);
  }

  const result = recordRunCheckIn(db, {
    instanceId,
    stage,
    sessionKey,
    summary: summary ?? null,
    commitHash: commitHash ?? null,
    branchName: branchName ?? null,
    changedFiles: Array.isArray(body.changed_files) ? body.changed_files as string[] : null,
    changedFilesCount: typeof body.changed_files_count === 'number' ? body.changed_files_count : null,
    blockerReason: blockerReason ?? null,
    outcome: outcome ?? null,
    meaningfulOutput,
  });

  insertRuntimeLog(db, {
    instanceId,
    agentId: instance.agent_id as number | null,
    jobTitle: instance.agent_id as number | null,
    level: 'info',
    message: `Agent check-in received (${stage})${summary ? ` — ${summary}` : ''}`,
  });

  upsertCanonicalSessionForInstance(db, instanceId, sessionKey);
  return { ok: true, id: instanceId, task_id: result.taskId, note_created: result.noteCreated };
}

export async function completeRunInstance(
  db: Database.Database,
  instanceId: number,
  body: Record<string, unknown>,
) {
  const instance = getInstanceOrThrow(db, instanceId);

  const requestedStatus = typeof body.status === 'string' ? body.status : 'done';
  const finalStatus = ['done', 'failed'].includes(requestedStatus) ? requestedStatus : 'done';
  const summary = typeof body.summary === 'string' ? body.summary : null;
  const commitHash = typeof body.commit_hash === 'string' ? body.commit_hash : null;
  const branchName = typeof body.branch_name === 'string' ? body.branch_name : null;
  const outcome = typeof body.outcome === 'string' ? body.outcome : null;
  const taskId = Number(instance.task_id ?? null);
  const requiresOutcome = taskRequiresSemanticOutcome(db, taskId);
  const runtimeEndedWithoutLifecycleOutcome = finalStatus === 'done' && requiresOutcome && !instance.lifecycle_outcome_posted_at;
  const runtimeEndError = runtimeEndedWithoutLifecycleOutcome
    ? 'Runtime ended without required lifecycle outcome'
    : finalStatus === 'failed'
      ? (summary ?? 'Runtime reported failed terminal state')
      : null;

  const taskRow = taskId
    ? db.prepare(`
        SELECT ${tableHasColumn(db, 'tasks', 'tenant_id') ? 't.tenant_id' : 'NULL'} AS tenant_id,
               t.status, t.task_type, t.project_id, t.agent_id, t.sprint_id, s.sprint_type,
               t.review_branch, t.review_commit, t.review_url,
               t.qa_verified_commit, t.qa_tested_url,
               t.merged_commit, t.deployed_commit, t.deploy_target, t.deployed_at
        FROM tasks t
        LEFT JOIN sprints s ON s.id = t.sprint_id
        WHERE t.id = ?
      `).get(taskId) as {
        status: string;
        tenant_id: number | null;
        task_type: string | null;
        project_id: number | null;
        agent_id: number | null;
        sprint_id: number | null;
        sprint_type: string | null;
        review_branch: string | null;
        review_commit: string | null;
        review_url: string | null;
        qa_verified_commit: string | null;
        qa_tested_url: string | null;
        merged_commit: string | null;
        deployed_commit: string | null;
        deploy_target: string | null;
        deployed_at: string | null;
      } | undefined
    : undefined;
  const resolvedWorkflow = taskRow ? resolveWorkflow({
    taskStatus: taskRow.status,
    taskType: taskRow.task_type,
    sprintId: taskRow.sprint_id,
    sprintType: taskRow.sprint_type,
    db,
  }) : null;
  const evidenceRecorded = determineRuntimeEndEvidenceRecorded(resolvedWorkflow?.workflowPhase ?? null, taskRow);

  const tokenUsage = normalizeTokenUsage(
    {
      input_tokens: typeof body.token_input === 'number' ? body.token_input : null,
      output_tokens: typeof body.token_output === 'number' ? body.token_output : null,
      total_tokens: typeof body.token_total === 'number' ? body.token_total : null,
    },
    body.usage,
    body,
    instance.response ? (() => { try { return JSON.parse(String(instance.response)); } catch { return null; } })() : null,
  );

  db.prepare(`
    UPDATE job_instances
    SET status = ?,
        completed_at = datetime('now'),
        runtime_ended_at = COALESCE(runtime_ended_at, datetime('now')),
        runtime_end_success = COALESCE(runtime_end_success, ?),
        runtime_end_error = COALESCE(runtime_end_error, ?),
        runtime_end_source = COALESCE(runtime_end_source, 'instance_complete'),
        token_input = COALESCE(?, token_input),
        token_output = COALESCE(?, token_output),
        token_total = COALESCE(?, token_total)
    WHERE id = ?
  `).run(
    finalStatus,
    finalStatus === 'done' ? 1 : 0,
    runtimeEndError,
    tokenUsage.input,
    tokenUsage.output,
    tokenUsage.total,
    instanceId,
  );

  if (taskId) {
    scheduleEndedActiveInstanceLinkageCleanup(db, taskId, instanceId, {
      changedBy: 'task_lifecycle',
    });
  }

  recordRunCheckIn(db, {
    instanceId,
    stage: 'completion',
    summary,
    commitHash,
    branchName,
    changedFiles: Array.isArray(body.changed_files) ? body.changed_files as string[] : null,
    changedFilesCount: typeof body.changed_files_count === 'number' ? body.changed_files_count : null,
    outcome: outcome ?? finalStatus,
    meaningfulOutput: true,
    statusLabel: finalStatus,
    forceNote: !runtimeEndedWithoutLifecycleOutcome,
    runtimeEndSuccess: finalStatus === 'done',
    runtimeEndError: runtimeEndedWithoutLifecycleOutcome
      ? 'Runtime ended without required lifecycle outcome'
      : runtimeEndError,
    runtimeEndSource: 'instance_complete',
  });

  if (runtimeEndedWithoutLifecycleOutcome && instance.task_id) {
    markTaskNeedsAttentionForMissingSemanticHandoff(db, {
      taskId,
      instanceId,
      changedBy: instance.agent_id ? `agent:${instance.agent_id}` : 'system',
      workflowPhase: resolvedWorkflow?.workflowPhase ?? null,
      priorTaskStatus: taskRow?.status ?? String(instance.status ?? ''),
      sessionKey: typeof instance.session_key === 'string' ? instance.session_key : null,
      reviewQaDeployEvidenceRecorded: evidenceRecorded,
      runtimeEnd: {
        source: 'instance_complete',
        success: true,
        endedAt: new Date().toISOString(),
        error: 'Runtime ended without required lifecycle outcome',
      },
    });
  }

  if (finalStatus === 'failed' && taskId && taskRow && !runtimeEndedWithoutLifecycleOutcome) {
    await applyConfiguredRuntimeFailedEvent(db, {
      taskId,
      instanceId,
      changedBy: instance.agent_id ? `agent:${instance.agent_id}` : AGENT_HQ_RUNTIME_SOURCE,
      priorTaskStatus: taskRow.status,
      tenantId: taskRow.tenant_id,
      projectId: taskRow.project_id,
      sprintId: taskRow.sprint_id,
      sprintType: taskRow.sprint_type,
      taskType: taskRow.task_type,
      agentId: taskRow.agent_id,
      summary,
      runtimeEndSource: 'instance_complete',
      runtimeEndError,
    });
  }

  if (summary) {
    insertRuntimeLog(db, {
      instanceId,
      agentId: instance.agent_id as number | null,
      jobTitle: instance.agent_id as number | null,
      level: 'info',
      message: `Agent completion report: ${summary}`,
    });
  }

  insertRuntimeLog(db, {
    instanceId,
    agentId: instance.agent_id as number | null,
    jobTitle: instance.agent_id as number | null,
    level: 'info',
    message: `Job instance ${instanceId} marked ${finalStatus} via agent callback`,
  });

  const completedAgentRow = db.prepare(`
    SELECT a.session_key as agent_session_key, a.openclaw_agent_id, a.name
    FROM job_instances ji
    JOIN agents a ON a.id = ji.agent_id
    WHERE ji.id = ?
  `).get(instanceId) as {
    agent_session_key: string | null;
    openclaw_agent_id: string | null;
    name: string | null;
  } | undefined;
  const completedAgentSlug = resolveRuntimeAgentSlug({
    session_key: completedAgentRow?.agent_session_key ?? null,
    openclaw_agent_id: completedAgentRow?.openclaw_agent_id ?? null,
    name: completedAgentRow?.name ?? null,
  });
  if (completedAgentSlug) {
    destroyAgentContext(completedAgentSlug, instanceId).catch(err => {
      console.warn(`[instances] Browser context cleanup failed for instance ${instanceId} (non-fatal):`, err instanceof Error ? err.message : err);
    });
  }

  console.log(`[instances] Instance ${instanceId} marked ${finalStatus}${summary ? ` — ${summary}` : ''}`);

  upsertCanonicalSessionForInstance(db, instanceId, instance.session_key as string | null);
  return { ok: true, id: instanceId, status: finalStatus };
}
