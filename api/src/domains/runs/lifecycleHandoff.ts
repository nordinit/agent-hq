import type Database from 'better-sqlite3';
import { notifyTaskStatusChange } from '../../lib/taskNotifications';
import { resolveWorkflow } from '../../services/contracts/workflowContract';
import {
  AGENT_HQ_RUNTIME_SOURCE,
  MISSING_OUTCOME_WORKFLOW_EVENTS,
  PRIMARY_MISSING_OUTCOME_WORKFLOW_EVENT,
  resolveWorkflowEventMapping,
  type WorkflowEventMapping,
} from '../routing/externalEventMappings';
import { emitIntegrityEvent, writeTaskHistory, writeTaskRuntimeEndHistory, writeTaskStatusChange } from '../tasks/history';
import { toCanonicalTimestampOrNow } from '../../lib/timestamps';

export type LifecycleHandoffStatus = 'posted' | 'missing' | 'reconciled';
export type HandoffEvidencePresence = 'yes' | 'no';
export type MissingSemanticHandoffDisposition = 'recorded_only' | 'moved_to_needs_attention';

interface TaskLifecycleContractRow {
  status: string;
  task_type: string | null;
  sprint_id: number | null;
  sprint_type: string | null;
}

interface MissingHandoffRuntimeMeta {
  source?: string | null;
  success?: boolean | null;
  endedAt?: string | null;
  error?: string | null;
}

interface MarkMissingHandoffParams {
  taskId: number | null | undefined;
  instanceId: number;
  changedBy: string;
  workflowPhase: string | null;
  priorTaskStatus: string | null;
  sessionKey?: string | null;
  reviewQaDeployEvidenceRecorded?: HandoffEvidencePresence;
  runtimeEnd?: MissingHandoffRuntimeMeta;
}

export function taskRequiresSemanticOutcome(db: Database.Database, taskId: number | null | undefined): boolean {
  if (!taskId) return false;
  const task = db.prepare(`
    SELECT t.status, t.task_type, t.sprint_id, s.sprint_type
    FROM tasks t
    LEFT JOIN sprints s ON s.id = t.sprint_id
    WHERE t.id = ?
    LIMIT 1
  `).get(taskId) as TaskLifecycleContractRow | undefined;
  if (!task?.status) return false;

  const workflow = resolveWorkflow({
    taskStatus: task.status,
    taskType: task.task_type,
    sprintId: task.sprint_id,
    sprintType: task.sprint_type,
    db,
  });
  return workflow.requiresSemanticOutcome;
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
  } catch {
    return false;
  }
}

