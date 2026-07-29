import { cleanupImpossibleTaskLifecycleStates } from '../../lib/taskLifecycle';
import { tableHasColumn } from '../../lib/durableRunIdentity';
import { syncTaskActiveAgentFromInstance } from '../tasks/ownership';
import { nowTimestamp } from '../../lib/timestamps';
import { type Db } from "../../db/adapter/types";

export const START_CHECKIN_GRACE_MS = 5 * 60 * 1000;
export const HEARTBEAT_STALE_MS = 10 * 60 * 1000;
export const HEARTBEAT_NOTE_MIN_MS = 15 * 60 * 1000;

export type CheckInStage = 'dispatch' | 'start' | 'heartbeat' | 'progress' | 'blocker' | 'completion';

export interface RunCheckInInput {
  instanceId: number;
  durableRunId?: string | null;
  stage: CheckInStage;
  sessionKey?: string | null;
  summary?: string | null;
  commitHash?: string | null;
  branchName?: string | null;
  changedFiles?: string[] | null;
  changedFilesCount?: number | null;
  meaningfulOutput?: boolean;
  blockerReason?: string | null;
  outcome?: string | null;
  statusLabel?: string | null;
  author?: string;
  forceNote?: boolean;
  suppressNote?: boolean;
  runtimeEndSuccess?: boolean | null;
  runtimeEndError?: string | null;
  runtimeEndSource?: string | null;
}

interface InstanceRow {
  id: number;
  task_id: number | null;
  agent_id: number;
  status: string;
  session_key: string | null;
  durable_run_id?: string | null;
  started_at?: string | null;
}

/**
 * Agent-driven check-in stages: these should be attributed to the agent, not 'Agent HQ'.
 */
const AGENT_DRIVEN_STAGES: ReadonlySet<CheckInStage> = new Set(['dispatch', 'start', 'heartbeat', 'progress', 'blocker', 'completion']);

/**
 * Resolve the agent's display name from the agents table for a given agent_id.
 * Returns null if the agent is not found.
 */
async function resolveAgentName(db: Db, agentId: number): Promise<string | null> {
  const row = await db.get('SELECT name FROM agents WHERE id = ?', agentId) as { name: string } | undefined;
  return row?.name ?? null;
}

function normalizeTimestamp(raw?: string | null): number | null {
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZ = normalized.endsWith('Z') ? normalized : `${normalized}Z`;
  const ms = new Date(withZ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function parseChangedFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item).trim())
    .filter(Boolean)
    .slice(0, 200);
}

/** @deprecated Use selectTaskForAgent instead */
export async function selectTaskForJob(db: Db, jobId: number): Promise<number | null> {
  return await selectTaskForAgent(db, jobId);
}

export async function selectTaskForAgent(db: Db, agentId: number): Promise<number | null> {
  await cleanupImpossibleTaskLifecycleStates(db);
  const assignmentColumn = (await db.all('PRAGMA table_info(tasks)') as Array<{ name: string }>).some((col) => col.name === 'assigned_agent_id')
    ? 'assigned_agent_id'
    : 'agent_id';

  const row = await db.get(`
    SELECT id
    FROM tasks
    WHERE ${assignmentColumn} = ?
      AND status IN ('in_progress', 'ready', 'review', 'todo', 'stalled')
    ORDER BY
      CASE status
        WHEN 'in_progress' THEN 0
        WHEN 'ready' THEN 1
        WHEN 'review' THEN 2
        WHEN 'todo' THEN 3
        WHEN 'stalled' THEN 4
        ELSE 5
      END,
      priority DESC,
      updated_at ASC,
      created_at ASC
    LIMIT 1
  `, agentId) as { id: number } | undefined;

  return row?.id ?? null;
}

export async function attachInstanceToTask(db: Db, instanceId: number, taskId: number | null): Promise<void> {
  await db.run(`UPDATE job_instances SET task_id = ? WHERE id = ?`, taskId, instanceId);

  if (taskId) {
    await db.run(`
      UPDATE tasks
      SET active_instance_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `, instanceId, taskId);
    await syncTaskActiveAgentFromInstance(db, taskId);
  }
}

