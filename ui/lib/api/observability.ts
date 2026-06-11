import { apiFetch } from './http';
import type { CompletedRecentResponse, DashboardStats, LogEntry, LogParams } from './types';

export const observabilityClient = {
// Logs
getLogs: (params?: LogParams) => {
  const qs = new URLSearchParams();
  if (params?.agent_id) qs.set('agent_id', String(params.agent_id));
  if (params?.level) qs.set('level', params.level);
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.instance_id) qs.set('instance_id', String(params.instance_id));
  const query = qs.toString();
  return apiFetch<LogEntry[]>(`/api/v1/logs${query ? `?${query}` : ''}`);
},
// Stats
getStats: (projectId?: number | null) => {
  const qs = new URLSearchParams();
  if (projectId) qs.set('project_id', String(projectId));
  const query = qs.toString();
  return apiFetch<DashboardStats>(`/api/v1/stats${query ? `?${query}` : ''}`);
},
getCompletedRecent: (hours = 24, projectId?: number | null) => {
  const qs = new URLSearchParams({ hours: String(hours) });
  if (projectId) qs.set('project_id', String(projectId));
  return apiFetch<CompletedRecentResponse>(`/api/v1/tasks/completed-recent?${qs.toString()}`);
},
};
