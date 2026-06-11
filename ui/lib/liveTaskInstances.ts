export const LIVE_TASK_INSTANCE_STATUSES = new Set(['queued', 'dispatched', 'running']);

export interface LiveTaskInstanceRef {
  active_instance_id?: number | null;
  active_instance_status?: string | null;
}

export function hasLiveTaskInstance(task: LiveTaskInstanceRef): boolean {
  return task.active_instance_id != null
    && typeof task.active_instance_status === 'string'
    && LIVE_TASK_INSTANCE_STATUSES.has(task.active_instance_status);
}
