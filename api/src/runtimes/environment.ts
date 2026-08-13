/**
 * Build the ambient environment inherited by local runtime processes.
 *
 * The API process commonly owns database URLs, provider keys, webhook secrets,
 * and deployment credentials. Passing process.env wholesale to a model-driven
 * shell turns every one of those into an agent credential. Only ordinary
 * process/locale paths cross this boundary; signing-agent sockets are scrubbed
 * because using a non-exportable key is still an undeclared credential
 * capability. Runtime-specific identity and explicitly validated config values
 * are layered on by the adapter.
 */
const SAFE_RUNTIME_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // Windows process discovery and user-state paths.
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'LOCALAPPDATA',
  'APPDATA',
  'USERPROFILE',
]);

/**
 * Environment variables that agent-owned runtime_config may never override.
 *
 * These values control executable discovery, the effective user/config home,
 * shell startup, dynamic loading, or language package resolution. Letting an
 * agent change any of them would let an otherwise approved `claude` or `codex`
 * launch resolve attacker-controlled code before the adapter's policy applies.
 * Values are stored uppercase and checked case-insensitively for Windows and
 * for hosts that preserve oddly-cased environment keys.
 */
export const PROTECTED_RUNTIME_CONFIG_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SHELL',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'PWD',
  'OLDPWD',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_OPTIONS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'SSLKEYLOGFILE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_PATH',
  'PYTHONPATH',
]);

/** Return whether a runtime_config environment key crosses a shared boundary. */
export function isProtectedRuntimeConfigEnvKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  return PROTECTED_RUNTIME_CONFIG_ENV_KEYS.has(normalized)
    || /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/.test(normalized);
}

export function sanitizedRuntimeProcessEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SAFE_RUNTIME_ENV_KEYS.has(key.toUpperCase()) || key.toUpperCase().startsWith('LC_')) {
      result[key] = value;
    }
  }
  return result;
}

export function buildRuntimeChildEnv(
  overrides: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...sanitizedRuntimeProcessEnv(source), ...overrides };
}

/**
 * The subset of dispatch params that identifies a run to the agent process.
 *
 * Declared structurally rather than importing DispatchParams so this module
 * stays a leaf: every runtime adapter imports it, and none of them should have
 * to pull the dispatch type graph in to build an environment.
 */
export interface RuntimeRunIdentity {
  instanceId?: number | null;
  durableRunId?: string | null;
  taskId?: number | null;
  sessionKey: string;
  agentSlug: string;
  workspaceRoot?: string | null;
  activeRepoRoot?: string | null;
}

/**
 * The AGENT_HQ_* run identity handed to every locally spawned agent process.
 *
 * Built here rather than per adapter so a new run-identity variable is one edit
 * that every runtime picks up, instead of an edit per adapter plus whichever
 * one the author forgot.
 */
export function buildRunIdentityEnv(
  params: RuntimeRunIdentity,
  cwd: string,
): Record<string, string> {
  return {
    AGENT_HQ_INSTANCE_ID: params.instanceId != null ? String(params.instanceId) : '',
    AGENT_HQ_DURABLE_RUN_ID: params.durableRunId ?? '',
    AGENT_HQ_TASK_ID: params.taskId != null ? String(params.taskId) : '',
    AGENT_HQ_SESSION_KEY: params.sessionKey,
    AGENT_HQ_AGENT_SLUG: params.agentSlug,
    AGENT_HQ_WORKSPACE_ROOT: params.workspaceRoot ?? cwd,
    AGENT_HQ_ACTIVE_REPO_ROOT: params.activeRepoRoot ?? cwd,
  };
}

/**
 * Named layers composing the environment of a locally spawned agent process.
 *
 * Each layer has a different origin and a different trust level, and naming
 * them is the point: precedence used to be re-derived by hand in every adapter
 * from the order of object spreads, which is how one adapter ended up letting
 * agent config overwrite its own run identity.
 */
export interface AgentRuntimeEnvLayers {
  /** Operator-declared runtime_config.env. Validated, and never secrets. */
  agentConfig?: Record<string, string> | null;
  /**
   * Credentials resolved at dispatch for this run only.
   *
   * These never enter runtime_config, so the credential guard that keeps
   * secrets out of stored config needs no exception for them.
   */
  injectedSecrets?: Record<string, string> | null;
  /** AGENT_HQ_* truth about this run, from buildRunIdentityEnv(). */
  runIdentity?: Record<string, string> | null;
  /** Adapter-owned launch settings, e.g. CLAUDE_CONFIG_DIR / CODEX_HOME. */
  adapterOwned?: Record<string, string> | null;
}

/**
 * Compose the environment for a locally spawned agent process.
 *
 * Precedence, lowest to highest:
 *   1. ambient  — the allowlisted host environment; everything the API process
 *      holds beyond that list is dropped rather than handed to a model-driven shell
 *   2. agentConfig — what the agent record declares
 *   3. injectedSecrets — outranks agent config so a stored config cannot shadow
 *      the credential the platform resolved for this run
 *   4. runIdentity — must not be forgeable by anything above it
 *   5. adapterOwned — last, so the validated launch home can never be retargeted
 *
 * Runtimes that do not spawn a child process (OpenClaw dispatches over the
 * gateway websocket to an already-running daemon) have no use for this: there
 * is no process being created whose environment Agent HQ controls.
 */
export function buildAgentRuntimeEnv(
  layers: AgentRuntimeEnvLayers,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...sanitizedRuntimeProcessEnv(source),
    ...(layers.agentConfig ?? {}),
    ...(layers.injectedSecrets ?? {}),
    ...(layers.runIdentity ?? {}),
    ...(layers.adapterOwned ?? {}),
  };
}
