import { getDb } from '../db/client';
import { tableHasColumn } from './durableRunIdentity';
import { resolveTranscriptProvider } from '../domains/runs/transcriptProvider';
import {
  resolveSessionAdapterForKey,
  resolveSessionAdapter,
  type IngestResult,
  type AdapterSource,
} from './sessionAdapters';
import { resolveRuntimeTenantId, tenantInsertColumns, tenantUpsertUpdateSql } from './runtimeTenantScope';
import { toCanonicalTimestamp } from './timestamps';
import { type Db } from "../db/adapter/types";

export type CanonicalSessionStatus = 'active' | 'completed' | 'failed' | 'abandoned';

export interface CanonicalSessionRow {
  id: number;
  external_key: string;
  runtime: string;
  agent_id: number | null;
  task_id: number | null;
  instance_id: number | null;
  project_id: number | null;
  tenant_id?: number | null;
  status: CanonicalSessionStatus;
  title: string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  token_input: number | null;
  token_output: number | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface InstanceContextRow {
  id: number;
  session_key: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  dispatched_at: string | null;
  created_at: string;
  run_id: string | null;
  runtime_ended_at: string | null;
  runtime_end_error: string | null;
  runtime_end_source: string | null;
  token_input: number | null;
  token_output: number | null;
  agent_id: number | null;
  task_id: number | null;
  project_id: number | null;
  task_title: string | null;
  agent_name: string | null;
  agent_session_key: string | null;
  runtime_type: string | null;
  tenant_id: number | null;
}

function mapInstanceStatus(status: string | null | undefined): CanonicalSessionStatus {
  switch (status) {
    case 'done':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'queued':
    case 'dispatched':
    case 'running':
    default:
      return 'active';
  }
}

function inferRuntime(sessionKey: string | null, runtimeType: string | null): string {
  if (sessionKey?.startsWith('claude-code:')) return 'claude-code';
  if (sessionKey?.startsWith('cron:')) return 'cron';
  if (runtimeType === 'veri') return 'veri';
  if (runtimeType === 'hermes') return 'hermes';
  if (runtimeType === 'webhook') return 'webhook';
  if (runtimeType === 'claude-code') return 'claude-code';
  if (runtimeType === 'openclaw') return 'openclaw';
  if (sessionKey?.includes('hook:atlas:jobrun:')) return 'openclaw';
  return runtimeType || 'unknown';
}

function deriveTitle(row: InstanceContextRow): string {
  if (row.task_title?.trim()) return row.task_title.trim();
  if (row.agent_name?.trim()) return `${row.agent_name.trim()} session`;
  return `Session ${row.id}`;
}

function buildMetadata(row: InstanceContextRow): string {
  return JSON.stringify({
    run_id: row.run_id ?? null,
    runtime_type: row.runtime_type ?? null,
    agent_session_key: row.agent_session_key ?? null,
  });
}

async function resolveExternalKeyForInstance(
  db: Db,
  row: InstanceContextRow,
  sessionKeyOverride?: string | null,
): Promise<string> {
  const explicitKey = sessionKeyOverride?.trim() || row.session_key?.trim();
  if (explicitKey) return explicitKey;

  const chatMessageKey = await db.get(`
    SELECT session_key
      FROM chat_messages
     WHERE instance_id = ?
       AND session_key IS NOT NULL
       AND TRIM(session_key) != ''
     ORDER BY timestamp ASC, id ASC
     LIMIT 1
  `, row.id) as { session_key?: string | null } | undefined;

  const resolvedChatKey = chatMessageKey?.session_key?.trim();
  if (resolvedChatKey) return resolvedChatKey;
  if (row.status === 'failed') return `failed-run:${row.id}`;
  return `run:${row.id}`;
}

async function getInstanceContext(db: Db, instanceId: number): Promise<InstanceContextRow | undefined> {
  const optionalInstanceColumn = async (column: string): Promise<string> => (
    await tableHasColumn(db, 'job_instances', column) ? `ji.${column}` : 'NULL'
  );
  const instanceTenantSelect = await tableHasColumn(db, 'job_instances', 'tenant_id') ? 'ji.tenant_id' : 'NULL';
  return await db.get(`
    SELECT
      ji.id,
      ji.session_key,
      ji.status,
      ji.started_at,
      ji.completed_at,
      ji.dispatched_at,
      ji.created_at,
      ${optionalInstanceColumn('run_id')} AS run_id,
      ${optionalInstanceColumn('runtime_ended_at')} AS runtime_ended_at,
      ${optionalInstanceColumn('runtime_end_error')} AS runtime_end_error,
      ${optionalInstanceColumn('runtime_end_source')} AS runtime_end_source,
      ${optionalInstanceColumn('token_input')} AS token_input,
      ${optionalInstanceColumn('token_output')} AS token_output,
      ${instanceTenantSelect} AS tenant_id,
      ji.agent_id,
      ji.task_id,
      COALESCE(t.project_id, NULL) AS project_id,
      t.title AS task_title,
      a.name AS agent_name,
      a.session_key AS agent_session_key,
      a.runtime_type
    FROM job_instances ji
    LEFT JOIN tasks t ON t.id = ji.task_id
    LEFT JOIN agents a ON a.id = ji.agent_id
    WHERE ji.id = ?
  `, instanceId) as InstanceContextRow | undefined;
}

async function syncSessionMessageCount(db: Db, sessionId: number): Promise<void> {
  await db.run(`
    UPDATE sessions
    SET message_count = (
      SELECT COUNT(*) FROM session_messages WHERE session_id = ?
    ), updated_at = datetime('now')
    WHERE id = ?
  `, sessionId, sessionId);
}

async function getChatMessageIdsForInstance(db: Db, instanceId: number): Promise<Set<string>> {
  const rows = await db.all(`
    SELECT id
      FROM chat_messages
     WHERE instance_id = ?
  `, instanceId) as Array<{ id: number | string }>;

  return new Set(rows.map((row) => String(row.id)));
}

async function insertFailurePlaceholderMessage(
  db: Db,
  sessionId: number,
  row: InstanceContextRow,
): Promise<boolean> {
  if (row.status !== 'failed') return false;

  const existingCount = (await db.get(`
    SELECT COUNT(*) AS n
      FROM session_messages
     WHERE session_id = ?
  `, sessionId) as { n: number }).n;
  if (existingCount > 0) return false;

  const error = row.runtime_end_error?.trim() || 'Runtime failed before transcript output was captured';
  const content = [
    `Runtime failure: ${error}`,
    `Instance ID: ${row.id}`,
    row.task_id != null ? `Task ID: ${row.task_id}` : null,
    row.agent_name?.trim() ? `Agent: ${row.agent_name.trim()}` : null,
    `Session key: ${row.session_key?.trim() || 'unavailable'}`,
  ].filter((line): line is string => Boolean(line)).join('\n');

  await db.run(`
    INSERT INTO session_messages (
      session_id, ordinal, role, event_type, content, event_meta, raw_payload, timestamp, created_at
    ) VALUES (?, 0, 'system', 'error', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(session_id, ordinal) DO UPDATE SET
      role = excluded.role,
      event_type = excluded.event_type,
      content = excluded.content,
      event_meta = excluded.event_meta,
      raw_payload = COALESCE(excluded.raw_payload, session_messages.raw_payload),
      timestamp = excluded.timestamp
  `, sessionId, content, JSON.stringify({
          source: 'job_instance_runtime_failure',
          instance_id: row.id,
          task_id: row.task_id,
          runtime_end_source: row.runtime_end_source,
        }), `job-instance-runtime-failure:${row.id}`, toCanonicalTimestamp(
          row.runtime_ended_at ?? row.completed_at ?? row.started_at ?? row.dispatched_at ?? row.created_at,
        ));

  await syncSessionMessageCount(db, sessionId);
  return true;
}


export async function syncSessionMessagesFromChatMessages(db: Db, sessionId: number, instanceId: number): Promise<number> {
  const rows = await db.all(`
    SELECT id, role, event_type, event_meta, content, timestamp
      FROM chat_messages
     WHERE instance_id = ?
     ORDER BY timestamp ASC, id ASC
  `, instanceId) as Array<{
    id: number | string;
    role: string | null;
    event_type: string | null;
    event_meta: string | null;
    content: string | null;
    timestamp: string | null;
  }>;

  if (!rows.length) return 0;

  const existingRows = await db.all(`
    SELECT raw_payload, ordinal
      FROM session_messages
     WHERE session_id = ?
       AND raw_payload IS NOT NULL
  `, sessionId) as Array<{ raw_payload: string; ordinal: number }>;
  const ordinalByRawPayload = new Map(
    existingRows.map((row) => [String(row.raw_payload), row.ordinal] as const),
  );

  const maxOrdinalRow = await db.get(`
    SELECT COALESCE(MAX(ordinal), -1) AS max_ord
      FROM session_messages
     WHERE session_id = ?
  `, sessionId) as { max_ord: number };

  const insert = db.prepare(`
    INSERT INTO session_messages (
      session_id, ordinal, role, event_type, content, event_meta, raw_payload, timestamp, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(session_id, ordinal) DO UPDATE SET
      role = excluded.role,
      event_type = excluded.event_type,
      content = excluded.content,
      event_meta = excluded.event_meta,
      raw_payload = COALESCE(excluded.raw_payload, session_messages.raw_payload),
      timestamp = excluded.timestamp
  `);

  const tx = db.transaction(() => {
    let ordinal = maxOrdinalRow.max_ord + 1;
    rows.forEach((row) => {
      const rawPayload = String(row.id);
      const existingOrdinal = ordinalByRawPayload.get(rawPayload);
      const nextOrdinal = existingOrdinal ?? ordinal++;
      insert.run(
        sessionId,
        nextOrdinal,
        row.role ?? 'system',
        row.event_type ?? 'text',
        row.content ?? '',
        row.event_meta ?? JSON.stringify({ source: 'chat_messages_backfill', chat_message_id: row.id, instance_id: instanceId }),
        rawPayload,
        toCanonicalTimestamp(row.timestamp),
      );
    });
  });

  tx();
  await syncSessionMessageCount(db, sessionId);
  return rows.length;
}

export async function upsertCanonicalSessionForInstance(
  db: Db,
  instanceId: number,
  sessionKeyOverride?: string | null,
): Promise<CanonicalSessionRow | null> {
  const row = await getInstanceContext(db, instanceId);
  if (!row) return null;

  const externalKey = await resolveExternalKeyForInstance(db, row, sessionKeyOverride);

  const runtime = inferRuntime(externalKey, row.runtime_type);
  const tenantId = (await resolveRuntimeTenantId(db, {
      taskId: row.task_id,
      agentId: row.agent_id,
      projectId: row.project_id,
      instanceId,
    })) ?? row.tenant_id ?? null;
  const tenant = await tenantInsertColumns(db, 'sessions', tenantId);
  const status = mapInstanceStatus(row.status);
  const startedAt = toCanonicalTimestamp(row.started_at ?? row.dispatched_at ?? row.created_at);
  const endedAt = status === 'completed' || status === 'failed' || status === 'abandoned'
    ? toCanonicalTimestamp(row.completed_at)
    : null;

  await db.run(`
    INSERT INTO sessions (
      ${tenant.columnSql}external_key, runtime, agent_id, task_id, instance_id, project_id,
      status, title, started_at, ended_at, token_input, token_output,
      metadata, created_at, updated_at
    )
    VALUES (${tenant.valueSql}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(external_key) DO UPDATE SET
      ${await tenantUpsertUpdateSql(db, 'sessions')}
      runtime = excluded.runtime,
      agent_id = COALESCE(excluded.agent_id, sessions.agent_id),
      task_id = COALESCE(excluded.task_id, sessions.task_id),
      instance_id = COALESCE(excluded.instance_id, sessions.instance_id),
      project_id = COALESCE(excluded.project_id, sessions.project_id),
      status = excluded.status,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE sessions.title END,
      started_at = COALESCE(excluded.started_at, sessions.started_at),
      ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
      token_input = COALESCE(excluded.token_input, sessions.token_input),
      token_output = COALESCE(excluded.token_output, sessions.token_output),
      metadata = CASE WHEN excluded.metadata != '{}' THEN excluded.metadata ELSE sessions.metadata END,
      updated_at = datetime('now')
  `, ...tenant.values, externalKey, runtime, row.agent_id, row.task_id, row.id, row.project_id, status, deriveTitle(row), startedAt, endedAt, row.token_input, row.token_output, buildMetadata(row));

  const session = await db.get(`SELECT * FROM sessions WHERE external_key = ?`, externalKey) as CanonicalSessionRow | undefined;
  return session ?? null;
}

export async function ensureCanonicalSessionForInstance(
  instanceId: number,
  opts: { forceIngest?: boolean; sessionKey?: string | null } = {},
): Promise<CanonicalSessionRow | null> {
  const db = getDb();
  const session = await upsertCanonicalSessionForInstance(db, instanceId, opts.sessionKey ?? null);
  if (!session) return null;

  const existingCount = (await db.get('SELECT COUNT(*) as n FROM session_messages WHERE session_id = ?', session.id) as { n: number }).n;
  if (!opts.forceIngest && existingCount > 0) {
    await syncSessionMessagesFromChatMessages(db, session.id, instanceId);
    await syncSessionMessageCount(db, session.id);
    return await db.get('SELECT * FROM sessions WHERE id = ?', session.id) as CanonicalSessionRow;
  }

  const provider = await resolveTranscriptProvider(instanceId);
  const transcript = await provider.getTranscript(instanceId);
  if (!transcript.messages.length) {
    const inserted = await syncSessionMessagesFromChatMessages(db, session.id, instanceId);
    if (inserted > 0) {
      return await db.get('SELECT * FROM sessions WHERE id = ?', session.id) as CanonicalSessionRow;
    }
    const contextRow = await getInstanceContext(db, instanceId);
    if (contextRow && await insertFailurePlaceholderMessage(db, session.id, contextRow)) {
      return await db.get('SELECT * FROM sessions WHERE id = ?', session.id) as CanonicalSessionRow;
    }
  }

  const insert = db.prepare(`
    INSERT INTO session_messages (
      session_id, ordinal, role, event_type, content, event_meta, raw_payload, timestamp, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(session_id, ordinal) DO UPDATE SET
      role = excluded.role,
      event_type = excluded.event_type,
      content = excluded.content,
      event_meta = excluded.event_meta,
      raw_payload = COALESCE(excluded.raw_payload, session_messages.raw_payload),
      timestamp = excluded.timestamp
  `);
  const chatMessageIds = await getChatMessageIdsForInstance(db, instanceId);

  const tx = db.transaction(async () => {
    transcript.messages.forEach((message, idx) => {
      const rawPayload = chatMessageIds.has(String(message.id)) ? String(message.id) : null;
      insert.run(
        session.id,
        idx,
        message.role,
        message.event_type ?? 'text',
        message.content,
        JSON.stringify(message.event_meta ?? {}),
        rawPayload,
        toCanonicalTimestamp(message.timestamp),
      );
    });

    await db.run(`
      UPDATE sessions
      SET message_count = (
            SELECT COUNT(*) FROM session_messages WHERE session_id = ?
          ),
          status = CASE
            WHEN ? = 1 THEN 'active'
            ELSE status
          END,
          updated_at = datetime('now')
      WHERE id = ?
    `, session.id, transcript.in_progress ? 1 : 0, session.id);
  });

  tx();

  await syncSessionMessagesFromChatMessages(db, session.id, instanceId);

  return await db.get('SELECT * FROM sessions WHERE id = ?', session.id) as CanonicalSessionRow;
}

export async function ensureCanonicalSessionByExternalKey(externalKey: string): Promise<CanonicalSessionRow | null> {
  const db = getDb();
  const existing = await db.get('SELECT * FROM sessions WHERE external_key = ?', externalKey) as CanonicalSessionRow | undefined;
  if (existing) return existing;

  // Instance-linked path — direct match or hook:atlas:jobrun:<id> pattern
  const directInstance = await db.get('SELECT id FROM job_instances WHERE session_key = ? LIMIT 1', externalKey) as { id: number } | undefined;
  if (directInstance) return await ensureCanonicalSessionForInstance(directInstance.id);

  const runIdMatch = externalKey.match(/hook:atlas:jobrun:(\d+)$/);
  if (runIdMatch) {
    return await ensureCanonicalSessionForInstance(Number(runIdMatch[1]));
  }

  // Adapter-based pull ingestion (cron runs, claude-code JSONL, etc.)
  const adapter = resolveSessionAdapterForKey(externalKey);
  const source: AdapterSource = { externalKey };
  const result = await adapter.ingest(source);
  if (result) {
    return await writeIngestResult(db, result);
  }

  return null;
}

/**
 * writeIngestResult — persist an IngestResult (session upsert + messages) to the DB.
 *
 * Handles upsert conflicts on external_key and ordinal so it's safe to call
 * repeatedly (idempotent ingestion).
 */
export async function writeIngestResult(db: Db, result: IngestResult): Promise<CanonicalSessionRow | null> {
  const { session, messages } = result;
  const tenantId = await resolveRuntimeTenantId(db, {
      taskId: session.taskId ?? null,
      agentId: session.agentId ?? null,
      projectId: session.projectId ?? null,
      instanceId: session.instanceId ?? null,
    });
  const tenant = await tenantInsertColumns(db, 'sessions', tenantId);

  // Upsert the session row
  await db.run(`
    INSERT INTO sessions (
      ${tenant.columnSql}external_key, runtime, agent_id, task_id, instance_id, project_id,
      status, title, started_at, ended_at, token_input, token_output,
      metadata, created_at, updated_at
    )
    VALUES (${tenant.valueSql}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(external_key) DO UPDATE SET
      ${await tenantUpsertUpdateSql(db, 'sessions')}
      runtime = excluded.runtime,
      agent_id = COALESCE(excluded.agent_id, sessions.agent_id),
      task_id = COALESCE(excluded.task_id, sessions.task_id),
      instance_id = COALESCE(excluded.instance_id, sessions.instance_id),
      project_id = COALESCE(excluded.project_id, sessions.project_id),
      status = excluded.status,
      title = CASE WHEN excluded.title IS NOT NULL AND excluded.title != '' THEN excluded.title ELSE sessions.title END,
      started_at = COALESCE(excluded.started_at, sessions.started_at),
      ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
      token_input = COALESCE(excluded.token_input, sessions.token_input),
      token_output = COALESCE(excluded.token_output, sessions.token_output),
      metadata = CASE WHEN excluded.metadata IS NOT NULL AND excluded.metadata != '{}' THEN excluded.metadata ELSE sessions.metadata END,
      updated_at = datetime('now')
  `, ...tenant.values, session.externalKey, session.runtime, session.agentId ?? null, session.taskId ?? null, session.instanceId ?? null, session.projectId ?? null, session.status, session.title ?? '', toCanonicalTimestamp(session.startedAt), toCanonicalTimestamp(session.endedAt), session.tokenInput ?? null, session.tokenOutput ?? null, session.metadata ? JSON.stringify(session.metadata) : '{}');

  const sessionRow = await db.get('SELECT * FROM sessions WHERE external_key = ?', session.externalKey) as CanonicalSessionRow | undefined;
  if (!sessionRow) return null;

  if (messages.length > 0) {
    const insertMsg = db.prepare(`
      INSERT INTO session_messages (
        session_id, ordinal, role, event_type, content, event_meta, raw_payload, timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(session_id, ordinal) DO UPDATE SET
        role = excluded.role,
        event_type = excluded.event_type,
        content = excluded.content,
        event_meta = excluded.event_meta,
        raw_payload = COALESCE(excluded.raw_payload, session_messages.raw_payload),
        timestamp = excluded.timestamp
    `);

    const tx = db.transaction(() => {
      for (const msg of messages) {
        insertMsg.run(
          sessionRow.id,
          msg.ordinal,
          msg.role,
          msg.eventType,
          msg.content,
          JSON.stringify(msg.eventMeta ?? {}),
          msg.rawPayload ?? null,
          toCanonicalTimestamp(msg.timestamp),
        );
      }
    });
    tx();

    await syncSessionMessageCount(db, sessionRow.id);
  }

  return await db.get('SELECT * FROM sessions WHERE id = ?', sessionRow.id) as CanonicalSessionRow;
}

/**
 * ingestSessionByExternalKey — ingest a session using the appropriate adapter.
 * Unlike ensureCanonicalSessionByExternalKey, this always re-runs the adapter
 * (useful for forced refresh after a run completes).
 *
 * @param externalKey  The runtime session key to ingest.
 * @param source       Optional additional context (instanceId, agentId, etc.).
 * @param runtime      Optional explicit runtime (skips key-based inference).
 */
export async function ingestSessionByExternalKey(
  externalKey: string,
  source: Partial<AdapterSource> = {},
  runtime?: string,
): Promise<CanonicalSessionRow | null> {
  const db = getDb();
  const adapter = runtime
    ? (resolveSessionAdapter(runtime) ?? resolveSessionAdapterForKey(externalKey))
    : resolveSessionAdapterForKey(externalKey);

  const fullSource: AdapterSource = { externalKey, ...source };
  const result = await adapter.ingest(fullSource);
  if (!result) return null;

  return await writeIngestResult(db, result);
}
