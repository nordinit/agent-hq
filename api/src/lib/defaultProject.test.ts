import type { Db } from '../db/adapter/types';
import { ensureDefaultProjectId } from './defaultProject';

describe('ensureDefaultProjectId', () => {
  it('returns the configured valid project without writing configuration', async () => {
    const get = jest.fn()
      .mockResolvedValueOnce({ value: '7' })
      .mockResolvedValueOnce({ id: 7 });
    const run = jest.fn();
    const db = { get, run } as unknown as Db;

    await expect(ensureDefaultProjectId(db)).resolves.toBe(7);
    expect(get).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it('returns null for a missing setting instead of selecting and persisting a fallback', async () => {
    const get = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn();
    const db = { get, run } as unknown as Db;

    await expect(ensureDefaultProjectId(db)).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });
});
