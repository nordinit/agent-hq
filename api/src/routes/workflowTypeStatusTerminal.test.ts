import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/client';
import { listConfiguredTerminalStatuses } from '../domains/tasks/terminality';
import workflowsRouter from './workflows';

let tempDir: string;
const originalContractRoot = process.env.AGENT_CONTRACT_ROOT;

beforeEach(async () => {
  await setupTestDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-type-terminal-'));
  process.env.AGENT_CONTRACT_ROOT = path.join(tempDir, 'agent-contracts');
  fs.mkdirSync(process.env.AGENT_CONTRACT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(process.env.AGENT_CONTRACT_ROOT, 'generic.md'), 'Workflow type: {{workflowType}}\n');
  const db = getDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Agency')`);
  await db.run(`INSERT INTO workflow_types (tenant_id, key, name, is_system) VALUES (1, 'lead_gen', 'Lead Gen', 0)`);
  await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type, status) VALUES (10, 1, 1, 'Lead Generation', 'lead_gen', 'active')`);
  await db.run(`INSERT INTO workflow_type_task_statuses (tenant_id, workflow_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json) VALUES (1, 'lead_gen', 'submitted', 'Submitted', 'blue', 0, 0, '[]', 0, 0, '{}')`);
  await db.run(`INSERT INTO workflow_task_statuses (workflow_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json) VALUES (10, 'submitted', 'Submitted', 'blue', 0, 0, '[]', 0, 0, '{}')`);
});

afterEach(async () => {
  await teardownTestDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  if (originalContractRoot === undefined) delete process.env.AGENT_CONTRACT_ROOT;
  else process.env.AGENT_CONTRACT_ROOT = originalContractRoot;
});

test('the Workflow Definitions terminal toggle changes terminality for every workflow of the type', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/workflows', workflowsRouter);
  const server = await new Promise<Server>(resolve => { const instance = app.listen(0, () => resolve(instance)); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const setTerminal = (terminal: boolean) => fetch(`http://127.0.0.1:${address.port}/api/v1/workflows/types/lead_gen/statuses/submitted`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Submitted', color: 'blue', terminal }),
  });
  try {
    const on = await setTerminal(true);
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ name: 'submitted', terminal: true });
    expect(await listConfiguredTerminalStatuses(getDb(), { workflowId: 10, tenantId: 1 })).toContain('submitted');

    const off = await setTerminal(false);
    expect(await off.json()).toMatchObject({ name: 'submitted', terminal: false });
    expect(await listConfiguredTerminalStatuses(getDb(), { workflowId: 10, tenantId: 1 })).not.toContain('submitted');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
});
