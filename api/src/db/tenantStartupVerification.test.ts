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
    expect(async () => await initSchema({ tenantMode: 'verify' })).toThrow('Tenant install/migration required');
    const db = getDb();
    expect(await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenants'`)).toBeUndefined();
    expect(await db.get(`SELECT value FROM app_settings WHERE key = 'default_tenant_id'`)).toBeUndefined();
  });

  it('does not update tenants or app_settings on a current database', async () => {
    await initSchema({ tenantMode: 'repair' });
    const db = getDb();
    const beforeTenants = await db.all(`SELECT id, name, slug, is_default, updated_at FROM tenants ORDER BY id`);
    const beforeSettings = await db.all(`SELECT key, value, updated_at FROM app_settings ORDER BY key`);

    expect(async () => await initSchema({ tenantMode: 'verify' })).not.toThrow();

    expect(await db.all(`SELECT id, name, slug, is_default, updated_at FROM tenants ORDER BY id`)).toEqual(beforeTenants);
    expect(await db.all(`SELECT key, value, updated_at FROM app_settings ORDER BY key`)).toEqual(beforeSettings);
  });
});
