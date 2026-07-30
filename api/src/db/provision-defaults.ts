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
  provisionDefaultToolRegistry();
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

// See migrate.ts: main() is async, so the original try/finally closed the database before the
// work finished and let rejections pass silently with exit code 0.
void main()
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
