/**
 * Task statuses are 100% configuration. Valid statuses for a task come only from its workflow's
 * configured statuses (workflow_task_statuses), or from its workflow type's (workflow_type_task_statuses)
 * when the workflow has none of its own. There is no global list of valid statuses: see
 * lib/taskStatusValidation.ts.
 *
 * Code that reacts to a status by name ('blocked', 'in_progress', ...) is engine behaviour for
 * workflows that configure that status. It does not make the status valid anywhere.
 */
export type TaskStatus = string;

/**
 * Seed data only: the terminal defaults the starter workflow templates are created with.
 *
 * This is NOT the answer to "is this status terminal?". Terminality is operator
 * configuration held in task_statuses / workflow_type_task_statuses /
 * workflow_task_statuses, and is read through
 * domains/tasks/terminality.ts (list form) or the dispatcher's
 * buildResolvedTaskTerminalityExpression (SQL form). Deciding terminality from
 * this constant would override what the user configured.
 */
export const DEFAULT_TERMINAL_TASK_STATUS_SEEDS = ['done', 'cancelled', 'failed'] as const;
