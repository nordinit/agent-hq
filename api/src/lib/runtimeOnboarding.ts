import type Database from 'better-sqlite3';
import { getAgentHqBaseUrl } from './agentHqBaseUrl';
import { probeGateway, type GatewayProbeResult } from './gatewayHealth';
import { normalizeGatewayUrl, readGatewaySettings, saveGatewaySettings } from './gatewaySettings';

export type RuntimeKind = 'openclaw' | 'hermes' | 'custom';
export type RuntimeHealthState = 'healthy' | 'unreachable' | 'unauthorized' | 'partial' | 'unsupported';

export type RuntimeConnectionConfig = {
  kind: RuntimeKind;
  endpoint: string;
  authToken?: string | null;
  label?: string | null;
};

export type RuntimeConnectionStatus = {
  kind: RuntimeKind;
  endpoint: string;
  auth_present: boolean;
  state: RuntimeHealthState;
  reachable: boolean;
  authorized: boolean;
  capabilities: string[];
  callback_ready: boolean;
  callback_url: string | null;
  repair_guidance: string[];
  checked_at: string;
  error: string | null;
};

const RUNTIME_CONNECTION_SETTING_KEY = 'onboarding.runtime_connection';
const OPENCLAW_CAPABILITIES = [
  'chat.send',
  'chat.history',
  'sessions.patch',
  'chat.abort',
  'transcript.capture',
  'agent_hq.lifecycle_callbacks',
];
const HERMES_CAPABILITIES = [
  'dispatch',
  'abort',
  'agent_hq.lifecycle_callbacks',
];
const CUSTOM_CAPABILITIES = [
  'dispatch',
  'agent_hq.lifecycle_callbacks',
];

function nowIso(): string {
  return new Date().toISOString();
}

function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

