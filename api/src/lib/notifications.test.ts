import Database from 'better-sqlite3';
import { readNotificationPreferences, saveNotificationPreferences } from './notifications';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('notification preferences', () => {
  it('stores tenant-scoped preferences without changing other tenants', () => {
    const db = createDb();
    try {
      saveNotificationPreferences({ enabled: false, liveEnabled: false, outlets: { telegram: false } }, db, 5);

      expect(readNotificationPreferences(db, 5)).toEqual({
        enabled: false,
        liveEnabled: false,
        outlets: { telegram: false },
      });
      expect(readNotificationPreferences(db, 1)).toEqual({
        enabled: true,
        liveEnabled: true,
        outlets: { telegram: true },
      });
    } finally {
      db.close();
    }
  });

  it('uses legacy global preferences only until a tenant override is saved', () => {
    const db = createDb();
    try {
      saveNotificationPreferences({ enabled: false }, db);
      expect(readNotificationPreferences(db, 1).enabled).toBe(false);

      saveNotificationPreferences({ liveEnabled: false }, db, 1);
      expect(readNotificationPreferences(db, 1)).toEqual({
        enabled: false,
        liveEnabled: false,
        outlets: { telegram: true },
      });
      expect(readNotificationPreferences(db, 2).enabled).toBe(false);
      expect(readNotificationPreferences(db, 2).liveEnabled).toBe(true);
    } finally {
      db.close();
    }
  });
});
