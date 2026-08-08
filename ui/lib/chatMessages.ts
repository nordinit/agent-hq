import type { CanonicalMessage, ChatEventType, ChatMessage } from './api';

const CHAT_EVENT_TYPES = new Set<ChatEventType>([
  'text',
  'thought',
  'tool_call',
  'tool_result',
  'turn_start',
  'system',
  'error',
]);

function parseEventMeta(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

function normalizeEventType(raw: unknown): ChatEventType {
  return CHAT_EVENT_TYPES.has(raw as ChatEventType) ? raw as ChatEventType : 'text';
}

function normalizeRole(raw: unknown, eventType?: ChatEventType): ChatMessage['role'] {
  if (raw === 'user' || raw === 'system') return raw;
  if (eventType === 'system') return 'system';
  return 'assistant';
}

function normalizeTimestamp(raw: unknown): string {
  if (typeof raw === 'string' && raw) return raw;
  return '';
}

function toTimestampMs(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Tie-break order for rows sharing a timestamp, in the order the work happened:
 * the agent thinks, uses tools, then replies. `text` deliberately ranks after
 * the tool events — several ingestion paths stamp a whole turn with one
 * timestamp, and ranking the reply first put it above the tool calls that
 * produced it.
 */
function eventTypeRank(eventType: ChatEventType): number {
  switch (eventType) {
    case 'turn_start':
      return 0;
    case 'thought':
      return 1;
    case 'tool_call':
      return 2;
    case 'tool_result':
      return 3;
    case 'text':
      return 4;
    case 'system':
      return 5;
    case 'error':
      return 6;
    default:
      return 99;
  }
}

function compareChatMessages(a: ChatMessage, b: ChatMessage): number {
  const byTime = toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp);
  if (byTime !== 0) return byTime;

  const byEventType = eventTypeRank(a.event_type ?? 'text') - eventTypeRank(b.event_type ?? 'text');
  if (byEventType !== 0) return byEventType;

  const aId = String(a.id);
  const bId = String(b.id);
  return aId.localeCompare(bId, undefined, { numeric: true, sensitivity: 'base' });
}

export function sortChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort(compareChatMessages);
}

/**
 * Absent meta and empty meta must produce the same string.
 *
 * Optimistic rows are built in the composer without a `meta` field, while every
 * row read back from the API goes through `parseEventMeta`, which always returns
 * an object (`{}` when the column held no metadata). Treating those two as
 * different made their fingerprints differ, so `mergeChatMessages` never
 * recognised the persisted row as the same message and the sender saw their own
 * message twice.
 */
