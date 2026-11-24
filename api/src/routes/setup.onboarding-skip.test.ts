import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import type { Db } from '../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { DEFAULT_TENANT_NAME, DEFAULT_TENANT_SLUG } from '../lib/tenantContext';
import setupRouter from './setup';

/** The explicitly installed tenant a fresh install has. */
async function ensureDefaultTenantId(db: Db): Promise<number> {
  const existing = await db.get(
    `SELECT id FROM tenants WHERE slug = ? LIMIT 1`,
    DEFAULT_TENANT_SLUG,
  ) as { id: number } | undefined;
  let tenantId = existing ? Number(existing.id) : null;

  if (tenantId == null) {
    const inserted = await db.run(
      `INSERT INTO tenants (name, slug, is_default) VALUES (?, ?, 1)`,
      DEFAULT_TENANT_NAME,
      DEFAULT_TENANT_SLUG,
    );
    if (inserted.lastInsertId == null) throw new Error('tenant fixture insert returned no id');
    tenantId = inserted.lastInsertId;
  }

  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', ?), ('active_tenant_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, String(tenantId), String(tenantId));
  return tenantId;
}

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/setup', setupRouter);
  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe('POST /api/v1/setup/onboarding/skip', () => {
  beforeEach(async () => {
    const db = await setupTestDb();
    await ensureDefaultTenantId(db);
  });
  afterEach(async () => {
    await teardownTestDb();
  });

  it('marks onboarding complete without a connected provider and creates no agent', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const db = getDb();
      const agentsBefore = (await db.get(`SELECT COUNT(*) as n FROM agents`) as { n: number }).n;

      const res = await fetch(`${baseUrl}/api/v1/setup/onboarding/skip`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.onboarding_completed).toBe(true);
      expect(body.onboarding_provider_gate_passed).toBe(false);
      expect(body).not.toHaveProperty('atlas_created');

      const setting = await db.get(`SELECT value FROM app_settings WHERE key = 'onboarding_completed'`) as { value: string } | undefined;
      expect(setting?.value).toBe('true');

      const agentsAfter = (await db.get(`SELECT COUNT(*) as n FROM agents`) as { n: number }).n;
      expect(agentsAfter).toBe(agentsBefore);

      const statusRes = await fetch(`${baseUrl}/api/v1/setup/status`);
      const status = await statusRes.json() as Record<string, unknown>;
      expect(status.onboarding_completed).toBe(true);
      expect(status).not.toHaveProperty('has_atlas_agent');
    } finally {
      await stopServer(server);
    }
  });
});
