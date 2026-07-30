import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import type { Db } from '../db/adapter/types';
import { syncStarterRoutingForProject } from './starterSetup';

// The tenant is created explicitly rather than read back from initSchema's seeding: the PostgreSQL
// fixture carries DDL only and is truncated between tests, so there is no seeded default tenant to
// find. A fixed id keeps the project/sprint/agent foreign keys below satisfiable on both engines.
const TENANT_ID = 9000;

async function seedTenant(db: Db): Promise<number> {
  // is_default = 0 deliberately: SQLite and PostgreSQL both carry a unique partial index over
  // is_default = 1, and on SQLite initSchema has already seeded the default tenant. Nothing in
  // starter routing looks at is_default, so an ordinary tenant is the honest fixture.
  await db.run(`
    INSERT INTO tenants (id, name, slug, is_default)
    VALUES (?, 'Starter Setup Test', 'starter-setup-test', 0)
  `, TENANT_ID);
  return TENANT_ID;
}

describe('starter routing setup', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await teardownTestDb(); });

  it('does not provision dev-only routing statuses for a narrowed lead-generation sprint', async () => {
    const db = getDb();
    const tenantId = await seedTenant(db);

    await db.run(`
      INSERT INTO projects (id, tenant_id, name, description, context_md, created_at)
      VALUES (990, ?, 'Agency', '', '', datetime('now'))
    `, tenantId);
    await db.run(`
      INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at)
      VALUES (9901, ?, 990, 'Lead Generation', '', 'lead_generation', 'active', 'time', 'ongoing', datetime('now'))
    `, tenantId);
    await db.run(`
      INSERT INTO sprint_task_statuses (
        sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json
      ) VALUES
        (9901, 'todo', 'To Do', 'slate', 0, 0, '["ready"]', 0, 1, '{}'),
        (9901, 'ready', 'Ready', 'blue', 0, 0, '["in_progress"]', 1, 0, '{}'),
        (9901, 'in_progress', 'In Progress', 'yellow', 0, 0, '["review"]', 2, 0, '{}'),
        (9901, 'review', 'Review', 'purple', 0, 0, '["approved"]', 3, 0, '{}'),
        (9901, 'approved', 'Approved', 'emerald', 0, 0, '["submitted"]', 4, 0, '{}'),
        (9901, 'submitted', 'Submitted', 'cyan', 0, 0, '["closed"]', 5, 0, '{}'),
        (9901, 'closed', 'Closed', 'green', 1, 0, '[]', 6, 0, '{}')
    `);
    await db.run(`
      INSERT INTO agents (tenant_id, project_id, name, role, job_title, system_role, session_key, workspace_path, status)
      VALUES
        (?, 990, 'Atlas', 'Agency workflow owner', 'PM', 'atlas', 'agent:agency-atlas', '', 'idle'),
        (?, 990, 'Agency Reviewer', 'QA and approval reviewer', 'Reviewer', NULL, 'agent:agency-reviewer', '', 'idle')
    `, tenantId, tenantId);

    await syncStarterRoutingForProject(db, 990);

    const rows = await db.all(`
      SELECT task_type, status
      FROM sprint_task_routing_rules
      WHERE sprint_id = 9901
      ORDER BY task_type ASC, status ASC
    `) as Array<{ task_type: string; status: string }>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map(row => row.status)).toEqual(expect.arrayContaining(['ready', 'review']));
    expect(rows.map(row => row.status)).not.toEqual(expect.arrayContaining([
      'qa_pass',
      'ready_to_merge',
      'deployed',
      'dev_deploy_queued',
      'dev_deploying',
    ]));
  });

  it('preserves ready-to-merge starter routing for dev sprints', async () => {
    const db = getDb();
    const tenantId = await seedTenant(db);

    await db.run(`
      INSERT INTO projects (id, tenant_id, name, description, context_md, created_at)
      VALUES (991, ?, 'Default Project', '', '', datetime('now'))
    `, tenantId);
    await db.run(`
      INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at)
      VALUES (9911, ?, 991, 'Bugs', '', 'dev', 'active', 'time', 'ongoing', datetime('now'))
    `, tenantId);
    await db.run(`
      INSERT INTO agents (tenant_id, project_id, name, role, job_title, session_key, workspace_path, status)
      VALUES
        (?, 991, 'Cinder Backend', 'Backend engineer', 'Software Engineer', 'agent:cinder', '', 'idle'),
        (?, 991, 'Release Owner', 'Release and deployment owner', 'Release Engineer', 'agent:release', '', 'idle')
    `, tenantId, tenantId);

    await syncStarterRoutingForProject(db, 991);

    const statuses = await db.all(`
      SELECT DISTINCT status
      FROM sprint_task_routing_rules
      WHERE sprint_id = 9911
      ORDER BY status ASC
    `) as Array<{ status: string }>;

    expect(statuses.map(row => row.status)).toEqual(expect.arrayContaining(['ready', 'review', 'ready_to_merge']));
  });
});
