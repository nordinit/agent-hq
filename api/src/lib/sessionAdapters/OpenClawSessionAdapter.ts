/**
 * sessionAdapters/OpenClawSessionAdapter.ts
 *
 * Adapter for OpenClaw-native agent sessions.
 *
 * Source of truth:
 *   - chat_messages table (populated by the WS proxy / runObservability)
 *   - job_instances for instance context (status, agent, task, project)
 *
 * Session key format:
 *   run:<instanceId>                                  (canonical new write format)
 *   hook:atlas:jobrun:<instanceId>                    (legacy compatibility)
 *   agent:<project>:<agent>:<role>:run:<instanceId>   (canonical reconstructed gateway key)
 *   agent:<slug>:hook:atlas:jobrun:<instanceId>       (legacy reconstructed gateway key)
 *   agent:<slug>:cron:<jobId>:run:<uuid>              (for cron-dispatched openclaw sessions)
 *   Any key that references a job_instances.session_key
 *
 * Live chat: fully supported — returns the gateway WS URL for the agent.
 */

import { getDb } from '../../db/client';
import { OPENCLAW_GATEWAY_URL } from '../../config';
import { normalizeChatMessageRole } from '../chatMessageRoles';
import { parseHookSessionKey, parseAgentSessionKey, toGatewaySessionKey } from '../sessionKeys';
import type { CanonicalSessionStatus, SessionAdapter, AdapterSource, IngestResult, LiveChatInfo, SessionUpsert, SessionMessageInput } from './types';

const GATEWAY_URL = OPENCLAW_GATEWAY_URL;

interface InstanceCtx {
  id: number;
  session_key: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  dispatched_at: string | null;
  created_at: string;
  token_input: number | null;
  token_output: number | null;
  agent_id: number | null;
  task_id: number | null;
  project_id: number | null;
  task_title: string | null;
  agent_name: string | null;
  agent_session_key: string | null;
  hooks_url: string | null;
}

interface DirectCtx {
  id: number;
  name: string | null;
  session_key: string;
  hooks_url: string | null;
}

interface ChatMessageRow {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  event_type: string | null;
  event_meta: string | null;
}

function sessionSlug(externalKey: string): string | null {
  const parsed = parseAgentSessionKey(externalKey);
  return parsed?.runtimeSlug ?? null;
}

function mapInstanceStatus(status: string): CanonicalSessionStatus {
  switch (status) {
    case 'done': return 'completed';
    case 'failed': return 'failed';
    default: return 'active';
  }
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; }
  catch { return {}; }
}

function deriveStatusFromMessages(instanceStatus: string, messages: SessionMessageInput[]): CanonicalSessionStatus {
  const mappedStatus = mapInstanceStatus(instanceStatus);
  if (mappedStatus !== 'active') return mappedStatus;

  const turnEnd = [...messages].reverse().find(message => message.eventType === 'turn_end');
  const terminalReason = turnEnd?.eventMeta?.terminal_reason;
  if (terminalReason === 'completed') return 'completed';
  if (terminalReason === 'error' || terminalReason === 'timeout') return 'failed';
  if (terminalReason === 'aborted') return 'abandoned';
  return mappedStatus;
}

export class OpenClawSessionAdapter implements SessionAdapter {
  readonly runtime = 'openclaw';

