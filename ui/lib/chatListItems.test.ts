import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatListItems, type ChatListSession } from './chatListItems.ts';

function session(overrides: Partial<ChatListSession> & Pick<ChatListSession, 'agent_id' | 'last_activity'>): ChatListSession {
  return {
    instance_id: null,
    session_key: `session-${overrides.agent_id}-${overrides.last_activity}`,
    agent_id: overrides.agent_id,
    agent_name: `Agent ${overrides.agent_id}`,
    project_id: null,
    last_activity: overrides.last_activity,
    last_message: null,
    message_count: 1,
    ...overrides,
  };
}

test('buildChatListItems sorts direct and run chats together by recent activity', () => {
  const items = buildChatListItems([
    session({ agent_id: 1, instance_id: null, last_activity: '2026-06-01T10:00:00.000Z' }),
    session({ agent_id: 2, instance_id: 42, last_activity: '2026-06-01T12:00:00.000Z' }),
  ], [
    { id: 1, name: 'Atlas' },
    { id: 2, name: 'Prism' },
  ]);

  assert.deepEqual(items.map(item => item.id), ['run-42', 'direct-1-session-1-2026-06-01T10:00:00.000Z']);
});

test('buildChatListItems does not add pinned agent rows when sessions exist', () => {
  const items = buildChatListItems([
    session({ agent_id: 1, instance_id: null, last_activity: '2026-06-01T10:00:00.000Z' }),
  ], [
    { id: 1, name: 'Atlas' },
    { id: 2, name: 'Prism' },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'session');
});

test('buildChatListItems falls back to agents only when no chat sessions are available', () => {
  const items = buildChatListItems([], [
    { id: 1, name: 'Atlas' },
    { id: 2, name: 'Prism' },
  ]);

  assert.deepEqual(items.map(item => item.id), ['agent-1', 'agent-2']);
});
