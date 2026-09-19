import { createHash } from 'crypto';
import { canDiscoverTool, declaredToolNames, getToolPermissionRequirement, type ToolPermissionRequirement } from './toolPermissions';

export interface McpToolAccessDecision {
  name: string;
  available: boolean;
  requires_any: ToolPermissionRequirement;
  reason: string;
}

export function describeToolAccess(enabledCapabilities: readonly string[]): McpToolAccessDecision[] {
  const enabled = new Set(enabledCapabilities);
  return declaredToolNames().map(name => {
    const requirement = getToolPermissionRequirement(name);
    const available = canDiscoverTool(name, enabled);
    const matches = requirement.filter(clause => clause.every(key => enabled.has(key)));
    return {
      name, available, requires_any: requirement,
      reason: available
        ? `Allowed by ${enabled.has('admin.full_access') ? 'admin.full_access' : matches.map(clause => clause.join(' + ')).join(' or ')}. Resource scope and arguments are checked on each call.`
        : `Requires ${requirement.map(clause => clause.join(' + ')).join(' or ')} (or admin.full_access).`,
    };
  });
}

export interface McpEffectiveAccess {
  identity: { agent_id: number; agent_slug: string; key_id: number; key_role: string; tenant_id: number; project_id: number | null };
  policy_mode: 'default' | 'explicit';
  default_policy: string;
  enabled_capabilities: string[];
  tool_names: string[];
  policy_fingerprint: string;
  scopes: Array<{ capability: string; description: string }>;
}

export function buildEffectiveAccess(input: Omit<McpEffectiveAccess, 'tool_names' | 'policy_fingerprint'>): McpEffectiveAccess {
  const enabled_capabilities = [...input.enabled_capabilities].sort();
  const decisions = describeToolAccess(enabled_capabilities);
  const tool_names = decisions.filter(tool => tool.available).map(tool => tool.name);
  const data = { ...input, enabled_capabilities, tool_names };
  return {
    ...data,
    policy_fingerprint: createHash('sha256').update(JSON.stringify({ ...data, requirements: decisions.map(tool => tool.requires_any) })).digest('hex'),
  };
}