  async ingest(source: AdapterSource): Promise<IngestResult | null> {
    const db = getDb();
    const { externalKey, instanceId } = source;

    // Resolve instance context
    let ctx: InstanceCtx | undefined;
    if (instanceId) {
      ctx = db.prepare(`
        SELECT ji.id, ji.session_key, ji.status, ji.started_at, ji.completed_at,
               ji.dispatched_at, ji.created_at, ji.token_input, ji.token_output,
               ji.agent_id, ji.task_id,
               COALESCE(t.project_id, NULL) AS project_id,
               t.title AS task_title,
               a.name AS agent_name,
               a.session_key AS agent_session_key,
               a.hooks_url
        FROM job_instances ji
        LEFT JOIN tasks t ON t.id = ji.task_id
        LEFT JOIN agents a ON a.id = ji.agent_id
        WHERE ji.id = ?
      `).get(instanceId) as InstanceCtx | undefined;
    }

    if (!ctx) {
      // Try to find instance by session_key
      ctx = db.prepare(`
        SELECT ji.id, ji.session_key, ji.status, ji.started_at, ji.completed_at,
               ji.dispatched_at, ji.created_at, ji.token_input, ji.token_output,
               ji.agent_id, ji.task_id,
               COALESCE(t.project_id, NULL) AS project_id,
               t.title AS task_title,
               a.name AS agent_name,
               a.session_key AS agent_session_key,
               a.hooks_url
        FROM job_instances ji
        LEFT JOIN tasks t ON t.id = ji.task_id
        LEFT JOIN agents a ON a.id = ji.agent_id
        WHERE ji.session_key = ?
        LIMIT 1
      `).get(externalKey) as InstanceCtx | undefined;
    }

    if (!ctx) {
      // Try parsing instance ID from canonical or legacy run-session patterns
      const hook = parseHookSessionKey(externalKey);
      if (hook) {
        ctx = db.prepare(`
          SELECT ji.id, ji.session_key, ji.status, ji.started_at, ji.completed_at,
                 ji.dispatched_at, ji.created_at, ji.token_input, ji.token_output,
                 ji.agent_id, ji.task_id,
                 COALESCE(t.project_id, NULL) AS project_id,
                 t.title AS task_title,
                 a.name AS agent_name,
                 a.session_key AS agent_session_key,
                 a.hooks_url
          FROM job_instances ji
          LEFT JOIN tasks t ON t.id = ji.task_id
          LEFT JOIN agents a ON a.id = ji.agent_id
          WHERE ji.id = ?
        `).get(hook.instanceId) as InstanceCtx | undefined;
      }
    }

    if (ctx) {
      const effectiveKey = externalKey || ctx.session_key || '';
      if (!effectiveKey) return null;

      const startedAt = ctx.started_at ?? ctx.dispatched_at ?? ctx.created_at;
      const rows = db.prepare(`
        SELECT id, role, content, timestamp, event_type, event_meta
        FROM chat_messages
        WHERE instance_id = ?
        ORDER BY timestamp ASC
      `).all(ctx.id) as ChatMessageRow[];

      const messages: SessionMessageInput[] = rows.map((row, idx) => ({
        ordinal: idx,
        role: normalizeChatMessageRole(row.role, row.event_type ?? 'text'),
        eventType: row.event_type ?? 'text',
        content: row.content,
        eventMeta: parseMeta(row.event_meta),
        rawPayload: row.id,
        timestamp: row.timestamp,
      }));

      const status = deriveStatusFromMessages(ctx.status, messages);
      const endedAt = (status === 'completed' || status === 'failed' || status === 'abandoned')
        ? (ctx.completed_at ?? messages[messages.length - 1]?.timestamp ?? null) : null;

      const sessionUpsert: SessionUpsert = {
        externalKey: effectiveKey,
        runtime: this.runtime,
        agentId: source.agentId ?? ctx.agent_id ?? null,
        taskId: source.taskId ?? ctx.task_id ?? null,
        instanceId: ctx.id,
        projectId: source.projectId ?? ctx.project_id ?? null,
        status,
        title: ctx.task_title?.trim() || (ctx.agent_name ? `${ctx.agent_name} session` : `Session ${ctx.id}`),
        startedAt: startedAt ?? undefined,
        endedAt: endedAt ?? undefined,
        tokenInput: ctx.token_input ?? undefined,
        tokenOutput: ctx.token_output ?? undefined,
        metadata: {
          agent_session_key: ctx.agent_session_key ?? null,
          hooks_url: ctx.hooks_url ?? null,
        },
      };

      return { session: sessionUpsert, messages };
    }

    const slug = sessionSlug(externalKey);
    if (!slug) return null;

    const directCtx = db.prepare(`
      SELECT id, name, session_key, hooks_url
      FROM agents
      WHERE openclaw_agent_id = ?
         OR session_key LIKE ?
      ORDER BY CASE WHEN openclaw_agent_id = ? THEN 0 ELSE 1 END, id DESC
      LIMIT 1
    `).get(slug, `agent:${slug}:%`, slug) as DirectCtx | undefined;

    if (!directCtx) return null;

    const rows = db.prepare(`
      SELECT id, role, content, timestamp, event_type, event_meta
      FROM chat_messages
      WHERE instance_id IS NULL AND session_key = ?
      ORDER BY timestamp ASC
    `).all(externalKey) as ChatMessageRow[];

    const messages: SessionMessageInput[] = rows.map((row, idx) => ({
      ordinal: idx,
      role: normalizeChatMessageRole(row.role, row.event_type ?? 'text'),
      eventType: row.event_type ?? 'text',
      content: row.content,
      eventMeta: parseMeta(row.event_meta),
      rawPayload: row.id,
      timestamp: row.timestamp,
    }));

    const sessionUpsert: SessionUpsert = {
      externalKey,
      runtime: this.runtime,
      agentId: source.agentId ?? directCtx.id,
      taskId: source.taskId ?? null,
      instanceId: null,
      projectId: source.projectId ?? null,
      status: 'active',
      title: directCtx.name?.trim() ? `${directCtx.name.trim()} direct chat` : 'Direct chat',
      startedAt: messages[0]?.timestamp,
      endedAt: undefined,
      metadata: {
        agent_session_key: directCtx.session_key,
        hooks_url: directCtx.hooks_url ?? null,
        direct_chat: true,
      },
    };

    return { session: sessionUpsert, messages };
  }

  async resolveLiveChat(externalKey: string): Promise<LiveChatInfo | null> {
    const db = getDb();
    const row = db.prepare(`
      SELECT ji.session_key, a.hooks_url, a.session_key AS agent_session_key
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE ji.session_key = ?
      LIMIT 1
    `).get(externalKey) as { session_key: string | null; hooks_url: string | null; agent_session_key: string | null } | undefined;

    if (!row) return null;

    const sessionKey = toGatewaySessionKey(row.session_key ?? externalKey, {
      session_key: row.agent_session_key,
    }) ?? row.session_key ?? externalKey;
    // Use hooks_url (container endpoint) if available, otherwise gateway
    const baseWs = (row.hooks_url ?? GATEWAY_URL).replace(/^http/, 'ws');
    const wsUrl = `${baseWs}/chat?session_key=${encodeURIComponent(sessionKey)}`;

    return { wsUrl, sessionKey, interactive: true };
  }
}
