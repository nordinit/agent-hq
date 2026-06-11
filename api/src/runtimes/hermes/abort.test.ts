import { EventEmitter } from 'events';
import { jest } from '@jest/globals';
import {
  parseHermesInstanceIdFromRunId,
  stopHermesActiveRun,
  waitForHermesChildProcess,
  type ActiveHermesRun,
} from './abort';

function createChild() {
  const child = new EventEmitter() as any;
  child.kill = jest.fn(() => true);
  return child;
}

describe('hermes abort helpers', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('parses Hermes runtime ids and rejects non-Hermes ids', () => {
    expect(parseHermesInstanceIdFromRunId('hermes:2940')).toBe(2940);
    expect(parseHermesInstanceIdFromRunId('openclaw:2940')).toBeNull();
    expect(parseHermesInstanceIdFromRunId('hermes:not-a-number')).toBeNull();
  });

  it('waits for spawn and close process events', async () => {
    const child = createChild();
    const wait = waitForHermesChildProcess(child);

    child.emit('spawn');
    child.emit('close', 0, null);

    await expect(wait.spawned).resolves.toBeUndefined();
    await expect(wait.exited).resolves.toEqual({ code: 0, signal: null });
  });

  it('sends SIGTERM immediately and escalates to SIGKILL after grace when still running', () => {
    jest.useFakeTimers();
    const child = createChild();
    const active: ActiveHermesRun = {
      child,
      killGraceMs: 25,
      exited: false,
      aborted: false,
      timedOut: false,
    };

    expect(stopHermesActiveRun(active)).toBe(true);
    expect(active.aborted).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    jest.advanceTimersByTime(25);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not stop an already exited Hermes run', () => {
    const child = createChild();
    const active: ActiveHermesRun = {
      child,
      killGraceMs: 25,
      exited: true,
      aborted: false,
      timedOut: false,
    };

    expect(stopHermesActiveRun(active)).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
