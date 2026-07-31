/**
 * runtimes/claudeCode/abort.ts — child-process lifecycle helpers.
 *
 * Mirrors runtimes/hermes/abort.ts. Kept as a separate module (rather than
 * shared with Hermes) because the two runtimes differ in one respect that
 * matters: the claude CLI reads its prompt from stdin, so the child is spawned
 * with a writable stdin pipe that must be closed before the process will do any
 * work. `writePromptToStdin` centralises that.
 */

import type { ChildProcess } from 'child_process';
import { CLAUDE_CODE_RUN_ID_PREFIX } from './types';

export interface ActiveClaudeCodeRun {
  child: ChildProcess;
  killGraceMs: number;
  exited: boolean;
  aborted: boolean;
  timedOut: boolean;
  /**
   * Set when the MCP readiness gate has decided the run cannot succeed, so the
   * terminal classifier can distinguish "we killed it" from "it failed".
   */
  mcpGateFailed?: boolean;
}

export interface ProcessExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

/** runId format is `claude-code:<instanceId>` — unchanged from the SDK runtime. */
export function parseClaudeCodeInstanceIdFromRunId(runId: string): number | null {
  if (!runId.startsWith(CLAUDE_CODE_RUN_ID_PREFIX)) return null;
  const raw = runId.slice(CLAUDE_CODE_RUN_ID_PREFIX.length);
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Two promises from one call.
 *
 * `spawned` rejects if the binary could not be launched at all (ENOENT).
 * `exited` NEVER rejects — it settles exactly once, carrying the error when the
 * failure arrived as an 'error' event instead of a clean 'close'. A rejecting
 * exit promise would become an unhandled rejection and, under Node's default
 * `--unhandled-rejections=throw`, take down the whole API process.
 */
export function waitForClaudeCodeChildProcess(child: ChildProcess): {
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

/**
 * Deliver the prompt and close stdin.
 *
 * `claude --print -` reads the prompt from stdin and does not begin work until
 * stdin reaches EOF, so failing to `end()` hangs the run until the dispatch
 * timeout fires — with no output to explain why.
 */
export function writePromptToStdin(child: ChildProcess, prompt: string): void {
  const stdin = child.stdin;
  if (!stdin) return;
  // A child that dies during startup leaves a stdin whose write() raises EPIPE.
  // That is already reported through the exit path, so swallow it here.
  stdin.on('error', () => undefined);
  stdin.end(prompt);
}

/** SIGTERM now, SIGKILL after the grace period. Idempotent and never throws. */
export function stopClaudeCodeActiveRun(active: ActiveClaudeCodeRun): boolean {
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

/**
 * Escalating kill used by the timeout and MCP-gate paths.
 *
 * Deliberately does NOT set `aborted` — an operator abort and a runtime-imposed
 * kill must classify differently, and Hermes conflates them by hand-rolling this
 * sequence inline in its timeout handler.
 */
export function terminateClaudeCodeRun(active: ActiveClaudeCodeRun): void {
  if (active.exited) return;
  active.child.kill('SIGTERM');
  setTimeout(() => {
    if (!active.exited) {
      active.child.kill('SIGKILL');
    }
  }, active.killGraceMs).unref();
}
