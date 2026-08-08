import { Router, Request, Response } from 'express';
import { getDb } from '../../db/client';
import { runtimeTenantInsertColumns } from '../../lib/runtimeTenantScope';
import { gatewayWsSend } from '../../runtimes/openclaw/gatewayClient';
import { abortChatRunBySessionKey } from '../../runtimes/openclaw';
import { resolveInstanceAbortTransport, stopInstanceExecution } from '../../domains/runs/stopInstanceExecution';
import { resolveTenantIdFromRequest } from '../../lib/tenantContext';
import { dispatchInstance } from '../../services/dispatcher';
import { startChatRunInstance } from './persistence';
import { getCanonicalChatSessionKey, buildDerivedDirectSessionKey } from '../../domains/chat/sessions';
import { resolveAgentRowById } from '../../domains/chat/sessions';
import { nowTimestamp } from '../../lib/timestamps';

/**
 * Chat instance row joined with the runtime columns that decide how a message
 * reaches the agent. `runtime_type` lives on the agent, not the instance, so the
 * join is what makes transport selection possible at all.
 */
interface ChatInstanceRow {
  session_key: string;
  agent_id: number;
  tenant_id: number | null;
  runtime_type: string | null;
  runtime_config: string | null;
  agent_name: string | null;
  job_title: string | null;
  openclaw_agent_id: string | null;
  preferred_provider: string | null;
  provider_connection_id: number | null;
  model: string | null;
  timeout_seconds: number | null;
  project_id: number | null;
}

async function loadChatInstance(instanceId: number): Promise<ChatInstanceRow | undefined> {
  const db = getDb();
  return await db.get(`
    SELECT ji.session_key, ji.agent_id, ji.tenant_id,
           a.runtime_type, a.runtime_config, a.name AS agent_name, a.job_title,
           a.openclaw_agent_id, a.preferred_provider, a.provider_connection_id,
           a.model, a.timeout_seconds, a.project_id
    FROM job_instances ji
    JOIN agents a ON a.id = ji.agent_id
    WHERE ji.id = ?
  `, instanceId) as ChatInstanceRow | undefined;
}

/**
 * Deliver a chat message to a runtime that owns its own process.
 *
 * OpenClaw keeps a live gateway session, so a message is simply pushed into it.
 * Every other runtime is one-shot per run: continuing a conversation means
 * opening a new run for the same chat session. `startChatRunInstance` closes any
 * still-running chat instance for the session and opens a fresh one, which is
 * exactly the turn boundary we need, and the runtime's own transcript writer
 * persists the reply and tool events against that instance.
 */
