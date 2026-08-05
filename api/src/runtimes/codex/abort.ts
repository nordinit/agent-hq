import type { ChildProcess } from 'child_process';
import { CODEX_RUN_ID_PREFIX } from './types';

export interface ActiveCodexRun {
  child: ChildProcess;
  killGraceMs: number;
  exited: boolean;
  aborted: boolean;
  timedOut: boolean;
}

export interface ProcessExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export function parseCodexInstanceIdFromRunId(runId: string): number | null {
  if (!runId.startsWith(CODEX_RUN_ID_PREFIX)) return null;
  const value = runId.slice(CODEX_RUN_ID_PREFIX.length);
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function waitForCodexChildProcess(child: ChildProcess): {
  spawned: Promise<void>;
  exited: Promise<ProcessExitResult>;
} {
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const exited = new Promise<ProcessExitResult>((resolve) => {
    let settled = false;
    const finish = (result: ProcessExitResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('error', (error) => finish({ code: null, signal: null, error }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
  return { spawned, exited };
}

export function writeCodexPrompt(child: ChildProcess, prompt: string): void {
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(prompt);
}

function signalTree(active: ActiveCodexRun, signal: NodeJS.Signals): boolean {
  if (active.exited) return false;
  const pid = active.child.pid;
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Fall back when the child was not made a process-group leader.
    }
  }
  try {
    return active.child.kill(signal);
  } catch {
    return false;
  }
}

function terminate(active: ActiveCodexRun): boolean {
  const signaled = signalTree(active, 'SIGTERM');
  setTimeout(() => {
    if (!active.exited) signalTree(active, 'SIGKILL');
  }, active.killGraceMs).unref();
  return signaled;
}

export function stopCodexActiveRun(active: ActiveCodexRun): boolean {
  if (active.exited) return false;
  active.aborted = true;
  return terminate(active);
}

export function terminateCodexRun(active: ActiveCodexRun): void {
  if (!active.exited) terminate(active);
}
