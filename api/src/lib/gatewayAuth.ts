import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getConfiguredGatewayAuthToken } from './gatewaySettings';

export interface GatewayDeviceIdentity {
  version: number;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

export function readGatewayTokenFromConfig(): string | null {
  const token = getConfiguredGatewayAuthToken();
  return token || null;
}

export function getGatewayAuthToken(): string {
  return (
    process.env.GATEWAY_TOKEN
    ?? process.env.OPENCLAW_GATEWAY_TOKEN
    ?? getConfiguredGatewayAuthToken()
    ?? ''
  );
}

export function loadGatewayDeviceIdentity(): GatewayDeviceIdentity | null {
  try {
    const identityPath = path.join(os.homedir(), '.openclaw', 'identity', 'device.json');
    const raw = fs.readFileSync(identityPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKeyPem === 'string' && typeof parsed.privateKeyPem === 'string') {
      return parsed as GatewayDeviceIdentity;
    }
    return null;
  } catch {
    return null;
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function publicKeyRawBase64Url(publicKeyPem: string): string {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer;
  if (spki.length >= 44) {
    return base64UrlEncode(spki.slice(spki.length - 32));
  }
  return base64UrlEncode(spki);
}

function signPayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(signature as Buffer);
}

export function buildDeviceForGatewayConnect(
  identity: GatewayDeviceIdentity,
  token: string,
  nonce: string,
  signedAtMs: number,
  role: string,
  scopes: string[],
): Record<string, unknown> {
  const payload = [
    'v3',
    identity.deviceId,
    'gateway-client',
    'ui',
    role,
    scopes.join(','),
    String(signedAtMs),
    token,
    nonce,
    process.platform,
    '',
  ].join('|');

  return {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
    signature: signPayload(identity.privateKeyPem, payload),
    signedAt: signedAtMs,
    nonce,
  };
}
