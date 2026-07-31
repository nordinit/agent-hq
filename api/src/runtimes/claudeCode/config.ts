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
  DEFAULT_CLAUDE_BIN,
  DEFAULT_KILL_GRACE_MS,
  type ClaudeCodeRuntimeConfig,
  type NormalizedClaudeCodeRuntimeConfig,
} from './types';

// ── extraArgs denylist ───────────────────────────────────────────────────────

/**
 * Flags this adapter owns and therefore refuses to let an operator pass through
 * `extraArgs`.
 *
 * This matters more here than it does for Hermes because the Claude Code CLI
 * (verified against 2.1.220) SILENTLY IGNORES UNKNOWN FLAGS and quietly accepts
 * repeated ones. An operator who adds `--output-format text` or a second
 * `--session-id` gets no error at all — the run just stops producing parseable
 * stream-json, or resumes the wrong session. Failing at config-write time is the
 * only place the mistake is visible.
 *
 * Note that `-p`/`--print` is denied here even though Hermes' equivalent list
 * denies `-p` for an unrelated reason: for this CLI `--print -` is the primary
 * invocation, and re-specifying it is what breaks stdin prompt delivery.
 *
 * Matching covers the bare flag and the `flag=value` form; a flag whose value is
 * a separate argv entry is caught by the flag itself.
 */
export const DISALLOWED_EXTRA_ARG_PREFIXES: readonly string[] = [
  // Invocation shape + transcript format.
  '--print',
  '-p',
  '--output-format',
  '--input-format',
  '--verbose',
  // Session identity and continuation.
  '--session-id',
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--fork-session',
  '--no-session-persistence',
  // MCP wiring.
  '--mcp-config',
  '--strict-mcp-config',
  // Model and budget knobs, which have first-class config fields.
  '--model',
  '--effort',
  '--max-turns',
  '--max-budget-usd',
  // System prompt composition.
  '--append-system-prompt-file',
  '--append-system-prompt',
  '--system-prompt',
  '--system-prompt-file',
  // Permission posture and tool policy.
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--tools',
  '--add-dir',
  '--settings',
  '--setting-sources',
  // Execution location / detachment, which would take the run out of Agent HQ's
  // control entirely.
  '--worktree',
  '--bg',
  '--background',
  '--remote-control',
];

/**
 * Bare words that select a CLI subcommand instead of running a prompt (verified
 * against `claude --help` on 2.1.220). Appended to argv these hijack the whole
 * invocation: `claude --print - ... mcp` manages MCP servers, it does not run
 * the agent.
 */
export const DISALLOWED_EXTRA_ARG_VALUES: ReadonlySet<string> = new Set([
  'agents',
  'auth',
  'auto-mode',
  'doctor',
  'gateway',
  'install',
  'mcp',
  'plugin',
  'plugins',
  'project',
  'setup-token',
  'ultrareview',
  'update',
  'upgrade',
]);

// ── Field tables ─────────────────────────────────────────────────────────────

const STRING_FIELDS = [
  'workingDirectory',
  'claudeBin',
  'model',
  'systemPromptSuffix',
  'claudeConfigDir',
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

  if (config.effort != null && !isOneOf(CLAUDE_EFFORT_LEVELS, config.effort)) {
    return `runtime_config.effort must be one of: ${CLAUDE_EFFORT_LEVELS.join(', ')}`;
  }

  if (config.permissionMode != null && !isOneOf(CLAUDE_PERMISSION_MODES, config.permissionMode)) {
    return `runtime_config.permissionMode must be one of: ${CLAUDE_PERMISSION_MODES.join(', ')}`;
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

  const extraArgs = config.extraArgs;
  if (Array.isArray(extraArgs)) {
    for (const arg of extraArgs) {
      const trimmed = arg.trim();
      if (!trimmed) continue;
      const denied =
        DISALLOWED_EXTRA_ARG_PREFIXES.some(
          (prefix) => trimmed === prefix || trimmed.startsWith(`${prefix}=`),
        ) || DISALLOWED_EXTRA_ARG_VALUES.has(trimmed);
      if (denied) {
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

  return {
    workingDirectory: trimmedOrNull(config?.workingDirectory),
    claudeBin: trimmedOrNull(config?.claudeBin) ?? DEFAULT_CLAUDE_BIN,
    model: trimmedOrNull(config?.model),
    effort: config?.effort ?? null,
    allowedTools: copyStrings(config?.allowedTools),
    disallowedTools: copyStrings(config?.disallowedTools),
    maxTurns: config?.maxTurns ?? null,
    maxBudgetUsd: config?.maxBudgetUsd ?? null,
    permissionMode: config?.permissionMode ?? 'bypass',
    systemPromptSuffix: trimmedOrNull(config?.systemPromptSuffix),
    extraArgs: copyStrings(config?.extraArgs),
    env: config?.env ? { ...config.env } : {},
    killGraceMs: config?.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    claudeConfigDir: trimmedOrNull(config?.claudeConfigDir),
  };
}
