export const TASK_STATUSES = [
  'todo',
  'ready',
  'in_progress',
  'dev_deploy_queued',
  'dev_deploying',
  'review',
  'qa_pass',
  'ready_to_merge',
  'deployed',
  'done',
  'needs_attention',
  'cancelled',
  'stalled',
  'failed',
  'blocked',
] as const;

export type TaskStatus = typeof TASK_STATUSES[number];

export const RELEASE_TASK_STATUSES = TASK_STATUSES;
export type ReleaseTaskStatus = TaskStatus;

export const DIRECT_GATED_TASK_STATUSES = ['review', 'qa_pass', 'ready_to_merge', 'deployed', 'done'] as const;
export type DirectGatedTaskStatus = typeof DIRECT_GATED_TASK_STATUSES[number];

/**
 * Seed data only — the terminal defaults a fresh install starts with.
 *
 * This is NOT the answer to "is this status terminal?". Terminality is operator
 * configuration held in task_statuses / sprint_type_task_statuses /
 * sprint_task_statuses, and is read through
 * domains/tasks/terminality.ts (list form) or the dispatcher's
 * buildResolvedTaskTerminalityExpression (SQL form). Deciding terminality from
 * this constant would override what the user configured.
 */
export const DEFAULT_TERMINAL_TASK_STATUS_SEEDS = ['done', 'cancelled', 'failed'] as const;
export const ACTIVE_TASK_STATUSES = ['in_progress', 'review', 'ready_to_merge', 'deployed'] as const;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export function taskStatusesSqlList(statuses: readonly string[] = TASK_STATUSES): string {
  return statuses.map(status => `'${status}'`).join(',');
}
