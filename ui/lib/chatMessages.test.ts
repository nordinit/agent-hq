import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMessage } from './api.ts';
import {
  buildTranscriptRows,
  countToolUses,
  mergeChatMessages,
  parseStoredChatMessages,
  reconcileChatMessageSnapshot,
  sortChatMessages,
} from './chatMessages.ts';

describe('chat message transcript helpers', () => {
  it('parses stored tool call and tool result rows for compact event rendering', () => {
    const parsed = parseStoredChatMessages([
      {
        id: 'tool-call-1',
        role: 'assistant',
        content: 'exec_command',
        timestamp: '2026-06-03T10:00:01.000Z',
        event_type: 'tool_call',
        event_meta: JSON.stringify({ name: 'exec_command', args: { cmd: 'npm test' } }),
      },
      {
        id: 'tool-result-1',
        role: 'assistant',
        content: 'ok',
        timestamp: '2026-06-03T10:00:02.000Z',
        event_type: 'tool_result',
        event_meta: JSON.stringify({ tool_name: 'exec_command', output: 'ok' }),
      },
    ]);

    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].event_type, 'tool_call');
    assert.deepEqual(parsed[0].meta, { name: 'exec_command', args: { cmd: 'npm test' } });
    assert.equal(parsed[1].event_type, 'tool_result');
    assert.deepEqual(parsed[1].meta, { tool_name: 'exec_command', output: 'ok' });
  });

  it('dedupes repeated poll rows and updates matching transcript rows in place', () => {
    const existing: ChatMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'old',
        timestamp: '2026-06-03T10:00:01.000Z',
        event_type: 'text',
      },
    ];

    const incoming: ChatMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'new',
        timestamp: '2026-06-03T10:00:02.000Z',
        event_type: 'text',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'new',
        timestamp: '2026-06-03T10:00:02.000Z',
        event_type: 'text',
      },
    ];

    const merged = mergeChatMessages(existing, incoming);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'assistant-1');
    assert.equal(merged[0].content, 'new');
  });

  it('replaces an optimistic user bubble whose meta is absent with the persisted row', () => {
    // The composer builds its optimistic bubble without a `meta` field, while every
    // row that comes back from the API is normalized through parseEventMeta and so
    // always carries `meta: {}`. Absent and empty meta must fingerprint identically,
    // or the optimistic bubble survives alongside the persisted row and the user
    // sees their own message twice.
    const optimistic: ChatMessage[] = [
      {
        id: 'user-1786159172430',
        role: 'user',
        content: 'hi',
        timestamp: '2026-08-08T03:19:32.000Z',
      },
    ];

    const persisted = parseStoredChatMessages([
      {
        id: 'oc-chat-user-chat-8a1a7849-1786159172430',
        role: 'user',
        content: 'hi',
        timestamp: '2026-08-08T03:19:32.000Z',
        event_type: 'text',
        event_meta: '{}',
      },
    ]);

    const merged = mergeChatMessages(optimistic, persisted);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'oc-chat-user-chat-8a1a7849-1786159172430');
  });

  it('replaces optimistic and rolling rows with persisted final transcript rows', () => {
    const existing: ChatMessage[] = [
      {
        id: 'user-local',
        role: 'user',
        content: 'Ship it',
        timestamp: '2026-06-03T10:00:00.000Z',
        event_type: 'text',
      },
      {
        id: 'oc-stream-agent-1',
        role: 'assistant',
        content: 'Done.',
        timestamp: '2026-06-03T10:00:01.000Z',
        event_type: 'text',
      },
    ];

    const snapshot: ChatMessage[] = [
      {
        id: 'oc-chat-user-agent-1',
        role: 'user',
        content: 'Ship it',
        timestamp: '2026-06-03T10:00:00.500Z',
        event_type: 'text',
      },
      {
        id: 'oc-asst-agent-1-0',
        role: 'assistant',
        content: 'Done.',
        timestamp: '2026-06-03T10:00:03.000Z',
        event_type: 'text',
      },
    ];

    const reconciled = reconcileChatMessageSnapshot(existing, snapshot);

    assert.deepEqual(reconciled.map(message => message.id), [
      'oc-chat-user-agent-1',
      'oc-asst-agent-1-0',
    ]);
  });
});

describe('transcript tool grouping', () => {
  const msg = (over: Partial<ChatMessage> & { id: string }): ChatMessage => ({
    role: 'assistant',
    content: '',
    timestamp: '2026-08-08T03:19:48.000Z',
    event_type: 'text',
    ...over,
  });

  it('groups a run of tool events and places it before the reply they produced', () => {
    const rows = buildTranscriptRows([
      msg({ id: 'u1', role: 'user', content: 'hi', timestamp: '2026-08-08T03:19:32.000Z' }),
      msg({ id: 't1', event_type: 'tool_call', content: 'bash' }),
      msg({ id: 't2', event_type: 'tool_result', content: 'ok' }),
      msg({ id: 't3', event_type: 'tool_call', content: 'bash' }),
      msg({ id: 't4', event_type: 'tool_result', content: 'ok' }),
      msg({ id: 'a1', content: 'Hi Masiah.', timestamp: '2026-08-08T03:19:50.000Z' }),
    ]);

    assert.deepEqual(rows.map(r => r.kind), ['message', 'tools', 'message']);
    const tools = rows[1];
    assert.equal(tools.kind === 'tools' && tools.events.length, 4);
    assert.equal(rows[2].kind === 'message' && rows[2].message.id, 'a1');
  });

  it('counts a call and its result as one tool use', () => {
    const events = [
      msg({ id: 't1', event_type: 'tool_call' }),
      msg({ id: 't2', event_type: 'tool_result' }),
      msg({ id: 't3', event_type: 'tool_call' }),
      msg({ id: 't4', event_type: 'tool_result' }),
    ];
    assert.equal(countToolUses(events), 2);
  });

  it('leaves a trailing tool run in place while the turn is still running', () => {
    const rows = buildTranscriptRows([
      msg({ id: 'a1', content: 'working on it' }),
      msg({ id: 't1', event_type: 'tool_call', content: 'bash' }),
    ]);

    assert.deepEqual(rows.map(r => r.kind), ['message', 'tools']);
  });

  it('orders tool events before the reply when a turn shares one timestamp', () => {
    const sorted = sortChatMessages([
      msg({ id: 'a1', content: 'done' }),
      msg({ id: 't1', event_type: 'tool_call', content: 'bash' }),
    ]);

    assert.deepEqual(sorted.map(m => m.id), ['t1', 'a1']);
  });
});
