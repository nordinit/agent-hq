import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import tasksRouter from './tasks';
import { requireReleaseGate } from '../lib/taskRelease';
import { validateInlineEvidenceForOutcome } from '../lib/evidenceValidation';

let tempDir: string;
let dbPath: string;

function resetDb(): void {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-qa-evidence-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;

  const db = getDb();
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sprint_type TEXT NOT NULL DEFAULT 'generic'
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      task_type TEXT,
      sprint_id INTEGER,
      project_id INTEGER,
      agent_id INTEGER,
      origin_task_id INTEGER,
      review_commit TEXT,
      qa_verified_commit TEXT,
      qa_tested_url TEXT,
      active_instance_id INTEGER,
      updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      changed_by TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      uploaded_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE instance_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER,
      task_id INTEGER,
      kind TEXT,
      label TEXT,
      value TEXT,
      current_stage TEXT,
      last_agent_heartbeat_at TEXT,
      last_meaningful_output_at TEXT,
      latest_commit_hash TEXT,
      branch_name TEXT,
      changed_files_json TEXT,
      changed_files_count INTEGER,
      summary TEXT,
      blocker_reason TEXT,
      outcome TEXT,
      stale INTEGER,
      stale_at TEXT,
      updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_outcome_metrics (
      task_id INTEGER PRIMARY KEY,
      spawned_defects INTEGER DEFAULT 0,
      last_outcome TEXT,
      last_outcome_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE task_defects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_dependencies (
      blocker_id INTEGER NOT NULL,
      blocked_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (blocker_id, blocked_id)
    );
    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      task_id INTEGER,
      agent_id INTEGER,
      status TEXT,
      session_key TEXT,
      task_outcome TEXT,
      lifecycle_outcome_posted_at TEXT,
      response TEXT,
      dispatched_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      runtime_ended_at TEXT,
      runtime_completed_at TEXT,
      runtime_end_success INTEGER,
      runtime_end_error TEXT,
      runtime_end_source TEXT,
      lifecycle_handoff_status TEXT,
      semantic_outcome_missing INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      job_title TEXT,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY,
      agent_id INTEGER
    );
    CREATE TABLE task_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      status_key TEXT,
      label TEXT,
      color TEXT,
      terminal INTEGER DEFAULT 0,
      is_system INTEGER DEFAULT 0,
      allowed_transitions_json TEXT DEFAULT '[]',
      stage_order INTEGER DEFAULT 0,
      is_default_entry INTEGER DEFAULT 0,
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_task_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      task_type TEXT,
      from_status TEXT NOT NULL,
      outcome TEXT NOT NULL,
      to_status TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      is_protected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_task_transition_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      task_type TEXT,
      outcome TEXT NOT NULL,
      field_name TEXT NOT NULL,
      requirement_type TEXT NOT NULL DEFAULT 'required',
      match_field TEXT,
      severity TEXT NOT NULL DEFAULT 'block',
      message TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_types (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_field_schemas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      task_type TEXT,
      schema_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.prepare(`INSERT INTO projects (id, name) VALUES (1, 'Agent HQ')`).run();
  db.prepare(`INSERT INTO sprint_types (key, name, is_system) VALUES ('generic', 'Generic', 1)`).run();
  db.prepare(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (10, 1, 'Bugs', 'generic')`).run();
  db.prepare(`INSERT INTO agents (id, name, enabled) VALUES (7, 'Talon', 1)`).run();
  db.prepare(`INSERT INTO tasks (id, title, status, task_type, sprint_id, project_id, agent_id, review_commit, active_instance_id) VALUES (383, 'Task 383', 'review', 'backend', 10, 1, 7, '6d614b3b104ae36d1dd75210b9f9fb0342673329', 1784)`).run();
  db.prepare(`INSERT INTO job_instances (id, task_id, agent_id, status, dispatched_at) VALUES (1784, 383, 7, 'running', datetime('now'))`).run();
  db.prepare(`INSERT INTO instance_artifacts (instance_id, task_id, current_stage, stale, updated_at) VALUES (1784, 383, 'progress', 0, datetime('now'))`).run();
  db.prepare(`INSERT INTO task_outcome_metrics (task_id, spawned_defects, updated_at) VALUES (383, 0, datetime('now'))`).run();
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
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-qa-evidence-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    resetDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
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
      const row = db.prepare(`SELECT qa_tested_url FROM tasks WHERE id = ?`).get(383) as { qa_tested_url: string | null };
      expect(row.qa_tested_url).toBe('http://localhost:3501/api/v1/tasks/383');
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
      const row = db.prepare(`SELECT qa_verified_commit, qa_tested_url FROM tasks WHERE id = ?`).get(383) as {
        qa_verified_commit: string | null;
        qa_tested_url: string | null;
      };
      expect(row).toEqual({
        qa_verified_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
        qa_tested_url: 'http://localhost:3501/api/v1/tasks/383?contract=old',
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects review evidence from a stopped instance after task linkage is cleared', async () => {
    const db = getDb();
    db.prepare(`UPDATE tasks SET active_instance_id = NULL WHERE id = ?`).run(383);
    db.prepare(`UPDATE job_instances SET task_id = NULL, status = 'failed' WHERE id = ?`).run(1784);

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

      const row = db.prepare(`SELECT review_commit FROM tasks WHERE id = ?`).get(383) as { review_commit: string | null };
      expect(row.review_commit).toBe('6d614b3b104ae36d1dd75210b9f9fb0342673329');
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects QA evidence from a stopped instance after task linkage is cleared', async () => {
    const db = getDb();
    db.prepare(`UPDATE tasks SET active_instance_id = NULL WHERE id = ?`).run(383);
    db.prepare(`UPDATE job_instances SET task_id = NULL, status = 'failed' WHERE id = ?`).run(1784);

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

      const row = db.prepare(`SELECT qa_verified_commit, qa_tested_url FROM tasks WHERE id = ?`).get(383) as {
        qa_verified_commit: string | null;
        qa_tested_url: string | null;
      };
      expect(row).toEqual({ qa_verified_commit: null, qa_tested_url: null });
    } finally {
      await stopTestServer(server);
    }
  });

  it('refreshes review evidence to the latest commit on re-submission for review', async () => {
    const db = getDb();
    db.exec(`
      ALTER TABLE tasks ADD COLUMN review_branch TEXT;
      ALTER TABLE tasks ADD COLUMN review_url TEXT;
      ALTER TABLE tasks ADD COLUMN review_owner_agent_id INTEGER;
      ALTER TABLE tasks ADD COLUMN previous_status TEXT;
      ALTER TABLE tasks ADD COLUMN merged_commit TEXT;
      ALTER TABLE tasks ADD COLUMN deployed_commit TEXT;
      ALTER TABLE tasks ADD COLUMN deployed_at TEXT;
      ALTER TABLE tasks ADD COLUMN live_verified_at TEXT;
      ALTER TABLE tasks ADD COLUMN live_verified_by TEXT;
      ALTER TABLE tasks ADD COLUMN deploy_target TEXT;
      ALTER TABLE tasks ADD COLUMN evidence_json TEXT;
      ALTER TABLE tasks ADD COLUMN failure_detail TEXT;
      ALTER TABLE job_instances ADD COLUMN failure_stage TEXT;
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER,
        job_title TEXT,
        level TEXT,
        message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE routing_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_status TEXT NOT NULL,
        outcome TEXT NOT NULL,
        to_status TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        project_id INTEGER
      );
      CREATE TABLE integrity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        project_id INTEGER,
        agent_id INTEGER,
        instance_id INTEGER,
        anomaly_type TEXT,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        project_id INTEGER,
        agent_id INTEGER,
        from_status TEXT,
        to_status TEXT,
        moved_by TEXT,
        move_type TEXT,
        instance_id INTEGER,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    db.prepare(`UPDATE tasks SET status = ?, review_branch = ?, review_url = ? WHERE id = ?`).run(
      'in_progress',
      'feature/task-383-old',
      'http://localhost:3510/review/task-383?attempt=1',
      383,
    );
    db.prepare(`INSERT INTO routing_config (from_status, outcome, to_status, enabled, project_id) VALUES (?, ?, ?, 1, ?)`).run(
      'in_progress',
      'completed_for_review',
      'review',
      1,
    );

    const { server, baseUrl } = await startTestServer();
    try {
      const newCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const beforePreview = {
        task: db.prepare(`SELECT status, review_branch, review_commit, review_url FROM tasks WHERE id = ?`).get(383),
        history: (db.prepare(`SELECT COUNT(*) AS count FROM task_history WHERE task_id = ?`).get(383) as { count: number }).count,
        notes: (db.prepare(`SELECT COUNT(*) AS count FROM task_notes WHERE task_id = ?`).get(383) as { count: number }).count,
        instance: db.prepare(`SELECT status, task_outcome, lifecycle_outcome_posted_at FROM job_instances WHERE id = ?`).get(1784),
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
      expect(db.prepare(`SELECT status, review_branch, review_commit, review_url FROM tasks WHERE id = ?`).get(383)).toEqual(beforePreview.task);
      expect((db.prepare(`SELECT COUNT(*) AS count FROM task_history WHERE task_id = ?`).get(383) as { count: number }).count).toBe(beforePreview.history);
      expect((db.prepare(`SELECT COUNT(*) AS count FROM task_notes WHERE task_id = ?`).get(383) as { count: number }).count).toBe(beforePreview.notes);
      expect(db.prepare(`SELECT status, task_outcome, lifecycle_outcome_posted_at FROM job_instances WHERE id = ?`).get(1784)).toEqual(beforePreview.instance);

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

      const row = db.prepare(`SELECT review_branch, review_commit, review_url, status FROM tasks WHERE id = ?`).get(383) as {
        review_branch: string | null;
        review_commit: string | null;
        review_url: string | null;
        status: string;
      };
      expect(row).toEqual({
        review_branch: 'feature/task-383-rereview',
        review_commit: newCommit,
        review_url: 'http://localhost:3510/review/task-383?attempt=2',
        status: 'review',
      });

      const reviewHistory = db.prepare(`
        SELECT field, old_value, new_value
        FROM task_history
        WHERE task_id = ? AND field IN ('review_branch', 'review_commit', 'review_url')
        ORDER BY id ASC
      `).all(383) as Array<{ field: string; old_value: string | null; new_value: string | null }>;
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

  it('allows qa_pass release-gate validation for the localhost:3501 review artifact URL', () => {
    const db = getDb();
    db.prepare(`UPDATE tasks SET qa_verified_commit = ?, qa_tested_url = ? WHERE id = ?`).run(
      '6d614b3b104ae36d1dd75210b9f9fb0342673329',
      'http://localhost:3501/review/task/383',
      383,
    );

    const task = db.prepare(`
      SELECT id, status, task_type, sprint_id, review_commit, qa_verified_commit, qa_tested_url
      FROM tasks
      WHERE id = ?
    `).get(383) as {
      id: number;
      status: string;
      task_type: string | null;
      sprint_id: number | null;
      review_commit: string | null;
      qa_verified_commit: string | null;
      qa_tested_url: string | null;
    };

    const result = requireReleaseGate(db, task, 'qa_pass', task.task_type);
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

  it('supports configured OR field expressions for release gates', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO sprint_task_transition_requirements (sprint_id, task_type, outcome, field_name, requirement_type, match_field, severity, message)
      VALUES (10, NULL, 'deployed_live', 'merged_commit|deployed_commit', 'required', NULL, 'block', 'deployed_live requires merged_commit or deployed_commit')
    `).run();

    const result = requireReleaseGate(db, {
      id: 383,
      status: 'ready_to_merge',
      task_type: 'backend',
      sprint_id: 10,
      deployed_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
    }, 'deployed_live', 'backend');

    expect(result.errors).toEqual([]);
  });

  it('rejects premature or malformed live_verified release-gate validation when the workflow config requires it', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO sprint_task_transition_requirements (sprint_id, task_type, outcome, field_name, requirement_type, match_field, severity, message)
      VALUES
        (10, NULL, 'live_verified', 'status', 'from_status', 'deployed', 'block', 'live_verified requires task status deployed'),
        (10, NULL, 'live_verified', 'live_verified_by', 'required', NULL, 'block', 'live_verified requires live_verified_by'),
        (10, NULL, 'live_verified', 'live_verified_at', 'required', NULL, 'block', 'live_verified requires live_verified_at')
    `).run();

    const result = requireReleaseGate(db, {
      id: 383,
      status: 'ready_to_merge',
      task_type: 'backend',
      sprint_id: 10,
      deployed_commit: '6d614b3b104ae36d1dd75210b9f9fb0342673329',
      live_verified_by: null,
      live_verified_at: null,
    }, 'live_verified', 'backend');

    expect(result.errors).toEqual(expect.arrayContaining([
      'live_verified requires task status deployed',
      'live_verified requires live_verified_by',
      'live_verified requires live_verified_at',
    ]));
  });
});
