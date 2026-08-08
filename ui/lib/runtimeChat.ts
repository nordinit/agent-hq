import { api, type ChatMessage } from '@/lib/api';
import { mergeChatMessages, parseStoredChatMessages, sortChatMessages } from '@/lib/chatMessages';

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

/** Turns to keep on screen. Each runtime turn is its own instance. */
const RUNTIME_CHAT_TURN_WINDOW = 12;

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
 * Read a runtime-backed conversation.
 *
 * A runtime turn writes its transcript under the run's own session key, not the
 * chat session key, so the conversation cannot be fetched by key the way an
 * OpenClaw chat can — it is assembled from the recent chat instances instead.
 * `mergeChatMessages` dedupes across them, so overlapping fetches are harmless
 * and a reload rebuilds the thread without any client-side bookkeeping.
 */
export async function loadRuntimeChatTranscript(
  agentId: number,
  extraInstanceIds: readonly number[] = [],
  afterInstanceId: number | null = null,
): Promise<ChatMessage[]> {
  const sessions = await api.getChatSessions(agentId, RUNTIME_CHAT_TURN_WINDOW).catch(() => []);
  const instanceIds = Array.from(new Set([
    ...sessions.map(session => session.instance_id).filter((id): id is number => typeof id === 'number'),
    ...extraInstanceIds,
  ]))
    // "New chat" on a runtime agent cannot rotate a session key the way an
    // OpenClaw chat does, because each turn's rows carry the run's own key. The
    // floor is the boundary instead: only turns opened after it belong to the
    // current conversation.
    .filter(id => afterInstanceId == null || id > afterInstanceId)
    .sort((left, right) => left - right)
    .slice(-RUNTIME_CHAT_TURN_WINDOW);

  if (instanceIds.length === 0) return [];

  const perInstance = await Promise.all(instanceIds.map(id =>
    api.getChatSessionMessages(id, '', 200)
      .then(rows => parseStoredChatMessages(rows))
      .catch(() => [] as ChatMessage[]),
  ));

  return sortChatMessages(perInstance.reduce<ChatMessage[]>(
    (acc, rows) => mergeChatMessages(acc, rows),
    [],
  ));
}
