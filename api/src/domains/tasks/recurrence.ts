import type { Db } from '../../db/adapter/types';

/** Stored occurrence provenance, separate from editable workflow custom fields. */
export interface TaskRecurrenceMetadata {
  recurring_series_id: number | null;
  scheduled_for: string | null;
  schedule_run_id: number | null;
  generated_from: string | null;
}

export const TASK_RECURRENCE_SELECT = 't.recurring_series_id, t.scheduled_for, t.schedule_run_id, t.generated_from';

export function taskRecurrenceMetadata(row: Partial<TaskRecurrenceMetadata>): TaskRecurrenceMetadata {
  return {
    recurring_series_id: row.recurring_series_id ?? null,
    scheduled_for: row.scheduled_for ?? null,
    schedule_run_id: row.schedule_run_id ?? null,
    generated_from: row.generated_from ?? null,
  };
}

export async function loadTaskRecurrenceMetadata(db: Db, taskId: number): Promise<TaskRecurrenceMetadata> {
  const row = await db.get(`SELECT ${TASK_RECURRENCE_SELECT} FROM tasks t WHERE t.id = ?`, taskId) as TaskRecurrenceMetadata | undefined;
  return taskRecurrenceMetadata(row ?? {});
}
