import { apiFetch } from './http';
import { buildChatSessionsPath, buildInstancesPath } from '../apiQuery';
import type { JobInstance, RunActivity } from './types';

export const runsClient = {
// Task Instances
getTaskInstances: (taskId: number) => apiFetch<JobInstance[]>(`/api/v1/tasks/${taskId}/instances`),
// Instances (Kanban)
getInstances: (params?: { agentId?: number; projectId?: number | null; limit?: number; offset?: number }) =>
  apiFetch<JobInstance[]>(buildInstancesPath(params)),
stopInstance: (id: number, behavior: 'stop' | 'park' | 'requeue' = 'park') =>
  apiFetch<{
    ok: boolean;
    cronRemoved?: boolean;
    cronRemoveError?: string | null;
    behavior: 'stop' | 'park' | 'requeue';
    result?: 'confirmed_stopped' | 'already_gone' | 'stopped_runtime_uncertain' | 'already_finished';
    message?: string;
    runtimeUncertain?: boolean;
    abortAttempted?: boolean;
    abortOk?: boolean | null;
    abortStatus?: 'succeeded' | 'already_gone' | 'timed_out' | 'failed' | null;
    abortError?: string | null;
    taskId?: number | null;
    taskStatusBefore?: string | null;
    taskStatusAfter?: string | null;
    clearedTaskLinkage?: boolean;
  }>(`/api/v1/instances/${id}/stop`, {
    method: 'PUT',
    body: JSON.stringify({ behavior }),
  }),
resolveSessionKey: (id: number) =>
  apiFetch<{ sessionKey: string | null; source: string; agentId?: number | null }>(`/api/v1/instances/${id}/session-key`),
getAgentInstances: (agentId: number, params?: { projectId?: number | null; limit?: number; offset?: number }) =>
  apiFetch<JobInstance[]>(buildInstancesPath({
    agentId,
    projectId: params?.projectId,
    limit: params?.limit,
    offset: params?.offset,
  })),
getCanonicalChatSession: (agentId: number, channel = 'web') =>
  apiFetch<{ sessionKey: string | null; channel: string; agentId: number }>(`/api/v1/chat/canonical-session/${agentId}?channel=${encodeURIComponent(channel)}`),
// Whether a turn is open on this run and what it is doing. Polled on a short
// interval while a run is live to drive the chat typing indicator.
getInstanceActivity: (id: number) =>
  apiFetch<RunActivity>(`/api/v1/instances/${id}/activity`),
};
