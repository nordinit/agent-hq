import type { ChildProcess } from 'child_process';

export interface OwnedProcessTreeCleanupResult {
  confirmed: boolean;
  escalated: boolean;
  scope: 'none' | 'process-group' | 'direct-child';
  error?: string;
}

export interface OwnedProcessTreeCleanupOptions {
  platform?: NodeJS.Platform;
  targetExists?: (target: number) => boolean | null;
  signalTarget?: (target: number, signal: NodeJS.Signals) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  killConfirmationMs?: number;
}

function targetExists(target: number): boolean | null {
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

const delay = (milliseconds: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  timer.unref?.();
});

async function waitUntilAbsent(params: {
  target: number;
  timeoutMs: number;
  exists: (target: number) => boolean | null;
  sleep: (milliseconds: number) => Promise<void>;
  pollIntervalMs: number;
}): Promise<boolean> {
  const attempts = Math.max(1, Math.ceil(params.timeoutMs / params.pollIntervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const exists = params.exists(params.target);
    if (exists === false) return true;
    if (exists === null) return false;
    await params.sleep(params.pollIntervalMs);
  }
  return params.exists(params.target) === false;
}

/**
 * Tear down a process tree that this API process just created and still owns.
 *
 * On POSIX, detached spawn gives us an isolated PGID and absence of the whole
 * group is the terminal proof. A direct-child fallback cannot prove descendant
 * absence (notably on Windows), so it is cleaned up best-effort but deliberately
 * returns `confirmed: false`; callers must fail closed rather than terminalize.
 */
export async function cleanupOwnedProcessTree(params: {
  child?: ChildProcess | null;
  processGroupId: number | null;
  graceMs: number;
  options?: OwnedProcessTreeCleanupOptions;
}): Promise<OwnedProcessTreeCleanupResult> {
  const options = params.options ?? {};
  const platform = options.platform ?? process.platform;
  const exists = options.targetExists ?? targetExists;
  const signal = options.signalTarget ?? ((target, value) => process.kill(target, value));
  const sleep = options.sleep ?? delay;
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 25);

  if (platform !== 'win32' && params.processGroupId != null && params.processGroupId > 0) {
    const target = -params.processGroupId;
    const initial = exists(target);
    if (initial === false) return { confirmed: true, escalated: false, scope: 'process-group' };
    if (initial === null) {
      return { confirmed: false, escalated: false, scope: 'process-group', error: 'Could not inspect the owned process group.' };
    }

    try {
      signal(target, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return { confirmed: true, escalated: false, scope: 'process-group' };
      }
      return { confirmed: false, escalated: false, scope: 'process-group', error: 'Failed to terminate the owned process group.' };
    }
    if (await waitUntilAbsent({
      target,
      timeoutMs: Math.min(30_000, Math.max(0, params.graceMs)),
      exists,
      sleep,
      pollIntervalMs,
    })) {
      return { confirmed: true, escalated: false, scope: 'process-group' };
    }

    try {
      signal(target, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return { confirmed: true, escalated: true, scope: 'process-group' };
      }
      return { confirmed: false, escalated: true, scope: 'process-group', error: 'Failed to kill the owned process group.' };
    }
    const confirmed = await waitUntilAbsent({
      target,
      timeoutMs: Math.max(100, options.killConfirmationMs ?? 1_000),
      exists,
      sleep,
      pollIntervalMs,
    });
    return confirmed
      ? { confirmed: true, escalated: true, scope: 'process-group' }
      : { confirmed: false, escalated: true, scope: 'process-group', error: 'Owned process group remained observable after SIGKILL.' };
  }

  const child = params.child;
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* best effort only */ }
    try { child.kill('SIGKILL'); } catch { /* best effort only */ }
  }
  return {
    confirmed: false,
    escalated: Boolean(child),
    scope: 'direct-child',
    error: platform === 'win32'
      ? 'Windows direct-child teardown cannot confirm descendant absence without a Job Object.'
      : 'The process was not launched in an isolated process group; descendant absence cannot be confirmed.',
  };
}

export class OwnedProcessTreeCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnedProcessTreeCleanupError';
  }
}