async function dispatchRuntimeChatTurn(
  instance: ChatInstanceRow,
  message: string,
): Promise<{ ok: true; instanceId: number } | { ok: false; error: string }> {
  const started = await startChatRunInstance({
    instanceId: null,
    durableRunId: null,
    agentId: instance.agent_id,
    sessionKey: instance.session_key,
    tenantId: instance.tenant_id,
  });

  if (!started) {
    return { ok: false, error: 'Could not open a chat run for this agent' };
  }

  try {
    await dispatchInstance({
      instanceId: started.instanceId,
      agentId: instance.agent_id,
      sessionKey: instance.session_key,
      jobTitle: instance.job_title || instance.agent_name || 'Agent',
      message,
      timeoutSeconds: instance.timeout_seconds ?? 900,
      runtimeType: instance.runtime_type,
      runtimeConfig: instance.runtime_config,
      openclawAgentId: instance.openclaw_agent_id,
      preferredProvider: instance.preferred_provider,
      providerConnectionId: instance.provider_connection_id,
      model: instance.model,
      projectId: instance.project_id,
    } as Parameters<typeof dispatchInstance>[0]);
    return { ok: true, instanceId: started.instanceId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Shared delivery for both send routes: persist the user's message against the
 * chat instance, then hand it to whichever transport the agent's runtime uses.
 */
async function sendToInstance(req: Request, res: Response, instanceId: number): Promise<Response | void> {
    const body = req.body as { message?: string; attachment_ids?: number[] };
    const message = body.message?.trim() ?? '';
    const attachmentIds: number[] = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];

    if (!message && attachmentIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'message or attachment required' });
    }

    try {
      const db = getDb();
      const inst = await loadChatInstance(instanceId);
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
      const tenant = await runtimeTenantInsertColumns(db, 'chat_messages', { instanceId, agentId: inst.agent_id });
      await db.run(`
        INSERT INTO chat_messages (id, ${tenant.columnSql}agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
        VALUES (?, ${tenant.valueSql}?, ?, ?, 'user', ?, ?, 'text', '{}') ON CONFLICT DO NOTHING`, `oc-chat-user-${instanceId}-${Date.now()}`, ...tenant.values, inst.agent_id, instanceId, inst.session_key, fullMessage, now);

      // Transport is a property of the agent's runtime, not of chat. OpenClaw
      // owns a live gateway session; every other runtime is dispatched per turn.
      if (resolveInstanceAbortTransport(inst.runtime_type) === 'runtime') {
        const dispatched = await dispatchRuntimeChatTurn(inst, fullMessage);
        if (!dispatched.ok) {
          return res.status(502).json({ ok: false, error: dispatched.error });
        }
        return res.json({ ok: true, instance_id: dispatched.instanceId, transport: 'runtime' });
      }

      const result = await gatewayWsSend({
        sessionKey: inst.session_key,
        message: fullMessage,
      });

      if (!result.ok) {
        return res.status(502).json({ ok: false, error: result.error });
      }
      res.json({ ok: true, instance_id: instanceId, transport: 'openclaw-gateway' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
}

export function registerSendAbortRoutes(router: Router): void {
  router.post('/instances/:id/send', async (req: Request, res: Response) => {
    const instanceId = parseInt(req.params.id, 10);
    if (!Number.isFinite(instanceId)) {
      return res.status(400).json({ ok: false, error: 'Invalid instance id' });
    }
    return sendToInstance(req, res, instanceId);
  });

  /**
   * Agent-scoped send — the entry point a chat surface uses when it has an agent
   * but no instance yet.
   *
   * `/instances/:id/send` cannot serve a fresh conversation: it resolves the
   * agent by joining through the instance, so the very first message of a chat
   * has nothing to address. This resolves the agent's canonical chat session,
   * reuses the live chat instance for it when one exists, and otherwise opens
   * one, then hands off to the same transport-aware delivery as the instance
   * route.
   */
  router.post('/agents/:agentId/send', async (req: Request, res: Response) => {
    const agentId = Number(req.params.agentId);
    const body = req.body as { message?: string; attachment_ids?: number[]; channel?: string };
    const message = body.message?.trim() ?? '';
    const channel = typeof body.channel === 'string' && body.channel.trim() ? body.channel.trim() : 'web';

    if (!Number.isFinite(agentId)) {
      return res.status(400).json({ ok: false, error: 'Invalid agent id' });
    }
    if (!message) {
      return res.status(400).json({ ok: false, error: 'message required' });
    }

    try {
      const db = getDb();
      const agent = await resolveAgentRowById(agentId);
      if (!agent) return res.status(404).json({ ok: false, error: 'Agent not found' });

      const baseSessionKey = typeof agent.session_key === 'string' ? agent.session_key : '';
      const sessionKey = (await getCanonicalChatSessionKey(agentId, channel))
        ?? (await buildDerivedDirectSessionKey(baseSessionKey, channel, agentId, false));
      if (!sessionKey) {
        return res.status(500).json({ ok: false, error: 'Could not resolve a chat session for this agent' });
      }

      const live = await db.get(
        `SELECT id FROM job_instances
         WHERE agent_id = ? AND session_key = ? AND run_stage = 'chat' AND status = 'running'
         ORDER BY id DESC LIMIT 1`,
        agentId, sessionKey,
      ) as { id: number } | undefined;

      let instanceId = live?.id ?? null;
      if (instanceId == null) {
        const started = await startChatRunInstance({
          instanceId: null,
          durableRunId: null,
          agentId,
          sessionKey,
          tenantId: typeof agent.tenant_id === 'number' ? agent.tenant_id : null,
        });
        if (!started) {
          return res.status(500).json({ ok: false, error: 'Could not open a chat run for this agent' });
        }
        instanceId = started.instanceId;
      }

      req.params.id = String(instanceId);
      return sendToInstance(req, res, instanceId);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/instances/:id/abort', async (req: Request, res: Response) => {
    const instanceId = parseInt(req.params.id, 10);

    try {
      const db = getDb();
      const inst = await loadChatInstance(instanceId);
      if (!inst) {
        return res.status(404).json({ ok: false, error: 'Instance not found' });
      }

      // Same seam as send. Routing a claude-code/codex/hermes session key to
      // OpenClaw's chat.abort aborts nothing and reports success.
      if (resolveInstanceAbortTransport(inst.runtime_type) === 'runtime') {
        const tenantId = await resolveTenantIdFromRequest(db, req);
        const stopped = await stopInstanceExecution(db, instanceId, tenantId, 'stop');
        return res.json({ ok: true, status: stopped.result, transport: 'runtime' });
      }

      const result = abortChatRunBySessionKey(inst.session_key);
      res.json({ ok: result.ok, status: result.status, transport: 'openclaw-gateway' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
