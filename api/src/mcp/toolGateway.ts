import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/** The same Agent HQ assignment controls discovery and invocation. No CRM policy. */
export function createToolGateway(upstream: Client, allowedTools: string[]): Server {
  const allowed = new Set(allowedTools);
  const capabilities = upstream.getServerCapabilities();
  const server = new Server({ name: 'agent-hq-tool-gateway', version: '1' }, {
    capabilities: { tools: {}, ...(capabilities?.resources ? { resources: {} } : {}) },
  });
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await upstream.listTools(request.params);
    return { ...result, tools: result.tools.filter(tool => allowed.has(tool.name)) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!allowed.has(request.params.name)) {
      return { isError: true, content: [{ type: 'text', text: 'Tool is not granted by this Agent HQ MCP assignment' }] };
    }
    return upstream.callTool(request.params);
  });
  if (capabilities?.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, request => upstream.listResources(request.params));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, request => upstream.listResourceTemplates(request.params));
    server.setRequestHandler(ReadResourceRequestSchema, request => upstream.readResource(request.params));
  }
  return server;
}
