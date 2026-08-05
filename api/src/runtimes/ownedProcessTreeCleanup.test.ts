import { cleanupOwnedProcessTree } from './ownedProcessTreeCleanup';

describe('cleanupOwnedProcessTree', () => {
  it('escalates and confirms absence of the complete POSIX process group', async () => {
    let checks = 0;
    const signalTarget = jest.fn();
    const result = await cleanupOwnedProcessTree({
      processGroupId: 42,
      graceMs: 10,
      options: {
        platform: 'linux',
        targetExists: () => {
          checks += 1;
          return checks < 4;
        },
        signalTarget,
        sleep: async () => undefined,
        pollIntervalMs: 10,
        killConfirmationMs: 20,
      },
    });

    expect(result).toEqual({ confirmed: true, escalated: true, scope: 'process-group' });
    expect(signalTarget).toHaveBeenNthCalledWith(1, -42, 'SIGTERM');
    expect(signalTarget).toHaveBeenNthCalledWith(2, -42, 'SIGKILL');
  });

  it('fails closed when only direct-child teardown is available', async () => {
    const child = { kill: jest.fn(() => true) };
    await expect(cleanupOwnedProcessTree({
      child: child as never,
      processGroupId: null,
      graceMs: 0,
      options: { platform: 'win32' },
    })).resolves.toMatchObject({
      confirmed: false,
      scope: 'direct-child',
      error: expect.stringContaining('Job Object'),
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not signal a group already confirmed absent', async () => {
    const signalTarget = jest.fn();
    await expect(cleanupOwnedProcessTree({
      processGroupId: 9,
      graceMs: 100,
      options: { platform: 'darwin', targetExists: () => false, signalTarget },
    })).resolves.toEqual({ confirmed: true, escalated: false, scope: 'process-group' });
    expect(signalTarget).not.toHaveBeenCalled();
  });
});
