import fs from 'fs';
import os from 'os';
import path from 'path';
import { deleteTenant, ensureTenantSchema, verifyTenantSchemaForStartup } from './tenantContext';
import { installInitialConfiguration } from '../db/migrate';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import type { Db } from '../db/adapter/types';

describe('PostgreSQL tenant install and startup verification', () => {
  let db: Db;
  let workspaceRoot = '';

  beforeEach(async () => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-context-pg-'));
    process.env.WORKSPACE_PARENT = workspaceRoot;
    db = await setupTestDb();
  });

  afterEach(async () => {
    await teardownTestDb();
    delete process.env.WORKSPACE_PARENT;
    if (workspaceRoot) fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('verification refuses missing tenant state without creating it', async () => {
    await expect(verifyTenantSchemaForStartup(db)).rejects.toThrow('Tenant install/migration required');
    expect(Number(await db.value(`SELECT COUNT(*) FROM tenants`))).toBe(0);
    expect(Number(await db.value(`SELECT COUNT(*) FROM app_settings`))).toBe(0);
  });

  it('explicit install is idempotent and startup verification is read-only', async () => {
    await expect(installInitialConfiguration(db)).resolves.toEqual(expect.objectContaining({
      installed: true,
    }));
    const installedTenantId = await ensureTenantSchema(db);
    const beforeTenant = await db.get(
      `SELECT id, name, slug, is_default, updated_at FROM tenants WHERE id = ?`,
      installedTenantId,
    );
    const beforeSettings = await db.all(
      `SELECT key, value, updated_at FROM app_settings ORDER BY key`,
    );

    await expect(installInitialConfiguration(db)).resolves.toEqual({ installed: false });
    expect(await ensureTenantSchema(db)).toBe(installedTenantId);
    expect(await verifyTenantSchemaForStartup(db)).toBe(installedTenantId);
    expect(await verifyTenantSchemaForStartup(db)).toBe(installedTenantId);
    expect(await db.get(
      `SELECT id, name, slug, is_default, updated_at FROM tenants WHERE id = ?`,
      installedTenantId,
    )).toEqual(beforeTenant);
    expect(await db.all(
      `SELECT key, value, updated_at FROM app_settings ORDER BY key`,
    )).toEqual(beforeSettings);
  });

  it('deletes tenant-owned skills while preserving the default tenant', async () => {
    await expect(installInitialConfiguration(db)).resolves.toEqual(expect.objectContaining({
      installed: true,
    }));
    const defaultTenantId = await ensureTenantSchema(db);
    const otherTenantId = Number((await db.run(
      `INSERT INTO tenants (name, slug, is_default) VALUES ('Acme', 'acme', 0)`,
    )).lastInsertId);
    await db.run(
      `INSERT INTO skills (tenant_id, name, content) VALUES (?, 'tenant-skill', '# tenant')`,
      otherTenantId,
    );

    const result = await deleteTenant(db, otherTenantId, { confirmation: 'Acme' });

    expect(result.deleted_counts.skills).toBe(1);
    expect(await db.get(`SELECT id FROM tenants WHERE id = ?`, otherTenantId)).toBeUndefined();
    expect(await db.get(`SELECT id FROM tenants WHERE id = ?`, defaultTenantId)).toBeDefined();
  });
});
