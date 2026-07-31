/**
 * runtimes/transcript/events.ts — the canonical runtime transcript event, and
 * the Anthropic content-block decoder that four runtimes currently fork.
 *
 * Pure module: no DB, no filesystem.
 *
 * Scope note (task #538). Only two things are genuinely shareable between the
 * runtimes: this decoding step, and the write path in ./writer.ts. Discovery,
 * resume offsets and ordinal assignment merely LOOK shareable — OpenClaw is the
 * only runtime with incremental resume state, Hermes re-parses its whole session
 * file per poll, and Claude Code re-parses its whole JSONL. Forcing those into
 * one contract would make three of four implementations fake a `fromOffset` they
 * do not have, which silently truncates transcripts.
 */

/**
 * Event kinds a runtime can emit.
 *
 * This union is deliberately closed, but it is a SUPERSET of what any single
 * runtime produces and matches the `event_type` values already present in
 * production rows. `event_type` is unconstrained at the database level in both
 * engines (plain `text NOT NULL DEFAULT 'text'`), and three in-repo lists
 * disagree about whether `turn_end` is legal — even though three separate code
 * paths write it. It is legal; it is here.
 */
export const RUNTIME_TRANSCRIPT_EVENT_KINDS = [
  'text',
  'thought',
  'tool_call',
  'tool_result',
  'system',
  'turn_end',
] as const;

export type RuntimeTranscriptEventKind = (typeof RUNTIME_TRANSCRIPT_EVENT_KINDS)[number];

/** Roles permitted by the CHECK constraint on chat_messages.role in both engines. */
export const PERSISTED_CHAT_ROLES = ['user', 'assistant', 'system', 'tool'] as const;
export type PersistedChatRole = (typeof PERSISTED_CHAT_ROLES)[number];

export interface RuntimeTranscriptEvent {
  kind: RuntimeTranscriptEventKind;
  /**
   * Role hint from the source. The writer still funnels this through
   * normalizeChatMessageRole, because `role` IS CHECK-enforced and an unexpected
   * value throws at insert time rather than degrading.
   */
  role?: string;
  /** Rendered content for the transcript row. */
  content: string;
  /** Structured detail persisted to event_meta. */
  meta?: Record<string, unknown>;
  /** Source timestamp, canonicalized by the writer. */
  timestamp?: string;
  /** Tool name for tool_call / tool_result. */
  toolName?: string;
  /** Correlates a tool_result back to its tool_call. */
  toolUseId?: string;
  isError?: boolean;
}

// ── Anthropic content-block decoding ─────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Render a tool payload for the `content` column.
 *
 * Tool results arrive as a string, as an array of content blocks, or as an
 * arbitrary object depending on the tool. Stringifying blindly would store
 * `[object Object]`, so each shape is handled explicitly.
 */
export function renderToolPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';

  if (Array.isArray(value)) {
    const parts = value.map((entry) => {
      if (typeof entry === 'string') return entry;
      if (isRecord(entry) && asString(entry.type) === 'text') return asString(entry.text);
      return safeJson(entry);
    });
    return parts.filter((part) => part.length > 0).join('\n');
  }

  return safeJson(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Decode one Anthropic-shaped message's `content` array into transcript events.
 *
 * The `tool_result` branch is the point of this function. Both existing Claude
 * Code readers drop tool results entirely — one filters to `type === 'text'`
 * before ever looking, so in a sampled live session 82 of 88 user rows were
 * discarded. Any "unify the normalizers" work that treats those readers as the
 * reference implementation inherits that bug, so it is fixed here once.
 *
 * `role` is the role of the containing message; tool_result blocks arrive inside
 * a `user` message but must be persisted as role `tool`.
 */
export function decodeAnthropicContentBlocks(
  content: unknown,
  role: string,
): RuntimeTranscriptEvent[] {
  if (typeof content === 'string') {
    const text = content.trim();
    return text ? [{ kind: 'text', role, content: text }] : [];
  }
  if (!Array.isArray(content)) return [];

  const events: RuntimeTranscriptEvent[] = [];

  for (const block of content) {
    if (!isRecord(block)) continue;

    switch (asString(block.type)) {
      case 'text': {
        const text = asString(block.text);
        if (text.trim()) events.push({ kind: 'text', role, content: text });
        break;
      }

      case 'thinking':
      case 'redacted_thinking': {
        // Reasoning is kept out of `text` so a transcript consumer never
        // mistakes it for the agent's actual answer.
        const thinking = asString(block.thinking);
        if (thinking.trim()) {
          events.push({ kind: 'thought', role: 'assistant', content: thinking });
        }
        break;
      }

      case 'tool_use': {
        const name = asString(block.name, 'tool');
        events.push({
          kind: 'tool_call',
          role: 'assistant',
          content: name,
          toolName: name,
          toolUseId: asString(block.id) || undefined,
          meta: { tool_name: name, tool_input: block.input ?? null },
        });
        break;
      }

      case 'tool_result': {
        const rendered = renderToolPayload(block.content);
        events.push({
          kind: 'tool_result',
          // Persisted as `tool` even though the block sits in a user message.
          role: 'tool',
          content: rendered,
          toolUseId: asString(block.tool_use_id) || undefined,
          isError: block.is_error === true,
          meta: {
            tool_use_id: asString(block.tool_use_id) || null,
            is_error: block.is_error === true,
          },
        });
        break;
      }

      default:
        // Unknown block types are skipped rather than stringified: the CLI adds
        // new ones over time and dumping raw JSON into the transcript is worse
        // than omitting it.
        break;
    }
  }

  return events;
}
