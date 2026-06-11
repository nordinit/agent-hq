export function buildQuery(params: Record<string, number | string | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `?${query}` : '';
}

export function buildInstancesPath(params?: { agentId?: number; projectId?: number | null; limit?: number; offset?: number }): string {
  return `/api/v1/instances${buildQuery({
    agent_id: params?.agentId,
    project_id: params?.projectId,
    limit: params?.limit,
    offset: params?.offset,
  })}`;
}

export function buildChatSessionsPath(
  agentIdOrParams?: number | { agentId?: number; instanceId?: number; projectId?: number | null; offset?: number },
  limit = 50,
): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (typeof agentIdOrParams === 'number') {
    params.set('agent_id', String(agentIdOrParams));
  } else if (agentIdOrParams) {
    if (agentIdOrParams.agentId) params.set('agent_id', String(agentIdOrParams.agentId));
    if (agentIdOrParams.instanceId) params.set('instance_id', String(agentIdOrParams.instanceId));
    if (agentIdOrParams.projectId) params.set('project_id', String(agentIdOrParams.projectId));
    if (agentIdOrParams.offset) params.set('offset', String(agentIdOrParams.offset));
  }
  return `/api/v1/chat/sessions?${params.toString()}`;
}
