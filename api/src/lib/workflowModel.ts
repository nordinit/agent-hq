import { listWorkflowTaskStatuses, listWorkflowTaskTransitions } from '../domains/routing/policy/statuses';
import { type Db } from "../db/adapter/types";

export interface ResolvedWorkflowModelStatus {
  statusName: string;
  isVisibleOnBoard: boolean;
  columnOrder: number;
}

export interface ResolvedWorkflowModelTransition {
  fromStatus: string;
  outcome: string;
  toStatus: string;
  taskType: string | null;
  priority: number;
  isProtected: boolean;
}

export interface ResolvedWorkflowModel {
  workflowId: number | null;
  workflowType: string | null;
  statuses: ResolvedWorkflowModelStatus[];
  transitions: ResolvedWorkflowModelTransition[];
}

function normalizeWorkflowType(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized.length > 0 ? normalized : null;
}

async function resolveWorkflowType(db: Db, workflowId: number | null | undefined): Promise<string | null> {
  if (typeof workflowId !== 'number' || !Number.isFinite(workflowId)) return null;

  try {
    const workflow = await db.get(`
      SELECT workflow_type
      FROM workflows
      WHERE id = ?
      LIMIT 1
    `, workflowId) as { workflow_type: string | null } | undefined;
    return normalizeWorkflowType(workflow?.workflow_type);
  } catch {
    return null;
  }
}

function dedupeTransitions(transitions: ResolvedWorkflowModelTransition[]): ResolvedWorkflowModelTransition[] {
  const seen = new Set<string>();
  const deduped: ResolvedWorkflowModelTransition[] = [];

  for (const transition of transitions) {
    const key = [transition.fromStatus, transition.outcome, transition.toStatus, transition.taskType ?? '', transition.priority].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(transition);
  }

  return deduped;
}

export async function resolveWorkflowModel(
  db: Db,
  workflowId?: number | null,
  workflowTypeHint?: string | null,
): Promise<ResolvedWorkflowModel> {
  const resolvedWorkflowId = typeof workflowId === 'number' && Number.isFinite(workflowId) ? workflowId : null;
  const resolvedWorkflowType = (await resolveWorkflowType(db, resolvedWorkflowId)) ?? normalizeWorkflowType(workflowTypeHint) ?? 'generic';
  const statuses = (await listWorkflowTaskStatuses(db, resolvedWorkflowId)).map((status, index) => ({
    statusName: status.name,
    isVisibleOnBoard: true,
    columnOrder: index,
  }));
  const transitions = (await listWorkflowTaskTransitions(db, resolvedWorkflowId))
    .filter((transition) => transition.enabled !== 0)
    .map((transition) => ({
      fromStatus: transition.from_status,
      outcome: transition.outcome,
      toStatus: transition.to_status,
      taskType: transition.task_type,
      priority: transition.priority,
      isProtected: Boolean(transition.is_protected),
    }));

  return {
    workflowId: resolvedWorkflowId,
    workflowType: resolvedWorkflowType,
    statuses,
    transitions: dedupeTransitions(transitions),
  };
}
