/**
 * runtimes/claudeCode/config.ts — validation and normalization of agent-level
 * `runtime_config` for the claude-code runtime.
 *
 * Pure module: no DB, no filesystem, no process handles. `validate` returns an
 * error string (the HTTP layer turns it into a 400), `normalize` throws — the
 * same split the Hermes adapter uses (api/src/runtimes/hermes/config.ts).
 *
 * Design reference: docs/architecture/claude-code-runtime-v2.md
 */

import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_PERMISSION_MODES,
  DEFAULT_CLAUDE_ALLOWED_TOOLS,
  DEFAULT_CLAUDE_BIN,
  DEFAULT_KILL_GRACE_MS,
  type ClaudeCodeRuntimeConfig,
  type NormalizedClaudeCodeRuntimeConfig,
} from './types';
import { validateRuntimeExecutable } from '../executablePolicy';
import { isProtectedRuntimeConfigEnvKey } from '../environment';
import { REQUIRED_AGENT_HQ_LIFECYCLE_TOOL_NAMES } from './lifecycleTools';

// ── extraArgs allowlist ───────────────────────────────────────────────────────

/**
 * Complete operator pass-through surface. A denylist cannot secure an evolving
 * CLI: newly added settings, plugin, permission, detachment, or remote-control
 * flags would be accepted before this adapter knew they existed. Keep this to
 * argument-free switches that cannot replace an adapter-owned launch boundary.
 * Verified against Claude Code 2.1.222.
 */
export const ALLOWED_EXTRA_ARGS: readonly string[] = [
  '--debug',
  '--exclude-dynamic-system-prompt-sections',
];

// ── Field tables ─────────────────────────────────────────────────────────────

const STRING_FIELDS = [
  'workingDirectory',
  'claudeBin',
  'model',
  'systemPromptSuffix',
  'claudeConfigDir',
  'providerConnectionExternalRef',
] as const;

const STRING_ARRAY_FIELDS = ['allowedTools', 'disallowedTools', 'extraArgs'] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function copyStrings(value: unknown): string[] {
  return Array.isArray(value) ? [...(value as string[])] : [];
}

const BUILT_IN_TOOL_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

function lifecycleToolDenied(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return REQUIRED_AGENT_HQ_LIFECYCLE_TOOL_NAMES.some(
    (required) => normalized === required || normalized.endsWith(`__${required}`),
  );
}

