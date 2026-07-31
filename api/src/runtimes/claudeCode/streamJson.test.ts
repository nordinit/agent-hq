import * as fs from 'fs';
import * as path from 'path';
import {
  ClaudeStreamAccumulator,
  NdjsonDecoder,
  evaluateMcpReadiness,
  mcpToolName,
  parseClaudeStreamJson,
  MCP_STATUS_CONNECTED,
} from './streamJson';

/**
 * The capture fixture is real stdout from Claude Code CLI 2.1.220, trimmed but
 * structurally untouched. It deliberately contains the three shapes that break
 * naive parsers: two `system/init` events (pending then connected), two
 * `result` events, and a top-level `usage` that disagrees with `modelUsage`.
 */
const CAPTURE = fs.readFileSync(
  path.join(__dirname, '__fixtures__', 'stream-json.capture.jsonl'),
  'utf8',
);

const CAPTURE_SESSION_ID = '9278eeca-b7af-44f7-bc1f-2e6d4c16ee09';

describe('NdjsonDecoder', () => {
  it('reassembles events split across arbitrary chunk boundaries', () => {
    const decoder = new NdjsonDecoder();
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' });

    // Feed one byte at a time — the worst case for a line-buffered decoder.
    const collected = [];
    for (const char of `${line}\n`) {
      collected.push(...decoder.push(char));
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].session_id).toBe('abc');
  });

  it('emits nothing for a partial trailing line until flush()', () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push('{"type":"result"')).toHaveLength(0);
    expect(decoder.push(',"subtype":"success"}')).toHaveLength(0);
    const flushed = decoder.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].subtype).toBe('success');
  });

  it('skips malformed lines without dropping healthy neighbours', () => {
    const decoder = new NdjsonDecoder();
    const events = decoder.push(
      'not json at all\n{"type":"assistant"}\n<<< shell banner >>>\n{"type":"result"}\n',
    );

    expect(events.map((event) => event.type)).toEqual(['assistant', 'result']);
    expect(decoder.malformedLines).toHaveLength(2);
  });

  it('ignores blank lines and non-object JSON', () => {
    const decoder = new NdjsonDecoder();
    const events = decoder.push('\n\n[1,2,3]\n"a string"\n{"type":"result"}\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
  });
});

describe('ClaudeStreamAccumulator against a real CLI capture', () => {
  const accumulator = parseClaudeStreamJson(CAPTURE);

  it('captures session identity and model from the init event', () => {
    expect(accumulator.sessionId).toBe(CAPTURE_SESSION_ID);
    expect(accumulator.model).toBe('claude-haiku-4-5-20251001');
  });

  it('sees more than one init event', () => {
    // Guards the assumption that MCP status is resolved at first init.
    expect(accumulator.initCount).toBe(2);
  });

  it('reports MCP status from the LATEST init, not the first', () => {
    // The first init in this capture says "pending"; only the second says
    // "connected". Reading the first would make the readiness gate always fail.
    expect(accumulator.mcpServers).toEqual([
      { name: 'agent-hq__agent-42', status: MCP_STATUS_CONNECTED },
    ]);
  });

  it('treats the LAST result event as authoritative', () => {
    expect(accumulator.resultCount).toBe(2);
    expect(accumulator.terminalReason).toBe('completed');
    expect(accumulator.resultSubtype).toBe('success');
    expect(accumulator.isError).toBe(false);
    expect(accumulator.finalText).toContain('Here is the exact output');
    // ...and not the first result's text.
    expect(accumulator.finalText).not.toContain('The agent is now calling');
  });

  it('sums num_turns across every result segment', () => {
    expect(accumulator.totalTurns).toBe(6); // 5 + 1
  });

  it('reads cumulative usage from modelUsage, not the per-segment usage block', () => {
    // The last result's top-level usage is 10 in / 143 out. modelUsage is the
    // process-wide ledger: 620 in + 15845 cache-creation, 1576 out.
    // Cache-creation tokens are billed prompt tokens, so they count as input.
    expect(accumulator.usage).toEqual({
      inputTokens: 620 + 15845,
      outputTokens: 1576,
      cachedInputTokens: 168353,
    });
  });

  it('takes cost from the last result rather than summing segments', () => {
    // Segment costs were 0.0262109 then 0.0486388. modelUsage is cumulative, so
    // summing would double-count.
    expect(accumulator.costUsd).toBeCloseTo(0.0486388, 7);
  });

  it('exposes the per-model ledger for run metadata', () => {
    expect(Object.keys(accumulator.modelUsage ?? {})).toEqual([
      'claude-haiku-4-5-20251001',
    ]);
  });
});

