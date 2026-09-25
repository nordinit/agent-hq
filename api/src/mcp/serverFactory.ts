/**
 * Agent HQ MCP Server — Server Factory
 *
 * Builds a configured McpServer with the Agent HQ domains registered. Shared by both
 * transports so the tool surface, error envelope, and rate-limit behaviour cannot drift
 * between them: the stdio server (api/src/mcp/server.ts) builds one long-lived instance,
 * and the HTTP transport (api/src/mcp/httpServer.ts) builds one per request.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgentHqApiClient } from './apiClient';
import { RateLimiter } from './rateLimiter';
import { createMcpRegistrar, formatMcpToolError, McpToolResult } from './registrar';
import { registerAgentHqMcpDomains } from './registerDomains';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpEffectiveAccess } from './accessView';
import { getMcpCatalog } from './catalog';
import { registerAgentHqMcpCatalog } from './registerCatalog';

export const AGENT_HQ_MCP_SERVER_NAME = 'agent-hq';
export const AGENT_HQ_MCP_SERVER_VERSION = '1.0.0';

export interface CreateAgentHqMcpServerOptions {
  api: AgentHqApiClient;
  /**
   * Whether an Agent HQ MCP key is configured. When false every tool returns the typed
   * "key required" envelope instead of failing at the API. The stdio server starts before it
   * can know, so this stays a tool-time answer rather than a boot-time one.
   */
  hasApiKey: boolean;
  /** Omit or pass null when the caller has already limited the request (e.g. per key). */
  rateLimiter?: RateLimiter | null;
  /** Fresh authenticated access. Stdio asks the API; HTTP resolves the presented key. */
  resolveAccess?: () => Promise<McpEffectiveAccess>;
  /** Describe the registered tools in the process-wide product catalog. */
  catalog?: boolean;
  /** Server instructions returned to the client during initialize. */
  instructions?: string;
}

function textResult(payload: unknown): McpToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

export function createAgentHqMcpServer(options: CreateAgentHqMcpServerOptions): McpServer {
  const { api, hasApiKey, rateLimiter = null, catalog, instructions } = options;
  if (getMcpCatalog().tools.length === 0) registerAgentHqMcpCatalog();

  const server = new McpServer(
    {
      name: AGENT_HQ_MCP_SERVER_NAME,
      version: AGENT_HQ_MCP_SERVER_VERSION,
    },
    instructions ? { instructions } : undefined,
  );

  function wrap<T>(fn: () => Promise<T>): () => Promise<McpToolResult> {
    return async () => {
      if (!hasApiKey) {
        return textResult({
          ok: false,
          error: 'MCP API key is required. Set AGENT_HQ_MCP_API_KEY to an Agent HQ MCP key materialized for this agent.',
        });
      }
      if (rateLimiter && !rateLimiter.allow()) {
        return textResult({
          ok: false,
          error: `Rate limit exceeded. Maximum ${rateLimiter.requestsPerMinute} requests per minute.`,
        });
      }
      try {
        return textResult({ ok: true, data: await fn() });
      } catch (err: unknown) {
        return textResult(formatMcpToolError(err));
      }
    };
  }

  let lastFingerprint: string | undefined;
  async function access(): Promise<McpEffectiveAccess> {
    if (!hasApiKey) throw new Error('MCP API key is required. Set AGENT_HQ_MCP_API_KEY.');
    // Never reuse a successful decision after a failed refresh or a policy/key change.
    const current = await (options.resolveAccess ? options.resolveAccess() : api.getEffectiveAccess());
    if (!Array.isArray(current.tool_names) || !current.policy_fingerprint) throw new Error('Invalid MCP access response');
    if (lastFingerprint && lastFingerprint !== current.policy_fingerprint) server.sendToolListChanged();
    lastFingerprint = current.policy_fingerprint;
    return current;
  }
  const registrar = createMcpRegistrar(server, {
    catalog,
    authorizeTool: async name => {
      if (!(await access()).tool_names.includes(name)) throw new Error(`MCP permission denied for ${name}`);
    },
    authenticateResource: async () => { await access(); },
  });
  registerAgentHqMcpDomains({ api, wrap, ...registrar, getCatalog: async () => {
    const current = await access();
    const names = new Set(current.tool_names);
    return { ...getMcpCatalog(), tools: getMcpCatalog().tools.filter(tool => names.has(tool.canonical_name)),
      policy_fingerprint: current.policy_fingerprint, scopes: current.scopes };
  } });
  // Register all handlers so live grants need no restart, but advertise only permitted tools.
  // Handlers independently refresh before execution, including calls from a stale client list.
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: registrar.listTools(new Set((await access()).tool_names)) };
  });

  return server;
}
