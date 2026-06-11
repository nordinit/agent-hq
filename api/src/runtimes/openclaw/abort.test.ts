import { jest } from '@jest/globals';
import {
  abortChatRunBySessionKey,
  isMissingAbortTarget,
  parseAbortJson,
  type OpenClawAbortRunner,
} from './abort';

jest.mock('./gatewayClient', () => ({
  getGatewayAuthToken: jest.fn(() => null),
}));

function runnerResult(overrides: Partial<ReturnType<OpenClawAbortRunner>>): ReturnType<OpenClawAbortRunner> {
  return {
    pid: 123,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    ...overrides,
  } as ReturnType<OpenClawAbortRunner>;
}

describe('openclaw abort helpers', () => {
  it('parses abort JSON safely', () => {
    expect(parseAbortJson('{"ok":true}')).toEqual({ ok: true });
    expect(parseAbortJson('not-json')).toBeNull();
  });

  it('detects missing abort targets from canonical session/run signals', () => {
    expect(isMissingAbortTarget('', 'session not found', null)).toBe(true);
    expect(isMissingAbortTarget('', '', { error: 'unknown run' })).toBe(true);
    expect(isMissingAbortTarget('', 'gateway unavailable', null)).toBe(false);
  });

  it('returns succeeded for a successful gateway abort', () => {
    const runner = jest.fn<OpenClawAbortRunner>(() => runnerResult({ stdout: '{"ok":true}' }));

    const result = abortChatRunBySessionKey('run:123', 'manual stop', runner);

    expect(result.status).toBe('succeeded');
    expect(result.ok).toBe(true);
    expect(result.response).toEqual({ ok: true });
    expect(runner).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['gateway', 'call', 'chat.abort']), expect.objectContaining({ timeout: 15000 }));
  });

  it('maps missing abort target exits to already_gone', () => {
    const runner = jest.fn<OpenClawAbortRunner>(() => runnerResult({ status: 1, stderr: 'session not found' }));

    const result = abortChatRunBySessionKey('run:missing', undefined, runner);

    expect(result.status).toBe('already_gone');
    expect(result.ok).toBe(true);
    expect(result.error).toBe('session not found');
  });

  it('maps spawn timeout errors to timed_out and other errors to failed', () => {
    const timedOut = abortChatRunBySessionKey('run:slow', undefined, jest.fn<OpenClawAbortRunner>(() => runnerResult({
      error: new Error('spawnSync openclaw ETIMEDOUT'),
    })));
    const failed = abortChatRunBySessionKey('run:fail', undefined, jest.fn<OpenClawAbortRunner>(() => runnerResult({
      error: new Error('spawnSync openclaw failed'),
    })));

    expect(timedOut.status).toBe('timed_out');
    expect(timedOut.ok).toBe(false);
    expect(failed.status).toBe('failed');
    expect(failed.ok).toBe(false);
  });
});
