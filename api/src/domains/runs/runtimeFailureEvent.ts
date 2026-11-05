import { AGENT_HQ_RUNTIME_SOURCE } from '../routing/externalEventMappings';
import { applyTaskOutcome, RefusedTaskOutcomeError } from '../../lib/taskOutcome';
import { RUNTIME_FAILED_OUTCOME } from '../../lib/outcomeCatalog';
import { writeTaskHistory } from '../tasks/history';
import { resolveRuntimeTenantId, tenantInsertColumns } from '../../lib/runtimeTenantScope';
import { type Db } from "../../db/adapter/types";
import { WorkflowAllowedValuesError } from '../../lib/taskStatusValidation';

export interface RuntimeFailureParams {
  taskId: number;
  instanceId: number;
  changedBy: string;
  priorTaskStatus: string;
  summary: string | null;
  runtimeEndSource: string;
  runtimeEndError: string | null;
}

/**
 * A run died before its agent posted an outcome. Agent HQ posts the built-in runtime_failed
 * outcome for it, and that outcome routes like any other: a configured runtime_failed transition
 * from the task's status moves the task. Without one the outcome is refused, exactly as any outcome
 * with no route is, and the task stays where it is to be dispatched again.
 */
export async function applyRuntimeFailedOutcome(
  db: Db,
  params: RuntimeFailureParams,
): Promise<void> {
  const changedBy = params.changedBy || AGENT_HQ_RUNTIME_SOURCE;
  const summary = params.summary ?? 'Runtime reported failed terminal state';
  const failureDetail = [
    'Run failed before its agent posted an outcome',
    `Outcome: ${RUNTIME_FAILED_OUTCOME} (posted by Agent HQ)`,
    `Runtime end source: ${params.runtimeEndSource}`,
    `Instance ID: ${params.instanceId}`,
    `Message: ${summary}`,
    ...(params.runtimeEndError ? [`Runtime error: ${params.runtimeEndError}`] : []),
  ].join('\n');

  await writeTaskHistory(db, params.taskId, changedBy, 'runtime_failed_instance_id', null, params.instanceId, false);
  await writeTaskHistory(db, params.taskId, changedBy, 'runtime_failed_end_source', null, params.runtimeEndSource, false);

  try {
    const tenantId = await resolveRuntimeTenantId(db, { taskId: params.taskId });
    const tenant = await tenantInsertColumns(db, 'task_notes', tenantId);
    await db.run(`INSERT INTO task_notes (${tenant.columnSql}task_id, author, content) VALUES (${tenant.valueSql}?, ?, ?)`, ...tenant.values, params.taskId, changedBy, [
            'Run failed',
            `Instance ID: ${params.instanceId}`,
            `Runtime end source: ${params.runtimeEndSource}`,
            `Message: ${summary}`,
            `Agent HQ posted ${RUNTIME_FAILED_OUTCOME}: a runtime or control-plane failure, not an outcome the agent reported.`,
          ].join('\n'));
  } catch {
    // task_notes may not exist in minimal tests; task_history remains the durable audit trail.
  }

  try {
    await applyTaskOutcome(db, {
      taskId: params.taskId,
      outcome: RUNTIME_FAILED_OUTCOME,
      changedBy,
      summary,
      instanceId: params.instanceId,
      failureDetail,
    });
  } catch (error) {
    // No route (or a gate on the route) refuses runtime_failed like any other outcome. The task
    // stays and is dispatched again; record why. Database and other failures still propagate.
    const refused = error instanceof RefusedTaskOutcomeError
      || (error instanceof WorkflowAllowedValuesError && error.code === 'task_outcome_not_allowed_for_workflow');
    if (!refused) throw error;
    const reason = `${error.message}. The task stays in "${params.priorTaskStatus}" and will be dispatched again.`;
    await writeTaskHistory(db, params.taskId, changedBy, 'runtime_failed_unrouted', null, reason, false);
    await db.run('UPDATE tasks SET failure_detail = ? WHERE id = ?', `${failureDetail}\n${reason}`, params.taskId);
    console.warn(`[runtime-failure] Task #${params.taskId}: ${reason}`);
  }
}
