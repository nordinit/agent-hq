/**
 * Provision a scoped Agent HQ identity for a remote MCP client.
 *
 * A remote connector's key lives outside this machine — in Anthropic's or OpenAI's connector
 * config — which makes it the key most likely to leak and the one least worth granting broadly.
 * So it gets its own agent rather than borrowing Atlas's: a separate identity is separately
 * revocable, shows up on its own in the audit trail, and (unlike anything named Atlas, which
 * isTrustedMcpIdentity resolves to trusted-admin defaults) starts from the scoped-runtime policy.
 *
 * The identity is a permission holder, not a worker, and its capability policy is written
 * explicitly from the tool profile's paired capability list rather than left to the defaults.
 *
 * It is created enabled, which is not an oversight: resolveMcpApiIdentityForKey refuses a key
 * mapped to a disabled agent, so a disabled identity is one whose connector can never authenticate.
 * Nothing dispatches to it anyway — automatic assignment runs through assignment rules, and none
 * names this agent. Leave it out of assignment rules and teams and it stays a credential.
 *
 * Usage:
 *   npx tsx src/bin/provision-remote-mcp-identity.ts --project-id 86
 *   npx tsx src/bin/provision-remote-mcp-identity.ts --project-id 86 --rotate-key
 *   npx tsx src/bin/provision-remote-mcp-identity.ts --project-id 86 --name "Claude Mobile" --slug claude-mobile
 */

import '../config/loadRootEnv';
import { closeDb, getDb } from '../db/client';
import type { Db } from '../db/adapter/types';
import { getDefaultTenantId } from '../lib/tenantContext';
import { issueMcpApiKeyForAgent, replaceAgentMcpPermissionPolicy } from '../lib/mcpApiAuth';
import { resolveMcpToolProfile } from '../mcp/toolProfiles';
import { REMOTE_MCP_CLIENT_ROLE } from '../mcp/oauth/identities';

interface Options {
  name: string;
  slug: string;
  projectId: number | null;
  tenantId: number | null;
  profileName: string;
  rotateKey: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    name: 'Claude Mobile',
    slug: 'claude-mobile',
    projectId: null,
    tenantId: null,
    profileName: 'mobile',
    rotateKey: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return next;
    };

    switch (arg) {
      case '--name': options.name = value(); break;
      case '--slug': options.slug = value(); break;
      case '--project-id': options.projectId = Number.parseInt(value(), 10); break;
      case '--tenant-id': options.tenantId = Number.parseInt(value(), 10); break;
      case '--profile': options.profileName = value(); break;
      case '--rotate-key': options.rotateKey = true; break;
      case '--help':
      case '-h':
        console.log('Usage: provision-remote-mcp-identity --project-id <id> [--name <name>] [--slug <slug>] [--tenant-id <id>] [--profile <name>] [--rotate-key]');
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function resolveExistingAgentId(db: Db, sessionKey: string): Promise<number | null> {
  const row = await db.get(
    `SELECT id FROM agents WHERE session_key = ? LIMIT 1`,
    sessionKey,
  ) as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

async function assertProjectInTenant(db: Db, projectId: number, tenantId: number): Promise<void> {
  const row = await db.get(
    `SELECT id FROM projects WHERE id = ? AND tenant_id = ? LIMIT 1`,
    projectId,
    tenantId,
  ) as { id: number } | undefined;
  if (!row) throw new Error(`Project #${projectId} was not found in tenant #${tenantId}.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const profile = resolveMcpToolProfile(options.profileName);
  if (!profile.capabilities) {
    throw new Error(
      `Tool profile "${profile.name}" has no paired capability policy, so there is nothing to scope this identity to. Use a narrower profile such as "mobile".`,
    );
  }

  const db = getDb();
  const tenantId = options.tenantId ?? await getDefaultTenantId(db);

  if (!Number.isInteger(options.projectId) || (options.projectId ?? 0) <= 0) {
    throw new Error('--project-id is required: every capability in this policy is scoped to one assigned project.');
  }
  const projectId = options.projectId as number;
  await assertProjectInTenant(db, projectId, tenantId);

  const sessionKey = `agent:${options.slug}:main`;
  const existingAgentId = await resolveExistingAgentId(db, sessionKey);

  let agentId: number;
  let created = false;
  if (existingAgentId) {
    agentId = existingAgentId;
    await db.run(
      // role is re-asserted, not just set on create: it is the marker that makes this identity
      // selectable on the consent screen, and an agent edited elsewhere could have lost it.
      `UPDATE agents SET name = ?, slug = ?, role = ?, tenant_id = ?, project_id = ?, enabled = 1 WHERE id = ?`,
      options.name,
      options.slug,
      REMOTE_MCP_CLIENT_ROLE,
      tenantId,
      projectId,
      agentId,
    );
  } else {
    const result = await db.run(`
      INSERT INTO agents (tenant_id, name, slug, session_key, role, job_title, project_id, enabled, runtime_type, workspace_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'openclaw', '')
    `, tenantId, options.name, options.slug, sessionKey, REMOTE_MCP_CLIENT_ROLE, REMOTE_MCP_CLIENT_ROLE, projectId);
    agentId = Number(result.lastInsertId);
    created = true;
  }

  const policy = await replaceAgentMcpPermissionPolicy(db, agentId, profile.capabilities);

  const existingKeys = await db.all(
    `SELECT id, key_prefix, last_used_at FROM mcp_api_keys WHERE agent_id = ? AND enabled = 1 AND revoked_at IS NULL ORDER BY id DESC`,
    agentId,
  ) as Array<{ id: number; key_prefix: string; last_used_at: string | null }>;

  let issuedKey: string | null = null;
  let issuedKeyId: number | null = null;
  if (existingKeys.length === 0 || options.rotateKey) {
    const issued = await issueMcpApiKeyForAgent(db, agentId, `${options.name} remote MCP key`);
    issuedKey = issued.apiKey;
    issuedKeyId = issued.keyId;
    if (options.rotateKey && existingKeys.length > 0) {
      // Revoke rather than delete: mcp_api_keys is the audit trail for what a key did.
      for (const key of existingKeys) {
        await db.run(
          `UPDATE mcp_api_keys SET enabled = 0, revoked_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
          key.id,
        );
      }
    }
  }

  const enabledCapabilities = policy.capabilities.filter((capability) => capability.enabled).map((c) => c.key);

  console.log(JSON.stringify({
    ok: true,
    agent_id: agentId,
    agent_name: options.name,
    agent_slug: options.slug,
    created,
    tenant_id: tenantId,
    project_id: projectId,
    tool_profile: profile.name,
    exposed_tool_count: profile.toolNames ? profile.toolNames.size : null,
    policy_mode: policy.policy_mode,
    enabled_capabilities: enabledCapabilities,
    key_id: issuedKeyId,
    existing_key_ids: existingKeys.map((key) => key.id),
  }, null, 2));

  if (issuedKey) {
    console.log(`\nMCP API key (shown once — store it in the connector config now):\n  ${issuedKey}\n`);
    console.log('Verify the endpoint before pointing a connector at it:');
    console.log(`  curl -sS -X POST http://127.0.0.1:\${PORT:-3501}/mcp \\
    -H "Authorization: Bearer ${issuedKey}" \\
    -H "Content-Type: application/json" \\
    -H "Accept: application/json, text/event-stream" \\
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'\n`);
  } else {
    console.log(`\nThis identity already has ${existingKeys.length} active key(s) and Agent HQ stores only their hashes, so none can be printed again. Re-run with --rotate-key to issue a replacement and revoke the old ones.\n`);
  }
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
