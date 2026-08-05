import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/client';
import tasksRouter from './tasks';
import { requireReleaseGate } from '../lib/taskRelease';
import { validateInlineEvidenceForOutcome } from '../lib/evidenceValidation';

let tempDir: string;
let dbPath: string;

async function resetDb(): Promise<void> {
  await setupTestDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-qa-evidence-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');

  const db = getDb();

  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Agent HQ')`);
  await db.run(`INSERT INTO sprint_types (tenant_id, key, name, is_system) VALUES (1, 'generic', 'Generic', 1)`);
  await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type) VALUES (10, 1, 1, 'Bugs', 'generic')`);
  await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, enabled) VALUES (7, 1, 'Talon', 'agent:talon:main', 1)`);
  await db.run(`
    INSERT INTO tasks (id, tenant_id, title, status, task_type, sprint_id, project_id, agent_id, custom_fields_json, active_instance_id)
    VALUES (383, 1, 'Task 383', 'review', 'backend', 10, 1, 7, ?, NULL)
  `, JSON.stringify({ review_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329' }));
  await db.run(`INSERT INTO job_instances (id, tenant_id, task_id, agent_id, status, dispatched_at) VALUES (1784, 1, 383, 7, 'running', CURRENT_TIMESTAMP)`);
  await db.run(`INSERT INTO instance_artifacts (instance_id, task_id, current_stage, stale, updated_at) VALUES (1784, 383, 'progress', 0, CURRENT_TIMESTAMP)`);
  await db.run(`INSERT INTO task_outcome_metrics (tenant_id, task_id, spawned_defects, updated_at) VALUES (1, 383, 0, CURRENT_TIMESTAMP)`);
  await db.run(`UPDATE tasks SET active_instance_id = 1784 WHERE id = 383`);
}

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tasks', tasksRouter);
  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
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

describe('tasks qa-evidence aliases', () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-qa-evidence-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    await resetDb();
  });

  afterEach(async () => {
    await teardownTestDb();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts canonical qa_tested_url on qa-evidence writes', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/383/qa-evidence`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qa_verified_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
          qa_tested_url: 'http://localhost:3501/api/v1/tasks/383',
          summary: 'QA verification of task 383 provider-limit false-live handling.',
          changed_by: 'talon-qa',
          instance_id: 1784,
        }),
      });
      const body = await response.json() as { custom_fields?: { qa_tested_url?: string | null }; error?: string };

      if (response.status !== 200) {
        throw new Error(`Expected 200, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body).not.toHaveProperty('qa_tested_url');
      expect(body.custom_fields?.qa_tested_url).toBe('http://localhost:3501/api/v1/tasks/383');

      const db = getDb();
      const row = await db.get(`SELECT custom_fields_json FROM tasks WHERE id = ?`, 383) as { custom_fields_json: string };
      expect(JSON.parse(row.custom_fields_json)).toEqual(expect.objectContaining({
        qa_tested_url: 'http://localhost:3501/api/v1/tasks/383',
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('still accepts legacy tested_url alias on qa-evidence writes', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/383/qa-evidence`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qa_verified_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
          tested_url: 'http://localhost:3501/api/v1/tasks/383?legacy=1',
          changed_by: 'talon-qa',
          instance_id: 1784,
        }),
      });
      const body = await response.json() as { custom_fields?: { qa_tested_url?: string | null }; error?: string };

      if (response.status !== 200) {
        throw new Error(`Expected 200, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body).not.toHaveProperty('qa_tested_url');
      expect(body.custom_fields?.qa_tested_url).toBe('http://localhost:3501/api/v1/tasks/383?legacy=1');
    } finally {
      await stopTestServer(server);
    }
  });

  it('accepts older QA contract aliases without silently dropping evidence', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/383/qa-evidence`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verified_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
          qa_url: 'http://localhost:3501/api/v1/tasks/383?contract=old',
          changed_by: 'talon-qa',
          instance_id: 1784,
        }),
      });
      const body = await response.json() as {
        custom_fields?: { qa_verified_commit?: string | null; qa_tested_url?: string | null };
        error?: string;
      };

      if (response.status !== 200) {
        throw new Error(`Expected 200, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body).not.toHaveProperty('qa_verified_commit');
      expect(body).not.toHaveProperty('qa_tested_url');
      expect(body.custom_fields?.qa_verified_commit).toBe('6d614b3b104ae36d1dd75210b9f9fb0342673329');
      expect(body.custom_fields?.qa_tested_url).toBe('http://localhost:3501/api/v1/tasks/383?contract=old');

      const db = getDb();
      const row = await db.get(`SELECT custom_fields_json FROM tasks WHERE id = ?`, 383) as { custom_fields_json: string };
      expect(JSON.parse(row.custom_fields_json)).toEqual(expect.objectContaining({
        qa_verified_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
        qa_tested_url: 'http://localhost:3501/api/v1/tasks/383?contract=old',
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects review evidence from a stopped instance after task linkage is cleared', async () => {
    const db = getDb();
    await db.run(`UPDATE tasks SET active_instance_id = NULL WHERE id = ?`, 383);
    await db.run(`UPDATE job_instances SET task_id = NULL, status = 'failed' WHERE id = ?`, 1784);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/383/review-evidence`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          review_branch: 'cinder/task-383-late',
          review_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          changed_by: 'cinder-backend',
          instance_id: 1784,
        }),
      });
      const body = await response.json() as {
        error?: string;
        reason?: string;
        callback_task_id?: number | null;
        callback_agent_id?: number | null;
        task_agent_id?: number | null;
      };

      expect(response.status).toBe(409);
      expect(body).toMatchObject({
        error: 'Stale instance: review evidence write rejected',
        reason: 'instance_not_authoritative',
        callback_task_id: null,
        callback_agent_id: 7,
        task_agent_id: 7,
      });

      const row = await db.get(`SELECT custom_fields_json FROM tasks WHERE id = ?`, 383) as { custom_fields_json: string };
      expect(JSON.parse(row.custom_fields_json).review_commit).toBe('6d614b3b104ae36d1dd75210b9f9fb0342673329');
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects QA evidence from a stopped instance after task linkage is cleared', async () => {
    const db = getDb();
    await db.run(`UPDATE tasks SET active_instance_id = NULL WHERE id = ?`, 383);
    await db.run(`UPDATE job_instances SET task_id = NULL, status = 'failed' WHERE id = ?`, 1784);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/383/qa-evidence`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qa_verified_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
          qa_tested_url: 'http://localhost:3501/review/task/383',
          changed_by: 'talon-qa',
          instance_id: 1784,
        }),
      });
      const body = await response.json() as {
        error?: string;
        reason?: string;
        callback_task_id?: number | null;
        callback_agent_id?: number | null;
        task_agent_id?: number | null;
      };

      expect(response.status).toBe(409);
      expect(body).toMatchObject({
        error: 'Stale instance: QA evidence write rejected',
        reason: 'instance_not_authoritative',
        callback_task_id: null,
        callback_agent_id: 7,
        task_agent_id: 7,
      });

      const row = await db.get(`SELECT custom_fields_json FROM tasks WHERE id = ?`, 383) as { custom_fields_json: string };
      expect(JSON.parse(row.custom_fields_json)).toEqual({
        review_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('refreshes review evidence to the latest commit on re-submission for review', async () => {
    const db = getDb();
    await db.run(`UPDATE tasks SET status = ?, custom_fields_json = ? WHERE id = ?`, 'in_progress', JSON.stringify({
              review_branch: 'feature/task-383-old',
              review_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
              review_url: 'http://localhost:3510/review/task-383?attempt=1',
            }), 383);
    await db.run(`INSERT INTO routing_config (tenant_id, from_status, outcome, to_status, enabled, project_id) VALUES (1, ?, ?, ?, 1, ?)`, 'in_progress', 'completed_for_review', 'review', 1);

    const { server, baseUrl } = await startTestServer();
    try {
      const newCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const beforePreview = {
        task: await db.get(`SELECT status, custom_fields_json FROM tasks WHERE id = ?`, 383),
        history: (await db.get(`SELECT COUNT(*) AS count FROM task_history WHERE task_id = ?`, 383) as { count: number }).count,
        notes: (await db.get(`SELECT COUNT(*) AS count FROM task_notes WHERE task_id = ?`, 383) as { count: number }).count,
        instance: await db.get(`SELECT status, task_outcome, lifecycle_outcome_posted_at FROM job_instances WHERE id = ?`, 1784),
      };
      const previewResponse = await fetch(`${baseUrl}/api/v1/tasks/383/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dry_run: true,
          outcome: 'completed_for_review',
          summary: 'Preview re-submission after QA fixes.',
          changed_by: 'cinder-backend',
          instance_id: 1784,
          payload: {
            review_branch: 'feature/task-383-rereview',
            review_commit: newCommit,
            review_url: 'http://localhost:3510/review/task-383?attempt=2',
          },
        }),
      });
      const previewBody = await previewResponse.json() as { dry_run?: boolean; proposed_changes?: { status?: { from?: string; to?: string } }; validation_errors?: string[] };
      expect(previewResponse.status).toBe(200);
      expect(previewBody.dry_run).toBe(true);
      expect(previewBody.proposed_changes?.status).toEqual({ from: 'in_progress', to: 'review' });
      expect(previewBody.validation_errors).toEqual([]);
      expect(await db.get(`SELECT status, custom_fields_json FROM tasks WHERE id = ?`, 383)).toEqual(beforePreview.task);
      expect((await db.get(`SELECT COUNT(*) AS count FROM task_history WHERE task_id = ?`, 383) as { count: number }).count).toBe(beforePreview.history);
      expect((await db.get(`SELECT COUNT(*) AS count FROM task_notes WHERE task_id = ?`, 383) as { count: number }).count).toBe(beforePreview.notes);
      expect(await db.get(`SELECT status, task_outcome, lifecycle_outcome_posted_at FROM job_instances WHERE id = ?`, 1784)).toEqual(beforePreview.instance);

      const response = await fetch(`${baseUrl}/api/v1/tasks/383/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outcome: 'completed_for_review',
          summary: 'Re-submitting after QA fixes.',
          changed_by: 'cinder-backend',
          instance_id: 1784,
          payload: {
            review_branch: 'feature/task-383-rereview',
            review_commit: newCommit,
            review_url: 'http://localhost:3510/review/task-383?attempt=2',
          },
        }),
      });
      const body = await response.json() as {
        task?: {
          custom_fields?: {
            review_branch?: string | null;
            review_commit?: string | null;
            review_url?: string | null;
          };
          status?: string;
        };
        error?: string;
      };

      if (response.status !== 200) {
        throw new Error(`Expected 200, received ${response.status}: ${JSON.stringify(body)}`);
      }

      expect(body.task?.status).toBe('review');
      expect(body.task ?? {}).not.toHaveProperty('review_branch');
      expect(body.task ?? {}).not.toHaveProperty('review_commit');
      expect(body.task ?? {}).not.toHaveProperty('review_url');
      expect(body.task?.custom_fields?.review_branch).toBe('feature/task-383-rereview');
      expect(body.task?.custom_fields?.review_commit).toBe(newCommit);
      expect(body.task?.custom_fields?.review_url).toBe('http://localhost:3510/review/task-383?attempt=2');

      const row = await db.get(`SELECT custom_fields_json, status FROM tasks WHERE id = ?`, 383) as {
        custom_fields_json: string;
        status: string;
      };
      expect(row.status).toBe('review');
      expect(JSON.parse(row.custom_fields_json)).toEqual(expect.objectContaining({
        review_branch: 'feature/task-383-rereview',
        review_commit: newCommit,
        review_url: 'http://localhost:3510/review/task-383?attempt=2',
      }));

      const reviewHistory = await db.all(`
        SELECT field, old_value, new_value
        FROM task_history
        WHERE task_id = ? AND field IN ('review_branch', 'review_commit', 'review_url')
        ORDER BY id ASC
      `, 383) as Array<{ field: string; old_value: string | null; new_value: string | null }>;
      expect(reviewHistory).toEqual([
        { field: 'review_branch', old_value: 'feature/task-383-old', new_value: 'feature/task-383-rereview' },
        { field: 'review_commit', old_value: '6d614b3b104ae36d1dd75210b9f9fb0342673329', new_value: newCommit },
        { field: 'review_url', old_value: 'http://localhost:3510/review/task-383?attempt=1', new_value: 'http://localhost:3510/review/task-383?attempt=2' },
      ]);
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects legacy top-level lifecycle evidence on unversioned outcome requests', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/383/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dry_run: true,
          outcome: 'completed_for_review',
          summary: 'Legacy top-level evidence should not be accepted.',
          changed_by: 'cinder-backend',
          instance_id: 1784,
          review_branch: 'feature/task-383-rereview',
          review_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        ok: false,
        code: 'top_level_lifecycle_evidence_not_supported',
        fields: ['review_branch', 'review_commit'],
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('allows qa_pass release-gate validation for the localhost:3501 review artifact URL', async () => {
    const db = getDb();
    await db.run(`UPDATE tasks SET custom_fields_json = ? WHERE id = ?`, JSON.stringify({
            review_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
            qa_verified_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
            qa_tested_url: 'http://localhost:3501/review/task/383',
          }), 383);

    const task = await db.get(`
      SELECT id, status, task_type, sprint_id, custom_fields_json
      FROM tasks
      WHERE id = ?
    `, 383) as {
      id: number;
      status: string;
      task_type: string | null;
      sprint_id: number | null;
      custom_fields_json: string | null;
    };

    const result = await requireReleaseGate(db, task, 'qa_pass', task.task_type);
    expect(result.errors).toEqual([]);
  });

  it('does not infer inline evidence requirements from outcome names', () => {
    const reviewResult = validateInlineEvidenceForOutcome('completed_for_review', {}, {}, []);
    const qaResult = validateInlineEvidenceForOutcome('qa_pass', {}, {}, []);
    const deployResult = validateInlineEvidenceForOutcome('deployed_live', {}, {}, []);

    expect(reviewResult.errors).toEqual([]);
    expect(qaResult.errors).toEqual([]);
    expect(deployResult.errors).toEqual([]);
  });

  it('enforces inline evidence requirements from configured gate rows', () => {
    const result = validateInlineEvidenceForOutcome(
      'custom_review_ready',
      { review_branch: 'feature/task-383' },
      {},
      [
        {
          field_name: 'review_commit',
          requirement_type: 'required',
          match_field: null,
          severity: 'block',
          message: 'custom gate requires review_commit',
        },
      ],
    );

    expect(result.errors).toEqual(['custom gate requires review_commit']);
  });

  it('supports configured OR field expressions for release gates', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO sprint_task_transition_requirements (tenant_id, sprint_id, project_id, sprint_type, task_type, outcome, field_name, requirement_type, match_field, severity, message)
      VALUES (1, 10, 1, 'generic', NULL, 'deployed_live', 'merged_commit|deployed_commit', 'required', NULL, 'block', 'deployed_live requires merged_commit or deployed_commit')
    `);

    const result = await requireReleaseGate(db, {
          id: 383,
          status: 'ready_to_merge',
          task_type: 'backend',
          sprint_id: 10,
          custom_fields_json: JSON.stringify({
            deployed_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
          }),
        }, 'deployed_live', 'backend');

    expect(result.errors).toEqual([]);
  });

  it('rejects premature or malformed live_verified release-gate validation when the workflow config requires it', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO sprint_task_transition_requirements (tenant_id, sprint_id, project_id, sprint_type, task_type, outcome, field_name, requirement_type, match_field, severity, message)
      VALUES
        (1, 10, 1, 'generic', NULL, 'live_verified', 'status', 'from_status', 'deployed', 'block', 'live_verified requires task status deployed'),
        (1, 10, 1, 'generic', NULL, 'live_verified', 'live_verified_by', 'required', NULL, 'block', 'live_verified requires live_verified_by'),
        (1, 10, 1, 'generic', NULL, 'live_verified', 'live_verified_at', 'required', NULL, 'block', 'live_verified requires live_verified_at')
    `);

    const result = await requireReleaseGate(db, {
          id: 383,
          status: 'ready_to_merge',
          task_type: 'backend',
          sprint_id: 10,
          custom_fields_json: JSON.stringify({
            deployed_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
            live_verified_by: null,
            live_verified_at: null,
          }),
        }, 'live_verified', 'backend');

    expect(result.errors).toEqual(expect.arrayContaining([
      'live_verified requires task status deployed',
      'live_verified requires live_verified_by',
      'live_verified requires live_verified_at',
    ]));
  });
});
