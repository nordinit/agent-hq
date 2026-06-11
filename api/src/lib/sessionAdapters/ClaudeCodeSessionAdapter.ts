/**
 * sessionAdapters/ClaudeCodeSessionAdapter.ts
 *
 * Adapter for Claude Code / ACP sessions.
 *
 * Source of truth:
 *   ~/.claude/projects/<project-slug>/<uuid>.jsonl
 *
 * Session key format:
 *   claude-code:<uuid>  (stored on job_instances.session_key after SDK init)
 *
 * JSONL message format (Claude Code SDK):
 *   { type: 'user'|'assistant'|'system'|'result', message: {...}, session_id, ... }
 *   - type='user'      → role='user', event_type='text'
 *   - type='assistant' → role='assistant'
 *     - text content   → event_type='text'
 *     - tool_use block → event_type='tool_call'
 *     - thinking block → event_type='thought'
 *   - type='result'    → role='tool', event_type='tool_result'
 *   - type='system'    → role='system', event_type='system' or 'turn_start'/'turn_end'
 *
 * Live chat: not supported for completed sessions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDb } from '../../db/client';
import type {
  SessionAdapter,
  AdapterSource,
  IngestResult,
  LiveChatInfo,
  SessionUpsert,
  SessionMessageInput,
  MessageRole,
  EventType,
} from './types';

const HOME = process.env.HOME ?? os.homedir();
const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

// ── JSONL row types (Claude Code SDK format) ──────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
}

interface ClaudeCodeRow {
  type: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | ContentBlock[];
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number };
    stop_reason?: string;
  };
  session_id?: string;
  timestamp?: string;
  // result rows
  result?: string;
  is_error?: boolean;
  cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number };
  // system rows
  subtype?: string;
  cwd?: string;
  // raw catch-all
  [key: string]: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('');
}

function findJsonlFile(uuid: string): string | null {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
  for (const projectDir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    const candidate = path.join(CLAUDE_PROJECTS_DIR, projectDir, `${uuid}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseRow(line: string): ClaudeCodeRow | null {
  try { return JSON.parse(line) as ClaudeCodeRow; }
  catch { return null; }
}

/**
 * Normalize a single Claude Code JSONL row into one or more canonical messages.
 * One row can produce multiple messages (e.g., an assistant message with both
 * text and tool_use blocks emits separate text + tool_call events).
 */
function normalizeRow(row: ClaudeCodeRow, baseOrdinal: number): SessionMessageInput[] {
  const ts = row.timestamp ?? new Date().toISOString();
  const raw = JSON.stringify(row);

  switch (row.type) {
    case 'user': {
      const content = extractText(row.message?.content);
      if (!content) return [];
      return [{
        ordinal: baseOrdinal,
        role: 'user' as MessageRole,
        eventType: 'text' as EventType,
        content,
        eventMeta: {},
        rawPayload: raw,
        timestamp: ts,
      }];
    }

    case 'assistant': {
      const results: SessionMessageInput[] = [];
      const blocks: ContentBlock[] = Array.isArray(row.message?.content)
        ? (row.message!.content as ContentBlock[])
        : [];

      let localOrdinal = baseOrdinal;

      // Text blocks
      const textContent = extractText(row.message?.content);
      const hasText = textContent.trim().length > 0 && !Array.isArray(row.message?.content);
      // If content is a string, emit as text
      if (hasText) {
        results.push({
          ordinal: localOrdinal++,
          role: 'assistant',
          eventType: 'text',
          content: textContent,
          eventMeta: {
            model: row.message?.model,
            usage: row.message?.usage,
          },
          rawPayload: raw,
          timestamp: ts,
        });
      }

      for (const block of blocks) {
        if (block.type === 'text' && block.text?.trim()) {
          results.push({
            ordinal: localOrdinal++,
            role: 'assistant',
            eventType: 'text',
            content: block.text,
            eventMeta: { model: row.message?.model },
            rawPayload: raw,
            timestamp: ts,
          });
        } else if (block.type === 'thinking' && block.thinking) {
          results.push({
            ordinal: localOrdinal++,
            role: 'assistant',
            eventType: 'thought',
            content: block.thinking,
            eventMeta: {},
            rawPayload: raw,
            timestamp: ts,
          });
        } else if (block.type === 'tool_use') {
          const toolName = block.name ?? 'unknown_tool';
          const toolArgs = block.input ?? {};
          const content = buildToolCallSummary(toolName, toolArgs);
          results.push({
            ordinal: localOrdinal++,
            role: 'assistant',
            eventType: 'tool_call',
            content,
            eventMeta: {
              tool: toolName,
              args: toolArgs,
              call_id: block.id,
            },
            rawPayload: raw,
            timestamp: ts,
          });
        }
      }

      if (results.length === 0) return [];
      return results;
    }

    case 'tool': {
      // Some SDK versions emit type='tool' for tool results
      const content = typeof row.message?.content === 'string'
        ? row.message.content
        : extractText(row.message?.content);
      return [{
        ordinal: baseOrdinal,
        role: 'tool',
        eventType: 'tool_result',
        content: content || '[tool result]',
        eventMeta: {
          success: !row.is_error,
        },
        rawPayload: raw,
        timestamp: ts,
      }];
    }

    case 'result': {
      const isError = !!row.is_error;
      const content = row.result ?? (isError ? 'Task failed' : 'Task completed');
      return [{
        ordinal: baseOrdinal,
        role: 'tool',
        eventType: 'tool_result',
        content: String(content),
        eventMeta: {
          success: !isError,
          cost_usd: row.cost_usd,
          duration_ms: row.duration_ms,
          usage: row.usage,
        },
        rawPayload: raw,
        timestamp: ts,
      }];
    }

    case 'system': {
      const subtype = row.subtype ?? '';
      if (subtype === 'init') {
        return [{
          ordinal: baseOrdinal,
          role: 'system',
          eventType: 'turn_start',
          content: `Session initialized (cwd: ${row.cwd ?? 'unknown'})`,
          eventMeta: {
            session_id: row.session_id,
            cwd: row.cwd,
          },
          rawPayload: raw,
          timestamp: ts,
        }];
      }
      return [{
        ordinal: baseOrdinal,
        role: 'system',
        eventType: 'system',
        content: subtype || 'system event',
        eventMeta: { subtype, session_id: row.session_id },
        rawPayload: raw,
        timestamp: ts,
      }];
    }

    default:
      return [];
  }
}

