import type { TaskType } from '../../lib/taskTypes';
import type { TaskStatus } from '../../lib/taskStatuses';

export type RecurringTaskOverlapPolicy = 'skip_if_active' | 'create_anyway';
export type RecurringTaskRunStatus = 'started' | 'created' | 'skipped' | 'failed';
export type GeneratedTaskMarker = 'recurring_task_series';

export interface RecurringTaskSeriesRecord {
  id: number;
  tenant_id: number | null;
  project_id: number;
  sprint_id: number;
  title_template: string;
  description_template: string;
  task_type: TaskType | string;
  priority: 'low' | 'medium' | 'high';
  story_points: number;
  status_on_create: TaskStatus | string;
  schedule_expression: string;
  timezone: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  overlap_policy: RecurringTaskOverlapPolicy;
  agent_id: number | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface RecurringTaskRunRecord {
  id: number;
  series_id: number;
  scheduled_for: string;
  created_task_id: number | null;
  status: RecurringTaskRunStatus;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export interface GeneratedTaskRecurrenceMetadata {
  recurring_series_id: number;
  scheduled_for: string;
  schedule_run_id: number;
  generated_from: GeneratedTaskMarker;
}

export interface RecurringTaskSeriesListItem extends RecurringTaskSeriesRecord {
  project_name: string | null;
  sprint_name: string | null;
  sprint_status: string | null;
  sprint_type: string | null;
  agent_name: string | null;
  latest_run_id: number | null;
  latest_run_status: RecurringTaskRunStatus | null;
  latest_run_scheduled_for: string | null;
  latest_run_created_task_id: number | null;
  generated_task_count: number;
}

export interface RecurringTaskRunWithTask extends RecurringTaskRunRecord {
  generated_task_title: string | null;
  generated_task_status: string | null;
}
