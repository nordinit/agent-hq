import { apiFetch } from './http';
import { withWorkflowAliases } from './workflowAliases';
import type { ReconcilerConfig, RoutingConfig, RoutingScopeInfo, RoutingTransition, TaskRoutingRule, TaskStatusMeta, TransitionRequirement, TransitionRequirementFieldsResponse, WorkflowEventMapping } from './types';

export const routingClient = {
// Routing Config / Routing Admin
getRoutingConfig: (projectId?: number) => {
  const qs = projectId ? `?project_id=${projectId}` : '';
  return apiFetch<RoutingConfig[]>(`/api/v1/routing-config${qs}`);
},
getRoutingConfigs: () =>
  apiFetch<{ configs: RoutingConfig[] }>(`/api/v1/routing/config`),
getRoutingReconcilerConfig: () =>
  apiFetch<ReconcilerConfig>(`/api/v1/routing/reconciler-config`),
updateRoutingReconcilerConfig: (data: ReconcilerConfig) =>
  apiFetch<ReconcilerConfig>(`/api/v1/routing/reconciler-config`, { method: 'PUT', body: JSON.stringify(data) }),
createRoutingConfig: (data: Partial<RoutingConfig>) =>
  apiFetch<RoutingConfig>('/api/v1/routing-config', { method: 'POST', body: JSON.stringify(data) }),
updateRoutingConfig: (id: number | null | undefined, data: Partial<RoutingConfig>) =>
  apiFetch<RoutingConfig>(`/api/v1/routing/config/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteRoutingConfig: (id: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/routing-config/${id}`, { method: 'DELETE' }),
getRoutingStatuses: (sprintId?: number) => {
  const qs = sprintId ? `?sprint_id=${sprintId}` : '';
  return apiFetch<{ statuses: TaskStatusMeta[] }>(`/api/v1/routing/statuses${qs}`);
},
createRoutingStatus: (data: Partial<TaskStatusMeta> & { name: string; label: string; sprint_id?: number }) =>
  apiFetch<TaskStatusMeta>(`/api/v1/routing/statuses`, { method: 'POST', body: JSON.stringify(data) }),
updateRoutingStatus: (name: string, data: Partial<TaskStatusMeta> & { sprint_id?: number }) =>
  apiFetch<TaskStatusMeta>(`/api/v1/routing/statuses/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteRoutingStatus: (name: string, sprintId?: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/routing/statuses/${encodeURIComponent(name)}${sprintId ? `?sprint_id=${sprintId}` : ''}`, { method: 'DELETE' }),
getRoutingTransitions: (projectId?: number, sprintId?: number, sprintType?: string) => {
  const params = new URLSearchParams();
  if (projectId) params.set('project_id', String(projectId));
  if (sprintId) params.set('workflow_id', String(sprintId));
  if (sprintType) params.set('workflow_type', sprintType);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<{ transitions: RoutingTransition[]; scope?: RoutingScopeInfo }>(`/api/v1/routing/transitions${qs}`);
},
createRoutingTransition: (data: Partial<RoutingTransition>) =>
  apiFetch<RoutingTransition>(`/api/v1/routing/transitions`, { method: 'POST', body: JSON.stringify(withWorkflowAliases(data)) }),
updateRoutingTransition: (id: number, data: Partial<RoutingTransition>) =>
  apiFetch<RoutingTransition>(`/api/v1/routing/transitions/${id}`, { method: 'PUT', body: JSON.stringify(withWorkflowAliases(data)) }),
deleteRoutingTransition: (id: number, sprintId?: number, projectId?: number, sprintType?: string) => {
  const params = new URLSearchParams();
  if (sprintId) params.set('workflow_id', String(sprintId));
  if (projectId) params.set('project_id', String(projectId));
  if (sprintType) params.set('workflow_type', sprintType);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<{ ok: boolean }>(`/api/v1/routing/transitions/${id}${qs}`, { method: 'DELETE' });
},
getRoutingRules: (projectId?: number, sprintId?: number, sprintType?: string) => {
  const params = new URLSearchParams();
  if (projectId) params.set('project_id', String(projectId));
  if (sprintId) params.set('workflow_id', String(sprintId));
  if (sprintType) params.set('workflow_type', sprintType);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<{ rules: TaskRoutingRule[]; scope?: RoutingScopeInfo }>(`/api/v1/routing/rules${qs}`);
},
createRoutingRule: (data: Partial<TaskRoutingRule>) =>
  apiFetch<TaskRoutingRule>(`/api/v1/routing/rules`, { method: 'POST', body: JSON.stringify(withWorkflowAliases(data)) }),
updateRoutingRule: (id: number, data: Partial<TaskRoutingRule>) =>
  apiFetch<TaskRoutingRule>(`/api/v1/routing/rules/${id}`, { method: 'PUT', body: JSON.stringify(withWorkflowAliases(data)) }),
deleteRoutingRule: (id: number, sprintId?: number, projectId?: number) => {
  const params = new URLSearchParams();
  if (sprintId) params.set('workflow_id', String(sprintId));
  if (projectId) params.set('project_id', String(projectId));
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<{ ok: boolean }>(`/api/v1/routing/rules/${id}${qs}`, { method: 'DELETE' });
},
// Transition requirements (task #612)
getTransitionRequirements: (taskType?: string, outcome?: string, sprintId?: number, projectId?: number, sprintType?: string) => {
  const params = new URLSearchParams();
  if (taskType) params.set('task_type', taskType);
  if (outcome) params.set('outcome', outcome);
  if (sprintId) params.set('workflow_id', String(sprintId));
  if (projectId) params.set('project_id', String(projectId));
  if (sprintType) params.set('workflow_type', sprintType);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<{ transition_requirements: TransitionRequirement[]; scope?: RoutingScopeInfo }>(`/api/v1/routing/transition-requirements${qs}`);
},
getTransitionRequirementFields: (sprintId?: number, taskType?: string, sprintType?: string) => {
  const params = new URLSearchParams();
  if (sprintId) params.set('workflow_id', String(sprintId));
  if (sprintType) params.set('workflow_type', sprintType);
  if (taskType) params.set('task_type', taskType);
  return apiFetch<TransitionRequirementFieldsResponse>(`/api/v1/routing/transition-requirement-fields?${params.toString()}`);
},
createTransitionRequirement: (data: Partial<TransitionRequirement>) =>
  apiFetch<TransitionRequirement>(`/api/v1/routing/transition-requirements`, { method: 'POST', body: JSON.stringify(withWorkflowAliases(data)) }),
updateTransitionRequirement: (id: number, data: Partial<TransitionRequirement>) =>
  apiFetch<TransitionRequirement>(`/api/v1/routing/transition-requirements/${id}`, { method: 'PUT', body: JSON.stringify(withWorkflowAliases(data)) }),
deleteTransitionRequirement: (id: number, sprintId?: number, projectId?: number, sprintType?: string) => {
  const params = new URLSearchParams();
  if (sprintId) params.set('workflow_id', String(sprintId));
  if (projectId) params.set('project_id', String(projectId));
  if (sprintType) params.set('workflow_type', sprintType);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<{ ok: boolean }>(`/api/v1/routing/transition-requirements/${id}${qs}`, { method: 'DELETE' });
},

getWorkflowEventMappings: (projectId?: number, sprintId?: number, sprintType?: string) => {
  const params = new URLSearchParams();
  if (projectId) params.set('project_id', String(projectId));
  if (sprintId) params.set('workflow_id', String(sprintId));
  if (sprintType) params.set('workflow_type', sprintType);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<{ mappings: WorkflowEventMapping[] }>(`/api/v1/routing/workflow-event-mappings${qs}`);
},
createWorkflowEventMapping: (data: Partial<WorkflowEventMapping>) =>
  apiFetch<WorkflowEventMapping>(`/api/v1/routing/workflow-event-mappings`, { method: 'POST', body: JSON.stringify(data) }),
updateWorkflowEventMapping: (id: number, data: Partial<WorkflowEventMapping>) =>
  apiFetch<WorkflowEventMapping>(`/api/v1/routing/workflow-event-mappings/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteWorkflowEventMapping: (id: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/routing/workflow-event-mappings/${id}`, { method: 'DELETE' }),
getExternalEventMappings: (projectId?: number) => routingClient.getWorkflowEventMappings(projectId),
createExternalEventMapping: (data: Partial<WorkflowEventMapping>) => routingClient.createWorkflowEventMapping(data),
updateExternalEventMapping: (id: number, data: Partial<WorkflowEventMapping>) => routingClient.updateWorkflowEventMapping(id, data),
deleteExternalEventMapping: (id: number) => routingClient.deleteWorkflowEventMapping(id),
};
