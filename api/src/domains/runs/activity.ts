/**
 * activity.ts — "is this run doing something right now, and what?"
 *
 * WHY THIS EXISTS
 * A chat client needs a typing indicator while an agent turn is open. Every
 * local runtime already writes transcript rows to chat_messages as a run
 * progresses, so liveness is recorded — it was simply never exposed as a
 * single readable state:
 *
 *   claude-code / codex  RuntimeTranscriptWriter.enqueue() per stream event
 *   hermes               transcript poller, HERMES_TRANSCRIPT_POLL_INTERVAL_MS
 *   openclaw             gateway capture socket; deltas upsert a rolling row
 *                        and advance its timestamp, so MAX(timestamp) moves
 *
 * Because all four land in the same table, the read here is runtime-agnostic.
 * What is NOT uniform is event_meta, which carries a different shape per
 * runtime — that difference is reconciled by describeActivity() so clients
 * never branch on runtime_type.
 */

import { type Db } from '../../db/adapter/types';
import { parseTimestamp, toIsoUtc } from '../../lib/timestamps';

/** Terminal instance statuses: a turn cannot be open in any of these. */
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'aborted']);

/**
 * How long after the last transcript row a run is still presumed active.
 *
 * Sized off the slowest producer rather than the fastest: Hermes ingests on a
 * 2s poll, so anything tighter would flicker between working and stalled
 * between two healthy polls.
 */
const ACTIVITY_FRESH_MS = 15_000;

/**
 * The same allowance while a tool call is outstanding.
 *
 * A tool writes one row when it is issued and the next when it returns, so a
 * long build, test run, or search legitimately produces no transcript rows for
 * minutes. Judging that window by ACTIVITY_FRESH_MS reports the busiest part of
 * a run as stalled.
 */
const TOOL_CALL_FRESH_MS = 180_000;

export type RunActivityState =
  | 'idle'
  | 'starting'
  | 'working'
  | 'stalled'
  | 'done';

export interface RunActivity {
  instance_id: number;
  state: RunActivityState;
  /** Latest transcript event type, or null when nothing has been written yet. */
  activity: string | null;
  /** Human-readable present-tense label, e.g. "Running a command". */
  label: string;
  /** Optional specifier, e.g. the tool name. Null when there is nothing to add. */
  detail: string | null;
  /** ISO-8601 UTC of the newest transcript row, or null before the first one. */
  last_event_at: string | null;
  /** Coarse lifecycle phase from instance_artifacts. */
  stage: string | null;
}

interface ActivityRow {
  status: unknown;
  event_type: unknown;
  event_meta: unknown;
  last_event_at: unknown;
  stage: unknown;
}

function parseMeta(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Pull a tool name out of event_meta regardless of which runtime wrote it.
 *
 * Observed shapes, all live in production:
 *   claude-code  { tool_name: "Bash", tool_input: {...} }
 *   codex        { tool_name: "shell", ... }
 *   hermes       { source: "hermes-json", name: "patch", arguments: "..." }
 *   openclaw     { name: "agent-hq__agent-12.agent_hq_post_task_outcome", args: {...} }
 */
function readToolName(meta: Record<string, unknown>): string | null {
  const raw = typeof meta.tool_name === 'string' && meta.tool_name.trim()
    ? meta.tool_name
    : typeof meta.name === 'string' && meta.name.trim()
      ? meta.name
      : null;
  if (!raw) return null;
  return prettifyToolName(raw.trim());
}

/**
 * Reduce a wire tool name to something a person reads in a status line.
 *
 * MCP tools arrive fully qualified and per-agent — openclaw writes
 * `agent-hq__agent-99974437.agent_hq_post_task_outcome`. Showing that verbatim
 * would leak an agent id into the UI and bury the verb, so keep the last
 * segment and drop the transport's separators.
 */
export function prettifyToolName(raw: string): string {
  const lastDotted = raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1) : raw;
  const lastScoped = lastDotted.includes('__')
    ? lastDotted.slice(lastDotted.lastIndexOf('__') + 2)
    : lastDotted;
  const trimmed = lastScoped.trim();
  return trimmed || raw;
}

