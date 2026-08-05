import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/client';
import { tableHasColumn } from '../../lib/durableRunIdentity';
import { tenantInsertColumns, tenantUpsertUpdateSql } from '../../lib/runtimeTenantScope';
import { nowTimestamp, toCanonicalTimestampOrNow } from '../../lib/timestamps';
import { SessionContext } from './sessionContext';
import { StructuredEvent, extractStructuredEvents, normalizeChatRole } from './structuredEvents';

function contextRowScope(ctx: SessionContext): string {
  if (ctx.durableRunId) return ctx.durableRunId;
  if (ctx.instanceId !== null) return String(ctx.instanceId);
  return crypto.createHash('sha1').update(ctx.sessionKey).digest('hex').slice(0, 12);
}

function stableLiveEventSuffix(evt: StructuredEvent): string {
  const meta = evt.event_meta;
  const stableId = meta.id ?? meta.tool_call_id ?? meta.tool_use_id ?? meta.call_id;
  if (typeof stableId === 'string' && stableId.trim()) {
    return `${evt.event_type}-${stableId.trim().replace(/[^a-zA-Z0-9_.:-]/g, '_')}`;
  }
  return `${evt.event_type}-${crypto
    .createHash('sha1')
    .update(JSON.stringify({ event_type: evt.event_type, content: evt.content, event_meta: meta }))
    .digest('hex')
    .slice(0, 12)}`;
}

async function chatMessageDurableColumns(db: ReturnType<typeof getDb>, ctx: SessionContext): Promise<{
  insertColumnSql: string;
  valueSql: string;
  updateSql: string;
  values: unknown[];
}> {
  if (!await tableHasColumn(db, 'chat_messages', 'durable_run_id')) {
    return { insertColumnSql: '', valueSql: '', updateSql: '', values: [] };
  }
  return {
    insertColumnSql: 'durable_run_id, ',
    valueSql: '?, ',
    updateSql: 'durable_run_id = excluded.durable_run_id,',
    values: [ctx.durableRunId],
  };
}

export async function persistHistoryMessages(ctx: SessionContext, messages: Array<Record<string, unknown>>): Promise<void> {
  try {
    const db = getDb();
    const rowScope = contextRowScope(ctx);
    const durable = await chatMessageDurableColumns(db, ctx);
    const tenant = await tenantInsertColumns(db, 'chat_messages', ctx.tenantId);
    const insertSql = `
      INSERT INTO chat_messages (id, ${tenant.columnSql}agent_id, instance_id, ${durable.insertColumnSql}session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ${tenant.valueSql}?, ?, ${durable.valueSql}?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ${await tenantUpsertUpdateSql(db, 'chat_messages')}
        content = excluded.content,
        timestamp = excluded.timestamp,
        event_type = excluded.event_type,
        event_meta = excluded.event_meta,
        ${durable.updateSql}
        session_key = excluded.session_key
    `;

    await db.run('DELETE FROM chat_messages WHERE id LIKE ? OR id LIKE ?', `oc-hist-${rowScope}-%`, `oc-live-${rowScope}-%`);

    let rowIndex = 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      // Runtime-supplied timestamps arrive as epoch-ms or as arbitrary ISO
      // strings; normalize so chat_messages.timestamp only ever holds the
      // canonical offset-less UTC form its DEFAULT also produces.
      const ts = toCanonicalTimestampOrNow(m.timestamp);

      const events = extractStructuredEvents(m).filter(evt => evt.event_type !== 'text');
      for (const evt of events) {
        const rowId = `oc-hist-${rowScope}-${rowIndex++}`;
        await db.run(
          insertSql,
          rowId,
          ...tenant.values,
          ctx.agentId,
          ctx.instanceId,
          ...durable.values,
          ctx.sessionKey,
          normalizeChatRole(m.role, evt.event_type),
          evt.content,
          ts,
          evt.event_type,
          JSON.stringify(evt.event_meta),
        );
      }
    }
  } catch (err) {
    console.warn('[chat-proxy] Failed to persist history:', err instanceof Error ? err.message : String(err));
  }
}

export async function persistLiveStructuredMessage(ctx: SessionContext, message: Record<string, unknown>): Promise<void> {
  try {
    const events = extractStructuredEvents(message).filter(evt => evt.event_type !== 'text');
    if (events.length === 0) return;

    const db = getDb();
    const rowScope = contextRowScope(ctx);
    const durable = await chatMessageDurableColumns(db, ctx);
    const tenant = await tenantInsertColumns(db, 'chat_messages', ctx.tenantId);
    const ts = toCanonicalTimestampOrNow(message.timestamp);
    const insertSql = `
      INSERT INTO chat_messages (id, ${tenant.columnSql}agent_id, instance_id, ${durable.insertColumnSql}session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ${tenant.valueSql}?, ?, ${durable.valueSql}?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ${await tenantUpsertUpdateSql(db, 'chat_messages')}
        role = excluded.role,
        content = excluded.content,
        timestamp = excluded.timestamp,
        event_type = excluded.event_type,
        event_meta = excluded.event_meta,
        ${durable.updateSql}
        session_key = excluded.session_key
    `;

    for (const evt of events) {
      await db.run(
        insertSql,
        `oc-live-${rowScope}-${stableLiveEventSuffix(evt)}`,
        ...tenant.values,
        ctx.agentId,
        ctx.instanceId,
        ...durable.values,
        ctx.sessionKey,
        normalizeChatRole(message.role, evt.event_type),
        evt.content,
        ts,
        evt.event_type,
        JSON.stringify(evt.event_meta),
      );
    }
  } catch (err) {
    console.warn('[chat-proxy] Failed to persist live structured event:', err instanceof Error ? err.message : String(err));
  }
}

