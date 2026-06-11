import {
  extractGatewayStructuredEvents,
  extractTextFromGatewayMessage,
} from './openclawMessageEvents';

describe('openclawMessageEvents', () => {
  it('parses camelCase assistant toolCall blocks as tool_call events', () => {
    const events = extractGatewayStructuredEvents({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-123',
          name: 'read',
          arguments: { path: '/tmp/example.txt', offset: 1, limit: 20 },
        },
      ],
    });

    expect(events).toEqual([
      {
        event_type: 'tool_call',
        content: 'read',
        event_meta: {
          name: 'read',
          args: { path: '/tmp/example.txt', offset: 1, limit: 20 },
          id: 'call-123',
        },
      },
    ]);
  });

  it('parses top-level toolResult messages as tool_result events', () => {
    const events = extractGatewayStructuredEvents({
      role: 'toolResult',
      toolCallId: 'call-456',
      toolName: 'read',
      content: [{ type: 'text', text: 'file contents here' }],
      details: { status: 'completed' },
      isError: false,
    });

    expect(events).toEqual([
      {
        event_type: 'tool_result',
        content: 'file contents here',
        event_meta: {
          tool_use_id: 'call-456',
          output: 'file contents here',
          tool_name: 'read',
          details: { status: 'completed' },
        },
      },
    ]);
  });

  it('unwraps outer gateway message envelopes', () => {
    const events = extractGatewayStructuredEvents({
      type: 'message',
      timestamp: '2026-04-18T00:39:39.942Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-789',
            name: 'exec',
            arguments: { command: 'pwd' },
          },
        ],
      },
    });

    expect(events[0]?.event_type).toBe('tool_call');
    expect(events[0]?.event_meta).toMatchObject({
      name: 'exec',
      args: { command: 'pwd' },
      id: 'call-789',
    });
  });

  it('extracts plain text from wrapped toolResult messages', () => {
    const text = extractTextFromGatewayMessage({
      message: {
        role: 'toolResult',
        content: [{ type: 'text', text: 'Plan updated.' }],
      },
    });

    expect(text).toBe('Plan updated.');
  });
});
