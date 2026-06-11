/**
 * Legacy/default task-type seed list.
 *
 * Runtime task-type validation is workflow-specific and comes from
 * sprint_type_task_types / workflow definition config. Do not use this list as
 * a global source of truth for allowed task_type values.
 */
export const VALID_TASK_TYPES = [
  'frontend',
  'backend',
  'fullstack',
  'qa',
  'design',
  'marketing',
  'pm',
  'pm_analysis',
  'pm_operational',
  'ops',
  'data',
  'adhoc',
  'other',
] as const;

export type TaskType = string;

export function isValidTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(value.trim().toLowerCase());
}
