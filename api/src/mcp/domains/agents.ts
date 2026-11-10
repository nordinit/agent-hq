import { z } from 'zod';
import { McpDomainContext } from '../registrar';

export function registerAgentsTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;
  const taskTypeSchema = z.string().min(1);

  registerTool(
    ['agent_hq_analyze_agent_capabilities'],
    'Explain an agent’s effective tools, MCP servers, skills and permission policy, including team inheritance, overrides, opt-outs and context findings. Configuration describes grants, not proof that a runtime can execute them. Optionally select a workflow in the agent’s project for team context resolution.',
    { agent_id: z.number().int().positive(), workflow_id: z.number().int().positive().optional() },
    ({ agent_id, workflow_id }) => wrap(() => api.getAgentResolution(agent_id, workflow_id))(),
    { domain: 'agents', rest_paths: ['/api/v1/agents/:id/resolution'] },
  );


  registerTool(
    ['agent_hq_list_agents'],
    'List registered agents in Agent HQ. Optionally filter by project.',
    { project_id: z.number().int().positive().optional().describe('Filter by project ID') },
    ({ project_id }) => wrap(() => api.listAgents(project_id ? { project_id } : undefined))(),
    { domain: 'agents', rest_paths: ['/api/v1/agents'] },
  );
  
  registerTool(
    ['agent_hq_get_agent'],
    'Get a single agent by ID.',
    { agent_id: z.number().int().positive().describe('Agent ID') },
    ({ agent_id }) => wrap(() => api.getAgent(agent_id))(),
    { domain: 'agents', rest_paths: ['/api/v1/agents/:id'] },
  );
  
  registerTool(
    ['agent_hq_create_agent'],
    'Create a new agent. Repository settings are workflow-owned and must be configured on workflows, not agents.',
    {
      name: z.string().min(1).describe('Agent name'),
      role: z.string().optional().describe('Role label'),
      session_key: z.string().optional().describe('Session key for openclaw agents'),
      workspace_path: z.string().optional().describe('Workspace path'),
      status: z.string().optional().describe('Initial status'),
      provision_openclaw: z.boolean().optional().describe('Provision an OpenClaw-native agent'),
      runtime_type: z.string().optional().describe('Runtime type'),
      runtime_config: z.unknown().optional().describe('Runtime config object'),
      project_id: z.number().int().positive().nullable().optional().describe('Project association'),
      preferred_provider: z.string().nullable().optional().describe('Preferred model provider'),
      model: z.string().nullable().optional().describe('Preferred model'),
      job_instructions: z.string().nullable().optional().describe('Optional instructions prepended to every dispatched job'),
      system_role: z.string().nullable().optional().describe('Reserved built-in system role'),
      hooks_url: z.string().nullable().optional().describe('Optional Remote Gateway URL; accepted as hooks_url for compatibility'),
      hooks_auth_header: z.string().nullable().optional().describe('Optional Remote Gateway Auth Header; accepted as hooks_auth_header for compatibility'),
    },
    (args) => wrap(() => api.createAgent(args))(),
    { domain: 'agents', rest_paths: ['/api/v1/agents'] },
  );
  
  registerTool(
    ['agent_hq_provision_full_agent'],
    'Atomically create and fully provision an OpenClaw agent, including workspace docs, OpenClaw registration, routing, and optional capability assignments. Repository settings are workflow-owned and must be configured on workflows.',
    {
      name: z.string().min(1).describe('Agent name'),
      role: z.string().nullable().optional().describe('Role label'),
      session_key: z.string().optional().describe('Explicit session key override'),
      workspace_path: z.string().optional().describe('Explicit workspace path override'),
      status: z.string().optional().describe('Initial status'),
      runtime_type: z.literal('openclaw').optional().describe('Runtime type, currently openclaw only'),
      runtime_config: z.unknown().nullable().optional().describe('Optional runtime config object'),
      project_id: z.number().int().positive().nullable().optional().describe('Project association'),
      preferred_provider: z.string().nullable().optional().describe('Preferred model provider'),
      model: z.string().nullable().optional().describe('Preferred model'),
      system_role: z.string().nullable().optional().describe('Reserved built-in system role'),
      hooks_url: z.string().nullable().optional().describe('Optional Remote Gateway URL; accepted as hooks_url for compatibility'),
      hooks_auth_header: z.string().nullable().optional().describe('Optional Remote Gateway Auth Header; accepted as hooks_auth_header for compatibility'),
      os_user: z.string().nullable().optional().describe('Dedicated OS user'),
      enabled: z.union([z.number().int(), z.boolean()]).optional().describe('Enabled flag'),
      github_identity_id: z.number().int().positive().nullable().optional().describe('Optional GitHub identity'),
      job_instructions: z.string().optional().describe('Job instructions prepended to each dispatched task'),
      skill_names: z.array(z.string()).optional().describe('Assigned skills'),
      timeout_seconds: z.number().int().positive().nullable().optional().describe('Run timeout in seconds'),
      startup_grace_seconds: z.number().int().positive().nullable().optional().describe('Startup grace override'),
      heartbeat_stale_seconds: z.number().int().positive().nullable().optional().describe('Heartbeat stale override'),
      stall_threshold_min: z.number().int().min(1).optional().describe('Stall threshold in minutes'),
      max_retries: z.number().int().min(0).optional().describe('Max retries'),
      sort_rules: z.array(z.string()).optional().describe('Routing sort rules'),
      openclaw_agent_id: z.string().optional().describe('Explicit OpenClaw runtime slug'),
      routing_rules: z.array(z.object({
        task_type: taskTypeSchema.nullable().describe('Task type, or null for all task types'),
        status: z.string().min(1).describe('Route status'),
        priority: z.number().int().optional().describe('Rule priority'),
      })).optional().describe('Task routing rules to create'),
      tool_ids: z.array(z.number().int().positive()).optional().describe('Tool IDs to assign'),
      mcp_server_ids: z.array(z.number().int().positive()).optional().describe('MCP server IDs to assign'),
      restart_gateway: z.boolean().optional().describe('Restart the OpenClaw gateway after registration'),
    },
    (args) => wrap(() => api.provisionFullAgent(args))(),
    { domain: 'agents', rest_paths: ['/api/v1/agents/provision-full'] },
  );
  
  registerTool(
    ['agent_hq_update_agent'],
    'Update an agent. Repository settings are workflow-owned, and repo_path/repo_url/repo_access_mode patches are rejected by the Agent HQ API.',
    {
      agent_id: z.number().int().positive().describe('Agent ID'),
      patch: z.object({name:z.string().min(1).optional(),role:z.string().optional(),model:z.string().nullable().optional(),project_id:z.number().int().positive().nullable().optional(),enabled:z.boolean().optional(),status:z.string().optional(),job_instructions:z.string().nullable().optional(),runtime_type:z.string().optional(),runtime_config:z.record(z.string(),z.unknown()).nullable().optional(),workspace_path:z.string().optional(),hooks_url:z.string().nullable().optional(),hooks_auth_header:z.string().nullable().optional(),os_user:z.string().nullable().optional(),github_identity_id:z.number().int().nullable().optional(),provider_connection_id:z.number().int().nullable().optional(),preferred_provider:z.string().nullable().optional(),timeout_seconds:z.number().int().positive().nullable().optional(),startup_grace_seconds:z.number().int().positive().nullable().optional(),heartbeat_stale_seconds:z.number().int().positive().nullable().optional(),skill_names:z.array(z.string()).optional()}).strict().describe('Partial update payload'),
    },
    ({ agent_id, patch }) => wrap(() => api.updateAgent(agent_id, patch))(),
    { domain: 'agents', rest_paths: ['/api/v1/agents/:id'] },
  );
  
  registerTool(
    ['agent_hq_delete_agent'],
    'Delete an agent by ID.',
    { agent_id: z.number().int().positive().describe('Agent ID') },
    ({ agent_id }) => wrap(() => api.deleteAgent(agent_id))(),
    { domain: 'agents', rest_paths: ['/api/v1/agents/:id'] },
  );

  registerTool(
    ['agent_hq_get_agent_mcp_capability_policy'],
    'Read the effective MCP capability policy snapshot for an agent. Scoped MCP keys require MCP capability policy read access and can only read agents in their assigned project.',
    { agent_id: z.number().int().positive().describe('Agent ID') },
    ({ agent_id }) => wrap(() => api.getAgentMcpCapabilityPolicy(agent_id))(),
    { domain: 'agents', rest_paths: ['/api/v1/agents/:id/mcp-permissions'] },
  );

  registerTool(
    ['agent_hq_create_agent_mcp_capability_policy'],
    'Create an explicit MCP capability policy for another agent in the caller agent\'s assigned project. Requires permissions.manage. The caller cannot edit itself, exceed its tenant/project delegation scope, or grant capabilities it does not hold.',
    {
      agent_id: z.number().int().positive().describe('Agent ID'),
      enabled_capabilities: z.array(z.string().min(1)).describe('Capability keys to enable in the explicit policy'),
      expected_revision:z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Revision returned by the policy read. Supply it to reject stale concurrent edits.'),
    },
    ({ agent_id, enabled_capabilities,expected_revision }) => wrap(() => api.createAgentMcpCapabilityPolicy(agent_id, enabled_capabilities,expected_revision))(),
    { domain: 'agents', rest_paths: ['/api/v1/agents/:id/mcp-permissions'] },
  );

  registerTool(
    ['agent_hq_update_agent_mcp_capability_policy'],
    'Replace an explicit MCP capability policy for another agent in the caller agent\'s assigned project. Requires permissions.manage. The caller cannot edit itself, exceed its tenant/project delegation scope, or grant capabilities it does not hold.',
    {
      agent_id: z.number().int().positive().describe('Agent ID'),
      enabled_capabilities: z.array(z.string().min(1)).describe('Capability keys to enable in the explicit policy'),
      expected_revision:z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Revision returned by the policy read. Supply it to reject stale concurrent edits.'),
    },
    ({ agent_id, enabled_capabilities,expected_revision }) => wrap(() => api.updateAgentMcpCapabilityPolicy(agent_id, enabled_capabilities,expected_revision))(),
    { domain: 'agents', rest_paths: ['/api/v1/agents/:id/mcp-permissions'] },
  );

  registerTool(
    ['agent_hq_delete_agent_mcp_capability_policy'],
    'Compatibility operation: restoring implicit defaults requires an operator credential. MCP identities must replace an explicit policy instead; they cannot reset policies to role defaults.',
    { agent_id: z.number().int().positive().describe('Agent ID') },
    ({ agent_id }) => wrap(() => api.deleteAgentMcpCapabilityPolicy(agent_id))(),
    { domain: 'agents', rest_paths: ['/api/v1/agents/:id/mcp-permissions'] },
  );
  
  registerTool(
    ['agent_hq_get_agent_docs'],
    'Read the docs bundle for an agent workspace.',
    { agent_id: z.number().int().positive().describe('Agent ID') },
    ({ agent_id }) => wrap(() => api.getAgentDocs(agent_id))(),
    { domain: 'agents', rest_paths: ['/api/v1/agents/:id/docs'] },
  );
  
  registerTool(
    ['agent_hq_sync_agent_mcp'],
    'Force re-materialization of the effective OpenClaw MCP config for an agent workspace.',
    {
      agent_id: z.number().int().positive().describe('Agent ID'),
      working_directory: z.string().optional().describe('Fallback workspace directory when the agent has no workspace_path'),
    },
    ({ agent_id, working_directory }) => wrap(() => api.syncAgentMcp(agent_id, working_directory))(),
    { domain: 'agents', rest_paths: ['/api/v1/agents/:id/mcp/sync'] },
  );
}
