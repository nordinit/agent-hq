import express from 'express';
import type { Server } from 'http';
import { closeDb, getDb } from '../db/client';
import instancesRouter from './instances';

jest.mock('../services/browserPool', () => ({
  createAgentContext: jest.fn(() => Promise.resolve({})),
  destroyAgentContext: jest.fn(() => Promise.resolve()),
}));

function resetDb(): void {
  closeDb();
  const db = getDb();
  db.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY,
      project_id INTEGER,
      name TEXT,
      sprint_type TEXT
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      previous_status TEXT,
      task_type TEXT,
      sprint_id INTEGER,
      project_id INTEGER,
      agent_id INTEGER,
      active_instance_id INTEGER,
      review_branch TEXT,
      review_commit TEXT,
      review_url TEXT,
      qa_verified_commit TEXT,
      qa_tested_url TEXT,
      merged_commit TEXT,
      deployed_commit TEXT,
      deploy_target TEXT,
      deployed_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      session_key TEXT,
      openclaw_agent_id TEXT,
      runtime_type TEXT
    );

    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      agent_id INTEGER,
      task_id INTEGER,
      status TEXT,
      session_key TEXT,
      task_outcome TEXT,
      runtime_completed_at TEXT,
      lifecycle_handoff_status TEXT,
      semantic_outcome_missing INTEGER NOT NULL DEFAULT 0,
      lifecycle_outcome_posted_at TEXT,
      error TEXT,
      response TEXT,
      dispatched_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      runtime_ended_at TEXT,
      runtime_end_success INTEGER,
      runtime_end_error TEXT,
      runtime_end_source TEXT,
      token_input INTEGER,
      token_output INTEGER,
      token_total INTEGER,
      run_id TEXT,
      durable_run_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE instance_artifacts (
      instance_id INTEGER PRIMARY KEY,
      task_id INTEGER,
      current_stage TEXT,
      summary TEXT,
      latest_commit_hash TEXT,
      branch_name TEXT,
      changed_files_json TEXT,
      changed_files_count INTEGER,
      blocker_reason TEXT,
      outcome TEXT,
      last_agent_heartbeat_at TEXT,
      last_meaningful_output_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      stale INTEGER,
      stale_at TEXT,
      session_key TEXT,
      updated_at TEXT,
      last_note_at TEXT
    );

    CREATE TABLE task_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
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

    CREATE TABLE integrity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      project_id INTEGER,
      agent_id INTEGER,
      instance_id INTEGER,
      anomaly_type TEXT NOT NULL,
      detail TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER,
      agent_id INTEGER,
      job_title TEXT,
      level TEXT,
      message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_key TEXT NOT NULL UNIQUE,
      runtime TEXT NOT NULL,
      agent_id INTEGER,
      task_id INTEGER,
      instance_id INTEGER,
      project_id INTEGER,
      status TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      ended_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      token_input INTEGER,
      token_output INTEGER,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      role TEXT,
      event_type TEXT,
      content TEXT,
      event_meta TEXT,
      raw_payload TEXT,
      timestamp TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, ordinal)
    );
  `);

  db.prepare(`INSERT INTO projects (id, name) VALUES (86, 'Agent HQ')`).run();
  db.prepare(`INSERT INTO agents (id, name, session_key, runtime_type) VALUES (96, 'Talon (QA)', 'agency-qa', 'openclaw')`).run();
  db.prepare(`
    INSERT INTO tasks (
      id, title, status, task_type, project_id, agent_id, active_instance_id,
      review_branch, review_commit, review_url, updated_at
    )
    VALUES (
      403,
      'Prevent outcome-less run completions from closing cleanly or redispatching blindly',
      'review',
      'backend',
      86,
      96,
      2045,
      'cinder-backend/task-403-prevent-outcome-less-run-completions-fro',
      '2997dcc8cec51f6fe0dfec2ab882668b83d482df',
      'http://localhost:3510/tasks/403',
      datetime('now')
    )
  `).run();
  db.prepare(`
    INSERT INTO job_instances (
      id, agent_id, task_id, status, session_key, dispatched_at, started_at
    )
    VALUES (2045, 96, 403, 'running', 'run:2045', datetime('now'), datetime('now'))
  `).run();
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
  beforeEach(resetDb);
  afterEach(closeDb);

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
      const task = db.prepare(`SELECT status, previous_status FROM tasks WHERE id = 403`).get() as {
        status: string;
        previous_status: string | null;
      };
      expect(task).toEqual({ status: 'review', previous_status: null });

      const instance = db.prepare(`
        SELECT status, runtime_end_success, runtime_end_error, lifecycle_handoff_status, semantic_outcome_missing, lifecycle_outcome_posted_at, task_outcome
        FROM job_instances
        WHERE id = 2045
      `).get() as {
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

      const notes = db.prepare(`SELECT author, content FROM task_notes WHERE task_id = 403 ORDER BY id`).all() as Array<{
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

      const event = db.prepare(`
        SELECT anomaly_type, instance_id, detail
        FROM integrity_events
        WHERE task_id = 403
      `).get() as { anomaly_type: string; instance_id: number; detail: string };
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
