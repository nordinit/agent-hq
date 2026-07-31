/**
 * runtimes/claudeCode/transcript.ts — stream-json events → canonical transcript
 * events.
 *
 * This is the claude-code half of task #538: a thin, source-specific decoder on
 * top of the shared pieces in ../transcript. Everything reusable (Anthropic block
 * decoding, the chat_messages write path) lives there; this file only knows the
 * shapes the Claude Code CLI emits.
 *
 * Pure module — no DB, no filesystem.
 */

import {
  decodeAnthropicContentBlocks,
  type RuntimeTranscriptEvent,
} from '../transcript/events';
import type { ClaudeStreamEvent } from './streamJson';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * `system` subtypes that carry no transcript value.
 *
 * `thinking_tokens` fires many times per turn as a running estimate, and the
 * `task_` and `background_tasks_changed` family is scheduler bookkeeping.
 * Persisting either would bury the actual conversation in noise — a single short
 * run emitted 49 thinking_tokens events against 3 assistant messages.
 */
const IGNORED_SYSTEM_SUBTYPES = new Set([
  'thinking_tokens',
  'status',
  'background_tasks_changed',
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
]);

/**
 * Decode one stream-json event.
 *
 * Returns an empty array for events with nothing to record, which is most of
 * them. The `result` event is deliberately NOT turned into a turn_end row here:
 * a process can emit several of them, and the runtime writes exactly one
 * terminal row from its own authoritative view of how the process ended.
 */
export function decodeClaudeStreamEvent(event: ClaudeStreamEvent): RuntimeTranscriptEvent[] {
  const type = asString(event.type);

  if (type === 'assistant' || type === 'user') {
    const message = isRecord(event.message) ? event.message : null;
    if (!message) return [];

    const events = decodeAnthropicContentBlocks(message.content, type);
    const timestamp = asString(event.timestamp) || undefined;
    if (!timestamp) return events;
    return events.map((entry) => ({ ...entry, timestamp }));
  }

  if (type === 'system') {
    const subtype = asString(event.subtype);
    if (subtype === 'init' || IGNORED_SYSTEM_SUBTYPES.has(subtype)) return [];
    // An unrecognised system subtype is worth keeping: it is rare, and the CLI
    // uses this channel for things an operator debugging a run needs to see.
    return [
      {
        kind: 'system',
        role: 'system',
        content: subtype ? `system: ${subtype}` : 'system event',
        meta: { subtype },
      },
    ];
  }

  return [];
}

/** The dispatched prompt, so a transcript starts with what the agent was asked. */
export function promptTranscriptEvent(prompt: string): RuntimeTranscriptEvent {
  return { kind: 'text', role: 'user', content: prompt };
}
