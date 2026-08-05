import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import tasksRouter from './tasks';

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

/** Resolves or creates the explicit tenant parent required by the workflow-definition rows. */
async function resolveTenantId(): Promise<number> {
  const db = getDb();
  const existing = await db.get(
    `SELECT id FROM tenants ORDER BY is_default DESC, id ASC LIMIT 1`,
  ) as { id: number } | undefined;
  if (existing) return Number(existing.id);
  const inserted = await db.run(
    `INSERT INTO tenants (name, slug, is_default) VALUES ('Agent HQ', 'agent-hq', 1)`,
  );
  return Number(inserted.lastInsertId);
}

const GENERIC_SCHEMA = JSON.stringify({
  fields: [{ key: 'generic_only', label: 'Generic Only', type: 'text' }],
});
const DEV_SCHEMA = JSON.stringify({
  fields: [
    { key: 'review_branch', label: 'Review Branch', type: 'text', required: true },
    { key: 'review_commit', label: 'Review Commit', type: 'text', required: true },
    { key: 'qa_verified_commit', label: 'QA Verified Commit', type: 'text' },
  ],
});
const DEV_BACKEND_SCHEMA = JSON.stringify({
  fields: [
    { key: 'target_surface', label: 'Target Surface', type: 'select', options: ['api', 'ui'] },
    { key: 'review_commit', label: 'Backend Review Commit', type: 'text', help_text: 'Backend-specific label override.' },
  ],
});

async function seedFieldSchemaFixture(): Promise<{ sprintId: number }> {
  const db = getDb();
  const tenantId = await resolveTenantId();

  const project = await db.run(
    `INSERT INTO projects (tenant_id, name, description, context_md) VALUES (?, 'Agent HQ', '', '')`,
    tenantId,
  );
  const sprint = await db.run(
    `INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status)
     VALUES (?, ?, 'Backend Domain Refactor', '', 'dev', 'active')`,
    tenantId, Number(project.lastInsertId),
  );

  // The DELETEs make this fixture authoritative rather than additive if setup added definitions.
  await db.run(`DELETE FROM sprint_type_task_types WHERE sprint_type_key = 'dev'`);
  await db.run(
    `INSERT INTO sprint_type_task_types (tenant_id, sprint_type_key, task_type)
     VALUES (?, 'dev', 'backend'), (?, 'dev', 'frontend'), (?, 'dev', 'qa')`,
    tenantId, tenantId, tenantId,
  );
  await db.run(`DELETE FROM task_field_schemas WHERE sprint_type_key IN ('generic', 'dev') AND task_type IS NULL`);
  await db.run(`DELETE FROM task_field_schemas WHERE sprint_type_key = 'dev' AND task_type = 'backend'`);
  await db.run(`
    INSERT INTO task_field_schemas (tenant_id, sprint_type_key, task_type, schema_json)
    VALUES
      (?, 'generic', NULL, ?),
      (?, 'dev', NULL, ?),
      (?, 'dev', 'backend', ?)
  `, tenantId, GENERIC_SCHEMA, tenantId, DEV_SCHEMA, tenantId, DEV_BACKEND_SCHEMA);

  return { sprintId: Number(sprint.lastInsertId) };
}

describe('GET /api/v1/tasks/field-schema/resolve', () => {
  let server: Server;
  let baseUrl: string;
  let sprintId: number;

  beforeEach(async () => {
    await setupTestDb();
    ({ sprintId } = await seedFieldSchemaFixture());
    ({ server, baseUrl } = await startServer());
  });

  afterEach(async () => {
    await stopServer(server);
    await teardownTestDb();
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
    const res = await fetch(`${baseUrl}/api/v1/tasks/field-schema/resolve?sprint_id=${sprintId}&task_type=backend`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      sprint_type: string;
      fields: Array<{ key: string }>;
    };

    expect(body.sprint_type).toBe('dev');
    expect(body.fields.map((field) => field.key)).toEqual(['review_branch', 'review_commit', 'qa_verified_commit', 'target_surface']);
  });

  it('returns only workflow default fields when no task-type schema is configured', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/field-schema/resolve?sprint_id=${sprintId}&task_type=qa`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      sprint_type: string;
      fields: Array<{ key: string }>;
    };

    expect(body.sprint_type).toBe('dev');
    expect(body.fields.map((field) => field.key)).toEqual(['review_branch', 'review_commit', 'qa_verified_commit']);
  });
});
