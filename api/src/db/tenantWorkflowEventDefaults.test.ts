import { getDb } from './client';
import { initSchema } from './schema';
import { setupTestDb, teardownTestDb, usingPostgres } from './testDb';
import { bootstrapRoutingAndWorkflowDefaults } from './bootstrapDefaults';
import {
  AGENT_HQ_RUNTIME_SOURCE,
  DEFAULT_WORKFLOW_EVENT_MAPPINGS,
  DEV_ENV_LEASE_MANAGER_SOURCE,
  listWorkflowEventMappings,
  removeDevEnvironmentLeaseManagerWorkflowEventDefaultsForNonDefaultTenants,
} from '../domains/routing/externalEventMappings';

const DEFAULT_TENANT_ID = 1;

/**
 * The default tenant row every assertion in this file is scoped to.
 *
 * On SQLite initSchema() seeded it as a side effect; the PostgreSQL fixture template carries DDL
 * only and is truncated between tests, so it is simply absent there. Rather than depend on a
 * seeding side effect on one engine, insert it explicitly on both: the seeding path under test
 * resolves its target tenant through getDefaultTenantIdIfAvailable(), which needs a real
 * is_default = 1 row, and external_event_mappings.tenant_id is a real foreign key on PostgreSQL.
 */
async function ensureDefaultTenant(): Promise<void> {
  const db = getDb();
  const existing = await db.get(`SELECT id FROM tenants WHERE id = ?`, DEFAULT_TENANT_ID);
  if (existing) return;
  await db.run(
    `INSERT INTO tenants (id, name, slug, is_default) VALUES (?, ?, ?, 1)`,
    DEFAULT_TENANT_ID, 'Default', 'default',
  );
}

async function devLeaseMappingCount(tenantId: number): Promise<number> {
  const db = getDb();
  return Number((await db.get(`
    SELECT COUNT(*) AS count
    FROM external_event_mappings
    WHERE tenant_id = ?
      AND project_id IS NULL
      AND source = ?
  `, tenantId, DEV_ENV_LEASE_MANAGER_SOURCE) as { count: number }).count);
}

