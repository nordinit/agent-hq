import { decodeCodexJsonEvent } from './transcript';

describe('decodeCodexJsonEvent', () => {
  it('turns command lifecycle events into correlated call/result rows', () => {
    expect(decodeCodexJsonEvent({
      type: 'item.started',
      item: { id: 'item_0', type: 'command_execution', command: 'pwd' },
    })).toEqual([expect.objectContaining({
      kind: 'tool_call',
      toolName: 'shell',
      toolUseId: 'item_0',
    })]);
    expect(decodeCodexJsonEvent({
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'command_execution',
        aggregated_output: '/repo\n',
        exit_code: 0,
        status: 'completed',
      },
    })).toEqual([expect.objectContaining({
      kind: 'tool_result',
      role: 'tool',
      content: '/repo\n',
      toolUseId: 'item_0',
      isError: false,
    })]);
  });

  it('keeps reasoning distinct from the final assistant answer', () => {
    expect(decodeCodexJsonEvent({
      type: 'item.completed',
      item: { id: 'r', type: 'reasoning', text: 'Inspect first.' },
    })[0].kind).toBe('thought');
    expect(decodeCodexJsonEvent({
      type: 'item.completed',
      item: { id: 'a', type: 'agent_message', text: 'Done.' },
    })[0]).toMatchObject({ kind: 'text', role: 'assistant', content: 'Done.' });
  });
});