function resolveMissingOutcomeMapping(db: Database.Database, task: { tenant_id: number | null; project_id: number | null; sprint_id?: number | null; sprint_type?: string | null; task_type: string | null; status: string }): WorkflowEventMapping | null {
  const mappingsTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'external_event_mappings'`).get() as { name: string } | undefined;
  if (!mappingsTable) return null;

  for (const eventName of MISSING_OUTCOME_WORKFLOW_EVENTS) {
    const mapping = resolveWorkflowEventMapping(db, {
      source: AGENT_HQ_RUNTIME_SOURCE,
      eventName,
      tenantId: task.tenant_id,
      projectId: task.project_id,
      sprintId: task.sprint_id ?? null,
      sprintType: task.sprint_type ?? null,
      taskType: task.task_type,
      currentStatus: task.status,
    });
    if (mapping) return mapping;
  }
  return null;
}

export function markTaskNeedsAttentionForMissingSemanticHandoff(
  db: Database.Database,
  params: MarkMissingHandoffParams,
): MissingSemanticHandoffDisposition | null {
  db.prepare(`
    UPDATE job_instances
    SET lifecycle_handoff_status = 'missing',
        semantic_outcome_missing = 1,
        runtime_completed_at = COALESCE(runtime_completed_at, runtime_ended_at, ?)
    WHERE id = ?
      AND COALESCE(task_outcome, '') = ''
      AND lifecycle_outcome_posted_at IS NULL
  `).run(toCanonicalTimestampOrNow(params.runtimeEnd?.endedAt), params.instanceId);

  if (!params.taskId) return null;

  const taskColumns = new Set((db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map(column => column.name));
  const task = db.prepare(`
    SELECT tasks.id AS id,
           ${tableHasColumn(db, 'tasks', 'tenant_id') ? 'tasks.tenant_id' : 'NULL'} AS tenant_id,
           tasks.title AS title,
           tasks.status AS status,
           ${taskColumns.has('task_type') ? 'tasks.task_type' : 'NULL'} AS task_type,
           ${taskColumns.has('project_id') ? 'tasks.project_id' : 'NULL'} AS project_id,
           ${taskColumns.has('sprint_id') ? 'tasks.sprint_id' : 'NULL'} AS sprint_id,
           s.sprint_type,
           ${taskColumns.has('agent_id') ? 'tasks.agent_id' : 'NULL'} AS agent_id
    FROM tasks
    LEFT JOIN sprints s ON s.id = tasks.sprint_id
    WHERE tasks.id = ?
  `).get(params.taskId) as
    | { id: number; tenant_id: number | null; title: string; status: string; task_type: string | null; project_id: number | null; sprint_id: number | null; sprint_type: string | null; agent_id: number | null }
    | undefined;
  if (!task) return null;

  const priorStatus = task.status;
  const mapping = resolveMissingOutcomeMapping(db, task);
  const eventName = mapping?.event_name ?? PRIMARY_MISSING_OUTCOME_WORKFLOW_EVENT;

  writeTaskRuntimeEndHistory(db, params.taskId, params.changedBy, {
    endedAt: params.runtimeEnd?.endedAt,
    success: params.runtimeEnd?.success ?? null,
    source: params.runtimeEnd?.source ?? null,
    error: params.runtimeEnd?.error ?? null,
    lifecycleHandoff: 'missing_after_runtime_end',
  });
  writeTaskHistory(db, params.taskId, params.changedBy, 'workflow_event_source', null, AGENT_HQ_RUNTIME_SOURCE, false);
  writeTaskHistory(db, params.taskId, params.changedBy, 'workflow_event_source_kind', null, 'agent_hq_internal', false);
  writeTaskHistory(db, params.taskId, params.changedBy, 'workflow_event_name', null, eventName, false);
  writeTaskHistory(db, params.taskId, params.changedBy, 'workflow_event_aliases', null, MISSING_OUTCOME_WORKFLOW_EVENTS.join(','), false);
  writeTaskHistory(db, params.taskId, params.changedBy, 'workflow_event_instance_id', null, params.instanceId, false);
  writeTaskHistory(db, params.taskId, params.changedBy, 'workflow_event_runtime_end_source', null, params.runtimeEnd?.source ?? 'unknown', false);
  writeTaskHistory(db, params.taskId, params.changedBy, 'workflow_event_mapping_id', null, mapping?.id ?? null, false);
  writeTaskHistory(db, params.taskId, params.changedBy, 'workflow_event_action_kind', null, mapping?.action_kind ?? null, false);
  writeTaskHistory(db, params.taskId, params.changedBy, 'workflow_event_action_target', null, mapping?.action_target ?? null, false);

  let currentStatus = priorStatus;
  let actionApplied = false;
  if (mapping?.action_kind === 'status' && mapping.action_target && mapping.action_target !== priorStatus) {
    db.prepare(`
      UPDATE tasks
      SET status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(mapping.action_target, params.taskId);
    writeTaskStatusChange(db, params.taskId, params.changedBy, priorStatus, mapping.action_target, {
      instanceId: params.instanceId,
      reason: `Workflow event ${eventName} via ${AGENT_HQ_RUNTIME_SOURCE}: runtime ended without a recognized semantic outcome`,
      projectId: task.project_id,
      agentId: task.agent_id,
    });
    notifyTaskStatusChange(db, {
      taskId: params.taskId,
      fromStatus: priorStatus,
      toStatus: mapping.action_target,
      source: params.changedBy,
    });
    currentStatus = mapping.action_target;
    actionApplied = true;
  }

  const runtimeEndedSuccessfully = params.runtimeEnd?.success ? 'yes' : 'no';
  const evidenceRecorded = params.reviewQaDeployEvidenceRecorded ?? 'unknown';
  const runtimeEndedAt = params.runtimeEnd?.endedAt ?? 'unknown';
  const runtimeEndedState = params.runtimeEnd?.success ? 'successfully' : 'unsuccessfully';
  const noteLines = [
    'Summary: run ended without required lifecycle outcome',
    'Work completed: runtime session reached a terminal state, but no valid semantic lifecycle outcome was posted for this workflow state',
    'Tests run: runtime completion reconciliation and lifecycle handoff enforcement',
    actionApplied ? 'Result: workflow event action applied' : 'Result: partial',
    `Failure or issue observed: runtime ended ${runtimeEndedState} at the session level without the required lifecycle handoff`,
    'Root cause assessment: control-plane/lifecycle contract failure or missing outcome write; visible workflow movement is controlled by the configured workflow-event mapping',
    `Evidence: instance_id=${params.instanceId}; session_key=${params.sessionKey ?? 'unknown'}; workflow_phase=${params.workflowPhase ?? 'unknown'}; prior_status=${params.priorTaskStatus ?? priorStatus}; runtime_success=${runtimeEndedSuccessfully}; review_qa_deploy_evidence_recorded=${evidenceRecorded}; runtime_end_source=${params.runtimeEnd?.source ?? 'unknown'}; runtime_ended_at=${runtimeEndedAt}; workflow_event=${eventName}; mapping_id=${mapping?.id ?? 'none'}; action=${mapping?.action_kind ?? 'none'}${mapping?.action_target ? `:${mapping.action_target}` : ''}`,
    'Next action: inspect the missing lifecycle outcome, then decide an explicit routed status or semantic outcome if the configured workflow-event action was ignore',
    'Next owner: PM/operator',
    actionApplied ? `Visible status moved by workflow event: ${priorStatus} → ${currentStatus}` : `Visible status preserved: ${currentStatus}`,
    `Instance ID: ${params.instanceId}`,
    `Session key: ${params.sessionKey ?? 'unknown'}`,
    `Workflow phase: ${params.workflowPhase ?? 'unknown'}`,
    `Prior task status: ${params.priorTaskStatus ?? priorStatus}`,
    `Current visible task status: ${currentStatus}`,
    `Runtime ended successfully: ${runtimeEndedSuccessfully}`,
    `Review/QA/deploy evidence recorded: ${evidenceRecorded}`,
    `Workflow event: ${eventName}`,
    mapping ? `Resolved mapping: #${mapping.id}` : 'Resolved mapping: none',
    `Action: ${mapping?.action_kind ?? 'none'}${mapping?.action_target ? ` → ${mapping.action_target}` : ''}`,
    'Recommended next action: inspect the missing lifecycle outcome, then choose an explicit routed move or outcome when needed',
  ];
  if (params.runtimeEnd?.source) noteLines.push(`Runtime end source: ${params.runtimeEnd.source}`);
  if (params.runtimeEnd?.endedAt) noteLines.push(`Runtime ended at: ${params.runtimeEnd.endedAt}`);
  if (params.runtimeEnd?.error) noteLines.push(`Runtime end error: ${params.runtimeEnd.error}`);

  db.prepare(`INSERT INTO task_notes (task_id, author, content) VALUES (?, ?, ?)`).run(params.taskId, params.changedBy, noteLines.join('\n'));

  emitIntegrityEvent(db, {
    taskId: params.taskId,
    anomalyType: 'missing_lifecycle_handoff',
    detail: `Runtime ended on instance #${params.instanceId} without required lifecycle outcome; workflow event ${eventName} action=${mapping?.action_kind ?? 'none'}${mapping?.action_target ? `:${mapping.action_target}` : ''}`,
    instanceId: params.instanceId,
  });
  return actionApplied && currentStatus === 'needs_attention' ? 'moved_to_needs_attention' : 'recorded_only';
}
