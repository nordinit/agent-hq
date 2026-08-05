import { stopDurableLocalProcess } from './durableLocalProcessControl';

const handle = {
  version: 1,
  kind: 'local-process',
  pid: 8123,
  processGroupId: 8123,
  processIdentity: 'sha256:birth',
  hostname: 'api-host',
  startedAt: '2026-08-04 12:00:00',
};

describe('stopDurableLocalProcess', () => {
  it('confirms a same-host identity-bound process group after it exits', async () => {
    const exists = jest.fn()
      .mockReturnValueOnce(true) // direct PID before signalling
      .mockReturnValueOnce(true) // group during first poll
      .mockReturnValueOnce(false); // group exited
    const signal = jest.fn();

    await expect(stopDurableLocalProcess(handle, 1_000, {
      currentHostname: 'api-host',
      inspectIdentity: () => 'sha256:birth',
      targetExists: exists,
      signalTarget: signal,
      sleep: async () => undefined,
      pollIntervalMs: 10,
    })).resolves.toMatchObject({ ok: true, confirmed: true, status: 'signalled' });
    expect(signal).toHaveBeenCalledWith(-8123, 'SIGTERM');
  });

  it('refuses a handle without a process-birth fingerprint', async () => {
    await expect(stopDurableLocalProcess({ ...handle, processIdentity: null }, 10, {
      currentHostname: 'api-host',
    })).resolves.toMatchObject({ attempted: false, ok: false, confirmed: false, status: 'failed' });
  });

  it('treats a reused PID as the original process already gone without signalling it', async () => {
    const signal = jest.fn();
    await expect(stopDurableLocalProcess(handle, 10, {
      currentHostname: 'api-host',
      targetExists: (target) => target > 0,
      inspectIdentity: () => 'sha256:different-birth',
      signalTarget: signal,
    })).resolves.toMatchObject({ ok: true, confirmed: true, status: 'already_gone' });
    expect(signal).not.toHaveBeenCalled();
  });

  it('does not claim success when the leader is gone but descendants remain', async () => {
    await expect(stopDurableLocalProcess(handle, 10, {
      currentHostname: 'api-host',
      targetExists: (target) => target < 0,
    })).resolves.toMatchObject({ attempted: false, ok: false, confirmed: false, status: 'failed' });
  });

  it('refuses a handle owned by another host', async () => {
    await expect(stopDurableLocalProcess(handle, 10, {
      currentHostname: 'different-host',
    })).resolves.toMatchObject({ attempted: false, ok: false, confirmed: false, status: 'failed' });
  });
});
