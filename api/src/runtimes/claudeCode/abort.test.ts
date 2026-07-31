import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';

import {
  parseClaudeCodeInstanceIdFromRunId,
  stopClaudeCodeActiveRun,
  terminateClaudeCodeRun,
  waitForClaudeCodeChildProcess,
  writePromptToStdin,
  type ActiveClaudeCodeRun,
} from './abort';

function createMockChild(): ChildProcess & {
  kill: jest.Mock;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
} {
  const child = new EventEmitter() as unknown as ChildProcess & {
    kill: jest.Mock;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn(() => true);
  return child;
}

function activeRun(child: ChildProcess, overrides: Partial<ActiveClaudeCodeRun> = {}): ActiveClaudeCodeRun {
  return {
    child,
    killGraceMs: 10_000,
    exited: false,
    aborted: false,
    timedOut: false,
    ...overrides,
  };
}

describe('parseClaudeCodeInstanceIdFromRunId', () => {
  it('extracts the instance id', () => {
    expect(parseClaudeCodeInstanceIdFromRunId('claude-code:4711')).toBe(4711);
  });

  it('rejects a different runtime prefix', () => {
    expect(parseClaudeCodeInstanceIdFromRunId('hermes:4711')).toBeNull();
  });

  it('rejects a session-key style value', () => {
    // session_key uses the SAME prefix with a uuid, so this must not parse as
    // an instance id — the two namespaces are easy to confuse.
    expect(
      parseClaudeCodeInstanceIdFromRunId('claude-code:9278eeca-b7af-44f7-bc1f-2e6d4c16ee09'),
    ).toBeNull();
  });

  it.each(['', 'claude-code:', 'claude-code:abc', 'claude-code:12abc', 'nonsense'])(
    'rejects %p',
    (runId) => {
      expect(parseClaudeCodeInstanceIdFromRunId(runId)).toBeNull();
    },
  );
});

describe('waitForClaudeCodeChildProcess', () => {
  it('resolves spawned on the spawn event', async () => {
    const child = createMockChild();
    const { spawned } = waitForClaudeCodeChildProcess(child);
    child.emit('spawn');
    await expect(spawned).resolves.toBeUndefined();
  });

  it('rejects spawned when the binary cannot be launched', async () => {
    const child = createMockChild();
    const { spawned, exited } = waitForClaudeCodeChildProcess(child);
    const failure = new Error('spawn claude ENOENT');
    child.emit('error', failure);

    await expect(spawned).rejects.toThrow('ENOENT');
    // The exit promise must still settle — never reject — or the error becomes
    // an unhandled rejection and takes down the API process.
    await expect(exited).resolves.toEqual({ code: null, signal: null, error: failure });
  });

  it('resolves exited with code and signal on close', async () => {
    const child = createMockChild();
    const { exited } = waitForClaudeCodeChildProcess(child);
    child.emit('close', 0, null);
    await expect(exited).resolves.toEqual({ code: 0, signal: null });
  });

  it('settles exited exactly once even when error and close both fire', async () => {
    const child = createMockChild();
    const { spawned, exited } = waitForClaudeCodeChildProcess(child);
    // `spawned` rejects on the same event; leaving it unhandled would surface as
    // an unhandled rejection and abort the whole test process.
    spawned.catch(() => undefined);

    child.emit('error', new Error('first'));
    child.emit('close', 137, 'SIGKILL');

    const result = await exited;
    expect(result.error?.message).toBe('first');
    expect(result.code).toBeNull();
  });

  it('reports a signal-terminated exit', async () => {
    const child = createMockChild();
    const { exited } = waitForClaudeCodeChildProcess(child);
    child.emit('close', null, 'SIGKILL');
    await expect(exited).resolves.toEqual({ code: null, signal: 'SIGKILL' });
  });
});

describe('writePromptToStdin', () => {
  it('writes the prompt and closes stdin', async () => {
    const child = createMockChild();
    const chunks: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    const closed = new Promise<void>((resolve) => child.stdin.on('end', () => resolve()));
    child.stdin.resume();

    writePromptToStdin(child, 'do the thing');
    await closed;

    // Closing stdin is not optional: `claude --print -` does no work until it
    // sees EOF, so a missing end() hangs the run until the dispatch timeout.
    expect(chunks.join('')).toBe('do the thing');
  });

  it('swallows EPIPE from a child that died during startup', () => {
    const child = createMockChild();
    writePromptToStdin(child, 'prompt');
    expect(() => child.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
  });

  it('is a no-op when the child has no stdin pipe', () => {
    const child = createMockChild();
    (child as unknown as { stdin: null }).stdin = null;
    expect(() => writePromptToStdin(child, 'prompt')).not.toThrow();
  });
});

describe('stopClaudeCodeActiveRun', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('marks the run aborted and sends SIGTERM', () => {
    const child = createMockChild();
    const active = activeRun(child);

    expect(stopClaudeCodeActiveRun(active)).toBe(true);
    expect(active.aborted).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('escalates to SIGKILL after the grace period', () => {
    const child = createMockChild();
    const active = activeRun(child, { killGraceMs: 25 });

    stopClaudeCodeActiveRun(active);
    jest.advanceTimersByTime(25);

    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('does not escalate when the process already exited', () => {
    const child = createMockChild();
    const active = activeRun(child, { killGraceMs: 25 });

    stopClaudeCodeActiveRun(active);
    active.exited = true;
    jest.advanceTimersByTime(25);

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for an already-exited run', () => {
    const child = createMockChild();
    const active = activeRun(child, { exited: true });

    expect(stopClaudeCodeActiveRun(active)).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('terminateClaudeCodeRun', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('kills without marking the run aborted', () => {
    const child = createMockChild();
    const active = activeRun(child);

    terminateClaudeCodeRun(active);

    // An operator abort and a runtime-imposed kill (timeout, MCP gate) must
    // classify differently, so terminate must not set `aborted`.
    expect(active.aborted).toBe(false);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('escalates to SIGKILL after the grace period', () => {
    const child = createMockChild();
    const active = activeRun(child, { killGraceMs: 50 });

    terminateClaudeCodeRun(active);
    jest.advanceTimersByTime(50);

    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('is a no-op for an already-exited run', () => {
    const child = createMockChild();
    const active = activeRun(child, { exited: true });

    terminateClaudeCodeRun(active);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
