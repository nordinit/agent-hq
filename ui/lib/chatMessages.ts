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

function eventTypeRank(eventType: ChatEventType): number {
  switch (eventType) {
    case 'turn_start':
      return 0;
    case 'thought':
      return 1;
    case 'text':
      return 2;
    case 'tool_call':
      return 3;
    case 'tool_result':
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

function stableMetaString(meta: Record<string, unknown> | undefined): string {
  if (!meta) return '';
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
