/**
 * transcriptProvider.ts — Chat/transcript provider abstraction for local and remote agents.
 *   - Local OpenClaw agents (chat via gateway WebSocket, history in OpenClaw sessions)
 *   - Claude Code agents (transcript from .claude/projects JSONL files)
 *   - Custom / remote agents (transcript from chat_messages table, populated by runtime)
 *   - Future remote agents with their own transcript APIs
 *
 * Provider interface:
 *   - getTranscript(instanceId)       → transcript messages for a completed/in-progress run
 *   - resolveSessionKey(instanceId)   → gateway session key for live chat
 *   - supportsLiveChat()              → whether real-time WebSocket chat is available
 *   - supportsTranscript()            → whether historical transcript loading is available
 *   - getTranscriptSource()           → human-readable source label
 *
 * Factory:
 *   resolveTranscriptProvider(instanceId) → TranscriptProvider
 *   resolveTranscriptProviderByAgent(agentId) → TranscriptProvider
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDb } from '../../db/client';
import { gatewayGetHistory } from '../../runtimes/OpenClawRuntime';
import { normalizeChatMessageRole, type PersistedChatRole } from '../../lib/chatMessageRoles';
import { extractGatewayStructuredEvents, extractTextFromGatewayMessage } from '../../lib/openclawMessageEvents';
import { buildGatewayRunSessionKey, parseHookSessionKey, resolveRuntimeAgentSlug } from '../../lib/sessionKeys';
import { backfillOpenClawJsonlTranscript, isRunChatTranscriptSparse } from './openclawJsonlBackfill';
import { nowTimestamp, timestampFromEpochMs, toCanonicalTimestampOrNow } from '../../lib/timestamps';

// ── Public types ──────────────────────────────────────────────────────────────

export interface TranscriptMessage {
  id: string;
  role: PersistedChatRole;
  content: string;
  timestamp: string;
  event_type?: string;
  event_meta?: Record<string, unknown>;
}

export interface TranscriptResult {
  sessionKey: string | null;
  source: string;
  messages: TranscriptMessage[];
  in_progress?: boolean;
}

export interface SessionKeyResult {
  sessionKey: string | null;
  source: string;
  agentId?: number | null;
}

export interface TranscriptProvider {
  /** Human-readable provider name */
  readonly name: string;

  /** Whether this provider supports real-time WebSocket chat */
  supportsLiveChat(): boolean;

  /** Whether this provider can load historical transcripts */
  supportsTranscript(): boolean;

  /** Load transcript for a given instance */
  getTranscript(instanceId: number): Promise<TranscriptResult>;

  /**
   * Resolve the gateway-compatible session key for live chat.
   * Returns null if the provider doesn't support live chat for this instance.
   */
  resolveSessionKey(instanceId: number): Promise<SessionKeyResult>;

  /** Source label for API responses */
  getTranscriptSource(): string;
}

// ── Agent/Instance row types ──────────────────────────────────────────────────

interface InstanceRow {
  id: number;
  session_key: string | null;
  agent_id: number;
  status: string;
  [key: string]: unknown;
}

interface AgentRow {
  id: number;
  name: string;
  runtime_type: string;
  runtime_config: string | null;
  session_key: string;
  hooks_url: string | null;
  openclaw_agent_id: string | null;
  [key: string]: unknown;
}

interface RemoteRuntimeConfig {
  baseUrl?: string;
  apiKey?: string;
  transcriptApiUrl?: string;
  [key: string]: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInstanceRow(instanceId: number): InstanceRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM job_instances WHERE id = ?').get(instanceId) as InstanceRow | undefined;
}

function getAgentRow(agentId: number): AgentRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as AgentRow | undefined;
}

function parseRuntimeConfig(agent: AgentRow): RemoteRuntimeConfig {
  if (!agent.runtime_config) return {};
  try {
    return JSON.parse(agent.runtime_config) as RemoteRuntimeConfig;
  } catch {
    return {};
  }
}

function parseChatMessageMeta(metaStr?: string): Record<string, unknown> {
  if (!metaStr) return {};
  try {
    return JSON.parse(metaStr);
  } catch {
    return {};
  }
}

