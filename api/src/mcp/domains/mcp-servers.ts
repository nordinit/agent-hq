import { z } from 'zod';
import { McpDomainContext } from '../registrar';

export function registerMcpServersTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;

  registerTool(
    ['agent_hq_list_mcp_servers'],
    'List MCP servers in the Agent HQ registry.',
    {},
    () => wrap(() => api.listMcpServers())(),
    { domain: 'mcp_servers', rest_paths: ['/api/v1/mcp-servers'] },
  );
  
  registerTool(
    ['agent_hq_get_mcp_server'],
    'Get an MCP server by ID.',
    { mcp_server_id: z.number().int().positive().describe('MCP server ID') },
    ({ mcp_server_id }) => wrap(() => api.getMcpServer(mcp_server_id))(),
    { domain: 'mcp_servers', rest_paths: ['/api/v1/mcp-servers/:id'] },
  );
  
  registerTool(
    ['agent_hq_create_mcp_server'],
    'Create an MCP server entry.',
    {
      name: z.string().min(1).describe('Display name'),
      slug: z.string().min(1).describe('Unique slug'),
      description: z.string().optional().describe('Description'),
      transport: z.string().optional().describe('Transport, currently stdio'),
      command: z.string().min(1).describe('Executable path'),
      args: z.array(z.string()).optional().describe('Command args'),
      env: z.record(z.string(), z.string()).optional().describe('Environment variables'),
      cwd: z.string().optional().describe('Working directory'),
      enabled: z.boolean().optional().describe('Enabled flag'),
    },
    (args) => wrap(() => api.createMcpServer(args))(),
    { domain: 'mcp_servers', rest_paths: ['/api/v1/mcp-servers'] },
  );
  
  registerTool(
    ['agent_hq_update_mcp_server'],
    'Update an MCP server entry.',
    {
      mcp_server_id: z.number().int().positive().describe('MCP server ID'),
      patch: z.record(z.string(), z.unknown()).describe('Partial update payload'),
    },
    ({ mcp_server_id, patch }) => wrap(() => api.updateMcpServer(mcp_server_id, patch))(),
    { domain: 'mcp_servers', rest_paths: ['/api/v1/mcp-servers/:id'] },
  );
  
  registerTool(
    ['agent_hq_delete_mcp_server'],
    'Disable an MCP server entry.',
    { mcp_server_id: z.number().int().positive().describe('MCP server ID') },
    ({ mcp_server_id }) => wrap(() => api.deleteMcpServer(mcp_server_id))(),
    { domain: 'mcp_servers', rest_paths: ['/api/v1/mcp-servers/:id'] },
  );
  
  registerTool(
    ['agent_hq_list_agent_mcp_servers'],
    'List MCP servers assigned to an agent.',
    { agent_id: z.number().int().positive().describe('Agent ID') },
    ({ agent_id }) => wrap(() => api.listAgentMcpServers(agent_id))(),
    { domain: 'mcp_servers', rest_paths: ['/api/v1/agents/:id/mcp-servers'] },
  );
  
  registerTool(
    ['agent_hq_assign_mcp_server_to_agent'],
    'Assign an MCP server to an agent.',
    {
      agent_id: z.number().int().positive().describe('Agent ID'),
      mcp_server_id: z.number().int().positive().describe('MCP server ID'),
      overrides: z.record(z.string(), z.unknown()).optional().describe('Assignment overrides'),
      enabled: z.boolean().optional().describe('Assignment enabled flag'),
    },
    ({ agent_id, mcp_server_id, overrides, enabled }) =>
      wrap(() => api.assignMcpServerToAgent(agent_id, mcp_server_id, overrides, enabled))(),
    { domain: 'mcp_servers', rest_paths: ['/api/v1/agents/:id/mcp-servers'] },
  );
  
  registerTool(
    ['agent_hq_remove_mcp_server_from_agent'],
    'Remove an MCP server assignment from an agent.',
    {
      agent_id: z.number().int().positive().describe('Agent ID'),
      mcp_server_id: z.number().int().positive().describe('MCP server ID'),
    },
    ({ agent_id, mcp_server_id }) => wrap(() => api.removeMcpServerFromAgent(agent_id, mcp_server_id))(),
    { domain: 'mcp_servers', rest_paths: ['/api/v1/agents/:id/mcp-servers/:mcpServerId'] },
  );
}
