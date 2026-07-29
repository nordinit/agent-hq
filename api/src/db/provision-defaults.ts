/**
 * provision-defaults.ts — Explicit bootstrap/admin provisioning for built-in
 * tool registry rows, MCP registry rows, and optional runtime MCP API key.
 *
 * Usage:
 *   AGENT_HQ_DB_PATH=/path/to/agent-hq.db npx tsx src/db/provision-defaults.ts
 */

import { closeDb, getDbPath } from './client';
import { initSchema, provisionDefaultMcpRegistry, provisionDefaultToolRegistry } from './schema';
import { ensureConfiguredRuntimeMcpApiKey } from '../lib/mcpApiAuth';

async function main(): Promise<void> {
  await initSchema();
  await provisionDefaultToolRegistry();
  await provisionDefaultMcpRegistry();

  const runtimeMcpKey = await ensureConfiguredRuntimeMcpApiKey();

  console.log(JSON.stringify({
    ok: true,
    db_path: getDbPath(),
    runtime_mcp_key: runtimeMcpKey.status,
    runtime_mcp_key_id: runtimeMcpKey.keyId ?? null,
    runtime_mcp_agent_id: runtimeMcpKey.agentId ?? null,
  }));
}

try {
  main();
} finally {
  closeDb();
}
