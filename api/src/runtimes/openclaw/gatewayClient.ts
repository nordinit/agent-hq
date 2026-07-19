import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';
import {
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_GATEWAY_URL,
  OPENCLAW_GATEWAY_WS_URL,
} from '../../config';
import { openClawGatewayWsOptions } from '../../lib/openclawGatewayWs';
import { resolveOpenClawGatewayProtocolVersion } from '../../lib/openclawGatewayProtocol';

export const GATEWAY_URL = OPENCLAW_GATEWAY_URL;
export const GATEWAY_WS_URL = OPENCLAW_GATEWAY_WS_URL;

export interface DeviceIdentity {
  version: number;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

export interface GatewayRpcCallResult {
  ok: boolean;
  payload?: unknown;
  result?: unknown;
  error?: string;
}

type GatewayResponseFrame = Record<string, unknown>;

type PendingGatewayCall = {
  method: string;
  resolve: (frame: GatewayResponseFrame) => void;
  reject: (err: Error) => void;
};

const GATEWAY_SOCKET_DISCONNECTED_ERROR = 'Gateway WebSocket disconnected before response';

class GatewayConnectionDropError extends Error {
  constructor(message = GATEWAY_SOCKET_DISCONNECTED_ERROR) {
    super(message);
    this.name = 'GatewayConnectionDropError';
  }
}

class GatewayConnectionPool {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private authPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingGatewayCall>();

  async call(params: {
    method: string;
    rpcParams?: Record<string, unknown>;
    timeoutMs?: number;
    displayName?: string;
  }): Promise<GatewayResponseFrame> {
    let timedOut = false;
    let timeout: NodeJS.Timeout | null = null;

    const callPromise = (async () => {
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            return await this.callOnce(params);
          } catch (err) {
            if (timedOut || attempt > 0 || !(err instanceof GatewayConnectionDropError)) {
              throw err;
            }
          }
        }
        throw new GatewayConnectionDropError();
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    })();

