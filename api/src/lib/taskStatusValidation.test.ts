import { setupTestDb, teardownTestDb } from '../db/testDb';
import type { Db } from '../db/adapter/types';
import { assertTaskStatusDefinedForWorkflow, listAllowedTaskStatusesForWorkflow, WorkflowAllowedValuesError } from './taskStatusValidation';

// Task statuses are 100% configuration: a workflow allows exactly its workflow type's configured
// statuses (a workflow has none of its own). There is no global status list.
describe('task status validation is configuration-only', () => {
  let db: Db;

  beforeEach(async () => {
    db = await setupTestDb();
    // The PostgreSQL fixture is schema-only; this suite owns the tenant it needs.
    const t = 1;
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (?, 'Status Config', 'status-config', 1)`, t);
    await db.run(`INSERT INTO projects (id, tenant_id, name, description, context_md) VALUES (1, ?, 'P', '', '')`, t);
    await db.run(`INSERT INTO workflow_types (tenant_id, key, name, description) VALUES (?, 'strategy_cfg', 'Strategy', '')`, t);
    await db.run(`INSERT INTO workflow_types (tenant_id, key, name, description) VALUES (?, 'bare_cfg', 'Bare', '')`, t);
    await db.run(`INSERT INTO workflow_types (tenant_id, key, name, description) VALUES (?, 'typed_cfg', 'Typed', '')`, t);
    // A strategy-style workflow type whose only terminal status is `retired`.
    await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type) VALUES (71, ?, 1, 'Strategy', 'strategy_cfg')`, t);
    await db.run(`
      INSERT INTO workflow_type_task_statuses (tenant_id, workflow_type_key, status_key, label, terminal, stage_order, is_default_entry)
      VALUES (?, 'strategy_cfg', 'todo', 'Todo', 0, 0, 1), (?, 'strategy_cfg', 'paper', 'Paper', 0, 1, 0), (?, 'strategy_cfg', 'retired', 'Retired', 1, 2, 0)
    `, t, t, t);
    // A leftover per-workflow status row is ignored: statuses come only from the type.
    await db.run(`
      INSERT INTO workflow_task_statuses (workflow_id, status_key, label, terminal, stage_order, is_default_entry)
      VALUES (71, 'legacy_only', 'Legacy only', 0, 3, 0)
    `);
    // Another type configures different statuses.
    await db.run(`INSERT INTO workflow_type_task_statuses (tenant_id, workflow_type_key, status_key, label, stage_order, is_default_entry)
      VALUES (?, 'typed_cfg', 'intake', 'Intake', 0, 1), (?, 'typed_cfg', 'closed', 'Closed', 1, 0)`, t, t);
    await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type) VALUES (72, ?, 1, 'Typed', 'typed_cfg')`, t);
    // A workflow with nothing configured at either level.
    await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type) VALUES (73, ?, 1, 'Bare', 'bare_cfg')`, t);
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('allows exactly the workflow type\'s configured statuses', async () => {
    await expect(listAllowedTaskStatusesForWorkflow(db, { workflowId: 71 })).resolves.toEqual(['todo', 'paper', 'retired']);
    await expect(assertTaskStatusDefinedForWorkflow(db, 'retired', { workflowId: 71 })).resolves.toBeUndefined();
    await expect(assertTaskStatusDefinedForWorkflow(db, 'legacy_only', { workflowId: 71 })).rejects.toMatchObject({
      code: 'task_status_not_allowed_for_workflow',
    });
  });

  it.each(['done', 'cancelled', 'failed', 'blocked', 'deployed'])(
    'rejects "%s" on a workflow that does not configure it, even though other workflows use it',
    async (status) => {
      const attempt = assertTaskStatusDefinedForWorkflow(db, status, { workflowId: 71 });
      await expect(attempt).rejects.toBeInstanceOf(WorkflowAllowedValuesError);
      await expect(attempt).rejects.toMatchObject({
        code: 'task_status_not_allowed_for_workflow',
        allowedValues: ['todo', 'paper', 'retired'],
      });
    },
  );

  it('uses each workflow type\'s own configured statuses, and only those', async () => {
    await expect(listAllowedTaskStatusesForWorkflow(db, { workflowId: 72 })).resolves.toEqual(['intake', 'closed']);
    await expect(assertTaskStatusDefinedForWorkflow(db, 'done', { workflowId: 72 })).rejects.toMatchObject({
      code: 'task_status_not_allowed_for_workflow',
    });
  });

  it('allows no status at all when the workflow type configures none', async () => {
    await expect(listAllowedTaskStatusesForWorkflow(db, { workflowId: 73 })).resolves.toEqual([]);
    await expect(assertTaskStatusDefinedForWorkflow(db, 'todo', { workflowId: 73 })).rejects.toMatchObject({
      code: 'workflow_statuses_not_configured',
      allowedValues: [],
    });
  });
});
