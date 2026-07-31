import { classifyClaudeRun, retryNotBeforeFromRateLimit, type ClassifyClaudeRunInput } from './errors';
import { parseClaudeStreamJson, type ClaudeRateLimitInfo } from './streamJson';
import { CANONICAL_TIMESTAMP_PATTERN } from '../../lib/timestamps';

// ── Builders ─────────────────────────────────────────────────────────────────

type Event = Record<string, unknown>;

function stream(...events: Event[]): ReturnType<typeof parseClaudeStreamJson> {
  return parseClaudeStreamJson(events.map((event) => `${JSON.stringify(event)}\n`).join(''));
}

const INIT: Event = {
  type: 'system',
  subtype: 'init',
  session_id: 's',
  model: 'claude-opus-4-5-20260101',
  claude_code_version: '2.1.220',
  mcp_servers: [{ name: 'agent-hq__agent-42', status: 'connected' }],
};

const SUCCESS_RESULT: Event = {
  type: 'result',
  subtype: 'success',
  terminal_reason: 'completed',
  is_error: false,
  num_turns: 3,
  session_id: 's',
  result: 'Done. Renamed the helper and updated its callers.',
};

function errorResult(overrides: Event = {}): Event {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    terminal_reason: 'error',
    is_error: true,
    num_turns: 1,
    session_id: 's',
    ...overrides,
  };
}

function rateLimitEvent(info: Partial<ClaudeRateLimitInfo>): Event {
  return { type: 'rate_limit_event', session_id: 's', rate_limit_info: info };
}

/** A healthy run: exit 0, one success result, MCP up. */
function input(overrides: Partial<ClassifyClaudeRunInput> = {}): ClassifyClaudeRunInput {
  return {
    accumulator: stream(INIT, SUCCESS_RESULT),
    exitCode: 0,
    signal: null,
    spawnError: null,
    timedOut: false,
    aborted: false,
    mcpReady: true,
    stderr: '',
    timeoutSeconds: 1800,
    ...overrides,
  };
}

/** A failed run carrying `errors`, which is where the CLI puts its own messages. */
function failedWith(errors: string[], resultOverrides: Event = {}): ClassifyClaudeRunInput {
  return input({
    accumulator: stream(INIT, errorResult({ errors, ...resultOverrides })),
    exitCode: 1,
  });
}

// ── retryNotBeforeFromRateLimit ──────────────────────────────────────────────

