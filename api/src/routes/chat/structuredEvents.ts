import { normalizeChatMessageRole } from '../../lib/chatMessageRoles';
import { extractGatewayErrorMessage, summarizeGatewayErrorForUi } from '../../lib/chatGatewayErrors';
import { extractGatewayStructuredEvents, extractTextFromGatewayMessage, unwrapGatewayMessage } from '../../lib/openclawMessageEvents';
import { nowTimestamp } from '../../lib/timestamps';

export interface StructuredEvent {
  event_type: string;
  content: string;
  event_meta: Record<string, unknown>;
}

export function extractText(message: unknown): string {
  return extractTextFromGatewayMessage(message);
}

export function normalizeChatRole(role: unknown, eventType?: unknown) {
  return normalizeChatMessageRole(role, eventType);
}

export function extractStructuredEvents(msg: unknown): StructuredEvent[] {
  if (!msg || typeof msg !== 'object') {
    return [{ event_type: 'text', content: '', event_meta: {} }];
  }
  const m = unwrapGatewayMessage(msg) ?? (msg as Record<string, unknown>);
  const contentRaw = m.content;
  const stopReason = typeof m.stopReason === 'string' ? m.stopReason.trim().toLowerCase() : '';
  const errorMessage = extractGatewayErrorMessage(m);

  const events = extractGatewayStructuredEvents(m);
  const hasStructuredContent = events.some(evt =>
    evt.event_type !== 'text' || evt.content.trim().length > 0,
  );

  if (stopReason === 'error' && errorMessage) {
    return [
      ...events,
      {
        event_type: 'error',
        content: summarizeGatewayErrorForUi(m),
        event_meta: { stop_reason: stopReason },
      },
    ];
  }

  if (hasStructuredContent) {
    return events;
  }

  const plainText = typeof contentRaw === 'string' ? contentRaw : extractTextFromGatewayMessage(m);
  return [{ event_type: 'text', content: plainText, event_meta: {} }];
}

export function gatewayMsgToUi(msg: unknown, index: number): Record<string, unknown> {
  if (!msg || typeof msg !== 'object') {
    return { id: `hist-${index}`, role: 'assistant', content: '', event_type: 'text', event_meta: {}, timestamp: nowTimestamp() };
  }
  const outer = msg as Record<string, unknown>;
  const m = unwrapGatewayMessage(msg) ?? outer;
  const ts = m.timestamp ?? outer.timestamp;
  let timestamp: string;
  if (typeof ts === 'number') {
    timestamp = new Date(ts).toISOString();
  } else if (typeof ts === 'string') {
    timestamp = ts;
  } else {
    timestamp = nowTimestamp();
  }

  const events = extractStructuredEvents(msg);
  const primary = events[0] ?? { event_type: 'text', content: '', event_meta: {} };
  const role = normalizeChatRole(m.role, primary.event_type);

  return {
    id: typeof m.id === 'string' ? m.id : typeof outer.id === 'string' ? outer.id : `hist-${index}`,
    role,
    content: primary.content,
    event_type: primary.event_type,
    event_meta: primary.event_meta,
    timestamp,
    extra_events: events.length > 1 ? events.slice(1) : undefined,
  };
}
