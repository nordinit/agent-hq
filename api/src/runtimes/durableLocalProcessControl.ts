import { hostname } from 'os';

import { localProcessIdentity } from './localProcessSupervisor';
import type { RuntimeAbortResult } from './types';

interface DurableLocalProcessHandle {
  kind: 'local-process';
  pid: number;
  processGroupId: number | null;
  processIdentity: string | null;
  hostname: string;
}

export interface DurableLocalProcessControlOptions {
  currentHostname?: string;
  inspectIdentity?: (pid: number) => string | null;
  targetExists?: (target: number) => boolean | null;
  signalTarget?: (target: number, signal: NodeJS.Signals) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  killConfirmationMs?: number;
}

function parseHandle(value: unknown): DurableLocalProcessHandle | null {
  let candidate = value;
  if (typeof value === 'string') {
    try { candidate = JSON.parse(value) as unknown; } catch { return null; }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const handle = candidate as Record<string, unknown>;
  const processGroupId = handle.processGroupId == null ? null : Number(handle.processGroupId);
  if (
    handle.kind !== 'local-process'
    || !Number.isSafeInteger(handle.pid)
    || Number(handle.pid) <= 0
    || (processGroupId != null && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0))
    || typeof handle.hostname !== 'string'
  ) return null;
  return {
    kind: 'local-process',
    pid: Number(handle.pid),
    processGroupId,
    processIdentity: typeof handle.processIdentity === 'string' && handle.processIdentity
      ? handle.processIdentity
      : null,
    hostname: handle.hostname,
  };
}

function processTargetExists(target: number): boolean | null {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

function signalProcessTarget(target: number, signal: NodeJS.Signals): void {
  process.kill(target, signal);
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  timer.unref?.();
});

async function waitUntilGone(params: {
  target: number;
  timeoutMs: number;
  targetExists: (target: number) => boolean | null;
  sleep: (milliseconds: number) => Promise<void>;
  pollIntervalMs: number;
}): Promise<boolean> {
  const attempts = Math.max(1, Math.ceil(params.timeoutMs / params.pollIntervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const exists = params.targetExists(params.target);
    if (exists === false) return true;
    if (exists === null) return false;
    await params.sleep(params.pollIntervalMs);
  }
  return params.targetExists(params.target) === false;
}

/**
 * Stop a same-host process recovered from a durable handle.
 *
 * The process birth fingerprint is mandatory: a numeric PID/process-group id
 * alone is never authority to signal after restart because the OS may have
 * reused it. The result is confirmed only after the direct PID or complete
 * process group can no longer be observed.
 */
export async function stopDurableLocalProcess(
  rawHandle: unknown,
  killGraceMs: number,
  options: DurableLocalProcessControlOptions = {},
): Promise<RuntimeAbortResult> {
  const handle = parseHandle(rawHandle);
  if (!handle) {
    return { attempted: false, ok: false, confirmed: false, status: 'failed', error: 'Durable local-process handle is missing or invalid.' };
  }
  if (handle.hostname !== (options.currentHostname ?? hostname())) {
    return { attempted: false, ok: false, confirmed: false, status: 'failed', error: 'Durable local process belongs to a different host.' };
  }
  if (!handle.processIdentity) {
    return { attempted: false, ok: false, confirmed: false, status: 'failed', error: 'Durable local process has no birth fingerprint; refusing to signal a reusable PID.' };
  }

  const targetExists = options.targetExists ?? processTargetExists;
  const inspectIdentity = options.inspectIdentity ?? localProcessIdentity;
  const signalTarget = options.signalTarget ?? signalProcessTarget;
  const sleep = options.sleep ?? delay;
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 50);
  const directExists = targetExists(handle.pid);
  if (directExists === false) {
    if (handle.processGroupId != null && process.platform !== 'win32') {
      const groupExists = targetExists(-handle.processGroupId);
      if (groupExists === true) {
        return { attempted: false, ok: false, confirmed: false, status: 'failed', error: 'The durable process leader exited but its process group remains; its birth identity can no longer be verified.' };
      }
      if (groupExists === null) {
        return { attempted: false, ok: false, confirmed: false, status: 'failed', error: 'Could not inspect the durable process group.' };
      }
    }
    return { attempted: true, ok: true, confirmed: true, status: 'already_gone' };
  }
  if (directExists === null) {
    return { attempted: false, ok: false, confirmed: false, status: 'failed', error: 'Could not inspect the durable local process.' };
  }
  const actualIdentity = inspectIdentity(handle.pid);
  if (!actualIdentity) {
    return { attempted: false, ok: false, confirmed: false, status: 'failed', error: 'Could not verify the durable local process birth fingerprint.' };
  }
  if (actualIdentity !== handle.processIdentity) {
    if (handle.processGroupId != null && process.platform !== 'win32' && targetExists(-handle.processGroupId) === true) {
      return { attempted: false, ok: false, confirmed: false, status: 'failed', error: 'The durable PID was reused while its process-group id remains observable; refusing to signal it.' };
    }
    return { attempted: true, ok: true, confirmed: true, status: 'already_gone' };
  }

  const target = handle.processGroupId != null && process.platform !== 'win32'
    ? -handle.processGroupId
    : handle.pid;
  try {
    signalTarget(target, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return { attempted: true, ok: true, confirmed: true, status: 'already_gone' };
    }
    return { attempted: true, ok: false, confirmed: false, status: 'failed', error: 'Failed to signal the durable local process.' };
  }

  const graceMs = Math.min(30_000, Math.max(0, killGraceMs));
  if (await waitUntilGone({ target, timeoutMs: graceMs, targetExists, sleep, pollIntervalMs })) {
    return { attempted: true, ok: true, confirmed: true, status: 'signalled' };
  }
  try {
    signalTarget(target, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return { attempted: true, ok: true, confirmed: true, status: 'signalled' };
    }
    return { attempted: true, ok: false, confirmed: false, status: 'failed', error: 'Failed to escalate the durable local process stop.' };
  }
  const gone = await waitUntilGone({
    target,
    timeoutMs: Math.max(100, options.killConfirmationMs ?? 1_000),
    targetExists,
    sleep,
    pollIntervalMs,
  });
  return gone
    ? { attempted: true, ok: true, confirmed: true, status: 'signalled' }
    : { attempted: true, ok: false, confirmed: false, status: 'failed', error: 'Process group remained observable after SIGKILL.' };
}
