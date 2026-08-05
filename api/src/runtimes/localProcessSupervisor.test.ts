import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

import {
  LocalProcessSupervisor,
  type ActiveLocalProcessRun,
} from './localProcessSupervisor';

function mockRun(pid = 8123): ActiveLocalProcessRun & { child: ChildProcess & { kill: jest.Mock } } {
  const child = new EventEmitter() as ChildProcess & { kill: jest.Mock };
  Object.defineProperty(child, 'pid', { value: pid, configurable: true });
  child.kill = jest.fn(() => true);
  return {
    child,
    killGraceMs: 25,
    exited: false,
    aborted: false,
    timedOut: false,
  };
}

describe('LocalProcessSupervisor', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('lets a separately resolved runtime stop a registered run', () => {
    const signalProcess = jest.fn();
    const supervisor = new LocalProcessSupervisor({ platform: 'linux', signalProcess });
    const state = mockRun();
    supervisor.register({
      runId: 'claude-code:4711',
      runtimeType: 'claude-code',
      instanceId: 4711,
      state,
      processGroupId: state.child.pid,
    });

    const result = supervisor.stop('claude-code:4711', 'claude-code');

    expect(result).toMatchObject({ status: 'signalled', signal: 'SIGTERM' });
    expect(state.aborted).toBe(true);
    expect(signalProcess).toHaveBeenCalledWith(-8123, 'SIGTERM');
    expect(state.child.kill).not.toHaveBeenCalled();
  });

  it('escalates the complete process group once after the grace period', () => {
    const signalProcess = jest.fn();
    const supervisor = new LocalProcessSupervisor({ platform: 'linux', signalProcess });
    const state = mockRun();
    supervisor.register({
      runId: 'hermes:91',
      runtimeType: 'hermes',
      instanceId: 91,
      state,
      processGroupId: state.child.pid,
    });

    supervisor.stop('hermes:91');
    supervisor.stop('hermes:91');
    jest.advanceTimersByTime(25);

    expect(signalProcess.mock.calls).toEqual([
      [-8123, 'SIGTERM'],
      [-8123, 'SIGKILL'],
    ]);
  });

  it('still escalates the process group when the CLI leader exits first', () => {
    const signalProcess = jest.fn();
    const supervisor = new LocalProcessSupervisor({ platform: 'linux', signalProcess });
    const state = mockRun();
    supervisor.register({
      runId: 'claude-code:92',
      runtimeType: 'claude-code',
      instanceId: 92,
      state,
      processGroupId: state.child.pid,
    });

    supervisor.stop('claude-code:92');
    state.child.emit('close', null, 'SIGTERM');
    jest.advanceTimersByTime(25);

    expect(signalProcess.mock.calls).toEqual([
      [-8123, 'SIGTERM'],
      [-8123, 'SIGKILL'],
    ]);
  });

  it('cancels deferred escalation after the complete group is independently confirmed absent', () => {
    const signalProcess = jest.fn();
    const supervisor = new LocalProcessSupervisor({ platform: 'linux', signalProcess });
    const state = mockRun();
    supervisor.register({
      runId: 'codex:93', runtimeType: 'codex', instanceId: 93, state,
      processGroupId: state.child.pid,
    });

    supervisor.stop('codex:93');
    state.child.emit('close', null, 'SIGTERM');
    supervisor.confirmProcessGroupAbsent(state.child.pid ?? null);
    jest.advanceTimersByTime(25);

    expect(signalProcess.mock.calls).toEqual([[-8123, 'SIGTERM']]);
  });

  it('does not mark timeout/policy termination as an operator abort', () => {
    const supervisor = new LocalProcessSupervisor({ platform: 'win32' });
    const state = mockRun();
    supervisor.register({
      runId: 'claude-code:52',
      runtimeType: 'claude-code',
      instanceId: 52,
      state,
    });

    supervisor.terminate('claude-code:52');

    expect(state.aborted).toBe(false);
    expect(state.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('cleans up on close and treats later stops as already absent', () => {
    const supervisor = new LocalProcessSupervisor({ platform: 'win32' });
    const state = mockRun();
    supervisor.register({
      runId: 'hermes:102',
      runtimeType: 'hermes',
      instanceId: 102,
      state,
    });

    state.child.emit('close', 0, null);

    expect(state.exited).toBe(true);
    expect(supervisor.has('hermes:102')).toBe(false);
    expect(supervisor.stop('hermes:102').status).toBe('not_found');
  });

  it('refuses to overwrite a different live child with the same run id', () => {
    const supervisor = new LocalProcessSupervisor({ platform: 'win32' });
    const first = mockRun(1);
    const second = mockRun(2);
    supervisor.register({ runId: 'hermes:7', runtimeType: 'hermes', instanceId: 7, state: first });

    expect(() => supervisor.register({
      runId: 'hermes:7',
      runtimeType: 'hermes',
      instanceId: 7,
      state: second,
    })).toThrow(/already registered/);
  });
});
