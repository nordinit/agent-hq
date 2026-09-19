import type { Db } from '../db/adapter/types';
import { AGENT_MCP_CAPABILITY_CATALOG, resolveEffectiveAgentMcpPermissionState, type McpApiIdentity } from '../lib/mcpApiAuth';
import { buildEffectiveAccess } from './accessView';

/** Uses the presented key's role, never the operator summary's strongest key role. */
export async function resolveMcpEffectiveAccess(db: Db, identity: McpApiIdentity) {
  const state = await resolveEffectiveAgentMcpPermissionState(db, identity);
  // Authentication already validates the agent/key binding, including super-admin keys
  // whose key tenant can differ from the identity's home tenant.
  const agent = await db.get('SELECT project_id FROM agents WHERE id = ?', identity.agentId) as { project_id: number | null } | undefined;
  if (!agent) throw new Error('MCP identity is no longer available');
  return buildEffectiveAccess({
    identity: { agent_id: identity.agentId, agent_slug: identity.agentSlug, key_id: identity.keyId, key_role: identity.keyRole,
      tenant_id: identity.tenantId, project_id: agent.project_id == null ? null : Number(agent.project_id) },
    policy_mode: state.policyMode,
    default_policy: state.defaultPolicy,
    enabled_capabilities: [...state.enabledCapabilities],
    scopes: AGENT_MCP_CAPABILITY_CATALOG.filter(capability => state.enabledCapabilities.has(capability.key))
      .map(capability => ({ capability: capability.key, description: capability.description })),
  });
}
