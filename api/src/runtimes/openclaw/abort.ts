import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'child_process';
import { OPENCLAW_BIN, OPENCLAW_PATH } from '../../config';
import { getGatewayAuthToken } from './gatewayClient';

export type OpenClawAbortRunner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export type AbortChatRunStatus = 'succeeded' | 'already_gone' | 'timed_out' | 'failed';

export interface AbortChatRunResult {
  attempted: boolean;
  ok: boolean;
  status: AbortChatRunStatus;
  sessionKey: string;
  stopReason?: string | null;
  stdout: string;
  stderr: string;
  response: unknown;
  error?: string;
}

function makeAbortSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: OPENCLAW_PATH,
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
  };
}

export function parseAbortJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectAbortText(stdout: string, stderr: string, response: unknown, error?: string): string {
  const responseText =
    typeof response === 'string'
      ? response
      : response && typeof response === 'object'
        ? JSON.stringify(response)
        : '';
  return [stdout, stderr, responseText, error ?? '']
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

export function isMissingAbortTarget(stdout: string, stderr: string, response: unknown, error?: string): boolean {
  const haystack = collectAbortText(stdout, stderr, response, error);
  if (!haystack) return false;
  const missingSignals = [
    'session not found', 'session missing', 'unknown session', 'no session',
    'run not found', 'unknown run', 'no active run', 'not running',
    'no live session', 'abort target', 'not found', 'missing',
  ];
  const hasTargetNoun =
    haystack.includes('session') || haystack.includes('run') || haystack.includes('target');
  return hasTargetNoun && missingSignals.some(signal => haystack.includes(signal));
}

/**
 * abortChatRunBySessionKey — low-level OpenClaw gateway abort helper.
 *
 * Status compatibility is intentionally stable for stop/close callers:
 * succeeded, already_gone, timed_out, failed.
 */
export function abortChatRunBySessionKey(
  sessionKey: string,
  stopReason?: string,
  runner: OpenClawAbortRunner = spawnSync,
): AbortChatRunResult {
  const args = [
    'gateway', 'call', 'chat.abort',
    '--json',
    '--timeout', '10000',
    '--params', JSON.stringify({ sessionKey }),
  ];

  const gatewayAuthToken = getGatewayAuthToken();
  if (gatewayAuthToken) {
    args.push('--token', gatewayAuthToken);
  }

  const result = runner(OPENCLAW_BIN, args, {
    encoding: 'utf-8',
    timeout: 15000,
    env: makeAbortSpawnEnv(),
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const response = parseAbortJson(stdout);

  if (result.error) {
    const timedOut = result.error.message.includes('ETIMEDOUT');
    return {
      attempted: true,
      ok: false,
      status: timedOut ? 'timed_out' : 'failed',
      sessionKey,
      stopReason,
      stdout,
      stderr,
      response,
      error: result.error.message,
    };
  }

  if (result.status !== 0) {
    const error = stderr.trim() || `openclaw exited with code ${result.status}`;
    const missingAbortTarget = isMissingAbortTarget(stdout, stderr, response, error);
    return {
      attempted: true,
      ok: missingAbortTarget,
      status: missingAbortTarget ? 'already_gone' : 'failed',
      sessionKey,
      stopReason,
      stdout,
      stderr,
      response,
      error,
    };
  }

  return {
    attempted: true,
    ok: true,
    status: 'succeeded',
    sessionKey,
    stopReason,
    stdout,
    stderr,
    response,
  };
}
