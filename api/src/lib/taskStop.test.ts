import Database from 'better-sqlite3';
import { stopTaskActiveInstance } from './taskStop';
import { stopInstanceExecution } from './stopInstanceExecution';
import { type Db } from "../db/adapter/types";
import { SqliteAdapter } from "../db/adapter/SqliteAdapter";

jest.mock('../domains/runs/stopInstanceExecution', () => ({
  stopInstanceExecution: jest.fn(),
}));

const mockedStopInstanceExecution = stopInstanceExecution as jest.MockedFunction<typeof stopInstanceExecution>;

async function createDb(): Promise<Db> {
  const dbRaw = new Database(':memory:');
    const db = new SqliteAdapter(dbRaw);
  await db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      active_instance_id INTEGER,
      paused_at TEXT,
      pause_reason TEXT,
      manual_intervention_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );

    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL
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
  `);
  return db;
}

describe('stopTaskActiveInstance', () => {
  let db: Db;

  beforeEach(async () => {
    mockedStopInstanceExecution.mockReset();
    db = await createDb();
  });

  afterEach(() => {
    db.close();
  });

  it('aborts the active authoritative instance without pausing the task', async () => {
    await db.run(`
      INSERT INTO tasks (id, status, active_instance_id, paused_at, pause_reason)
      VALUES (486, 'in_progress', 91, NULL, NULL)
    `);
    await db.run(`INSERT INTO job_instances (id, status) VALUES (91, 'running')`);
    mockedStopInstanceExecution.mockResolvedValue({
      id: 91,
      behavior: 'stop',
      result: 'confirmed_stopped',
      message: 'Run stopped successfully.',
      runtimeUncertain: false,
      sessionKey: 'run:91',
      abortAttempted: true,
      abortOk: true,
      abortStatus: 'succeeded',
      abortError: null,
      cronRemoved: false,
      cronRemoveError: null,
      taskId: 486,
      taskStatusBefore: 'in_progress',
      taskStatusAfter: 'in_progress',
      clearedTaskLinkage: true,
    });

    const result = await stopTaskActiveInstance(db, 486, 'cinder-backend', 'Operator clicked Stop');

    expect(mockedStopInstanceExecution).toHaveBeenCalledWith(db, 91, 'stop');
    expect(result).toMatchObject({
      had_active_run: true,
      task_was_paused: false,
      no_op: false,
      stop_result: expect.objectContaining({ id: 91, result: 'confirmed_stopped' }),
    });

    const task = await db.get(`
      SELECT paused_at, pause_reason, manual_intervention_count
      FROM tasks
      WHERE id = ?
    `, 486) as {
      paused_at: string | null;
      pause_reason: string | null;
      manual_intervention_count: number;
    };
    expect(task.paused_at).toBeNull();
    expect(task.pause_reason).toBeNull();
    expect(task.manual_intervention_count).toBe(0);

    const history = await db.all(`
      SELECT field
      FROM task_history
      WHERE task_id = ?
    `, 486) as Array<{ field: string }>;
    expect(history).toEqual([]);

    const note = await db.get(`
      SELECT author, content
      FROM task_notes
      WHERE task_id = ?
      ORDER BY id DESC
      LIMIT 1
    `, 486) as { author: string; content: string };
    expect(note).toEqual({
      author: 'cinder-backend',
      content: 'Active instance manually stopped by cinder-backend: Operator clicked Stop',
    });
  });

  it('preserves existing task pause state when the task was already paused', async () => {
    await db.run(`
      INSERT INTO tasks (id, status, active_instance_id, paused_at, pause_reason, manual_intervention_count)
      VALUES (486, 'in_progress', 91, datetime('now'), 'Waiting on review', 2)
    `);
    await db.run(`INSERT INTO job_instances (id, status) VALUES (91, 'running')`);
    mockedStopInstanceExecution.mockResolvedValue({
      id: 91,
      behavior: 'stop',
      result: 'confirmed_stopped',
      message: 'Run stopped successfully.',
      runtimeUncertain: false,
      sessionKey: 'run:91',
      abortAttempted: true,
      abortOk: true,
      abortStatus: 'succeeded',
      abortError: null,
      cronRemoved: false,
      cronRemoveError: null,
      taskId: 486,
      taskStatusBefore: 'in_progress',
      taskStatusAfter: 'in_progress',
      clearedTaskLinkage: true,
    });

    const result = await stopTaskActiveInstance(db, 486, 'cinder-backend', null);

    expect(result).toMatchObject({
      had_active_run: true,
      task_was_paused: true,
      no_op: false,
    });

    const notes = await db.all(`
      SELECT content
      FROM task_notes
      WHERE task_id = ?
      ORDER BY id ASC
    `, 486) as Array<{ content: string }>;
    expect(notes).toEqual([
      { content: 'Active instance manually stopped by cinder-backend.' },
    ]);

    const task = await db.get(`
      SELECT paused_at, pause_reason, manual_intervention_count
      FROM tasks
      WHERE id = ?
    `, 486) as { paused_at: string | null; pause_reason: string | null; manual_intervention_count: number };
    expect(task.paused_at).not.toBeNull();
    expect(task.pause_reason).toBe('Waiting on review');
    expect(task.manual_intervention_count).toBe(2);
  });

  it('is a no-op and does not pause when no active instance is linked', async () => {
    await db.run(`
      INSERT INTO tasks (id, status, active_instance_id, paused_at, pause_reason, manual_intervention_count)
      VALUES (486, 'ready', NULL, NULL, NULL, 0)
    `);

    const result = await stopTaskActiveInstance(db, 486, 'cinder-backend', 'No active run');

    expect(mockedStopInstanceExecution).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      had_active_run: false,
      task_was_paused: false,
      no_op: true,
      stop_result: null,
    });

    const task = await db.get(`
      SELECT paused_at, pause_reason, manual_intervention_count
      FROM tasks
      WHERE id = ?
    `, 486) as {
      paused_at: string | null;
      pause_reason: string | null;
      manual_intervention_count: number;
    };
    expect(task.paused_at).toBeNull();
    expect(task.pause_reason).toBeNull();
    expect(task.manual_intervention_count).toBe(0);

    const notes = await db.all(`
      SELECT content
      FROM task_notes
      WHERE task_id = ?
    `, 486) as Array<{ content: string }>;
    expect(notes).toEqual([]);
  });
});
