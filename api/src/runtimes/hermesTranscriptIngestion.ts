import fs from 'fs';
import os from 'os';
import path from 'path';
import { tableHasColumn } from '../lib/durableRunIdentity';
import { normalizeChatMessageRole } from '../lib/chatMessageRoles';
import { nowTimestamp, timestampFromDate, timestampFromEpochMs, toCanonicalTimestamp } from '../lib/timestamps';
import { requireRuntimeTenantId } from '../lib/runtimeTenantScope';
import { type Db } from "../db/adapter/types";

export interface HermesTranscriptRunContext {
  instanceId: number;
  durableRunId?: string | null;
  taskId?: number | null;
  sessionKey?: string | null;
}

export interface HermesTranscriptIngestParams extends HermesTranscriptRunContext {
  db: Db;
  agentId: number;
  profile: string;
  hermesHome?: string | null;
}

export interface HermesTranscriptIngestResult {
  imported: number;
  matchedFile: string | null;
  skipped: 'no-db' | 'no-session-dir' | 'no-marker' | 'ambiguous' | 'parse-error' | null;
}

interface HermesParsedEvent {
  role: 'user' | 'assistant' | 'tool';
  eventType: 'text' | 'thought' | 'tool_call' | 'tool_result';
  content: string;
  eventMeta: Record<string, unknown>;
}

const HERMES_CONTEXT_HEADER = 'Agent HQ run context';

export function buildAgentHqRunContextBlock(context: HermesTranscriptRunContext): string {
  return [
    `<${HERMES_CONTEXT_HEADER}>`,
    `instance_id: ${context.instanceId}`,
    `durable_run_id: ${context.durableRunId ?? ''}`,
    `task_id: ${context.taskId ?? ''}`,
    `session_key: ${context.sessionKey ?? ''}`,
    `</${HERMES_CONTEXT_HEADER}>`,
  ].join('\n');
}

export function prependAgentHqRunContext(prompt: string, context: HermesTranscriptRunContext): string {
  return `${buildAgentHqRunContextBlock(context)}\n\n${prompt}`;
}

export function resolveHermesSessionDir(profile: string, hermesHome?: string | null): string {
  const home = typeof hermesHome === 'string' && hermesHome.trim() ? hermesHome.trim() : '';
  if (home) {
    const resolved = path.resolve(home);
    if (path.basename(resolved) === 'sessions') return resolved;
    if (path.basename(resolved) === profile && path.basename(path.dirname(resolved)) === 'profiles') {
      return path.join(resolved, 'sessions');
    }
    const profileSessionsDir = path.join(resolved, 'profiles', profile, 'sessions');
    if (fs.existsSync(profileSessionsDir)) return profileSessionsDir;
    const directSessionsDir = path.join(resolved, 'sessions');
    if (fs.existsSync(directSessionsDir)) return directSessionsDir;
    return profileSessionsDir;
  }
  return path.join(os.homedir(), '.hermes', 'profiles', profile, 'sessions');
}

function markerCandidates(context: HermesTranscriptRunContext): string[] {
  const candidates = [
    `instance_id: ${context.instanceId}`,
    `"instance_id":${context.instanceId}`,
    `"instance_id": ${context.instanceId}`,
    `"instanceId":${context.instanceId}`,
    `"instanceId": ${context.instanceId}`,
  ];
  if (context.durableRunId?.trim()) {
    const value = context.durableRunId.trim();
    candidates.push(`durable_run_id: ${value}`, `"durable_run_id":"${value}"`, `"durable_run_id": "${value}"`, `"durableRunId":"${value}"`, `"durableRunId": "${value}"`);
  }
  if (context.sessionKey?.trim()) {
    const value = context.sessionKey.trim();
    candidates.push(`session_key: ${value}`, `"session_key":"${value}"`, `"session_key": "${value}"`, `"sessionKey":"${value}"`, `"sessionKey": "${value}"`);
  }
  return candidates;
}

function fileContainsRunMarker(raw: string, context: HermesTranscriptRunContext): boolean {
  const searchable = raw.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  return markerCandidates(context).some((candidate) => searchable.includes(candidate));
}

function collectJsonFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string, depth: number) => {
    if (depth > 2) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(full);
      }
    }
  };
  walk(dir, 0);
  return files;
}

