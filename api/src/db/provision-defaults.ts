/** Explicit operator-requested reinstall of the default package. */
import '../config/loadRootEnv';
import { closeDb, getDb } from './client';
import { ensureConfiguredRuntimeMcpApiKey } from '../lib/mcpApiAuth';
import { applyDefaultInstallPackage } from '../lib/defaultInstallPackage';
import { getDefaultTenantId } from '../lib/tenantContext';

async function main(): Promise<void> {
  const db = getDb();
  const tenantId = await getDefaultTenantId(db);
  const packageResult = await applyDefaultInstallPackage(db, tenantId, { mode: 'reinstall' });
  const runtimeMcpKey = await ensureConfiguredRuntimeMcpApiKey(db);
  console.log(JSON.stringify({
    ok: true,
    tenant_id: tenantId,
    package: packageResult,
    runtime_mcp_key: runtimeMcpKey.status,
    runtime_mcp_key_id: runtimeMcpKey.keyId ?? null,
    runtime_mcp_agent_id: runtimeMcpKey.agentId ?? null,
  }));
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
