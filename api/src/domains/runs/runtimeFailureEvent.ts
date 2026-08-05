import { AGENT_HQ_RUNTIME_SOURCE, RUNTIME_FAILED_EVENT, resolveWorkflowEventMapping } from '../routing/externalEventMappings';
import { notifyTaskStatusChange } from '../../lib/taskNotifications';
import { applyTaskOutcome } from '../../lib/taskOutcome';
import { writeTaskHistory, writeTaskStatusChange } from '../tasks/history';
import { type Db } from "../../db/adapter/types";

export interface RuntimeFailureWorkflowEventParams {
  taskId: number;
  instanceId: number;
  changedBy: string;
  priorTaskStatus: string;
  tenantId?: number | null;
  projectId: number | null;
  sprintId?: number | null;
  sprintType?: string | null;
  taskType: string | null;
  agentId: number | null;
  summary: string | null;
  runtimeEndSource: string;
  runtimeEndError: string | null;
}

export async function applyConfiguredRuntimeFailedEvent(
  db: Db,
  params: RuntimeFailureWorkflowEventParams,
): Promise<void> {
  const mapping = await resolveWorkflowEventMapping(db, {
      source: AGENT_HQ_RUNTIME_SOURCE,
      eventName: RUNTIME_FAILED_EVENT,
      tenantId: params.tenantId ?? null,
      projectId: params.projectId,
      sprintId: params.sprintId ?? null,
      sprintType: params.sprintType ?? null,
      taskType: params.taskType,
      currentStatus: params.priorTaskStatus,
    });

  const changedBy = params.changedBy || AGENT_HQ_RUNTIME_SOURCE;
  const summary = params.summary ?? 'Runtime reported failed terminal state';
  const failureDetail = [
    'Runtime failure workflow event',
    `Source: ${AGENT_HQ_RUNTIME_SOURCE}`,
    `Event: ${RUNTIME_FAILED_EVENT}`,
    `Runtime end source: ${params.runtimeEndSource}`,
    `Instance ID: ${params.instanceId}`,
    `Message: ${summary}`,
    ...(params.runtimeEndError ? [`Runtime error: ${params.runtimeEndError}`] : []),
  ].join('\n');

  await writeTaskHistory(db, params.taskId, changedBy, 'workflow_event_source', null, AGENT_HQ_RUNTIME_SOURCE, false);
  await writeTaskHistory(db, params.taskId, changedBy, 'workflow_event_name', null, RUNTIME_FAILED_EVENT, false);
  await writeTaskHistory(db, params.taskId, changedBy, 'workflow_event_runtime_end_source', null, params.runtimeEndSource, false);
  await writeTaskHistory(db, params.taskId, changedBy, 'workflow_event_instance_id', null, params.instanceId, false);
  await writeTaskHistory(db, params.taskId, changedBy, 'workflow_event_mapping_id', null, mapping?.id ?? null, false);
  await writeTaskHistory(db, params.taskId, changedBy, 'workflow_event_action_kind', null, mapping?.action_kind ?? null, false);
  await writeTaskHistory(db, params.taskId, changedBy, 'workflow_event_action_target', null, mapping?.action_target ?? null, false);

  try {
    await db.run(`INSERT INTO task_notes (task_id, author, content) VALUES (?, ?, ?)`, params.taskId, changedBy, [
            'Runtime workflow event received',
            `Source: ${AGENT_HQ_RUNTIME_SOURCE}`,
            `Event: ${RUNTIME_FAILED_EVENT}`,
            `Instance ID: ${params.instanceId}`,
            `Runtime end source: ${params.runtimeEndSource}`,
            `Message: ${summary}`,
            mapping ? `Resolved mapping: #${mapping.id}` : 'Resolved mapping: none',
            `Action: ${mapping?.action_kind ?? 'none'}${mapping?.action_target ? ` → ${mapping.action_target}` : ''}`,
            'Classification: runtime/control-plane failure event, not an agent-authored product failure outcome',
          ].join('\n'));
  } catch {
    // task_notes may not exist in minimal tests; task_history remains the durable audit trail.
  }

  if (!mapping || mapping.action_kind === 'ignore') return;

  if (mapping.action_kind === 'status' && mapping.action_target) {
    if (params.priorTaskStatus === mapping.action_target) return;
    await db.run(`
      UPDATE tasks
      SET status = ?,
          failure_detail = CASE WHEN ? THEN ? ELSE failure_detail END,
          updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ?
    `, mapping.action_target, mapping.apply_failure_detail ? 1 : 0, failureDetail, params.taskId);
    await writeTaskStatusChange(db, params.taskId, changedBy, params.priorTaskStatus, mapping.action_target, {
            instanceId: params.instanceId,
            reason: `Workflow event ${RUNTIME_FAILED_EVENT} via ${AGENT_HQ_RUNTIME_SOURCE}. ${summary}`,
            projectId: params.projectId,
            agentId: params.agentId,
          });
    await notifyTaskStatusChange(db, {
            taskId: params.taskId,
            fromStatus: params.priorTaskStatus,
            toStatus: mapping.action_target,
            source: changedBy,
          });
    return;
  }

  if (mapping.action_kind === 'outcome' && mapping.action_target) {
    await applyTaskOutcome(db, {
      taskId: params.taskId,
      outcome: mapping.action_target,
      changedBy,
      summary: `Workflow event ${RUNTIME_FAILED_EVENT} via ${AGENT_HQ_RUNTIME_SOURCE}. ${summary}`,
      instanceId: params.instanceId,
      failureDetail: mapping.apply_failure_detail ? failureDetail : undefined,
    });
  }
}
