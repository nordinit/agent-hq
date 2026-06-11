import { apiFetch, getApiBase } from './http';
import type { Project, ProjectAuditEntry, ProjectImportPreview, ProjectImportResult, TenantDeleteResponse, TenantListResponse, TenantMutationResponse } from './types';

export const projectsClient = {
// Tenants
getTenants: () => apiFetch<TenantListResponse>('/api/v1/tenants'),
createTenant: (data: { name: string; slug?: string; set_active?: boolean }) =>
  apiFetch<TenantMutationResponse>('/api/v1/tenants', { method: 'POST', body: JSON.stringify(data) }),
selectTenant: (tenantId: number) =>
  apiFetch<TenantMutationResponse>(`/api/v1/tenants/${tenantId}/select`, { method: 'POST' }),
deleteTenant: (tenantId: number, confirmation: string) =>
  apiFetch<TenantDeleteResponse>(`/api/v1/tenants/${tenantId}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmation }),
  }),
// Projects
getProjects: () => apiFetch<Project[]>('/api/v1/projects'),
getProject: (id: number) => apiFetch<Project>(`/api/v1/projects/${id}`),
getDefaultProject: () => apiFetch<{ project: Project | null; default_project_id: number | null }>('/api/v1/projects/default'),
exportProjectManifest: (id: number, includeFiles = false) =>
  fetch(`${getApiBase()}/api/v1/projects/${id}/export?include_files=${includeFiles ? 'true' : 'false'}`)
    .then(async (res) => {
      if (!res.ok) throw new Error(await res.text());
      return res.blob();
    }),
previewProjectImport: (manifest: unknown, options?: { project_name?: string; include_files?: boolean }) =>
  apiFetch<ProjectImportPreview>('/api/v1/projects/import/preview', {
    method: 'POST',
    body: JSON.stringify({ manifest, ...options }),
  }),
importProjectManifest: (manifest: unknown, options?: { project_name?: string; include_files?: boolean; enable_agents?: boolean; activate_workflows?: boolean }) =>
  apiFetch<ProjectImportResult>('/api/v1/projects/import', {
    method: 'POST',
    body: JSON.stringify({ manifest, ...options }),
  }),
createProject: (data: Partial<Project>) =>
  apiFetch<Project>('/api/v1/projects', { method: 'POST', body: JSON.stringify(data) }),
updateProject: (id: number, data: Partial<Project>) =>
  apiFetch<Project>(`/api/v1/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
setDefaultProject: (id: number) =>
  apiFetch<{ ok: boolean; project: Project; default_project_id: number }>(`/api/v1/projects/${id}/default`, { method: 'PUT' }),
deleteProject: (id: number, options?: { force?: boolean; confirm?: boolean }) => {
  const params = new URLSearchParams();
  if (options?.force) params.set('force', 'true');
  if (options?.confirm) params.set('confirm', 'true');
  const query = params.toString();
  return apiFetch<{ ok: boolean }>(`/api/v1/projects/${id}${query ? `?${query}` : ''}`, { method: 'DELETE' });
},
checkProjectCascade: (id: number) =>
  apiFetch<{ active_tasks: number; running_instances: number; dependent_sprints: number; dependent_tasks: number; dependent_agents: number }>(`/api/v1/projects/${id}/cascade-check`),
// Project Audit History
getProjectAudit: (id: number, params?: { entity_type?: string; limit?: number; offset?: number }) => {
  const qs = new URLSearchParams();
  if (params?.entity_type) qs.set('entity_type', params.entity_type);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const query = qs.toString();
  return apiFetch<ProjectAuditEntry[]>(`/api/v1/projects/${id}/audit${query ? `?${query}` : ''}`);
},
};
