import { AgentHqApiClient } from './apiClient';
import { registerCatalogTool, resetMcpCatalogTools } from './catalog';
import { registerAgentHqMcpDomains } from './registerDomains';
import { McpRegistrar, McpToolResult } from './registrar';

function createCatalogRegistrar(): McpRegistrar {
  return {
    registerTool(names, description, schema, _handler, options) {
      registerCatalogTool({
        names,
        description,
        schema,
        domain: options?.domain ?? 'general',
        rest_paths: options?.rest_paths,
      });
    },
    registerResource() {
      // Resources are described by the static catalog resource list and registered live by the stdio server.
    },
  };
}

function wrapForCatalog<T>(_fn: () => Promise<T>): () => Promise<McpToolResult> {
  return async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Catalog-only registrar does not execute tools.' }) }],
  });
}

export function registerAgentHqMcpCatalog(api = new AgentHqApiClient('http://127.0.0.1')) {
  resetMcpCatalogTools();
  const registrar = createCatalogRegistrar();
  registerAgentHqMcpDomains({ api, wrap: wrapForCatalog, ...registrar });
}
