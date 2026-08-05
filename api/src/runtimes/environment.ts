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
