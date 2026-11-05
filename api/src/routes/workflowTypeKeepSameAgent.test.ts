import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { isKeepSameAgentEnabled } from '../domains/tasks/statusOwners';
import workflowsRouter from './workflows';

beforeEach(async () => {
  await setupTestDb();
  const db = getDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Agency')`);
  await db.run(`INSERT INTO workflow_types (tenant_id, key, name, is_system) VALUES (1, 'delivery', 'Delivery', 0)`);
  await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type, status) VALUES (10, 1, 1, 'Build', 'delivery', 'active')`);
});

afterEach(async () => { await teardownTestDb(); });

test('Keep same agent is off by default and the Workflow Definitions setting turns it on and off for the type', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/workflows', workflowsRouter);
  const server = await new Promise<Server>(resolve => { const instance = app.listen(0, () => resolve(instance)); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const url = `http://127.0.0.1:${address.port}/api/v1/workflows/types/delivery`;
  const update = (body: Record<string, unknown>) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    expect(await (await fetch(url)).json()).toMatchObject({ key: 'delivery', keep_same_agent: 0 });
    expect(await isKeepSameAgentEnabled(getDb(), 10)).toBe(false);

    const on = await update({ keep_same_agent: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ keep_same_agent: 1 });
    expect(await isKeepSameAgentEnabled(getDb(), 10)).toBe(true);

    // Editing other details without the field keeps the setting.
    expect(await (await update({ name: 'Delivery team' })).json()).toMatchObject({ name: 'Delivery team', keep_same_agent: 1 });

    expect(await (await update({ keep_same_agent: false })).json()).toMatchObject({ keep_same_agent: 0 });
    expect(await isKeepSameAgentEnabled(getDb(), 10)).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
});
