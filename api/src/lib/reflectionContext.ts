/**
 * lib/reflectionContext.ts — Composite context builder for reflection/learning workflows.
 *
 * This module assembles a rich, structured context object from the canonical
 * Agent HQ data model so reflection subagents can inspect prior work through
 * one data source without needing to know about runtime-specific storage paths.
 *
 * The composite context includes:
 *   - Session header (metadata, agent, task, project)
 *   - Transcript messages (filtered by event type if requested)
 *   - Task context (title, status, notes, outcome metrics)
 *   - Run history (all instances for the task — retries, failures, outcomes)
 */

import { getDb } from '../db/client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionHeader {
  id: number;
  external_key: string;
  runtime: string;
  agent_id: number | null;
  agent_name: string | null;
  task_id: number | null;
  task_title: string | null;
  instance_id: number | null;
  project_id: number | null;
  project_name: string | null;
  status: string;
  title: string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  token_input: number | null;
  token_output: number | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageEntry {
  id: number;
  ordinal: number;
  role: string;
  event_type: string;
  content: string;
  event_meta: string | null;
  timestamp: string;
}

export interface TaskContext {
  id: number;
  title: string;
  status: string;
  priority: string | null;
  story_points: number | null;
  task_type: string | null;
  failure_detail: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
  notes: Array<{ id: number; author: string; content: string; created_at: string }>;
  outcome_metrics: OutcomeMetrics | null;
}

export interface OutcomeMetrics {
  first_pass_qa: number;
  reopened_count: number;
  rerouted_count: number;
  spawned_defects: number;
  cycle_time_hours: number | null;
}

export interface RunHistoryEntry {
  instance_id: number;
  agent_id: number | null;
  agent_name: string | null;
  status: string;
  task_outcome: string | null;
  blocker_reason: string | null;
  artifact_summary: string | null;
  started_at: string | null;
  completed_at: string | null;
  session_key: string | null;
  token_input: number | null;
  token_output: number | null;
}

