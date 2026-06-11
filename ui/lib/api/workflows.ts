import { apiFetch } from './http';
import type { CreateSprintInput, ProjectMetrics, Sprint, SprintMetrics, SprintOutcomesResponse, SprintRelationshipTypeInput, SprintType, SprintTypeOutcome, SprintTypeTaskType, TaskFieldSchema, TaskFieldSchemaDocument, TaskRelationshipTypeConfig, TaskStatusMeta, WorkflowConfigResponse, WorkflowMetadataResponse } from './types';

export const workflowsClient = {
// Sprints
getSprintTypes: () => apiFetch<SprintType[]>('/api/v1/sprint-types'),
getWorkflowConfig: () => apiFetch<WorkflowConfigResponse>('/api/v1/sprints/config'),
getWorkflowMetadata: (params?: { sprint_id?: number | null; sprint_type?: string | null; task_type?: string | null }) => {
  const qs = new URLSearchParams();
  if (params?.sprint_id != null) qs.set('sprint_id', String(params.sprint_id));
  if (params?.sprint_type) qs.set('sprint_type', params.sprint_type);
  if (params?.task_type) qs.set('task_type', params.task_type);
  const query = qs.toString();
  return apiFetch<WorkflowMetadataResponse>(`/api/v1/sprints/workflow-metadata${query ? `?${query}` : ''}`);
},
createSprintType: (data: { key: string; name: string; description?: string }) =>
  apiFetch<SprintType>('/api/v1/sprints/types', { method: 'POST', body: JSON.stringify(data) }),
updateSprintType: (key: string, data: { name?: string; description?: string }) =>
  apiFetch<SprintType>(`/api/v1/sprints/types/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteSprintType: (key: string) =>
  apiFetch<{ ok: boolean }>(`/api/v1/sprints/types/${encodeURIComponent(key)}`, { method: 'DELETE' }),
replaceSprintTypeTaskTypes: (key: string, taskTypes: string[]) =>
  apiFetch<{ sprint_type: SprintType; task_types: SprintTypeTaskType[] }>(`/api/v1/sprints/types/${encodeURIComponent(key)}/task-types`, {
    method: 'PUT',
    body: JSON.stringify({ task_types: taskTypes }),
  }),
getSprintTypeStatuses: (key: string) =>
  apiFetch<{ sprint_type: SprintType; statuses: TaskStatusMeta[] }>(`/api/v1/sprints/types/${encodeURIComponent(key)}/statuses`),
createSprintTypeStatus: (key: string, data: Partial<TaskStatusMeta> & { name: string; label: string }) =>
  apiFetch<TaskStatusMeta>(`/api/v1/sprints/types/${encodeURIComponent(key)}/statuses`, { method: 'POST', body: JSON.stringify(data) }),
updateSprintTypeStatus: (key: string, name: string, data: Partial<TaskStatusMeta>) =>
  apiFetch<TaskStatusMeta>(`/api/v1/sprints/types/${encodeURIComponent(key)}/statuses/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteSprintTypeStatus: (key: string, name: string) =>
  apiFetch<{ ok: boolean }>(`/api/v1/sprints/types/${encodeURIComponent(key)}/statuses/${encodeURIComponent(name)}`, { method: 'DELETE' }),
getSprintOutcomes: (key: string) =>
  apiFetch<SprintOutcomesResponse>(`/api/v1/sprints/types/${encodeURIComponent(key)}/outcomes`),
createTaskFieldSchema: (key: string, data: { task_type?: string | null; schema: TaskFieldSchemaDocument }) =>
  apiFetch<TaskFieldSchema>(`/api/v1/sprints/types/${encodeURIComponent(key)}/field-schemas`, {
    method: 'POST',
    body: JSON.stringify(data),
  }),
updateTaskFieldSchema: (key: string, schemaId: number, data: { task_type?: string | null; schema: TaskFieldSchemaDocument }) =>
  apiFetch<TaskFieldSchema>(`/api/v1/sprints/types/${encodeURIComponent(key)}/field-schemas/${schemaId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
deleteTaskFieldSchema: (key: string, schemaId: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/sprints/types/${encodeURIComponent(key)}/field-schemas/${schemaId}`, { method: 'DELETE' }),
createSprintOutcome: (key: string, data: Omit<SprintTypeOutcome, 'id' | 'sprint_type_key' | 'is_system' | 'created_at' | 'updated_at'>) =>
  apiFetch<SprintTypeOutcome>(`/api/v1/sprints/types/${encodeURIComponent(key)}/outcomes`, {
    method: 'POST',
    body: JSON.stringify(data),
  }),
updateSprintOutcome: (key: string, outcomeId: number, data: Partial<Omit<SprintTypeOutcome, 'id' | 'sprint_type_key' | 'is_system' | 'created_at' | 'updated_at'>>) =>
  apiFetch<SprintTypeOutcome>(`/api/v1/sprints/types/${encodeURIComponent(key)}/outcomes/${outcomeId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
deleteSprintOutcome: (key: string, outcomeId: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/sprints/types/${encodeURIComponent(key)}/outcomes/${outcomeId}`, { method: 'DELETE' }),
getSprintRelationshipTypes: (key: string) =>
  apiFetch<{ relationship_types: TaskRelationshipTypeConfig[] }>(`/api/v1/sprints/types/${encodeURIComponent(key)}/relationship-types`),
createSprintRelationshipType: (key: string, data: SprintRelationshipTypeInput) =>
  apiFetch<TaskRelationshipTypeConfig>(`/api/v1/sprints/types/${encodeURIComponent(key)}/relationship-types`, { method: 'POST', body: JSON.stringify(data) }),
updateSprintRelationshipType: (key: string, relationshipTypeId: number, data: SprintRelationshipTypeInput) =>
  apiFetch<TaskRelationshipTypeConfig>(`/api/v1/sprints/types/${encodeURIComponent(key)}/relationship-types/${relationshipTypeId}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteSprintRelationshipType: (key: string, relationshipTypeId: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/sprints/types/${encodeURIComponent(key)}/relationship-types/${relationshipTypeId}`, { method: 'DELETE' }),
getSprints: (projectId?: number, includeClosed?: boolean) => {
  const params = new URLSearchParams();
  if (projectId) params.set('project_id', String(projectId));
  if (includeClosed) params.set('include_closed', 'true');
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<Sprint[]>(`/api/v1/sprints${qs}`);
},
getSprint: (id: number) => apiFetch<Sprint>(`/api/v1/sprints/${id}`),
createSprint: (data: CreateSprintInput) =>
  apiFetch<Sprint>('/api/v1/sprints', { method: 'POST', body: JSON.stringify(data) }),
updateSprint: (id: number, data: Partial<Sprint>) =>
  apiFetch<Sprint>(`/api/v1/sprints/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteSprint: (id: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/sprints/${id}`, { method: 'DELETE' }),
completeSprint: (id: number) =>
  apiFetch<Sprint>(`/api/v1/sprints/${id}/complete`, { method: 'POST' }),
closeSprint: (id: number) =>
  apiFetch<Sprint>(`/api/v1/sprints/${id}/close`, { method: 'POST' }),
getSprintMetrics: (id: number) => apiFetch<SprintMetrics>(`/api/v1/sprints/${id}/metrics`),
getProjectMetrics: (id: number) => apiFetch<ProjectMetrics>(`/api/v1/projects/${id}/metrics`),
};
