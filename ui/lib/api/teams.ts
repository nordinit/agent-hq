import { apiFetch } from './http';
import type {
  AgentEffectiveCapabilities,
  AgentTeamMembership,
  Team,
  TeamContextPreview,
  TeamMcpAssignment,
  TeamMember,
  TeamRoutingPlan,
  TeamRoutingRule,
  TeamToolAssignment,
} from './types';

export const teamsClient = {
  getTeams: () => apiFetch<Team[]>('/api/v1/teams'),
  getTeam: (id: number) => apiFetch<Team>(`/api/v1/teams/${id}`),
  createTeam: (data: Partial<Team>) =>
    apiFetch<Team>('/api/v1/teams', { method: 'POST', body: JSON.stringify(data) }),
  updateTeam: (id: number, data: Partial<Team>) =>
    apiFetch<Team>(`/api/v1/teams/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTeam: (id: number) =>
    apiFetch<{ ok: boolean; id: number }>(`/api/v1/teams/${id}`, { method: 'DELETE' }),

  getTeamMembers: (id: number) => apiFetch<TeamMember[]>(`/api/v1/teams/${id}/members`),
  addTeamMember: (id: number, data: Partial<TeamMember> & { agent_id: number }) =>
    apiFetch<TeamMember>(`/api/v1/teams/${id}/members`, { method: 'POST', body: JSON.stringify(data) }),
  updateTeamMember: (id: number, agentId: number, data: Partial<TeamMember>) =>
    apiFetch<TeamMember>(`/api/v1/teams/${id}/members/${agentId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  removeTeamMember: (id: number, agentId: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/teams/${id}/members/${agentId}`, { method: 'DELETE' }),

  getTeamTools: (id: number) => apiFetch<TeamToolAssignment[]>(`/api/v1/teams/${id}/tools`),
  assignToolToTeam: (id: number, toolId: number) =>
    apiFetch<TeamToolAssignment>(`/api/v1/teams/${id}/tools`, {
      method: 'POST', body: JSON.stringify({ tool_id: toolId }),
    }),
  removeToolFromTeam: (id: number, toolId: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/teams/${id}/tools/${toolId}`, { method: 'DELETE' }),

  getTeamMcpServers: (id: number) => apiFetch<TeamMcpAssignment[]>(`/api/v1/teams/${id}/mcp-servers`),
  assignMcpServerToTeam: (id: number, mcpServerId: number) =>
    apiFetch<TeamMcpAssignment>(`/api/v1/teams/${id}/mcp-servers`, {
      method: 'POST', body: JSON.stringify({ mcp_server_id: mcpServerId }),
    }),
  removeMcpServerFromTeam: (id: number, mcpServerId: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/teams/${id}/mcp-servers/${mcpServerId}`, { method: 'DELETE' }),

  getTeamRoutingRules: (id: number) => apiFetch<TeamRoutingRule[]>(`/api/v1/teams/${id}/routing-rules`),
  createTeamRoutingRule: (id: number, data: Partial<TeamRoutingRule>) =>
    apiFetch<TeamRoutingRule>(`/api/v1/teams/${id}/routing-rules`, { method: 'POST', body: JSON.stringify(data) }),
  deleteTeamRoutingRule: (id: number, ruleId: number) =>
    apiFetch<{ ok: boolean }>(`/api/v1/teams/${id}/routing-rules/${ruleId}`, { method: 'DELETE' }),

  previewTeamContext: (id: number, agentId: number) =>
    apiFetch<TeamContextPreview>(`/api/v1/teams/${id}/context-preview?agent_id=${agentId}`),

  getAgentTeams: (agentId: number) => apiFetch<AgentTeamMembership[]>(`/api/v1/agents/${agentId}/teams`),
  getAgentEffectiveCapabilities: (agentId: number) =>
    apiFetch<AgentEffectiveCapabilities>(`/api/v1/agents/${agentId}/effective-capabilities`),

  setWorkflowTeam: (workflowId: number, teamId: number | null) =>
    apiFetch<{ ok: boolean; workflow_id: number; team_id: number | null }>(
      `/api/v1/workflows/${workflowId}/team`,
      { method: 'PUT', body: JSON.stringify({ team_id: teamId }) },
    ),
  /** dryRun defaults to true so a caller has to opt in to writing routing configuration. */
  applyWorkflowTeamRouting: (workflowId: number, dryRun = true) =>
    apiFetch<TeamRoutingPlan>(
      `/api/v1/workflows/${workflowId}/team/apply-routing${dryRun ? '?dry_run=1' : ''}`,
      { method: 'POST', body: '{}' },
    ),
};
