import fs from 'fs';
import path from 'path';
import { getDb } from './client';
import { setupTestDb, teardownTestDb } from './testDb';
import { POSTGRES_MIGRATION_DIRS } from './pg/migrationDirs';
import { hashMcpApiKey } from '../lib/mcpApiAuth';

const MIGRATION = fs.readFileSync(path.join(POSTGRES_MIGRATION_DIRS[0], '57-retire-atlas.sql'), 'utf8');

/** Runs migration 57 the way the runner does: as one transaction. */
async function retireAtlas(): Promise<void> {
  const db = getDb();
  await db.withTransaction(async (tx) => {
    await tx.exec(MIGRATION);
  });
}

describe('migration 57: retire Atlas', () => {
  beforeEach(async () => {
    await setupTestDb();
    const db = getDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
    await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Project')`);
    await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type) VALUES (10, 1, 1, 'Workflow', 'generic')`);
    await db.run(`INSERT INTO agents (id, tenant_id, project_id, name, session_key, status, system_role, openclaw_agent_id, enabled) VALUES
      (5, 1, 1, 'Atlas', 'agent:atlas:main', 'idle', 'atlas', 'atlas', 1),
      (6, 1, 1, 'Worker', 'agent:worker:main', 'idle', 'default_developer', 'worker', 1)`);
    await db.run(`INSERT INTO job_instances (id, tenant_id, agent_id, status) VALUES (50, 1, 5, 'done')`);
    await db.run(`INSERT INTO mcp_api_keys (agent_id, tenant_id, name, key_prefix, key_hash, role) VALUES
      (5, 1, 'atlas key', 'ahq_mcp_atlas', ?, 'admin'),
      (6, 1, 'worker key', 'ahq_mcp_worke', ?, 'scoped')`, hashMcpApiKey('ahq_mcp_atlas_key'), hashMcpApiKey('ahq_mcp_worker_key'));
    await db.run(`INSERT INTO workflow_task_routing_rules (tenant_id, workflow_id, task_type, status, agent_id) VALUES
      (1, 10, 'generic', 'ready', 5), (1, 10, 'generic', 'review', 6)`);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('soft-deletes Atlas, revokes its keys and drops its links, keeping its history', async () => {
    await retireAtlas();
    const db = getDb();

    const atlas = await db.get(`SELECT enabled, status, system_role, openclaw_agent_id, session_key, deleted_at FROM agents WHERE id = 5`) as Record<string, unknown>;
    expect(atlas).toMatchObject({ enabled: 0, status: 'idle', system_role: null, openclaw_agent_id: null, session_key: 'deleted:5:agent:atlas:main' });
    expect(atlas.deleted_at).toEqual(expect.any(String));

    expect(await db.get(`SELECT enabled, revoked_at IS NOT NULL AS revoked FROM mcp_api_keys WHERE agent_id = 5`)).toEqual({ enabled: 0, revoked: true });
    expect(await db.value(`SELECT count(*) FROM workflow_task_routing_rules WHERE agent_id = 5`)).toBe(0);
    // Run history still points at the row.
    expect(await db.value(`SELECT agent_id FROM job_instances WHERE id = 50`)).toBe(5);
  });

  it('leaves every other agent alone', async () => {
    await retireAtlas();
    const db = getDb();

    expect(await db.get(`SELECT enabled, system_role, session_key, deleted_at FROM agents WHERE id = 6`)).toEqual({
      enabled: 1, system_role: 'default_developer', session_key: 'agent:worker:main', deleted_at: null,
    });
    expect(await db.get(`SELECT enabled, revoked_at FROM mcp_api_keys WHERE agent_id = 6`)).toEqual({ enabled: 1, revoked_at: null });
    expect(await db.value(`SELECT count(*) FROM workflow_task_routing_rules WHERE agent_id = 6`)).toBe(1);
  });

  it('is a no-op on a second run', async () => {
    await retireAtlas();
    const db = getDb();
    const before = await db.get(`SELECT session_key, deleted_at FROM agents WHERE id = 5`);
    await retireAtlas();
    expect(await db.get(`SELECT session_key, deleted_at FROM agents WHERE id = 5`)).toEqual(before);
  });
});
