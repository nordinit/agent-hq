import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import type { Db } from '../db/adapter/types';
import { ensureProjectBacklogSprint } from './starterSetup';

// A fixed explicit tenant keeps the project/sprint/agent foreign keys below deterministic.
const TENANT_ID = 9000;

async function seedTenant(db: Db): Promise<number> {
  // Nothing in starter setup needs the tenant to be the selected default.
  await db.run(`
    INSERT INTO tenants (id, name, slug, is_default)
    VALUES (?, 'Starter Setup Test', 'starter-setup-test', 0)
  `, TENANT_ID);
  await db.run(`INSERT INTO sprint_types (tenant_id, key, name) VALUES (?, 'generic', 'Generic')`, TENANT_ID);
  return TENANT_ID;
}

describe('starter workspace setup', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await teardownTestDb(); });

  it('creates the backlog workflow without implicitly creating configuration', async () => {
    const db = getDb();
    const tenantId = await seedTenant(db);
    await db.run(`
      INSERT INTO projects (id, tenant_id, name, description, context_md, created_at)
      VALUES (990, ?, 'Default Project', '', '', CURRENT_TIMESTAMP)
    `, tenantId);
    await db.run(`
      INSERT INTO agents (tenant_id, project_id, name, role, job_title, session_key, workspace_path, status)
      VALUES
        (?, 990, 'Cinder', 'Backend engineer', 'Software Engineer', 'agent:cinder', '', 'idle'),
        (?, 990, 'Scout', 'QA and validation', 'QA Engineer', 'agent:scout', '', 'idle')
    `, tenantId, tenantId);

    const sprintId = await ensureProjectBacklogSprint(db, 990);

    const statusCount = Number((await db.get(
      `SELECT COUNT(*) AS n FROM sprint_task_statuses WHERE sprint_id = ?`, sprintId,
    ) as { n: number | string }).n);
    const ruleCount = Number((await db.get(
      `SELECT COUNT(*) AS n FROM sprint_task_routing_rules WHERE sprint_id = ?`, sprintId,
    ) as { n: number | string }).n);

    // Configuration is install-owned. Creating a project backlog must not seed or repair it.
    expect(statusCount).toBe(0);
    expect(ruleCount).toBe(0);
  });

  it('never routes implementation work to an agent merely because its title contains a keyword', async () => {
    const db = getDb();
    const tenantId = await seedTenant(db);
    await db.run(`
      INSERT INTO projects (id, tenant_id, name, description, context_md, created_at)
      VALUES (991, ?, 'Agency', '', '', CURRENT_TIMESTAMP)
    `, tenantId);
    // "Business Development" contains the substring "development". Role text must never be
    // used to infer who implements work — this agent is in sales and cannot write code.
    await db.run(`
      INSERT INTO agents (id, tenant_id, project_id, name, role, job_title, session_key, workspace_path, status)
      VALUES
        (7701, ?, 991, 'James', 'Business Development', '', 'agent:james', '', 'idle'),
        (7702, ?, 991, 'Kepler', 'Backend Engineer', '', 'agent:kepler', '', 'idle')
    `, tenantId, tenantId);

    await ensureProjectBacklogSprint(db, 991);

    const salesRules = await db.all(`
      SELECT task_type, status
      FROM sprint_task_routing_rules
      WHERE agent_id = 7701
    `) as Array<{ task_type: string; status: string }>;

    expect(salesRules).toEqual([]);
  });
});