export async function persistStreamDelta(ctx: SessionContext, cumulativeText: string): Promise<void> {
  try {
    const db = getDb();
    const now = nowTimestamp();
    const durable = await chatMessageDurableColumns(db, ctx);
    const tenant = await tenantInsertColumns(db, 'chat_messages', ctx.tenantId);
    await db.run(`
      INSERT INTO chat_messages (id, ${tenant.columnSql}agent_id, instance_id, ${durable.insertColumnSql}session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ${tenant.valueSql}?, ?, ${durable.valueSql}?, 'assistant', ?, ?, 'text', '{}')
      ON CONFLICT(id) DO UPDATE SET ${await tenantUpsertUpdateSql(db, 'chat_messages')} content = excluded.content, timestamp = excluded.timestamp, ${durable.updateSql} session_key = excluded.session_key
    `, `oc-stream-${contextRowScope(ctx)}`, ...tenant.values, ctx.agentId, ctx.instanceId, ...durable.values, ctx.sessionKey, cumulativeText, now);
  } catch { /* non-critical */ }
}

export async function persistFinalMessage(ctx: SessionContext, text: string, msgIndex: number): Promise<void> {
  try {
    const db = getDb();
    const now = nowTimestamp();
    const rowScope = contextRowScope(ctx);
    const durable = await chatMessageDurableColumns(db, ctx);
    const tenant = await tenantInsertColumns(db, 'chat_messages', ctx.tenantId);
    await db.run(`
      INSERT INTO chat_messages (id, ${tenant.columnSql}agent_id, instance_id, ${durable.insertColumnSql}session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ${tenant.valueSql}?, ?, ${durable.valueSql}?, 'assistant', ?, ?, 'text', '{}')
      ON CONFLICT(id) DO UPDATE SET ${await tenantUpsertUpdateSql(db, 'chat_messages')} content = excluded.content, timestamp = excluded.timestamp, ${durable.updateSql} session_key = excluded.session_key
    `, `oc-asst-${rowScope}-${msgIndex}`, ...tenant.values, ctx.agentId, ctx.instanceId, ...durable.values, ctx.sessionKey, text, now);
    await db.run('DELETE FROM chat_messages WHERE id = ?', `oc-stream-${rowScope}`);
  } catch { /* non-critical */ }
}

export async function startChatRunInstance(ctx: SessionContext): Promise<{ instanceId: number; durableRunId: string } | null> {
  try {
    const db = getDb();
    const now = nowTimestamp();
    await db.run(`UPDATE job_instances SET status = 'done', completed_at = ?, runtime_ended_at = ?
       WHERE agent_id = ? AND session_key = ? AND run_stage = 'chat' AND status = 'running'`, now, now, ctx.agentId, ctx.sessionKey);

    const durableRunId = `chat-${randomUUID()}`;
    const hasDurable = await tableHasColumn(db, 'job_instances', 'durable_run_id');
    const tenant = await tenantInsertColumns(db, 'job_instances', ctx.tenantId);
    const info = hasDurable
      ? await db.run(`INSERT INTO job_instances (${tenant.columnSql}agent_id, task_id, status, session_key, run_stage, started_at, durable_run_id)
           VALUES (${tenant.valueSql}?, NULL, 'running', ?, 'chat', ?, ?)`, ...tenant.values, ctx.agentId, ctx.sessionKey, now, durableRunId)
      : await db.run(`INSERT INTO job_instances (${tenant.columnSql}agent_id, task_id, status, session_key, run_stage, started_at)
           VALUES (${tenant.valueSql}?, NULL, 'running', ?, 'chat', ?)`, ...tenant.values, ctx.agentId, ctx.sessionKey, now);
    return { instanceId: Number(info.lastInsertId), durableRunId };
  } catch (err) {
    console.warn('[chat-proxy] Failed to start chat run instance:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function completeChatRunInstance(instanceId: number, status: 'done' | 'failed' | 'cancelled'): Promise<void> {
  try {
    const db = getDb();
    const now = nowTimestamp();
    await db.run(`UPDATE job_instances SET status = ?, completed_at = ?, runtime_ended_at = ?
       WHERE id = ? AND status = 'running'`, status, now, now, instanceId);
  } catch { /* non-critical */ }
}

export async function persistUserChatMessage(ctx: SessionContext, message: string): Promise<void> {
  try {
    const db = getDb();
    const now = nowTimestamp();
    const durable = await chatMessageDurableColumns(db, ctx);
    const tenant = await tenantInsertColumns(db, 'chat_messages', ctx.tenantId);
    const msgId = `oc-chat-user-${contextRowScope(ctx)}-${Date.now()}`;
    await db.run(`
      INSERT INTO chat_messages (id, ${tenant.columnSql}agent_id, instance_id, ${durable.insertColumnSql}session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ${tenant.valueSql}?, ?, ${durable.valueSql}?, 'user', ?, ?, 'text', '{}') ON CONFLICT DO NOTHING`, msgId, ...tenant.values, ctx.agentId, ctx.instanceId, ...durable.values, ctx.sessionKey, message, now);
  } catch { /* non-critical */ }
}
