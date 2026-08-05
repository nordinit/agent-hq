import fs from 'fs';
import path from 'path';
import { CodexJsonlDecoder, CodexStreamAccumulator } from './streamJson';

const fixture = fs.readFileSync(
  path.join(__dirname, '__fixtures__', 'exec-json.capture.jsonl'),
  'utf8',
);

describe('Codex JSONL decoding', () => {
  it('survives arbitrary chunk boundaries and folds native run state', () => {
    const decoder = new CodexJsonlDecoder();
    const accumulator = new CodexStreamAccumulator();
    for (let offset = 0; offset < fixture.length; offset += 17) {
      for (const event of decoder.push(fixture.slice(offset, offset + 17))) {
        accumulator.observe(event);
      }
    }
    for (const event of decoder.flush()) accumulator.observe(event);

    expect(decoder.malformedLines).toEqual([]);
    expect(accumulator.threadId).toBe('019c1234-1234-7000-8000-123456789abc');
    expect(accumulator.sawTurnCompleted).toBe(true);
    expect(accumulator.finalText).toBe('Implemented and verified.');
    expect(accumulator.usage).toEqual({
      inputTokens: 1234,
      cachedInputTokens: 234,
      outputTokens: 87,
    });
    expect(accumulator.mcpServersUsed).toEqual(['agent-hq__agent-42']);
  });

  it('records malformed lines without discarding later valid events', () => {
    const decoder = new CodexJsonlDecoder();
    expect(decoder.push('not-json\n{"type":"turn.started"}\n')).toHaveLength(1);
    expect(decoder.malformedLines).toEqual(['not-json']);
  });
});