function validateBuiltInToolName(
  field: 'allowedTools' | 'disallowedTools',
  name: string,
): string | null {
  if (field === 'disallowedTools' && lifecycleToolDenied(name)) {
    return `runtime_config.disallowedTools may not deny required Agent HQ lifecycle tool ${JSON.stringify(name)}`;
  }
  if (
    !BUILT_IN_TOOL_IDENTIFIER.test(name)
    || name.toLowerCase().startsWith('mcp__')
    || name.toLowerCase().startsWith('agent_hq_')
  ) {
    return `runtime_config.${field} entry ${JSON.stringify(name)} must be a simple built-in tool identifier`;
  }
  return null;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Returns an error message, or null when the config is usable.
 *
 * EVERY field is optional, deliberately: `PUT /agents/:id` re-validates the
 * STORED runtime_config when the request body omits it, so a newly-required
 * field would retroactively 400 every unrelated update to an existing
 * claude-code agent (see the ClaudeCodeRuntimeConfig doc comment in types.ts).
 */
export function validateClaudeCodeRuntimeConfig(
  config: ClaudeCodeRuntimeConfig | null | undefined,
): string | null {
  if (config == null) return null;

  for (const field of STRING_FIELDS) {
    const value = config[field];
    if (value != null && typeof value !== 'string') {
      return `runtime_config.${field} must be a string`;
    }
  }

  const executableError = validateRuntimeExecutable('claude-code', config.claudeBin);
  if (executableError) return executableError;

  if (config.effort != null && !isOneOf(CLAUDE_EFFORT_LEVELS, config.effort)) {
    return `runtime_config.effort must be one of: ${CLAUDE_EFFORT_LEVELS.join(', ')}`;
  }

  if (config.permissionMode != null && !isOneOf(CLAUDE_PERMISSION_MODES, config.permissionMode)) {
    return `runtime_config.permissionMode must be one of: ${CLAUDE_PERMISSION_MODES.join(', ')}`;
  }
  if (config.allowDangerousBypass != null && typeof config.allowDangerousBypass !== 'boolean') {
    return 'runtime_config.allowDangerousBypass must be a boolean';
  }
  if (config.permissionMode === 'bypass' && config.allowDangerousBypass !== true) {
    return 'runtime_config.allowDangerousBypass must be true when permissionMode is bypass';
  }

  if (config.maxTurns != null && (!isFiniteNumber(config.maxTurns) || config.maxTurns <= 0)) {
    return 'runtime_config.maxTurns must be a positive number';
  }

  if (
    config.maxBudgetUsd != null &&
    (!isFiniteNumber(config.maxBudgetUsd) || config.maxBudgetUsd <= 0)
  ) {
    return 'runtime_config.maxBudgetUsd must be a positive number';
  }

  if (
    config.killGraceMs != null &&
    (!isFiniteNumber(config.killGraceMs) || config.killGraceMs < 0)
  ) {
    return 'runtime_config.killGraceMs must be a non-negative number';
  }

  for (const field of STRING_ARRAY_FIELDS) {
    const value = config[field];
    if (value == null) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      return `runtime_config.${field} must be an array of strings`;
    }
  }

  for (const field of ['allowedTools', 'disallowedTools'] as const) {
    for (const name of config[field] ?? []) {
      const toolError = validateBuiltInToolName(field, name);
      if (toolError) return toolError;
    }
  }

  // Only an EXPLICIT allowedTools can contradict disallowedTools. Comparing against
  // the implicit default would turn "deny WebSearch, take the defaults otherwise"
  // into a 400 — and because PUT /agents/:id re-validates the STORED config, every
  // later unrelated edit of such an agent would fail too. Growing the default list
  // must never retroactively invalidate an existing agent. A default-vs-denied
  // collision is not ambiguous: normalization below subtracts the denials.
  if (config.allowedTools !== undefined) {
    const allowedToolNames = new Set(config.allowedTools.map((name) => name.toLowerCase()));
    const overlap = config.disallowedTools?.find(
      (name) => allowedToolNames.has(name.toLowerCase()),
    );
    if (overlap) {
      return `runtime_config.allowedTools and runtime_config.disallowedTools overlap on ${JSON.stringify(overlap)}`;
    }
  }

  const extraArgs = config.extraArgs;
  if (Array.isArray(extraArgs)) {
    for (const arg of extraArgs) {
      const trimmed = arg.trim();
      if (!trimmed) continue;
      if (!ALLOWED_EXTRA_ARGS.includes(trimmed)) {
        return `Claude Code runtime does not allow extraArgs entry ${JSON.stringify(trimmed)}`;
      }
    }
  }

  const env: unknown = config.env;
  if (env != null) {
    if (typeof env !== 'object' || Array.isArray(env)) {
      return 'runtime_config.env must be an object of string environment values';
    }
    for (const value of Object.values(env as Record<string, unknown>)) {
      if (typeof value !== 'string') return 'runtime_config.env values must be strings';
    }
    for (const key of Object.keys(env as Record<string, unknown>)) {
      const normalized = key.trim().toUpperCase();
      const protectedKey =
        normalized === 'CLAUDE_CONFIG_DIR' ||
        normalized.startsWith('AGENT_HQ_') ||
        normalized.startsWith('ANTHROPIC_') ||
        normalized.startsWith('CLAUDE_') ||
        isProtectedRuntimeConfigEnvKey(normalized);
      if (protectedKey) {
        return `runtime_config.env may not set protected or credential variable ${JSON.stringify(key)}`;
      }
    }
  }

  return null;
}

// ── Normalization ────────────────────────────────────────────────────────────

/**
 * Applies defaults to a validated config, throwing the validation message when
 * the config is unusable.
 *
 * Arrays and `env` are copied rather than aliased: the normalized config is
 * handed to argv construction, which appends to these lists, and aliasing would
 * let one dispatch mutate the agent record shared by every later dispatch.
 */
export function normalizeClaudeCodeRuntimeConfig(
  config: ClaudeCodeRuntimeConfig | null | undefined,
): NormalizedClaudeCodeRuntimeConfig {
  const validationError = validateClaudeCodeRuntimeConfig(config);
  if (validationError) throw new Error(validationError);

  const disallowedTools = copyStrings(config?.disallowedTools);
  const deniedToolNames = new Set(disallowedTools.map((name) => name.toLowerCase()));

  return {
    workingDirectory: trimmedOrNull(config?.workingDirectory),
    claudeBin: trimmedOrNull(config?.claudeBin) ?? DEFAULT_CLAUDE_BIN,
    model: trimmedOrNull(config?.model),
    effort: config?.effort ?? null,
    // An explicit list is taken verbatim (validation already proved it does not
    // contradict the denials). The implicit default instead yields to them, so a
    // denied tool never lands in `--tools` and `--disallowedTools` at once.
    allowedTools: config?.allowedTools === undefined
      ? DEFAULT_CLAUDE_ALLOWED_TOOLS.filter((name) => !deniedToolNames.has(name.toLowerCase()))
      : copyStrings(config.allowedTools),
    disallowedTools,
    maxTurns: config?.maxTurns ?? null,
    maxBudgetUsd: config?.maxBudgetUsd ?? null,
    permissionMode: config?.permissionMode ?? 'allowlist',
    allowDangerousBypass: config?.allowDangerousBypass ?? false,
    systemPromptSuffix: trimmedOrNull(config?.systemPromptSuffix),
    extraArgs: copyStrings(config?.extraArgs).map((arg) => arg.trim()).filter(Boolean),
    env: config?.env ? { ...config.env } : {},
    killGraceMs: config?.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    claudeConfigDir: trimmedOrNull(config?.claudeConfigDir),
    providerConnectionExternalRef: trimmedOrNull(config?.providerConnectionExternalRef),
  };
}
