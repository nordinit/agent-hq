import { apiFetch, getApiBase } from './http';
import type { CreateTaskPayload, HistoricalTrace, RecurringTaskRun, RecurringTaskRunNowResponse, RecurringTaskSeries, RecurringTaskSeriesDetail, RecurringTaskSeriesInput, RecurringTaskSeriesListResponse, ResolvedTaskFieldSchemaResponse, Task, TaskAttachment, TaskHistory, TaskNote, TaskRelationship } from './types';

export const tasksClient = {
// Tasks
getTasks: (projectId?: number, sprintId?: number, filters?: { origin_task_id?: number; defect_type?: string; status?: string; include_closed?: boolean; live_instances_only?: boolean }) => {
  const qs = new URLSearchParams();
  if (projectId) qs.set('project_id', String(projectId));
  if (sprintId) qs.set('sprint_id', String(sprintId));
  if (filters?.origin_task_id != null) qs.set('origin_task_id', String(filters.origin_task_id));
  if (filters?.defect_type) qs.set('defect_type', filters.defect_type);
  if (filters?.status) qs.set('status', filters.status);
  if (filters?.include_closed) qs.set('include_closed', 'true');
  if (filters?.live_instances_only) qs.set('live_instances_only', 'true');
  const q = qs.toString();
  return apiFetch<Task[]>(`/api/v1/tasks${q ? `?${q}` : ''}`);
},
searchTasks: (q: string, excludeId?: number, filters?: { project_id?: number | null; sprint_id?: number | null }) => {
  const qs = new URLSearchParams({ q });
  if (excludeId != null) qs.set('exclude_id', String(excludeId));
  if (filters?.project_id != null) qs.set('project_id', String(filters.project_id));
  if (filters?.sprint_id != null) qs.set('sprint_id', String(filters.sprint_id));
  return apiFetch<{ id: number; title: string; status: string }[]>(`/api/v1/tasks/search?${qs}`);
},
getTask: (id: number) => apiFetch<Task>(`/api/v1/tasks/${id}`),
getTaskRelationships: (taskId: number) =>
  apiFetch<{ relationships: TaskRelationship[] }>(`/api/v1/tasks/${taskId}/relationships`),
createTaskRelationship: (taskId: number, data: { target_task_id: number; relationship_type_key: string; metadata?: Record<string, unknown>; created_by?: string }) =>
  apiFetch<TaskRelationship>(`/api/v1/tasks/${taskId}/relationships`, { method: 'POST', body: JSON.stringify(data) }),
deleteTaskRelationship: (taskId: number, relationshipId: number) =>
  apiFetch<{ ok: true; deleted_id: number }>(`/api/v1/tasks/${taskId}/relationships/${relationshipId}`, { method: 'DELETE' }),
createTask: (data: Partial<Task> | CreateTaskPayload) =>
  apiFetch<Task>('/api/v1/tasks', { method: 'POST', body: JSON.stringify(data) }),
updateTask: (id: number, data: Partial<Task>) =>
  apiFetch<Task>(`/api/v1/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
resolveTaskFieldSchema: (params: { sprint_id?: number | null; task_type?: string | null }) => {
  const qs = new URLSearchParams();
  if (params.sprint_id !== undefined && params.sprint_id !== null) qs.set('sprint_id', String(params.sprint_id));
  if (params.task_type !== undefined && params.task_type !== null) qs.set('task_type', params.task_type);
  return apiFetch<ResolvedTaskFieldSchemaResponse>(`/api/v1/tasks/field-schema/resolve?${qs.toString()}`);
},
deleteTask: (id: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/tasks/${id}`, { method: 'DELETE' }),
getRecurringTaskSeries: (params?: { project_id?: number | null; workflow_id?: number | null; sprint_id?: number | null; enabled?: boolean | null; limit?: number; offset?: number }) => {
  const qs = new URLSearchParams();
  if (params?.project_id) qs.set('project_id', String(params.project_id));
  if (params?.workflow_id) qs.set('workflow_id', String(params.workflow_id));
  else if (params?.sprint_id) qs.set('sprint_id', String(params.sprint_id));
  if (params?.enabled !== undefined && params.enabled !== null) qs.set('enabled', String(params.enabled));
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const query = qs.toString();
  return apiFetch<RecurringTaskSeriesListResponse>(`/api/v1/recurring-task-series${query ? `?${query}` : ''}`);
},
getRecurringTaskSeriesDetail: (id: number) =>
  apiFetch<RecurringTaskSeriesDetail>(`/api/v1/recurring-task-series/${id}`),
createRecurringTaskSeries: (data: RecurringTaskSeriesInput) =>
  apiFetch<RecurringTaskSeries>(`/api/v1/recurring-task-series`, { method: 'POST', body: JSON.stringify(data) }),
updateRecurringTaskSeries: (id: number, data: Partial<RecurringTaskSeriesInput>) =>
  apiFetch<RecurringTaskSeries>(`/api/v1/recurring-task-series/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
enableRecurringTaskSeries: (id: number) =>
  apiFetch<RecurringTaskSeries>(`/api/v1/recurring-task-series/${id}/enable`, { method: 'POST', body: JSON.stringify({ changed_by: 'User' }) }),
disableRecurringTaskSeries: (id: number) =>
  apiFetch<RecurringTaskSeries>(`/api/v1/recurring-task-series/${id}/disable`, { method: 'POST', body: JSON.stringify({ changed_by: 'User' }) }),
runRecurringTaskSeriesNow: (id: number) =>
  apiFetch<RecurringTaskRunNowResponse>(`/api/v1/recurring-task-series/${id}/run-now`, { method: 'POST', body: JSON.stringify({ changed_by: 'User' }) }),
getRecurringTaskSeriesHistory: (id: number, limit = 25) =>
  apiFetch<{ series_id: number; runs: RecurringTaskRun[] }>(`/api/v1/recurring-task-series/${id}/history?limit=${limit}`),
cancelTask: (id: number) =>
  apiFetch<{ ok: boolean; task: Task }>(`/api/v1/tasks/${id}/cancel`, { method: 'POST' }),
stopTask: (id: number, reason?: string) =>
  apiFetch<{
    ok: boolean;
    had_active_run: boolean;
    task_was_paused: boolean;
    no_op: boolean;
    stop_result: {
      id: number;
      behavior: 'stop' | 'park' | 'requeue';
      result: 'confirmed_stopped' | 'already_gone' | 'stopped_runtime_uncertain';
      message: string;
      runtimeUncertain: boolean;
      taskId: number | null;
      taskStatusBefore: string | null;
      taskStatusAfter: string | null;
      clearedTaskLinkage: boolean;
    } | null;
    task: Task;
  }>(`/api/v1/tasks/${id}/stop`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason ?? null, changed_by: 'User' }),
  }),
pauseTask: (id: number, reason?: string) =>
  apiFetch<{ ok: boolean; task: Task }>(`/api/v1/tasks/${id}/pause`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason ?? null }),
  }),
unpauseTask: (id: number) =>
  apiFetch<{ ok: boolean; task: Task }>(`/api/v1/tasks/${id}/unpause`, { method: 'POST' }),
addBlocker: (taskId: number, blockerId: number) =>
  apiFetch<Task>(`/api/v1/tasks/${taskId}/blockers`, {
    method: 'POST',
    body: JSON.stringify({ blocker_id: blockerId }),
  }),
removeBlocker: (taskId: number, blockerId: number) =>
  apiFetch<Task>(`/api/v1/tasks/${taskId}/blockers/${blockerId}`, { method: 'DELETE' }),
// Task Notes
getTaskNotes: (taskId: number) =>
  apiFetch<TaskNote[]>(`/api/v1/tasks/${taskId}/notes`),
createTaskNote: (taskId: number, data: { author: string; content: string }) =>
  apiFetch<TaskNote>(`/api/v1/tasks/${taskId}/notes`, {
    method: 'POST',
    body: JSON.stringify(data),
  }),
deleteTaskNote: (taskId: number, noteId: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/tasks/${taskId}/notes/${noteId}`, { method: 'DELETE' }),
// Task History
getTaskHistory: (taskId: number) =>
  apiFetch<TaskHistory[]>(`/api/v1/tasks/${taskId}/history`),
// Status history replayed against the routing graph, for the canvas overlay.
getTaskTrace: (taskId: number) =>
  apiFetch<HistoricalTrace>(`/api/v1/tasks/${taskId}/trace`),
// Task Attachments
getTaskAttachments: (taskId: number) =>
  apiFetch<TaskAttachment[]>(`/api/v1/tasks/${taskId}/attachments`),

uploadTaskAttachment: async (taskId: number, file: File, uploadedBy?: string) => {
  const formData = new FormData();
  formData.append('file', file);
  if (uploadedBy) formData.append('uploaded_by', uploadedBy);
  const res = await fetch(`${getApiBase()}/api/v1/tasks/${taskId}/attachments`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json() as Promise<TaskAttachment>;
},

deleteTaskAttachment: (taskId: number, attachmentId: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/tasks/${taskId}/attachments/${attachmentId}`, { method: 'DELETE' }),

getTaskAttachmentUrl: (taskId: number, attachmentId: number) =>
  `${getApiBase()}/api/v1/tasks/${taskId}/attachments/${attachmentId}/download`,
// Task Outcome
submitTaskOutcome: (taskId: number, data: { outcome: string; changed_by: string; summary?: string }) =>
  apiFetch<{ ok: boolean; prior_status: string; next_status: string; outcome: string; task: Task }>(
    `/api/v1/tasks/${taskId}/outcome`,
    { method: 'POST', body: JSON.stringify(data) }
  ),
updateReviewEvidence: (taskId: number, data: { review_branch?: string | null; review_commit?: string | null; review_url?: string | null; summary?: string; changed_by?: string }) =>
  apiFetch<Task>(`/api/v1/tasks/${taskId}/review-evidence`, { method: 'PUT', body: JSON.stringify(data) }),
updateQaEvidence: (taskId: number, data: { qa_verified_commit?: string | null; tested_url?: string | null; summary?: string; changed_by?: string }) =>
  apiFetch<Task>(`/api/v1/tasks/${taskId}/qa-evidence`, { method: 'PUT', body: JSON.stringify(data) }),
updateDeployEvidence: (taskId: number, data: { merged_commit?: string | null; deployed_commit?: string | null; deploy_target?: string | null; deployed_at?: string | null; summary?: string; changed_by?: string }) =>
  apiFetch<Task>(`/api/v1/tasks/${taskId}/deploy-evidence`, { method: 'PUT', body: JSON.stringify(data) }),
updateLiveVerification: (taskId: number, data: { live_verified_by?: string | null; live_verified_at?: string | null; summary?: string; changed_by?: string }) =>
  apiFetch<Task>(`/api/v1/tasks/${taskId}/live-verification`, { method: 'PUT', body: JSON.stringify(data) }),
backfillReleaseIntegrity: () =>
  apiFetch<{ ok: boolean; total: number; flagged: number }>(`/api/v1/tasks/backfill-release-integrity`, { method: 'POST' }),
};
