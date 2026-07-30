import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import { syncStarterRoutingForProject } from './starterSetup';

const originalDbPath = process.env.AGENT_HQ_DB_PATH;
let tempDir = '';

async function resetDb(): Promise<void> {
  closeDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-setup-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  await initSchema();
}

function cleanup(): void {
  closeDb();
  if (originalDbPath == null) delete process.env.AGENT_HQ_DB_PATH;
  else process.env.AGENT_HQ_DB_PATH = originalDbPath;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
}

async function defaultTenantId(): Promise<number> {
  const row = await getDb().get(`SELECT id FROM tenants WHERE is_default = 1 ORDER BY id ASC LIMIT 1`) as { id: number } | undefined;
  if (!row) throw new Error('default tenant missing');
  return row.id;
}

describe('starter routing setup', () => {
  afterEach(cleanup);

  it('does not provision dev-only routing statuses for a narrowed lead-generation sprint', async () => {
    await resetDb();
    const db = getDb();
    const tenantId = await defaultTenantId();

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
    await resetDb();
    const db = getDb();
    const tenantId = await defaultTenantId();

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
