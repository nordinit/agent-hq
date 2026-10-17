import fs from 'fs';
import { historicalTestFixture, migrationsThrough } from './historicalTestFixture';
import { runMigrations } from './migrationRunner';

it('releases only legacy retry-limit pauses and preserves retry timing, routing, and audit evidence', async () => {
  const fixture = await historicalTestFixture(39);
  const db = fixture.db;
  const through40 = migrationsThrough(40);
  try {
    await db.exec(`
      INSERT INTO tenants (id, name, slug) VALUES (1, 'One', 'one'), (2, 'Two', 'two');
      INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'One'), (2, 2, 'Two');
      INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type) VALUES (1, 1, 1, 'One', 'generic'), (2, 2, 2, 'Two', 'generic');
      INSERT INTO agents (id, tenant_id, name, session_key) VALUES (1, 1, 'Test', 'test');
    `);
    const oldPause = 'Dispatch startup retry limit reached (3/3). Fix the runtime startup failure, then resume this task to retry.';
    for (const [id, tenantId, reason] of [
      [1, 1, oldPause],
      [2, 2, oldPause],
      [3, 1, 'Operator investigation'],
      [4, 1, null],
      [5, 1, oldPause],
    ] as const) {
      await db.run(`INSERT INTO tasks
        (id, tenant_id, project_id, workflow_id, title, status, paused_at, pause_reason, retry_count, dispatched_at, failure_detail)
        VALUES (?, ?, ?, ?, 'Retry fixture', 'ready', '2026-10-09 17:20:11', ?, 3, '2026-10-09 17:20:11', 'Gateway unavailable')`,
      id, tenantId, tenantId, tenantId, reason);
    }
    await db.exec(`
      INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status) VALUES (1, 1, 1, 5, 'running');
      UPDATE tasks SET active_instance_id = 1 WHERE id = 5;
    `);
    const untouched = await db.all('SELECT * FROM tasks WHERE id IN (3, 4, 5) ORDER BY id');

    expect(await runMigrations(db, through40)).toEqual(['40-dispatch-retry-backoff.sql']);
    for (const id of [1, 2]) {
      expect(await db.get(`SELECT status, paused_at, pause_reason, retry_count, dispatched_at, failure_detail FROM tasks WHERE id = ?`, id)).toEqual({
        status: 'ready', paused_at: null, pause_reason: null, retry_count: 3,
        dispatched_at: '2026-10-09 17:20:11', failure_detail: 'Gateway unavailable',
      });
      expect(await db.all('SELECT tenant_id, field, old_value, new_value FROM task_history WHERE task_id = ? ORDER BY field', id)).toEqual([
        { tenant_id: id, field: 'pause_reason', old_value: oldPause, new_value: null },
        { tenant_id: id, field: 'paused_at', old_value: '2026-10-09 17:20:11', new_value: null },
      ]);
      expect(await db.value('SELECT count(*) FROM task_notes WHERE task_id = ? AND tenant_id = ?', id, id)).toBe(1);
    }
    expect(await db.all('SELECT * FROM tasks WHERE id IN (3, 4, 5) ORDER BY id')).toEqual(untouched);
    expect(await runMigrations(db, through40)).toEqual([]);
    expect(await db.value('SELECT count(*) FROM task_notes')).toBe(2);
  } finally {
    await fixture.close();
    fs.rmSync(through40, { recursive: true, force: true });
  }
}, 60000);
