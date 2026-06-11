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

export const TERMINAL_TASK_STATUSES = ['done', 'cancelled', 'failed'] as const;
export const ACTIVE_TASK_STATUSES = ['in_progress', 'review', 'ready_to_merge', 'deployed'] as const;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export function taskStatusesSqlList(statuses: readonly string[] = TASK_STATUSES): string {
  return statuses.map(status => `'${status}'`).join(',');
}
