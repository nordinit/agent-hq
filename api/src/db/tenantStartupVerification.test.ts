import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from './client';
import { initSchema } from './schema';

let tempDir = '';

function resetDb(): void {
  closeDb();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-startup-verification-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
}

describe('API startup tenant verification mode', () => {
  beforeEach(() => {
    resetDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('fails instead of creating default tenant bootstrap state', async () => {
    // expect(fn).toThrow() calls fn SYNCHRONOUSLY. An async fn returns a promise instead of
    // throwing, so not.toThrow() passed trivially while the call ran DETACHED — and then
    // rejected after teardown closed the connection, killing the jest worker. toThrow() on an
    // async fn simply never matched. Both forms must go through the promise.
    await expect(initSchema({ tenantMode: 'verify' })).rejects.toThrow('Tenant install/migration required');
    const db = getDb();
    expect(await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenants'`)).toBeUndefined();
    expect(await db.get(`SELECT value FROM app_settings WHERE key = 'default_tenant_id'`)).toBeUndefined();
  });

  it('does not update tenants or app_settings on a current database', async () => {
    await initSchema({ tenantMode: 'repair' });
    const db = getDb();
    const beforeTenants = await db.all(`SELECT id, name, slug, is_default, updated_at FROM tenants ORDER BY id`);
    const beforeSettings = await db.all(`SELECT key, value, updated_at FROM app_settings ORDER BY key`);

    await initSchema({ tenantMode: 'verify' });

    expect(await db.all(`SELECT id, name, slug, is_default, updated_at FROM tenants ORDER BY id`)).toEqual(beforeTenants);
    expect(await db.all(`SELECT key, value, updated_at FROM app_settings ORDER BY key`)).toEqual(beforeSettings);
  });
});
