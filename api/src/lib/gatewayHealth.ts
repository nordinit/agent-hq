import { randomUUID } from 'crypto';
import { WebSocket as WsClient } from 'ws';
import { buildDeviceForGatewayConnect, getGatewayAuthToken, loadGatewayDeviceIdentity } from './gatewayAuth';
import { isPairingRequiredText } from './openclawAutoPair';
import { openClawGatewayWsOptions } from './openclawGatewayWs';
import { resolveOpenClawGatewayProtocolVersion } from './openclawGatewayProtocol';

export type GatewayProbeState = 'ready' | 'offline' | 'pairing_required' | 'auth_error' | 'timeout';

export interface GatewayProbeResult {
  ok: boolean;
  state: GatewayProbeState;
  reachable: boolean;
  pairing_required: boolean;
  checked_at: string;
  error: string | null;
}

function gatewayErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
    if (typeof record.code === 'string' && typeof record.details === 'string') {
      return `${record.code}: ${record.details}`;
    }
  }
  return fallback;
}

export async function probeGateway(wsUrl: string): Promise<GatewayProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let connectId: string | null = null;
    const ws = new WsClient(wsUrl, openClawGatewayWsOptions(wsUrl));

    const finish = (result: GatewayProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (ws.readyState === WsClient.OPEN || ws.readyState === WsClient.CONNECTING) {
        ws.close();
      }
      resolve(result);
    };

    const fail = (state: GatewayProbeState, error: string) => finish({
      ok: state === 'ready',
      state,
      reachable: state === 'ready',
      pairing_required: state === 'pairing_required',
      checked_at: new Date().toISOString(),
      error,
    });

    const timeout = setTimeout(() => {
      fail('timeout', `Timed out connecting to ${wsUrl}`);
    }, 10000);

    ws.on('error', (err) => {
      fail('offline', `WebSocket error: ${err.message}`);
    });

    ws.on('close', (_code, reason) => {
      if (!settled) {
        const message = reason.toString() || `Gateway connection closed for ${wsUrl}`;
        fail(isPairingRequiredText(message) ? 'pairing_required' : 'offline', message);
      }
    });

    ws.on('message', (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (frame.type === 'event' && frame.event === 'connect.challenge') {
        const payload = frame.payload as Record<string, unknown> | undefined;
        const nonce = (payload?.nonce as string) ?? '';
        const role = 'operator';
        const scopes = ['operator.read', 'operator.write', 'operator.admin'];
        const token = getGatewayAuthToken();
        const deviceIdentity = loadGatewayDeviceIdentity();
        const signedAtMs = Date.now();
        const device = deviceIdentity
          ? buildDeviceForGatewayConnect(deviceIdentity, token, nonce, signedAtMs, role, scopes)
          : undefined;
        connectId = randomUUID();
        ws.send(JSON.stringify({
          type: 'req',
          id: connectId,
          method: 'connect',
          params: {
            minProtocol: resolveOpenClawGatewayProtocolVersion(),
            maxProtocol: resolveOpenClawGatewayProtocolVersion(),
            client: {
              id: 'gateway-client',
              displayName: 'Agent HQ Gateway Probe',
              version: '1.0.0',
              platform: process.platform,
              mode: 'ui',
              instanceId: randomUUID(),
            },
            caps: [],
            role,
            scopes,
            auth: { token },
            ...(device ? { device } : {}),
          },
        }));
        return;
      }

      if (frame.type === 'res' && typeof frame.id === 'string' && frame.id === connectId) {
        if (frame.ok === true) {
          finish({
            ok: true,
            state: 'ready',
            reachable: true,
            pairing_required: false,
            checked_at: new Date().toISOString(),
            error: null,
          });
          return;
        }

        const error = gatewayErrorMessage(frame.error, 'Gateway connect failed');
        fail(isPairingRequiredText(error) ? 'pairing_required' : 'auth_error', error);
      }
    });
  });
}
