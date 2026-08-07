import type { ClaudeCodeRuntimeConfig } from './api/types';

/** Must stay identical to DEFAULT_CLAUDE_ALLOWED_TOOLS in api/src/runtimes/claudeCode/types.ts. */
export const DEFAULT_CLAUDE_ALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'Read',
  'WebFetch',
  'WebSearch',
  'Write',
] as const;

/**
 * Placeholder showing where a blank Working Directory will actually land.
 *
 * Mirrors buildAgentHqWorkspacePath in api/src/config.ts. `~` stands in for the
 * real home because the browser cannot know it, and the parent is relocatable via
 * AGENT_HQ_DATA_DIR — so this is a hint, never a submitted value.
 */
export function defaultClaudeWorkspaceHint(agentName: string): string {
  const slug = agentName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `~/.agent-hq/workspaces/${slug || '<agent-slug>'}`;
}

/**
 * Build the structured Claude config used by both create and edit forms.
 * `allowedTools: []` is semantically different from an omitted field: empty is
 * a tool-less boundary while omitted selects the API's productive defaults.
 *
 * `workingDirectory` has no such distinction — an empty string and an absent key
 * both mean "fall back" — so blank is omitted rather than persisted as `""`.
 */
export function serializeClaudeRuntimeConfig(
  config: ClaudeCodeRuntimeConfig,
): ClaudeCodeRuntimeConfig {
  const out: ClaudeCodeRuntimeConfig = {};
  if (config.workingDirectory?.trim()) out.workingDirectory = config.workingDirectory.trim();
  if (config.claudeBin) out.claudeBin = config.claudeBin;
  if (config.model) out.model = config.model;
  if (config.effort) out.effort = config.effort;
  if (config.allowedTools !== undefined) out.allowedTools = [...config.allowedTools];
  if (config.disallowedTools !== undefined) out.disallowedTools = [...config.disallowedTools];
  if (config.permissionMode) out.permissionMode = config.permissionMode;
  if (config.allowDangerousBypass) out.allowDangerousBypass = true;
  if (config.maxTurns) out.maxTurns = Number(config.maxTurns);
  if (config.maxBudgetUsd) out.maxBudgetUsd = Number(config.maxBudgetUsd);
  if (config.systemPromptSuffix) out.systemPromptSuffix = config.systemPromptSuffix;
  if (config.extraArgs !== undefined) out.extraArgs = [...config.extraArgs];
  if (config.env !== undefined) out.env = { ...config.env };
  if (config.killGraceMs != null) out.killGraceMs = Number(config.killGraceMs);
  if (config.claudeConfigDir) out.claudeConfigDir = config.claudeConfigDir;
  if (config.providerConnectionExternalRef) {
    out.providerConnectionExternalRef = config.providerConnectionExternalRef;
  }
  return out;
}

export function claudeRuntimeConfigToJson(config: ClaudeCodeRuntimeConfig): string {
  return JSON.stringify(serializeClaudeRuntimeConfig(config), null, 2);
}
