/**
 * Agent HQ MCP Server — stdio Entry Point
 *
 * Exposes Agent HQ projects, boards, tasks, and task management to any
 * MCP-compatible AI client via stdio transport.
 *
 * Architecture:
 *   AI client (stdio) -> this process -> Agent HQ REST API (localhost:3501)
 *
 * Transport: stdio. No network port is opened by this server. The same tool surface is
 * served over Streamable HTTP by api/src/mcp/httpServer.ts, mounted at /mcp inside the API.
 * Auth: Agent-bound API key required via AGENT_HQ_MCP_API_KEY or config file.
 * Rate limit: 60 req/min by default (configurable via MCP_RATE_LIMIT_RPM).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config';
import { AgentHqApiClient } from './apiClient';
import { RateLimiter } from './rateLimiter';
import { createAgentHqMcpServer } from './serverFactory';
import { resolveMcpToolProfile } from './toolProfiles';

const cfg = loadConfig();
const api = new AgentHqApiClient(cfg.apiUrl, cfg.apiKey);
const limiter = new RateLimiter(cfg.rateLimitRpm);
const profile = resolveMcpToolProfile(process.env.AGENT_HQ_MCP_TOOL_PROFILE);

console.error(
  `[agent-hq-mcp] Starting, API: ${cfg.apiUrl} | Rate limit: ${cfg.rateLimitRpm} req/min | Auth: ${cfg.apiKey ? 'configured' : 'missing'} | Profile: ${profile.name}`,
);

const server = createAgentHqMcpServer({
  api,
  hasApiKey: Boolean(cfg.apiKey),
  rateLimiter: limiter,
  profile: profile.toolNames ? profile : null,
});

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
