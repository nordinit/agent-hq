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
import { McpToolProfile } from './toolProfiles';

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
  /** Restricts the exposed tool names. Defaults to the full surface. */
  profile?: McpToolProfile | null;
  /** Describe the registered tools in the process-wide catalog. Defaults to full-surface only. */
  catalog?: boolean;
  /** Server instructions returned to the client during initialize. */
  instructions?: string;
}

function textResult(payload: unknown): McpToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

export function createAgentHqMcpServer(options: CreateAgentHqMcpServerOptions): McpServer {
  const { api, hasApiKey, rateLimiter = null, profile = null, catalog, instructions } = options;

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

  const registrar = createMcpRegistrar(server, { profile, catalog });
  registerAgentHqMcpDomains({ api, wrap, ...registrar });

  return server;
}
