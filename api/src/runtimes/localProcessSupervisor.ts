import { createHash } from 'crypto';
import { execFileSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import { sanitizedRuntimeProcessEnv } from './environment';

/**
 * Mutable process flags shared with a runtime's terminal classifier.
 *
 * The supervisor deliberately owns the process registration, not these flags:
 * Claude and Hermes need to add runtime-specific state while still observing
 * whether an operator abort or a timeout initiated termination.
 */
export interface ActiveLocalProcessRun {
  child: ChildProcess;
  killGraceMs: number;
  exited: boolean;
  aborted: boolean;
  timedOut: boolean;
}

export interface RegisterLocalProcessRun {
  runId: string;
  runtimeType: string;
  instanceId: number | null;
  state: ActiveLocalProcessRun;
  /**
   * POSIX process-group id created by spawning with detached=true. Null means
   * signal only the immediate child (the Windows and test fallback).
   */
  processGroupId?: number | null;
}

export type LocalProcessSignalStatus = 'signalled' | 'already_gone' | 'not_found';

export interface LocalProcessSignalResult {
  runId: string;
  status: LocalProcessSignalStatus;
  signal: NodeJS.Signals | null;
  processGroupId: number | null;
}

interface RegisteredLocalProcessRun extends RegisterLocalProcessRun {
  processGroupId: number | null;
  escalationTimer: ReturnType<typeof setTimeout> | null;
  terminationStarted: boolean;
}

export interface LocalProcessSupervisorOptions {
  platform?: NodeJS.Platform;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Process-wide owner for local runtime children.
 *
 * Runtime adapters are short-lived factory results. Keeping child handles on an
 * adapter instance means a separately resolved adapter cannot stop a process
 * started by the dispatch adapter. This registry has module/process lifetime,
 * so every adapter instance sees the same live runs. The durable database
 * execution/checkpoint records provide the cross-restart half of the contract;
 * this class owns only processes attached to the current API process.
 */
export class LocalProcessSupervisor {
  private readonly runs = new Map<string, RegisteredLocalProcessRun>();
  private readonly escalationTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly groupEscalationTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly platform: NodeJS.Platform;
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;

  constructor(options: LocalProcessSupervisorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.signalProcess = options.signalProcess ?? process.kill.bind(process);
  }

  register(input: RegisterLocalProcessRun): void {
    const runId = input.runId.trim();
    if (!runId) throw new Error('Local process runId must not be empty');

    const existing = this.runs.get(runId);
    if (existing && !existing.state.exited && existing.state.child !== input.state.child) {
      throw new Error(`Local process run ${runId} is already registered`);
    }
    if (existing) this.unregister(runId, existing.state.child);

    const entry: RegisteredLocalProcessRun = {
      ...input,
      runId,
      processGroupId: this.platform === 'win32' ? null : input.processGroupId ?? null,
      escalationTimer: null,
      terminationStarted: false,
    };
    this.runs.set(runId, entry);

    // A token-aware cleanup prevents a late close from an old child deleting a
    // newer registration that happens to reuse the same durable run id.
    input.state.child.once('close', () => {
      input.state.exited = true;
      this.unregister(runId, input.state.child);
    });
  }

  has(runId: string, runtimeType?: string): boolean {
    const entry = this.runs.get(runId);
    return Boolean(entry && !entry.state.exited && (!runtimeType || entry.runtimeType === runtimeType));
  }

  stop(runId: string, runtimeType?: string): LocalProcessSignalResult {
    return this.beginTermination(runId, true, runtimeType);
  }

  /** Terminate for timeout/policy reasons without misclassifying it as an operator abort. */
  terminate(runId: string, runtimeType?: string): LocalProcessSignalResult {
    return this.beginTermination(runId, false, runtimeType);
  }

  unregister(runId: string, child?: ChildProcess): boolean {
    const entry = this.runs.get(runId);
    if (!entry || (child && entry.state.child !== child)) return false;
    if (entry.escalationTimer && !(entry.terminationStarted && entry.processGroupId != null)) {
      clearTimeout(entry.escalationTimer);
      this.escalationTimers.delete(entry.escalationTimer);
    }
    this.runs.delete(runId);
    return true;
  }

  /** Cancel a deferred SIGKILL only after the complete group is confirmed absent. */
  confirmProcessGroupAbsent(processGroupId: number | null): void {
    this.cancelDeferredProcessGroupEscalation(processGroupId);
  }

  /** A synchronous cleanup owner may take over after the leader close event. */
  cancelDeferredProcessGroupEscalation(processGroupId: number | null): void {
    if (processGroupId == null) return;
    const timer = this.groupEscalationTimers.get(processGroupId);
    if (!timer) return;
    clearTimeout(timer);
    this.groupEscalationTimers.delete(processGroupId);
    this.escalationTimers.delete(timer);
  }

  /** Jest isolation hook; production code must unregister through process exit. */
  clearForTests(): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('LocalProcessSupervisor.clearForTests is only available in tests');
    }
    for (const entry of this.runs.values()) {
      if (entry.escalationTimer) clearTimeout(entry.escalationTimer);
    }
    for (const timer of this.escalationTimers) clearTimeout(timer);
    this.escalationTimers.clear();
    this.groupEscalationTimers.clear();
    this.runs.clear();
  }

  private beginTermination(
    runId: string,
    markAborted: boolean,
    runtimeType?: string,
  ): LocalProcessSignalResult {
    const entry = this.runs.get(runId);
    if (!entry || (runtimeType && entry.runtimeType !== runtimeType)) {
      return { runId, status: 'not_found', signal: null, processGroupId: null };
    }
    if (entry.state.exited) {
      this.unregister(runId, entry.state.child);
      return {
        runId,
        status: 'already_gone',
        signal: null,
        processGroupId: entry.processGroupId,
      };
    }

    if (markAborted) entry.state.aborted = true;
    if (entry.terminationStarted) {
      return {
        runId,
        status: 'signalled',
        signal: 'SIGTERM',
        processGroupId: entry.processGroupId,
      };
    }
    entry.terminationStarted = true;

    const signalled = this.signal(entry, 'SIGTERM');
    if (!signalled) {
      entry.state.exited = true;
      this.unregister(runId, entry.state.child);
      return {
        runId,
        status: 'already_gone',
        signal: null,
        processGroupId: entry.processGroupId,
      };
    }

    entry.escalationTimer = setTimeout(() => {
      const timer = entry.escalationTimer;
      // A CLI leader can exit on SIGTERM while a shell/MCP grandchild ignores
      // it. Keep the process-group escalation alive in that case; direct-child
      // fallbacks need no signal once their only process has exited.
      if (entry.processGroupId != null || !entry.state.exited) this.signal(entry, 'SIGKILL');
      if (timer) this.escalationTimers.delete(timer);
      if (entry.processGroupId != null) this.groupEscalationTimers.delete(entry.processGroupId);
      entry.escalationTimer = null;
    }, Math.max(0, entry.state.killGraceMs));
    this.escalationTimers.add(entry.escalationTimer);
    if (entry.processGroupId != null) {
      const previous = this.groupEscalationTimers.get(entry.processGroupId);
      if (previous && previous !== entry.escalationTimer) {
        clearTimeout(previous);
        this.escalationTimers.delete(previous);
      }
      this.groupEscalationTimers.set(entry.processGroupId, entry.escalationTimer);
    }
    entry.escalationTimer.unref?.();

    return {
      runId,
      status: 'signalled',
      signal: 'SIGTERM',
      processGroupId: entry.processGroupId,
    };
  }

  private signal(entry: RegisteredLocalProcessRun, signal: NodeJS.Signals): boolean {
    try {
      if (entry.processGroupId != null && entry.processGroupId > 0) {
        // Negative pid addresses the complete POSIX process group. Claude/Codex
        // can launch MCP and shell grandchildren; killing only the CLI leaks them.
        this.signalProcess(-entry.processGroupId, signal);
        return true;
      }
      return entry.state.child.kill(signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ESRCH') return false;

      // A group may be unavailable because the host refused group signalling.
      // Fall back to the direct child so stop remains useful and cross-platform.
      try {
        return entry.state.child.kill(signal);
      } catch {
        return false;
      }
    }
  }
}

/** Shared across every resolveRuntime() result in this API process. */
export const localProcessSupervisor = new LocalProcessSupervisor();

/** Spawn option and matching group-id helper must be used together. */
export function localProcessSpawnOptions(): { detached: boolean } {
  return { detached: process.platform !== 'win32' };
}

export function localProcessGroupId(child: ChildProcess): number | null {
  // Real spawned ChildProcess objects carry spawnargs. Unit-test event emitters
  // often set a decorative pid without creating a process group; treating that
  // as a pgid would signal an unrelated host process (or ESRCH) during tests.
  return process.platform !== 'win32'
    && Array.isArray(child.spawnargs)
    && typeof child.pid === 'number'
    && child.pid > 0
    ? child.pid
    : null;
}

/**
 * Best-effort, non-secret process birth fingerprint used to distinguish a
 * surviving child from an unrelated process that later reused the same PID.
 */
export function localProcessIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform === 'win32') return null;
  try {
    let identitySource: string;
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const afterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const startTicks = afterCommand[19]; // proc(5) field 22; array starts at field 3.
      if (!startTicks) return null;
      let executable = '';
      try { executable = fs.readlinkSync(`/proc/${pid}/exe`); } catch { /* permission/race */ }
      identitySource = `linux:${startTicks}:${executable}`;
    } else {
      const output = execFileSync(
        'ps',
        ['-o', 'lstart=', '-o', 'comm=', '-p', String(pid)],
        {
          env: sanitizedRuntimeProcessEnv(),
          encoding: 'utf8',
          timeout: 1_000,
          maxBuffer: 32 * 1024,
        },
      ).trim();
      if (!output) return null;
      identitySource = `${process.platform}:${output}`;
    }
    return `sha256:${createHash('sha256').update(identitySource).digest('hex')}`;
  } catch {
    return null;
  }
}