function stableMetaString(meta: Record<string, unknown> | undefined): string {
  if (!meta || Object.keys(meta).length === 0) return '';
  try {
    return JSON.stringify(stableValue(meta));
  } catch {
    return '';
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function messageFingerprint(message: ChatMessage): string {
  return [
    message.role,
    message.event_type ?? 'text',
    message.content,
    stableMetaString(message.meta),
  ].join('\u001f');
}

function isOptimisticMessage(message: ChatMessage): boolean {
  return message.id.startsWith('user-') || message.id.startsWith('stream-');
}

function isRollingTranscriptMessage(message: ChatMessage): boolean {
  return message.id.startsWith('oc-stream-');
}

export function mergeChatMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const merged = [...existing];
  const indexById = new Map(merged.map((message, index) => [message.id, index]));
  const indexByFingerprint = new Map<string, number>();

  merged.forEach((message, index) => {
    indexByFingerprint.set(messageFingerprint(message), index);
  });

  let changed = false;

  for (const message of incoming) {
    const existingIndex = indexById.get(message.id);
    if (existingIndex !== undefined) {
      const previous = merged[existingIndex];
      if (
        previous.role !== message.role
        || previous.content !== message.content
        || previous.timestamp !== message.timestamp
        || previous.event_type !== message.event_type
        || stableMetaString(previous.meta) !== stableMetaString(message.meta)
      ) {
        merged[existingIndex] = message;
        changed = true;
      }
      continue;
    }

    const duplicateIndex = indexByFingerprint.get(messageFingerprint(message));
    if (duplicateIndex !== undefined) {
      const duplicate = merged[duplicateIndex];
      if ((isOptimisticMessage(duplicate) || isRollingTranscriptMessage(duplicate)) && !isOptimisticMessage(message)) {
        indexById.delete(duplicate.id);
        merged[duplicateIndex] = message;
        indexById.set(message.id, duplicateIndex);
        changed = true;
      }
      continue;
    }

    indexById.set(message.id, merged.length);
    indexByFingerprint.set(messageFingerprint(message), merged.length);
    merged.push(message);
    changed = true;
  }

  if (!changed) return existing;
  return sortChatMessages(merged);
}

export function reconcileChatMessageSnapshot(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const incomingIds = new Set(incoming.map(message => message.id));
  const withoutStaleRollingRows = existing.filter(message => (
    !isRollingTranscriptMessage(message) || incomingIds.has(message.id)
  ));

  const merged = mergeChatMessages(withoutStaleRollingRows, incoming);
  if (merged === existing && withoutStaleRollingRows.length === existing.length) return existing;
  return merged === withoutStaleRollingRows ? sortChatMessages(withoutStaleRollingRows) : merged;
}

function normalizeChatMessage(
  raw: Record<string, unknown>,
  fallbackId: string,
): ChatMessage | null {
  const eventType = normalizeEventType(raw.event_type);
  const content = typeof raw.content === 'string' ? raw.content : '';
  if (!content && eventType === 'text') return null;

  return {
    id: typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : fallbackId,
    role: normalizeRole(raw.role, eventType),
    content,
    timestamp: normalizeTimestamp(raw.timestamp),
    event_type: eventType,
    meta: parseEventMeta(raw.event_meta ?? raw.meta),
  };
}

export function parseCanonicalMessages(rows: CanonicalMessage[]): ChatMessage[] {
  const messages = rows.reduce<ChatMessage[]>((acc, row, index) => {
    const normalized = normalizeChatMessage({
      id: row.id,
      role: row.role,
      content: row.content ?? '',
      timestamp: row.timestamp,
      event_type: row.event_type,
      event_meta: row.event_meta,
    }, `canonical-${index}`);
    if (normalized) acc.push(normalized);
    return acc;
  }, []);

  return sortChatMessages(messages);
}

export function parseStoredChatMessages(rows: Array<Record<string, unknown> | ChatMessage>): ChatMessage[] {
  const messages = rows.reduce<ChatMessage[]>((acc, row, index) => {
    const normalized = normalizeChatMessage(row as Record<string, unknown>, `stored-${index}`);
    if (normalized) acc.push(normalized);
    return acc;
  }, []);

  return sortChatMessages(messages);
}

export function parseGatewayHistoryMessages(rows: Array<Record<string, unknown>>): ChatMessage[] {
  const messages = rows.reduce<ChatMessage[]>((acc, row, index) => {
    const baseId = typeof row.id === 'string' || typeof row.id === 'number'
      ? String(row.id)
      : `hist-${index}`;

    const primary = normalizeChatMessage(row, baseId);
    if (primary) acc.push(primary);

    const extraEvents = Array.isArray(row.extra_events) ? row.extra_events : [];
    extraEvents.forEach((extra, extraIndex) => {
      if (!extra || typeof extra !== 'object') return;
      const normalized = normalizeChatMessage({
        id: `${baseId}-extra-${extraIndex + 1}`,
        role: row.role,
        content: '',
        timestamp: (extra as Record<string, unknown>).timestamp ?? row.timestamp,
        ...extra as Record<string, unknown>,
      }, `${baseId}-extra-${extraIndex + 1}`);
      if (normalized) acc.push(normalized);
    });

    return acc;
  }, []);

  return sortChatMessages(messages);
}

// ── Transcript grouping ──────────────────────────────────────────────────────

const TOOL_EVENT_TYPES = new Set<ChatEventType>(['tool_call', 'tool_result']);

/** A rendered transcript row: either one message, or a run of tool events. */
export type TranscriptRow =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'tools'; key: string; events: ChatMessage[] };

/** Tool uses in a group — a call and its result are one use, not two. */
export function countToolUses(events: ChatMessage[]): number {
  const calls = events.filter(event => event.event_type === 'tool_call').length;
  return calls > 0 ? calls : events.length;
}

/**
 * Collapse each run of tool events into a single row placed BEFORE the message
 * that follows it.
 *
 * Two things make this necessary. Ordering: transcript rows are sorted by
 * timestamp, and the JSONL backfill writes a turn's tool events after the
 * assistant text they preceded, so the raw order shows the agent speaking and
 * then apparently using tools. Volume: a turn can spend a dozen tool calls
 * before producing one sentence, which buries the reply.
 *
 * A run that ends the transcript (no message after it) stays where it is — the
 * agent is mid-turn and those calls have not led to a reply yet.
 */
export function buildTranscriptRows(messages: ChatMessage[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let pendingTools: ChatMessage[] = [];

  const flushTools = () => {
    if (pendingTools.length === 0) return;
    rows.push({ kind: 'tools', key: `tools-${pendingTools[0].id}`, events: pendingTools });
    pendingTools = [];
  };

  for (const message of messages) {
    if (TOOL_EVENT_TYPES.has(message.event_type ?? 'text')) {
      pendingTools.push(message);
      continue;
    }
    flushTools();
    rows.push({ kind: 'message', key: message.id, message });
  }
  flushTools();

  return rows;
}
