import {
  getGateRequirementFieldDefinitions,
  resolveTaskFieldSchemaForWorkflow,
  resolveTaskWorkflowContext,
  validateRequirementFieldExpression,
} from '../workflow-definitions/config';
import { listWorkflowTaskStatuses, listWorkflowTypeTaskStatuses } from './policy/statuses';
import { WorkflowRecord, tableHasColumn, withStatus } from './scope';
import { type Db } from "../../db/adapter/types";

export async function requireRoutingRuleStatusForWorkflow(db: Db, workflowId: number, status: string): Promise<void> {
  const statuses = await listWorkflowTaskStatuses(db, workflowId);
  if (statuses.some((entry) => entry.name === status)) return;
  throw withStatus(`Status "${status}" is not configured for workflow ${workflowId}`, 400);
}

export async function requireRoutingRuleStatusForWorkflowType(db: Db, workflowType: string, status: string): Promise<void> {
  const statuses = await listWorkflowTypeTaskStatuses(db, workflowType);
  if (statuses.some((entry) => entry.name === status)) return;
  throw withStatus(`Status "${status}" is not configured for workflow type "${workflowType}"`, 400);
}

export async function requireRoutingRuleTaskTypeForWorkflow(db: Db, workflowId: number, taskType: string): Promise<void> {
  const workflow = await resolveTaskWorkflowContext(db, { workflowId, taskType });
  if (workflow.allowedTaskTypes.length === 0 || workflow.allowedTaskTypes.includes(taskType)) return;
  throw withStatus(
    `task_type "${taskType}" is not allowed for workflow type "${workflow.workflowType}". Allowed: ${workflow.allowedTaskTypes.join(', ')}`,
    400,
  );
}

export async function requireRoutingRuleTaskTypeForWorkflowType(db: Db, workflowType: string, taskType: string): Promise<void> {
  const workflow = await resolveTaskWorkflowContext(db, { workflowType, taskType });
  if (workflow.allowedTaskTypes.length === 0 || workflow.allowedTaskTypes.includes(taskType)) return;
  throw withStatus(
    `task_type "${taskType}" is not allowed for workflow type "${workflow.workflowType}". Allowed: ${workflow.allowedTaskTypes.join(', ')}`,
    400,
  );
}

export async function requireTransitionRequirementFieldsForScope(
  db: Db,
  scope: { workflowId?: number | null; workflowType?: string | null },
  taskType: unknown,
  fieldName: unknown,
  matchField: unknown,
  requirementType: unknown,
): Promise<void> {
  const context = scope.workflowId != null ? { workflowId: scope.workflowId } : { workflowType: scope.workflowType };
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

export async function requireTransitionRequirementFieldsForWorkflow(
  db: Db,
  workflowId: number,
  taskType: unknown,
  fieldName: unknown,
  matchField: unknown,
  requirementType: unknown,
): Promise<void> {
  await requireTransitionRequirementFieldsForScope(db, { workflowId }, taskType, fieldName, matchField, requirementType);
}

export async function requireAgentInWorkflowProject(db: Db, workflow: WorkflowRecord, agentId: number, tenantId?: number | null): Promise<void> {
  if (!await tableHasColumn(db, 'agents', 'project_id')) return;

  const hasTenant = await tableHasColumn(db, 'agents', 'tenant_id');
  const agent = await db.get(`SELECT id, name, project_id${hasTenant ? ', tenant_id' : ''} FROM agents WHERE id = ?${hasTenant && tenantId != null ? ' AND tenant_id = ?' : ''} LIMIT 1`, ...(hasTenant && tenantId != null ? [agentId, tenantId] : [agentId])) as
    | { id: number; name?: string | null; project_id?: number | null; tenant_id?: number | null }
    | undefined;
  if (!agent) {
    throw withStatus(`Agent ${agentId} not found`, 404);
  }
  if (!agent || agent.project_id === workflow.project_id) return;

  throw withStatus(`Agent ${agentId} is not assigned to project ${workflow.project_id}`, 400);
}