function normalizeTranscriptRole(role: unknown, eventType?: unknown): PersistedChatRole {
  return normalizeChatMessageRole(role, eventType);
}

// ── Gateway message structured-event extraction ────────────────────────────
//
// Mirrors the logic in chat.ts:extractStructuredEvents but lives here so
// transcriptProvider is self-contained for non-WebSocket callers.

interface GatewayContentBlock {
  type?: string;
  kind?: string;
  text?: string;
  id?: string;
  name?: string;
  tool_name?: string;
  input?: unknown;
  args?: unknown;
  tool_use_id?: string;
  tool_call_id?: string;
  content?: unknown;
  output?: unknown;
  result?: unknown;
  thinking?: string;
  is_error?: boolean;
}

interface OpenClawTerminalEvent {
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

interface GatewayStructuredEvent {
  event_type: string;
  content: string;
  event_meta: Record<string, unknown>;
}

function classifyTerminalReason(event: OpenClawTerminalEvent): 'completed' | 'aborted' | 'timeout' | 'error' {
  if (event.error != null) return 'error';
  if (event.timedOut === true || event.timeout === true) return 'timeout';
  if (event.aborted === true) return 'aborted';
  const reason = String(event.reason ?? event.stopReason ?? '').toLowerCase();
  if (reason.includes('timeout')) return 'timeout';
  if (reason.includes('abort') || reason.includes('cancel')) return 'aborted';
  if (reason.includes('error') || reason.includes('fail')) return 'error';
  return 'completed';
}

function buildTurnEndEvent(event: OpenClawTerminalEvent): GatewayStructuredEvent {
  const terminalReason = classifyTerminalReason(event);
  const contentByReason = {
    completed: 'Run completed',
    aborted: 'Run aborted',
    timeout: 'Run timed out',
    error: 'Run failed',
  } as const;

  return {
    event_type: 'turn_end',
    content: contentByReason[terminalReason],
    event_meta: {
      terminal_reason: terminalReason,
      openclaw_event_type: event.type ?? 'agent_end',
      source: event.source ?? 'openclaw-native',
      reason: event.reason ?? event.stopReason ?? null,
      aborted: event.aborted === true,
      timed_out: event.timedOut === true || event.timeout === true,
      error: event.error ?? null,
      raw: event,
    },
  };
}

function extractGatewayEvents(msg: Record<string, unknown>): GatewayStructuredEvent[] {
  const contentRaw = msg.content;
  const rawRole = typeof msg.role === 'string' ? msg.role : '';
  const loweredRole = rawRole.toLowerCase();
  const openclawEvent = msg.event as OpenClawTerminalEvent | undefined;
  const openclawEventType = typeof openclawEvent?.type === 'string' ? openclawEvent.type : '';

  if (openclawEventType === 'agent_end' && openclawEvent) {
    return [buildTurnEndEvent(openclawEvent)];
  }

  const structuredEvents = extractGatewayStructuredEvents(msg);
  const hasStructuredContent = structuredEvents.some(evt =>
    evt.event_type !== 'text' || evt.content.trim().length > 0,
  );
  if (hasStructuredContent) {
    return structuredEvents;
  }

  const topLevelToolCall = msg.tool_call as Record<string, unknown> | undefined;
  if (topLevelToolCall && typeof topLevelToolCall === 'object') {
    const toolName = String(topLevelToolCall.name ?? topLevelToolCall.tool_name ?? 'unknown');
    return [{
      event_type: 'tool_call',
      content: toolName,
      event_meta: {
        name: toolName,
        args: topLevelToolCall.args ?? topLevelToolCall.input ?? {},
        id: topLevelToolCall.id ?? null,
      },
    }];
  }

  const topLevelToolResult = msg.tool_result as Record<string, unknown> | undefined;
  if (topLevelToolResult && typeof topLevelToolResult === 'object') {
    const output = topLevelToolResult.output ?? topLevelToolResult.result ?? topLevelToolResult.content ?? '';
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    return [{
      event_type: 'tool_result',
      content: outputStr.slice(0, 4000),
      event_meta: {
        tool_use_id: topLevelToolResult.tool_use_id ?? topLevelToolResult.tool_call_id ?? topLevelToolResult.id ?? null,
        output: outputStr,
      },
    }];
  }

  const plainText = typeof contentRaw === 'string'
    ? contentRaw
    : extractTextFromGatewayMessage(msg);
  if (loweredRole === 'toolresult' || loweredRole === 'tool_result') {
    return [{ event_type: 'tool_result', content: plainText, event_meta: { source_role: rawRole, output: plainText } }];
  }
  if (loweredRole === 'toolcall' || loweredRole === 'tool_call' || loweredRole === 'tooluse' || loweredRole === 'tool_use') {
    return [{ event_type: 'tool_call', content: plainText || 'tool_call', event_meta: { source_role: rawRole } }];
  }
  return [{ event_type: 'text', content: plainText, event_meta: {} }];
}

// ── Local OpenClaw Provider ───────────────────────────────────────────────────
// For agents that run via the local OpenClaw gateway (openclaw runtime_type).
// Live chat goes through the gateway WebSocket; transcripts come from gateway
// chat.history or from chat_messages as fallback.

export class OpenClawTranscriptProvider implements TranscriptProvider {
  readonly name = 'openclaw';

