import { reconcileOrphanInProgressTasks, startReconciler } from './reconciler';
import { setupTestDb, teardownTestDb } from '../db/testDb';

describe('reconciler runtime integrity recovery', () => {
  async function createDb() {
    const db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
    await db.run(`
      INSERT INTO app_settings (key, value)
      VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
    `);
    await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Test')`);
    await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type) VALUES (1, 1, 1, 'Test workflow', 'generic')`);
    return db;
  }

  afterEach(async () => { await teardownTestDb(); });

  it('logs orphaned in_progress tasks after grace without changing visible status', async () => {
    const db = await createDb();
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key) VALUES (7, 1, 'Cinder', 'agent:cinder:main')`);
    await db.run(`INSERT INTO job_instances (id, agent_id, status, runtime_ended_at) VALUES (90, 7, 'failed', CURRENT_TIMESTAMP)`);
    await db.run(`
      INSERT INTO tasks (id, tenant_id, project_id, sprint_id, title, status, agent_id, active_instance_id, paused_at, updated_at)
      VALUES (501, 1, 1, 1, 'Lost linkage task', 'in_progress', 7, 90, NULL, '2026-05-16T19:30:00.000Z')
    `);

    const realNow = Date.now;
    Date.now = () => new Date('2026-05-16T19:40:00.000Z').getTime();
    try {
      await reconcileOrphanInProgressTasks(db);
    } finally {
      Date.now = realNow;
    }

    const task = await db.get(`SELECT status FROM tasks WHERE id = 501`) as { status: string };
    expect(task.status).toBe('in_progress');

    const historyCount = (await db.get(`SELECT COUNT(*) as count FROM task_history WHERE task_id = 501 AND field = 'status'`) as { count: number }).count;
    expect(historyCount).toBe(0);

    const logs = await db.all(`SELECT message FROM logs WHERE message LIKE '%task #501%' ORDER BY id ASC`) as Array<{ message: string }>;
    expect(logs.some(row => row.message.includes('Orphan in_progress: task #501'))).toBe(true);
    expect(logs.some(row => row.message.includes('Orphan in_progress integrity anomaly: task #501'))).toBe(true);
    expect(logs.every(row => !row.message.includes('→ stalled'))).toBe(true);

  });

  it('releases the scheduler overlap guard after a hung tick times out', async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const runTick = jest.fn<Promise<void>, []>(() => new Promise(() => undefined));

    const timer = startReconciler({
      intervalMs: 10,
      tickTimeoutMs: 50,
      runTick,
    });

    try {
      await jest.advanceTimersByTimeAsync(10);
      expect(runTick).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(10);
      expect(runTick).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Previous tick still running; skipping overlapping tick'));

      await jest.advanceTimersByTimeAsync(50);
      expect(errorSpy).toHaveBeenCalledWith(
        '[reconciler] Tick error:',
        expect.objectContaining({
          name: 'ReconcilerTimeoutError',
          message: expect.stringContaining('scheduler tick #1 timed out after 50ms'),
        }),
      );

      await jest.advanceTimersByTimeAsync(10);
      expect(runTick).toHaveBeenCalledTimes(2);
    } finally {
      if (timer) clearInterval(timer);
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
