import Database from 'better-sqlite3';
import { readNotificationPreferences, saveNotificationPreferences } from './notifications';
import { type Db } from "../db/adapter/types";

async function createDb(): Promise<Db> {
  const db = new Database(':memory:');
  await db.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('notification preferences', () => {
  it('stores tenant-scoped preferences without changing other tenants', async () => {
    const db = await createDb();
    try {
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
    } finally {
      db.close();
    }
  });

  it('uses legacy global preferences only until a tenant override is saved', async () => {
    const db = await createDb();
    try {
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
    } finally {
      db.close();
    }
  });
});
