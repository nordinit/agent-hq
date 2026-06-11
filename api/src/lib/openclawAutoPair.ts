import fs from 'fs';
import os from 'os';
import path from 'path';
import { OPENCLAW_CONFIG_PATH } from '../config';
import { runOpenClawSync } from './openclawCli';

export interface AutoPairResult {
  ok: boolean;
  approved: boolean;
  localGateway: boolean;
  deviceId: string | null;
  requestId: string | null;
  message: string;
  stdout?: string;
  stderr?: string;
}

type PendingRequest = {
  requestId: string;
  deviceId: string | null;
  clientId: string | null;
  status: string | null;
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function makeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
  };
}

function runOpenClaw(args: string[]) {
  return runOpenClawSync(args, { timeout: 30000, env: makeEnv() });
}

function readGatewayTokenFromConfig(): string | null {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { gateway?: { auth?: { token?: unknown } } };
    const token = parsed.gateway?.auth?.token;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function loadGatewayToken(): string | null {
  const envToken = process.env.GATEWAY_TOKEN ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  if (typeof envToken === 'string' && envToken.trim()) return envToken.trim();
  return readGatewayTokenFromConfig();
}

function buildListArgs(gatewayToken: string | null): string[] {
  const args = ['devices', 'list', '--json'];
  if (gatewayToken) args.push('--token', gatewayToken);
  return args;
}

function buildApproveArgs(requestId: string, gatewayToken: string | null): string[] {
  const args = ['devices', 'approve', requestId, '--json'];
  if (gatewayToken) args.push('--token', gatewayToken);
  return args;
}

function collectPendingRequests(value: unknown, acc: PendingRequest[], inheritedPending = false): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPendingRequests(item, acc, inheritedPending);
    return;
  }
  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  const status =
    typeof record.status === 'string' ? record.status
      : typeof record.state === 'string' ? record.state
        : null;
  const isPending = inheritedPending || status === 'pending' || status === 'requested';
  const requestId =
    typeof record.requestId === 'string' ? record.requestId
      : typeof record.pendingRequestId === 'string' ? record.pendingRequestId
        : null;
  const deviceId =
    typeof record.deviceId === 'string' ? record.deviceId
      : record.device && typeof record.device === 'object' && typeof (record.device as Record<string, unknown>).id === 'string'
        ? ((record.device as Record<string, unknown>).id as string)
        : typeof record.id === 'string' && isPending
          ? record.id
          : null;
  const clientId =
    typeof record.clientId === 'string' ? record.clientId
      : record.client && typeof record.client === 'object' && typeof (record.client as Record<string, unknown>).id === 'string'
        ? ((record.client as Record<string, unknown>).id as string)
        : null;

  if (requestId) {
    acc.push({
      requestId,
      deviceId,
      clientId,
      status,
    });
  }

  for (const [key, nested] of Object.entries(record)) {
    const nestedPending = isPending || key === 'pending' || key === 'requests';
    collectPendingRequests(nested, acc, nestedPending);
  }
}

function loadLocalDeviceId(): string | null {
  try {
    const identityPath = path.join(os.homedir(), '.openclaw', 'identity', 'device.json');
    const raw = fs.readFileSync(identityPath, 'utf8');
    const parsed = JSON.parse(raw) as { deviceId?: unknown };
    return typeof parsed.deviceId === 'string' && parsed.deviceId.trim() ? parsed.deviceId.trim() : null;
  } catch {
    return null;
  }
}