describe('retryNotBeforeFromRateLimit', () => {
  const full: ClaudeRateLimitInfo = {
    status: 'rejected',
    resetsAt: 1785527400,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'out_of_credits',
    isUsingOverage: false,
  };

  it('reads resetsAt as EPOCH SECONDS, not milliseconds', () => {
    // 1785527400s = 2026-07-31T19:50:00Z. Treating it as ms would yield 1970.
    expect(retryNotBeforeFromRateLimit(full)).toBe('2026-07-31 19:50:00');
  });

  it('emits a canonical DB timestamp, never an ISO string with T/Z', () => {
    const value = retryNotBeforeFromRateLimit(full);
    expect(value).toMatch(CANONICAL_TIMESTAMP_PATTERN);
    expect(value).not.toContain('T');
    expect(value).not.toContain('Z');
  });

  it('returns null for a null info', () => {
    expect(retryNotBeforeFromRateLimit(null)).toBeNull();
  });

  it('returns null when resetsAt is absent', () => {
    expect(retryNotBeforeFromRateLimit({ ...full, resetsAt: null })).toBeNull();
  });

  it('returns null when resetsAt is non-finite', () => {
    expect(retryNotBeforeFromRateLimit({ ...full, resetsAt: Number.NaN })).toBeNull();
    expect(retryNotBeforeFromRateLimit({ ...full, resetsAt: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('handles the epoch itself rather than treating 0 as missing', () => {
    expect(retryNotBeforeFromRateLimit({ ...full, resetsAt: 0 })).toBe('1970-01-01 00:00:00');
  });
});

// ── Precedence ───────────────────────────────────────────────────────────────

describe('classifyClaudeRun precedence', () => {
  it('rule 1: a spawn error outranks every other signal', () => {
    const verdict = classifyClaudeRun(
      input({
        spawnError: new Error('spawn claude ENOENT'),
        aborted: true,
        timedOut: true,
        mcpReady: false,
        exitCode: 1,
      }),
    );
    expect(verdict.code).toBe('spawn_failed');
    expect(verdict.family).toBe('infra');
    expect(verdict.summary).toContain('ENOENT');
  });

  it('rule 2: an abort beats the timeout it raced with', () => {
    const verdict = classifyClaudeRun(input({ aborted: true, timedOut: true, exitCode: null, signal: 'SIGTERM' }));
    expect(verdict.code).toBe('aborted');
    // An operator abort is not a failure of the work.
    expect(verdict.family).toBe('none');
  });

  it('rule 2: an abort beats a dead MCP server', () => {
    expect(classifyClaudeRun(input({ aborted: true, mcpReady: false })).code).toBe('aborted');
  });

  it('rule 3: a timeout is a runtime failure and names the limit', () => {
    const verdict = classifyClaudeRun(
      input({ timedOut: true, timeoutSeconds: 900, exitCode: null, signal: 'SIGKILL' }),
    );
    expect(verdict).toMatchObject({ code: 'timeout', family: 'runtime' });
    expect(verdict.summary).toContain('900s');
    expect(verdict.summary).toContain('SIGKILL');
  });

  it('rule 3: a timeout beats a dead MCP server', () => {
    expect(classifyClaudeRun(input({ timedOut: true, mcpReady: false })).code).toBe('timeout');
  });

  it('rule 4: exit 0 + subtype success + mcpReady=false is mcp_not_ready', () => {
    // THE silent-degradation case. Verified against CLI 2.1.220: a failed MCP
    // server still exits 0 with terminal_reason 'completed', so without this gate
    // an agent that could not post an outcome looks like a clean success.
    const verdict = classifyClaudeRun(input({ mcpReady: false }));
    expect(verdict.code).toBe('mcp_not_ready');
    expect(verdict.family).toBe('infra');
    expect(verdict.summary).toMatch(/Agent HQ lifecycle tools/);
    expect(verdict.summary).toMatch(/reports this run as a success/);
  });

  it('rule 4: a dead MCP server beats an auth error in the transcript', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(INIT, errorResult({ errors: ['Invalid API key'] })),
        exitCode: 1,
        mcpReady: false,
      }),
    );
    expect(verdict.code).toBe('mcp_not_ready');
  });

  it('rule 5: auth beats a quota signal present in the same text', () => {
    const verdict = classifyClaudeRun(
      failedWith(['Invalid API key', 'rate limit exceeded on retry']),
    );
    expect(verdict.code).toBe('claude_auth_required');
  });

  it('rule 6: quota beats a transient upstream signal in the same text', () => {
    const verdict = classifyClaudeRun(failedWith(['429 too many requests', 'Overloaded']));
    expect(verdict.code).toBe('provider_quota');
  });

  it('rule 6: quota beats max-turns exhaustion', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(
          INIT,
          rateLimitEvent({ status: 'rejected', resetsAt: 1785527400, rateLimitType: 'five_hour' }),
          errorResult({ subtype: 'error_max_turns', terminal_reason: 'max_turns', num_turns: 40 }),
        ),
        exitCode: 1,
      }),
    );
    expect(verdict.code).toBe('provider_quota');
  });

  it('rule 9: max-turns beats the non-zero exit it produced', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(
          INIT,
          errorResult({ subtype: 'error_max_turns', terminal_reason: 'max_turns', num_turns: 12 }),
        ),
        exitCode: 1,
      }),
    );
    expect(verdict.code).toBe('max_turns_exhausted');
  });

  it('rule 12: a missing result beats the non-zero exit', () => {
    const verdict = classifyClaudeRun(input({ accumulator: stream(INIT), exitCode: 137 }));
    expect(verdict.code).toBe('no_result');
  });
});

