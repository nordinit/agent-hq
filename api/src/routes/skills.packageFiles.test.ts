import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import skillsRouter from './skills';

describe('database-backed skill package files', () => {
  let server: Server | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    await setupTestDb();
    const db = getDb();
    const existingTenant = await db.get<{ id: number }>(`
      SELECT id FROM tenants WHERE is_default = 1 ORDER BY id LIMIT 1
    `);
    const tenantId = existingTenant?.id ?? (await db.run(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Default Tenant', 'default', 1)
    `)).lastInsertId;
    if (tenantId === null) throw new Error('Could not resolve the default tenant id');
    await db.run(`
      INSERT INTO app_settings (key, value)
      VALUES ('default_tenant_id', ?), ('active_tenant_id', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `, String(tenantId), String(tenantId));

    const app = express();
    app.use(express.json());
    app.use('/api/v1/skills', skillsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (!address || typeof address === 'string') throw new Error('Failed to bind skill test server');
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((error) => error ? reject(error) : resolve());
    });
    server = null;
    await teardownTestDb();
  });

  it('creates, lists, reads, and updates supplemental files', async () => {
    const create = await fetch(`${baseUrl}/api/v1/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'packaged-skill',
        content: '---\nname: packaged-skill\n---\n',
        files: [{ path: 'references/guide.md', content: '# First guide\n' }],
      }),
    });
    expect(create.status).toBe(201);
    await expect(create.json()).resolves.toMatchObject({
      name: 'packaged-skill',
      files: ['SKILL.md', 'references/guide.md'],
    });

    const list = await fetch(`${baseUrl}/api/v1/skills`);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual([
      expect.objectContaining({ name: 'packaged-skill', files: ['SKILL.md', 'references/guide.md'] }),
    ]);

    const read = await fetch(`${baseUrl}/api/v1/skills/packaged-skill/file/references/guide.md`);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      file: 'references/guide.md',
      content: '# First guide\n',
      path: 'db://skills/packaged-skill/references/guide.md',
    });

    const update = await fetch(`${baseUrl}/api/v1/skills/packaged-skill/file/references/guide.md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Updated guide\n' }),
    });
    expect(update.status).toBe(200);

    const readUpdated = await fetch(`${baseUrl}/api/v1/skills/packaged-skill/file/references/guide.md`);
    await expect(readUpdated.json()).resolves.toMatchObject({ content: '# Updated guide\n' });
  });

  it('rejects traversal paths and duplicate SKILL.md storage', async () => {
    const create = await fetch(`${baseUrl}/api/v1/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'unsafe-package',
        content: '# Canonical\n',
        files: [{ path: '../outside.md', content: 'nope' }],
      }),
    });
    expect(create.status).toBe(400);

    const duplicateRoot = await fetch(`${baseUrl}/api/v1/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'duplicate-root',
        content: '# Canonical\n',
        files: [{ path: 'SKILL.md', content: '# Duplicate\n' }],
      }),
    });
    expect(duplicateRoot.status).toBe(400);
  });
});
