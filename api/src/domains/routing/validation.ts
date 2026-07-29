import {
  getGateRequirementFieldDefinitions,
  resolveTaskFieldSchemaForSprint,
  resolveTaskWorkflowContext,
  validateRequirementFieldExpression,
} from '../sprint-definitions/config';
import { listSprintTaskStatuses, listSprintTypeTaskStatuses } from './policy/statuses';
import { SprintRecord, tableHasColumn, withStatus } from './scope';
import { type Db } from "../../db/adapter/types";

export async function requireRoutingRuleStatusForSprint(db: Db, sprintId: number, status: string): Promise<void> {
  const statuses = await listSprintTaskStatuses(db, sprintId);
  if (statuses.some((entry) => entry.name === status)) return;
  throw withStatus(`Status "${status}" is not configured for sprint ${sprintId}`, 400);
}

export async function requireRoutingRuleStatusForSprintType(db: Db, sprintType: string, status: string): Promise<void> {
  const statuses = await listSprintTypeTaskStatuses(db, sprintType);
  if (statuses.some((entry) => entry.name === status)) return;
  throw withStatus(`Status "${status}" is not configured for sprint type "${sprintType}"`, 400);
}

export async function requireRoutingRuleTaskTypeForSprint(db: Db, sprintId: number, taskType: string): Promise<void> {
  const workflow = await resolveTaskWorkflowContext(db, { sprintId, taskType });
  if (workflow.allowedTaskTypes.length === 0 || workflow.allowedTaskTypes.includes(taskType)) return;
  throw withStatus(
    `task_type "${taskType}" is not allowed for sprint type "${workflow.sprintType}". Allowed: ${workflow.allowedTaskTypes.join(', ')}`,
    400,
  );
}

export async function requireRoutingRuleTaskTypeForSprintType(db: Db, sprintType: string, taskType: string): Promise<void> {
  const workflow = await resolveTaskWorkflowContext(db, { sprintType, taskType });
  if (workflow.allowedTaskTypes.length === 0 || workflow.allowedTaskTypes.includes(taskType)) return;
  throw withStatus(
    `task_type "${taskType}" is not allowed for sprint type "${workflow.sprintType}". Allowed: ${workflow.allowedTaskTypes.join(', ')}`,
    400,
  );
}

export async function requireTransitionRequirementFieldsForScope(
  db: Db,
  scope: { sprintId?: number | null; sprintType?: string | null },
  taskType: unknown,
  fieldName: unknown,
  matchField: unknown,
  requirementType: unknown,
): Promise<void> {
  const context = scope.sprintId != null ? { sprintId: scope.sprintId } : { sprintType: scope.sprintType };
  await validateRequirementFieldExpression(db, {
        ...context,
        taskType,
        fieldName,
        fieldRole: 'field_name',
      });
  if (requirementType === 'match') {
    await validateRequirementFieldExpression(db, {
            ...context,
            taskType,
            fieldName: matchField,
            fieldRole: 'match_field',
          });
  }
}

export async function requireTransitionRequirementFieldsForSprint(
  db: Db,
  sprintId: number,
  taskType: unknown,
  fieldName: unknown,
  matchField: unknown,
  requirementType: unknown,
): Promise<void> {
  await requireTransitionRequirementFieldsForScope(db, { sprintId }, taskType, fieldName, matchField, requirementType);
}

export async function requireAgentInSprintProject(db: Db, sprint: SprintRecord, agentId: number, tenantId?: number | null): Promise<void> {
  if (!await tableHasColumn(db, 'agents', 'project_id')) return;

  const hasTenant = await tableHasColumn(db, 'agents', 'tenant_id');
  const agent = await db.get(`SELECT id, name, project_id${hasTenant ? ', tenant_id' : ''} FROM agents WHERE id = ?${hasTenant && tenantId != null ? ' AND tenant_id = ?' : ''} LIMIT 1`, ...(hasTenant && tenantId != null ? [agentId, tenantId] : [agentId])) as
    | { id: number; name?: string | null; project_id?: number | null; tenant_id?: number | null }
    | undefined;
  if (!agent) {
    throw withStatus(`Agent ${agentId} not found`, 404);
  }
  if (!agent || agent.project_id === sprint.project_id) return;

  throw withStatus(`Agent ${agentId} is not assigned to project ${sprint.project_id}`, 400);
}
