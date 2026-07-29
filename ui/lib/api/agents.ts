import { apiFetch } from './http';
import type { Agent, AgentDoc, AgentMcpAssignment, AgentMcpPermissionPolicy, AgentMcpToolAllowlistPolicy, AgentToolAssignment, ClaudeMdResult, DeleteAgentResponse, GatewayConfig, GatewayRestartResponse, GatewayRuntimeHint, GatewayStatus, GatewayPairResponse, McpCatalog, McpServer, ProvisionResult, ProvisionStatus, RuntimeConfigResponse, SetupStatus, SkillDetail, SkillEntry, StarterPlanApplyResponse, StarterPlanInput, StarterPlanPreviewResponse, StarterTemplateCatalogResponse, Tool } from './types';

export const agentsClient = {
// Agents
getAgents: (projectId?: number | null) => apiFetch<Agent[]>(projectId ? `/api/v1/agents?project_id=${projectId}` : '/api/v1/agents'),
getSetupStatus: () => apiFetch<SetupStatus>('/api/v1/setup/status'),
completeOnboarding: () =>
  apiFetch<{ ok: boolean; onboarding_completed: boolean; onboarding_provider_gate_passed: boolean }>('/api/v1/setup/onboarding/complete', { method: 'POST' }),
skipOnboarding: () =>
  apiFetch<{ ok: boolean; onboarding_completed: boolean; atlas_created: boolean }>('/api/v1/setup/onboarding/skip', { method: 'POST' }),
getStarterTemplates: () => apiFetch<StarterTemplateCatalogResponse>('/api/v1/setup/templates'),
previewStarterPlan: (data: StarterPlanInput) =>
  apiFetch<StarterPlanPreviewResponse>('/api/v1/setup/starter-plan/preview', { method: 'POST', body: JSON.stringify(data) }),
applyStarterPlan: (data: StarterPlanInput) =>
  apiFetch<StarterPlanApplyResponse>('/api/v1/setup/starter-plan/apply', { method: 'POST', body: JSON.stringify(data) }),
configureRuntime: (data: { kind: 'openclaw' | 'hermes' | 'custom'; endpoint: string; auth_token?: string | null; label?: string | null }) =>
  apiFetch<RuntimeConfigResponse>('/api/v1/setup/runtime/config', { method: 'POST', body: JSON.stringify(data) }),
getAgent: (id: number) => apiFetch<Agent>(`/api/v1/agents/${id}`),
createAgent: (data: Partial<Agent> & { provision_openclaw?: boolean }) =>
  apiFetch<Agent>('/api/v1/agents', { method: 'POST', body: JSON.stringify(data) }),
updateAgent: (id: number, data: Partial<Agent>) =>
  apiFetch<Agent>(`/api/v1/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
deleteAgent: (id: number) =>
  apiFetch<DeleteAgentResponse>(`/api/v1/agents/${id}`, { method: 'DELETE' }),
getAgentMcpPermissions: (id: number) =>
  apiFetch<AgentMcpPermissionPolicy>(`/api/v1/agents/${id}/mcp-permissions`),
updateAgentMcpPermissions: (id: number, enabledCapabilities: string[]) =>
  apiFetch<AgentMcpPermissionPolicy>(`/api/v1/agents/${id}/mcp-permissions`, {
    method: 'PUT',
    body: JSON.stringify({ enabled_capabilities: enabledCapabilities }),
  }),
resetAgentMcpPermissions: (id: number) =>
  apiFetch<AgentMcpPermissionPolicy>(`/api/v1/agents/${id}/mcp-permissions`, { method: 'DELETE' }),
getAgentMcpToolAllowlists: (id: number) =>
  apiFetch<AgentMcpToolAllowlistPolicy>(`/api/v1/agents/${id}/mcp-tool-allowlists`),
updateAgentMcpToolAllowlist: (id: number, mcpServerId: number, toolAllowlist: string[]) =>
  apiFetch<AgentMcpToolAllowlistPolicy>(`/api/v1/agents/${id}/mcp-tool-allowlists/${mcpServerId}`, {
    method: 'PUT',
    body: JSON.stringify({ tool_allowlist: toolAllowlist }),
  }),
// Skills
getSkills: () => apiFetch<SkillEntry[]>('/api/v1/skills'),
getSkill: (name: string) => apiFetch<SkillDetail>(`/api/v1/skills/${encodeURIComponent(name)}`),
getSkillFile: (name: string, filePath: string) =>
  apiFetch<{ name: string; file: string; content: string; path: string }>(
    `/api/v1/skills/${encodeURIComponent(name)}/file/${filePath}`
  ),
updateSkill: (name: string, content: string) =>
  apiFetch<{ ok: boolean }>(`/api/v1/skills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  }),
