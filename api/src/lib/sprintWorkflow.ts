import { listSprintTaskStatuses, listSprintTaskTransitions } from '../domains/routing/policy/statuses';
import { type Db } from "../db/adapter/types";

export interface ResolvedSprintWorkflowStatus {
  statusName: string;
  isVisibleOnBoard: boolean;
  columnOrder: number;
}

export interface ResolvedSprintWorkflowTransition {
  fromStatus: string;
  outcome: string;
  toStatus: string;
  taskType: string | null;
  priority: number;
  isProtected: boolean;
}

export interface ResolvedSprintWorkflow {
  sprintId: number | null;
  sprintType: string | null;
  statuses: ResolvedSprintWorkflowStatus[];
  transitions: ResolvedSprintWorkflowTransition[];
}

function normalizeSprintType(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized.length > 0 ? normalized : null;
}

async function resolveSprintType(db: Db, sprintId: number | null | undefined): Promise<string | null> {
  if (typeof sprintId !== 'number' || !Number.isFinite(sprintId)) return null;

  try {
    const sprint = await db.get(`
      SELECT sprint_type
      FROM sprints
      WHERE id = ?
      LIMIT 1
    `, sprintId) as { sprint_type: string | null } | undefined;
    return normalizeSprintType(sprint?.sprint_type);
  } catch {
    return null;
  }
}

function dedupeTransitions(transitions: ResolvedSprintWorkflowTransition[]): ResolvedSprintWorkflowTransition[] {
  const seen = new Set<string>();
  const deduped: ResolvedSprintWorkflowTransition[] = [];

  for (const transition of transitions) {
    const key = [transition.fromStatus, transition.outcome, transition.toStatus, transition.taskType ?? '', transition.priority].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(transition);
  }

  return deduped;
}

export async function resolveSprintWorkflow(
  db: Db,
  sprintId?: number | null,
  sprintTypeHint?: string | null,
): Promise<ResolvedSprintWorkflow> {
  const resolvedSprintId = typeof sprintId === 'number' && Number.isFinite(sprintId) ? sprintId : null;
  const resolvedSprintType = (await resolveSprintType(db, resolvedSprintId)) ?? normalizeSprintType(sprintTypeHint) ?? 'generic';
  const statuses = (await listSprintTaskStatuses(db, resolvedSprintId)).map((status, index) => ({
    statusName: status.name,
    isVisibleOnBoard: true,
    columnOrder: index,
  }));
  const transitions = (await listSprintTaskTransitions(db, resolvedSprintId))
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
    sprintId: resolvedSprintId,
    sprintType: resolvedSprintType,
    statuses,
    transitions: dedupeTransitions(transitions),
  };
}
