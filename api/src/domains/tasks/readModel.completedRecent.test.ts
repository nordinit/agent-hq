import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { timestampFromEpochMs } from '../../lib/timestamps';
import { listRecentlyCompletedTasks } from './readModel';

/**
 * Tenant isolation for the "recently completed" read model.
 *
 * The fixture is the real schema on both engines, so every row here needs its parents:
 * tasks.sprint_id is NOT NULL and tasks/sprints/projects all carry foreign keys to tenants.
 * The two tenants matter to the assertions themselves — they are what "isolation" means here —
 * and the PostgreSQL fixture truncates them between tests, so they are seeded explicitly rather
 * than inherited from initSchema's seeding side effects on SQLite.
 */

const DEFAULT_TENANT_ID = 1;
const ECOPOOL_TENANT_ID = 2;
const DEFAULT_PROJECT_ID = 10;
const ECOPOOL_PROJECT_ID = 20;
const DEFAULT_SPRINT_ID = 100;
const ECOPOOL_SPRINT_ID = 200;

/** A canonical-format timestamp N hours in the past, the same form the query's cutoff uses. */
function hoursAgo(hours: number): string {
  return timestampFromEpochMs(Date.now() - hours * 60 * 60 * 1000) as string;
}

async function ensureTenant(id: number, name: string, slug: string, isDefault: 0 | 1): Promise<void> {
  const db = getDb();
  // initSchema seeds the default tenant on SQLite; the PostgreSQL template carries DDL only.
  if (await db.get(`SELECT id FROM tenants WHERE id = ?`, id)) return;
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (?, ?, ?, ?)`, id, name, slug, isDefault);
}

async function seedScope(): Promise<void> {
  const db = getDb();
  await ensureTenant(DEFAULT_TENANT_ID, 'Default', 'default', 1);
  await ensureTenant(ECOPOOL_TENANT_ID, 'EcoPool', 'ecopool', 0);
  await db.run(
    `INSERT INTO projects (id, name, tenant_id) VALUES (?, ?, ?), (?, ?, ?)`,
    DEFAULT_PROJECT_ID, 'Default Project', DEFAULT_TENANT_ID,
    ECOPOOL_PROJECT_ID, 'EcoPool Project', ECOPOOL_TENANT_ID,
  );
  await db.run(
    `INSERT INTO sprints (id, project_id, name, tenant_id) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    DEFAULT_SPRINT_ID, DEFAULT_PROJECT_ID, 'Default Workflow', DEFAULT_TENANT_ID,
    ECOPOOL_SPRINT_ID, ECOPOOL_PROJECT_ID, 'EcoPool Workflow', ECOPOOL_TENANT_ID,
  );
}

async function insertTask(task: {
  id: number;
  tenantId: number;
  title: string;
  projectId: number;
  sprintId: number;
  updatedAt: string;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO tasks (id, tenant_id, title, status, priority, project_id, sprint_id, updated_at)
     VALUES (?, ?, ?, 'done', 'medium', ?, ?, ?)`,
    task.id, task.tenantId, task.title, task.projectId, task.sprintId, task.updatedAt,
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
      projectId: DEFAULT_PROJECT_ID, sprintId: DEFAULT_SPRINT_ID, updatedAt: hoursAgo(1),
    });
    await insertTask({
      id: 2, tenantId: ECOPOOL_TENANT_ID, title: 'EcoPool completed task',
      projectId: ECOPOOL_PROJECT_ID, sprintId: ECOPOOL_SPRINT_ID, updatedAt: hoursAgo(1),
    });
    await insertTask({
      id: 3, tenantId: ECOPOOL_TENANT_ID, title: 'EcoPool stale task',
      projectId: ECOPOOL_PROJECT_ID, sprintId: ECOPOOL_SPRINT_ID, updatedAt: hoursAgo(25),
    });
    await insertDoneHistory(1, DEFAULT_TENANT_ID, hoursAgo(1));
    await insertDoneHistory(2, ECOPOOL_TENANT_ID, hoursAgo(1));
    await insertDoneHistory(3, ECOPOOL_TENANT_ID, hoursAgo(25));

    const db = getDb();
    const ecoPool = await listRecentlyCompletedTasks(db, 24, undefined, ECOPOOL_TENANT_ID);
    expect(ecoPool.tasks.map(task => task.title)).toEqual(['EcoPool completed task']);

    const defaultCompany = await listRecentlyCompletedTasks(db, 24, undefined, DEFAULT_TENANT_ID);
    expect(defaultCompany.tasks.map(task => task.title)).toEqual(['Default completed task']);
  });

  it('applies project and tenant scope together', async () => {
    await insertTask({
      id: 1, tenantId: DEFAULT_TENANT_ID, title: 'Default project task',
      projectId: DEFAULT_PROJECT_ID, sprintId: DEFAULT_SPRINT_ID, updatedAt: hoursAgo(1),
    });
    await insertTask({
      id: 2, tenantId: ECOPOOL_TENANT_ID, title: 'EcoPool project task',
      projectId: ECOPOOL_PROJECT_ID, sprintId: ECOPOOL_SPRINT_ID, updatedAt: hoursAgo(1),
    });

    const db = getDb();
    expect((await listRecentlyCompletedTasks(db, 24, DEFAULT_PROJECT_ID, ECOPOOL_TENANT_ID)).tasks).toEqual([]);
    expect((await listRecentlyCompletedTasks(db, 24, ECOPOOL_PROJECT_ID, ECOPOOL_TENANT_ID)).tasks.map(task => task.title))
      .toEqual(['EcoPool project task']);
  });
});
