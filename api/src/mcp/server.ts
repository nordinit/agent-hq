/**
 * Agent HQ MCP Server — Main Entry Point
 *
 * Exposes Agent HQ projects, boards, tasks, and task management to any
 * MCP-compatible AI client via stdio transport.
 *
 * Architecture:
 *   AI client (stdio) -> this process -> Agent HQ REST API (localhost:3501)
 *
 * Transport: stdio (v1). No network port is opened by this server.
 * Auth: Agent-bound API key required via AGENT_HQ_MCP_API_KEY or config file.
 * Rate limit: 60 req/min by default (configurable via MCP_RATE_LIMIT_RPM).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config';
import { AgentHqApiClient } from './apiClient';
import { RateLimiter } from './rateLimiter';
import { createMcpRegistrar, formatMcpToolError, McpToolResult } from './registrar';
import { registerAgentHqMcpDomains } from './registerDomains';

const cfg = loadConfig();
const api = new AgentHqApiClient(cfg.apiUrl, cfg.apiKey);
const limiter = new RateLimiter(cfg.rateLimitRpm);

console.error(
  `[agent-hq-mcp] Starting, API: ${cfg.apiUrl} | Rate limit: ${cfg.rateLimitRpm} req/min | Auth: ${cfg.apiKey ? 'configured' : 'missing'}`,
);

const server = new McpServer({
  name: 'agent-hq',
  version: '1.0.0',
});

function wrap<T>(fn: () => Promise<T>): () => Promise<McpToolResult> {
  return async () => {
    if (!cfg.apiKey) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'MCP API key is required. Set AGENT_HQ_MCP_API_KEY to an Agent HQ MCP key materialized for this agent.',
            }),
          },
        ],
      };
    }
    if (!limiter.allow()) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: `Rate limit exceeded. Maximum ${cfg.rateLimitRpm} requests per minute.`,
            }),
          },
        ],
      };
    }
    try {
      const result = await fn();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data: result }) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(formatMcpToolError(err)) }],
      };
    }
  };
}

const registrar = createMcpRegistrar(server);
const context = { api, wrap, ...registrar };

registerAgentHqMcpDomains(context);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[agent-hq-mcp] MCP server connected, ready for tool calls via stdio.');

  const shutdown = async (signal: string) => {
    console.error(`[agent-hq-mcp] Received ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[agent-hq-mcp] Fatal error:', err);
  process.exit(1);
});