export function findHermesSessionFile(params: HermesTranscriptRunContext & { profile: string; hermesHome?: string | null }): { filePath: string | null; skipped: HermesTranscriptIngestResult['skipped'] } {
  const sessionDir = resolveHermesSessionDir(params.profile, params.hermesHome);
  if (!fs.existsSync(sessionDir) || !fs.statSync(sessionDir).isDirectory()) {
    return { filePath: null, skipped: 'no-session-dir' };
  }

  const matches: string[] = [];
  for (const filePath of collectJsonFiles(sessionDir)) {
    let raw = '';
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    if (fileContainsRunMarker(raw, params)) matches.push(filePath);
  }

  if (matches.length === 0) return { filePath: null, skipped: 'no-marker' };
  if (matches.length > 1) return { filePath: null, skipped: 'ambiguous' };
  return { filePath: matches[0], skipped: null };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = asRecord(block);
      if (!record) return '';
      const type = typeof record.type === 'string' ? record.type : typeof record.kind === 'string' ? record.kind : '';
      if (type && type !== 'text' && type !== 'output_text') return '';
      return typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('');
}

function parseToolCalls(value: unknown): HermesParsedEvent[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = asRecord(item) ?? {};
    const fn = asRecord(record.function);
    const name = stringifyContent(record.name ?? record.tool_name ?? fn?.name ?? `tool_call_${index + 1}`);
    return {
      role: 'assistant' as const,
      eventType: 'tool_call' as const,
      content: name,
      eventMeta: {
        source: 'hermes-json',
        tool_call_id: record.id ?? record.tool_call_id ?? null,
        name,
        arguments: record.arguments ?? record.args ?? record.input ?? fn?.arguments ?? null,
        raw: record,
      },
    };
  });
}

export function parseHermesMessageEvents(message: unknown): HermesParsedEvent[] {
  const record = asRecord(message);
  if (!record) return [];
  const role = typeof record.role === 'string' ? record.role : '';
  const events: HermesParsedEvent[] = [];

  if (role === 'user') {
    const content = extractTextContent(record.content) || stringifyContent(record.content);
    if (content) {
      events.push({ role: 'user', eventType: 'text', content, eventMeta: { source: 'hermes-json' } });
    }
    return events;
  }

  if (role === 'assistant') {
    const reasoning = typeof record.reasoning_content === 'string' ? record.reasoning_content : '';
    if (reasoning.trim()) {
      events.push({ role: 'assistant', eventType: 'thought', content: reasoning, eventMeta: { source: 'hermes-json', field: 'reasoning_content' } });
    }
    const text = extractTextContent(record.content);
    if (text) {
      events.push({ role: 'assistant', eventType: 'text', content: text, eventMeta: { source: 'hermes-json' } });
    }
    events.push(...parseToolCalls(record.tool_calls));
    return events;
  }

  if (role === 'tool') {
    const content = extractTextContent(record.content) || stringifyContent(record.content ?? record.output ?? record.result);
    if (content) {
      events.push({
        role: 'tool',
        eventType: 'tool_result',
        content,
        eventMeta: {
          source: 'hermes-json',
          tool_call_id: record.tool_call_id ?? record.tool_use_id ?? null,
          name: record.name ?? record.tool_name ?? null,
          output: content,
        },
      });
    }
  }

  return events;
}

function timestampForMessage(message: unknown, session: Record<string, unknown>, fallback: string): string {
  const record = asRecord(message) ?? {};
  const raw = record.timestamp ?? record.created_at ?? record.createdAt ?? session.updated_at ?? session.created_at ?? session.timestamp;
  if (typeof raw === 'string' && raw.trim()) return toCanonicalTimestamp(raw) ?? fallback;
  if (typeof raw === 'number' && Number.isFinite(raw)) return timestampFromEpochMs(raw) ?? fallback;
  return fallback;
}