// ── Success ──────────────────────────────────────────────────────────────────

describe('classifyClaudeRun success path', () => {
  it('reports a healthy run as family none with the success code pairing', () => {
    const verdict = classifyClaudeRun(input());
    // The (none, no_result) pair is produced by exactly one path: success.
    expect(verdict).toMatchObject({ family: 'none', code: 'no_result' });
    expect(verdict.summary).toContain('completed');
  });

  it('distinguishes success from an abort by code, both being family none', () => {
    const ok = classifyClaudeRun(input());
    const stopped = classifyClaudeRun(input({ aborted: true }));
    expect(ok.family).toBe('none');
    expect(stopped.family).toBe('none');
    expect(ok.code).not.toBe(stopped.code);
  });

  it('does not turn an agent report that discusses a 429 into a quota failure', () => {
    // The combined text includes the agent's own answer. A task about retry
    // handling must not be thrown away as infra.
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(INIT, {
          ...SUCCESS_RESULT,
          result: 'Added backoff for HTTP 429 rate limit responses and quota errors.',
        }),
      }),
    );
    expect(verdict.family).toBe('none');
  });

  it('does not turn an agent report that discusses auth errors into an infra failure', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(INIT, {
          ...SUCCESS_RESULT,
          result: 'The 401 unauthorized path now surfaces an authentication_error to the caller.',
        }),
      }),
    );
    expect(verdict.family).toBe('none');
  });

  it('treats an allowed_warning rate-limit event as still allowed', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(
          INIT,
          rateLimitEvent({ status: 'allowed_warning', resetsAt: 1785527400, rateLimitType: 'five_hour' }),
          SUCCESS_RESULT,
        ),
      }),
    );
    expect(verdict.family).toBe('none');
  });

  it('keeps a run that recovered from a rejection and finished cleanly as a success', () => {
    // `rateLimit` is the LATEST event, not a verdict on the run: a run that went
    // on to emit a clean success result plainly was not blocked by it.
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(
          INIT,
          rateLimitEvent({ status: 'rejected', resetsAt: 1785527400 }),
          SUCCESS_RESULT,
        ),
      }),
    );
    expect(verdict.family).toBe('none');
  });
});

// ── Infra families ───────────────────────────────────────────────────────────

