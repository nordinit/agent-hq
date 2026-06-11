import { apiFetch, getApiBase } from './http';
import { buildChatSessionsPath } from '../apiQuery';
import type { CanonicalMessage, CanonicalSession, ChatConfig, ChatMessage, ChatSession } from './types';

export const chatClient = {
// Chat
getChatConfig: () =>
  apiFetch<ChatConfig>('/api/v1/chat/config'),
getChatSessions: (agentIdOrParams?: number | { agentId?: number; instanceId?: number; projectId?: number | null; offset?: number }, limit = 50) =>
  apiFetch<ChatSession[]>(buildChatSessionsPath(agentIdOrParams, limit)),
getChatSessionMessages: (instanceId: number | null, sessionKey: string, limit = 200) => {
  const id = instanceId === null ? '0' : String(instanceId);
  const params = new URLSearchParams({ limit: String(limit) });
  if (instanceId === null) params.set('session_key', sessionKey);
  return apiFetch<ChatMessage[]>(`/api/v1/chat/sessions/${id}/messages?${params.toString()}`);
},
// Canonical Sessions
getSessions: (params?: { agent_id?: number; instance_id?: number; task_id?: number; project_id?: number; runtime?: string; status?: string; limit?: number; offset?: number }) => {
  const qs = new URLSearchParams();
  if (params?.agent_id) qs.set('agent_id', String(params.agent_id));
  if (params?.instance_id) qs.set('instance_id', String(params.instance_id));
  if (params?.task_id) qs.set('task_id', String(params.task_id));
  if (params?.project_id) qs.set('project_id', String(params.project_id));
  if (params?.runtime) qs.set('runtime', params.runtime);
  if (params?.status) qs.set('status', params.status);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const query = qs.toString();
  return apiFetch<CanonicalSession[]>(`/api/v1/sessions${query ? `?${query}` : ''}`);
},
getSession: (id: number) =>
  apiFetch<CanonicalSession>(`/api/v1/sessions/${id}`),
getSessionByKey: (externalKey: string) =>
  apiFetch<CanonicalSession>(`/api/v1/sessions/by-key/${encodeURIComponent(externalKey)}`),
getSessionMessages: (sessionId: number, params?: { limit?: number; offset?: number; event_type?: string }) => {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.event_type) qs.set('event_type', params.event_type);
  const query = qs.toString();
  return apiFetch<CanonicalMessage[]>(`/api/v1/sessions/${sessionId}/messages${query ? `?${query}` : ''}`);
},
/** Ensure a canonical session exists for an instance (creates/updates it via adapter). */
ensureSessionForInstance: (instanceId: number) =>
  apiFetch<CanonicalSession>(`/api/v1/sessions/import/instance/${instanceId}`, { method: 'POST' }),
/** Force re-ingest a session by external key (e.g. after a run completes). */
ingestSession: (params: { external_key: string; instance_id?: number; agent_id?: number; task_id?: number; runtime?: string }) =>
  apiFetch<CanonicalSession>('/api/v1/sessions/ingest', { method: 'POST', body: JSON.stringify(params) }),
// ─── Chat attachments (task #658) ─────────────────────────────────────────
uploadChatAttachment: async (file: File, agentId?: number): Promise<{ id: number; url: string; filename: string; mime_type: string; size: number }> => {
  const formData = new FormData();
  formData.append('file', file);
  if (agentId != null) formData.append('agent_id', String(agentId));
  formData.append('uploaded_by', 'user');
  const res = await fetch(`${getApiBase()}/api/v1/chat/attachments`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `Upload failed (${res.status})` }));
    throw new Error((err as Record<string, unknown>).error as string ?? `Upload failed (${res.status})`);
  }
  const data = await res.json() as { ok: boolean; attachment: { id: number; url: string; filename: string; mime_type: string; size: number } };
  return data.attachment;
},
};
