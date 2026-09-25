import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { timestampFromEpochMs } from '../../lib/timestamps';
import { listRecentlyCompletedTasks } from './readModel';

/**
 * Tenant isolation for the "recently completed" read model.
 *
 * The PostgreSQL fixture enforces the real parent relationships:
 * tasks.workflow_id is NOT NULL and tasks/workflows/projects all carry foreign keys to tenants.
 * The two tenants matter to the assertions themselves — they are what "isolation" means here —
 * and the fixture truncates them between tests, so they are seeded explicitly.
 */

const DEFAULT_TENANT_ID = 1;
const GLOBEX_TENANT_ID = 2;
const DEFAULT_PROJECT_ID = 10;
const GLOBEX_PROJECT_ID = 20;
const DEFAULT_WORKFLOW_ID = 100;
const GLOBEX_WORKFLOW_ID = 200;

/** A canonical-format timestamp N hours in the past, the same form the query's cutoff uses. */
function hoursAgo(hours: number): string {
  return timestampFromEpochMs(Date.now() - hours * 60 * 60 * 1000) as string;
}

async function ensureTenant(id: number, name: string, slug: string, isDefault: 0 | 1): Promise<void> {
  const db = getDb();
  if (await db.get(`SELECT id FROM tenants WHERE id = ?`, id)) return;
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (?, ?, ?, ?)`, id, name, slug, isDefault);
}

async function seedScope(): Promise<void> {
  const db = getDb();
  await ensureTenant(DEFAULT_TENANT_ID, 'Default', 'default', 1);
  await ensureTenant(GLOBEX_TENANT_ID, 'Globex', 'globex', 0);
  await db.run(
    `INSERT INTO projects (id, name, tenant_id) VALUES (?, ?, ?), (?, ?, ?)`,
    DEFAULT_PROJECT_ID, 'Default Project', DEFAULT_TENANT_ID,
    GLOBEX_PROJECT_ID, 'Globex Project', GLOBEX_TENANT_ID,
  );
  await db.run(
    `INSERT INTO workflows (id, project_id, name, tenant_id) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    DEFAULT_WORKFLOW_ID, DEFAULT_PROJECT_ID, 'Default Workflow', DEFAULT_TENANT_ID,
    GLOBEX_WORKFLOW_ID, GLOBEX_PROJECT_ID, 'Globex Workflow', GLOBEX_TENANT_ID,
  );
}

async function insertTask(task: {
  id: number;
  tenantId: number;
  title: string;
  projectId: number;
  workflowId: number;
  updatedAt: string;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO tasks (id, tenant_id, title, status, priority, project_id, workflow_id, updated_at)
     VALUES (?, ?, ?, 'done', 'medium', ?, ?, ?)`,
    task.id, task.tenantId, task.title, task.projectId, task.workflowId, task.updatedAt,
  );
}

async function insertDoneHistory(taskId: number, tenantId: number, createdAt: string): Promise<void> {
  await getDb().run(
    `INSERT INTO task_history (task_id, tenant_id, field, new_value, created_at)
     VALUES (?, ?, 'status', 'done', ?)`,
    taskId, tenantId, createdAt,
  );
}

describe('listRecentlyCompletedTasks tenant isolation', () => {
  beforeEach(async () => {
    await setupTestDb();
    await seedScope();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('returns only recently completed tasks for the requested tenant', async () => {
    await insertTask({
      id: 1, tenantId: DEFAULT_TENANT_ID, title: 'Default completed task',
      projectId: DEFAULT_PROJECT_ID, workflowId: DEFAULT_WORKFLOW_ID, updatedAt: hoursAgo(1),
    });
    await insertTask({
      id: 2, tenantId: GLOBEX_TENANT_ID, title: 'Globex completed task',
      projectId: GLOBEX_PROJECT_ID, workflowId: GLOBEX_WORKFLOW_ID, updatedAt: hoursAgo(1),
    });
    await insertTask({
      id: 3, tenantId: GLOBEX_TENANT_ID, title: 'Globex stale task',
      projectId: GLOBEX_PROJECT_ID, workflowId: GLOBEX_WORKFLOW_ID, updatedAt: hoursAgo(25),
    });
    await insertDoneHistory(1, DEFAULT_TENANT_ID, hoursAgo(1));
    await insertDoneHistory(2, GLOBEX_TENANT_ID, hoursAgo(1));
    await insertDoneHistory(3, GLOBEX_TENANT_ID, hoursAgo(25));

    const db = getDb();
    const globex = await listRecentlyCompletedTasks(db, 24, undefined, GLOBEX_TENANT_ID);
    expect(globex.tasks.map(task => task.title)).toEqual(['Globex completed task']);

    const defaultCompany = await listRecentlyCompletedTasks(db, 24, undefined, DEFAULT_TENANT_ID);
    expect(defaultCompany.tasks.map(task => task.title)).toEqual(['Default completed task']);
  });

  it('applies project and tenant scope together', async () => {
    await insertTask({
      id: 1, tenantId: DEFAULT_TENANT_ID, title: 'Default project task',
      projectId: DEFAULT_PROJECT_ID, workflowId: DEFAULT_WORKFLOW_ID, updatedAt: hoursAgo(1),
    });
    await insertTask({
      id: 2, tenantId: GLOBEX_TENANT_ID, title: 'Globex project task',
      projectId: GLOBEX_PROJECT_ID, workflowId: GLOBEX_WORKFLOW_ID, updatedAt: hoursAgo(1),
    });

    const db = getDb();
    expect((await listRecentlyCompletedTasks(db, 24, DEFAULT_PROJECT_ID, GLOBEX_TENANT_ID)).tasks).toEqual([]);
    expect((await listRecentlyCompletedTasks(db, 24, GLOBEX_PROJECT_ID, GLOBEX_TENANT_ID)).tasks.map(task => task.title))
      .toEqual(['Globex project task']);
  });
});
