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
