import Database from 'better-sqlite3';
import { listSprintTaskStatuses, listSprintTaskTransitions } from '../domains/routing/policy/statuses';

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

function resolveSprintType(db: Database.Database, sprintId: number | null | undefined): string | null {
  if (typeof sprintId !== 'number' || !Number.isFinite(sprintId)) return null;

  try {
    const sprint = db.prepare(`
      SELECT sprint_type
      FROM sprints
      WHERE id = ?
      LIMIT 1
    `).get(sprintId) as { sprint_type: string | null } | undefined;
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

export function resolveSprintWorkflow(
  db: Database.Database,
  sprintId?: number | null,
  sprintTypeHint?: string | null,
): ResolvedSprintWorkflow {
  const resolvedSprintId = typeof sprintId === 'number' && Number.isFinite(sprintId) ? sprintId : null;
  const resolvedSprintType = resolveSprintType(db, resolvedSprintId) ?? normalizeSprintType(sprintTypeHint) ?? 'generic';
  const statuses = listSprintTaskStatuses(db, resolvedSprintId).map((status, index) => ({
    statusName: status.name,
    isVisibleOnBoard: true,
    columnOrder: index,
  }));
  const transitions = listSprintTaskTransitions(db, resolvedSprintId)
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