function parseSavedConfig(raw: string | null): RuntimeConnectionConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeConnectionConfig>;
    const kind = parsed.kind;
    const endpoint = typeof parsed.endpoint === 'string' ? parsed.endpoint.trim() : '';
    if ((kind === 'openclaw' || kind === 'hermes' || kind === 'custom') && endpoint) {
      return {
        kind,
        endpoint,
        authToken: typeof parsed.authToken === 'string' ? parsed.authToken : null,
        label: typeof parsed.label === 'string' ? parsed.label : null,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeEndpoint(kind: RuntimeKind, endpoint: string): string {
  if (kind === 'openclaw') return normalizeGatewayUrl(endpoint, 'ws');
  try {
    return new URL(endpoint).toString().replace(/\/$/, '');
  } catch {
    return endpoint.trim();
  }
}

export function readRuntimeConnectionConfig(db: Database.Database): RuntimeConnectionConfig | null {
  return parseSavedConfig(getSetting(db, RUNTIME_CONNECTION_SETTING_KEY));
}

export function saveRuntimeConnectionConfig(db: Database.Database, input: RuntimeConnectionConfig): RuntimeConnectionConfig {
  const normalized: RuntimeConnectionConfig = {
    kind: input.kind,
    endpoint: normalizeEndpoint(input.kind, input.endpoint),
    authToken: typeof input.authToken === 'string' && input.authToken.trim() ? input.authToken.trim() : null,
    label: typeof input.label === 'string' && input.label.trim() ? input.label.trim() : null,
  };
  setSetting(db, RUNTIME_CONNECTION_SETTING_KEY, JSON.stringify(normalized));

  if (normalized.kind === 'openclaw') {
    saveGatewaySettings({
      wsUrl: normalized.endpoint,
      runtimeHint: 'external',
      authToken: normalized.authToken,
    });
  }

  return normalized;
}

export function detectRuntimeConnectionConfig(): RuntimeConnectionConfig {
  const gateway = readGatewaySettings();
  return {
    kind: 'openclaw',
    endpoint: gateway.wsUrl,
    authToken: gateway.authTokenConfigured ? gateway.authToken : null,
    label: gateway.source === 'stored' ? 'Configured OpenClaw Gateway' : 'Local OpenClaw Gateway',
  };
}

function callbackUrl(): string | null {
  const base = getAgentHqBaseUrl();
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function callbackGuidance(callback: string | null): string[] {
  if (!callback) return ['Set AGENT_HQ_API_URL or AGENT_HQ_INTERNAL_BASE_URL to an HTTP(S) Agent HQ API URL reachable by the runtime.'];
  if (callback.includes('localhost') || callback.includes('127.0.0.1')) {
    return ['If the runtime is not on this host, set AGENT_HQ_API_URL to a network-reachable Agent HQ API URL before dispatching agents.'];
  }
  return [];
}

function mapGatewayProbe(config: RuntimeConnectionConfig, probe: GatewayProbeResult): RuntimeConnectionStatus {
  const callback = callbackUrl();
  const guidance = callbackGuidance(callback);
  let state: RuntimeHealthState = 'healthy';
  if (!probe.ok) {
    if (probe.state === 'auth_error' || probe.state === 'pairing_required') state = 'unauthorized';
    else state = 'unreachable';
  } else if (guidance.length > 0) {
    state = 'partial';
  }

  if (!probe.reachable) guidance.unshift('Start the OpenClaw gateway or update the runtime endpoint to the active gateway WebSocket URL.');
  if (probe.pairing_required) guidance.unshift('Pair Agent HQ with the OpenClaw gateway, then re-run the runtime check.');
  if (probe.state === 'auth_error') guidance.unshift('Paste the gateway auth token from the runtime owner into Agent HQ, then retry.');

  return {
    kind: 'openclaw',
    endpoint: config.endpoint,
    auth_present: Boolean(config.authToken),
    state,
    reachable: probe.reachable,
    authorized: probe.ok,
    capabilities: probe.ok ? OPENCLAW_CAPABILITIES : [],
    callback_ready: Boolean(callback) && guidance.length === 0,
    callback_url: callback,
    repair_guidance: guidance,
    checked_at: probe.checked_at,
    error: probe.error,
  };
}

async function httpRuntimeStatus(config: RuntimeConnectionConfig, capabilities: string[]): Promise<RuntimeConnectionStatus> {
  const callback = callbackUrl();
  const guidance = callbackGuidance(callback);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;

  try {
    const response = await fetch(`${config.endpoint.replace(/\/$/, '')}/health`, { headers, signal: AbortSignal.timeout(5000) });
    const reachable = response.status !== 0;
    const authorized = response.status !== 401 && response.status !== 403;
    if (!response.ok) {
      if (!authorized) guidance.unshift('Update the runtime token, then retry the runtime check.');
      else guidance.unshift('The runtime /health endpoint responded with an error; inspect runtime logs and retry.');
    }
    return {
      kind: config.kind,
      endpoint: config.endpoint,
      auth_present: Boolean(config.authToken),
      state: response.ok && guidance.length === 0 ? 'healthy' : authorized ? 'partial' : 'unauthorized',
      reachable,
      authorized,
      capabilities: response.ok ? capabilities : [],
      callback_ready: Boolean(callback) && guidance.length === 0,
      callback_url: callback,
      repair_guidance: guidance,
      checked_at: nowIso(),
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      kind: config.kind,
      endpoint: config.endpoint,
      auth_present: Boolean(config.authToken),
      state: 'unreachable',
      reachable: false,
      authorized: false,
      capabilities: [],
      callback_ready: Boolean(callback) && guidance.length === 0,
      callback_url: callback,
      repair_guidance: ['Start the runtime, verify the endpoint URL, then retry the runtime check.', ...guidance],
      checked_at: nowIso(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkRuntimeConnection(config: RuntimeConnectionConfig): Promise<RuntimeConnectionStatus> {
  const normalized = { ...config, endpoint: normalizeEndpoint(config.kind, config.endpoint) };
  if (normalized.kind === 'openclaw') {
    return mapGatewayProbe(normalized, await probeGateway(normalized.endpoint));
  }
  if (normalized.kind === 'hermes') return httpRuntimeStatus(normalized, HERMES_CAPABILITIES);
  return httpRuntimeStatus(normalized, CUSTOM_CAPABILITIES);
}

export function buildRuntimeConfigDefaults(db: Database.Database): Record<string, unknown> {
  const config = readRuntimeConnectionConfig(db);
  if (!config) return {};
  return {
    onboarding_runtime: {
      kind: config.kind,
      endpoint: config.endpoint,
      auth_present: Boolean(config.authToken),
    },
    ...(config.kind === 'openclaw' ? { gateway_ws_url: config.endpoint } : { baseUrl: config.endpoint }),
  };
}
