import { classifyCodexRun } from './errors';
import { CodexStreamAccumulator } from './streamJson';

function accumulator(...events: Array<Record<string, unknown>>): CodexStreamAccumulator {
  const value = new CodexStreamAccumulator();
  for (const event of events) value.observe(event);
  return value;
}

describe('classifyCodexRun', () => {
  const base = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    stderr: '',
    malformedLineCount: 0,
    timeoutSeconds: 900,
  } as const;

  it('requires turn.completed for success', () => {
    expect(classifyCodexRun({
      ...base,
      accumulator: accumulator({ type: 'turn.completed', usage: {} }),
    })).toMatchObject({ code: 'success', family: 'none' });
    expect(classifyCodexRun({
      ...base,
      accumulator: accumulator({ type: 'thread.started', thread_id: 'x' }),
    })).toMatchObject({ code: 'no_turn_completion', family: 'runtime' });
  });

  it('separates auth, quota, sandbox, timeout, and operator abort', () => {
    expect(classifyCodexRun({ ...base, exitCode: 1, stderr: 'Not logged in; run codex login', accumulator: accumulator() }).code).toBe('codex_auth_required');
    expect(classifyCodexRun({ ...base, exitCode: 1, stderr: 'HTTP 429 rate limit exceeded', accumulator: accumulator() }).code).toBe('provider_quota');
    expect(classifyCodexRun({ ...base, exitCode: 1, stderr: 'sandbox violation: operation not permitted', accumulator: accumulator() }).code).toBe('sandbox_denied');
    expect(classifyCodexRun({ ...base, timedOut: true, accumulator: accumulator() }).code).toBe('timeout');
    expect(classifyCodexRun({ ...base, timedOut: true, aborted: true, accumulator: accumulator() })).toMatchObject({ code: 'aborted', family: 'none' });
  });
});
