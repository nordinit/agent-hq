import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/** The same Agent HQ assignment controls discovery and invocation. No CRM policy. */
export function createToolGateway(upstream: Client, allowedTools: string[]|null, authorize?:(toolName?:string)=>Promise<void>): Server {
  const allowed = allowedTools===null?null:new Set(allowedTools);
  const capabilities = upstream.getServerCapabilities();
  const server = new Server({ name: 'agent-hq-tool-gateway', version: '1' }, {
    capabilities: { tools: {}, ...(capabilities?.resources ? { resources: {} } : {}) },
  });
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    await authorize?.();
    const result = await upstream.listTools(request.params);
    return { ...result, tools: result.tools.filter(tool => (allowed===null||allowed.has(tool.name))) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (allowed!==null && !allowed.has(request.params.name)) {
      return { isError: true, content: [{ type: 'text', text: 'Tool is not granted by this Agent HQ MCP assignment' }] };
    }
    if(authorize){try{await authorize(request.params.name);}catch{return {isError:true,content:[{type:'text',text:'Execution grant denied or revoked.'}]};}}
    return upstream.callTool(request.params);
  });
  if (capabilities?.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async request => { await authorize?.(); return upstream.listResources(request.params); });
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async request => { await authorize?.(); return upstream.listResourceTemplates(request.params); });
    server.setRequestHandler(ReadResourceRequestSchema, async request => { await authorize?.(); return upstream.readResource(request.params); });
  }
  return server;
}
