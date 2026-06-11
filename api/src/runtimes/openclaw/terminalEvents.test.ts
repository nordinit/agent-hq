import {
  isRunCompletedFallbackMessage,
  resolveChatTerminalEvent,
} from '../OpenClawRuntime';

describe('OpenClaw terminal event parsing', () => {
  const sessionKey = 'session-123';
  const runId = 'run-abc';

  it('resolves native successful agent_end events', () => {
    const event = resolveChatTerminalEvent({
      sessionKey,
      message: {
        timestamp: 1_700_000_000_000,
        event: { type: 'agent_end', source: 'native' },
      },
    }, sessionKey, runId);

    expect(event).toEqual(expect.objectContaining({
      type: 'turnEnded',
      source: 'openclaw',
      success: true,
      reason: 'completed',
      sessionKey,
      runId,
      endedAt: '2023-11-14T22:13:20.000Z',
    }));
    expect(event?.metadata).toEqual(expect.objectContaining({
      openclaw_event_type: 'agent_end',
      source: 'native',
      aborted: false,
      timed_out: false,
    }));
  });

  it('resolves native failure events and serializes non-string errors', () => {
    const event = resolveChatTerminalEvent({
      sessionKey,
      message: {
        timestamp: '2026-01-01T00:00:00.000Z',
        event: {
          type: 'agent_end',
          error: { code: 'provider_error' },
          reason: 'model failed',
        },
      },
    }, sessionKey);

    expect(event).toEqual(expect.objectContaining({
      type: 'turnEnded',
      success: false,
      reason: 'error',
      error: JSON.stringify({ code: 'provider_error' }),
      endedAt: '2026-01-01T00:00:00.000Z',
    }));
    expect(event?.metadata).toEqual(expect.objectContaining({
      reason_detail: 'model failed',
      raw: expect.objectContaining({ error: { code: 'provider_error' } }),
    }));
  });

  it('resolves native aborted events', () => {
    const event = resolveChatTerminalEvent({
      sessionKey,
      message: {
        event: { type: 'agent_end', aborted: true, stopReason: 'cancelled by operator' },
      },
    }, sessionKey);

    expect(event).toEqual(expect.objectContaining({
      type: 'turnEnded',
      success: false,
      reason: 'aborted',
    }));
    expect(event?.metadata).toEqual(expect.objectContaining({
      aborted: true,
      reason_detail: 'cancelled by operator',
    }));
  });

  it('resolves native timed-out events', () => {
    const event = resolveChatTerminalEvent({
      sessionKey,
      message: {
        event: { type: 'agent_end', timedOut: true, reason: 'timeout waiting for model' },
      },
    }, sessionKey);

    expect(event).toEqual(expect.objectContaining({
      type: 'turnEnded',
      success: false,
      reason: 'timeout',
    }));
    expect(event?.metadata).toEqual(expect.objectContaining({
      timed_out: true,
      reason_detail: 'timeout waiting for model',
    }));
  });

  it('maps chat final, aborted, error, and timeout states', () => {
    expect(resolveChatTerminalEvent({ sessionKey, state: 'final' }, sessionKey)).toEqual(expect.objectContaining({
      type: 'runEnded',
      success: true,
      reason: 'completed',
      metadata: { terminal_state: 'final', payload_event: 'chat' },
    }));

    expect(resolveChatTerminalEvent({ sessionKey, state: 'aborted', reason: 'operator abort' }, sessionKey)).toEqual(expect.objectContaining({
      type: 'runEnded',
      success: false,
      reason: 'aborted',
      metadata: { terminal_state: 'aborted', payload_event: 'chat', reason_detail: 'operator abort' },
    }));

    expect(resolveChatTerminalEvent({ sessionKey, state: 'error', error: 'Gateway timeout' }, sessionKey)).toEqual(expect.objectContaining({
      type: 'runEnded',
      success: false,
      reason: 'timeout',
      error: 'Gateway timeout',
      metadata: { terminal_state: 'error', payload_event: 'chat' },
    }));

    expect(resolveChatTerminalEvent({ sessionKey, state: 'error', error: 'Gateway failed' }, sessionKey)).toEqual(expect.objectContaining({
      type: 'runEnded',
      success: false,
      reason: 'error',
      error: 'Gateway failed',
    }));
  });

  it('resolves the exact Run Completed fallback transcript message', () => {
    expect(isRunCompletedFallbackMessage(' Run Completed\r\n')).toBe(true);
    expect(isRunCompletedFallbackMessage('Run completed')).toBe(false);
    expect(isRunCompletedFallbackMessage({ content: [{ type: 'text', text: 'Run Completed' }] })).toBe(true);
    expect(isRunCompletedFallbackMessage({ content: [
      { type: 'text', text: 'Run Completed' },
      { type: 'text', text: 'extra' },
    ] })).toBe(false);

    const event = resolveChatTerminalEvent({
      sessionKey,
      message: { text: 'Run Completed', timestamp: '2026-02-03T04:05:06.000Z' },
    }, sessionKey, runId);

    expect(event).toEqual(expect.objectContaining({
      type: 'runEnded',
      source: 'openclaw',
      success: true,
      reason: 'completed',
      sessionKey,
      runId,
      endedAt: '2026-02-03T04:05:06.000Z',
      metadata: {
        terminal_state: 'Run Completed',
        payload_event: 'chat',
        fallback: 'exact_transcript_message',
      },
    }));
  });

  it('ignores terminal events for other sessions or unsupported payloads', () => {
    expect(resolveChatTerminalEvent({ sessionKey: 'other', state: 'final' }, sessionKey)).toBeNull();
    expect(resolveChatTerminalEvent({ state: 'final' }, sessionKey)).toBeNull();
    expect(resolveChatTerminalEvent({ sessionKey, state: 'running' }, sessionKey)).toBeNull();
    expect(resolveChatTerminalEvent({ sessionKey, message: { event: { type: 'tool_call' } } }, sessionKey)).toBeNull();
  });
});
