import {
  CODEX_APPROVAL_POLICIES,
  CODEX_REASONING_EFFORTS,
  CODEX_SANDBOX_MODES,
  DEFAULT_CODEX_BIN,
  DEFAULT_KILL_GRACE_MS,
  type CodexRuntimeConfig,
  type NormalizedCodexRuntimeConfig,
} from './types';
import { validateRuntimeExecutable } from '../executablePolicy';
import { isProtectedRuntimeConfigEnvKey } from '../environment';

/** Adapter-owned flags and subcommands may not be changed through extraArgs. */
export const DISALLOWED_CODEX_EXTRA_ARG_PREFIXES: readonly string[] = [
  '--ask-for-approval',
  '-a',
  '--full-auto',
  '--json',
  '--color',
  '--strict-config',
  '--config',
  '-c',
  '--model',
  '-m',
  '--sandbox',
  '-s',
  '--cd',
  '-C',
  '--skip-git-repo-check',
  '--add-dir',
  '--oss',
  '--local-provider',
  '--image',
  '-i',
  '--ignore-rules',
  '--enable',
  '--disable',
  '--search',
  '--web-search',
  '--ephemeral',
  '--ignore-user-config',
  '--profile',
  '-p',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--output-last-message',
  '-o',
  '--output-schema',
];

export const DISALLOWED_CODEX_EXTRA_ARG_VALUES: ReadonlySet<string> = new Set([
  'exec',
  'resume',
  'review',
  'login',
  'logout',
  'mcp',
  'app-server',
  'cloud',
  'completion',
  'debug',
  'features',
  'fork',
  'apply',
]);

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function trim(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result || null;
}

export function validateCodexRuntimeConfig(
  config: CodexRuntimeConfig | null | undefined,
): string | null {
  if (config == null) return null;
  if (typeof config !== 'object' || Array.isArray(config)) {
    return 'runtime_config must be an object';
  }

  for (const field of [
    'workingDirectory',
    'codexBin',
    'model',
    'codexHomeRoot',
    'codexHome',
    'providerConnectionExternalRef',
    'resumeSessionId',
  ] as const) {
    if (config[field] != null && typeof config[field] !== 'string') {
      return `runtime_config.${field} must be a string`;
    }
  }

  const executableError = validateRuntimeExecutable('codex', config.codexBin);
  if (executableError) return executableError;

  if (
    config.reasoningEffort != null &&
    !oneOf(CODEX_REASONING_EFFORTS, config.reasoningEffort)
  ) {
    return `runtime_config.reasoningEffort must be one of: ${CODEX_REASONING_EFFORTS.join(', ')}`;
  }
  if (config.sandboxMode != null && !oneOf(CODEX_SANDBOX_MODES, config.sandboxMode)) {
    return `runtime_config.sandboxMode must be one of: ${CODEX_SANDBOX_MODES.join(', ')}`;
  }
  if (
    config.approvalPolicy != null &&
    !oneOf(CODEX_APPROVAL_POLICIES, config.approvalPolicy)
  ) {
    return `runtime_config.approvalPolicy must be one of: ${CODEX_APPROVAL_POLICIES.join(', ')}`;
  }

  for (const field of [
    'allowDangerousFullAccess',
    'skipGitRepoCheck',
  ] as const) {
    if (config[field] != null && typeof config[field] !== 'boolean') {
      return `runtime_config.${field} must be a boolean`;
    }
  }

  if (
    config.sandboxMode === 'danger-full-access' &&
    config.allowDangerousFullAccess !== true
  ) {
    return 'runtime_config.allowDangerousFullAccess must be true when sandboxMode is danger-full-access';
  }

  if (
    config.killGraceMs != null &&
    (typeof config.killGraceMs !== 'number' ||
      !Number.isFinite(config.killGraceMs) ||
      config.killGraceMs < 0)
  ) {
    return 'runtime_config.killGraceMs must be a non-negative number';
  }

  if (config.extraArgs != null) {
    if (!Array.isArray(config.extraArgs) || config.extraArgs.some((arg) => typeof arg !== 'string')) {
      return 'runtime_config.extraArgs must be an array of strings';
    }
    if (config.extraArgs.some((arg) => arg.trim().length > 0)) {
      return 'Codex runtime extraArgs are disabled by the hardened adapter; add a validated first-class config field instead';
    }
    for (const raw of config.extraArgs) {
      const arg = raw.trim();
      if (!arg) continue;
      if (!arg.startsWith('-')) {
        return `Codex runtime extraArgs entries must be option flags, got ${JSON.stringify(arg)}`;
      }
      if (
        DISALLOWED_CODEX_EXTRA_ARG_VALUES.has(arg) ||
        DISALLOWED_CODEX_EXTRA_ARG_PREFIXES.some(
          (prefix) => arg === prefix || arg.startsWith(`${prefix}=`),
        )
      ) {
        return `Codex runtime does not allow extraArgs entry ${JSON.stringify(arg)}`;
      }
    }
  }

  if (config.env != null) {
    if (typeof config.env !== 'object' || Array.isArray(config.env)) {
      return 'runtime_config.env must be an object of string environment values';
    }
    if (Object.values(config.env).some((value) => typeof value !== 'string')) {
      return 'runtime_config.env values must be strings';
    }
    for (const key of Object.keys(config.env)) {
      const normalized = key.trim().toUpperCase();
      const protectedKey =
        normalized === 'CODEX_HOME' ||
        normalized.startsWith('AGENT_HQ_') ||
        normalized.startsWith('OPENAI_') ||
        normalized.startsWith('CODEX_') ||
        isProtectedRuntimeConfigEnvKey(normalized);
      if (protectedKey) {
        return `runtime_config.env may not set protected or credential variable ${JSON.stringify(key)}`;
      }
    }
  }

  return null;
}

export function normalizeCodexRuntimeConfig(
  config: CodexRuntimeConfig | null | undefined,
): NormalizedCodexRuntimeConfig {
  const error = validateCodexRuntimeConfig(config);
  if (error) throw new Error(error);
  return {
    workingDirectory: trim(config?.workingDirectory),
    codexBin: trim(config?.codexBin) ?? DEFAULT_CODEX_BIN,
    model: trim(config?.model),
    reasoningEffort: config?.reasoningEffort ?? null,
    sandboxMode: config?.sandboxMode ?? 'workspace-write',
    approvalPolicy: config?.approvalPolicy ?? 'never',
    allowDangerousFullAccess: config?.allowDangerousFullAccess ?? false,
    skipGitRepoCheck: config?.skipGitRepoCheck ?? false,
    codexHomeRoot: trim(config?.codexHomeRoot),
    codexHome: trim(config?.codexHome),
    providerConnectionExternalRef: trim(config?.providerConnectionExternalRef),
    resumeSessionId: trim(config?.resumeSessionId),
    extraArgs: Array.isArray(config?.extraArgs) ? [...config.extraArgs] : [],
    env: config?.env ? { ...config.env } : {},
    killGraceMs: config?.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
  };
}
