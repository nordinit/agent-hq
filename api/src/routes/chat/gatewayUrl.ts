import { getDb } from '../../db/client';
import { resolveAgentRowForSessionKey } from '../../domains/chat/sessions';
import { getConfiguredGatewayWsUrl } from '../../lib/gatewaySettings';
import { parseRunSessionKey, resolveRuntimeAgentSlug } from '../../lib/sessionKeys';

export function getDefaultGatewayUrl(): string {
  return getConfiguredGatewayWsUrl();
}

export function resolveGatewayUrl(sessionKey: string | null | undefined): string {
  if (!sessionKey) return getDefaultGatewayUrl();
  try {
    const db = getDb();
    let hooksUrl: string | null = null;

    const hook = parseRunSessionKey(sessionKey);
    if (hook) {
      const row = db.prepare(`
        SELECT a.hooks_url, a.session_key, a.openclaw_agent_id, a.name FROM job_instances ji
        JOIN agents a ON a.id = ji.agent_id
        WHERE ji.id = ?
      `).get(hook.instanceId) as {
        hooks_url: string | null;
        session_key: string | null;
        openclaw_agent_id: string | null;
        name: string | null;
      } | undefined;
      hooksUrl = row?.hooks_url ?? null;
    }

    if (!hooksUrl) {
      const agent = resolveAgentRowForSessionKey(sessionKey);
      const agentSlug = resolveRuntimeAgentSlug({
        session_key: agent?.session_key as string | null | undefined,
        openclaw_agent_id: agent?.openclaw_agent_id as string | null | undefined,
        name: agent?.name as string | null | undefined,
      });
      if (agentSlug) {
        const row = db.prepare(`
          SELECT hooks_url FROM agents
          WHERE openclaw_agent_id = ?
             OR session_key LIKE ?
             OR session_key LIKE ?
          LIMIT 1
        `).get(agentSlug, `agent:${agentSlug}:%`, `agent:%:${agentSlug}:%`) as { hooks_url: string | null } | undefined;
        hooksUrl = row?.hooks_url ?? null;
      }
    }

    if (hooksUrl) {
      const url = new URL(hooksUrl);
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const resolved = `${wsProtocol}//${url.host}`;
      console.log(`[chat-proxy] Container session "${sessionKey}" → ${resolved}`);
      return resolved;
    }
  } catch (err) {
    console.warn('[chat-proxy] resolveGatewayUrl error:', err);
  }
  return getDefaultGatewayUrl();
}
