import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import router from './provider-connections';

const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
let tempDir = '';

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/provider-connections', router);
  const server = await new Promise<Server>(resolve => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('runtime-owned provider connections', () => {
  beforeEach(async () => {
    // setupTestDb() selects the engine from AGENT_HQ_TEST_PG_URL, so this file runs unchanged on
    // SQLite and on PostgreSQL. tempDir is still needed for OPENCLAW_STATE_DIR, which is
    // filesystem state unrelated to the database.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-provider-connections-'));
    process.env.OPENCLAW_STATE_DIR = path.join(tempDir, 'openclaw');
    await setupTestDb();
    const authPath = path.join(process.env.OPENCLAW_STATE_DIR, 'agents', 'builder', 'agent', 'auth-profiles.json');
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({
      profiles: { 'anthropic:work': { type: 'oauth', provider: 'anthropic', access: 'do-not-store', refresh: 'do-not-store' } },
    }));
  });

  afterEach(async () => {
    await teardownTestDb();
    if (originalOpenClawStateDir == null) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('discovers and stores only a runtime credential reference', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const discover = await fetch(`${baseUrl}/api/v1/provider-connections/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', runtime: 'openclaw', auth_mode: 'subscription', agent_slug: 'builder' }),
      });
      expect(discover.status).toBe(200);
      const discovered = await discover.json() as { connections: Array<{ externalRef: string; metadata: Record<string, unknown> }> };
      expect(discovered.connections[0].externalRef).toBe('builder/anthropic:work');
      expect(JSON.stringify(discovered)).not.toContain('do-not-store');

      const create = await fetch(`${baseUrl}/api/v1/provider-connections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_slug: 'anthropic',
          auth_mode: 'subscription',
          runtime_type: 'openclaw',
          external_ref: 'builder/anthropic:work',
          agent_slug: 'builder',
          metadata: { account_label: 'Work', credential_owner: 'openclaw' },
        }),
      });
      expect(create.status).toBe(201);
      const saved = await create.json() as Record<string, unknown>;
      expect(saved).toMatchObject({ provider_slug: 'anthropic', runtime_type: 'openclaw', status: 'connected' });
      const row = await getDb().get('SELECT config FROM provider_config WHERE slug = ?', 'anthropic');
      expect(row).toBeUndefined();
      const connection = await getDb().get('SELECT external_ref, metadata FROM provider_connections') as { external_ref: string; metadata: string };
      expect(connection.external_ref).toBe('builder/anthropic:work');
      expect(connection.metadata).not.toContain('do-not-store');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('rejects secret-bearing metadata', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/provider-connections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_slug: 'anthropic',
          auth_mode: 'subscription',
          runtime_type: 'openclaw',
          external_ref: 'builder/anthropic:work',
          agent_slug: 'builder',
          metadata: { refresh_token: 'forbidden' },
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringMatching(/must not contain/i) });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