    const timeoutPromise = new Promise<GatewayResponseFrame>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        reject(new Error('Gateway WebSocket timeout'));
        this.reset();
      }, params.timeoutMs ?? 30_000);
    });

    return Promise.race([callPromise, timeoutPromise]);
  }

  reset(): void {
    this.failPending(new GatewayConnectionDropError());
    this.authenticated = false;
    this.authPromise = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
  }

  private async callOnce(params: {
    method: string;
    rpcParams?: Record<string, unknown>;
    displayName?: string;
  }): Promise<GatewayResponseFrame> {
    await this.ensureAuthenticated(params.displayName);
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new GatewayConnectionDropError();
    }
    return this.sendRpc(ws, params.method, params.rpcParams ?? {});
  }

  private sendRpc(
    ws: WebSocket,
    method: string,
    rpcParams: Record<string, unknown>,
  ): Promise<GatewayResponseFrame> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      this.pending.set(id, { method, resolve, reject });
      try {
        ws.send(JSON.stringify({
          type: 'req',
          id,
          method,
          params: rpcParams,
        }));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new GatewayConnectionDropError(String(err)));
      }
    });
  }

  private ensureAuthenticated(displayName?: string): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.authenticated) {
      return Promise.resolve();
    }
    if (this.authPromise) return this.authPromise;

    this.authenticated = false;
    const ws = new WebSocket(GATEWAY_WS_URL, openClawGatewayWsOptions(GATEWAY_WS_URL));
    this.ws = ws;

    this.authPromise = new Promise((resolve, reject) => {
      const rejectAuth = (err: Error) => {
        if (this.ws === ws) {
          this.authenticated = false;
          this.authPromise = null;
          this.ws = null;
        }
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
        reject(err);
      };

      ws.on('error', (err) => {
        if (this.ws === ws) {
          this.failPending(new GatewayConnectionDropError(`WebSocket error: ${err.message}`));
        }
        rejectAuth(new GatewayConnectionDropError(`WebSocket error: ${err.message}`));
      });

      ws.on('close', () => {
        if (this.ws !== ws) return;
        this.authenticated = false;
        this.authPromise = null;
        this.ws = null;
        this.failPending(new GatewayConnectionDropError());
        reject(new GatewayConnectionDropError());
      });

      ws.on('message', async (raw) => {
        let frame: GatewayResponseFrame;
        try {
          frame = JSON.parse(raw.toString()) as GatewayResponseFrame;
        } catch {
          return;
        }

        if (frame.type === 'res' && typeof frame.id === 'string') {
          const handler = this.pending.get(frame.id);
          if (handler) {
            this.pending.delete(frame.id);
            handler.resolve(frame);
          }
          return;
        }

        if (frame.type !== 'event' || frame.event !== 'connect.challenge') return;

        try {
          const payload = frame.payload as Record<string, unknown> | undefined;
          const nonce = (payload?.nonce as string) ?? '';
          const connectResult = await this.sendRpc(
            ws,
            'connect',
            buildOpenClawGatewayConnectParams({
              nonce,
              displayName: displayName ?? 'Agent HQ Runtime',
            }),
          );

          if (connectResult.error) {
            rejectAuth(new Error(`Gateway connect failed: ${formatGatewayRpcError(connectResult.error)}`));
            return;
          }

          if (this.ws === ws) {
            this.authenticated = true;
            this.authPromise = null;
          }
          resolve();
        } catch (err) {
          rejectAuth(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    return this.authPromise;
  }

  private failPending(err: Error): void {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const call of pending) {
      call.reject(err);
    }
  }
}

const gatewayConnectionPool = new GatewayConnectionPool();

export function __resetGatewayConnectionPoolForTests(): void {
  gatewayConnectionPool.reset();
}

export function readGatewayTokenFromConfig(): string | null {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw) as { gateway?: { auth?: { token?: string } } };
    const token = cfg.gateway?.auth?.token;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

export function readHooksTokenFromConfig(): string | null {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw) as { hooks?: { token?: string } };
    const token = cfg.hooks?.token;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

export function getGatewayAuthToken(): string {
  return process.env.OPENCLAW_GATEWAY_TOKEN ?? readGatewayTokenFromConfig() ?? '';
}

export function getHooksToken(): string {
  return process.env.OPENCLAW_HOOKS_TOKEN ?? readHooksTokenFromConfig() ?? '';
}

export function gatewayFetch(hookPath: string, init: RequestInit): Promise<Response> {
  const url = `${GATEWAY_URL}${hookPath}`;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return fetch(url, init);
}

export function loadDeviceIdentity(): DeviceIdentity | null {
  try {
    const identityPath = path.join(os.homedir(), '.openclaw', 'identity', 'device.json');
    const raw = fs.readFileSync(identityPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKeyPem === 'string' && typeof parsed.privateKeyPem === 'string') {
      return parsed as DeviceIdentity;
    }
    return null;
  } catch {
    return null;
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

export function publicKeyRawBase64Url(publicKeyPem: string): string {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer;
  if (spki.length >= 44) return base64UrlEncode(spki.slice(spki.length - 32));
  return base64UrlEncode(spki);
}

export function signPayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(signature as Buffer);
}

function formatGatewayRpcError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') return JSON.stringify(error);
  return String(error ?? 'unknown error');
}

export function buildOpenClawGatewayConnectParams(params: {
  nonce: string;
  displayName: string;
  instanceId?: string;
}): Record<string, unknown> {
  const role = 'operator';
  const scopes = ['operator.read', 'operator.write', 'operator.admin'];
  const signedAtMs = Date.now();
  const gatewayAuthToken = getGatewayAuthToken();
  const deviceIdentity = loadDeviceIdentity();

  let device: Record<string, unknown> | undefined;
  if (deviceIdentity) {
    const sigPayload = [
      'v3', deviceIdentity.deviceId, 'gateway-client', 'ui',
      role, scopes.join(','), String(signedAtMs),
      gatewayAuthToken, params.nonce, process.platform, '',
    ].join('|');
    device = {
      id: deviceIdentity.deviceId,
      publicKey: publicKeyRawBase64Url(deviceIdentity.publicKeyPem),
      signature: signPayload(deviceIdentity.privateKeyPem, sigPayload),
      signedAt: signedAtMs,
      nonce: params.nonce,
    };
  }

  return {
    minProtocol: resolveOpenClawGatewayProtocolVersion(),
    maxProtocol: resolveOpenClawGatewayProtocolVersion(),
    client: {
      id: 'gateway-client',
      displayName: params.displayName,
      version: '1.0.0',
      platform: process.platform,
      mode: 'ui',
      instanceId: params.instanceId ?? crypto.randomUUID(),
    },
    caps: [],
    role,
    scopes,
    auth: { token: gatewayAuthToken },
    ...(device ? { device } : {}),
  };
}

export function gatewayRpcCall(params: {
  method: string;
  rpcParams?: Record<string, unknown>;
  timeoutMs?: number;
  displayName?: string;
}): Promise<GatewayRpcCallResult> {
  return gatewayConnectionPool.call(params)
    .then((rpcResult) => {
      if (rpcResult.error) {
        return { ok: false, error: `${params.method} failed: ${formatGatewayRpcError(rpcResult.error)}` };
      }
      return {
        ok: true,
        payload: rpcResult.payload,
        result: rpcResult.result,
      };
    })
    .catch((err) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
}

export async function reloadOpenClawSecretsRuntimeForAuthSync(): Promise<{ ok: boolean; message: string }> {
  const result = await gatewayRpcCall({
    method: 'secrets.reload',
    timeoutMs: 30_000,
    displayName: 'Agent HQ Auth Profile Reload',
  });
  if (!result.ok) {
    return { ok: false, message: result.error ?? 'unknown error' };
  }

  const payload = (result.payload ?? result.result) as Record<string, unknown> | undefined;
  const warningCount = typeof payload?.warningCount === 'number' ? payload.warningCount : null;
  return {
    ok: true,
    message: warningCount === null
      ? 'OpenClaw secrets runtime reloaded.'
      : `OpenClaw secrets runtime reloaded (${warningCount} warning(s)).`,
  };
}

function normalizeOpenClawThinkingLevel(thinking: string | null | undefined): string | null {
  const normalized = thinking?.trim();
  if (!normalized || normalized === 'adaptive') return null;
  return normalized;
}

function normalizeOpenClawModel(model: string | null | undefined): string | null {
  const normalized = model?.trim();
  return normalized || null;
}

function normalizeOpenClawFastMode(fastMode: boolean | null | undefined): boolean | null {
  return typeof fastMode === 'boolean' ? fastMode : null;
}

export async function gatewayWsPatchSession(params: {
  sessionKey: string;
  model?: string | null;
  thinking?: string | null;
  fastMode?: boolean | null;
  timeoutMs?: number;
  force?: boolean;
}): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const model = normalizeOpenClawModel(params.model);
  const thinkingLevel = normalizeOpenClawThinkingLevel(params.thinking);
  const fastMode = normalizeOpenClawFastMode(params.fastMode);
  if (!params.force && !model && !thinkingLevel && fastMode === null) {
    return { ok: true, skipped: true };
  }

  const result = await gatewayRpcCall({
    method: 'sessions.patch',
    rpcParams: {
      key: params.sessionKey,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(fastMode !== null ? { fastMode } : {}),
    },
    timeoutMs: params.timeoutMs ?? 30_000,
    displayName: 'Agent HQ Runtime Config',
  });

  if (!result.ok) {
    return { ok: false, error: result.error ?? 'sessions.patch failed' };
  }
  return { ok: true };
}

function collectEffectiveToolNames(payload: unknown): string[] {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    const hasChildTools = Array.isArray(record.tools);
    const hasChildGroups = Array.isArray(record.groups);
    if (!hasChildTools && !hasChildGroups) {
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      if (id) names.add(id);
      if (name) names.add(name);
    }
    if (hasChildTools) visit(record.tools);
    if (hasChildGroups) visit(record.groups);
  };
  visit(payload);
  return Array.from(names).sort();
}

function collectEffectiveToolNoticeIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const notices = Array.isArray(record.notices) ? record.notices : [];
  return notices
    .map((notice) => (
      notice && typeof notice === 'object' && typeof (notice as Record<string, unknown>).id === 'string'
        ? String((notice as Record<string, unknown>).id)
        : ''
    ))
    .filter(Boolean)
    .sort();
}

export async function gatewayWsGetEffectiveTools(params: {
  sessionKey: string;
  agentId?: string | null;
  timeoutMs?: number;
}): Promise<{
  ok: boolean;
  toolNames: string[];
  noticeIds: string[];
  raw?: unknown;
  error?: string;
}> {
  const result = await gatewayRpcCall({
    method: 'tools.effective',
    rpcParams: {
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
    },
    timeoutMs: params.timeoutMs ?? 20_000,
    displayName: 'Agent HQ MCP Readiness',
  });

  if (!result.ok) {
    return {
      ok: false,
      toolNames: [],
      noticeIds: [],
      error: result.error ?? 'tools.effective failed',
    };
  }

  const payload = result.payload ?? result.result;
  return {
    ok: true,
    toolNames: collectEffectiveToolNames(payload),
    noticeIds: collectEffectiveToolNoticeIds(payload),
    raw: payload,
  };
}

/**
 * Fetch history for a given session key from the gateway via WebSocket `chat.history` RPC.
 *
 * Reuses the shared authenticated operator socket, issues a chat.history
 * request, and waits for the matching response frame.
 *
 * Returns the raw message array on success; an empty array if the session
 * has no history or the call fails.
 */
export async function gatewayGetHistory(params: {
  sessionKey: string;
  limit?: number;
  timeoutMs?: number;
}): Promise<{ ok: boolean; messages: Array<Record<string, unknown>>; error?: string }> {
  const { sessionKey, limit = 200 } = params;
  const result = await gatewayRpcCall({
    method: 'chat.history',
    rpcParams: { sessionKey, limit },
    timeoutMs: params.timeoutMs ?? 20_000,
    displayName: 'Agent HQ',
  });

  if (!result.ok) {
    return { ok: false, messages: [], error: result.error ?? 'chat.history failed' };
  }

  const histPayload = result.payload as Record<string, unknown> | undefined ?? {};
  const msgs = Array.isArray(histPayload.messages) ? histPayload.messages : [];
  return { ok: true, messages: msgs as Array<Record<string, unknown>> };
}

/**
 * Send a single message to an agent via the gateway WebSocket `chat.send` RPC.
 *
 * Reuses the shared authenticated operator socket. This avoids the /hooks/agent
 * path entirely so no SECURITY NOTICE wrapping is applied.
 */
export async function gatewayWsSend(params: {
  sessionKey: string;
  message: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const { sessionKey, message, timeoutMs } = params;
  // systemInputProvenance is omitted because OpenClaw restricts it to ACP
  // bridge clients. chat.send bypasses the hooks wrapping pipeline.
  console.log('[runtime-ws] sending chat.send');
  const sendParams: Record<string, unknown> = {
    sessionKey,
    message,
    idempotencyKey: crypto.randomUUID(),
    timeoutMs: timeoutMs ?? 900_000,
  };

  const sendResult = await gatewayRpcCall({
    method: 'chat.send',
    rpcParams: sendParams,
    timeoutMs: 30_000,
    displayName: 'Agent HQ Runtime',
  });

  console.log('[runtime-ws] chat.send result', sendResult.error ? 'error' : 'ok');
  if (!sendResult.ok) {
    return { ok: false, error: sendResult.error ?? 'chat.send failed' };
  }

  const result = (sendResult.payload ?? sendResult.result) as Record<string, unknown> | undefined;
  return { ok: true, runId: (result?.runId as string) ?? '' };
}
