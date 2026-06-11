import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/client';
import { tableHasColumn } from '../../lib/durableRunIdentity';
import { tenantInsertColumns, tenantUpsertUpdateSql } from '../../lib/runtimeTenantScope';
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

function chatMessageDurableColumns(db: ReturnType<typeof getDb>, ctx: SessionContext): {
  insertColumnSql: string;
  valueSql: string;
  updateSql: string;
  values: unknown[];
} {
  if (!tableHasColumn(db, 'chat_messages', 'durable_run_id')) {
    return { insertColumnSql: '', valueSql: '', updateSql: '', values: [] };
  }
  return {
    insertColumnSql: 'durable_run_id, ',
    valueSql: '?, ',
    updateSql: 'durable_run_id = excluded.durable_run_id,',
    values: [ctx.durableRunId],
  };
}

export function persistHistoryMessages(ctx: SessionContext, messages: Array<Record<string, unknown>>): void {
  try {
    const db = getDb();
    const rowScope = contextRowScope(ctx);
    const durable = chatMessageDurableColumns(db, ctx);
    const tenant = tenantInsertColumns(db, 'chat_messages', ctx.tenantId);
    const stmt = db.prepare(`
      INSERT INTO chat_messages (id, ${tenant.columnSql}agent_id, instance_id, ${durable.insertColumnSql}session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ${tenant.valueSql}?, ?, ${durable.valueSql}?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ${tenantUpsertUpdateSql(db, 'chat_messages')}
        content = excluded.content,
        timestamp = excluded.timestamp,
        event_type = excluded.event_type,
        event_meta = excluded.event_meta,
        ${durable.updateSql}
        session_key = excluded.session_key
    `);

    db.prepare('DELETE FROM chat_messages WHERE id LIKE ? OR id LIKE ?').run(
      `oc-hist-${rowScope}-%`,
      `oc-live-${rowScope}-%`,
    );

    let rowIndex = 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const ts = typeof m.timestamp === 'number' ? new Date(m.timestamp).toISOString()
        : typeof m.timestamp === 'string' ? m.timestamp
        : new Date().toISOString();

      const events = extractStructuredEvents(m).filter(evt => evt.event_type !== 'text');
      for (const evt of events) {
        const rowId = `oc-hist-${rowScope}-${rowIndex++}`;
        stmt.run(
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

export function persistLiveStructuredMessage(ctx: SessionContext, message: Record<string, unknown>): void {
  try {
    const events = extractStructuredEvents(message).filter(evt => evt.event_type !== 'text');
    if (events.length === 0) return;

    const db = getDb();
    const rowScope = contextRowScope(ctx);
    const durable = chatMessageDurableColumns(db, ctx);
    const tenant = tenantInsertColumns(db, 'chat_messages', ctx.tenantId);
    const ts =
      typeof message.timestamp === 'number'
        ? new Date(message.timestamp).toISOString()
        : typeof message.timestamp === 'string'
          ? message.timestamp
          : new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO chat_messages (id, ${tenant.columnSql}agent_id, instance_id, ${durable.insertColumnSql}session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ${tenant.valueSql}?, ?, ${durable.valueSql}?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ${tenantUpsertUpdateSql(db, 'chat_messages')}
        role = excluded.role,
        content = excluded.content,
        timestamp = excluded.timestamp,
        event_type = excluded.event_type,
        event_meta = excluded.event_meta,
        ${durable.updateSql}
        session_key = excluded.session_key
    `);

    for (const evt of events) {
      stmt.run(
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

export function persistStreamDelta(ctx: SessionContext, cumulativeText: string): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const durable = chatMessageDurableColumns(db, ctx);
    const tenant = tenantInsertColumns(db, 'chat_messages', ctx.tenantId);
    db.prepare(`
      INSERT INTO chat_messages (id, ${tenant.columnSql}agent_id, instance_id, ${durable.insertColumnSql}session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ${tenant.valueSql}?, ?, ${durable.valueSql}?, 'assistant', ?, ?, 'text', '{}')
      ON CONFLICT(id) DO UPDATE SET ${tenantUpsertUpdateSql(db, 'chat_messages')} content = excluded.content, timestamp = excluded.timestamp, ${durable.updateSql} session_key = excluded.session_key
    `).run(`oc-stream-${contextRowScope(ctx)}`, ...tenant.values, ctx.agentId, ctx.instanceId, ...durable.values, ctx.sessionKey, cumulativeText, now);
  } catch { /* non-critical */ }
}

export function persistFinalMessage(ctx: SessionContext, text: string, msgIndex: number): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const rowScope = contextRowScope(ctx);
    const durable = chatMessageDurableColumns(db, ctx);
    const tenant = tenantInsertColumns(db, 'chat_messages', ctx.tenantId);
    db.prepare(`
      INSERT INTO chat_messages (id, ${tenant.columnSql}agent_id, instance_id, ${durable.insertColumnSql}session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ${tenant.valueSql}?, ?, ${durable.valueSql}?, 'assistant', ?, ?, 'text', '{}')
      ON CONFLICT(id) DO UPDATE SET ${tenantUpsertUpdateSql(db, 'chat_messages')} content = excluded.content, timestamp = excluded.timestamp, ${durable.updateSql} session_key = excluded.session_key
    `).run(`oc-asst-${rowScope}-${msgIndex}`, ...tenant.values, ctx.agentId, ctx.instanceId, ...durable.values, ctx.sessionKey, text, now);
    db.prepare('DELETE FROM chat_messages WHERE id = ?').run(`oc-stream-${rowScope}`);
  } catch { /* non-critical */ }
}

export function startChatRunInstance(ctx: SessionContext): { instanceId: number; durableRunId: string } | null {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE job_instances SET status = 'done', completed_at = ?, runtime_ended_at = ?
       WHERE agent_id = ? AND session_key = ? AND run_stage = 'chat' AND status = 'running'`,
    ).run(now, now, ctx.agentId, ctx.sessionKey);

    const durableRunId = `chat-${randomUUID()}`;
    const hasDurable = tableHasColumn(db, 'job_instances', 'durable_run_id');
    const tenant = tenantInsertColumns(db, 'job_instances', ctx.tenantId);
    const info = hasDurable
      ? db.prepare(
          `INSERT INTO job_instances (${tenant.columnSql}agent_id, task_id, status, session_key, run_stage, started_at, durable_run_id)
           VALUES (${tenant.valueSql}?, NULL, 'running', ?, 'chat', ?, ?)`,
        ).run(...tenant.values, ctx.agentId, ctx.sessionKey, now, durableRunId)
      : db.prepare(
          `INSERT INTO job_instances (${tenant.columnSql}agent_id, task_id, status, session_key, run_stage, started_at)
           VALUES (${tenant.valueSql}?, NULL, 'running', ?, 'chat', ?)`,
        ).run(...tenant.values, ctx.agentId, ctx.sessionKey, now);
    return { instanceId: Number(info.lastInsertRowid), durableRunId };
  } catch (err) {
    console.warn('[chat-proxy] Failed to start chat run instance:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function completeChatRunInstance(instanceId: number, status: 'done' | 'failed' | 'cancelled'): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE job_instances SET status = ?, completed_at = ?, runtime_ended_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(status, now, now, instanceId);
  } catch { /* non-critical */ }
}

export function persistUserChatMessage(ctx: SessionContext, message: string): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const durable = chatMessageDurableColumns(db, ctx);
    const tenant = tenantInsertColumns(db, 'chat_messages', ctx.tenantId);
    const msgId = `oc-chat-user-${contextRowScope(ctx)}-${Date.now()}`;
    db.prepare(`
      INSERT OR IGNORE INTO chat_messages (id, ${tenant.columnSql}agent_id, instance_id, ${durable.insertColumnSql}session_key, role, content, timestamp, event_type, event_meta)
      VALUES (?, ${tenant.valueSql}?, ?, ${durable.valueSql}?, 'user', ?, ?, 'text', '{}')
    `).run(msgId, ...tenant.values, ctx.agentId, ctx.instanceId, ...durable.values, ctx.sessionKey, message, now);
  } catch { /* non-critical */ }
}
