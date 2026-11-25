import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import contextRouter from './context';

async function start(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/context', contextRouter);
  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('/api/v1/context', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    await setupTestDb();
    const db = getDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Agent HQ', 'default', 1) ON CONFLICT (id) DO NOTHING`);
    await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    await db.run(`INSERT INTO projects (id, tenant_id, name, description, context_md) VALUES (90, 1, 'P', '', '')`);
    await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, goal, workflow_type, status) VALUES (50, 1, 90, 'W', 'Goal.', 'generic', 'active')`);
    ({ server, baseUrl } = await start());
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await teardownTestDb();
  });

  it('answers 404 for an unknown agent and 400 for a malformed filter', async () => {
    expect((await fetch(`${baseUrl}/api/v1/context/agents/999`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/v1/context/runs?agent_id=abc`)).status).toBe(400);
    const runs = await fetch(`${baseUrl}/api/v1/context/runs`);
    expect(runs.status).toBe(200);
    expect(await runs.json()).toEqual({ runs: [] });
  });

  it('returns the conflict list with 409 and applies nothing', async () => {
    const res = await fetch(`${baseUrl}/api/v1/context/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: [{ kind: 'workflow_goal', workflow_id: 50, base_hash: '0'.repeat(64), value: 'New.' }] }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string; detail: { conflicts: unknown[] } };
    expect(body.code).toBe('context_conflict');
    expect(body.detail.conflicts).toEqual([expect.objectContaining({ target: 'workflow_goal:workflow:50' })]);
    expect((await getDb().get<{ goal: string }>('SELECT goal FROM workflows WHERE id = 50'))?.goal).toBe('Goal.');
  });

  it('rejects unknown change kinds', async () => {
    const res = await fetch(`${baseUrl}/api/v1/context/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: [{ kind: 'team_goal', team_id: 1, base_hash: '0'.repeat(64), value: 'x' }] }),
    });
    expect(res.status).toBe(400);
  });
});
