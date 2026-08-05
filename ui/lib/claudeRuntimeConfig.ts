import type { ClaudeCodeRuntimeConfig } from './api/types';

export const DEFAULT_CLAUDE_ALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'Read',
  'Write',
] as const;

/**
 * Build the structured Claude config used by both create and edit forms.
 * `allowedTools: []` is semantically different from an omitted field: empty is
 * a tool-less boundary while omitted selects the API's productive defaults.
 */
export function serializeClaudeRuntimeConfig(
  config: ClaudeCodeRuntimeConfig,
): ClaudeCodeRuntimeConfig {
  const out: ClaudeCodeRuntimeConfig = {};
  if (config.workingDirectory !== undefined) out.workingDirectory = config.workingDirectory;
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
