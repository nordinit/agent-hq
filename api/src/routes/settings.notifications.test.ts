import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/client';
import { createNotificationRecord } from '../lib/notifications';
import settingsRouter from './settings';

let tempDir: string;

async function resetDb(): Promise<void> {
  await setupTestDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-notifications-'));
  const db = getDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1), (5, 'Tenant Five', 'tenant-five', 0)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
}

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/settings', settingsRouter);
  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, () => resolve(bound));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test server');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function setActiveTenantIdForTest(tenantId: number): Promise<void> {
  await getDb().run(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('active_tenant_id', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `, String(tenantId));
}

describe('settings notification preferences', () => {
  beforeEach(async () => await resetDb());

  afterEach(async () => {
    await teardownTestDb();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps preference writes scoped to the requested tenant', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      await setActiveTenantIdForTest(5);
      const update = await fetch(`${baseUrl}/api/v1/settings/notifications/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, liveEnabled: false, outlets: { telegram: false } }),
      });
      expect(update.status).toBe(200);

      const tenantFive = await (await fetch(`${baseUrl}/api/v1/settings/notifications`)).json() as {
        preferences: { enabled: boolean; liveEnabled: boolean; outlets: { telegram: boolean } };
      };
      await setActiveTenantIdForTest(1);
      const tenantOne = await (await fetch(`${baseUrl}/api/v1/settings/notifications`)).json() as {
        preferences: { enabled: boolean; liveEnabled: boolean; outlets: { telegram: boolean } };
      };

      expect(tenantFive.preferences).toEqual({ enabled: false, liveEnabled: false, outlets: { telegram: false } });
      expect(tenantOne.preferences).toEqual({ enabled: true, liveEnabled: true, outlets: { telegram: true } });
    } finally {
      await stopTestServer(server);
    }
  });

  it('returns stable tenant-scoped notification history pages', async () => {
    const db = getDb();
    const first = await createNotificationRecord(db, {
          tenantId: 5,
          type: 'task_status_change',
          title: '🔵 First',
          body: 'first',
          source: 'test',
          outlet: 'agent_hq',
        });
    const second = await createNotificationRecord(db, {
          tenantId: 5,
          type: 'watchdog_stale_run',
          title: '⏰ Second',
          body: 'second',
          source: 'watchdog',
          outlet: 'agent_hq',
        });
    await createNotificationRecord(db, {
            tenantId: 1,
            type: 'worktree_pruned',
            title: '🧹 Other tenant',
            body: 'other',
            source: 'watchdog',
            outlet: 'agent_hq',
          });

    const { server, baseUrl } = await startTestServer();
    try {
      await setActiveTenantIdForTest(5);
      const pageOne = await (await fetch(`${baseUrl}/api/v1/settings/notifications?limit=1`)).json() as {
        records: Array<{ id: number; title: string }>;
        pagination: { next_cursor: string | null };
        unread_count: number;
      };
      expect(pageOne.records).toHaveLength(1);
      expect(pageOne.records[0]).toEqual(expect.objectContaining({ id: second.id, title: '⏰ Second' }));
      expect(pageOne.pagination.next_cursor).toBeTruthy();
      expect(pageOne.unread_count).toBe(2);

      const pageTwo = await (await fetch(`${baseUrl}/api/v1/settings/notifications?limit=1&cursor=${encodeURIComponent(pageOne.pagination.next_cursor ?? '')}`)).json() as {
        records: Array<{ id: number; title: string }>;
        pagination: { next_cursor: string | null };
        unread_count: number;
      };
      expect(pageTwo.records).toHaveLength(1);
      expect(pageTwo.records[0]).toEqual(expect.objectContaining({ id: first.id, title: '🔵 First' }));
      expect(pageTwo.pagination.next_cursor).toBeNull();
      expect(pageTwo.unread_count).toBe(2);
    } finally {
      await stopTestServer(server);
    }
  });
});
