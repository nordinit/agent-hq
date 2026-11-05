import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { type Db } from '../../db/adapter/types';
import { getTaskById } from './readModel';

// is_blocked / blocks_dispatch drive the UI's blocked badge, so they must agree
// with dispatch eligibility (dispatcher.relationship-eligibility.test.ts covers
// the same cases from the dispatcher's side).

async function setupDb(): Promise<Db> {
  const db = await setupTestDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (86, 1, 'Agent HQ')`);
  await db.run(`INSERT INTO workflow_types (tenant_id, key, name, repo_required) VALUES (1, 'dev', 'Development', 0)`);
  await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type, status) VALUES (10, 1, 86, 'Enhancements', 'dev', 'active')`);
  // Same narrow resolved list production uses for blocked_by: only `done`.
  await db.run(`
    INSERT INTO workflow_type_relationship_types (tenant_id, workflow_type_key, key, label, inverse_label, category, affects_dispatch_eligibility, direction_semantics, resolved_statuses_json)
    VALUES
      (1, 'dev', 'blocked_by', 'Blocked by', 'Blocks', 'dependency', 1, 'target_blocks_source', '["done"]'),
      (1, 'dev', 'related_to', 'Related to', 'Related to', 'reference', 0, 'target_blocks_source', '[]')
  `);
  // Terminality is configuration, never a status name.
  await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('done', 'Done', 1), ('cancelled', 'Cancelled', 1), ('failed', 'Failed', 1)`);
  return db;
}

async function insertTask(db: Db, id: number, status: string): Promise<void> {
  await db.run(`
    INSERT INTO tasks (id, title, description, status, priority, project_id, tenant_id, task_type, workflow_id, created_at, updated_at)
    VALUES (?, ?, 'Task', ?, 'high', 86, 1, 'backend', 10, '2026-05-20T12:00:00.000Z', '2026-05-20T12:00:00.000Z')
  `, id, `Task ${id}`, status);
}

async function blockOn(db: Db, blockedId: number, blockerId: number, key = 'blocked_by'): Promise<void> {
  await db.run(`INSERT INTO task_relationships (source_task_id, target_task_id, relationship_type_key) VALUES (?, ?, ?)`, blockedId, blockerId, key);
}

async function blockerFlags(db: Db, taskId: number) {
  const task = await getTaskById(db, taskId) as {
    is_blocked: boolean;
    blockers: Array<{ id: number; blocks_dispatch: boolean }>;
  };
  return { isBlocked: task.is_blocked, blockers: task.blockers.map((b) => [b.id, b.blocks_dispatch]) };
}

describe('task read model blocker state', () => {
  afterEach(async () => {
    await teardownTestDb();
  });

  it('marks a task blocked while its blocker is unresolved', async () => {
    const db = await setupDb();
    await insertTask(db, 530, 'blocked');
    await insertTask(db, 567, 'in_progress');
    await blockOn(db, 530, 567);

    expect(await blockerFlags(db, 530)).toEqual({ isBlocked: true, blockers: [[567, true]] });
  });

  it('stops blocking once the blocker is done', async () => {
    const db = await setupDb();
    await insertTask(db, 530, 'blocked');
    await insertTask(db, 567, 'done');
    await blockOn(db, 530, 567);

    expect(await blockerFlags(db, 530)).toEqual({ isBlocked: false, blockers: [[567, false]] });
  });

  it('stops blocking once the blocker is cancelled, as dispatch does, despite a narrow resolved list', async () => {
    const db = await setupDb();
    await insertTask(db, 530, 'blocked');
    await insertTask(db, 567, 'cancelled');
    await blockOn(db, 530, 567);

    expect(await blockerFlags(db, 530)).toEqual({ isBlocked: false, blockers: [[567, false]] });
  });

  it('keeps blocking when the workflow marks the blocker status non-terminal', async () => {
    const db = await setupDb();
    await db.run(`INSERT INTO workflow_task_statuses (workflow_id, status_key, label, terminal) VALUES (10, 'failed', 'Failed', 0)`);
    await insertTask(db, 530, 'blocked');
    await insertTask(db, 567, 'failed');
    await blockOn(db, 530, 567);

    expect(await blockerFlags(db, 530)).toEqual({ isBlocked: true, blockers: [[567, true]] });
  });

  it('does not call a finished task blocked', async () => {
    const db = await setupDb();
    await insertTask(db, 530, 'done');
    await insertTask(db, 567, 'in_progress');
    await blockOn(db, 530, 567);

    expect(await blockerFlags(db, 530)).toEqual({ isBlocked: false, blockers: [[567, true]] });
  });

  it('ignores relationship types that do not affect dispatch', async () => {
    const db = await setupDb();
    await insertTask(db, 530, 'ready');
    await insertTask(db, 567, 'in_progress');
    await blockOn(db, 530, 567, 'related_to');

    expect((await blockerFlags(db, 530)).isBlocked).toBe(false);
  });

  it('is not blocked by a run outcome when no blocker relationship exists', async () => {
    const db = await setupDb();
    await insertTask(db, 530, 'blocked');

    expect(await blockerFlags(db, 530)).toEqual({ isBlocked: false, blockers: [] });
  });
});
