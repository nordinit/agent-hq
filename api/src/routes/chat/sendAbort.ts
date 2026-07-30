import { Router, Request, Response } from 'express';
import { getDb } from '../../db/client';
import { resolveRuntimeTenantId, tenantInsertColumns } from '../../lib/runtimeTenantScope';
import { gatewayWsSend } from '../../runtimes/openclaw/gatewayClient';
import { abortChatRunBySessionKey } from '../../runtimes/openclaw';
import { nowTimestamp } from '../../lib/timestamps';

export function registerSendAbortRoutes(router: Router): void {
  router.post('/instances/:id/send', async (req: Request, res: Response) => {
    const instanceId = parseInt(req.params.id, 10);
    const body = req.body as { message?: string; attachment_ids?: number[] };
    const message = body.message?.trim() ?? '';
    const attachmentIds: number[] = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];

    if (!message && attachmentIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'message or attachment required' });
    }

    try {
      const db = getDb();
      const inst = await db.get('SELECT session_key, agent_id FROM job_instances WHERE id = ?', instanceId) as { session_key: string; agent_id: number } | undefined;
      if (!inst) {
        return res.status(404).json({ ok: false, error: 'Instance not found' });
      }

      let attachmentLines = '';
      if (attachmentIds.length > 0) {
        const placeholders = attachmentIds.map(() => '?').join(',');
        const attachments = await db.all(`SELECT * FROM chat_attachments WHERE id IN (${placeholders})`, ...attachmentIds) as Array<Record<string, unknown>>;
        for (const a of attachments) {
          await db.run('UPDATE chat_attachments SET instance_id = ?, agent_id = ? WHERE id = ?', instanceId, inst.agent_id, a.id);
        }
        attachmentLines = attachments.map(a => {
          const url = `/api/v1/chat/attachments/${a.id as number}/download`;
          return `[Attachment: ${a.filename as string} (${a.mime_type as string}, ${Math.round((a.size as number) / 1024)} KB) — ${url}]`;
        }).join('\n');
      }

      const fullMessage = [message, attachmentLines].filter(Boolean).join('\n');
      const now = nowTimestamp();
      const tenantId = await resolveRuntimeTenantId(db, { instanceId, agentId: inst.agent_id });
      const tenant = await tenantInsertColumns(db, 'chat_messages', tenantId);
      await db.run(`
        INSERT OR IGNORE INTO chat_messages (id, ${tenant.columnSql}agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
        VALUES (?, ${tenant.valueSql}?, ?, ?, 'user', ?, ?, 'text', '{}')
      `, `oc-chat-user-${instanceId}-${Date.now()}`, ...tenant.values, inst.agent_id, instanceId, inst.session_key, fullMessage, now);

      const result = await gatewayWsSend({
        sessionKey: inst.session_key,
        message: fullMessage,
      });

      if (!result.ok) {
        return res.status(502).json({ ok: false, error: result.error });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/instances/:id/abort', async (req: Request, res: Response) => {
    const instanceId = parseInt(req.params.id, 10);

    try {
      const db = getDb();
      const inst = await db.get('SELECT session_key FROM job_instances WHERE id = ?', instanceId) as { session_key: string } | undefined;
      if (!inst) {
        return res.status(404).json({ ok: false, error: 'Instance not found' });
      }

      const result = abortChatRunBySessionKey(inst.session_key);
      res.json({ ok: result.ok, status: result.status });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
