/**
 * runtimeEvents.ts — Shared runtime completion event contract.
 *
 * These events represent transport/runtime truth about a run or turn ending.
 * They are intentionally separate from semantic task outcomes such as
 * `blocked`, `qa_pass`, or `completed_for_review`, which are workflow-layer
 * concepts inferred or reported elsewhere.
 *
 * Runtimes can adopt this contract incrementally by emitting `onRuntimeEnd`
 * without needing to parse transcript text for task semantics.
 */

export const RUNTIME_END_EVENT_TYPES = ['runEnded', 'turnEnded'] as const;
export type RuntimeEndEventType = typeof RUNTIME_END_EVENT_TYPES[number];

export const RUNTIME_EVENT_SOURCES = ['openclaw', 'claude-code', 'veri', 'hermes', 'webhook'] as const;
export type RuntimeEventSource = typeof RUNTIME_EVENT_SOURCES[number];

export const RUNTIME_END_REASONS = ['completed', 'aborted', 'timeout', 'error'] as const;
export type RuntimeEndReason = typeof RUNTIME_END_REASONS[number];

/**
 * Canonical runtime-level completion payload.
 *
 * Runtime end events communicate transport truth only: a run or turn ended,
 * whether the runtime considered it successful, when it ended, and any raw
 * runtime error or terminal metadata.
 *
 * They intentionally do NOT encode semantic workflow outcomes such as
 * `blocked`, `qa_pass`, or `completed_for_review`. Those belong to the
 * workflow/lifecycle layer and may be derived or reported separately.
 *
 * Canonical fields:
 * - `type`: whether the runtime ended an entire run or a single turn
 * - `source`: which runtime emitted the event
 * - `sessionKey`: canonical Atlas/OpenClaw session key for the run
 * - `success`: whether the runtime itself considers the run complete/successful
 * - `endedAt`: ISO timestamp for the terminal runtime event
 * - `runId`: runtime-native run identifier when available
 * - `error`: raw runtime error string when the run ended unsuccessfully
 * - `reason`: normalized terminal runtime reason
 * - `metadata`: transport/runtime-specific details only, never semantic outcomes
 */
export interface RuntimeEndEvent {
  type: RuntimeEndEventType;
  source: RuntimeEventSource;
  sessionKey: string;
  success: boolean;
  endedAt: string;
  runId?: string;
  error?: string;
  reason?: RuntimeEndReason;
  metadata?: Record<string, unknown>;
}

export interface RuntimeEventCallbacks {
  onRuntimeEnd?: (event: RuntimeEndEvent) => void | Promise<void>;
}

export function runtimeEndReasonFromSuccess(success: boolean, reason?: RuntimeEndReason): RuntimeEndReason {
  if (reason) return reason;
  return success ? 'completed' : 'error';
}
