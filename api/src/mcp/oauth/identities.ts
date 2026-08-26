/**
 * The Agent HQ identities a remote connector may authorize as.
 *
 * One endpoint serves every connector, so the identity cannot be a property of the endpoint —
 * Claude and ChatGPT arriving at the same /mcp would otherwise share one audit actor and one
 * capability policy. It is chosen by the operator at the consent screen instead, from the set
 * below.
 *
 * ELIGIBILITY IS A ROLE MARKER, NOT A LIST OF EVERY AGENT. Only agents provisioned as remote MCP
 * clients qualify. That restriction is load-bearing: the consent form posts back an agent id, and
 * without a server-side eligibility check an operator — or anyone who reached the form — could
 * name Atlas's id and mint a connector token with trusted-admin defaults. Selection is always
 * validated against this set, never trusted from the form.
 */

import type { Db } from '../../db/adapter/types';
import { getAgentMcpPermissionPolicy } from '../../lib/mcpApiAuth';

/** Written by provision-remote-mcp-identity.ts; the marker that makes an agent selectable here. */
export const REMOTE_MCP_CLIENT_ROLE = 'Remote MCP client';

export interface ConsentIdentity {
  agentId: number;
  tenantId: number;
  agentName: string;
  agentSlug: string;
  projectName: string | null;
  capabilities: string[];
}

async function shapeIdentity(db: Db, row: Record<string, unknown>): Promise<ConsentIdentity> {
  const policy = await getAgentMcpPermissionPolicy(db, Number(row.id));
  return {
    agentId: Number(row.id),
    tenantId: Number(row.tenant_id),
    agentName: String(row.name),
    agentSlug: String(row.slug ?? ''),
    projectName: typeof row.project_name === 'string' ? row.project_name : null,
    capabilities: policy.capabilities.filter((capability) => capability.enabled).map((capability) => capability.label),
  };
}

/**
 * Every identity a connector may be authorized as, with its live capability list.
 *
 * Read on each consent render rather than cached, so an operator who narrows a policy sees the
 * narrowed list on the screen where they are deciding whether to approve.
 */
export async function listRemoteMcpIdentities(db: Db): Promise<ConsentIdentity[]> {
  const rows = await db.all(`
    SELECT a.id, a.name, a.slug, a.tenant_id, p.name AS project_name
    FROM agents a
    LEFT JOIN projects p ON p.id = a.project_id
    WHERE a.role = ? AND a.enabled = 1
    ORDER BY a.name ASC
  `, REMOTE_MCP_CLIENT_ROLE) as Array<Record<string, unknown>>;

  const identities: ConsentIdentity[] = [];
  for (const row of rows) identities.push(await shapeIdentity(db, row));
  return identities;
}

/**
 * The identity a returning client last used.
 *
 * Reconnecting an already-connected app should land on the same identity it had, or its history
 * splits across two actors for no reason the operator asked for. Revoked grants are ignored so a
 * deliberate disconnection does not keep steering the choice.
 */
export async function findLastIdentityForClient(db: Db, clientId: string): Promise<number | null> {
  const row = await db.get(`
    SELECT agent_id FROM mcp_oauth_grants
    WHERE client_id = ? AND revoked_at IS NULL
    ORDER BY id DESC LIMIT 1
  `, clientId) as { agent_id: number } | undefined;
  return row ? Number(row.agent_id) : null;
}

/**
 * Picks the identity to pre-select: what this client used last, else the configured default,
 * else the first eligible one.
 */
export function selectDefaultIdentity(
  identities: ConsentIdentity[],
  options: { lastAgentId?: number | null; defaultSlug?: string | null },
): ConsentIdentity | null {
  if (identities.length === 0) return null;
  if (options.lastAgentId != null) {
    const previous = identities.find((identity) => identity.agentId === options.lastAgentId);
    if (previous) return previous;
  }
  if (options.defaultSlug) {
    const configured = identities.find((identity) => identity.agentSlug === options.defaultSlug);
    if (configured) return configured;
  }
  return identities[0];
}
