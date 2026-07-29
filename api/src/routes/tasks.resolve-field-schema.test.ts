import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import tasksRouter from './tasks';

const ORIGINAL_DB_PATH = process.env.AGENT_HQ_DB_PATH;

function restoreEnv(name: string, value: string | undefined): void {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tasks', tasksRouter);
  const server = await new Promise<Server>((resolve, reject) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    bound.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function seedFieldSchemaFixture(): Promise<void> {
  const db = getDb();

  await db.run(`INSERT INTO projects (id, name, description, context_md) VALUES (86, 'Agent HQ', '', '')`);
  await db.run(`INSERT INTO sprints (id, project_id, name, goal, sprint_type, status) VALUES (42, 86, 'Backend Domain Refactor', '', 'dev', 'active')`);
  await db.run(`DELETE FROM sprint_type_task_types WHERE sprint_type_key = 'dev'`);
  await db.run(`INSERT INTO sprint_type_task_types (tenant_id, sprint_type_key, task_type) VALUES (1, 'dev', 'backend'), (1, 'dev', 'frontend'), (1, 'dev', 'qa')`);
  await db.run(`DELETE FROM task_field_schemas WHERE sprint_type_key IN ('generic', 'dev') AND task_type IS NULL`);
  await db.run(`DELETE FROM task_field_schemas WHERE sprint_type_key = 'dev' AND task_type = 'backend'`);
  await db.run(`
    INSERT INTO task_field_schemas (tenant_id, sprint_type_key, task_type, schema_json)
    VALUES
      (1, 'generic', NULL, ?),
      (1, 'dev', NULL, ?),
      (1, 'dev', 'backend', ?)
  `, JSON.stringify({ fields: [{ key: 'generic_only', label: 'Generic Only', type: 'text' }] }), JSON.stringify({ fields: [
          { key: 'review_branch', label: 'Review Branch', type: 'text', required: true },
          { key: 'review_commit', label: 'Review Commit', type: 'text', required: true },
          { key: 'qa_verified_commit', label: 'QA Verified Commit', type: 'text' },
        ] }), JSON.stringify({ fields: [
          { key: 'target_surface', label: 'Target Surface', type: 'select', options: ['api', 'ui'] },
          { key: 'review_commit', label: 'Backend Review Commit', type: 'text', help_text: 'Backend-specific label override.' },
        ] }));
}

describe('GET /api/v1/tasks/field-schema/resolve', () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-field-schema-resolve-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq.db');
    closeDb();
    await initSchema();
    await seedFieldSchemaFixture();
    ({ server, baseUrl } = await startServer());
  });

  afterEach(async () => {
    await stopServer(server);
    closeDb();
    restoreEnv('AGENT_HQ_DB_PATH', ORIGINAL_DB_PATH);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves the sprint-type schema when sprint_type is provided directly', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/field-schema/resolve?sprint_type=dev&task_type=backend`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      sprint_type: string;
      allowed_task_types: string[];
      fields: Array<{ key: string }>;
      schema: { fields: Array<{ key: string }> };
    };

    expect(body.sprint_type).toBe('dev');
    expect(body.allowed_task_types).toEqual(['backend', 'frontend', 'qa']);
    expect(body.fields.map((field) => field.key)).toEqual(['review_branch', 'review_commit', 'qa_verified_commit', 'target_surface']);
    expect(body.fields.find((field) => field.key === 'review_commit')).toEqual(expect.objectContaining({
      label: 'Backend Review Commit',
      help_text: 'Backend-specific label override.',
    }));
    expect(body.schema.fields.map((field) => field.key)).toEqual(['review_branch', 'review_commit', 'qa_verified_commit', 'target_surface']);
  });

  it('still resolves the sprint-type schema when sprint_id is provided', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/field-schema/resolve?sprint_id=42&task_type=backend`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      sprint_type: string;
      fields: Array<{ key: string }>;
    };

    expect(body.sprint_type).toBe('dev');
    expect(body.fields.map((field) => field.key)).toEqual(['review_branch', 'review_commit', 'qa_verified_commit', 'target_surface']);
  });

  it('returns only workflow default fields when no task-type schema is configured', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/field-schema/resolve?sprint_id=42&task_type=qa`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      sprint_type: string;
      fields: Array<{ key: string }>;
    };

    expect(body.sprint_type).toBe('dev');
    expect(body.fields.map((field) => field.key)).toEqual(['review_branch', 'review_commit', 'qa_verified_commit']);
  });
});
