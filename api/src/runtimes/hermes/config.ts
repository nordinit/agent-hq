export interface HermesRuntimeConfig {
  hermesBin?: string;
  profile?: string;
  hermesHome?: string;
  invocationMode?: "z" | "chat-q";
  sessionMode?: "fresh";
  provider?: string | null;
  model?: string | null;
  fastMode?: boolean | null;
  workingDirectory?: string;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  extraArgs?: string[];
  env?: Record<string, string>;
  heartbeatIntervalMs?: number;
  killGraceMs?: number;
  [key: string]: unknown;
}

export interface NormalizedHermesRuntimeConfig {
  hermesBin: string;
  profile: string;
  hermesHome?: string;
  invocationMode: "z" | "chat-q";
  sessionMode: "fresh";
  provider: string | null;
  model: string | null;
  fastMode: boolean | null;
  workingDirectory?: string;
  ignoreUserConfig: boolean;
  ignoreRules: boolean;
  extraArgs: string[];
  env: Record<string, string>;
  heartbeatIntervalMs: number;
  killGraceMs: number;
}

const DEFAULT_HERMES_BIN = "hermes";
const REMOVED_HERMES_LIFECYCLE_FIELD = "lifecycle" + "Mode";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 10_000;
const DISALLOWED_EXTRA_ARG_PREFIXES = [
  "--resume",
  "--continue",
  "--worktree",
  "--profile",
  "-p",
  "-z",
];
const DISALLOWED_EXTRA_ARG_VALUES = new Set([
  "chat",
  "gateway",
  "acp",
  "sessions",
  "tools",
  "skills",
  "config",
  "model",
  "auth",
]);

export function validateHermesRuntimeConfig(
  config: HermesRuntimeConfig | null | undefined,
): string | null {
  const profile =
    typeof config?.profile === "string" ? config.profile.trim() : "";
  if (!profile) return "runtime_config.profile is required for hermes runtime";

  if (config?.[REMOVED_HERMES_LIFECYCLE_FIELD] != null) {
    return "removed Hermes lifecycle mode config is no longer supported; use Agent HQ MCP/capability lifecycle tools instead";
  }

  if (config?.sessionMode != null && config.sessionMode !== "fresh") {
    return 'Hermes runtime only supports runtime_config.sessionMode="fresh" in V1';
  }

  if (
    config?.invocationMode != null &&
    config.invocationMode !== "z" &&
    config.invocationMode !== "chat-q"
  ) {
    return 'Hermes runtime only supports runtime_config.invocationMode of "z" or "chat-q"';
  }

  if (
    config?.heartbeatIntervalMs != null &&
    (!Number.isFinite(config.heartbeatIntervalMs) ||
      config.heartbeatIntervalMs < 0)
  ) {
    return "runtime_config.heartbeatIntervalMs must be a non-negative number";
  }

  if (
    config?.killGraceMs != null &&
    (!Number.isFinite(config.killGraceMs) || config.killGraceMs < 0)
  ) {
    return "runtime_config.killGraceMs must be a non-negative number";
  }

  if (config?.fastMode != null && typeof config.fastMode !== "boolean") {
    return "runtime_config.fastMode must be a boolean when provided";
  }

  const extraArgs = config?.extraArgs;
  if (extraArgs != null) {
    if (
      !Array.isArray(extraArgs) ||
      extraArgs.some((value) => typeof value !== "string")
    ) {
      return "runtime_config.extraArgs must be an array of strings";
    }

    for (const arg of extraArgs) {
      const trimmed = arg.trim();
      if (!trimmed) continue;
      if (
        DISALLOWED_EXTRA_ARG_PREFIXES.some(
          (prefix) => trimmed === prefix || trimmed.startsWith(`${prefix}=`),
        )
      ) {
        return `Hermes runtime does not allow extraArgs entry ${JSON.stringify(trimmed)} in V1`;
      }
      if (DISALLOWED_EXTRA_ARG_VALUES.has(trimmed)) {
        return `Hermes runtime does not allow extraArgs entry ${JSON.stringify(trimmed)} in V1`;
      }
    }
  }

  if (config?.env != null) {
    if (typeof config.env !== "object" || Array.isArray(config.env)) {
      return "runtime_config.env must be an object of string environment values";
    }
    for (const [key, value] of Object.entries(config.env)) {
      if (typeof value !== "string") {
        return `runtime_config.env.${key} must be a string`;
      }
    }
  }

  return null;
}

export function normalizeHermesRuntimeConfig(
  config: HermesRuntimeConfig | null | undefined,
): NormalizedHermesRuntimeConfig {
  const validationError = validateHermesRuntimeConfig(config);
  if (validationError) throw new Error(validationError);

  return {
    hermesBin:
      typeof config?.hermesBin === "string" && config.hermesBin.trim()
        ? config.hermesBin.trim()
        : DEFAULT_HERMES_BIN,
    profile: String(config?.profile).trim(),
    hermesHome:
      typeof config?.hermesHome === "string" && config.hermesHome.trim()
        ? config.hermesHome.trim()
        : undefined,
    invocationMode: config?.invocationMode === "chat-q" ? "chat-q" : "z",
    sessionMode: "fresh",
    provider:
      typeof config?.provider === "string" && config.provider.trim()
        ? config.provider.trim()
        : null,
    model:
      typeof config?.model === "string" && config.model.trim()
        ? config.model.trim()
        : null,
    fastMode: typeof config?.fastMode === "boolean" ? config.fastMode : null,
    workingDirectory:
      typeof config?.workingDirectory === "string" &&
      config.workingDirectory.trim()
        ? config.workingDirectory.trim()
        : undefined,
    ignoreUserConfig: config?.ignoreUserConfig === true,
    ignoreRules: config?.ignoreRules === true,
    extraArgs: Array.isArray(config?.extraArgs) ? [...config.extraArgs] : [],
    env: config?.env ? { ...config.env } : {},
    heartbeatIntervalMs:
      config?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    killGraceMs: config?.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
  };
}