describe('ClaudeStreamAccumulator terminal classification', () => {
  it('surfaces a max-turns exhaustion result', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm' }),
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        terminal_reason: 'max_turns',
        is_error: true,
        num_turns: 2,
        errors: ['Reached maximum number of turns (1)'],
        session_id: 's',
      }),
    ].join('\n');

    const accumulator = parseClaudeStreamJson(stream);
    expect(accumulator.resultSubtype).toBe('error_max_turns');
    expect(accumulator.terminalReason).toBe('max_turns');
    expect(accumulator.isError).toBe(true);
    expect(accumulator.errors).toEqual(['Reached maximum number of turns (1)']);
  });

  it('reports sawResult=false when the process died before any result', () => {
    const accumulator = parseClaudeStreamJson(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
    );
    expect(accumulator.sawResult).toBe(false);
    expect(accumulator.usage).toBeNull();
    expect(accumulator.costUsd).toBeNull();
    expect(accumulator.terminalReason).toBeNull();
  });

  it('falls back to assistant text when no result event arrived', () => {
    const stream = [
      JSON.stringify({
        type: 'assistant',
        session_id: 's',
        message: { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'partial answer' }] },
      }),
    ].join('\n');

    const accumulator = parseClaudeStreamJson(stream);
    // Thinking blocks must never leak into the recorded answer.
    expect(accumulator.finalText).toBe('partial answer');
  });

  it('captures the structured rate-limit signal', () => {
    const stream = JSON.stringify({
      type: 'rate_limit_event',
      session_id: 's',
      rate_limit_info: {
        status: 'rejected',
        resetsAt: 1785527400,
        rateLimitType: 'five_hour',
        overageStatus: 'rejected',
        overageDisabledReason: 'out_of_credits',
        isUsingOverage: false,
      },
    });

    const accumulator = parseClaudeStreamJson(stream);
    expect(accumulator.rateLimit).toEqual({
      status: 'rejected',
      resetsAt: 1785527400,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      overageDisabledReason: 'out_of_credits',
      isUsingOverage: false,
    });
  });
});

describe('observe() streaming behaviour', () => {
  it('exposes MCP status mid-run so the readiness gate can fire early', () => {
    const accumulator = new ClaudeStreamAccumulator();
    const decoder = new NdjsonDecoder();

    const statuses: string[] = [];
    for (const event of decoder.push(CAPTURE)) {
      accumulator.observe(event);
      const server = accumulator.mcpServers[0];
      if (server) statuses.push(server.status);
    }

    // The gate must be able to observe the pending -> connected transition
    // without waiting for process exit.
    expect(statuses[0]).toBe('pending');
    expect(statuses[statuses.length - 1]).toBe(MCP_STATUS_CONNECTED);
  });
});

describe('evaluateMcpReadiness', () => {
  const required = ['agent-hq__agent-42'];

  it('is ready when every required server is connected', () => {
    const verdict = evaluateMcpReadiness(
      [{ name: 'agent-hq__agent-42', status: 'connected' }],
      required,
    );
    expect(verdict).toEqual({ ready: true, pending: [], missing: [], failed: [] });
  });

  it('is not ready while a required server is still pending', () => {
    const verdict = evaluateMcpReadiness(
      [{ name: 'agent-hq__agent-42', status: 'pending' }],
      required,
    );
    expect(verdict.ready).toBe(false);
    expect(verdict.pending).toHaveLength(1);
  });

  it('reports a required server the CLI never mentioned', () => {
    const verdict = evaluateMcpReadiness([], required);
    expect(verdict.ready).toBe(false);
    expect(verdict.missing).toEqual(['agent-hq__agent-42']);
  });

  it('reports a server that settled on an unexpected status', () => {
    const verdict = evaluateMcpReadiness(
      [{ name: 'agent-hq__agent-42', status: 'failed' }],
      required,
    );
    expect(verdict.ready).toBe(false);
    expect(verdict.failed).toEqual([{ name: 'agent-hq__agent-42', status: 'failed' }]);
  });

  it('ignores servers that were not required', () => {
    const verdict = evaluateMcpReadiness(
      [
        { name: 'agent-hq__agent-42', status: 'connected' },
        { name: 'some-other-server', status: 'pending' },
      ],
      required,
    );
    expect(verdict.ready).toBe(true);
  });

  it('is trivially ready when nothing is required', () => {
    expect(evaluateMcpReadiness([], []).ready).toBe(true);
  });
});

describe('mcpToolName', () => {
  it('builds the fully-qualified CLI tool name', () => {
    expect(mcpToolName('agent-hq__agent-42', 'agent_hq_post_task_outcome')).toBe(
      'mcp__agent-hq__agent-42__agent_hq_post_task_outcome',
    );
  });
});
