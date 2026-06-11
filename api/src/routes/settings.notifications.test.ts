import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import { createNotificationRecord } from '../lib/notifications';
import settingsRouter from './settings';

let tempDir: string;

function resetDb(): void {
  closeDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-notifications-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  const db = getDb();
  db.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO tenants (id, name, slug, is_default)
    VALUES (1, 'Default Tenant', 'default', 1), (5, 'Tenant 5', 'tenant-5', 0);
  `);
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

function setActiveTenantIdForTest(tenantId: number): void {
  getDb().prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('active_tenant_id', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(String(tenantId));
}

describe('settings notification preferences', () => {
  beforeEach(() => resetDb());

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps preference writes scoped to the requested tenant', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      setActiveTenantIdForTest(5);
      const update = await fetch(`${baseUrl}/api/v1/settings/notifications/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, liveEnabled: false, outlets: { telegram: false } }),
      });
      expect(update.status).toBe(200);

      const tenantFive = await (await fetch(`${baseUrl}/api/v1/settings/notifications`)).json() as {
        preferences: { enabled: boolean; liveEnabled: boolean; outlets: { telegram: boolean } };
      };
      setActiveTenantIdForTest(1);
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
    const first = createNotificationRecord(db, {
      tenantId: 5,
      type: 'task_status_change',
      title: '🔵 First',
      body: 'first',
      source: 'test',
      outlet: 'agent_hq',
    });
    const second = createNotificationRecord(db, {
      tenantId: 5,
      type: 'watchdog_stale_run',
      title: '⏰ Second',
      body: 'second',
      source: 'watchdog',
      outlet: 'agent_hq',
    });
    createNotificationRecord(db, {
      tenantId: 1,
      type: 'worktree_pruned',
      title: '🧹 Other tenant',
      body: 'other',
      source: 'watchdog',
      outlet: 'agent_hq',
    });

    const { server, baseUrl } = await startTestServer();
    try {
      setActiveTenantIdForTest(5);
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
