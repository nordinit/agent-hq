import { resolveWorkflowTaskRoutingAssignment } from '../domains/routing/policy/statuses';
import { type Db } from "../db/adapter/types";

export const USER_UPDATE_OUTCOME = 'user_update';

export function isManualUserStatusChange(changedBy: string | null | undefined, priorStatus: string | null | undefined, nextStatus: string | null | undefined): boolean {
  return String(changedBy ?? '').trim().toLowerCase() === 'user'
    && String(priorStatus ?? '') !== String(nextStatus ?? '');
}

export async function resolveTaskRoutingRule(
  db: Db,
  workflowId: number | null | undefined,
  _projectId: number | null | undefined,
  taskType: string | null | undefined,
  status: string | null | undefined,
): Promise<{ agentId: number | null; routingReason: string | null }> {
  if (!status) {
    return { agentId: null, routingReason: null };
  }

  const workflowRule = await resolveWorkflowTaskRoutingAssignment(db, workflowId ?? null, taskType ?? null, status);
  if (workflowRule.agent_id == null) {
    return { agentId: null, routingReason: null };
  }

  return {
    agentId: workflowRule.agent_id,
    routingReason: `Workflow policy: ${taskType ?? 'all task types'}/${status} → agent #${workflowRule.agent_id}`,
  };
}

export async function resolveManualUserUpdate(
  db: Db,
  params: {
    changedBy: string | null | undefined;
    priorStatus: string | null | undefined;
    nextStatus: string | null | undefined;
    workflowId: number | null | undefined;
    projectId: number | null | undefined;
    taskType: string | null | undefined;
    explicitAgentIdProvided: boolean;
    explicitAgentId: number | null | undefined;
    currentAgentId: number | null | undefined;
  }
): Promise<{ emitted: boolean; resolvedAgentId: number | null; routingReason: string | null }> {
  const emitted = isManualUserStatusChange(params.changedBy, params.priorStatus, params.nextStatus);
  if (!emitted) {
    return {
      emitted: false,
      resolvedAgentId: params.explicitAgentIdProvided ? (params.explicitAgentId ?? null) : (params.currentAgentId ?? null),
      routingReason: null,
    };
  }

  if (params.explicitAgentIdProvided) {
    return {
      emitted: true,
      resolvedAgentId: params.explicitAgentId ?? null,
      routingReason: null,
    };
  }

  const route = await resolveTaskRoutingRule(db, params.workflowId, params.projectId, params.taskType, params.nextStatus);
  if (route.agentId != null) {
    return {
      emitted: true,
      resolvedAgentId: route.agentId,
      routingReason: route.routingReason,
    };
  }

  return {
    emitted: true,
    resolvedAgentId: params.currentAgentId ?? null,
    routingReason: null,
  };
}

export function buildUserUpdateAuditLog(taskId: number, priorStatus: string, nextStatus: string, changedBy: string, agentId?: number | null): string {
  return `Manual board status change emitted outcome "${USER_UPDATE_OUTCOME}": task #${taskId} (${priorStatus} → ${nextStatus}), actor="${changedBy}"${agentId ? `, agent_id=${agentId}` : ''}`;
}
