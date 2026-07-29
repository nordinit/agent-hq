import Database from 'better-sqlite3';
import { completeRunInstance, startRunInstance } from './callbacks';
import { type Db } from "../../db/adapter/types";
import { SqliteAdapter } from "../../db/adapter/SqliteAdapter";

jest.mock('../../services/browserPool', () => ({
  createAgentContext: jest.fn(() => Promise.resolve({})),
  destroyAgentContext: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../integrations/telegram', () => ({
  notifyTelegram: jest.fn(() => Promise.resolve()),
}));

async function createDb(): Promise<Db> {
  const dbRaw = new Database(':memory:');
    const db = new SqliteAdapter(dbRaw);
  await db.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      session_key TEXT,
      openclaw_agent_id TEXT,
      runtime_type TEXT
    );

    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY,
      sprint_type TEXT
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      previous_status TEXT,
      failure_detail TEXT,
      task_type TEXT,
      review_branch TEXT,
      review_commit TEXT,
      review_url TEXT,
      qa_verified_commit TEXT,
      qa_tested_url TEXT,
      merged_commit TEXT,
      deployed_commit TEXT,
      deploy_target TEXT,
      deployed_at TEXT,
      sprint_id INTEGER,
      project_id INTEGER,
      agent_id INTEGER,
      active_instance_id INTEGER,
      updated_at TEXT
    );

    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      agent_id INTEGER,
      task_id INTEGER,
      status TEXT,
      session_key TEXT,
      task_outcome TEXT,
      lifecycle_outcome_posted_at TEXT,
      error TEXT,
      response TEXT,
      dispatched_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      runtime_completed_at TEXT,
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

    CREATE TABLE external_event_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      source TEXT,
      event_name TEXT NOT NULL,
      task_type TEXT,
      status_includes_json TEXT NOT NULL DEFAULT '[]',
      status_excludes_json TEXT NOT NULL DEFAULT '[]',
      action_kind TEXT NOT NULL,
      action_target TEXT,
      apply_review_evidence INTEGER NOT NULL DEFAULT 0,
      apply_failure_detail INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  `);

  await db.run(`
    INSERT INTO external_event_mappings (
      project_id, source, event_name, task_type, status_includes_json, status_excludes_json,
      action_kind, action_target, apply_review_evidence, apply_failure_detail, enabled, priority
    )
    VALUES (NULL, NULL, 'agent_started', NULL, '[]', '["in_progress","blocked","review","qa_pass","ready_to_merge","deployed","done","cancelled","failed"]', 'status', 'in_progress', 0, 0, 1, 100)
  `);

  await db.run(`
    INSERT INTO agents (id, name, session_key, openclaw_agent_id, runtime_type)
    VALUES (94, 'Cinder (Backend)', 'cinder-backend', 'cinder-backend', 'openclaw')
  `);

  return db;
}

async function seedReadyTaskRun(db: Db, activeInstanceId: number | null = null): Promise<void> {
  await db.run(`
    INSERT INTO tasks (id, title, status, task_type, project_id, agent_id, active_instance_id, updated_at)
    VALUES (552, 'Allow task routing rules that apply to all task types', 'ready', 'backend', 86, 94, ?, datetime('now'))
  `, activeInstanceId);
  await db.run(`
    INSERT INTO job_instances (id, agent_id, task_id, status, dispatched_at)
    VALUES (3461, 94, 552, 'running', datetime('now'))
  `);
}

describe('startRunInstance task ownership repair', () => {
  let db: Db;

  afterEach(async () => {
    await db.close();
  });

  it('reattaches a matching live instance before applying the agent_started status mapping', async () => {
    db = await createDb();
    await seedReadyTaskRun(db);

    expect(await startRunInstance(db, 3461, 'run:3461')).toEqual({ ok: true, id: 3461, session_key: 'run:3461' });

    const task = await db.get(`SELECT status, active_instance_id FROM tasks WHERE id = 552`) as {
      status: string;
      active_instance_id: number | null;
    };
    expect(task).toEqual({ status: 'in_progress', active_instance_id: 3461 });

    const history = await db.all(`
      SELECT field, old_value, new_value
      FROM task_history
      WHERE task_id = 552
      ORDER BY id
    `);
    expect(history).toEqual([
      { field: 'active_instance_id', old_value: null, new_value: '3461' },
      { field: 'workflow_event_source', old_value: null, new_value: 'agent_hq_runtime' },
      { field: 'workflow_event_source_kind', old_value: null, new_value: 'agent_hq_internal' },
      { field: 'workflow_event_name', old_value: null, new_value: 'agent_started' },
      { field: 'workflow_event_instance_id', old_value: null, new_value: '3461' },
      { field: 'status', old_value: 'ready', new_value: 'in_progress' },
    ]);
  });

  it('does not let a stale start callback steal a task owned by another instance', async () => {
    db = await createDb();
    await seedReadyTaskRun(db, 9999);

    expect(await startRunInstance(db, 3461, 'run:3461')).toEqual({ ok: true, id: 3461, session_key: 'run:3461' });

    const task = await db.get(`SELECT status, active_instance_id FROM tasks WHERE id = 552`) as {
      status: string;
      active_instance_id: number | null;
    };
    expect(task).toEqual({ status: 'ready', active_instance_id: 9999 });
  });
});

describe('completeRunInstance runtime failure workflow event', () => {
  let db: Db;

  afterEach(async () => {
    await db.close();
  });

  async function seedInProgressRun(actionKind: 'status' | 'ignore', actionTarget: string | null): Promise<void> {
    await seedReadyTaskRun(db, 3461);
    await db.run(`UPDATE tasks SET status = 'in_progress' WHERE id = 552`);
    await db.run(`UPDATE job_instances SET session_key = 'run:3461' WHERE id = 3461`);
    await db.run(`
      INSERT INTO external_event_mappings (
        project_id, source, event_name, task_type, status_includes_json, status_excludes_json,
        action_kind, action_target, apply_review_evidence, apply_failure_detail, enabled, priority
      )
      VALUES (NULL, 'agent_hq_runtime', 'runtime_failed', NULL, '[]', '[]', ?, ?, 0, 1, 1, 200)
    `, actionKind, actionTarget);
  }

  it('applies the configured visible status for a runtime_failed workflow event', async () => {
    db = await createDb();
    await seedInProgressRun('status', 'blocked');

    await expect(await completeRunInstance(db, 3461, {
              status: 'failed',
              summary: 'Runtime process exited with code 1',
            })).resolves.toEqual({ ok: true, id: 3461, status: 'failed' });

    const task = await db.get(`SELECT status, failure_detail FROM tasks WHERE id = 552`) as { status: string; failure_detail: string | null };
    expect(task.status).toBe('blocked');
    expect(task.failure_detail).toContain('Runtime failure workflow event');
    expect(task.failure_detail).toContain('Event: runtime_failed');

    const history = await db.all(`
      SELECT field, new_value
      FROM task_history
      WHERE task_id = 552
      ORDER BY id
    `) as Array<{ field: string; new_value: string | null }>;
    expect(history).toEqual(expect.arrayContaining([
      { field: 'workflow_event_source', new_value: 'agent_hq_runtime' },
      { field: 'workflow_event_name', new_value: 'runtime_failed' },
      { field: 'workflow_event_action_kind', new_value: 'status' },
      { field: 'workflow_event_action_target', new_value: 'blocked' },
      { field: 'status', new_value: 'blocked' },
    ]));

    const note = await db.get(`SELECT content FROM task_notes WHERE task_id = 552 ORDER BY id DESC LIMIT 1`) as { content: string };
    expect(note.content).toContain('Classification: runtime/control-plane failure event, not an agent-authored product failure outcome');
  });

  it('records runtime_failed workflow event history when configured action is ignore', async () => {
    db = await createDb();
    await seedInProgressRun('ignore', null);

    await completeRunInstance(db, 3461, {
      status: 'failed',
      summary: 'Runtime monitor failed',
    });

    const task = await db.get(`SELECT status FROM tasks WHERE id = 552`) as { status: string };
    expect(task.status).toBe('in_progress');

    const history = await db.all(`
      SELECT field, new_value
      FROM task_history
      WHERE task_id = 552
      ORDER BY id
    `) as Array<{ field: string; new_value: string | null }>;
    expect(history).toEqual(expect.arrayContaining([
      { field: 'workflow_event_source', new_value: 'agent_hq_runtime' },
      { field: 'workflow_event_name', new_value: 'runtime_failed' },
      { field: 'workflow_event_action_kind', new_value: 'ignore' },
      { field: 'workflow_event_action_target', new_value: null },
    ]));
    expect(history.some((entry) => entry.field === 'status' && entry.new_value === 'failed')).toBe(false);
  });
});
