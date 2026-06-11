export interface ChatListSession {
  instance_id: number | null;
  session_key: string;
  agent_id: number;
  agent_name: string | null;
  project_id?: number | null;
  last_activity: string;
  last_message: string | null;
  message_count: number;
}

export interface ChatListAgent {
  id: number;
  name: string;
  role?: string | null;
}

export type ChatListItem =
  | {
      kind: 'session';
      id: string;
      session: ChatListSession;
      agent: ChatListAgent | null;
      lastActivity: string;
    }
  | {
      kind: 'agent';
      id: string;
      agent: ChatListAgent;
      lastActivity: string | null;
    };

function sessionId(session: ChatListSession): string {
  return session.instance_id === null
    ? `direct-${session.agent_id}-${session.session_key}`
    : `run-${session.instance_id}`;
}

export function buildChatListItems(
  sessions: ChatListSession[],
  agents: ChatListAgent[],
): ChatListItem[] {
  if (sessions.length === 0) {
    return agents.map(agent => ({
      kind: 'agent',
      id: `agent-${agent.id}`,
      agent,
      lastActivity: null,
    }));
  }

  const agentsById = new Map(agents.map(agent => [agent.id, agent]));
  return [...sessions]
    .sort((a, b) => String(b.last_activity ?? '').localeCompare(String(a.last_activity ?? '')))
    .map(session => ({
      kind: 'session',
      id: sessionId(session),
      session,
      agent: agentsById.get(session.agent_id) ?? null,
      lastActivity: session.last_activity,
    }));
}
