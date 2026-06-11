import { getDb } from '../db/client';
import { OPENCLAW_CONFIG_PATH, OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_WS_URL, resolveDefaultGatewayUrl } from '../config';
import fs from 'fs';

export type GatewayRuntimeHint = 'powershell' | 'wsl' | 'macos' | 'linux' | 'external';

const GATEWAY_WS_URL_KEY = 'gateway_ws_url';
const GATEWAY_RUNTIME_HINT_KEY = 'gateway_runtime_hint';
const GATEWAY_AUTH_TOKEN_KEY = 'gateway_auth_token';

function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setSetting(key: string, value: string | null): void {
  const db = getDb();
  if (value === null) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

export function normalizeGatewayUrl(raw: string | undefined, target: 'http' | 'ws'): string {
  const fallback = raw
    ? (target === 'http' ? OPENCLAW_GATEWAY_URL : OPENCLAW_GATEWAY_WS_URL)
    : resolveDefaultGatewayUrl(target);
  try {
    const parsed = new URL(raw ?? fallback);
    if (target === 'http') {
      if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
      else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
      else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    } else {
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return fallback;
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

export function getConfiguredGatewayWsUrl(): string {
  const stored = getSetting(GATEWAY_WS_URL_KEY);
  return normalizeGatewayUrl(stored ?? OPENCLAW_GATEWAY_WS_URL, 'ws');
}

export function getConfiguredGatewayHttpUrl(): string {
  return normalizeGatewayUrl(getConfiguredGatewayWsUrl(), 'http');
}

function readLocalGatewayTokenFromConfig(): string | null {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw) as { gateway?: { auth?: { token?: unknown } } };
    const token = cfg.gateway?.auth?.token;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

export function getGatewayRuntimeHint(): GatewayRuntimeHint {
  const stored = (getSetting(GATEWAY_RUNTIME_HINT_KEY) ?? '').trim().toLowerCase();
  switch (stored) {
    case 'powershell':
    case 'wsl':
    case 'macos':
    case 'linux':
    case 'external':
      return stored;
    default:
      return process.platform === 'win32' ? 'powershell' : process.platform === 'darwin' ? 'macos' : 'linux';
  }
}

export function getConfiguredGatewayAuthToken(): string {
  const stored = (getSetting(GATEWAY_AUTH_TOKEN_KEY) ?? '').trim();
  if (stored) return stored;

  const runtimeHint = getGatewayRuntimeHint();
  if (runtimeHint === 'powershell' || runtimeHint === 'macos' || runtimeHint === 'linux') {
    return readLocalGatewayTokenFromConfig() ?? '';
  }

  return '';
}

export function saveGatewaySettings(input: {
  wsUrl: string;
  runtimeHint: GatewayRuntimeHint;
  authToken?: string | null;
}): {
  wsUrl: string;
  httpUrl: string;
  runtimeHint: GatewayRuntimeHint;
  authToken: string;
} {
  const wsUrl = normalizeGatewayUrl(input.wsUrl, 'ws');
  setSetting(GATEWAY_WS_URL_KEY, wsUrl);
  setSetting(GATEWAY_RUNTIME_HINT_KEY, input.runtimeHint);
  const normalizedToken = typeof input.authToken === 'string' ? input.authToken.trim() : '';
  setSetting(GATEWAY_AUTH_TOKEN_KEY, normalizedToken || null);
  return {
    wsUrl,
    httpUrl: normalizeGatewayUrl(wsUrl, 'http'),
    runtimeHint: input.runtimeHint,
    authToken: getConfiguredGatewayAuthToken(),
  };
}

export function readGatewaySettings(): {
  wsUrl: string;
  httpUrl: string;
  runtimeHint: GatewayRuntimeHint;
  authToken: string;
  authTokenConfigured: boolean;
  authTokenSource: 'stored' | 'local' | 'none';
  source: 'stored' | 'default';
} {
  const storedUrl = getSetting(GATEWAY_WS_URL_KEY);
  const storedToken = (getSetting(GATEWAY_AUTH_TOKEN_KEY) ?? '').trim();
  const wsUrl = getConfiguredGatewayWsUrl();
  const authToken = getConfiguredGatewayAuthToken();
  const runtimeHint = getGatewayRuntimeHint();
  return {
    wsUrl,
    httpUrl: normalizeGatewayUrl(wsUrl, 'http'),
    runtimeHint,
    authToken,
    authTokenConfigured: authToken.length > 0,
    authTokenSource: storedToken
      ? 'stored'
      : ((runtimeHint === 'powershell' || runtimeHint === 'macos' || runtimeHint === 'linux') && authToken ? 'local' : 'none'),
    source: storedUrl ? 'stored' : 'default',
  };
}
