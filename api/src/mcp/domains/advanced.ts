import { z } from 'zod';
import { McpDomainContext } from '../registrar';

export function registerAdvancedTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;

  registerTool(
    ['agent_hq_api_request'],
    'Advanced JSON-only Agent HQ REST request tool. Path must start with /api/v1/. Use this only when no typed MCP tool exists yet. Do not use it for routine lifecycle writes now that dedicated lifecycle tools exist.',
    {
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).describe('HTTP method'),
      path: z.string().min(1).describe('Absolute API path starting with /api/v1/'),
      body: z.unknown().optional().describe('Optional JSON body for POST/PUT requests'),
    },
    ({ method, path, body }) => wrap(() => api.apiRequest(method, path, body))(),
    { domain: 'advanced', rest_paths: ['/api/v1/*'] },
  );
}
