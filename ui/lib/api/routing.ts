import { apiFetch } from './http';
import type { HypotheticalTrace, RoutingPreview, RoutingPreviewOperation, ReconcilerConfig, RoutingConfig, RoutingScopeInfo, RoutingTransition, TaskRoutingRule, TaskStatusMeta, TransitionRequirement, TransitionRequirementFieldsResponse, WorkflowEventMapping, WorkflowGraph } from './types';

export const routingClient = {
// The workflow state machine, derived server-side so the canvas and Atlas share one
// representation. workflowType is required — a graph is always scoped to one type.
getRoutingGraph: (projectId?: number | null, workflowType?: string | null, workflowId?: number | null, taskType?: string | null) => {
  const params = new URLSearchParams();
  if (projectId) params.set('project_id', String(projectId));
  if (workflowType) params.set('workflow_type', workflowType);
  if (workflowId) params.set('workflow_id', String(workflowId));
  if (taskType) params.set('task_type', taskType);
  return apiFetch<WorkflowGraph>(`/api/v1/routing/graph?${params.toString()}`);
},

// "If a <task_type> task in <from_status> reports <outcome>, then what?"
traceRouting: (params: { projectId?: number | null; workflowType?: string | null; workflowId?: number | null; taskType?: string | null; fromStatus: string; outcome: string }) => {
  const query = new URLSearchParams();
  if (params.projectId) query.set('project_id', String(params.projectId));
  if (params.workflowType) query.set('workflow_type', params.workflowType);
  if (params.workflowId) query.set('workflow_id', String(params.workflowId));
  if (params.taskType) query.set('task_type', params.taskType);
  query.set('from_status', params.fromStatus);
  query.set('outcome', params.outcome);
  return apiFetch<HypotheticalTrace>(`/api/v1/routing/trace?${query.toString()}`);
},

// Apply a set of changes in a transaction that never commits, and report what they would
// write plus the lint findings they introduce or clear. One gesture is one preview.
previewRoutingChange: (params: {
  projectId?: number | null;
  workflowType?: string | null;
  workflowId?: number | null;
  operations: RoutingPreviewOperation[];
}) =>
  apiFetch<RoutingPreview>(`/api/v1/routing/preview`, {
    method: 'POST',
    body: JSON.stringify({
      project_id: params.projectId ?? undefined,
      workflow_type: params.workflowType ?? undefined,
      workflow_id: params.workflowId ?? undefined,
      operations: params.operations,
    }),
  }),

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
getRoutingStatuses: (workflowId?: number) => {
  const qs = workflowId ? `?workflow_id=${workflowId}` : '';
  return apiFetch<{ statuses: TaskStatusMeta[] }>(`/api/v1/routing/statuses${qs}`);
},
createRoutingStatus: (data: Partial<TaskStatusMeta> & { name: string; label: string; workflow_id?: number }) =>
  apiFetch<TaskStatusMeta>(`/api/v1/routing/statuses`, { method: 'POST', body: JSON.stringify(data) }),
updateRoutingStatus: (name: string, data: Partial<TaskStatusMeta> & { workflow_id?: number }) =>
  apiFetch<TaskStatusMeta>(`/api/v1/routing/statuses/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteRoutingStatus: (name: string, workflowId?: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/routing/statuses/${encodeURIComponent(name)}${workflowId ? `?workflow_id=${workflowId}` : ''}`, { method: 'DELETE' }),
getRoutingTransitions: (projectId?: number, workflowId?: number, workflowType?: string) => {
  const params = new URLSearchParams();
  if (projectId) params.set('project_id', String(projectId));
  if (workflowId) params.set('workflow_id', String(workflowId));
  if (workflowType) params.set('workflow_type', workflowType);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<{ transitions: RoutingTransition[]; scope?: RoutingScopeInfo }>(`/api/v1/routing/transitions${qs}`);
},
createRoutingTransition: (data: Partial<RoutingTransition>) =>
  apiFetch<RoutingTransition>(`/api/v1/routing/transitions`, { method: 'POST', body: JSON.stringify(data) }),
updateRoutingTransition: (id: number, data: Partial<RoutingTransition>) =>
  apiFetch<RoutingTransition>(`/api/v1/routing/transitions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteRoutingTransition: (id: number, workflowId?: number, projectId?: number, workflowType?: string) => {
  const params = new URLSearchParams();
  if (workflowId) params.set('workflow_id', String(workflowId));
  if (projectId) params.set('project_id', String(projectId));
  if (workflowType) params.set('workflow_type', workflowType);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<{ ok: boolean }>(`/api/v1/routing/transitions/${id}${qs}`, { method: 'DELETE' });
},
getRoutingRules: (projectId?: number, workflowId?: number, workflowType?: string) => {
  const params = new URLSearchParams();
  if (projectId) params.set('project_id', String(projectId));
  if (workflowId) params.set('workflow_id', String(workflowId));
  if (workflowType) params.set('workflow_type', workflowType);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<{ rules: TaskRoutingRule[]; scope?: RoutingScopeInfo }>(`/api/v1/routing/rules${qs}`);
},
createRoutingRule: (data: Partial<TaskRoutingRule>) =>
  apiFetch<TaskRoutingRule>(`/api/v1/routing/rules`, { method: 'POST', body: JSON.stringify(data) }),
updateRoutingRule: (id: number, data: Partial<TaskRoutingRule>) =>
  apiFetch<TaskRoutingRule>(`/api/v1/routing/rules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteRoutingRule: (id: number, workflowId?: number, projectId?: number) => {
  const params = new URLSearchParams();
  if (workflowId) params.set('workflow_id', String(workflowId));
  if (projectId) params.set('project_id', String(projectId));
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<{ ok: boolean }>(`/api/v1/routing/rules/${id}${qs}`, { method: 'DELETE' });
},
// Transition requirements (task #612)
getTransitionRequirements: (taskType?: string, outcome?: string, workflowId?: number, projectId?: number, workflowType?: string) => {
  const params = new URLSearchParams();
  if (taskType) params.set('task_type', taskType);
  if (outcome) params.set('outcome', outcome);
  if (workflowId) params.set('workflow_id', String(workflowId));
  if (projectId) params.set('project_id', String(projectId));
  if (workflowType) params.set('workflow_type', workflowType);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<{ transition_requirements: TransitionRequirement[]; scope?: RoutingScopeInfo }>(`/api/v1/routing/transition-requirements${qs}`);
},
getTransitionRequirementFields: (workflowId?: number, taskType?: string, workflowType?: string) => {
  const params = new URLSearchParams();
  if (workflowId) params.set('workflow_id', String(workflowId));
  if (workflowType) params.set('workflow_type', workflowType);
  if (taskType) params.set('task_type', taskType);
  return apiFetch<TransitionRequirementFieldsResponse>(`/api/v1/routing/transition-requirement-fields?${params.toString()}`);
},
createTransitionRequirement: (data: Partial<TransitionRequirement>) =>
  apiFetch<TransitionRequirement>(`/api/v1/routing/transition-requirements`, { method: 'POST', body: JSON.stringify(data) }),
updateTransitionRequirement: (id: number, data: Partial<TransitionRequirement>) =>
  apiFetch<TransitionRequirement>(`/api/v1/routing/transition-requirements/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteTransitionRequirement: (id: number, workflowId?: number, projectId?: number, workflowType?: string) => {
  const params = new URLSearchParams();
  if (workflowId) params.set('workflow_id', String(workflowId));
  if (projectId) params.set('project_id', String(projectId));
  if (workflowType) params.set('workflow_type', workflowType);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<{ ok: boolean }>(`/api/v1/routing/transition-requirements/${id}${qs}`, { method: 'DELETE' });
},

getWorkflowEventMappings: (projectId?: number, workflowId?: number, workflowType?: string) => {
  const params = new URLSearchParams();
  if (projectId) params.set('project_id', String(projectId));
  if (workflowId) params.set('workflow_id', String(workflowId));
  if (workflowType) params.set('workflow_type', workflowType);
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
