import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import instancesRouter from './instances';

jest.mock('../services/browserPool', () => ({
  createAgentContext: jest.fn(() => Promise.resolve({})),
  destroyAgentContext: jest.fn(() => Promise.resolve()),
}));

async function seedFixture(): Promise<void> {
  const db = await setupTestDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Agent HQ', 'agent-hq', 1)`);
  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
  `);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (86, 1, 'Agent HQ')`);
  await db.run(`
    INSERT INTO sprint_types (tenant_id, key, name, description, is_system)
    VALUES (1, 'dev', 'Development', '', 1)
  `);
  await db.run(`
    INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status)
    VALUES (42, 1, 86, 'Development', '', 'dev', 'active')
  `);
  await db.run(`
    INSERT INTO agents (
      id, tenant_id, project_id, sprint_id, name, role, session_key, runtime_type
    ) VALUES (
      96, 1, 86, 42, 'Talon (QA)', 'QA Engineer', 'agency-qa', 'openclaw'
    )
  `);
  await db.run(`
    INSERT INTO tasks (
      id, tenant_id, title, status, task_type, sprint_id, project_id, agent_id,
      custom_fields_json, updated_at
    ) VALUES (
      403,
      1,
      'Prevent outcome-less run completions from closing cleanly or redispatching blindly',
      'review',
      'backend',
      42,
      86,
      96,
      ?,
      CURRENT_TIMESTAMP
    )
  `, JSON.stringify({
    review_branch: 'cinder-backend/task-403-prevent-outcome-less-run-completions-fro',
    review_commit: '2997dcc8cec51f6fe0dfec2ab882668b83d482df',
    review_url: 'http://localhost:3510/tasks/403',
  }));
  await db.run(`
    INSERT INTO job_instances (
      id, tenant_id, agent_id, task_id, status, session_key, dispatched_at, started_at
    ) VALUES (2045, 1, 96, 403, 'running', 'run:2045', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  await db.run(`UPDATE tasks SET active_instance_id = 2045 WHERE id = 403`);
}

function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/instances', instancesRouter);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('instance completion lifecycle handoff recovery', () => {
  beforeEach(seedFixture);
  afterEach(teardownTestDb);

  it('persists the structured operator note when a lifecycle-managed run completes without an outcome', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/instances/2045/complete`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: 'done',
          summary: 'QA simulation: runtime ended without posting lifecycle outcome after the final note-path patch.',
        }),
      });

      if (response.status !== 200) {
        throw new Error(await response.text());
      }
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, id: 2045, status: 'done' });

      const db = getDb();
      const task = await db.get(`SELECT status, previous_status FROM tasks WHERE id = 403`) as {
        status: string;
        previous_status: string | null;
      };
      expect(task).toEqual({ status: 'review', previous_status: null });

      const instance = await db.get(`
        SELECT status, runtime_end_success, runtime_end_error, lifecycle_handoff_status, semantic_outcome_missing, lifecycle_outcome_posted_at, task_outcome
        FROM job_instances
        WHERE id = 2045
      `) as {
        status: string;
        runtime_end_success: number | null;
        runtime_end_error: string | null;
        lifecycle_handoff_status: string | null;
        semantic_outcome_missing: number | null;
        lifecycle_outcome_posted_at: string | null;
        task_outcome: string | null;
      };
      expect(instance).toEqual({
        status: 'done',
        runtime_end_success: 1,
        runtime_end_error: 'Runtime ended without required lifecycle outcome',
        lifecycle_handoff_status: 'missing',
        semantic_outcome_missing: 1,
        lifecycle_outcome_posted_at: null,
        task_outcome: null,
      });

      const notes = await db.all(`SELECT author, content FROM task_notes WHERE task_id = 403 ORDER BY id`) as Array<{
        author: string;
        content: string;
      }>;
      expect(notes).toHaveLength(1);
      expect(notes[0].author).toBe('agent:96');
      expect(notes[0].content).toContain('Summary: run ended without required lifecycle outcome');
      expect(notes[0].content).toContain('Instance ID: 2045');
      expect(notes[0].content).toContain('Session key: run:2045');
      expect(notes[0].content).toContain('Workflow phase: review');
      expect(notes[0].content).toContain('Prior task status: review');
      expect(notes[0].content).toContain('Runtime ended successfully: yes');
      expect(notes[0].content).toContain('Review/QA/deploy evidence recorded: no');
      expect(notes[0].content).toContain('Recommended next action: inspect the missing lifecycle outcome, then choose an explicit routed move or outcome');
      expect(notes[0].content).not.toContain('Moved to Needs Attention because the runtime ended without a semantic lifecycle outcome.');

      const event = await db.get(`
        SELECT anomaly_type, instance_id, detail
        FROM integrity_events
        WHERE task_id = 403
      `) as { anomaly_type: string; instance_id: number; detail: string };
      expect(event).toEqual({
        anomaly_type: 'missing_lifecycle_handoff',
        instance_id: 2045,
        detail: 'Runtime ended on instance #2045 without required lifecycle outcome; workflow event no_semantic_handoff_posted action=none',
      });
    } finally {
      await stopTestServer(server);
    }
  });
});