/**
 * Map a transcript event onto a present-tense status line.
 *
 * Labels describe what the agent is doing rather than naming the event, so the
 * indicator reads as activity ("Running a command") and not as telemetry
 * ("tool_call").
 */
export function describeActivity(
  eventType: string | null,
  meta: Record<string, unknown>,
): { label: string; detail: string | null } {
  const tool = readToolName(meta);

  switch (eventType) {
    case 'thought':
      return { label: 'Thinking', detail: null };
    case 'tool_call':
      return { label: tool ? `Using ${tool}` : 'Using a tool', detail: tool };
    case 'tool_result':
      return { label: 'Reading results', detail: tool };
    case 'text':
      return { label: 'Writing', detail: null };
    case 'turn_end':
      return { label: 'Finished', detail: null };
    default:
      return { label: 'Working', detail: null };
  }
}

/**
 * Resolve the current activity of one run.
 *
 * Returns null when the instance does not exist, so the caller can 404 rather
 * than inventing an idle state for an id that was never real.
 */
export async function getInstanceActivity(
  db: Db,
  instanceId: number,
  now: Date = new Date(),
): Promise<RunActivity | null> {
  const row = await db.get(`
    SELECT
      ji.status AS status,
      cm.event_type AS event_type,
      cm.event_meta AS event_meta,
      cm.timestamp AS last_event_at,
      ia.current_stage AS stage
    FROM job_instances ji
    LEFT JOIN LATERAL (
      SELECT event_type, event_meta, timestamp
      FROM chat_messages
      WHERE instance_id = ji.id
      ORDER BY timestamp DESC
      LIMIT 1
    ) cm ON true
    LEFT JOIN LATERAL (
      SELECT current_stage
      FROM instance_artifacts
      WHERE instance_id = ji.id
      ORDER BY id DESC
      LIMIT 1
    ) ia ON true
    WHERE ji.id = ?
  `, instanceId) as ActivityRow | undefined;

  if (!row) return null;

  const status = typeof row.status === 'string' ? row.status : '';
  const eventType = typeof row.event_type === 'string' ? row.event_type : null;
  const meta = parseMeta(row.event_meta);
  const stage = typeof row.stage === 'string' ? row.stage : null;
  const lastEventAt = toIsoUtc(row.last_event_at);
  const lastEventDate = parseTimestamp(row.last_event_at);

  const { label, detail } = describeActivity(eventType, meta);

  const state = resolveState({
    status,
    eventType,
    lastEventDate,
    now,
  });

  return {
    instance_id: instanceId,
    state,
    activity: eventType,
    // A finished run should not advertise the last thing it was doing as if it
    // were still doing it.
    label: state === 'done' || state === 'idle'
      ? 'Idle'
      : state === 'stalled'
        ? 'No recent activity'
        : state === 'starting'
          ? 'Starting up'
          : label,
    detail: state === 'working' ? detail : null,
    last_event_at: lastEventAt,
    stage,
  };
}

function resolveState(args: {
  status: string;
  eventType: string | null;
  lastEventDate: Date | null;
  now: Date;
}): RunActivityState {
  const { status, eventType, lastEventDate, now } = args;

  // Instance status and turn_end are authoritative over event age. Hermes lags
  // its transcript by up to one poll interval, so a run can look "fresh" for a
  // couple of seconds after it has actually finished.
  if (TERMINAL_STATUSES.has(status)) return 'done';
  if (eventType === 'turn_end') return 'done';

  if (!lastEventDate) {
    // Dispatched with nothing written yet is the gap between spawn and first
    // token — the exact window a typing indicator exists to cover.
    return status === 'dispatched' || status === 'running' || status === 'queued'
      ? 'starting'
      : 'idle';
  }

  const ageMs = now.getTime() - lastEventDate.getTime();
  // An outstanding tool call is the agent waiting on something slow, which is
  // work rather than silence, so it gets the longer allowance.
  const freshMs = eventType === 'tool_call' ? TOOL_CALL_FRESH_MS : ACTIVITY_FRESH_MS;
  if (ageMs > freshMs) return 'stalled';
  return 'working';
}
