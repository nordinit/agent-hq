import Database from 'better-sqlite3';
import { reconcileOrphanInProgressTasks, startReconciler } from './reconciler';

describe('reconciler runtime integrity recovery', () => {
  function createDb() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        agent_id INTEGER,
        active_instance_id INTEGER,
        paused_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        status TEXT,
        runtime_ended_at TEXT
      );
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER,
        job_title TEXT,
        level TEXT,
        message TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        name TEXT
      );
      CREATE TABLE task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        changed_by TEXT,
        field TEXT,
        old_value TEXT,
        new_value TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    return db;
  }

  it('logs orphaned in_progress tasks after grace without changing visible status', () => {
    const db = createDb();
    db.prepare(`INSERT INTO agents (id, name) VALUES (7, 'Cinder')`).run();
    db.prepare(`INSERT INTO job_instances (id, status, runtime_ended_at) VALUES (90, 'failed', datetime('now'))`).run();
    db.prepare(`
      INSERT INTO tasks (id, title, status, agent_id, active_instance_id, paused_at, updated_at)
      VALUES (501, 'Lost linkage task', 'in_progress', 7, 90, NULL, '2026-05-16T19:30:00.000Z')
    `).run();

    const realNow = Date.now;
    Date.now = () => new Date('2026-05-16T19:40:00.000Z').getTime();
    try {
      reconcileOrphanInProgressTasks(db);
    } finally {
      Date.now = realNow;
    }

    const task = db.prepare(`SELECT status FROM tasks WHERE id = 501`).get() as { status: string };
    expect(task.status).toBe('in_progress');

    const historyCount = (db.prepare(`SELECT COUNT(*) as count FROM task_history WHERE task_id = 501 AND field = 'status'`).get() as { count: number }).count;
    expect(historyCount).toBe(0);

    const logs = db.prepare(`SELECT message FROM logs WHERE message LIKE '%task #501%' ORDER BY id ASC`).all() as Array<{ message: string }>;
    expect(logs.some(row => row.message.includes('Orphan in_progress: task #501'))).toBe(true);
    expect(logs.some(row => row.message.includes('Orphan in_progress integrity anomaly: task #501'))).toBe(true);
    expect(logs.every(row => !row.message.includes('→ stalled'))).toBe(true);

    db.close();
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