describe('classifyClaudeRun infra classification', () => {
  it('detects auth from the CLI login prompt', () => {
    const verdict = classifyClaudeRun(failedWith(['Invalid API key · Please run /login']));
    expect(verdict).toMatchObject({ code: 'claude_auth_required', family: 'infra' });
    expect(verdict.summary).toMatch(/not authenticated/i);
  });

  it('detects auth from the structured api_error_status', () => {
    const verdict = classifyClaudeRun(
      failedWith(['request failed'], { api_error_status: '401' }),
    );
    expect(verdict.code).toBe('claude_auth_required');
  });

  it('detects auth from stderr when the result carried nothing', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(INIT, errorResult()),
        exitCode: 1,
        stderr: 'OAuth token has expired; re-authenticate to continue.',
      }),
    );
    expect(verdict.code).toBe('claude_auth_required');
  });

  it('detects quota from the structured rate-limit event and attaches the reset time', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(
          INIT,
          rateLimitEvent({
            status: 'rejected',
            resetsAt: 1785527400,
            rateLimitType: 'five_hour',
            overageStatus: 'rejected',
            overageDisabledReason: 'out_of_credits',
          }),
          errorResult({ errors: ['Claude usage limit reached'] }),
        ),
        exitCode: 1,
      }),
    );
    expect(verdict).toMatchObject({ code: 'provider_quota', family: 'infra' });
    expect(verdict.retryNotBefore).toBe('2026-07-31 19:50:00');
    expect(verdict.summary).toContain('five_hour');
  });

  it('detects quota from api_error_status 429 with no rate-limit event', () => {
    const verdict = classifyClaudeRun(failedWith(['upstream said no'], { api_error_status: '429' }));
    expect(verdict.code).toBe('provider_quota');
    expect(verdict.retryNotBefore).toBeNull();
  });

  it('falls back to the shared provider-limit text detector', () => {
    const verdict = classifyClaudeRun(failedWith(['Request failed: rate_limit_error, too many requests']));
    expect(verdict.code).toBe('provider_quota');
    expect(verdict.summary).toMatch(/too many requests/i);
  });

  it('treats an exhausted credit balance as quota even though it says neither quota nor 429', () => {
    const verdict = classifyClaudeRun(
      failedWith(['Your credit balance is too low to access the Anthropic API']),
    );
    expect(verdict.code).toBe('provider_quota');
  });

  it('detects a transient upstream overload', () => {
    const verdict = classifyClaudeRun(failedWith(['API Error: Overloaded']));
    expect(verdict).toMatchObject({ code: 'claude_transient_upstream', family: 'infra' });
  });

  it('detects a transient upstream failure from a 5xx api_error_status', () => {
    const verdict = classifyClaudeRun(failedWith(['request failed'], { api_error_status: '529' }));
    expect(verdict.code).toBe('claude_transient_upstream');
  });

  it('detects a transient upstream failure from a socket-level error', () => {
    const verdict = classifyClaudeRun(
      input({ accumulator: stream(INIT, errorResult()), exitCode: 1, stderr: 'Error: ECONNRESET' }),
    );
    expect(verdict.code).toBe('claude_transient_upstream');
  });

  it('omits retryNotBefore on a transient failure with no rate-limit event', () => {
    const verdict = classifyClaudeRun(failedWith(['internal server error']));
    expect(verdict.code).toBe('claude_transient_upstream');
    expect(verdict.retryNotBefore).toBeUndefined();
  });

  it('carries the reset time onto a transient failure when the CLI told us one', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(
          INIT,
          rateLimitEvent({ status: 'allowed', resetsAt: 1785527400 }),
          errorResult({ errors: ['service unavailable'] }),
        ),
        exitCode: 1,
      }),
    );
    expect(verdict.code).toBe('claude_transient_upstream');
    expect(verdict.retryNotBefore).toBe('2026-07-31 19:50:00');
  });

  it('detects an unavailable model', () => {
    const verdict = classifyClaudeRun(
      failedWith(['not_found_error: model claude-nope-1 does not exist']),
    );
    expect(verdict).toMatchObject({ code: 'model_not_found', family: 'infra' });
  });

  it('does not blame the model for a 404 the agent hit in its own work', () => {
    const verdict = classifyClaudeRun(
      failedWith(['GET /widgets/9 returned 404'], { api_error_status: '404' }),
    );
    expect(verdict.family).toBe('runtime');
    expect(verdict.code).toBe('nonzero_exit');
  });
});

// ── Runtime families ─────────────────────────────────────────────────────────