export async function importHermesSessionJson(params: HermesTranscriptIngestParams & { filePath: string }): Promise<HermesTranscriptIngestResult> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(params.filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return { imported: 0, matchedFile: params.filePath, skipped: 'parse-error' };
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (!messages.length) return { imported: 0, matchedFile: params.filePath, skipped: null };

  const hasDurableRunId = await tableHasColumn(params.db, 'chat_messages', 'durable_run_id');
  const hasSessionKey = await tableHasColumn(params.db, 'chat_messages', 'session_key');
  const hasTenantId = await tableHasColumn(params.db, 'chat_messages', 'tenant_id');
  const tenantId = hasTenantId
    ? await requireRuntimeTenantId(params.db, {
        instanceId: params.instanceId,
        agentId: params.agentId,
      })
    : null;
  const optionalColumns = [
    hasTenantId ? 'tenant_id' : null,
    hasDurableRunId ? 'durable_run_id' : null,
    hasSessionKey ? 'session_key' : null,
  ].filter((value): value is string => Boolean(value));
  const optionalSql = optionalColumns.length ? `${optionalColumns.join(', ')}, ` : '';
  const optionalValuesSql = optionalColumns.length ? `${optionalColumns.map(() => '?').join(', ')}, ` : '';
  // Grow-only upsert.
  //
  // This used to be ON CONFLICT DO NOTHING, which silently truncated every
  // streamed message: HermesRuntime re-ingests on a 2s poll, row ids are
  // POSITIONAL (`hermes-json-<instance>-<msgIdx>-<evtIdx>`), so the first
  // partial snapshot of an assistant message claimed the id and the finished
  // text was discarded forever.
  //
  // Plain DO UPDATE fixes that but introduces the opposite hazard: because the
  // id encodes a position rather than the message's identity, a session file
  // that ever reordered or inserted a message would rewrite historically correct
  // rows with unrelated content. The `length(excluded) >= length(existing)`
  // guard removes that — content at a given position can only ever grow, which
  // is exactly the invariant an append-only conversation log has.
  //
  // Paperclip avoids the dilemma entirely by making run events append-only
  // (`heartbeat_run_events`: surrogate bigserial PK + explicit `seq`, no upsert
  // at all). chat_messages has a TEXT primary key and six writers relying on
  // deterministic ids, so adopting that here is a schema change, not a patch —
  // it is the right long-term shape and is noted as follow-up.
  const insertSql = `
    INSERT INTO chat_messages (id, agent_id, instance_id, ${optionalSql}role, content, timestamp, event_type, event_meta)
    VALUES (?, ?, ?, ${optionalValuesSql}?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      timestamp = excluded.timestamp,
      event_type = excluded.event_type,
      event_meta = excluded.event_meta
    WHERE length(excluded.content) >= length(chat_messages.content)
  `;

  const fallbackTimestamp = timestampFromDate(fs.statSync(params.filePath).mtime) ?? nowTimestamp();
  let imported = 0;
  await params.db.withTransaction(async (db) => {
    for (const [messageIndex, message] of messages.entries()) {
      const timestamp = timestampForMessage(message, parsed, fallbackTimestamp);
      const events = parseHermesMessageEvents(message);
      for (const [eventIndex, event] of events.entries()) {
        const rowId = `hermes-json-${params.instanceId}-${messageIndex}-${eventIndex}`;
        const optionalValues: unknown[] = [];
        if (hasTenantId) optionalValues.push(tenantId);
        if (hasDurableRunId) optionalValues.push(params.durableRunId ?? null);
        if (hasSessionKey) optionalValues.push(params.sessionKey ?? '');
        const result = await db.run(
          insertSql,
          rowId,
          params.agentId,
          params.instanceId,
          ...optionalValues,
          normalizeChatMessageRole(event.role, event.eventType),
          event.content,
          timestamp,
          event.eventType,
          JSON.stringify({
            ...event.eventMeta,
            hermes_message_index: messageIndex,
            hermes_event_index: eventIndex,
            hermes_session_file: params.filePath,
          }),
        );
        imported += result.changes;
      }
    }
  });

  return { imported, matchedFile: params.filePath, skipped: null };
}

export async function ingestHermesTranscriptForRun(params: HermesTranscriptIngestParams): Promise<HermesTranscriptIngestResult> {
  const match = findHermesSessionFile(params);
  if (!match.filePath) return { imported: 0, matchedFile: null, skipped: match.skipped };
  return await importHermesSessionJson({ ...params, filePath: match.filePath });
}
