import {
  decodeAnthropicContentBlocks,
  renderToolPayload,
  RUNTIME_TRANSCRIPT_EVENT_KINDS,
} from './events';

describe('decodeAnthropicContentBlocks', () => {
  it('decodes plain text', () => {
    expect(decodeAnthropicContentBlocks([{ type: 'text', text: 'hello' }], 'assistant')).toEqual([
      { kind: 'text', role: 'assistant', content: 'hello' },
    ]);
  });

  it('accepts a bare string content', () => {
    expect(decodeAnthropicContentBlocks('hi there', 'user')).toEqual([
      { kind: 'text', role: 'user', content: 'hi there' },
    ]);
  });

  it('keeps thinking separate from text and attributes it to the assistant', () => {
    const events = decodeAnthropicContentBlocks(
      [
        { type: 'thinking', thinking: 'internal reasoning' },
        { type: 'text', text: 'the answer' },
      ],
      'assistant',
    );

    // Reasoning must never be indistinguishable from the answer.
    expect(events.map((e) => e.kind)).toEqual(['thought', 'text']);
    expect(events[0].content).toBe('internal reasoning');
  });

  it('decodes tool_use into a tool_call carrying its input', () => {
    const events = decodeAnthropicContentBlocks(
      [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
      'assistant',
    );

    expect(events).toEqual([
      {
        kind: 'tool_call',
        role: 'assistant',
        content: 'Bash',
        toolName: 'Bash',
        toolUseId: 'toolu_1',
        meta: { tool_name: 'Bash', tool_input: { command: 'ls' } },
      },
    ]);
  });

  it('decodes tool_result from a USER message and re-roles it as tool', () => {
    // This is the whole reason the decoder exists. In real Claude Code output
    // tool results arrive on `type: 'user'` rows; both existing readers filter to
    // text blocks first and discard them (82 of 88 user rows in a sampled live
    // session). Regressing this silently empties tool output from transcripts.
    const events = decodeAnthropicContentBlocks(
      [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello\n', is_error: false }],
      'user',
    );

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('tool_result');
    expect(events[0].role).toBe('tool');
    expect(events[0].content).toBe('hello\n');
    expect(events[0].toolUseId).toBe('toolu_1');
  });

  it('marks a failed tool_result', () => {
    const [event] = decodeAnthropicContentBlocks(
      [{ type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true }],
      'user',
    );
    expect(event.isError).toBe(true);
    expect(event.meta).toEqual({ tool_use_id: 't', is_error: true });
  });

  it('flattens a block-array tool_result rather than storing [object Object]', () => {
    const [event] = decodeAnthropicContentBlocks(
      [
        {
          type: 'tool_result',
          tool_use_id: 't',
          content: [
            { type: 'text', text: 'line one' },
            { type: 'text', text: 'line two' },
          ],
        },
      ],
      'user',
    );
    expect(event.content).toBe('line one\nline two');
  });

  it('drops empty text but keeps an empty tool_result', () => {
    const events = decodeAnthropicContentBlocks(
      [
        { type: 'text', text: '   ' },
        { type: 'tool_result', tool_use_id: 't', content: '' },
      ],
      'user',
    );
    // A tool that legitimately returned nothing is information; blank assistant
    // text is not.
    expect(events.map((e) => e.kind)).toEqual(['tool_result']);
  });

  it('skips unknown block types instead of dumping raw JSON', () => {
    const events = decodeAnthropicContentBlocks(
      [{ type: 'some_future_block', payload: { a: 1 } }, { type: 'text', text: 'kept' }],
      'assistant',
    );
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe('kept');
  });

  it('is empty for malformed input rather than throwing', () => {
    expect(decodeAnthropicContentBlocks(null, 'assistant')).toEqual([]);
    expect(decodeAnthropicContentBlocks(undefined, 'assistant')).toEqual([]);
    expect(decodeAnthropicContentBlocks(42, 'assistant')).toEqual([]);
    expect(decodeAnthropicContentBlocks([null, 'x', 7], 'assistant')).toEqual([]);
  });

  it('preserves ordering across mixed blocks', () => {
    const events = decodeAnthropicContentBlocks(
      [
        { type: 'thinking', thinking: 'a' },
        { type: 'text', text: 'b' },
        { type: 'tool_use', id: 'i', name: 'T', input: {} },
      ],
      'assistant',
    );
    expect(events.map((e) => e.kind)).toEqual(['thought', 'text', 'tool_call']);
  });
});

describe('renderToolPayload', () => {
  it.each([
    ['string', 'plain', 'plain'],
    ['null', null, ''],
    ['undefined', undefined, ''],
  ])('renders %s', (_label, input, expected) => {
    expect(renderToolPayload(input)).toBe(expected);
  });

  it('serializes an object', () => {
    expect(renderToolPayload({ ok: true })).toBe('{"ok":true}');
  });

  it('survives a circular structure', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(renderToolPayload(circular)).toBe('');
  });
});

describe('RUNTIME_TRANSCRIPT_EVENT_KINDS', () => {
  it('includes turn_end', () => {
    // Three in-repo lists disagree about whether turn_end is a legal event_type,
    // yet three code paths write it to production rows. It is legal.
    expect(RUNTIME_TRANSCRIPT_EVENT_KINDS).toContain('turn_end');
  });
});