export interface ReflectionContext {
  session: SessionHeader;
  messages: MessageEntry[];
  task: TaskContext | null;
  run_history: RunHistoryEntry[];
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface ReflectionContextOptions {
  /** Filter messages to specific event types (e.g., ['text', 'tool_call']). Default: all. */
  eventTypes?: string[];
  /** Max messages to include. Default: 200. */
  messageLimit?: number;
  /** Include raw_payload in messages. Default: false. */
  includeRaw?: boolean;
  /** Max run history entries to include. Default: 20. */
  runHistoryLimit?: number;
}

// ── Main builder ──────────────────────────────────────────────────────────────

/**
 * buildReflectionContext — assemble the composite context for a single session.
 *
 * Returns null if the session doesn't exist.
 */
export function buildReflectionContext(
  sessionId: number,
  opts: ReflectionContextOptions = {},
): ReflectionContext | null {
  const db = getDb();
  const { eventTypes, messageLimit = 200, includeRaw = false, runHistoryLimit = 20 } = opts;

  // ── 1. Session header ────────────────────────────────────────────────────
  const session = db.prepare(`
    SELECT
      s.*,
      a.name AS agent_name,
      t.title AS task_title,
      p.name AS project_name
    FROM sessions s
    LEFT JOIN agents a ON a.id = s.agent_id
    LEFT JOIN tasks t ON t.id = s.task_id
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE s.id = ?
  `).get(sessionId) as SessionHeader | undefined;

  if (!session) return null;

  // ── 2. Messages ──────────────────────────────────────────────────────────
  const msgConditions: string[] = ['session_id = ?'];
  const msgParams: unknown[] = [sessionId];

  if (eventTypes && eventTypes.length > 0) {
    msgConditions.push(`event_type IN (${eventTypes.map(() => '?').join(',')})`);
    msgParams.push(...eventTypes);
  }

  const selectCols = includeRaw
    ? 'id, ordinal, role, event_type, content, event_meta, raw_payload, timestamp'
    : 'id, ordinal, role, event_type, content, event_meta, timestamp';

  msgParams.push(Math.min(messageLimit, 500));
  const messages = db.prepare(`
    SELECT ${selectCols}
    FROM session_messages
    WHERE ${msgConditions.join(' AND ')}
    ORDER BY ordinal ASC
    LIMIT ?
  `).all(...msgParams) as MessageEntry[];

  // ── 3. Task context (if linked) ──────────────────────────────────────────
  let task: TaskContext | null = null;

  if (session.task_id) {
    const taskRow = db.prepare(`
      SELECT
        t.id, t.title, t.status, t.priority, t.story_points, t.task_type,
        t.failure_detail, t.retry_count,
        t.created_at, t.updated_at
      FROM tasks t
      WHERE t.id = ?
    `).get(session.task_id) as Omit<TaskContext, 'notes' | 'outcome_metrics'> | undefined;

    if (taskRow) {
      const notes = db.prepare(`
        SELECT id, author, content, created_at
        FROM task_notes
        WHERE task_id = ?
        ORDER BY created_at ASC
      `).all(session.task_id) as TaskContext['notes'];

      const metricsRow = db.prepare(`
        SELECT first_pass_qa, reopened_count, rerouted_count, spawned_defects,
               cycle_time_hours
        FROM task_outcome_metrics
        WHERE task_id = ?
      `).get(session.task_id) as OutcomeMetrics | undefined;

      task = {
        ...taskRow,
        notes,
        outcome_metrics: metricsRow ?? null,
      };
    }
  }

  // ── 4. Run history (all instances for the linked task) ───────────────────
  // blocker_reason and artifact_summary may not exist in older schemas — use
  // COALESCE with a literal NULL fallback so the query is schema-tolerant.
  let runHistory: RunHistoryEntry[] = [];

  if (session.task_id) {
    // Detect available columns to build a compatible query
    const colInfo = db.prepare("PRAGMA table_info(job_instances)").all() as Array<{ name: string }>;
    const cols = new Set(colInfo.map(c => c.name));
    const blockerCol = cols.has('blocker_reason') ? 'ji.blocker_reason' : "NULL";
    const summaryCol = cols.has('artifact_summary') ? 'ji.artifact_summary' : "NULL";

    runHistory = db.prepare(`
      SELECT
        ji.id AS instance_id,
        ji.agent_id,
        a.name AS agent_name,
        ji.status,
        ji.task_outcome,
        ${blockerCol} AS blocker_reason,
        ${summaryCol} AS artifact_summary,
        ji.started_at,
        ji.completed_at,
        ji.session_key,
        ji.token_input,
        ji.token_output
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE ji.task_id = ?
      ORDER BY ji.created_at DESC
      LIMIT ?
    `).all(session.task_id, Math.min(runHistoryLimit, 100)) as RunHistoryEntry[];
  }

  return { session, messages, task, run_history: runHistory };
}

/**
 * buildAgentReflectionSummary — assemble a lightweight summary of an agent's
 * recent sessions for reflection/telemetry consumers.
 *
 * Returns sessions in reverse chronological order with message count, status,
 * and linked task context.
 */
export interface AgentSessionSummary {
  session_id: number;
  external_key: string;
  runtime: string;
  status: string;
  title: string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  token_input: number | null;
  token_output: number | null;
  task_id: number | null;
  task_title: string | null;
  task_status: string | null;
  instance_id: number | null;
}

export function buildAgentReflectionSummary(
  agentId: number,
  limit = 50,
): AgentSessionSummary[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      s.id AS session_id,
      s.external_key,
      s.runtime,
      s.status,
      s.title,
      s.started_at,
      s.ended_at,
      s.message_count,
      s.token_input,
      s.token_output,
      s.task_id,
      t.title AS task_title,
      t.status AS task_status,
      s.instance_id
    FROM sessions s
    LEFT JOIN tasks t ON t.id = s.task_id
    WHERE s.agent_id = ?
    ORDER BY COALESCE(s.started_at, s.created_at) DESC, s.id DESC
    LIMIT ?
  `).all(agentId, Math.min(limit, 500)) as AgentSessionSummary[];
}

/**
 * buildTaskSessionHistory — all sessions/runs for a task, enriched with instance context.
 * Used by reflection to inspect how a task evolved across retries and handoffs.
 */
export interface TaskSessionEntry {
  session_id: number | null;
  external_key: string | null;
  runtime: string | null;
  session_status: string | null;
  message_count: number;
  instance_id: number;
  instance_status: string;
  task_outcome: string | null;
  blocker_reason: string | null;
  agent_id: number | null;
  agent_name: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export function buildTaskSessionHistory(taskId: number): TaskSessionEntry[] {
  const db = getDb();
  // Schema-tolerant: blocker_reason may not exist in all environments
  const colInfo = db.prepare("PRAGMA table_info(job_instances)").all() as Array<{ name: string }>;
  const cols = new Set(colInfo.map(c => c.name));
  const blockerCol = cols.has('blocker_reason') ? 'ji.blocker_reason' : "NULL";

  return db.prepare(`
    SELECT
      s.id AS session_id,
      s.external_key,
      s.runtime,
      s.status AS session_status,
      COALESCE(s.message_count, 0) AS message_count,
      ji.id AS instance_id,
      ji.status AS instance_status,
      ji.task_outcome,
      ${blockerCol} AS blocker_reason,
      ji.agent_id,
      a.name AS agent_name,
      ji.started_at,
      ji.completed_at
    FROM job_instances ji
    LEFT JOIN sessions s ON s.instance_id = ji.id
    LEFT JOIN agents a ON a.id = ji.agent_id
    WHERE ji.task_id = ?
    ORDER BY ji.created_at DESC
  `).all(taskId) as TaskSessionEntry[];
}