describe('classifyClaudeRun runtime classification', () => {
  it('detects max turns from the result subtype', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(
          INIT,
          errorResult({ subtype: 'error_max_turns', terminal_reason: 'max_turns', num_turns: 30 }),
        ),
        exitCode: 1,
      }),
    );
    expect(verdict).toMatchObject({ code: 'max_turns_exhausted', family: 'runtime' });
    expect(verdict.summary).toContain('30 turns');
  });

  it('detects max turns from terminal_reason even on a clean exit 0', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(INIT, {
          ...SUCCESS_RESULT,
          terminal_reason: 'max_turns',
          num_turns: 25,
        }),
      }),
    );
    expect(verdict.code).toBe('max_turns_exhausted');
  });

  it('detects an exhausted cost budget from the result subtype', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(
          INIT,
          errorResult({ subtype: 'error_max_budget', total_cost_usd: 5.25 }),
        ),
        exitCode: 1,
      }),
    );
    expect(verdict).toMatchObject({ code: 'max_budget_exhausted', family: 'runtime' });
    expect(verdict.summary).toContain('5.2500');
  });

  it('detects an exhausted cost budget from the CLI message', () => {
    const verdict = classifyClaudeRun(failedWith(['Max budget of $2.00 exceeded']));
    expect(verdict.code).toBe('max_budget_exhausted');
  });

  it('detects a refusal', () => {
    const verdict = classifyClaudeRun(
      failedWith(['stop_reason: refusal — the request was declined']),
    );
    expect(verdict).toMatchObject({ code: 'claude_refusal', family: 'runtime' });
  });

  it('detects a refusal from the result subtype', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(INIT, errorResult({ subtype: 'error_refusal' })),
        exitCode: 1,
      }),
    );
    expect(verdict.code).toBe('claude_refusal');
  });

  it('reports no_result when the process died before emitting one', () => {
    const verdict = classifyClaudeRun(
      input({ accumulator: stream(INIT), exitCode: null, signal: 'SIGKILL' }),
    );
    expect(verdict).toMatchObject({ code: 'no_result', family: 'runtime' });
    expect(verdict.summary).toContain('SIGKILL');
  });

  it('reports no_result even when the process exited 0 without a result event', () => {
    // Exit 0 with no result is not a success — the CLI always emits one.
    const verdict = classifyClaudeRun(input({ accumulator: stream(INIT) }));
    expect(verdict).toMatchObject({ code: 'no_result', family: 'runtime' });
  });

  it('falls back to nonzero_exit for an unrecognized failure', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(INIT, errorResult({ result: 'tsc reported 3 type errors' })),
        exitCode: 2,
      }),
    );
    expect(verdict).toMatchObject({ code: 'nonzero_exit', family: 'runtime' });
    expect(verdict.summary).toContain('exited 2');
    expect(verdict.summary).toContain('tsc reported 3 type errors');
  });

  it('fails a run whose result is flagged is_error even on exit 0', () => {
    const verdict = classifyClaudeRun(
      input({ accumulator: stream(INIT, errorResult({ errors: ['tool execution failed'] })) }),
    );
    expect(verdict).toMatchObject({ code: 'nonzero_exit', family: 'runtime' });
    expect(verdict.summary).toMatch(/exited 0 but reported a failed result/);
  });

  it('reports a signal kill that produced no exit code', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(INIT, errorResult({ result: 'partial work' })),
        exitCode: null,
        signal: 'SIGTERM',
      }),
    );
    expect(verdict.code).toBe('nonzero_exit');
    expect(verdict.summary).toContain('SIGTERM');
  });
});

// ── Shape invariants ─────────────────────────────────────────────────────────

describe('classifyClaudeRun output shape', () => {
  it('keeps the summary to a single clipped line even for noisy stderr', () => {
    const verdict = classifyClaudeRun(
      input({
        accumulator: stream(INIT, errorResult()),
        exitCode: 1,
        stderr: `line one\nline two\n${'x'.repeat(4000)}`,
      }),
    );
    expect(verdict.summary).not.toContain('\n');
    expect(verdict.summary.length).toBeLessThan(400);
  });

  it('never reports family none for a run that shows failure evidence', () => {
    const failures = [
      classifyClaudeRun(input({ exitCode: 1, accumulator: stream(INIT, errorResult()) })),
      classifyClaudeRun(input({ accumulator: stream(INIT) })),
      classifyClaudeRun(input({ mcpReady: false })),
      classifyClaudeRun(input({ timedOut: true })),
      classifyClaudeRun(input({ spawnError: new Error('boom') })),
    ];
    for (const verdict of failures) {
      expect(verdict.family).not.toBe('none');
    }
  });
});