export function isLocalGatewayTarget(target: string | null | undefined): boolean {
  if (!target || !target.trim()) return false;
  try {
    const parsed = new URL(target);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

export function isPairingRequiredText(text: string | null | undefined): boolean {
  const normalized = String(text ?? '').toLowerCase();
  return normalized.includes('pairing required') || normalized.includes('device identity required');
}

export function isPairingRequiredClose(code: number, reason: string | Buffer | Uint8Array | null | undefined): boolean {
  const reasonText = Buffer.isBuffer(reason)
    ? reason.toString('utf8')
    : reason instanceof Uint8Array
      ? Buffer.from(reason).toString('utf8')
      : String(reason ?? '');
  return code === 1008 && isPairingRequiredText(reasonText);
}

export function ensureLocalGatewayPairing(gatewayUrl: string | null | undefined): AutoPairResult {
  const localGateway = isLocalGatewayTarget(gatewayUrl);
  const deviceId = loadLocalDeviceId();
  const gatewayToken = loadGatewayToken();
  if (!localGateway) {
    return {
      ok: false,
      approved: false,
      localGateway: false,
      deviceId,
      requestId: null,
      message: 'Auto-pair skipped: gateway is not local loopback.',
    };
  }

  const pendingFrom = (stdout: string): PendingRequest[] => {
    const pending: PendingRequest[] = [];
    collectPendingRequests(parseJson(stdout), pending);
    return pending;
  };
  const selectCandidate = (pending: PendingRequest[]): PendingRequest | null =>
    (deviceId ? pending.find(entry => entry.deviceId === deviceId && entry.clientId === 'gateway-client') : null)
    ?? (deviceId ? pending.find(entry => entry.deviceId === deviceId) : null)
    ?? pending.find(entry => entry.clientId === 'gateway-client')
    ?? pending[0]
    ?? null;

  const listResult = runOpenClaw(buildListArgs(gatewayToken));
  const listStdout = listResult.stdout ?? '';
  const listStderr = listResult.stderr ?? '';
  let candidate = selectCandidate(pendingFrom(listStdout));

  if (!candidate?.requestId) {
    return {
      ok: true,
      approved: false,
      localGateway: true,
      deviceId,
      requestId: null,
      message: 'No pending local OpenClaw device request was available to approve.',
      stdout: listStdout,
      stderr: listStderr,
    };
  }

  let approveResult = runOpenClaw(buildApproveArgs(candidate.requestId, gatewayToken));
  let stdout = approveResult.stdout ?? '';
  let stderr = approveResult.stderr ?? '';
  let requestId = candidate.requestId;

  const combinedError = `${stdout}\n${stderr}`.toLowerCase();
  if (approveResult.status !== 0 && combinedError.includes('unknown requestid')) {
    const retryListResult = runOpenClaw(buildListArgs(gatewayToken));
    const retryStdout = retryListResult.stdout ?? '';
    const retryStderr = retryListResult.stderr ?? '';
    const retryCandidate = selectCandidate(pendingFrom(retryStdout));
    if (retryCandidate?.requestId && retryCandidate.requestId !== requestId) {
      candidate = retryCandidate;
      requestId = retryCandidate.requestId;
      approveResult = runOpenClaw(buildApproveArgs(requestId, gatewayToken));
      stdout = approveResult.stdout ?? '';
      stderr = approveResult.stderr ?? '';
    } else {
      stdout = retryStdout || stdout;
      stderr = retryStderr || stderr;
    }
  }

  if (approveResult.status === 0) {
    return {
      ok: true,
      approved: true,
      localGateway: true,
      deviceId,
      requestId,
      message: `Approved pending local OpenClaw device request ${requestId}.`,
      stdout,
      stderr,
    };
  }

  const combined = `${stdout}\n${stderr}`.toLowerCase();
  const noPending =
    combined.includes('no pending')
    || combined.includes('nothing to approve')
    || combined.includes('not found')
    || combined.includes('unknown requestid');
  return {
    ok: noPending,
    approved: false,
    localGateway: true,
    deviceId,
    requestId,
    message: noPending
      ? 'No pending local OpenClaw device request was available to approve.'
      : `OpenClaw device approve failed: ${stderr.trim() || stdout.trim() || `exit ${approveResult.status ?? 'unknown'}`}`,
    stdout,
    stderr,
  };
}