export async function resolveTaskIdForInstance(db: Db, instanceId: number): Promise<number | null> {
  const instance = await db.get(`SELECT id, task_id FROM job_instances WHERE id = ?`, instanceId) as {
    id: number;
    task_id: number | null;
  } | undefined;

  if (!instance) return null;
  if (instance.task_id) return instance.task_id;

  const linkedTask = await db.get(`
    SELECT id
    FROM tasks
    WHERE active_instance_id = ?
    LIMIT 1
  `, instanceId) as { id: number } | undefined;

  if (!linkedTask) return null;

  await attachInstanceToTask(db, instanceId, linkedTask.id);
  return linkedTask.id;
}

function buildStructuredNote(input: Required<Pick<RunCheckInInput, 'stage'>> & Omit<RunCheckInInput, 'stage'>): string {
  const lines: string[] = [];
  const label = input.stage === 'completion'
    ? (input.runtimeEndSuccess === false ? 'Run failed' : 'Run completed')
    : {
        dispatch: 'Run dispatched',
        start: 'Run started',
        heartbeat: 'Heartbeat',
        progress: 'Progress update',
        blocker: 'Blocked',
      }[input.stage];

  lines.push(`Agent check-in: ${label}`);

  if (input.statusLabel) lines.push(`Status: ${input.statusLabel}`);
  if (input.summary) lines.push(`Summary: ${input.summary}`);
  if (input.blockerReason) lines.push(`Blocker: ${input.blockerReason}`);
  if (input.branchName) lines.push(`Branch: ${input.branchName}`);
  if (input.commitHash) lines.push(`Commit: ${input.commitHash}`);
  if (typeof input.changedFilesCount === 'number') lines.push(`Changed files: ${input.changedFilesCount}`);
  if (input.changedFiles && input.changedFiles.length > 0) {
    lines.push(`Files: ${input.changedFiles.slice(0, 20).join(', ')}`);
  }
  if (input.outcome) lines.push(`Outcome: ${input.outcome}`);
  if (input.sessionKey) lines.push(`Session: ${input.sessionKey}`);
  if (input.durableRunId) lines.push(`Durable run ID: ${input.durableRunId}`);

  return lines.join('\n');
}

function mentionsMissingLifecycleOutcome(text: string): boolean {
  if (!text) return false;
  return (
    text.includes('without required lifecycle outcome')
    || text.includes('without posting lifecycle outcome')
    || text.includes('without posting any lifecycle outcome')
    || text.includes('did not post a required lifecycle outcome')
    || (text.includes('without') && text.includes('lifecycle outcome'))
  );
}

function isMissingLifecycleHandoffCompletion(input: RunCheckInInput, instance: (InstanceRow & {
  lifecycle_outcome_posted_at?: string | null;
  task_outcome?: string | null;
}) | undefined): boolean {
  const summary = input.summary?.trim().toLowerCase() ?? '';
  const runtimeEndError = input.runtimeEndError?.trim().toLowerCase() ?? '';
  const mentionsMissingOutcome = mentionsMissingLifecycleOutcome(summary)
    || mentionsMissingLifecycleOutcome(runtimeEndError);

  return input.stage === 'completion'
    && !instance?.lifecycle_outcome_posted_at
    && !instance?.task_outcome
    && mentionsMissingOutcome;
}

