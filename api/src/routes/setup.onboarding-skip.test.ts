import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import { getAtlasAgentRecord, ATLAS_SESSION_KEY, ATLAS_SYSTEM_ROLE } from '../lib/atlasAgent';
import setupRouter from './setup';

const originalDbPath = process.env.AGENT_HQ_DB_PATH;
let tempDir = '';

function resetDb(): void {
  closeDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-setup-skip-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  initSchema();
}

function cleanup(): void {
  closeDb();
  if (originalDbPath == null) delete process.env.AGENT_HQ_DB_PATH;
  else process.env.AGENT_HQ_DB_PATH = originalDbPath;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
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
  beforeEach(resetDb);
  afterEach(cleanup);

  it('marks onboarding complete without a connected provider, keeping the seeded Atlas agent', async () => {
    const { server, baseUrl } = await startServer();
    try {
      // Fresh installs seed an Atlas DB record (unprovisioned at the runtime level)
      expect(getAtlasAgentRecord()).not.toBeNull();

      const res = await fetch(`${baseUrl}/api/v1/setup/onboarding/skip`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.onboarding_completed).toBe(true);
      expect(body.atlas_created).toBe(false);
      expect(body.onboarding_provider_gate_passed).toBe(false);

      const db = getDb();
      const setting = db.prepare(`SELECT value FROM app_settings WHERE key = 'onboarding_completed'`).get() as { value: string } | undefined;
      expect(setting?.value).toBe('true');

      const count = (db.prepare(`SELECT COUNT(*) as n FROM agents WHERE system_role = ?`).get(ATLAS_SYSTEM_ROLE) as { n: number }).n;
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
      db.prepare(`DELETE FROM agents WHERE system_role = ?`).run(ATLAS_SYSTEM_ROLE);
      expect(getAtlasAgentRecord()).toBeNull();

      const res = await fetch(`${baseUrl}/api/v1/setup/onboarding/skip`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.atlas_created).toBe(true);

      const atlas = getAtlasAgentRecord();
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
