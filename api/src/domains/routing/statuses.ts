import { listWorkflowTaskStatuses } from './policy/statuses';
import { parseWorkflowId, requireWorkflow, withStatus, StatusError } from './scope';
import { type Db } from "../../db/adapter/types";

async function requireWorkflowStatusScope(db: Db, workflowIdRaw: unknown, tenantIdRaw?: unknown): Promise<number> {
  const workflowId = parseWorkflowId(workflowIdRaw);
  if (!workflowId) throw withStatus('workflow_id is required for workflow task status policy operations', 400);
  const tenantId = Number.isFinite(Number(tenantIdRaw)) ? Number(tenantIdRaw) : null;
  await requireWorkflow(db, workflowId, tenantId);
  return workflowId;
}

/** A workflow's statuses: the statuses of its workflow type. */
export async function listRoutingStatuses(db: Db, input: { workflow_id?: unknown; tenant_id?: unknown }) {
  const workflowId = await requireWorkflowStatusScope(db, input.workflow_id, input.tenant_id);
  return { statuses: await listWorkflowTaskStatuses(db, workflowId) };
}

/**
 * Statuses are defined only on the workflow type, so a single workflow's statuses cannot be
 * changed on their own. The error names the type endpoint that changes them for every workflow
 * of that type.
 */
async function statusesLiveOnWorkflowType(db: Db, input: Record<string, unknown>): Promise<never> {
  const workflowId = await requireWorkflowStatusScope(db, input.workflow_id, input.tenant_id);
  const workflow = await db.get(`SELECT workflow_type FROM workflows WHERE id = ? LIMIT 1`, workflowId) as { workflow_type?: string | null } | undefined;
  const workflowType = workflow?.workflow_type ?? null;
  const error = withStatus(
    `Statuses are defined on the workflow type, not on a single workflow. Change them for every ${workflowType ?? 'such'} workflow at /api/v1/workflows/types/${workflowType ?? ':key'}/statuses.`,
    409,
  ) as StatusError & Record<string, unknown>;
  error.code = 'statuses_defined_on_workflow_type';
  error.workflow_id = workflowId;
  error.workflow_type = workflowType;
  throw error;
}

export async function updateRoutingStatus(db: Db, input: Record<string, unknown> & { name: string }) {
  return statusesLiveOnWorkflowType(db, input);
}

export async function createRoutingStatus(db: Db, input: Record<string, unknown>) {
  return statusesLiveOnWorkflowType(db, input);
}

export async function deleteRoutingStatus(db: Db, input: Record<string, unknown> & { name: string }) {
  return statusesLiveOnWorkflowType(db, input);
}