export async function recordRunCheckIn(db: Db, input: RunCheckInInput): Promise<{ taskId: number | null; noteCreated: boolean }> {
  const nowTs = nowTimestamp();
  const changedFiles = parseChangedFiles(input.changedFiles);
  const changedFilesCount = input.changedFilesCount ?? (changedFiles.length > 0 ? changedFiles.length : null);
  const taskId = await resolveTaskIdForInstance(db, input.instanceId);

  const hasDurableRunId = await tableHasColumn(db, 'job_instances', 'durable_run_id');
  const instance = await db.get(`
    SELECT id, task_id, agent_id, status, session_key, ${hasDurableRunId ? 'durable_run_id' : 'NULL AS durable_run_id'}, started_at, lifecycle_outcome_posted_at, task_outcome
    FROM job_instances
    WHERE id = ?
  `, input.instanceId) as (InstanceRow & {
    lifecycle_outcome_posted_at?: string | null;
    task_outcome?: string | null;
  }) | undefined;

  if (!instance) {
    throw new Error(`Instance ${input.instanceId} not found`);
  }
  const durableRunId = typeof instance.durable_run_id === 'string' && instance.durable_run_id.trim()
    ? instance.durable_run_id.trim()
    : null;

  const trustedStartSignal = ['start', 'heartbeat', 'progress', 'blocker', 'completion'].includes(input.stage);
  const suppressCompletionNote = isMissingLifecycleHandoffCompletion(input, instance);

  await db.run(`
    INSERT INTO instance_artifacts (
      instance_id,
      task_id,
      current_stage,
      summary,
      latest_commit_hash,
      branch_name,
      changed_files_json,
      changed_files_count,
      blocker_reason,
      outcome,
      last_agent_heartbeat_at,
      last_meaningful_output_at,
      started_at,
      completed_at,
      stale,
      stale_at,
      session_key,
      updated_at,
      last_note_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL)
    ON CONFLICT(instance_id) DO UPDATE SET
      task_id = excluded.task_id,
      current_stage = excluded.current_stage,
      summary = COALESCE(excluded.summary, instance_artifacts.summary),
      latest_commit_hash = COALESCE(excluded.latest_commit_hash, instance_artifacts.latest_commit_hash),
      branch_name = COALESCE(excluded.branch_name, instance_artifacts.branch_name),
      changed_files_json = CASE WHEN excluded.changed_files_json IS NOT NULL AND excluded.changed_files_json != '[]' THEN excluded.changed_files_json ELSE instance_artifacts.changed_files_json END,
      changed_files_count = COALESCE(excluded.changed_files_count, instance_artifacts.changed_files_count),
      blocker_reason = CASE WHEN excluded.blocker_reason IS NOT NULL THEN excluded.blocker_reason ELSE instance_artifacts.blocker_reason END,
      outcome = CASE WHEN excluded.outcome IS NOT NULL THEN excluded.outcome ELSE instance_artifacts.outcome END,
      last_agent_heartbeat_at = COALESCE(excluded.last_agent_heartbeat_at, instance_artifacts.last_agent_heartbeat_at),
      last_meaningful_output_at = COALESCE(excluded.last_meaningful_output_at, instance_artifacts.last_meaningful_output_at),
      started_at = COALESCE(instance_artifacts.started_at, excluded.started_at),
      completed_at = COALESCE(excluded.completed_at, instance_artifacts.completed_at),
      stale = 0,
      stale_at = NULL,
      session_key = COALESCE(excluded.session_key, instance_artifacts.session_key),
      updated_at = excluded.updated_at
  `, input.instanceId, taskId, input.stage, input.summary ?? null, input.commitHash ?? null, input.branchName ?? null, JSON.stringify(changedFiles), changedFilesCount, input.blockerReason ?? null, input.outcome ?? null, trustedStartSignal ? nowTs : null, input.meaningfulOutput || ['progress', 'blocker', 'completion'].includes(input.stage) ? nowTs : null, trustedStartSignal ? nowTs : null, input.stage === 'completion' ? nowTs : null, input.sessionKey ?? instance.session_key ?? null, nowTs);

  const artifact = await db.get(`
    SELECT summary, current_stage, last_note_at, changed_files_json, latest_commit_hash, branch_name, blocker_reason, outcome
    FROM instance_artifacts
    WHERE instance_id = ?
  `, input.instanceId) as {
    summary: string | null;
    current_stage: string | null;
    last_note_at: string | null;
    changed_files_json: string | null;
    latest_commit_hash: string | null;
    branch_name: string | null;
    blocker_reason: string | null;
    outcome: string | null;
  };

  const previousNoteMs = normalizeTimestamp(artifact.last_note_at);
  const shouldNoteBecauseTime = previousNoteMs === null || (Date.now() - previousNoteMs) >= HEARTBEAT_NOTE_MIN_MS;
  const shouldCreateNote = !input.suppressNote && !suppressCompletionNote && Boolean(
    input.forceNote
    || input.stage === 'dispatch'
    || input.stage === 'start'
    || input.stage === 'blocker'
    || input.stage === 'completion'
    || input.meaningfulOutput
    || (input.stage === 'heartbeat' && shouldNoteBecauseTime && input.summary)
    || (input.stage === 'progress' && (input.summary || changedFilesCount || input.commitHash || input.branchName))
  );

  let noteCreated = false;
  if (taskId && shouldCreateNote) {
    const note = buildStructuredNote({
      ...input,
      stage: input.stage,
      durableRunId,
      changedFiles,
      changedFilesCount: changedFilesCount ?? undefined,
    });

    // For agent-driven stages, attribute the note to the agent name rather than 'Agent HQ'.
    // If an explicit author was passed in, honour it; otherwise resolve from the agents table.
    let noteAuthor: string;
    if (input.author !== undefined) {
      noteAuthor = input.author;
    } else if (AGENT_DRIVEN_STAGES.has(input.stage)) {
      noteAuthor = (await resolveAgentName(db, instance.agent_id)) ?? 'Agent HQ';
    } else {
      noteAuthor = 'Agent HQ';
    }

    await db.run(`
      INSERT INTO task_notes (task_id, author, content)
      VALUES (?, ?, ?)
    `, taskId, noteAuthor, note);

    await db.run(`
      UPDATE instance_artifacts
      SET last_note_at = ?
      WHERE instance_id = ?
    `, nowTs, input.instanceId);

    noteCreated = true;
  }

  if (trustedStartSignal) {
    // Preserve a 'claude-code:' session_key that was set by ClaudeCodeRuntime from the
    // SDK init message — do not overwrite it with the 'hook:atlas:jobrun:' key from the
    // agent's start callback, which is sent before the SDK updates the key.
    // Runtime bookkeeping may advance the internal instance row to running, but it must
    // not silently mutate visible task workflow state here.
    await db.run(`
      UPDATE job_instances
      SET session_key = CASE
            WHEN session_key LIKE 'claude-code:%' THEN session_key
            ELSE COALESCE(?, session_key)
          END,
          status = CASE WHEN status IN ('queued', 'dispatched') THEN 'running' ELSE status END,
          started_at = COALESCE(started_at, ?)
      WHERE id = ?
    `, input.sessionKey ?? null, nowTs, input.instanceId);
  }

  if (input.stage === 'completion') {
    const runtimeEndSuccess = input.runtimeEndSuccess ?? (input.statusLabel ? input.statusLabel !== 'failed' : !['failed', 'runtime_failed', 'infra_failed'].includes(input.outcome ?? ''));
    const runtimeEndError = input.runtimeEndError ?? (runtimeEndSuccess ? null : (input.summary ?? input.blockerReason ?? null));
    const existingInstance = await db.get(`
      SELECT status, lifecycle_outcome_posted_at, task_outcome
      FROM job_instances
      WHERE id = ?
    `, input.instanceId) as {
      status: string;
      lifecycle_outcome_posted_at: string | null;
      task_outcome: string | null;
    } | undefined;
    const runtimeEndedWithoutLifecycleOutcome = Boolean(
      existingInstance &&
      !existingInstance.lifecycle_outcome_posted_at &&
      !existingInstance.task_outcome
    );
    const nextStatus = input.statusLabel
      ?? existingInstance?.status
      ?? 'done';
    await db.run(`
      UPDATE job_instances
      SET status = ?,
          started_at = COALESCE(started_at, ?),
          completed_at = COALESCE(completed_at, ?),
          runtime_ended_at = COALESCE(runtime_ended_at, ?),
          runtime_end_success = COALESCE(runtime_end_success, ?),
          runtime_end_error = COALESCE(?, runtime_end_error),
          runtime_end_source = COALESCE(?, runtime_end_source)
      WHERE id = ?
    `, nextStatus, nowTs, nowTs, nowTs, runtimeEndSuccess ? 1 : 0, runtimeEndError, input.runtimeEndSource ?? 'instance_complete', input.instanceId);
  }

  return { taskId, noteCreated };
}

export async function markInstanceStale(db: Db, instanceId: number, reason: string): Promise<{ taskId: number | null; changed: boolean }> {
  const taskId = await resolveTaskIdForInstance(db, instanceId);
  const existing = await db.get(`SELECT stale FROM instance_artifacts WHERE instance_id = ?`, instanceId) as { stale: number } | undefined;
  if (existing?.stale) {
    return { taskId, changed: false };
  }

  const nowTs = nowTimestamp();
  await db.run(`
    INSERT INTO instance_artifacts (instance_id, task_id, current_stage, stale, stale_at, updated_at)
    VALUES (?, ?, 'heartbeat', 1, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET
      task_id = excluded.task_id,
      stale = 1,
      stale_at = excluded.stale_at,
      updated_at = excluded.updated_at
  `, instanceId, taskId, nowTs, nowTs);

  if (taskId) {
    await db.run(`
      INSERT INTO task_notes (task_id, author, content)
      VALUES (?, 'Agent HQ', ?)
    `, taskId, `Agent run appears stale\nReason: ${reason}`);
  }

  return { taskId, changed: true };
}
