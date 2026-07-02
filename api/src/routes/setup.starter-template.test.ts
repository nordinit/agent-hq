import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import { saveRuntimeConnectionConfig } from '../lib/runtimeOnboarding';
import setupRouter from './setup';

const originalDbPath = process.env.AGENT_HQ_DB_PATH;
let tempDir = '';

function resetDb(): void {
  closeDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-setup-template-'));
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

function seedCompatibility(): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO provider_config (tenant_id, slug, display_name, status, config)
    VALUES (1, 'openai', 'OpenAI', 'connected', '{}')
  `).run();
  saveRuntimeConnectionConfig(db, {
    kind: 'openclaw',
    endpoint: 'ws://127.0.0.1:17601',
    authToken: 'test',
  });
}

describe('starter template setup API', () => {
  beforeEach(resetDb);
  afterEach(cleanup);

  it('previews software QA routes from ownership answers and applies consistent records', async () => {
    seedCompatibility();
    const { server, baseUrl } = await startServer();
    try {
      const payload = {
        template_key: 'software-qa',
        project_name: 'Acme App',
        workflow_name: 'Delivery',
        owners: {
          implementation: 'Cinder Dev',
          review: 'QA Desk',
          pm: 'Atlas PM',
        },
        routing_plan: [
          { task_type: 'frontend', status: 'ready', owner_role: 'implementation', owner_name: 'Cinder Dev', enabled: false },
          { task_type: 'docs', status: 'ready', owner_role: 'pm', owner_name: 'Atlas PM', enabled: true },
        ],
      };

      const previewRes = await fetch(`${baseUrl}/api/v1/setup/starter-plan/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as Record<string, any>;
      expect(preview.plan.compatibility.ok).toBe(true);
      expect(preview.plan.routes).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'backend:ready', owner_name: 'Cinder Dev' }),
        expect.objectContaining({ key: 'frontend:ready', enabled: false }),
        expect.objectContaining({ key: 'docs:ready', owner_role: 'pm' }),
      ]));

      const applyRes = await fetch(`${baseUrl}/api/v1/setup/starter-plan/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(applyRes.status).toBe(201);
      const applied = await applyRes.json() as Record<string, any>;
      expect(applied.project_id).toBeGreaterThan(0);
      expect(applied.workflow_id).toBeGreaterThan(0);
      expect(applied.agent_ids.implementation).toBeGreaterThan(0);
      expect(applied.agent_ids.review).toBeGreaterThan(0);
      expect(applied.agent_ids.pm).toBeGreaterThan(0);

      const db = getDb();
      const agentCount = (db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE project_id = ?`).get(applied.project_id) as { n: number }).n;
      expect(agentCount).toBe(3);
      const disabledRoute = db.prepare(`
        SELECT enabled
        FROM sprint_task_routing_rules
        WHERE sprint_id = ? AND task_type = 'frontend' AND status = 'ready'
      `).get(applied.workflow_id) as { enabled: number } | undefined;
      expect(disabledRoute?.enabled).toBe(0);
      const docsRoute = db.prepare(`
        SELECT rr.agent_id, a.name
        FROM sprint_task_routing_rules rr
        JOIN agents a ON a.id = rr.agent_id
        WHERE rr.sprint_id = ? AND rr.task_type = 'docs' AND rr.status = 'ready'
      `).get(applied.workflow_id) as { name: string } | undefined;
      expect(docsRoute?.name).toBe('Atlas PM');
    } finally {
      await stopServer(server);
    }
  });

  it('blocks apply before creating starter agents when runtime or provider compatibility is missing', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const applyRes = await fetch(`${baseUrl}/api/v1/setup/starter-plan/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_key: 'software-qa', project_name: 'Blocked' }),
      });
      expect(applyRes.status).toBe(422);
      const body = await applyRes.json() as Record<string, any>;
      expect(body.code).toBe('starter_template_incompatible');
      expect(body.compatibility.errors.join('\n')).toMatch(/connected provider/);

      const db = getDb();
      const project = db.prepare(`SELECT id FROM projects WHERE name = 'Blocked'`).get();
      expect(project).toBeUndefined();
    } finally {
      await stopServer(server);
    }
  });
});
