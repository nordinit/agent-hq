import type { ChatMessage } from '@/lib/api';
import { parseStoredChatMessages, sortChatMessages } from '@/lib/chatMessages';

/**
 * Transport a chat surface must use to reach an agent.
 *
 * OpenClaw holds a live gateway session, so its messages go over the WebSocket
 * and stream token by token. Every other runtime is one-shot per run: a message
 * is an HTTP send that dispatches a turn, and the reply arrives by polling the
 * canonical transcript the runtime writes. Mirrors resolveInstanceAbortTransport
 * on the API side — the two must agree or a surface will talk to the wrong place.
 */
export type ChatTransport = 'openclaw-gateway' | 'runtime';

export function resolveChatTransport(runtimeType: string | null | undefined): ChatTransport {
  return typeof runtimeType === 'string' && runtimeType.trim() && runtimeType !== 'openclaw'
    ? 'runtime'
    : 'openclaw-gateway';
}

/** Stop a runtime turn. The gateway's chat.abort cannot reach a runtime run. */
export async function abortRuntimeChatTurn(instanceId: number): Promise<boolean> {
  try {
    const res = await fetch(`/api/v1/chat/instances/${instanceId}/abort`, { method: 'POST' });
    const data = await res.json() as { ok?: boolean };
    return res.ok && data.ok === true;
  } catch {
    return false;
  }
}

export interface RuntimeChatSendResult {
  instanceId: number | null;
  error: string | null;
}

/**
 * Send a message to a runtime-backed agent.
 *
 * Agent-scoped rather than instance-scoped: the first message of a conversation
 * has no instance to address, so the API resolves the agent's chat session and
 * opens a turn for it.
 */
export async function sendRuntimeChatMessage(
  agentId: number,
  message: string,
  attachmentIds: number[] = [],
): Promise<RuntimeChatSendResult> {
  try {
    const res = await fetch(`/api/v1/chat/agents/${agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, attachment_ids: attachmentIds, channel: 'web' }),
    });
    const data = await res.json() as { ok?: boolean; instance_id?: number; error?: string };
    if (!res.ok || !data.ok) {
      return { instanceId: null, error: data.error ?? 'Send failed' };
    }
    return { instanceId: typeof data.instance_id === 'number' ? data.instance_id : null, error: null };
  } catch (err) {
    return { instanceId: null, error: err instanceof Error ? err.message : 'Send failed' };
  }
}

/**
 * Read the agent's current runtime conversation.
 *
 * Scoping is the server's job: a runtime turn rewrites its instance's session key
 * to the run's own id, so the thread cannot be fetched by key, and a boundary
 * kept in the browser is lost on refresh — which showed every earlier
 * conversation again after "new chat".
 */
export async function loadRuntimeChatTranscript(agentId: number): Promise<ChatMessage[]> {
  const res = await fetch(`/api/v1/chat/agents/${agentId}/runtime-transcript?limit=500`);
  if (!res.ok) return [];
  const data = await res.json() as { messages?: Array<Record<string, unknown>> };
  return sortChatMessages(parseStoredChatMessages(data.messages ?? []));
}

/** Begin a new conversation by moving the server-side boundary forward. */
export async function rotateRuntimeChatSession(agentId: number): Promise<boolean> {
  try {
    const res = await fetch(`/api/v1/chat/agents/${agentId}/chat-session/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'web' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
