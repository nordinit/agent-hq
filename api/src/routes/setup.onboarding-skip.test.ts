import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import type { Db } from '../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import {
  getAtlasAgentRecord,
  ATLAS_AGENT_NAME,
  ATLAS_AGENT_SLUG,
  ATLAS_SESSION_KEY,
  ATLAS_SYSTEM_ROLE,
  ATLAS_WORKSPACE_PATH,
} from '../lib/atlasAgent';
import { DEFAULT_TENANT_NAME, DEFAULT_TENANT_SLUG } from '../lib/tenantContext';
import setupRouter from './setup';

/** The explicitly installed tenant required by the Atlas fixture's foreign key. */
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

/**
 * The Atlas record a fresh install has, stated explicitly.
 *
 * The first test's subject is that /onboarding/skip leaves an already-present Atlas alone
 * (atlas_created === false, still exactly one row), so that row is a precondition of the test, not
 * something it may assume the schema fixture installed.
 */
async function seedAtlasAgent(db: Db): Promise<void> {
  const tenantId = await ensureDefaultTenantId(db);
  if (await getAtlasAgentRecord()) return;
  await db.run(`
    INSERT INTO agents (tenant_id, name, role, session_key, workspace_path, status, openclaw_agent_id, system_role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    tenantId,
    ATLAS_AGENT_NAME,
    'Built-in assistant — task routing, coordination, and chat',
    ATLAS_SESSION_KEY,
    ATLAS_WORKSPACE_PATH,
    'idle',
    ATLAS_AGENT_SLUG,
    ATLAS_SYSTEM_ROLE,
  );
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
    await seedAtlasAgent(db);
  });
  afterEach(async () => {
    await teardownTestDb();
  });

  it('marks onboarding complete without a connected provider, keeping the seeded Atlas agent', async () => {
    const { server, baseUrl } = await startServer();
    try {
      // An install with an Atlas DB record already present (unprovisioned at the runtime level)
      expect(await getAtlasAgentRecord()).not.toBeNull();

      const res = await fetch(`${baseUrl}/api/v1/setup/onboarding/skip`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.onboarding_completed).toBe(true);
      expect(body.atlas_created).toBe(false);
      expect(body.onboarding_provider_gate_passed).toBe(false);

      const db = getDb();
      const setting = await db.get(`SELECT value FROM app_settings WHERE key = 'onboarding_completed'`) as { value: string } | undefined;
      expect(setting?.value).toBe('true');

      const count = (await db.get(`SELECT COUNT(*) as n FROM agents WHERE system_role = ?`, ATLAS_SYSTEM_ROLE) as { n: number }).n;
      expect(count).toBe(1);

      const statusRes = await fetch(`${baseUrl}/api/v1/setup/status`);
      const status = await statusRes.json() as Record<string, unknown>;
      expect(status.onboarding_completed).toBe(true);
      expect(status.has_atlas_agent).toBe(true);
    } finally {
      await stopServer(server);
    }
  });

  it('recreates a missing Atlas agent without provisioning it', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const db = getDb();
      await db.run(`DELETE FROM agents WHERE system_role = ?`, ATLAS_SYSTEM_ROLE);
      expect(await getAtlasAgentRecord()).toBeNull();

      const res = await fetch(`${baseUrl}/api/v1/setup/onboarding/skip`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.atlas_created).toBe(true);

      const atlas = await getAtlasAgentRecord();
      expect(atlas).not.toBeNull();
      expect(atlas?.system_role).toBe(ATLAS_SYSTEM_ROLE);
      expect(atlas?.session_key).toBe(ATLAS_SESSION_KEY);
      // Unprovisioned: no OpenClaw registration and no workspace assigned
      expect(atlas?.openclaw_agent_id).toBeNull();
      expect(atlas?.workspace_path).toBe('');
    } finally {
      await stopServer(server);
    }
  });
});
