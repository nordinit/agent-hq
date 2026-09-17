import { listWorkflowTaskStatuses, listWorkflowTypeTaskStatuses } from '../domains/routing/policy/statuses';
import { resolveWorkflowTypeForWorkflowId } from '../domains/workflow-definitions/config';
import { RELEASE_TASK_STATUSES } from './taskStatuses';
import { type Db } from "../db/adapter/types";

export interface TaskStatusWorkflowScope {
  workflowId?: number | null;
  workflowType?: string | null;
  taskType?: string | null;
  fromStatus?: string | null;
}

export class WorkflowAllowedValuesError extends Error {
  status = 400;
  code: string;
  field: string;
  attemptedValue: string;
  allowedValues: string[];
  metadataTool = 'agent_hq_get_workflow_metadata';
  workflow: {
    workflow_id: number | null;
    workflow_type: string | null;
    task_type?: string | null;
    from_status?: string | null;
  };

  constructor(input: {
    message: string;
    code: string;
    field: string;
    attemptedValue: string;
    allowedValues: string[];
    scope: TaskStatusWorkflowScope;
  }) {
    super(input.message);
    this.name = 'WorkflowAllowedValuesError';
    this.code = input.code;
    this.field = input.field;
    this.attemptedValue = input.attemptedValue;
    this.allowedValues = input.allowedValues;
    this.workflow = {
      workflow_id: input.scope.workflowId ?? null,
      workflow_type: input.scope.workflowType ?? null,
      task_type: input.scope.taskType ?? null,
      from_status: input.scope.fromStatus ?? null,
    };
  }
}

export function workflowAllowedValuesErrorBody(error: WorkflowAllowedValuesError): Record<string, unknown> {
  return {
    error: error.message,
    code: error.code,
    field: error.field,
    attempted_value: error.attemptedValue,
    allowed_values: error.allowedValues,
    metadata_tool: error.metadataTool,
    workflow: error.workflow,
  };
}

function normalizeStatus(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function listAllowedTaskStatusesForWorkflow(
  db: Db,
  scope: TaskStatusWorkflowScope,
): Promise<string[]> {
  const workflowStatuses = typeof scope.workflowId === 'number' && Number.isFinite(scope.workflowId)
    ? (await listWorkflowTaskStatuses(db, scope.workflowId)).map((status) => status.name)
    : [];
  if (workflowStatuses.length > 0) return [...new Set([...workflowStatuses, ...RELEASE_TASK_STATUSES])];

  const workflowType = normalizeStatus(scope.workflowType) ?? (await resolveWorkflowTypeForWorkflowId(db, scope.workflowId ?? null));
  const workflowTypeStatuses = (await listWorkflowTypeTaskStatuses(db, workflowType)).map((status) => status.name);
  if (workflowTypeStatuses.length > 0) return [...new Set([...workflowTypeStatuses, ...RELEASE_TASK_STATUSES])];

  return [...RELEASE_TASK_STATUSES];
}

export async function assertTaskStatusDefinedForWorkflow(
  db: Db,
  status: unknown,
  scope: TaskStatusWorkflowScope,
): Promise<void> {
  const normalized = normalizeStatus(status);
  if (!normalized) throw new Error('status is required');

  const allowedStatuses = await listAllowedTaskStatusesForWorkflow(db, scope);
  if (!allowedStatuses.includes(normalized)) {
    throw new WorkflowAllowedValuesError({
      message: `"${normalized}" is not a valid task status for this workflow. Valid values: ${allowedStatuses.join(', ')}`,
      code: 'task_status_not_allowed_for_workflow',
      field: 'status',
      attemptedValue: normalized,
      allowedValues: allowedStatuses,
      scope,
    });
  }
}
