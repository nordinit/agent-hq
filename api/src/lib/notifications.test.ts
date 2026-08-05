import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { readNotificationPreferences, saveNotificationPreferences } from './notifications';

beforeEach(async () => { await setupTestDb(); });
afterEach(async () => { await teardownTestDb(); });

describe('notification preferences', () => {
  it('stores tenant-scoped preferences without changing other tenants', async () => {
    const db = getDb();
    await saveNotificationPreferences({ enabled: false, liveEnabled: false, outlets: { telegram: false } }, db, 5);

    expect(await readNotificationPreferences(db, 5)).toEqual({
      enabled: false,
      liveEnabled: false,
      outlets: { telegram: false },
    });
    expect(await readNotificationPreferences(db, 1)).toEqual({
      enabled: true,
      liveEnabled: true,
      outlets: { telegram: true },
    });
  });

  it('uses legacy global preferences only until a tenant override is saved', async () => {
    const db = getDb();
    await saveNotificationPreferences({ enabled: false }, db);
    expect((await readNotificationPreferences(db, 1)).enabled).toBe(false);

    await saveNotificationPreferences({ liveEnabled: false }, db, 1);
    expect(await readNotificationPreferences(db, 1)).toEqual({
      enabled: false,
      liveEnabled: false,
      outlets: { telegram: true },
    });
    expect((await readNotificationPreferences(db, 2)).enabled).toBe(false);
    expect((await readNotificationPreferences(db, 2)).liveEnabled).toBe(true);
  });
});