  supportsLiveChat(): boolean {
    return true;
  }

  supportsTranscript(): boolean {
    // OpenClaw sessions primarily use live chat; transcript is available
    // via the gateway's chat.history method or chat_messages fallback
    return true;
  }

  async getTranscript(instanceId: number): Promise<TranscriptResult> {
    const instance = getInstanceRow(instanceId);
    if (!instance) {
      return { sessionKey: null, source: 'openclaw', messages: [] };
    }

    const sessionKey = instance.session_key;

    // Terminal runs are reconstructed only from the Agent HQ data model (chat_messages,
    // plus the local OpenClaw JSONL). Their gateway session no longer exists, so a live
    // gateway history fetch just blocks the request for the full timeout (~30s per key)
    // before failing — the cause of the slow Chats-tab loads / 500s. Never hit the
    // gateway for them.
    const isTerminalRun =
      Boolean(instance.runtime_ended_at)
      || ['done', 'failed', 'cancelled', 'stopped'].includes(String(instance.status));

    // Try chat_messages table as the authoritative source
    const db = getDb();
    let chatMessages = db.prepare(`
      SELECT id, role, content, timestamp, event_type, event_meta
      FROM chat_messages
      WHERE instance_id = ?
      ORDER BY timestamp ASC
    `).all(instanceId) as Array<{
      id: string; role: string; content: string; timestamp: string;
      event_type?: string; event_meta?: string;
    }>;

    let transcriptSource = 'chat_messages';
    try {
      if (isRunChatTranscriptSparse(db, instanceId)) {
        const backfill = backfillOpenClawJsonlTranscript(db, instanceId, { forceFull: true });
        if (backfill.backfilled) {
          transcriptSource = 'openclaw-jsonl';
          chatMessages = db.prepare(`
            SELECT id, role, content, timestamp, event_type, event_meta
            FROM chat_messages
            WHERE instance_id = ?
            ORDER BY timestamp ASC
          `).all(instanceId) as Array<{
            id: string; role: string; content: string; timestamp: string;
            event_type?: string; event_meta?: string;
          }>;
        }
      }
    } catch (err) {
      console.warn(
        `[OpenClawTranscriptProvider] Failed to backfill JSONL transcript for instance ${instanceId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    if (chatMessages.length > 0 && !isRunChatTranscriptSparse(db, instanceId)) {
      const messages: TranscriptMessage[] = chatMessages.map(m => ({
        id: m.id,
        role: m.role as TranscriptMessage['role'],
        content: m.content,
        timestamp: m.timestamp,
        event_type: m.event_type ?? 'text',
        event_meta: parseChatMessageMeta(m.event_meta),
      }));

      return { sessionKey, source: transcriptSource, messages };
    }

    // For running instances, return what we have with in_progress flag.
    // The WebSocket proxy will push live deltas; no need to poll the gateway.
    if (instance.status === 'running' && !instance.runtime_ended_at) {
      const messages: TranscriptMessage[] = chatMessages.map(m => ({
        id: m.id,
        role: m.role as TranscriptMessage['role'],
        content: m.content,
        timestamp: m.timestamp,
        event_type: m.event_type ?? 'text',
        event_meta: parseChatMessageMeta(m.event_meta),
      }));
      return { sessionKey, source: 'openclaw', messages, in_progress: true };
    }

    // chat_messages is sparse (no assistant turns). For non-terminal runs only, fetch the
    // full history from the gateway to populate it. Terminal runs skip this (see above) and
    // fall through to the local chat_messages transcript.
    if (sessionKey && !isTerminalRun) {
      try {
        // Try the stored session key first. For current OpenClaw job runs, the
        // short hook:* key is the authoritative history key even when other
        // subsystems can reconstruct an agent-prefixed variant.
        const sessionKeyResult = await this.resolveSessionKey(instanceId);
        const candidateKeys = [sessionKey];
        const resolvedKey = sessionKeyResult.sessionKey;
        if (resolvedKey && resolvedKey !== sessionKey) candidateKeys.push(resolvedKey);

        let histResult: Awaited<ReturnType<typeof gatewayGetHistory>> | null = null;
        let historySourceKey: string | null = null;
        for (const candidateKey of candidateKeys) {
          const result = await gatewayGetHistory({ sessionKey: candidateKey, limit: 200 });
          if (result.ok && result.messages.length > 0) {
            histResult = result;
            historySourceKey = candidateKey;
            break;
          }
          if (!histResult) histResult = result;
        }

        if (histResult?.ok && histResult.messages.length > 0) {
          // Persist the fetched history to chat_messages so subsequent loads are fast
          const agent = getAgentRow(instance.agent_id);
          const agentId = agent?.id ?? instance.agent_id;
          this.persistGatewayHistory(instanceId, agentId, histResult.messages);

          // Re-read from chat_messages to get the freshly written rows
          const refreshed = db.prepare(`
            SELECT id, role, content, timestamp, event_type, event_meta
            FROM chat_messages
            WHERE instance_id = ?
            ORDER BY timestamp ASC
          `).all(instanceId) as Array<{
            id: string; role: string; content: string; timestamp: string;
            event_type?: string; event_meta?: string;
          }>;

          if (refreshed.length > 0) {
            const messages: TranscriptMessage[] = refreshed.map(m => ({
              id: m.id,
              role: m.role as TranscriptMessage['role'],
              content: m.content,
              timestamp: m.timestamp,
              event_type: m.event_type ?? 'text',
              event_meta: parseChatMessageMeta(m.event_meta),
            }));
            return {
              sessionKey,
              source: historySourceKey === sessionKey ? 'openclaw-gateway' : 'openclaw-gateway-reconstructed',
              messages,
            };
          }
        }
      } catch (err) {
        console.warn(
          `[OpenClawTranscriptProvider] Failed to fetch gateway history for instance ${instanceId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Include whatever user-only rows exist (e.g. the dispatch prompt)
    const messages: TranscriptMessage[] = chatMessages.map(m => ({
      id: m.id,
      role: m.role as TranscriptMessage['role'],
      content: m.content,
      timestamp: m.timestamp,
      event_type: m.event_type ?? 'text',
      event_meta: parseChatMessageMeta(m.event_meta),
    }));

    return { sessionKey, source: 'openclaw', messages };
  }

  /**
   * Persist gateway history messages to chat_messages, expanding multi-block
   * turns (tool calls, thoughts, tool results) into individual rows.
   */
  private persistGatewayHistory(
    instanceId: number,
    agentId: number,
    messages: Array<Record<string, unknown>>,
  ): void {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type, event_meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        timestamp = excluded.timestamp,
        event_type = excluded.event_type,
        event_meta = excluded.event_meta
    `);

    let rowIndex = 0;
    for (const m of messages) {
      const baseRole = m.role;
      const ts = typeof m.timestamp === 'number' ? (timestampFromEpochMs(m.timestamp) ?? nowTimestamp())
        : typeof m.timestamp === 'string' ? m.timestamp
        : nowTimestamp();

      // Expand structured content blocks into individual rows
      for (const evt of extractGatewayEvents(m)) {
        const rowId = `oc-hist-${instanceId}-${rowIndex++}`;
        const role = normalizeTranscriptRole(baseRole, evt.event_type);
        stmt.run(rowId, agentId, instanceId, role, evt.content, ts, evt.event_type, JSON.stringify(evt.event_meta));
      }
    }
  }

  async resolveSessionKey(instanceId: number): Promise<SessionKeyResult> {
    const instance = getInstanceRow(instanceId);
    if (!instance) {
      return { sessionKey: null, source: 'not_found' };
    }

    const sessionKey = instance.session_key;
    const agentId = instance.agent_id;

    // If the stored key already has the full agent-prefixed hook format, return directly
    if (sessionKey?.startsWith('agent:') && parseHookSessionKey(sessionKey)) {
      return { sessionKey, source: 'instance', agentId };
    }

    // Legacy: stored key is the short "hook:atlas:jobrun:<id>" format.
    // Reconstruct the full key from the agent's session_key prefix.
    const hook = parseHookSessionKey(sessionKey);
    if (hook) {
      const agent = getAgentRow(agentId);
      const fullKey = buildGatewayRunSessionKey(agent ?? null, hook.shortKey);
      if (fullKey) {
        return { sessionKey: fullKey, source: 'instance-reconstructed', agentId };
      }
      return { sessionKey, source: 'instance', agentId };
    }

    return { sessionKey, source: 'instance', agentId };
  }

  getTranscriptSource(): string {
    return 'openclaw';
  }
}

// ── Claude Code Provider ──────────────────────────────────────────────────────
// For agents that run via the Claude Code SDK.
// Transcripts are stored as JSONL files in ~/.claude/projects/<project>/<uuid>.jsonl.

export class ClaudeCodeTranscriptProvider implements TranscriptProvider {
  readonly name = 'claude-code';

  supportsLiveChat(): boolean {
    // Claude Code sessions can receive messages via gateway but typically
    // operate as one-shot runs. Live chat is limited.
    return false;
  }

  supportsTranscript(): boolean {
    return true;
  }

  async getTranscript(instanceId: number): Promise<TranscriptResult> {
    const instance = getInstanceRow(instanceId);
    if (!instance) {
      return { sessionKey: null, source: 'claude-code', messages: [] };
    }

    const sessionKey = instance.session_key;
    if (!sessionKey?.startsWith('claude-code:')) {
      // Not a claude-code session — fall back to chat_messages
      return this.getChatMessagesTranscript(instanceId, sessionKey);
    }

    const uuid = sessionKey.replace('claude-code:', '');
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

    let jsonlPath: string | null = null;
    if (fs.existsSync(claudeProjectsDir)) {
      for (const projectDir of fs.readdirSync(claudeProjectsDir)) {
        const candidate = path.join(claudeProjectsDir, projectDir, `${uuid}.jsonl`);
        if (fs.existsSync(candidate)) {
          jsonlPath = candidate;
          break;
        }
      }
    }

    if (!jsonlPath) {
      // JSONL file not found — try chat_messages as fallback
      return this.getChatMessagesTranscript(instanceId, sessionKey);
    }

    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    const messages: TranscriptMessage[] = [];

    raw.split('\n')
      .filter(line => line.trim())
      .forEach((line, index) => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          // Claude Code JSONL format: { type: 'user'|'assistant'|'system', message: { content: ... } }
          const type = parsed.type as string;
          const message = parsed.message as { content?: string | Array<{ type: string; text?: string }> } | undefined;
          const content = message?.content;

          let text = '';
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            text = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
          }

          if (text || type === 'system') {
            messages.push({
              id: (parsed.id as string) || `sdk-${index}`,
              role: type as TranscriptMessage['role'],
              content: text,
              timestamp: toCanonicalTimestampOrNow(parsed.timestamp),
              event_type: (parsed.event_type as string) ?? 'text',
              event_meta: typeof parsed.event_meta === 'object' && parsed.event_meta !== null
                ? parsed.event_meta as Record<string, unknown>
                : {},
            });
          }
        } catch {
          // Skip malformed lines
        }
      });

    return {
      sessionKey,
      source: 'claude-code-jsonl',
      messages,
    };
  }

  async resolveSessionKey(instanceId: number): Promise<SessionKeyResult> {
    const instance = getInstanceRow(instanceId);
    if (!instance) {
      return { sessionKey: null, source: 'not_found' };
    }

    return {
      sessionKey: instance.session_key,
      source: 'instance',
      agentId: instance.agent_id,
    };
  }

  getTranscriptSource(): string {
    return 'claude-code';
  }

  private async getChatMessagesTranscript(
    instanceId: number,
    sessionKey: string | null,
  ): Promise<TranscriptResult> {
    const db = getDb();
    const chatMessages = db.prepare(`
      SELECT id, role, content, timestamp, event_type, event_meta
      FROM chat_messages
      WHERE instance_id = ?
      ORDER BY timestamp ASC
    `).all(instanceId) as Array<{
      id: string; role: string; content: string; timestamp: string;
      event_type?: string; event_meta?: string;
    }>;

    const messages: TranscriptMessage[] = chatMessages.map(m => ({
      id: m.id,
      role: m.role as TranscriptMessage['role'],
      content: m.content,
      timestamp: m.timestamp,
      event_type: m.event_type ?? 'text',
      event_meta: parseChatMessageMeta(m.event_meta),
    }));

    return { sessionKey, source: 'chat_messages', messages };
  }
}

// ── Remote Agent Provider ─────────────────────────────────────────────────────
// For agents that run on remote infrastructure (e.g. Custom).
// Transcripts come from chat_messages table (populated by the runtime during/after runs)
// or optionally from a remote transcript API.

export class RemoteTranscriptProvider implements TranscriptProvider {
  readonly name: string;
  private readonly config: RemoteRuntimeConfig;
  private readonly agentRow: AgentRow;

  constructor(agent: AgentRow, config: RemoteRuntimeConfig) {
    this.name = `remote-${agent.runtime_type}`;
    this.config = config;
    this.agentRow = agent;
  }

  supportsLiveChat(): boolean {
    // Remote agents can support live chat if they have a hooks_url (gateway endpoint)
    return !!this.agentRow.hooks_url;
  }

  supportsTranscript(): boolean {
    return true;
  }

  async getTranscript(instanceId: number): Promise<TranscriptResult> {
    const instance = getInstanceRow(instanceId);
    if (!instance) {
      return { sessionKey: null, source: this.name, messages: [] };
    }

    const sessionKey = instance.session_key;

    // Try remote transcript API first if configured
    if (this.config.transcriptApiUrl) {
      try {
        const result = await this.fetchRemoteTranscript(instanceId);
        if (result.messages.length > 0) {
          return result;
        }
      } catch (err) {
        console.warn(
          `[${this.name}] Remote transcript API failed for instance ${instanceId}, ` +
          `falling back to chat_messages:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Fall back to chat_messages table (populated by CustomAgentRuntime or similar)
    const db = getDb();
    const chatMessages = db.prepare(`
      SELECT id, role, content, timestamp, event_type, event_meta
      FROM chat_messages
      WHERE instance_id = ?
      ORDER BY timestamp ASC
    `).all(instanceId) as Array<{
      id: string; role: string; content: string; timestamp: string;
      event_type?: string; event_meta?: string;
    }>;

    if (chatMessages.length > 0) {
      const messages: TranscriptMessage[] = chatMessages.map(m => ({
        id: m.id,
        role: m.role as TranscriptMessage['role'],
        content: m.content,
        timestamp: m.timestamp,
        event_type: m.event_type ?? 'text',
        event_meta: parseChatMessageMeta(m.event_meta),
      }));

      return { sessionKey, source: 'chat_messages', messages };
    }

    // For running instances of remote agents, return empty with in_progress flag
    if (instance.status === 'running' && !instance.runtime_ended_at) {
      return {
        sessionKey,
        source: 'chat_messages',
        messages: [],
        in_progress: true,
      };
    }

    return { sessionKey, source: this.name, messages: [] };
  }

  async resolveSessionKey(instanceId: number): Promise<SessionKeyResult> {
    const instance = getInstanceRow(instanceId);
    if (!instance) {
      return { sessionKey: null, source: 'not_found' };
    }

    const sessionKey = instance.session_key;
    const agentId = instance.agent_id;

    // Remote agents with hooks_url: reconstruct the full session key
    // so the chat proxy can route to the correct gateway
    const hook = parseHookSessionKey(sessionKey);
    if (hook) {
      const fullKey = buildGatewayRunSessionKey(this.agentRow, hook.shortKey);
      if (fullKey) {
        return { sessionKey: fullKey, source: 'instance-reconstructed', agentId };
      }
    }

    // If the stored key already has full format or is some other format, return as-is
    return { sessionKey, source: 'instance', agentId };
  }

  getTranscriptSource(): string {
    return this.name;
  }

  /**
   * Fetch transcript from a remote API endpoint.
   * The remote API is expected to return:
   *   { messages: Array<{ role, content, timestamp, ... }> }
   */
  private async fetchRemoteTranscript(instanceId: number): Promise<TranscriptResult> {
    const url = `${this.config.transcriptApiUrl}/instances/${instanceId}/transcript`;
    const apiKey = this.config.apiKey || process.env.VERI_API_KEY || '';

    const resp = await fetch(url, {
      headers: {
        Authorization: apiKey ? `Bearer ${apiKey}` : '',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      throw new Error(`Remote transcript API returned ${resp.status}`);
    }

    const data = await resp.json() as {
      messages?: Array<Record<string, unknown>>;
      sessionKey?: string;
    };

    const messages: TranscriptMessage[] = (data.messages ?? []).map((m, i) => ({
      id: (m.id as string) || `remote-${i}`,
      role: (m.role as TranscriptMessage['role']) || 'assistant',
      content: (m.content as string) || '',
      timestamp: toCanonicalTimestampOrNow(m.timestamp),
      event_type: (m.event_type as string) ?? 'text',
      event_meta: typeof m.event_meta === 'object' && m.event_meta !== null
        ? m.event_meta as Record<string, unknown>
        : {},
    }));

    return {
      sessionKey: data.sessionKey ?? null,
      source: 'remote-api',
      messages,
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * resolveTranscriptProvider — returns the appropriate TranscriptProvider for
 * a given instance ID based on the agent's runtime_type.
 *
 * Provider selection:
 *   - runtime_type='claude-code' → ClaudeCodeTranscriptProvider
 *   - runtime_type='veri'        → RemoteTranscriptProvider
 *   - runtime_type='hermes'      → RemoteTranscriptProvider (chat_messages-backed)
 *   - runtime_type='openclaw'    → OpenClawTranscriptProvider (default)
 *   - runtime_type='webhook'     → OpenClawTranscriptProvider (hooks dispatch, local chat)
 *   - unknown                    → OpenClawTranscriptProvider (safe fallback)
 */
export function resolveTranscriptProvider(instanceId: number): TranscriptProvider {
  const instance = getInstanceRow(instanceId);
  if (!instance) {
    return new OpenClawTranscriptProvider();
  }

  return resolveTranscriptProviderByAgent(instance.agent_id);
}

/**
 * resolveTranscriptProviderByAgent — returns the appropriate TranscriptProvider
 * for a given agent ID. Useful when you need the provider without a specific instance.
 */
export function resolveTranscriptProviderByAgent(agentId: number): TranscriptProvider {
  const agent = getAgentRow(agentId);
  if (!agent) {
    return new OpenClawTranscriptProvider();
  }

  switch (agent.runtime_type) {
    case 'claude-code':
      return new ClaudeCodeTranscriptProvider();

    case 'veri':
    case 'hermes': {
      const config = parseRuntimeConfig(agent);
      return new RemoteTranscriptProvider(agent, config);
    }

    default:
      // openclaw, webhook, or unknown → local provider
      return new OpenClawTranscriptProvider();
  }
}

// ── Exported for testing ─────────────────────────────────────────────────────

export {
  getInstanceRow as _getInstanceRow,
  getAgentRow as _getAgentRow,
};
