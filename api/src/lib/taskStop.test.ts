import { setupTestDb, teardownTestDb } from '../db/testDb';
import { stopTaskActiveInstance } from './taskStop';
import { stopInstanceExecution } from './stopInstanceExecution';
import { type Db } from "../db/adapter/types";

jest.mock('../domains/runs/stopInstanceExecution', () => ({
  stopInstanceExecution: jest.fn(),
}));

const mockedStopInstanceExecution = stopInstanceExecution as jest.MockedFunction<typeof stopInstanceExecution>;

async function createDb(): Promise<Db> {
  const db = await setupTestDb();

  await db.run(`
    INSERT INTO tenants (id, name, slug, is_default)
    VALUES (1, 'Default', 'default', 1)
  `);
  await db.run(`
    INSERT INTO projects (id, tenant_id, name)
    VALUES (1, 1, 'Task stop')
  `);
  await db.run(`
    INSERT INTO sprints (id, tenant_id, project_id, name)
    VALUES (1, 1, 1, 'Task stop')
  `);
  await db.run(`
    INSERT INTO agents (id, tenant_id, name, role, session_key)
    VALUES (7, 1, 'Cinder', 'Implementation', 'agent:cinder')
  `);

  return db;
}

async function seedTask(db: Db, input: {
  status: string;
  pausedAt?: string | null;
  pauseReason?: string | null;
  manualInterventionCount?: number;
  activeInstance?: boolean;
}): Promise<void> {
  await db.run(`
    INSERT INTO tasks (
      id, tenant_id, project_id, sprint_id, title, status,
      active_instance_id, paused_at, pause_reason, manual_intervention_count
    )
    VALUES (486, 1, 1, 1, 'Stop an active task', ?, NULL, ?, ?, ?)
  `,
    input.status,
    input.pausedAt ?? null,
    input.pauseReason ?? null,
    input.manualInterventionCount ?? 0,
  );

  if (input.activeInstance) {
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status)
      VALUES (91, 1, 7, 486, 'running')
    `);
    await db.run(`UPDATE tasks SET active_instance_id = 91 WHERE id = 486`);
  }
}

describe('stopTaskActiveInstance', () => {
  let db: Db;

  beforeEach(async () => {
    mockedStopInstanceExecution.mockReset();
    db = await createDb();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('aborts the active authoritative instance without pausing the task', async () => {
    await seedTask(db, { status: 'in_progress', activeInstance: true });
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
    await seedTask(db, {
      status: 'in_progress',
      pausedAt: new Date().toISOString(),
      pauseReason: 'Waiting on review',
      manualInterventionCount: 2,
      activeInstance: true,
    });
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
    await seedTask(db, { status: 'ready' });

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
