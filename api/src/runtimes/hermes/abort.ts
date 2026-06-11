import type { ChildProcess } from 'child_process';

export interface ActiveHermesRun {
  child: ChildProcess;
  killGraceMs: number;
  exited: boolean;
  aborted: boolean;
  timedOut: boolean;
  transcriptPoller?: ReturnType<typeof setInterval>;
}

export interface ProcessExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export function parseHermesInstanceIdFromRunId(runId: string): number | null {
  const match = runId.match(/^hermes:(\d+)$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function waitForHermesChildProcess(child: ChildProcess): {
  spawned: Promise<void>;
  exited: Promise<ProcessExitResult>;
} {
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });

  const exited = new Promise<ProcessExitResult>((resolve) => {
    let settled = false;
    const settle = (value: ProcessExitResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.once('error', (error) => settle({ code: null, signal: null, error }));
    child.once('close', (code, signal) => settle({ code, signal }));
  });

  return { spawned, exited };
}

export function stopHermesActiveRun(active: ActiveHermesRun): boolean {
  if (active.exited) return false;

  active.aborted = true;
  const signaled = active.child.kill('SIGTERM');
  setTimeout(() => {
    if (!active.exited) {
      active.child.kill('SIGKILL');
    }
  }, active.killGraceMs).unref();
  return signaled;
}