async function copyDefaultDevLeaseMappingsToTenant(targetTenantId: number): Promise<void> {
  const db = getDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (?, ?, ?, 0)`, targetTenantId, 'Tenant Two', 'tenant-two');
  await db.run(`
    INSERT INTO external_event_mappings (
      tenant_id,
      project_id,
      source,
      event_name,
      task_type,
      status_includes_json,
      status_excludes_json,
      action_kind,
      action_target,
      apply_review_evidence,
      apply_failure_detail,
      enabled,
      priority,
      created_at,
      updated_at
    )
    SELECT
      ?,
      project_id,
      source,
      event_name,
      task_type,
      status_includes_json,
      status_excludes_json,
      action_kind,
      action_target,
      apply_review_evidence,
      apply_failure_detail,
      enabled,
      priority,
      created_at,
      updated_at
    FROM external_event_mappings
    WHERE tenant_id = 1
      AND project_id IS NULL
      AND source = ?
  `, targetTenantId, DEV_ENV_LEASE_MANAGER_SOURCE);
}

async function workflowEventMappingCount(): Promise<number> {
  return Number((await getDb().get(`
    SELECT COUNT(*) AS count
    FROM external_event_mappings
  `) as { count: number }).count);
}

async function defaultMappingCloneCount(eventName: string): Promise<number> {
  return Number((await getDb().get(`
    SELECT COUNT(*) AS count
    FROM external_event_mappings
    WHERE tenant_id = 1
      AND project_id IS NULL
      AND source = ?
      AND event_name = ?
      AND task_type IS NULL
      AND status_includes_json = '[]'
      AND action_kind = 'status'
      AND action_target = 'in_progress'
      AND apply_review_evidence = 0
      AND apply_failure_detail = 0
      AND enabled = 1
      AND priority = 100
  `, AGENT_HQ_RUNTIME_SOURCE, eventName) as { count: number }).count);
}

describe('tenant workflow-event default seeding and repair', () => {
  beforeEach(async () => {
    // setupTestDb() picks the engine from AGENT_HQ_TEST_PG_URL, so this file runs unchanged on
    // SQLite and on PostgreSQL. It replaces the old temp-file + initSchema() dance entirely.
    await setupTestDb();
    await ensureDefaultTenant();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('does not duplicate default-tenant Dev Environment Lease Manager mappings when explicit bootstrap reruns', async () => {
    const expectedDevLeaseMappings = DEFAULT_WORKFLOW_EVENT_MAPPINGS.filter((row) => row.source === DEV_ENV_LEASE_MANAGER_SOURCE).length;

    await bootstrapRoutingAndWorkflowDefaults(getDb());
    expect(await devLeaseMappingCount(1)).toBe(expectedDevLeaseMappings);

    await bootstrapRoutingAndWorkflowDefaults(getDb());
    expect(await devLeaseMappingCount(1)).toBe(expectedDevLeaseMappings);
  });

  it('collapses legacy duplicate default mappings and keeps custom variants across reinstall reruns', async () => {
    await bootstrapRoutingAndWorkflowDefaults(getDb());

    const db = getDb();
    await db.exec(`
      DROP INDEX IF EXISTS idx_external_event_mappings_effective_unique_no_tenant;
      DROP INDEX IF EXISTS idx_external_event_mappings_effective_unique_tenant;
    `);
    await db.run(`
      INSERT INTO external_event_mappings (
        tenant_id, project_id, source, event_name, task_type,
        status_includes_json, status_excludes_json, action_kind, action_target,
        apply_review_evidence, apply_failure_detail, enabled, priority, created_at, updated_at
      )
      SELECT
        tenant_id, project_id, source, event_name, task_type,
        status_includes_json, status_excludes_json, action_kind, action_target,
        apply_review_evidence, apply_failure_detail, enabled, priority,
        datetime('now'), datetime('now')
      FROM external_event_mappings
      WHERE tenant_id = 1
        AND project_id IS NULL
        AND source = ?
        AND event_name = 'agent_started'
    `, AGENT_HQ_RUNTIME_SOURCE);
    // The project-scoped variant below needs a real projects row: project_id carries a
    // REFERENCES projects(id) constraint, and this fixture previously hardcoded id 1,
    // which only inserted because foreign-key enforcement had leaked OFF during schema
    // init. Create the parent explicitly rather than assuming an id — on PostgreSQL the
    // fixture truncates with RESTART IDENTITY, so ids are not stable across tests either.
    const scopedProjectId = Number((await db.run(`
      INSERT INTO projects (tenant_id, name, description, context_md)
      VALUES (1, 'Workflow event scope fixture', 'project-scoped mapping variant', '')
    `)).lastInsertId);

    await db.run(`
      INSERT INTO external_event_mappings (
        tenant_id, project_id, source, event_name, task_type,
        status_includes_json, status_excludes_json, action_kind, action_target,
        apply_review_evidence, apply_failure_detail, enabled, priority
      ) VALUES
        (1, NULL, ?, 'agent_started', NULL, '[]', '["in_progress","blocked","review","qa_pass","ready_to_merge","deployed","done","cancelled","failed"]', 'status', 'in_progress', 0, 0, 1, 100),
        (1, NULL, ?, 'agent_started', NULL, '[]', '["in_progress","blocked","review","qa_pass","ready_to_merge","deployed","done","cancelled","failed"]', 'status', 'in_progress', 0, 0, 0, 100),
        (1, NULL, ?, 'agent_started', NULL, '[]', '["in_progress","blocked","review","qa_pass","ready_to_merge","deployed","done","cancelled","failed"]', 'status', 'in_progress', 0, 0, 1, 500),
        (1, ?, ?, 'agent_started', NULL, '[]', '["in_progress","blocked","review","qa_pass","ready_to_merge","deployed","done","cancelled","failed"]', 'status', 'in_progress', 0, 0, 1, 100)
    `, AGENT_HQ_RUNTIME_SOURCE, AGENT_HQ_RUNTIME_SOURCE, AGENT_HQ_RUNTIME_SOURCE, scopedProjectId, AGENT_HQ_RUNTIME_SOURCE);

    expect(await defaultMappingCloneCount('agent_started')).toBe(3);
    const beforeRepairTotal = await workflowEventMappingCount();

    await bootstrapRoutingAndWorkflowDefaults(db);

    expect(await defaultMappingCloneCount('agent_started')).toBe(1);
    expect(await workflowEventMappingCount()).toBe(beforeRepairTotal - 2);
    expect(Number((await db.get(`
      SELECT COUNT(*) AS count
      FROM external_event_mappings
      WHERE tenant_id = 1
        AND source = ?
        AND event_name = 'agent_started'
        AND (
          enabled = 0
          OR priority = 500
          OR project_id = ?
        )
    `, AGENT_HQ_RUNTIME_SOURCE, scopedProjectId) as { count: number }).count)).toBe(3);

    const afterRepairTotal = await workflowEventMappingCount();
    await bootstrapRoutingAndWorkflowDefaults(db);
    expect(await workflowEventMappingCount()).toBe(afterRepairTotal);

    const body = await listWorkflowEventMappings(db, { tenant_id: 1, event_name: 'agent_started' });
    const defaultRows = body.mappings.filter((mapping) => (
      mapping.project_id === null
      && mapping.source === AGENT_HQ_RUNTIME_SOURCE
      && mapping.action_kind === 'status'
      && mapping.action_target === 'in_progress'
      && mapping.enabled === 1
      && mapping.priority === 100
    ));
    expect(defaultRows).toHaveLength(1);
    expect(defaultRows[0].conflicts_with).toEqual([]);
  });

  it('repairs leaked non-default tenant Dev Environment Lease Manager mappings without changing default rows', async () => {
    const expectedDevLeaseMappings = DEFAULT_WORKFLOW_EVENT_MAPPINGS.filter((row) => row.source === DEV_ENV_LEASE_MANAGER_SOURCE).length;

    await bootstrapRoutingAndWorkflowDefaults(getDb());
    await copyDefaultDevLeaseMappingsToTenant(2);
    expect(await devLeaseMappingCount(1)).toBe(expectedDevLeaseMappings);
    expect(await devLeaseMappingCount(2)).toBe(expectedDevLeaseMappings);

    const result = await removeDevEnvironmentLeaseManagerWorkflowEventDefaultsForNonDefaultTenants(getDb());

    expect(result).toEqual({ deleted: expectedDevLeaseMappings, tenants: 1 });
    expect(await devLeaseMappingCount(1)).toBe(expectedDevLeaseMappings);
    expect(await devLeaseMappingCount(2)).toBe(0);

    // Re-run startup so the guarantee "startup must not resurrect what the repair deleted" is
    // still covered. initSchema() is SQLite-only machinery — it goes through getRawDb(), the raw
    // better-sqlite3 handle, so calling it under a PostgreSQL run would open an unrelated SQLite
    // file and assert nothing. On PostgreSQL run the startup path that actually could re-add the
    // rows: the defaults bootstrap (schema DDL itself seeds no mappings).
    if (usingPostgres()) await bootstrapRoutingAndWorkflowDefaults(getDb());
    else await initSchema();
    expect(await devLeaseMappingCount(1)).toBe(expectedDevLeaseMappings);
    expect(await devLeaseMappingCount(2)).toBe(0);
  });
});
