import { Router, Request, Response } from 'express';
import { getDb } from '../../db/client';
import {
  buildDerivedDirectSessionKey,
  getCanonicalChatSessionKey,
  listChatSessionMessages,
  listChatSessions,
  resolveAgentRowById,
} from '../../domains/chat/sessions';
import { getConfiguredGatewayAuthToken } from '../../lib/gatewaySettings';
import { resolveTenantIdFromRequest } from '../../lib/tenantContext';

async function getChatGatewayToken(): Promise<string> {
  return (
    process.env.GATEWAY_TOKEN
    ?? process.env.OPENCLAW_GATEWAY_TOKEN
    ?? (await getConfiguredGatewayAuthToken())
    ?? ''
  );
}

export function registerMessagesHistoryRoutes(router: Router): void {
  router.get('/canonical-session/:agentId', async (req: Request, res: Response) => {
    const agentId = Number(req.params.agentId);
    const channel = typeof req.query.channel === 'string' && req.query.channel.trim() ? req.query.channel.trim() : 'web';
    if (!Number.isFinite(agentId)) {
      return res.status(400).json({ error: 'Invalid agent id' });
    }

    const agent = await resolveAgentRowById(agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const baseSessionKey = typeof agent.session_key === 'string' ? agent.session_key : '';
    const sessionKey = (await getCanonicalChatSessionKey(agentId, channel))
      ?? (await buildDerivedDirectSessionKey(baseSessionKey, channel, agentId, false));

    return res.json({ sessionKey, channel, agentId });
  });

  router.get('/config', async (req: Request, res: Response) => {
    const host = req.headers.host || 'localhost:3501';
    const protocol = req.secure ? 'wss' : 'ws';
    res.json({
      gatewayUrl: `${protocol}://${host}/api/v1/chat/ws`,
      token: await getChatGatewayToken(),
    });
  });

  router.get('/sessions', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const tenantId = await resolveTenantIdFromRequest(db, req);
      return res.json(await listChatSessions(db, { ...req.query, tenantId }));
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.get('/sessions/:instanceId/messages', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const tenantId = await resolveTenantIdFromRequest(db, req);
      return res.json(await listChatSessionMessages(db, req.params.instanceId, { ...req.query, tenantId }));
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });
}
