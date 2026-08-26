import { z } from 'zod';
import { McpDomainContext } from '../registrar';

export function registerToolRegistryTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;

  registerTool(
    ['agent_hq_list_tools'],
    'List all Agent HQ tools in the registry.',
    {},
    () => wrap(() => api.listTools())(),
    { domain: 'tools', rest_paths: ['/api/v1/tools'] },
  );
  
  registerTool(
    ['agent_hq_get_tool'],
    'Get a tool definition by ID.',
    { tool_id: z.number().int().positive().describe('Tool ID') },
    ({ tool_id }) => wrap(() => api.getTool(tool_id))(),
    { domain: 'tools', rest_paths: ['/api/v1/tools/:id'] },
  );
  
  registerTool(
    ['agent_hq_create_tool'],
    'Create a tool in the Agent HQ registry.',
    {
      name: z.string().min(1).describe('Tool name'),
      slug: z.string().min(1).describe('Unique tool slug'),
      description: z.string().optional().describe('Tool description'),
      implementation_type: z.string().min(1).describe('Implementation type'),
      implementation_body: z.string().optional().describe('Implementation body'),
      input_schema: z.unknown().optional().describe('JSON schema object'),
      permissions: z.string().optional().describe('Permission label'),
      tags: z.array(z.string()).optional().describe('Tool tags'),
      enabled: z.boolean().optional().describe('Enabled flag'),
    },
    (args) => wrap(() => api.createTool(args))(),
    { domain: 'tools', rest_paths: ['/api/v1/tools'] },
  );
  
  registerTool(
    ['agent_hq_update_tool'],
    'Update an Agent HQ tool definition.',
    {
      tool_id: z.number().int().positive().describe('Tool ID'),
      patch: z.record(z.string(), z.unknown()).describe('Partial update payload'),
    },
    ({ tool_id, patch }) => wrap(() => api.updateTool(tool_id, patch))(),
    { domain: 'tools', rest_paths: ['/api/v1/tools/:id'] },
  );
  
  registerTool(
    ['agent_hq_delete_tool'],
    'Soft-delete an Agent HQ tool.',
    { tool_id: z.number().int().positive().describe('Tool ID') },
    ({ tool_id }) => wrap(() => api.deleteTool(tool_id))(),
    { domain: 'tools', rest_paths: ['/api/v1/tools/:id'] },
  );
  
  registerTool(
    ['agent_hq_test_tool'],
    'Run a tool test with sample input.',
    {
      tool_id: z.number().int().positive().describe('Tool ID'),
      input: z.record(z.string(), z.unknown()).describe('Sample tool input object'),
    },
    ({ tool_id, input }) => wrap(() => api.testTool(tool_id, input))(),
    { domain: 'tools', rest_paths: ['/api/v1/tools/:id/test'] },
  );
  
  registerTool(
    ['agent_hq_list_agent_tools'],
    'List all tools assigned to an agent.',
    { agent_id: z.number().int().positive().describe('Agent ID') },
    ({ agent_id }) => wrap(() => api.listAgentTools(agent_id))(),
    { domain: 'tools', rest_paths: ['/api/v1/agents/:id/tools'] },
  );
  
  registerTool(
    ['agent_hq_assign_tool_to_agent'],
    'Assign a registry tool to an agent.',
    {
      agent_id: z.number().int().positive().describe('Agent ID'),
      tool_id: z.number().int().positive().describe('Tool ID'),
      overrides: z.record(z.string(), z.unknown()).optional().describe('Assignment overrides'),
      enabled: z.boolean().optional().describe('Assignment enabled flag'),
    },
    ({ agent_id, tool_id, overrides, enabled }) => wrap(() => api.assignToolToAgent(agent_id, tool_id, overrides, enabled))(),
    { domain: 'tools', rest_paths: ['/api/v1/agents/:id/tools'] },
  );
  
  registerTool(
    ['agent_hq_remove_tool_from_agent'],
    'Remove a tool assignment from an agent.',
    {
      agent_id: z.number().int().positive().describe('Agent ID'),
      tool_id: z.number().int().positive().describe('Tool ID'),
    },
    ({ agent_id, tool_id }) => wrap(() => api.removeToolFromAgent(agent_id, tool_id))(),
    { domain: 'tools', rest_paths: ['/api/v1/agents/:id/tools/:toolId'] },
  );
}
