/**
 * runtimeSessionState.ts
 *
 * Liveness for runs owned by a runtime driver rather than by OpenClaw.
 *
 * The watchdog's OpenClaw equivalent reads that runtime's JSONL session file to
 * answer "is this run actually still working, or only slow?". No other runtime
 * writes that file, so for claude-code/codex/hermes the probe returned nothing
 * and the watchdog's reprieve for a visibly-busy run could never fire — an
 * OpenClaw run mid-tool-call was spared while an identical claude-code run was
 * failed.
 *
 * The signal those runtimes do emit is the canonical transcript: every runtime
 * turn writes timestamped thought/tool_call/tool_result/text rows to
 * chat_messages through RuntimeTranscriptWriter. That is the same evidence in a
 * runtime-agnostic place, which is what this reads.
 */

import { parseTimestamp } from '../../lib/timestamps';
import { type Db } from '../../db/adapter/types';

/**
 * How long a runtime run may emit nothing before silence stops counting as
 * work in progress. Mirrors OPENCLAW_TERMINAL_QUIESCENCE_MS so the two
 * transports agree on what "still going" means.
 */
export const RUNTIME_TERMINAL_QUIESCENCE_MS = 3 * 60 * 1000;

/** Transcript events that prove the agent itself is still producing work. */
const AGENT_ACTIVITY_EVENT_TYPES = new Set(['text', 'thought', 'tool_call', 'tool_result']);

/** Transcript events that mean the turn is over, however it ended. */
const TERMINAL_EVENT_TYPES = new Set(['turn_end', 'error']);

export interface RuntimeInstanceLiveness {
  /** Newest transcript row of any kind, epoch ms. */
  lastEventAtMs: number | null;
  /** Newest row that shows the agent working (not the user's own message). */
  lastActivityAtMs: number | null;
  /** Newest tool_call/tool_result, epoch ms. */
  lastToolUseAtMs: number | null;
  /** True once the runtime has written a turn_end or error for this run. */
  sawTerminalEvent: boolean;
  /** Silence since the last agent activity; null when there has been none. */
  quietForMs: number | null;
  /** Agent activity recent enough that the run should not be judged stale. */
  active: boolean;
}

interface TranscriptActivityRow {
  event_type: string | null;
  role: string | null;
  last_at: string | null;
}

/**
 * Read what the runtime has written for this run.
 *
 * A user message is deliberately not activity: it is what starts a turn, so
 * counting it would defer the kill on a run that never produced anything.
 */
export async function evaluateRuntimeInstanceLiveness(
  db: Db,
  instanceId: number,
  options: { now?: Date; quiescenceMs?: number } = {},
): Promise<RuntimeInstanceLiveness> {
  const now = options.now ?? new Date();
  const quiescenceMs = options.quiescenceMs ?? RUNTIME_TERMINAL_QUIESCENCE_MS;

  const rows = await db.all(`
    SELECT event_type, role, MAX(timestamp) AS last_at
    FROM chat_messages
    WHERE instance_id = ?
    GROUP BY event_type, role
  `, instanceId) as TranscriptActivityRow[];

  let lastEventAtMs: number | null = null;
  let lastActivityAtMs: number | null = null;
  let lastToolUseAtMs: number | null = null;
  let sawTerminalEvent = false;

  for (const row of rows) {
    const at = parseTimestamp(row.last_at)?.getTime() ?? null;
    if (at === null || !Number.isFinite(at)) continue;

    const eventType = (row.event_type ?? '').trim();
    const role = (row.role ?? '').trim();

    if (lastEventAtMs === null || at > lastEventAtMs) lastEventAtMs = at;

    if (TERMINAL_EVENT_TYPES.has(eventType)) sawTerminalEvent = true;

    const isAgentActivity = AGENT_ACTIVITY_EVENT_TYPES.has(eventType) && role !== 'user';
    if (isAgentActivity && (lastActivityAtMs === null || at > lastActivityAtMs)) {
      lastActivityAtMs = at;
    }

    if ((eventType === 'tool_call' || eventType === 'tool_result')
      && (lastToolUseAtMs === null || at > lastToolUseAtMs)) {
      lastToolUseAtMs = at;
    }
  }

  const quietForMs = lastActivityAtMs === null ? null : now.getTime() - lastActivityAtMs;

  // A finished turn is never "still working", no matter how recent its last row.
  const active = !sawTerminalEvent && quietForMs !== null && quietForMs < quiescenceMs;

  return { lastEventAtMs, lastActivityAtMs, lastToolUseAtMs, sawTerminalEvent, quietForMs, active };
}
