import type { Db } from '../../db/adapter/types';
import { resolveRuntimeAgentSlug } from '../../lib/sessionKeys';

/** Display names are read-time metadata; stored audit actors remain unchanged. */
export async function taskActorDisplayNames(db: Db, taskId: number) {
  const agents = await db.all<{
    id: number; name: string; slug: string | null; openclaw_agent_id: string | null; session_key: string | null;
  }>(`
    SELECT id, name, slug, openclaw_agent_id, session_key
    FROM agents
    WHERE tenant_id = (SELECT tenant_id FROM tasks WHERE id = ?)
  `, taskId);
  const aliases = new Map<string, { id: number; name: string } | null>();
  for (const agent of agents) {
    const name = agent.name?.trim();
    if (!name) continue;
    for (const alias of [name, agent.slug, agent.openclaw_agent_id, agent.session_key,
      resolveRuntimeAgentSlug(agent), `agent:${agent.id}`, `Agent #${agent.id}`]) {
      if (!alias?.trim()) continue;
      const key = alias.trim().toLowerCase();
      // An ambiguous historical label cannot safely identify an agent.
      const previous = aliases.get(key);
      aliases.set(key, previous === undefined || previous?.id === agent.id ? { id: agent.id, name } : null);
    }
  }
  return (actor: unknown): string => typeof actor === 'string'
    ? aliases.get(actor.trim().toLowerCase())?.name ?? actor
    : '';
}
