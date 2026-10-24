import express from 'express';
import type { Server } from 'http';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { getDb } from '../db/client';
import { beginMcpRecovery, escalateMcpRecoveries } from '../lib/mcpRecovery';
import agentsRouter from './agents';

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/agents', agentsRouter);
  const server = await new Promise<Server>((resolve, reject) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    bound.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('POST /api/v1/agents/:id/mcp-recovery/retry', () => {
  let server: Server;
  let baseUrl: string;
  const retry = (agentId: number) => fetch(`${baseUrl}/api/v1/agents/${agentId}/mcp-recovery/retry`, { method: 'POST' });

  beforeEach(async () => {
    await setupTestDb();
    const db = getDb();
    await db.run("INSERT INTO tenants (id,name,slug,is_default) VALUES (1,'Default Tenant','default',1),(2,'Other','other',0)");
    await db.run("INSERT INTO app_settings (key,value) VALUES ('default_tenant_id','1'),('active_tenant_id','1')");
    await db.run("INSERT INTO agents (id,tenant_id,name,session_key,enabled) VALUES (1,1,'Casper','agent:casper:main',1),(2,2,'Elsewhere','agent:elsewhere:main',1)");
    ({ server, baseUrl } = await startTestServer());
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    await teardownTestDb();
  });

  it('reopens an escalated recovery and refuses while one is already in progress', async () => {
    const db = getDb();
    await beginMcpRecovery(db, '/gateway', 1, 'connect ECONNREFUSED');
    const busy = await retry(1);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: 'mcp_recovery_in_progress', runtime_recovery: { state: 'recovering' } });

    await db.run("UPDATE openclaw_mcp_recovery SET deadline_at=now()-interval '1 minute'");
    await escalateMcpRecoveries(db);
    const reopened = await retry(1);
    expect(reopened.status).toBe(202);
    expect(await reopened.json()).toMatchObject({ ok: true, runtime_recovery: { agent_id: 1, state: 'recovering' } });
  });

  it('reports agents with no open recovery and hides other tenants', async () => {
    const none = await retry(1);
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ code: 'mcp_recovery_not_found', runtime_recovery: null });
    await beginMcpRecovery(getDb(), '/gateway', 2, 'disconnected');
    expect((await retry(2)).status).toBe(404);
  });
});
