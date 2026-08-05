import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/client';
import sprintsRouter from './sprints';

let tempDir: string;
let dbPath: string;
const originalContractRoot = process.env.AGENT_CONTRACT_ROOT;

async function resetDb(): Promise<void> {
  await setupTestDb();
  jest.resetModules();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task518-emoji-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_CONTRACT_ROOT = path.join(tempDir, 'agent-contracts');
  fs.mkdirSync(process.env.AGENT_CONTRACT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(process.env.AGENT_CONTRACT_ROOT, 'generic.md'), 'Sprint type: {{sprintType}}\n');

  const db = getDb();


  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Agent HQ')`);
  await db.run(`INSERT INTO sprint_types (tenant_id, key, name, is_system) VALUES (1, 'enhancements', 'Enhancements', 1)`);
  await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type, status) VALUES (10, 1, 1, 'Enhancements', 'enhancements', 'active')`);
  await db.run(`INSERT INTO task_statuses (name, label, color, terminal, is_system, allowed_transitions) VALUES ('review', 'Review', 'purple', 0, 1, '[]')`);
  await db.run(`INSERT INTO sprint_type_task_statuses (tenant_id, sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json) VALUES (1, 'enhancements', 'review', 'Review', 'purple', 0, 1, '[]', 0, 1, '{}')`);
  await db.run(`INSERT INTO sprint_task_statuses (sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json) VALUES (10, 'review', 'Review', 'purple', 0, 1, '[]', 0, 1, '{}')`);
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task518-emoji-bootstrap-'));
  await resetDb();
});

afterEach(async () => {
  await teardownTestDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  if (originalContractRoot === undefined) delete process.env.AGENT_CONTRACT_ROOT;
  else process.env.AGENT_CONTRACT_ROOT = originalContractRoot;
});

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/sprints', sprintsRouter);
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

test('sprint type status emoji persists and round-trips on repeated reload fetches', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const updateResponse = await fetch(`${baseUrl}/api/v1/sprints/types/enhancements/statuses/review`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '🚦' }),
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toEqual(expect.objectContaining({
      name: 'review',
      emoji: '🚦',
      metadata: expect.objectContaining({ emoji: '🚦' }),
    }));

    for (let i = 0; i < 3; i += 1) {
      const listResponse = await fetch(`${baseUrl}/api/v1/sprints/types/enhancements/statuses`);
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json() as { statuses: Array<{ name: string; emoji?: string | null; metadata?: Record<string, unknown> }> };
      expect(listBody.statuses.find((status) => status.name === 'review')).toEqual(expect.objectContaining({
        name: 'review',
        emoji: '🚦',
        metadata: expect.objectContaining({ emoji: '🚦' }),
      }));
    }

    const db = getDb();
    const sprintTypeRow = await db.get(`SELECT metadata_json FROM sprint_type_task_statuses WHERE sprint_type_key = ? AND status_key = ?`, 'enhancements', 'review') as { metadata_json: string } | undefined;
    const sprintRow = await db.get(`SELECT metadata_json FROM sprint_task_statuses WHERE sprint_id = ? AND status_key = ?`, 10, 'review') as { metadata_json: string } | undefined;
    expect(JSON.parse(sprintTypeRow?.metadata_json ?? '{}')).toEqual(expect.objectContaining({ emoji: '🚦' }));
    expect(JSON.parse(sprintRow?.metadata_json ?? '{}')).toEqual(expect.objectContaining({ emoji: '🚦' }));

    const workflowResponse = await fetch(`${baseUrl}/api/v1/sprints/workflow-metadata?sprint_type=enhancements`);
    expect(workflowResponse.status).toBe(200);
    const workflowBody = await workflowResponse.json() as { statuses: Array<{ name: string; emoji?: string | null; metadata?: Record<string, unknown> }> };
    expect(workflowBody.statuses.find((status) => status.name === 'review')).toEqual(expect.objectContaining({
      name: 'review',
      emoji: '🚦',
      metadata: expect.objectContaining({ emoji: '🚦' }),
    }));
  } finally {
    await stopServer(server);
  }
});

test('seedSprintTaskPolicy preserves sprint-type metadata when cloning statuses into a sprint', async () => {
  const db = getDb();
  await db.run(`UPDATE sprint_type_task_statuses SET metadata_json = ? WHERE sprint_type_key = ? AND status_key = ?`, '{"source":"legacy-seed"}', 'enhancements', 'review');
  await db.run(`DELETE FROM sprint_task_statuses WHERE sprint_id = ? AND status_key = ?`, 10, 'review');

  const { seedSprintTaskPolicy } = require('../domains/routing/policy') as typeof import('../domains/routing/policy');
  await seedSprintTaskPolicy(db, 10, { force: true });

  const sprintSeedRow = await db.get(`SELECT metadata_json FROM sprint_task_statuses WHERE sprint_id = ? AND status_key = ?`, 10, 'review') as { metadata_json: string } | undefined;
  expect(JSON.parse(sprintSeedRow?.metadata_json ?? '{}')).toEqual(expect.objectContaining({ source: 'legacy-seed' }));
});