deleteSkill: (name: string) =>
  apiFetch<{ ok: boolean }>(`/api/v1/skills/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  }),
createSkill: (name: string, content?: string) =>
  apiFetch<{ ok: boolean }>('/api/v1/skills', {
    method: 'POST',
    body: JSON.stringify({ name, content }),
  }),
// Tools
getTools: (params?: { tag?: string; enabled?: 0 | 1 }) => {
  const qs = new URLSearchParams();
  if (params?.tag) qs.set('tag', params.tag);
  if (params?.enabled !== undefined) qs.set('enabled', String(params.enabled));
  const query = qs.toString();
  return apiFetch<Tool[]>(`/api/v1/tools${query ? `?${query}` : ''}`);
},
getTool: (id: number) => apiFetch<Tool>(`/api/v1/tools/${id}`),
createTool: (data: Partial<Tool>) =>
  apiFetch<Tool>('/api/v1/tools', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
updateTool: (id: number, data: Partial<Tool>) =>
  apiFetch<Tool>(`/api/v1/tools/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
deleteTool: (id: number) =>
  apiFetch<{ ok: boolean; id: number }>(`/api/v1/tools/${id}`, { method: 'DELETE' }),
testTool: (id: number, input: Record<string, unknown>) =>
  apiFetch<{ output: string | null; duration_ms: number; error?: string }>(`/api/v1/tools/${id}/test`, {
    method: 'POST',
    body: JSON.stringify({ input }),
  }),
// Agent tool assignments
getAgentTools: (agentId: number) =>
  apiFetch<AgentToolAssignment[]>(`/api/v1/agents/${agentId}/tools`),
assignToolToAgent: (agentId: number, toolId: number) =>
  apiFetch<AgentToolAssignment>(`/api/v1/agents/${agentId}/tools`, {
    method: 'POST',
    body: JSON.stringify({ tool_id: toolId }),
  }),
removeToolFromAgent: (agentId: number, toolId: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/agents/${agentId}/tools/${toolId}`, { method: 'DELETE' }),
/** @alias assignToolToAgent — used by capabilities tool detail page */
assignAgentTool: (agentId: number, toolId: number) =>
  apiFetch<AgentToolAssignment>(`/api/v1/agents/${agentId}/tools`, {
    method: 'POST',
    body: JSON.stringify({ tool_id: toolId }),
  }),
/** @alias removeToolFromAgent — expects toolId, matching the API delete contract */
unassignAgentTool: (agentId: number, toolId: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/agents/${agentId}/tools/${toolId}`, { method: 'DELETE' }),
// MCP servers
getMcpServers: () => apiFetch<McpServer[]>('/api/v1/mcp-servers'),
getMcpCatalog: () => apiFetch<McpCatalog>('/api/v1/mcp/catalog'),
getMcpServer: (id: number) => apiFetch<McpServer>(`/api/v1/mcp-servers/${id}`),
createMcpServer: (data: Partial<McpServer>) =>
  apiFetch<McpServer>('/api/v1/mcp-servers', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
updateMcpServer: (id: number, data: Partial<McpServer>) =>
  apiFetch<McpServer>(`/api/v1/mcp-servers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
deleteMcpServer: (id: number) =>
  apiFetch<{ ok: boolean; id: number }>(`/api/v1/mcp-servers/${id}`, { method: 'DELETE' }),
getAgentMcpServers: (agentId: number) =>
  apiFetch<AgentMcpAssignment[]>(`/api/v1/agents/${agentId}/mcp-servers`),
assignMcpServerToAgent: (agentId: number, mcpServerId: number) =>
  apiFetch<AgentMcpAssignment>(`/api/v1/agents/${agentId}/mcp-servers`, {
    method: 'POST',
    body: JSON.stringify({ mcp_server_id: mcpServerId }),
  }),
removeMcpServerFromAgent: (agentId: number, mcpServerId: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/agents/${agentId}/mcp-servers/${mcpServerId}`, { method: 'DELETE' }),
// Agent skill assignments (backed by PATCH /agents/:id with skill_names array)
assignSkillToAgent: (agentId: number, currentSkills: string[], skillName: string) =>
  apiFetch<Agent>(`/api/v1/agents/${agentId}`, {
    method: 'PUT',
    body: JSON.stringify({ skill_names: [...currentSkills, skillName] }),
  }),
removeSkillFromAgent: (agentId: number, currentSkills: string[], skillName: string) =>
  apiFetch<Agent>(`/api/v1/agents/${agentId}`, {
    method: 'PUT',
    body: JSON.stringify({ skill_names: currentSkills.filter(s => s !== skillName) }),
  }),
// Agent Docs
getAgentDocs: (id: number) => apiFetch<AgentDoc[]>(`/api/v1/agents/${id}/docs`),
// CLAUDE.md (claude-code runtime agents)
getClaudeMd: (id: number) =>
  apiFetch<{ content: string; lastModified: string; path: string }>(`/api/v1/agents/${id}/claude-md`)
    .then(r => ({ exists: true, content: r.content, path: r.path, last_modified: r.lastModified } as ClaudeMdResult)),
updateClaudeMd: (id: number, content: string) =>
  apiFetch<{ content: string; lastModified: string; path: string }>(`/api/v1/agents/${id}/claude-md`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  }).then(r => ({ exists: true, content: r.content, path: r.path, last_modified: r.lastModified } as ClaudeMdResult)),
regenClaudeMd: (id: number) =>
  apiFetch<{ content: string; lastModified: string; path: string }>(`/api/v1/agents/${id}/claude-md/regen`, { method: 'POST' })
    .then(r => ({ exists: true, content: r.content, path: r.path, last_modified: r.lastModified } as ClaudeMdResult)),
// Agent Provisioning
provisionAgent: (id: number, data?: { restart_gateway?: boolean }) =>
  apiFetch<ProvisionResult>(`/api/v1/agents/${id}/provision`, { method: 'POST', body: JSON.stringify(data ?? {}) }),
getProvisionStatus: (id: number) =>
  apiFetch<ProvisionStatus>(`/api/v1/agents/${id}/provision-status`),
getGatewayConfig: () =>
  apiFetch<GatewayConfig>('/api/v1/settings/gateway/config'),
updateGatewayConfig: (data: { ws_url: string; runtime_hint: GatewayRuntimeHint; auth_token?: string | null }) =>
  apiFetch<GatewayConfig>('/api/v1/settings/gateway/config', { method: 'PUT', body: JSON.stringify(data) }),
getGatewayStatus: () =>
  apiFetch<GatewayStatus>('/api/v1/settings/gateway/status'),
pairGateway: () =>
  apiFetch<GatewayPairResponse>('/api/v1/settings/gateway/pair', { method: 'POST' }),
restartGateway: () =>
  apiFetch<GatewayRestartResponse>('/api/v1/settings/gateway/restart', { method: 'POST' }),
};
