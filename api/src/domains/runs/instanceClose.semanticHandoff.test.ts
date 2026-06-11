import Database from 'better-sqlite3';
import { closeActiveInstanceAfterSemanticHandoff } from './instanceClose';

jest.mock('../../runtimes/OpenClawRuntime', () => ({
  abortChatRunBySessionKey: jest.fn(() => ({ ok: true, status: 'aborted' })),
}));

jest.mock('../../services/browserPool', () => ({
  destroyAgentContext: jest.fn(() => Promise.resolve()),
}));

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      agent_id INTEGER,
      active_instance_id INTEGER,
      updated_at TEXT
    );

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      job_title TEXT,
      session_key TEXT,
      repo_path TEXT,
      repo_access_mode TEXT
    );

    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      task_id INTEGER,
      agent_id INTEGER,
      status TEXT,
      session_key TEXT,
      lifecycle_outcome_posted_at TEXT,
      task_outcome TEXT,
      completed_at TEXT,
      runtime_ended_at TEXT,
      runtime_end_success INTEGER,
      runtime_end_error TEXT,
      runtime_end_source TEXT,
      started_at TEXT,
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

    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER,
      agent_id INTEGER,
      job_title TEXT,
      level TEXT,
      message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(`INSERT INTO agents (id, name, job_title, session_key) VALUES (7, 'Vulcan', 'Backend', 'agent:vulcan-backend:local')`).run();
  return db;
}

function seedTaskAndInstance(db: Database.Database, options?: {
  taskId?: number;
  instanceId?: number;
  instanceTaskId?: number;
  taskStatus?: string;
  instanceStatus?: string;
  activeInstanceId?: number | null;
  runtimeEndedAt?: string | null;
}): void {
  const taskId = options?.taskId ?? 731;
  const instanceId = options?.instanceId ?? 4702;
  const activeInstanceId = options?.activeInstanceId === undefined ? instanceId : options.activeInstanceId;
  db.prepare(`INSERT INTO tasks (id, title, status, agent_id, active_instance_id, updated_at) VALUES (?, 'Task', ?, 7, ?, datetime('now'))`)
    .run(taskId, options?.taskStatus ?? 'review', activeInstanceId);
  db.prepare(`
    INSERT INTO job_instances (id, task_id, agent_id, status, session_key, runtime_ended_at, started_at)
    VALUES (?, ?, 7, ?, NULL, ?, datetime('now'))
  `).run(instanceId, options?.instanceTaskId ?? taskId, options?.instanceStatus ?? 'running', options?.runtimeEndedAt ?? null);
}

describe('closeActiveInstanceAfterSemanticHandoff', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
    jest.clearAllMocks();
  });

  it('closes the same-task active instance by reusing closeInstance behavior without changing task status', async () => {
    seedTaskAndInstance(db, { instanceStatus: 'running' });

    const result = await closeActiveInstanceAfterSemanticHandoff({
      db,
      taskId: 731,
      outcome: 'completed_for_review',
      summary: 'External event already posted the semantic handoff',
      changedBy: 'dev-env-lease-manager',
      source: 'external_task_event',
    });

    expect(result).toEqual({ closed: true, reason: 'closed', instanceId: 4702 });
    const instance = db.prepare(`SELECT status, runtime_ended_at, runtime_end_success, runtime_end_source FROM job_instances WHERE id = 4702`).get() as {
      status: string;
      runtime_ended_at: string | null;
      runtime_end_success: number | null;
      runtime_end_source: string | null;
    };
    expect(instance.status).toBe('done');
    expect(instance.runtime_ended_at).toBeTruthy();
    expect(instance.runtime_end_success).toBe(1);
    expect(instance.runtime_end_source).toBe('task_outcome_auto_close');

    const task = db.prepare(`SELECT status, active_instance_id FROM tasks WHERE id = 731`).get() as { status: string; active_instance_id: number | null };
    expect(task.status).toBe('review');
    expect(task.active_instance_id).toBe(4702);

    const note = db.prepare(`SELECT content FROM task_notes WHERE task_id = 731 ORDER BY id DESC LIMIT 1`).get() as { content: string };
    expect(note.content).toContain('Agent check-in: Run completed');
    expect(note.content).toContain('Outcome: completed_for_review');
  });

  it('refuses to close an instance that belongs to a different task', async () => {
    seedTaskAndInstance(db, { taskId: 731, instanceId: 4702, instanceTaskId: 999, activeInstanceId: 4702 });

    const result = await closeActiveInstanceAfterSemanticHandoff({
      db,
      taskId: 731,
      instanceId: 4702,
      outcome: 'completed_for_review',
    });

    expect(result).toEqual({ closed: false, reason: 'cross_task_instance', instanceId: 4702 });
    const instance = db.prepare(`SELECT status FROM job_instances WHERE id = 4702`).get() as { status: string };
    expect(instance.status).toBe('running');
  });

  it.each(['done', 'failed', 'cancelled'])('is idempotent when the instance is already %s', async (status) => {
    seedTaskAndInstance(db, { instanceStatus: status });

    const result = await closeActiveInstanceAfterSemanticHandoff({
      db,
      taskId: 731,
      instanceId: 4702,
      outcome: 'completed_for_review',
    });

    expect(result).toEqual({ closed: false, reason: 'already_terminal', instanceId: 4702 });
    const instance = db.prepare(`SELECT status, runtime_ended_at FROM job_instances WHERE id = 4702`).get() as { status: string; runtime_ended_at: string | null };
    expect(instance.status).toBe(status);
    expect(instance.runtime_ended_at).toBeNull();
  });

  it('is idempotent when the runtime already ended before instance status changed', async () => {
    seedTaskAndInstance(db, { instanceStatus: 'running', runtimeEndedAt: '2026-06-03T03:42:50.931Z' });

    const result = await closeActiveInstanceAfterSemanticHandoff({
      db,
      taskId: 731,
      outcome: 'completed_for_review',
    });

    expect(result).toEqual({ closed: false, reason: 'runtime_already_ended', instanceId: 4702 });
    const instance = db.prepare(`SELECT status FROM job_instances WHERE id = 4702`).get() as { status: string };
    expect(instance.status).toBe('running');
  });

  it('returns no-op when the task has no active instance and no instance id is provided', async () => {
    seedTaskAndInstance(db, { activeInstanceId: null });

    const result = await closeActiveInstanceAfterSemanticHandoff({
      db,
      taskId: 731,
      outcome: 'completed_for_review',
    });

    expect(result).toEqual({ closed: false, reason: 'no_active_instance' });
    const instance = db.prepare(`SELECT status FROM job_instances WHERE id = 4702`).get() as { status: string };
    expect(instance.status).toBe('running');
  });
});
