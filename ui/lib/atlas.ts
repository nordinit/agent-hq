import type { Agent } from '@/lib/api';

export function isAtlasAgent(agent: Agent | null | undefined): boolean {
  if (!agent) return false;
  return agent.system_role === 'atlas'
    || agent.openclaw_agent_id === 'atlas'
    || agent.session_key === 'agent:atlas:main'
    || agent.name === 'Atlas';
}

export function findAtlasAgent(agents: Agent[]): Agent | undefined {
  return agents.find(isAtlasAgent);
}
