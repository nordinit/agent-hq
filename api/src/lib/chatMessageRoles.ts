export type PersistedChatRole = 'user' | 'assistant' | 'system' | 'tool';

export function normalizeChatMessageRole(
  role: unknown,
  eventType?: unknown,
): PersistedChatRole {
  if (role === 'user') return 'user';
  if (role === 'tool') return 'tool';
  if (role === 'system') return 'system';
  if (role === 'assistant') {
    return eventType === 'tool_result' ? 'tool' : 'assistant';
  }

  if (eventType === 'tool_result') return 'tool';
  if (eventType === 'system' || eventType === 'error') return 'system';
  return 'assistant';
}
