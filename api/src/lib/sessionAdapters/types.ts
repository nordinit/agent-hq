/**
 * sessionAdapters/types.ts — Runtime session adapter contract.
 *
 * Each runtime that produces sessions/transcripts implements the SessionAdapter
 * interface. The adapter translates runtime-specific storage formats into the
 * canonical Agent HQ session/transcript model (sessions + session_messages tables).
 */

// ── Canonical types (mirrors DB columns) ─────────────────────────────────────

export type CanonicalSessionStatus = 'active' | 'completed' | 'failed' | 'abandoned';
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type EventType =
  | 'text'
  | 'thought'
  | 'tool_call'
  | 'tool_result'
  | 'turn_start'
  | 'turn_end'
  | 'system'
  | 'error';

// ── Adapter input/output ──────────────────────────────────────────────────────

/**
 * What the caller tells the adapter about the session source.
 * externalKey is the stable, runtime-specific session identifier.
 */
export interface AdapterSource {
  /** Runtime-specific session identifier (e.g., session key, cron run id, claude-code uuid). */
  externalKey: string;
  /** If we already know the linked job instance. */
  instanceId?: number;
  /** If we already know the linked agent. */
  agentId?: number;
  /** If we already know the linked task. */
  taskId?: number;
  /** If we already know the linked project. */
  projectId?: number;
}

export interface SessionUpsert {
  externalKey: string;
  runtime: string;
  agentId?: number | null;
  taskId?: number | null;
  instanceId?: number | null;
  projectId?: number | null;
  status: CanonicalSessionStatus;
  title?: string;
  startedAt?: string;
  endedAt?: string;
  tokenInput?: number;
  tokenOutput?: number;
  metadata?: Record<string, unknown>;
}

export interface SessionMessageInput {
  ordinal: number;
  role: MessageRole;
  eventType: EventType | string;
  content: string;
  eventMeta?: Record<string, unknown>;
  rawPayload?: string;
  timestamp: string;
}

export interface IngestResult {
  session: SessionUpsert;
  messages: SessionMessageInput[];
}

export interface LiveChatInfo {
  /** WebSocket URL for live streaming. */
  wsUrl: string;
  /** Gateway session key to pass when connecting. */
  sessionKey: string;
  /** Whether the session supports sending messages (interactive). */
  interactive: boolean;
}

// ── Adapter interface ─────────────────────────────────────────────────────────

export interface SessionAdapter {
  /** Runtime identifier — matches sessions.runtime column. */
  readonly runtime: string;

  /**
   * Ingest a runtime-specific session into the canonical form.
   * Called during push (real-time) or pull (on-demand import).
   * Returns null if the source can't be found or is not applicable.
   */
  ingest(source: AdapterSource): Promise<IngestResult | null>;

  /**
   * Resolve live chat info for a session, if supported.
   * Returns null if the runtime doesn't support live chat.
   */
  resolveLiveChat(externalKey: string): Promise<LiveChatInfo | null>;
}
