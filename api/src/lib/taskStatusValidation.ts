import { listSprintTaskStatuses, listSprintTypeTaskStatuses } from '../domains/routing/policy/statuses';
import { resolveSprintTypeForSprintId } from '../domains/sprint-definitions/config';
import { RELEASE_TASK_STATUSES } from './taskStatuses';
import { type Db } from "../db/adapter/types";

export interface TaskStatusWorkflowScope {
  sprintId?: number | null;
  sprintType?: string | null;
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
    sprint_id: number | null;
    sprint_type: string | null;
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
      sprint_id: input.scope.sprintId ?? null,
      sprint_type: input.scope.sprintType ?? null,
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
  const sprintStatuses = typeof scope.sprintId === 'number' && Number.isFinite(scope.sprintId)
    ? (await listSprintTaskStatuses(db, scope.sprintId)).map((status) => status.name)
    : [];
  if (sprintStatuses.length > 0) return [...new Set([...sprintStatuses, ...RELEASE_TASK_STATUSES])];

  const sprintType = normalizeStatus(scope.sprintType) ?? (await resolveSprintTypeForSprintId(db, scope.sprintId ?? null));
  const sprintTypeStatuses = (await listSprintTypeTaskStatuses(db, sprintType)).map((status) => status.name);
  if (sprintTypeStatuses.length > 0) return [...new Set([...sprintTypeStatuses, ...RELEASE_TASK_STATUSES])];

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
