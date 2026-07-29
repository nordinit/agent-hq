import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import { OPENCLAW_BIN, OPENCLAW_CONFIG_PATH, OPENCLAW_PATH } from '../config';
import { buildGatewayRunSessionKey } from './sessionKeys';
import { removeTaskWorktree } from '../services/worktreeManager';
import { removeTaskClone } from '../services/repoWorkspaceManager';
import { writeTaskHistory } from '../domains/tasks/history';
import { taskTableHasColumn } from '../domains/tasks/ownership';
import { nowTimestamp } from './timestamps';
import { type Db } from "../db/adapter/types";
import { columnExists as sharedColumnExists } from "../db/introspection";

const LIVE_TASK_STATUSES = ['in_progress', 'dev_deploy_queued', 'dev_deploying', 'stalled'] as const;
const LIVE_INSTANCE_STATUSES = ['queued', 'dispatched', 'running'] as const;
// Dispatch attaches an instance before the visible agent_started mapping moves
// the task out of ready, so retain live ownership during that handoff window.
const ACTIVE_LINKAGE_RETAIN_STATUSES = ['ready', 'dispatched', 'in_progress', 'dev_deploy_queued', 'dev_deploying', 'stalled', 'review', 'ready_to_merge', 'deployed', 'blocked'] as const;
export const ACTIVE_INSTANCE_END_GRACE_MS: number = (() => {
  const v = parseInt(process.env.ACTIVE_INSTANCE_END_GRACE_MS ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 10_000;
})();
const pendingEndedLinkageCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Deferred linkage cleanup runs from a timer callback, so nothing can await it
// through the normal call graph. Track the in-flight promises so callers that
// need the work to be finished (notably tests, and shutdown paths) can wait on
// it deterministically instead of guessing how many microtask ticks it needs.
const inFlightEndedLinkageCleanups = new Set<Promise<void>>();

function trackEndedLinkageCleanup(work: () => Promise<void>): Promise<void> {
  const holder: { done?: Promise<void> } = {};
  holder.done = (async () => {
    try {
      await work();
    } finally {
      if (holder.done) inFlightEndedLinkageCleanups.delete(holder.done);
    }
  })();
  inFlightEndedLinkageCleanups.add(holder.done);
  return holder.done;
}

export async function flushPendingEndedActiveInstanceLinkageCleanups(): Promise<void> {
  while (inFlightEndedLinkageCleanups.size > 0) {
    await Promise.allSettled([...inFlightEndedLinkageCleanups]);
  }
}

export function clearPendingEndedActiveInstanceLinkageCleanupTimers(): number {
  const count = pendingEndedLinkageCleanupTimers.size;
  for (const timer of pendingEndedLinkageCleanupTimers.values()) {
    clearTimeout(timer);
  }
  pendingEndedLinkageCleanupTimers.clear();
  return count;
}

// ── OpenClaw env config (mirrors integrations/openclaw.ts) ───────────────────
function readGatewayTokenFromConfig(): string | null {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw) as { gateway?: { auth?: { token?: string } } };
    const token = cfg.gateway?.auth?.token;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function getGatewayAuthToken(): string {
  return process.env.OPENCLAW_GATEWAY_TOKEN ?? readGatewayTokenFromConfig() ?? '';
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function isQaAgent(db: Db, agentId: number | null | undefined): Promise<boolean> {
  if (!agentId) return false;

  const row = await db.get(`
    SELECT name, job_title
    FROM agents
    WHERE id = ?
  `, agentId) as { name: string | null; job_title: string | null } | undefined;
  const haystack = ((row?.job_title ?? '') + ' ' + (row?.name ?? '')).toLowerCase();

  return /\bqa\b/.test(haystack);
}

async function taskAllowsReviewExecution(db: Db, task: { agent_id?: number | null; active_instance_id: number | null }): Promise<boolean> {
  if (!task.active_instance_id || !task.agent_id || !await isQaAgent(db, task.agent_id)) return false;

  const instance = await db.get(`
    SELECT agent_id, status
    FROM job_instances
    WHERE id = ?
  `, task.active_instance_id) as { agent_id: number; status: string } | undefined;

  if (!instance) return false;
  if (instance.agent_id !== task.agent_id) return false;
  return LIVE_INSTANCE_STATUSES.includes(instance.status as typeof LIVE_INSTANCE_STATUSES[number]);
}

/**
 * Returns true when a deployment-stage instance is still live and owns
 * the task. Outcome posting closes the instance and schedules ended-linkage
 * cleanup; this guard only preserves authority while that live release run is
 * still legitimately in flight.
 */
async function taskAllowsReleaseExecution(db: Db, task: { agent_id?: number | null; active_instance_id: number | null }): Promise<boolean> {
  if (!task.active_instance_id) return false;

  const instance = await db.get(`
    SELECT agent_id, status
    FROM job_instances
    WHERE id = ?
  `, task.active_instance_id) as { agent_id: number; status: string } | undefined;

  if (!instance) return false;
  return LIVE_INSTANCE_STATUSES.includes(instance.status as typeof LIVE_INSTANCE_STATUSES[number]);
}

function normalizeTimestamp(raw?: string | null): number | null {
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZ = normalized.endsWith('Z') ? normalized : `${normalized}Z`;
  const ms = new Date(withZ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function getEndedLinkageAnchorMs(runtimeEndedAt?: string | null, lifecycleOutcomePostedAt?: string | null): number | null {
  const candidates = [
    normalizeTimestamp(runtimeEndedAt),
    normalizeTimestamp(lifecycleOutcomePostedAt),
  ].filter((value): value is number => Number.isFinite(value));
  if (!candidates.length) return null;
  return Math.min(...candidates);
}

function isWithinEndedLinkageGraceWindow(
  runtimeEndedAt?: string | null,
  lifecycleOutcomePostedAt?: string | null,
  nowMs = Date.now(),
): boolean {
  const anchorMs = getEndedLinkageAnchorMs(runtimeEndedAt, lifecycleOutcomePostedAt);
  if (anchorMs == null) return false;
  return nowMs - anchorMs < ACTIVE_INSTANCE_END_GRACE_MS;
}

async function getEndedLinkageCleanupContext(db: Db, taskId: number, instanceId: number): Promise<{
  taskId: number;
  instanceId: number;
  runtimeEndedAt: string | null;
  lifecycleOutcomePostedAt: string | null;
  anchorMs: number;
} | null> {
  const row = await db.get(`
    SELECT t.active_instance_id,
           ji.runtime_ended_at,
           ji.lifecycle_outcome_posted_at
    FROM tasks t
    LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
    WHERE t.id = ?
  `, taskId) as {
    active_instance_id: number | null;
    runtime_ended_at: string | null;
    lifecycle_outcome_posted_at: string | null;
  } | undefined;

  if (!row || row.active_instance_id !== instanceId) return null;

  const anchorMs = getEndedLinkageAnchorMs(row.runtime_ended_at, row.lifecycle_outcome_posted_at);
  if (anchorMs == null) return null;

  return {
    taskId,
    instanceId,
    runtimeEndedAt: row.runtime_ended_at,
    lifecycleOutcomePostedAt: row.lifecycle_outcome_posted_at,
    anchorMs,
  };
}

async function finalizeTaskTransitionRuntimeEndIfNeeded(
  db: Db,
  taskId: number,
  instanceId: number,
  changedBy?: string,
): Promise<void> {
  const row = await db.get(`
    SELECT status,
           session_key,
           runtime_ended_at,
           lifecycle_outcome_posted_at,
           task_outcome
    FROM job_instances
    WHERE id = ?
  `, instanceId) as {
    status: string;
    session_key: string | null;
    runtime_ended_at: string | null;
    lifecycle_outcome_posted_at: string | null;
    task_outcome: string | null;
  } | undefined;

  if (!row?.status || row.runtime_ended_at) return;
  if (!LIVE_INSTANCE_STATUSES.includes(row.status as typeof LIVE_INSTANCE_STATUSES[number])) return;

  const hasSemanticOutcome = Boolean(row.lifecycle_outcome_posted_at || row.task_outcome);
  if (!hasSemanticOutcome) return;

  const { applyRuntimeEndToJobInstance } = require('../domains/runs/runtimeEnd') as typeof import('../domains/runs/runtimeEnd');
  const endedAt = nowTimestamp();
  const result = await applyRuntimeEndToJobInstance(db, {
    instanceId,
    runtimeName: 'Agent HQ',
    runtimeEndSource: 'task_transition',
    changedBy: changedBy ?? 'task_lifecycle',
    event: {
      type: 'runtime-end',
      source: 'task_transition',
      sessionKey: row.session_key ?? `task:${taskId}:instance:${instanceId}`,
      success: true,
      endedAt,
      reason: 'task_transition',
    },
  });

  if (!result.changed) return;

  await db.run(`
    UPDATE job_instances
    SET status = 'done',
        completed_at = COALESCE(completed_at, runtime_ended_at, datetime('now'))
    WHERE id = ?
      AND status IN ('queued', 'dispatched', 'running')
      AND runtime_ended_at IS NOT NULL
  `, instanceId);

  if (row.session_key && (row.status === 'dispatched' || row.status === 'running')) {
    abortOrphanedInstanceAsync(
      db,
      instanceId,
      row.session_key,
      `task #${taskId} completed semantic handoff and detached instance #${instanceId}`,
    );
  }
}

export async function clearEndedActiveInstanceLinkageIfEligible(
  db: Db,
  taskId: number,
  instanceId: number,
  options?: {
    changedBy?: string;
    nowMs?: number;
    force?: boolean;
  },
): Promise<boolean> {
  const context = await getEndedLinkageCleanupContext(db, taskId, instanceId);
  if (!context) return false;

  const nowMs = options?.nowMs ?? Date.now();
  if (!options?.force && nowMs - context.anchorMs < ACTIVE_INSTANCE_END_GRACE_MS) {
    return false;
  }

  const result = await db.run(`
    UPDATE tasks
    SET active_instance_id = NULL,
        ${await taskTableHasColumn(db, 'agent_id') ? 'agent_id = NULL,' : ''}
        updated_at = datetime('now')
    WHERE id = ?
      AND active_instance_id = ?
  `, taskId, instanceId);

  if (result.changes > 0) {
    try {
      await writeTaskHistory(db, taskId, options?.changedBy ?? 'task_lifecycle', 'active_instance_id', instanceId, null);
    } catch {
      // Non-fatal in minimal test schemas.
    }
  }

  return result.changes > 0;
}

export async function scheduleEndedActiveInstanceLinkageCleanup(
  db: Db,
  taskId: number,
  instanceId: number,
  options?: {
    changedBy?: string;
    nowMs?: number;
  },
): Promise<boolean> {
  const context = await getEndedLinkageCleanupContext(db, taskId, instanceId);
  if (!context) return false;

  const nowMs = options?.nowMs ?? Date.now();
  const remainingMs = Math.max(0, ACTIVE_INSTANCE_END_GRACE_MS - (nowMs - context.anchorMs));
  const key = `${taskId}:${instanceId}`;
  if (pendingEndedLinkageCleanupTimers.has(key)) {
    return true;
  }

  const runCleanup = async () => {
    pendingEndedLinkageCleanupTimers.delete(key);
    try {
      await finalizeTaskTransitionRuntimeEndIfNeeded(db, taskId, instanceId, options?.changedBy);
      await clearEndedActiveInstanceLinkageIfEligible(db, taskId, instanceId, {
                changedBy: options?.changedBy,
                force: true,
              });
    } catch (err) {
      console.warn(
        `[taskLifecycle] Failed delayed active-instance cleanup for task #${taskId} instance #${instanceId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  };

  if (remainingMs === 0) {
    setImmediate(() => { void trackEndedLinkageCleanup(runCleanup); });
    return true;
  }

  const timer = setTimeout(() => { void trackEndedLinkageCleanup(runCleanup); }, remainingMs);
  timer.unref?.();
  pendingEndedLinkageCleanupTimers.set(key, timer);
  return true;
}

export function taskAllowsActiveExecution(status: string | null | undefined): boolean {
  return Boolean(status && LIVE_TASK_STATUSES.includes(status as typeof LIVE_TASK_STATUSES[number]));
}

function resolveCleanupRepoContext(row: {
  payload_sent?: string | null;
  repo_path: string | null;
  repo_access_mode: string | null;
}): { repoAccessMode: 'worktree' | 'clone' | null; repoPath: string | null } {
  try {
    if (row.payload_sent) {
      const payload = JSON.parse(row.payload_sent) as { repoAccessMode?: unknown; repoSource?: unknown };
      const payloadMode = payload.repoAccessMode === 'worktree' || payload.repoAccessMode === 'clone'
        ? payload.repoAccessMode
        : null;
      const payloadSource = typeof payload.repoSource === 'string' ? payload.repoSource : null;

      if (payloadMode === 'clone') {
        return { repoAccessMode: 'clone', repoPath: null };
      }

      if (payloadMode === 'worktree') {
        const repoPath = payloadSource?.startsWith('worktree:')
          ? payloadSource.slice('worktree:'.length) || null
          : row.repo_path;
        return { repoAccessMode: 'worktree', repoPath };
      }
    }
  } catch {
    // Fall back to legacy agent columns below.
  }

  return {
    repoAccessMode: row.repo_access_mode === 'worktree' || row.repo_access_mode === 'clone'
      ? row.repo_access_mode
      : null,
    repoPath: row.repo_path,
  };
}

export async function cleanupDoneTaskWorktrees(db: Db, taskId: number): Promise<number> {
  const hasPayloadSent = await sharedColumnExists(db, 'job_instances', 'payload_sent');
  const hasRepoAccessMode = await sharedColumnExists(db, 'agents', 'repo_access_mode');
  const rows = await db.all(`
    SELECT DISTINCT ji.worktree_path,
           ${hasPayloadSent ? 'ji.payload_sent' : 'NULL AS payload_sent'},
           a.repo_path${hasRepoAccessMode ? ', a.repo_access_mode' : ', NULL AS repo_access_mode'}
    FROM job_instances ji
    LEFT JOIN agents a ON a.id = ji.agent_id
    WHERE (
        ji.task_id = ?
        OR ji.worktree_path = ?
        OR ji.worktree_path LIKE ?
        OR ji.worktree_path = ?
        OR ji.worktree_path LIKE ?
      )
      AND ji.worktree_path IS NOT NULL
      AND ji.worktree_path != ''
  `, taskId, `task-${taskId}`, `%/task-${taskId}`, `agent-hq-task-${taskId}`, `%/agent-hq-task-${taskId}`) as Array<{ worktree_path: string; payload_sent?: string | null; repo_path: string | null; repo_access_mode: string | null }>;

  let removed = 0;
  for (const row of rows) {
    try {
      const repoContext = resolveCleanupRepoContext(row);
      const result = repoContext.repoAccessMode === 'clone'
        ? removeTaskClone({ workspacePath: row.worktree_path })
        : removeTaskWorktree({
            repoPath: repoContext.repoPath ?? '',
            worktreePath: row.worktree_path,
          });
      if (result.removed) removed++;
      else if (result.error) {
        console.warn(`[taskLifecycle] Worktree cleanup failed for done task #${taskId} at ${row.worktree_path}: ${result.error}`);
      }
    } catch (err) {
      console.warn(`[taskLifecycle] Worktree cleanup error for done task #${taskId} at ${row.worktree_path}:`, err);
    }
  }

  return removed;
}

// ── Async abort for orphaned instances ───────────────────────────────────────

// ── Watchdog: hard-kill via sessions.delete if chat.abort doesn't stick ──────

const WATCHDOG_GRACE_MS = 15_000;   // wait this long after chat.abort before checking
const WATCHDOG_POLL_INTERVAL_MS = 3_000; // how often to re-check session activity
const WATCHDOG_MAX_POLLS = 5;        // max re-checks after grace period

/**
 * Resolves the full OpenClaw session key (agent:<slug>:...) from the instance
 * payload. The DB stores the short key (hook:atlas:jobrun:<id>); the gateway
 * sessions.* methods require the agent-prefixed key.
 */
async function resolveFullSessionKey(db: Db, instanceId: number, shortKey: string): Promise<string | null> {
  try {
    const row = await db.get(`
      SELECT ji.payload_sent, a.session_key, a.openclaw_agent_id, a.name
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE ji.id = ?
    `, instanceId) as {
      payload_sent: string | null;
      session_key: string | null;
      openclaw_agent_id: string | null;
      name: string | null;
    } | undefined;

    const fromAgent = buildGatewayRunSessionKey(row ?? null, shortKey);
    if (fromAgent) return fromAgent;

    if (!row?.payload_sent) return null;
    const payload = JSON.parse(row.payload_sent) as { agentSlug?: string };
    if (!payload.agentSlug) return null;
    return `agent:${payload.agentSlug}:${shortKey}`;
  } catch {
    return null;
  }
}

/**
 * Polls the gateway sessions.get endpoint to see if the session's updatedAt
 * has changed since the baseline. Returns true if the session appears to still
 * be active (updatedAt advanced), false if it appears gone or quiet.
 */
function sessionStillActiveSync(fullSessionKey: string, baselineUpdatedAt: number): boolean {
  const args = [
    'gateway', 'call', 'sessions.get',
    '--json',
    '--timeout', '8000',
    '--params', JSON.stringify({ key: fullSessionKey }),
  ];

  const gatewayAuthToken = getGatewayAuthToken();
  if (gatewayAuthToken) {
    args.push('--token', gatewayAuthToken);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: OPENCLAW_PATH,
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
  };

  const result = spawnSync(OPENCLAW_BIN, args, { encoding: 'utf-8', timeout: 10_000, env });
  if (result.error || result.status !== 0) return false;

  try {
    const parsed = JSON.parse(result.stdout ?? '{}') as { updatedAt?: number; messages?: unknown[] };
    // If the session has no messages at all, it's gone
    if (!parsed.messages || (parsed.messages as unknown[]).length === 0) return false;
    // If updatedAt advanced past the baseline, the session is still being written
    if (typeof parsed.updatedAt === 'number' && parsed.updatedAt > baselineUpdatedAt) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Force-kills a session by calling sessions.delete, which clears the session
 * queue and closes any active ACP runtimes — a hard kill that survives a soft
 * chat.abort being ignored by an in-flight agent.
 */
function hardKillSessionSync(fullSessionKey: string): { ok: boolean; error?: string } {
  const args = [
    'gateway', 'call', 'sessions.delete',
    '--json',
    '--timeout', '10000',
    '--params', JSON.stringify({ key: fullSessionKey }),
  ];

  const gatewayAuthToken = getGatewayAuthToken();
  if (gatewayAuthToken) {
    args.push('--token', gatewayAuthToken);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: OPENCLAW_PATH,
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
  };

  const result = spawnSync(OPENCLAW_BIN, args, { encoding: 'utf-8', timeout: 12_000, env });

  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr ?? '').trim() || `sessions.delete exited with code ${result.status}` };
  }

  try {
    const parsed = JSON.parse(result.stdout ?? '{}') as { ok?: boolean };
    return { ok: parsed.ok === true };
  } catch {
    return { ok: true }; // exit 0 is good enough
  }
}

/**
 * Asynchronously aborts an orphaned job instance after task linkage has been
 * cleared. Uses spawn (not spawnSync) so it never blocks the event loop.
 *
 * Two-stage termination:
 * 1. Send chat.abort (soft signal) — this works most of the time.
 * 2. After WATCHDOG_GRACE_MS, check if the session is still active via
 *    sessions.get. If so, escalate to sessions.delete (hard kill), which
 *    clears the session queue and tears down the ACP runtime, guaranteeing
 *    the agent cannot post further check-ins.
 *
 * If the abort times out or fails, the instance is marked failed so it is not
 * left indefinitely in dispatched/running state.
 *
 * @param db          - SQLite database connection
 * @param instanceId  - The orphaned job_instance.id to abort
 * @param sessionKey  - The openclaw session key for the running instance (short form)
 * @param reason      - Human-readable reason for the abort (logged)
 */
export function abortOrphanedInstanceAsync(
  db: Db,
  instanceId: number,
  sessionKey: string,
  reason: string,
): void {
  const ABORT_TIMEOUT_MS = 15_000;

  const args = [
    'gateway', 'call', 'chat.abort',
    '--json',
    '--timeout', '10000',
    '--params', JSON.stringify({ sessionKey }),
  ];

  const gatewayAuthToken = getGatewayAuthToken();
  if (gatewayAuthToken) {
    args.push('--token', gatewayAuthToken);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: OPENCLAW_PATH,
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
  };

  let stdout = '';
  let stderr = '';
  let settled = false;

  const child = spawn(OPENCLAW_BIN, args, { env });

  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  const timeoutHandle = setTimeout(async () => {
    if (settled) return;
    settled = true;
    child.kill('SIGKILL');
    console.warn(`[taskLifecycle] abort timed out for instance #${instanceId} (${sessionKey})`);
    await markInstanceFailed(db, instanceId, 'abort timed out after task cancel/stop');
  }, ABORT_TIMEOUT_MS);

  child.on('close', async (code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutHandle);

    const responseText = stdout.trim();
    const errorText = stderr.trim();

    // Treat "session not found" / "already gone" as a non-error success path
    const haystack = `${responseText} ${errorText}`.toLowerCase();
    const alreadyGone =
      (haystack.includes('session') || haystack.includes('run') || haystack.includes('target')) &&
      ['session not found', 'not found', 'no active run', 'not running', 'already_gone', 'missing']
        .some(s => haystack.includes(s));

    if (alreadyGone) {
      await markInstanceCancelled(db, instanceId, 'already_gone');
      console.log(`[taskLifecycle] instance #${instanceId} already gone — ${reason}`);
      return;
    }

    if (code !== 0) {
      // Abort failed entirely — mark failed, no watchdog
      const failReason = errorText || `abort exited with code ${code}`;
      console.warn(`[taskLifecycle] abort failed for instance #${instanceId}: ${failReason}`);
      await markInstanceFailed(db, instanceId, `abort failed after task cancel/stop: ${failReason}`);
      return;
    }

    // chat.abort succeeded (exit 0) — start watchdog to verify the session actually stops.
    // The soft signal may be ignored if the agent is between tool calls.
    console.log(`[taskLifecycle] chat.abort sent for instance #${instanceId} — starting watchdog (${WATCHDOG_GRACE_MS}ms grace, ${WATCHDOG_MAX_POLLS} polls)`);
    const baselineTs = Date.now();

    const watchdogTimer = setTimeout(async () => {
      await runAbortWatchdog(db, instanceId, sessionKey, reason, baselineTs);
    }, WATCHDOG_GRACE_MS);

    // Unref so the watchdog doesn't prevent Node from exiting if everything else is done
    watchdogTimer.unref();
  });

  child.on('error', async (err: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutHandle);
    console.error(`[taskLifecycle] spawn error aborting instance #${instanceId}:`, err);
    await markInstanceFailed(db, instanceId, `spawn error during abort: ${err.message}`);
  });
}

/**
 * Watchdog: runs after chat.abort grace period. Checks if the session is still
 * active via sessions.get polling; if still alive after all retries, escalates
 * to sessions.delete (hard kill).
 *
 * Fully non-blocking: uses recursive setTimeout so the event loop stays free.
 */
async function runAbortWatchdog(
  db: Db,
  instanceId: number,
  sessionKey: string,
  reason: string,
  baselineTs: number,
): Promise<void> {
  // First check: is the instance already terminal?
  const inst = await db.get(`SELECT status FROM job_instances WHERE id = ?`, instanceId) as { status: string } | undefined;
  if (!inst || ['done', 'failed', 'cancelled'].includes(inst.status)) {
    console.log(`[taskLifecycle:watchdog] instance #${instanceId} already terminal (${inst?.status ?? 'gone'}) — watchdog done`);
    return;
  }

  // Resolve the full OpenClaw session key (agent:<slug>:<key>)
  const maybeFullKey = await resolveFullSessionKey(db, instanceId, sessionKey);
  if (!maybeFullKey) {
    // Can't resolve full key — assume soft abort was sufficient
    console.warn(`[taskLifecycle:watchdog] cannot resolve full session key for instance #${instanceId}, assuming soft abort was sufficient`);
    await markInstanceCancelled(db, instanceId, 'succeeded');
    return;
  }
  const fullSessionKey: string = maybeFullKey;

  let pollCount = 0;

  async function doPoll(): Promise<void> {
    // Re-check instance status before each poll
    const current = await db.get(`SELECT status FROM job_instances WHERE id = ?`, instanceId) as { status: string } | undefined;
    if (!current || ['done', 'failed', 'cancelled'].includes(current.status)) {
      console.log(`[taskLifecycle:watchdog] instance #${instanceId} became terminal during poll ${pollCount + 1} — watchdog done`);
      return;
    }

    pollCount++;
    const sessionActive = sessionStillActiveSync(fullSessionKey, baselineTs);

    if (!sessionActive) {
      console.log(`[taskLifecycle:watchdog] session gone for instance #${instanceId} at poll ${pollCount} — marking cancelled`);
      await markInstanceCancelled(db, instanceId, 'succeeded');
      return;
    }

    console.log(`[taskLifecycle:watchdog] session still active for instance #${instanceId} at poll ${pollCount}/${WATCHDOG_MAX_POLLS}`);

    if (pollCount < WATCHDOG_MAX_POLLS) {
      // Schedule the next poll
      const t = setTimeout(doPoll, WATCHDOG_POLL_INTERVAL_MS);
      t.unref();
      return;
    }

    // All polls exhausted — escalate to hard kill
    console.warn(`[taskLifecycle:watchdog] session still active after ${WATCHDOG_MAX_POLLS} polls for instance #${instanceId} — escalating to sessions.delete`);
    const killResult = hardKillSessionSync(fullSessionKey);
    if (killResult.ok) {
      await markInstanceCancelled(db, instanceId, 'hard_killed');
      console.log(`[taskLifecycle:watchdog] sessions.delete succeeded for instance #${instanceId} — marked cancelled (hard_killed)`);
    } else {
      console.error(`[taskLifecycle:watchdog] sessions.delete failed for instance #${instanceId}: ${killResult.error}`);
      await markInstanceFailed(db, instanceId, `hard kill failed after soft abort was ignored: ${killResult.error}`);
    }
  }

  // Kick off the first poll immediately (we already waited WATCHDOG_GRACE_MS)
  await doPoll();
}

async function markInstanceCancelled(db: Db, instanceId: number, abortStatus: string): Promise<void> {
  try {
    await db.run(`
      UPDATE job_instances
      SET status = 'cancelled',
          abort_attempted_at = COALESCE(abort_attempted_at, datetime('now')),
          abort_status = ?,
          abort_error = NULL,
          completed_at = datetime('now')
      WHERE id = ?
        AND status NOT IN ('done', 'failed', 'cancelled')
    `, abortStatus, instanceId);
  } catch (err) {
    console.error(`[taskLifecycle] failed to mark instance #${instanceId} as cancelled:`, err);
  }
}

async function markInstanceFailed(db: Db, instanceId: number, reason: string): Promise<void> {
  try {
    await db.run(`
      UPDATE job_instances
      SET status = 'failed',
          abort_attempted_at = COALESCE(abort_attempted_at, datetime('now')),
          abort_status = 'failed',
          abort_error = ?,
          error = ?,
          completed_at = datetime('now')
      WHERE id = ?
        AND status NOT IN ('done', 'failed', 'cancelled')
    `, reason, reason, instanceId);
  } catch (err) {
    console.error(`[taskLifecycle] failed to mark instance #${instanceId} as failed:`, err);
  }
}

// ── Exported lifecycle functions ─────────────────────────────────────────────

export async function cleanupTaskExecutionLinkageForStatus(
  db: Db,
  taskId: number,
  nextStatus?: string | null,
  options?: {
    deferEndedActiveInstanceCleanup?: boolean;
    authoritativeInstanceId?: number | null;
    changedBy?: string;
  },
): Promise<boolean> {
  const task = await db.get(`
    SELECT id, status, agent_id, active_instance_id
    FROM tasks
    WHERE id = ?
  `, taskId) as { id: number; status: string; agent_id: number | null; active_instance_id: number | null } | undefined;

  if (!task) return false;

  const effectiveStatus = nextStatus ?? task.status;
  if (effectiveStatus === 'done') {
    await cleanupDoneTaskWorktrees(db, taskId);
  }

  if (!task.active_instance_id) return false;

  if (taskAllowsActiveExecution(effectiveStatus)) return false;
  if (effectiveStatus === 'review' && await taskAllowsReviewExecution(db, task)) return false;
  // Deployment-stage exception: preserve authority while a release run is still
  // live. Once an outcome closes the instance, ended-linkage cleanup clears it.
  if ((effectiveStatus === 'ready_to_merge' || effectiveStatus === 'deployed') && await taskAllowsReleaseExecution(db, task)) return false;

  if (options?.deferEndedActiveInstanceCleanup) {
    const authoritativeInstanceId = options.authoritativeInstanceId ?? task.active_instance_id;
    if (authoritativeInstanceId != null && authoritativeInstanceId === task.active_instance_id) {
      const scheduled = await scheduleEndedActiveInstanceLinkageCleanup(db, taskId, authoritativeInstanceId, {
              changedBy: options.changedBy,
            });
      if (scheduled) return false;
    }
  }

  // Capture orphaned instance info before clearing linkage
  const orphanedInstanceId = task.active_instance_id;
  const orphanedInstance = await db.get(`
    SELECT id, session_key, status
    FROM job_instances
    WHERE id = ?
  `, orphanedInstanceId) as { id: number; session_key: string | null; status: string } | undefined;

  const result = await db.run(`
    UPDATE tasks
    SET active_instance_id = NULL,
        ${await taskTableHasColumn(db, 'agent_id') ? 'agent_id = NULL,' : ''}
        updated_at = datetime('now')
    WHERE id = ?
      AND active_instance_id IS NOT NULL
  `, taskId);

  if (result.changes > 0 && orphanedInstance) {
    const { session_key: sessionKey, status: instanceStatus } = orphanedInstance;

    // Only abort instances that are still live (dispatched/running).
    // Queued instances have no active session to abort — just mark failed.
    const isLive = instanceStatus === 'dispatched' || instanceStatus === 'running';

    if (sessionKey && isLive) {
      // Fire-and-forget async abort — never blocks the event loop
      abortOrphanedInstanceAsync(
        db,
        orphanedInstanceId,
        sessionKey,
        `task #${taskId} cancelled/stopped (status → ${effectiveStatus})`,
      );
    } else if (instanceStatus === 'queued' || (isLive && !sessionKey)) {
      // Queued or live-but-sessionless: no session to abort, mark failed immediately
      await markInstanceFailed(
                db,
                orphanedInstanceId,
                `orphaned by task #${taskId} cancel/stop (status → ${effectiveStatus}); no session key to abort`,
              );
    }
    // Already-terminal instances (done/failed) are left untouched
  }

  return result.changes > 0;
}

export async function cleanupImpossibleTaskLifecycleStates(db: Db): Promise<number> {
  const rows = await db.all(`
    SELECT t.id, t.status, t.active_instance_id,
           ji.status AS instance_status,
           ji.runtime_ended_at,
           ji.lifecycle_outcome_posted_at
    FROM tasks t
    LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
    WHERE t.active_instance_id IS NOT NULL
  `) as Array<{
    id: number;
    status: string;
    active_instance_id: number;
    instance_status: string | null;
    runtime_ended_at: string | null;
    lifecycle_outcome_posted_at: string | null;
  }>;

  let cleared = 0;
  const nowMs = Date.now();

  for (const row of rows) {
    const liveInstance = row.instance_status != null
      && LIVE_INSTANCE_STATUSES.includes(row.instance_status as typeof LIVE_INSTANCE_STATUSES[number]);
    const validLiveStatus = ACTIVE_LINKAGE_RETAIN_STATUSES.includes(row.status as typeof ACTIVE_LINKAGE_RETAIN_STATUSES[number]);
    if (liveInstance && validLiveStatus) {
      continue;
    }

    if (isWithinEndedLinkageGraceWindow(row.runtime_ended_at, row.lifecycle_outcome_posted_at, nowMs)) {
      continue;
    }

    const result = await db.run(`
      UPDATE tasks
      SET active_instance_id = NULL,
          ${await taskTableHasColumn(db, 'agent_id') ? 'agent_id = NULL,' : ''}
          updated_at = datetime('now')
      WHERE id = ?
        AND active_instance_id = ?
    `, row.id, row.active_instance_id);
    cleared += result.changes;
  }

  return cleared;
}
