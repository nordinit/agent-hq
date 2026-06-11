import type Database from 'better-sqlite3';
import {
  getGateRequirementFieldDefinitions,
  resolveTaskFieldSchemaForSprint,
  resolveTaskWorkflowContext,
  validateRequirementFieldExpression,
} from '../sprint-definitions/config';
import { listSprintTaskStatuses, listSprintTypeTaskStatuses } from './policy/statuses';
import { SprintRecord, tableHasColumn, withStatus } from './scope';

export function requireRoutingRuleStatusForSprint(db: Database.Database, sprintId: number, status: string): void {
  const statuses = listSprintTaskStatuses(db, sprintId);
  if (statuses.some((entry) => entry.name === status)) return;
  throw withStatus(`Status "${status}" is not configured for sprint ${sprintId}`, 400);
}

export function requireRoutingRuleStatusForSprintType(db: Database.Database, sprintType: string, status: string): void {
  const statuses = listSprintTypeTaskStatuses(db, sprintType);
  if (statuses.some((entry) => entry.name === status)) return;
  throw withStatus(`Status "${status}" is not configured for sprint type "${sprintType}"`, 400);
}

export function requireRoutingRuleTaskTypeForSprint(db: Database.Database, sprintId: number, taskType: string): void {
  const workflow = resolveTaskWorkflowContext(db, { sprintId, taskType });
  if (workflow.allowedTaskTypes.length === 0 || workflow.allowedTaskTypes.includes(taskType)) return;
  throw withStatus(
    `task_type "${taskType}" is not allowed for sprint type "${workflow.sprintType}". Allowed: ${workflow.allowedTaskTypes.join(', ')}`,
    400,
  );
}

export function requireRoutingRuleTaskTypeForSprintType(db: Database.Database, sprintType: string, taskType: string): void {
  const workflow = resolveTaskWorkflowContext(db, { sprintType, taskType });
  if (workflow.allowedTaskTypes.length === 0 || workflow.allowedTaskTypes.includes(taskType)) return;
  throw withStatus(
    `task_type "${taskType}" is not allowed for sprint type "${workflow.sprintType}". Allowed: ${workflow.allowedTaskTypes.join(', ')}`,
    400,
  );
}

export function requireTransitionRequirementFieldsForScope(
  db: Database.Database,
  scope: { sprintId?: number | null; sprintType?: string | null },
  taskType: unknown,
  fieldName: unknown,
  matchField: unknown,
  requirementType: unknown,
): void {
  const context = scope.sprintId != null ? { sprintId: scope.sprintId } : { sprintType: scope.sprintType };
  validateRequirementFieldExpression(db, {
    ...context,
    taskType,
    fieldName,
    fieldRole: 'field_name',
  });
  if (requirementType === 'match') {
    validateRequirementFieldExpression(db, {
      ...context,
      taskType,
      fieldName: matchField,
      fieldRole: 'match_field',
    });
  }
}

export function requireTransitionRequirementFieldsForSprint(
  db: Database.Database,
  sprintId: number,
  taskType: unknown,
  fieldName: unknown,
  matchField: unknown,
  requirementType: unknown,
): void {
  requireTransitionRequirementFieldsForScope(db, { sprintId }, taskType, fieldName, matchField, requirementType);
}

export function requireAgentInSprintProject(db: Database.Database, sprint: SprintRecord, agentId: number, tenantId?: number | null): void {
  if (!tableHasColumn(db, 'agents', 'project_id')) return;

  const hasTenant = tableHasColumn(db, 'agents', 'tenant_id');
  const agent = db.prepare(`SELECT id, name, project_id${hasTenant ? ', tenant_id' : ''} FROM agents WHERE id = ?${hasTenant && tenantId != null ? ' AND tenant_id = ?' : ''} LIMIT 1`)
    .get(...(hasTenant && tenantId != null ? [agentId, tenantId] : [agentId])) as
    | { id: number; name?: string | null; project_id?: number | null; tenant_id?: number | null }
    | undefined;
  if (!agent) {
    throw withStatus(`Agent ${agentId} not found`, 404);
  }
  if (!agent || agent.project_id === sprint.project_id) return;

  throw withStatus(`Agent ${agentId} is not assigned to project ${sprint.project_id}`, 400);
}