function buildToolCallSummary(name: string, args: unknown): string {
  if (typeof args === 'object' && args !== null) {
    const keys = Object.keys(args as Record<string, unknown>);
    if (keys.length > 0) {
      const preview = keys.slice(0, 2).map(k => `${k}=...`).join(', ');
      return `Called \`${name}\` (${preview}${keys.length > 2 ? ', ...' : ''})`;
    }
  }
  return `Called \`${name}\``;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class ClaudeCodeSessionAdapter implements SessionAdapter {
  readonly runtime = 'claude-code';

  async ingest(source: AdapterSource): Promise<IngestResult | null> {
    const { externalKey, instanceId } = source;

    // Resolve UUID
    let uuid: string | null = null;
    if (externalKey.startsWith('claude-code:')) {
      uuid = externalKey.replace('claude-code:', '');
    } else if (/^[0-9a-f-]{36}$/i.test(externalKey)) {
      uuid = externalKey;
    }

    // Try to find the JSONL file
    let jsonlPath: string | null = uuid ? findJsonlFile(uuid) : null;

    // Instance context (for metadata)
    const db = getDb();
    let instanceCtx: {
      id: number;
      session_key: string | null;
      status: string;
      started_at: string | null;
      completed_at: string | null;
      created_at: string;
      token_input: number | null;
      token_output: number | null;
      agent_id: number | null;
      task_id: number | null;
      project_id: number | null;
      task_title: string | null;
      agent_name: string | null;
    } | undefined;

    const instanceLookupId = instanceId ?? (
      externalKey.startsWith('claude-code:')
        ? (() => {
            const m = externalKey.match(/claude-code:(\d+)$/);
            return m ? Number(m[1]) : null;
          })()
        : null
    );

    if (instanceLookupId) {
      instanceCtx = db.prepare(`
        SELECT ji.id, ji.session_key, ji.status, ji.started_at, ji.completed_at,
               ji.created_at, ji.token_input, ji.token_output, ji.agent_id, ji.task_id,
               COALESCE(t.project_id, NULL) AS project_id,
               t.title AS task_title, a.name AS agent_name
        FROM job_instances ji
        LEFT JOIN tasks t ON t.id = ji.task_id
        LEFT JOIN agents a ON a.id = ji.agent_id
        WHERE ji.id = ?
      `).get(instanceLookupId) as typeof instanceCtx;
    }

    // If no JSONL, fall back to chat_messages
    if (!jsonlPath) {
      if (!instanceCtx) return null;
      return this._ingestFromChatMessages(source, instanceCtx);
    }

    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;

    // Collect token totals from the result row
    let tokenInput = 0;
    let tokenOutput = 0;
    let sessionStatus: 'active' | 'completed' | 'failed' | 'abandoned' = 'completed';
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    let sessionTitle: string | undefined;

    // Infer from instance context
    if (instanceCtx) {
      const s = instanceCtx.status;
      sessionStatus = s === 'done' ? 'completed' : s === 'failed' ? 'failed' : 'active';
      startedAt = instanceCtx.started_at ?? instanceCtx.created_at ?? undefined;
      endedAt = instanceCtx.completed_at ?? undefined;
      sessionTitle = instanceCtx.task_title?.trim() || (instanceCtx.agent_name ? `${instanceCtx.agent_name} session` : undefined);
    }

    // Build messages
    const messages: SessionMessageInput[] = [];
    let ordinalCursor = 0;

    for (const line of lines) {
      const row = parseRow(line);
      if (!row) continue;

      if (!startedAt && row.timestamp) startedAt = row.timestamp;
      if (row.timestamp) endedAt = row.timestamp;

      // Collect token usage from result row
      if (row.type === 'result') {
        tokenInput += (row.usage?.input_tokens ?? 0) + (row.usage?.cache_creation_input_tokens ?? 0);
        tokenOutput += row.usage?.output_tokens ?? 0;
        sessionStatus = row.is_error ? 'failed' : 'completed';
      }

      const normalized = normalizeRow(row, ordinalCursor);
      if (normalized.length > 0) {
        messages.push(...normalized);
        ordinalCursor += normalized.length;
      }
    }

    const effectiveKey = externalKey.startsWith('claude-code:') ? externalKey : `claude-code:${uuid}`;

    const session: SessionUpsert = {
      externalKey: effectiveKey,
      runtime: this.runtime,
      agentId: source.agentId ?? instanceCtx?.agent_id ?? null,
      taskId: source.taskId ?? instanceCtx?.task_id ?? null,
      instanceId: instanceCtx?.id ?? source.instanceId ?? null,
      projectId: source.projectId ?? instanceCtx?.project_id ?? null,
      status: sessionStatus,
      title: sessionTitle,
      startedAt,
      endedAt,
      tokenInput: tokenInput > 0 ? tokenInput : (instanceCtx?.token_input ?? undefined),
      tokenOutput: tokenOutput > 0 ? tokenOutput : (instanceCtx?.token_output ?? undefined),
      metadata: {
        jsonl_path: jsonlPath,
        uuid,
      },
    };

    return { session, messages };
  }

  async resolveLiveChat(_externalKey: string): Promise<LiveChatInfo | null> {
    // Claude Code sessions don't support live interactive chat
    return null;
  }

  private async _ingestFromChatMessages(
    source: AdapterSource,
    instanceCtx: {
      id: number;
      session_key: string | null;
      status: string;
      started_at: string | null;
      completed_at: string | null;
      created_at: string;
      token_input: number | null;
      token_output: number | null;
      agent_id: number | null;
      task_id: number | null;
      project_id: number | null;
      task_title: string | null;
      agent_name: string | null;
    },
  ): Promise<IngestResult | null> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, role, content, timestamp, event_type, event_meta
      FROM chat_messages WHERE instance_id = ? ORDER BY timestamp ASC
    `).all(instanceCtx.id) as Array<{
      id: string; role: string; content: string; timestamp: string;
      event_type: string | null; event_meta: string | null;
    }>;

    const status = instanceCtx.status === 'done' ? 'completed'
      : instanceCtx.status === 'failed' ? 'failed' : 'active';

    const messages: SessionMessageInput[] = rows.map((r, idx) => ({
      ordinal: idx,
      role: normalizeRole(r.role),
      eventType: r.event_type ?? 'text',
      content: r.content,
      eventMeta: parseEventMeta(r.event_meta),
      timestamp: r.timestamp,
    }));

    const session: SessionUpsert = {
      externalKey: source.externalKey,
      runtime: this.runtime,
      agentId: source.agentId ?? instanceCtx.agent_id ?? null,
      taskId: source.taskId ?? instanceCtx.task_id ?? null,
      instanceId: instanceCtx.id,
      projectId: source.projectId ?? instanceCtx.project_id ?? null,
      status,
      title: instanceCtx.task_title?.trim() || (instanceCtx.agent_name ? `${instanceCtx.agent_name} session` : undefined),
      startedAt: instanceCtx.started_at ?? instanceCtx.created_at ?? undefined,
      endedAt: instanceCtx.completed_at ?? undefined,
      tokenInput: instanceCtx.token_input ?? undefined,
      tokenOutput: instanceCtx.token_output ?? undefined,
      metadata: { source: 'chat_messages_fallback' },
    };

    return { session, messages };
  }
}

function normalizeRole(role: string): 'user' | 'assistant' | 'system' | 'tool' {
  switch (role) {
    case 'user': return 'user';
    case 'assistant': return 'assistant';
    case 'tool': return 'tool';
    default: return 'system';
  }
}

function parseEventMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; }
  catch { return {}; }
}
