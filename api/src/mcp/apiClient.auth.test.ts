import express from 'express';
import type { Server } from 'http';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import { authenticateMcpApiKeyIfPresent, issueMcpApiKeyForAgent } from '../lib/mcpApiAuth';
import { getDefaultTenantId } from '../lib/tenantContext';
import tasksRouter from '../routes/tasks';
import { AgentHqApiClient } from './apiClient';

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', authenticateMcpApiKeyIfPresent);
  app.use('/api/v1/tasks', tasksRouter);
  const server = await new Promise<Server>((resolve, reject) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    bound.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function seedAtlasTask(): { agentId: number; taskId: number } {
  const db = getDb();
  const tenantId = getDefaultTenantId(db);
  const atlas = db.prepare(`
    SELECT id FROM agents
    WHERE system_role = 'atlas' OR openclaw_agent_id = 'atlas' OR name = 'Atlas'
    ORDER BY id ASC
    LIMIT 1
  `).get() as { id: number } | undefined;
  if (!atlas) throw new Error('Atlas seed agent missing');

  db.prepare(`INSERT INTO projects (id, tenant_id, name, description, context_md) VALUES (9101, ?, 'MCP Auth Test', '', '')`).run(tenantId);
  db.prepare(`
    INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
    VALUES (9103, ?, 9101, 'MCP Auth Workflow', '', 'dev', 'active', 'time', '2w')
  `).run(tenantId);
  db.prepare(`
    INSERT INTO tasks (id, tenant_id, title, description, status, priority, project_id, sprint_id, agent_id, task_type, custom_fields_json)
    VALUES (9102, ?, 'MCP auth task', '', 'todo', 'medium', 9101, 9103, ?, 'backend', '{}')
  `).run(tenantId, atlas.id);

  return { agentId: atlas.id, taskId: 9102 };
}

function seedCustomFieldWorkflow(): { projectId: number; sprintId: number } {
  const db = getDb();
  db.prepare(`INSERT INTO projects (id, name, description, context_md) VALUES (9201, 'Custom Field Workflow Test', '', '')`).run();
  db.prepare(`
    INSERT INTO sprints (id, project_id, name, goal, sprint_type, status)
    VALUES (9202, 9201, 'Configurable Workflow', '', 'custom_mcp', 'active')
  `).run();
  db.prepare(`
    INSERT INTO task_field_schemas (tenant_id, sprint_type_key, task_type, schema_json)
    VALUES (1, 'custom_mcp', NULL, ?)
  `).run(JSON.stringify({
    fields: [
      { key: 'target_surface', label: 'Target Surface', type: 'select', options: ['api', 'ui'], required: true },
      { key: 'risk_score', label: 'Risk Score', type: 'number' },
      { key: 'implementation_notes', label: 'Implementation Notes', type: 'textarea' },
    ],
  }));

  return { projectId: 9201, sprintId: 9202 };
}

describe('Agent HQ MCP API identity propagation', () => {
  beforeEach(() => {
    closeDb();
    initSchema();
  });

  afterEach(() => {
    closeDb();
  });

  it('allows an MCP task status update when the API key maps to Atlas and audits the resolved agent', async () => {
    const { agentId, taskId } = seedAtlasTask();
    const { apiKey } = issueMcpApiKeyForAgent(getDb(), agentId, 'test atlas key');
    const { server, baseUrl } = await startTestServer();

    try {
      const client = new AgentHqApiClient(baseUrl, apiKey);
      await client.moveTask(taskId, { status: 'ready' });

      const task = getDb().prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string };
      const history = getDb().prepare(`
        SELECT changed_by, field, old_value, new_value
        FROM task_history
        WHERE task_id = ? AND field = 'status'
        ORDER BY id DESC
        LIMIT 1
      `).get(taskId) as { changed_by: string; field: string; old_value: string; new_value: string };

      expect(task.status).toBe('ready');
      expect(history).toMatchObject({
        changed_by: 'atlas',
        field: 'status',
        old_value: 'todo',
        new_value: 'ready',
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects an MCP task status update with an invalid or unmapped API key', async () => {
    const { taskId } = seedAtlasTask();
    const { server, baseUrl } = await startTestServer();

    try {
      const client = new AgentHqApiClient(baseUrl, 'ahq_mcp_invalid');
      await expect(client.moveTask(taskId, { status: 'ready' })).rejects.toThrow('Invalid MCP API key');

      const task = getDb().prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string };
      expect(task.status).toBe('todo');
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates and updates tasks with workflow custom fields through the MCP API client', async () => {
    const { agentId } = seedAtlasTask();
    const { projectId, sprintId } = seedCustomFieldWorkflow();
    const { apiKey } = issueMcpApiKeyForAgent(getDb(), agentId, 'custom field create/update key');
    const { server, baseUrl } = await startTestServer();

    try {
      const client = new AgentHqApiClient(baseUrl, apiKey);
      const created = await client.createTask({
        title: 'Task with required custom field',
        project_id: projectId,
        sprint_id: sprintId,
        task_type: 'backend',
        custom_fields: {
          target_surface: 'api',
          risk_score: 2,
        },
      }) as { id: number; custom_fields?: Record<string, unknown> };

      expect(created.custom_fields).toMatchObject({
        target_surface: 'api',
        risk_score: 2,
      });

      await client.updateTask(created.id, {
        custom_fields: {
          implementation_notes: 'Preserve existing field values while changing one field.',
        },
      });

      const stored = getDb().prepare(`SELECT custom_fields_json FROM tasks WHERE id = ?`).get(created.id) as { custom_fields_json: string };
      expect(JSON.parse(stored.custom_fields_json)).toEqual({
        target_surface: 'api',
        risk_score: 2,
        implementation_notes: 'Preserve existing field values while changing one field.',
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('returns structured validation errors for invalid workflow custom fields', async () => {
    const { agentId } = seedAtlasTask();
    const { projectId, sprintId } = seedCustomFieldWorkflow();
    const { apiKey } = issueMcpApiKeyForAgent(getDb(), agentId, 'custom field validation key');
    const { server, baseUrl } = await startTestServer();

    try {
      const client = new AgentHqApiClient(baseUrl, apiKey);
      await expect(client.createTask({
        title: 'Task missing custom fields',
        project_id: projectId,
        sprint_id: sprintId,
        task_type: 'backend',
        custom_fields: {
          target_surface: 'mobile',
          risk_score: 'high',
          unknown_field: true,
        },
      })).rejects.toMatchObject({
        status: 400,
        body: {
          error: 'Unknown custom field "unknown_field"',
          validation_errors: expect.arrayContaining([
            expect.objectContaining({ field: 'unknown_field', code: 'unknown_field' }),
            expect.objectContaining({ field: 'target_surface', code: 'invalid_select_value', allowed_values: ['api', 'ui'] }),
            expect.objectContaining({ field: 'risk_score', code: 'invalid_type', expected: 'number' }),
          ]),
        },
      });

      await expect(client.createTask({
        title: 'Task missing required custom field',
        project_id: projectId,
        sprint_id: sprintId,
        task_type: 'backend',
      })).rejects.toMatchObject({
        status: 400,
        body: {
          validation_errors: expect.arrayContaining([
            expect.objectContaining({ field: 'target_surface', code: 'required' }),
          ]),
        },
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('keeps default workflow task creation compatible without custom fields', async () => {
    const { agentId } = seedAtlasTask();
    const { apiKey } = issueMcpApiKeyForAgent(getDb(), agentId, 'default workflow create key');
    const { server, baseUrl } = await startTestServer();

    try {
      const client = new AgentHqApiClient(baseUrl, apiKey);
      const created = await client.createTask({
        title: 'Default workflow compatible task',
        project_id: 9101,
        sprint_id: 9103,
        task_type: 'backend',
      }) as { id: number; title: string; custom_fields?: Record<string, unknown> };

      expect(created).toMatchObject({
        title: 'Default workflow compatible task',
        custom_fields: {},
      });
    } finally {
      await stopTestServer(server);
    }
  });
});
