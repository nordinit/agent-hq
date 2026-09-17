import { apiFetch } from './http';
import type { CreateWorkflowInput, ProjectMetrics, Workflow, WorkflowMetrics, WorkflowOutcomesResponse, WorkflowRelationshipTypeInput, WorkflowType, WorkflowTypeOutcome, WorkflowTypeTaskType, TaskFieldSchema, TaskFieldSchemaDocument, TaskRelationshipTypeConfig, TaskStatusMeta, WorkflowConfigResponse, WorkflowMetadataResponse } from './types';

export const workflowsClient = {
// Workflows
getWorkflowTypes: () => apiFetch<WorkflowType[]>('/api/v1/workflow-types'),
getWorkflowConfig: () => apiFetch<WorkflowConfigResponse>('/api/v1/workflows/config'),
getWorkflowMetadata: (params?: { workflow_id?: number | null; workflow_type?: string | null; task_type?: string | null }) => {
  const qs = new URLSearchParams();
  if (params?.workflow_id != null) qs.set('workflow_id', String(params.workflow_id));
  if (params?.workflow_type) qs.set('workflow_type', params.workflow_type);
  if (params?.task_type) qs.set('task_type', params.task_type);
  const query = qs.toString();
  return apiFetch<WorkflowMetadataResponse>(`/api/v1/workflows/workflow-metadata${query ? `?${query}` : ''}`);
},
createWorkflowType: (data: { key: string; name: string; description?: string }) =>
  apiFetch<WorkflowType>('/api/v1/workflows/types', { method: 'POST', body: JSON.stringify(data) }),
updateWorkflowType: (key: string, data: { name?: string; description?: string }) =>
  apiFetch<WorkflowType>(`/api/v1/workflows/types/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteWorkflowType: (key: string) =>
  apiFetch<{ ok: boolean }>(`/api/v1/workflows/types/${encodeURIComponent(key)}`, { method: 'DELETE' }),
replaceWorkflowTypeTaskTypes: (key: string, taskTypes: string[]) =>
  apiFetch<{ workflow_type: WorkflowType; task_types: WorkflowTypeTaskType[] }>(`/api/v1/workflows/types/${encodeURIComponent(key)}/task-types`, {
    method: 'PUT',
    body: JSON.stringify({ task_types: taskTypes }),
  }),
getWorkflowTypeStatuses: (key: string) =>
  apiFetch<{ workflow_type: WorkflowType; statuses: TaskStatusMeta[] }>(`/api/v1/workflows/types/${encodeURIComponent(key)}/statuses`),
createWorkflowTypeStatus: (key: string, data: Partial<TaskStatusMeta> & { name: string; label: string }) =>
  apiFetch<TaskStatusMeta>(`/api/v1/workflows/types/${encodeURIComponent(key)}/statuses`, { method: 'POST', body: JSON.stringify(data) }),
updateWorkflowTypeStatus: (key: string, name: string, data: Partial<TaskStatusMeta>) =>
  apiFetch<TaskStatusMeta>(`/api/v1/workflows/types/${encodeURIComponent(key)}/statuses/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteWorkflowTypeStatus: (key: string, name: string) =>
  apiFetch<{ ok: boolean }>(`/api/v1/workflows/types/${encodeURIComponent(key)}/statuses/${encodeURIComponent(name)}`, { method: 'DELETE' }),
getWorkflowOutcomes: (key: string) =>
  apiFetch<WorkflowOutcomesResponse>(`/api/v1/workflows/types/${encodeURIComponent(key)}/outcomes`),
createTaskFieldSchema: (key: string, data: { task_type?: string | null; schema: TaskFieldSchemaDocument }) =>
  apiFetch<TaskFieldSchema>(`/api/v1/workflows/types/${encodeURIComponent(key)}/field-schemas`, {
    method: 'POST',
    body: JSON.stringify(data),
  }),
updateTaskFieldSchema: (key: string, schemaId: number, data: { task_type?: string | null; schema: TaskFieldSchemaDocument }) =>
  apiFetch<TaskFieldSchema>(`/api/v1/workflows/types/${encodeURIComponent(key)}/field-schemas/${schemaId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
deleteTaskFieldSchema: (key: string, schemaId: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/workflows/types/${encodeURIComponent(key)}/field-schemas/${schemaId}`, { method: 'DELETE' }),
createWorkflowOutcome: (key: string, data: Omit<WorkflowTypeOutcome, 'id' | 'workflow_type_key' | 'is_system' | 'created_at' | 'updated_at'>) =>
  apiFetch<WorkflowTypeOutcome>(`/api/v1/workflows/types/${encodeURIComponent(key)}/outcomes`, {
    method: 'POST',
    body: JSON.stringify(data),
  }),
updateWorkflowOutcome: (key: string, outcomeId: number, data: Partial<Omit<WorkflowTypeOutcome, 'id' | 'workflow_type_key' | 'is_system' | 'created_at' | 'updated_at'>>) =>
  apiFetch<WorkflowTypeOutcome>(`/api/v1/workflows/types/${encodeURIComponent(key)}/outcomes/${outcomeId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
deleteWorkflowOutcome: (key: string, outcomeId: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/workflows/types/${encodeURIComponent(key)}/outcomes/${outcomeId}`, { method: 'DELETE' }),
getWorkflowRelationshipTypes: (key: string) =>
  apiFetch<{ relationship_types: TaskRelationshipTypeConfig[] }>(`/api/v1/workflows/types/${encodeURIComponent(key)}/relationship-types`),
createWorkflowRelationshipType: (key: string, data: WorkflowRelationshipTypeInput) =>
  apiFetch<TaskRelationshipTypeConfig>(`/api/v1/workflows/types/${encodeURIComponent(key)}/relationship-types`, { method: 'POST', body: JSON.stringify(data) }),
updateWorkflowRelationshipType: (key: string, relationshipTypeId: number, data: WorkflowRelationshipTypeInput) =>
  apiFetch<TaskRelationshipTypeConfig>(`/api/v1/workflows/types/${encodeURIComponent(key)}/relationship-types/${relationshipTypeId}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteWorkflowRelationshipType: (key: string, relationshipTypeId: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/workflows/types/${encodeURIComponent(key)}/relationship-types/${relationshipTypeId}`, { method: 'DELETE' }),
getWorkflows: (projectId?: number, includeClosed?: boolean) => {
  const params = new URLSearchParams();
  if (projectId) params.set('project_id', String(projectId));
  if (includeClosed) params.set('include_closed', 'true');
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<Workflow[]>(`/api/v1/workflows${qs}`);
},
getWorkflow: (id: number) => apiFetch<Workflow>(`/api/v1/workflows/${id}`),
createWorkflow: (data: CreateWorkflowInput) =>
  apiFetch<Workflow>('/api/v1/workflows', { method: 'POST', body: JSON.stringify(data) }),
updateWorkflow: (id: number, data: Partial<Workflow>) =>
  apiFetch<Workflow>(`/api/v1/workflows/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteWorkflow: (id: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/workflows/${id}`, { method: 'DELETE' }),
completeWorkflow: (id: number) =>
  apiFetch<Workflow>(`/api/v1/workflows/${id}/complete`, { method: 'POST' }),
closeWorkflow: (id: number) =>
  apiFetch<Workflow>(`/api/v1/workflows/${id}/close`, { method: 'POST' }),
getWorkflowMetrics: (id: number) => apiFetch<WorkflowMetrics>(`/api/v1/workflows/${id}/metrics`),
getProjectMetrics: (id: number) => apiFetch<ProjectMetrics>(`/api/v1/projects/${id}/metrics`),
};
