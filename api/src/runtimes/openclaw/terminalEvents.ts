import type { RuntimeEndEvent } from '../types';
import { nowTimestamp, timestampFromEpochMs, toCanonicalTimestampOrNow } from '../../lib/timestamps';

export interface OpenClawTerminalEvent {
  type?: string;
  error?: unknown;
  aborted?: unknown;
  timedOut?: unknown;
  timeout?: unknown;
  reason?: unknown;
  stopReason?: unknown;
  source?: unknown;
  [key: string]: unknown;
}

export function normalizeTerminalTranscriptText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

export function extractExactTerminalTranscriptText(message: unknown): string | null {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return null;

  const record = message as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;

  if (Array.isArray(record.content)) {
    const textBlocks = (record.content as Array<Record<string, unknown>>)
      .filter(block => (block.type ?? block.kind) === 'text' && typeof block.text === 'string')
      .map(block => String(block.text));
    if (textBlocks.length === 1) return textBlocks[0];
  }

  return null;
}

export function isRunCompletedFallbackMessage(message: unknown): boolean {
  const text = extractExactTerminalTranscriptText(message);
  if (text === null) return false;
  return normalizeTerminalTranscriptText(text) === 'Run Completed';
}

export function classifyTerminalReason(event: OpenClawTerminalEvent): 'completed' | 'aborted' | 'timeout' | 'error' {
  if (event.error != null) return 'error';
  if (event.timedOut === true || event.timeout === true) return 'timeout';
  if (event.aborted === true) return 'aborted';
  const reason = String(event.reason ?? event.stopReason ?? '').toLowerCase();
  if (reason.includes('timeout')) return 'timeout';
  if (reason.includes('abort') || reason.includes('cancel')) return 'aborted';
  if (reason.includes('error') || reason.includes('fail')) return 'error';
  return 'completed';
}

export function terminalEventToRuntimeTurnEnd(
  event: OpenClawTerminalEvent,
  sessionKey: string,
  runId?: string,
  timestamp?: string,
): RuntimeEndEvent {
  const reason = classifyTerminalReason(event);
  const rawError = event.error;
  return {
    type: 'turnEnded',
    source: 'openclaw',
    success: reason === 'completed',
    reason,
    sessionKey,
    runId,
    endedAt: toCanonicalTimestampOrNow(timestamp),
    error: typeof rawError === 'string' ? rawError : rawError != null ? JSON.stringify(rawError) : undefined,
    metadata: {
      openclaw_event_type: event.type ?? 'agent_end',
      source: event.source ?? 'openclaw-native',
      reason_detail: event.reason ?? event.stopReason ?? null,
      aborted: event.aborted === true,
      timed_out: event.timedOut === true || event.timeout === true,
      raw: event,
    },
  };
}

function mapChatStateToTurnEnd(
  state: string,
  payload: Record<string, unknown> | undefined,
  sessionKey: string,
  runId?: string,
): RuntimeEndEvent | null {
  if (state === 'final') {
    return {
      type: 'runEnded',
      source: 'openclaw',
      success: true,
      reason: 'completed',
      sessionKey,
      runId,
      endedAt: nowTimestamp(),
      metadata: { terminal_state: state, payload_event: 'chat' },
    };
  }
  if (state === 'aborted') {
    return {
      type: 'runEnded',
      source: 'openclaw',
      success: false,
      reason: 'aborted',
      sessionKey,
      runId,
      endedAt: nowTimestamp(),
      metadata: {
        terminal_state: state,
        payload_event: 'chat',
        reason_detail: payload?.reason ?? payload?.stopReason ?? null,
      },
    };
  }
  if (state === 'error') {
    const errorMessage = typeof payload?.error === 'string'
      ? payload.error
      : typeof payload?.message === 'string'
        ? payload.message
        : undefined;
    const reason: RuntimeEndEvent['reason'] = (errorMessage ?? '').toLowerCase().includes('timeout') ? 'timeout' : 'error';
    return {
      type: 'runEnded',
      source: 'openclaw',
      success: false,
      reason,
      sessionKey,
      runId,
      endedAt: nowTimestamp(),
      error: errorMessage,
      metadata: { terminal_state: state, payload_event: 'chat' },
    };
  }
  return null;
}

function extractNativeTurnEnd(
  payload: Record<string, unknown> | undefined,
  sessionKey: string,
  runId?: string,
): RuntimeEndEvent | null {
  const message = payload?.message;
  if (!message || typeof message !== 'object') return null;
  const rawEvent = (message as Record<string, unknown>).event;
  if (!rawEvent || typeof rawEvent !== 'object') return null;
  const terminalEvent = rawEvent as OpenClawTerminalEvent;
  if (terminalEvent.type !== 'agent_end') return null;
  const rawTimestamp = (message as Record<string, unknown>).timestamp;
  const timestamp = typeof rawTimestamp === 'number'
    ? (timestampFromEpochMs(rawTimestamp) ?? nowTimestamp())
    : typeof rawTimestamp === 'string'
      ? rawTimestamp
      : undefined;
  return terminalEventToRuntimeTurnEnd(terminalEvent, sessionKey, runId, timestamp);
}

function extractFallbackTurnEnd(
  payload: Record<string, unknown> | undefined,
  sessionKey: string,
  runId?: string,
): RuntimeEndEvent | null {
  const message = payload?.message;
  if (!isRunCompletedFallbackMessage(message)) return null;

  const rawTimestamp = message && typeof message === 'object'
    ? (message as Record<string, unknown>).timestamp
    : undefined;
  const endedAt = typeof rawTimestamp === 'number'
    ? (timestampFromEpochMs(rawTimestamp) ?? nowTimestamp())
    : typeof rawTimestamp === 'string'
      ? rawTimestamp
      : nowTimestamp();

  return {
    type: 'runEnded',
    source: 'openclaw',
    success: true,
    reason: 'completed',
    sessionKey,
    runId,
    endedAt,
    metadata: {
      terminal_state: 'Run Completed',
      payload_event: 'chat',
      fallback: 'exact_transcript_message',
    },
  };
}

export function resolveChatTerminalEvent(
  payload: Record<string, unknown> | undefined,
  expectedSessionKey: string,
  runId?: string,
): RuntimeEndEvent | null {
  const eventSessionKey = payload?.sessionKey as string | undefined;
  if (!eventSessionKey || eventSessionKey !== expectedSessionKey) return null;

  const state = typeof payload?.state === 'string' ? payload.state : undefined;
  const nativeTurnEnd = extractNativeTurnEnd(payload, expectedSessionKey, runId);
  const mappedTurnEnd = !nativeTurnEnd && state ? mapChatStateToTurnEnd(state, payload, expectedSessionKey, runId) : null;
  const fallbackTurnEnd = !nativeTurnEnd && !mappedTurnEnd ? extractFallbackTurnEnd(payload, expectedSessionKey, runId) : null;
  return nativeTurnEnd ?? mappedTurnEnd ?? fallbackTurnEnd;
}
