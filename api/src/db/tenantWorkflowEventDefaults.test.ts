import { getDb } from './client';
import { setupTestDb, teardownTestDb } from './testDb';
import { bootstrapRoutingAndWorkflowDefaults } from './bootstrapDefaults';
import {
  AGENT_HQ_RUNTIME_SOURCE,
  DEFAULT_WORKFLOW_EVENT_MAPPINGS,
  DEV_ENV_LEASE_MANAGER_SOURCE,
  listWorkflowEventMappings,
  removeDevEnvironmentLeaseManagerWorkflowEventDefaultsForNonDefaultTenants,
} from '../domains/routing/externalEventMappings';

const DEFAULT_TENANT_ID = 1;

/** The explicit default tenant parent required by the installation seeder and mapping rows. */
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

describe('explicit workflow-event default installation and repair', () => {
  beforeEach(async () => {
    await setupTestDb();
    await ensureDefaultTenant();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('does not duplicate default-tenant Dev Environment Lease Manager mappings when the explicit install seeder reruns', async () => {
    const expectedDevLeaseMappings = DEFAULT_WORKFLOW_EVENT_MAPPINGS.filter((row) => row.source === DEV_ENV_LEASE_MANAGER_SOURCE).length;

    await bootstrapRoutingAndWorkflowDefaults(getDb());
    expect(await devLeaseMappingCount(1)).toBe(expectedDevLeaseMappings);

    await bootstrapRoutingAndWorkflowDefaults(getDb());
    expect(await devLeaseMappingCount(1)).toBe(expectedDevLeaseMappings);
  });

  it('keeps operator-authored variants unchanged across explicit install reruns', async () => {
    await bootstrapRoutingAndWorkflowDefaults(getDb());

    const db = getDb();
    // The project-scoped variant below needs a real projects row: project_id carries a
    // REFERENCES projects(id) constraint. Create the parent explicitly rather than assuming an
    // id; PostgreSQL fixtures truncate with RESTART IDENTITY, so ids are not stable across tests.
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
        (1, NULL, ?, 'agent_started', NULL, '[]', '["in_progress","blocked","review","qa_pass","ready_to_merge","deployed","done","cancelled","failed"]', 'status', 'in_progress', 0, 0, 0, 100),
        (1, NULL, ?, 'agent_started', NULL, '[]', '["in_progress","blocked","review","qa_pass","ready_to_merge","deployed","done","cancelled","failed"]', 'status', 'in_progress', 0, 0, 1, 500),
        (1, ?, ?, 'agent_started', NULL, '[]', '["in_progress","blocked","review","qa_pass","ready_to_merge","deployed","done","cancelled","failed"]', 'status', 'in_progress', 0, 0, 1, 100)
    `, AGENT_HQ_RUNTIME_SOURCE, AGENT_HQ_RUNTIME_SOURCE, scopedProjectId, AGENT_HQ_RUNTIME_SOURCE);

    expect(await defaultMappingCloneCount('agent_started')).toBe(1);
    const beforeReinstallTotal = await workflowEventMappingCount();
    const beforeVariants = await db.all(`
      SELECT id, project_id, status_excludes_json, enabled, priority, created_at, updated_at
      FROM external_event_mappings
      WHERE tenant_id = 1
        AND source = ?
        AND event_name = 'agent_started'
        AND (enabled = 0 OR priority = 500 OR project_id = ?)
      ORDER BY id
    `, AGENT_HQ_RUNTIME_SOURCE, scopedProjectId);

    await bootstrapRoutingAndWorkflowDefaults(db);

    expect(await defaultMappingCloneCount('agent_started')).toBe(1);
    expect(await workflowEventMappingCount()).toBe(beforeReinstallTotal);
    expect(await db.all(`
      SELECT id, project_id, status_excludes_json, enabled, priority, created_at, updated_at
      FROM external_event_mappings
      WHERE tenant_id = 1
        AND source = ?
        AND event_name = 'agent_started'
        AND (enabled = 0 OR priority = 500 OR project_id = ?)
      ORDER BY id
    `, AGENT_HQ_RUNTIME_SOURCE, scopedProjectId)).toEqual(beforeVariants);

    const afterReinstallTotal = await workflowEventMappingCount();
    await bootstrapRoutingAndWorkflowDefaults(db);
    expect(await workflowEventMappingCount()).toBe(afterReinstallTotal);

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

    // Re-run the explicit installer. Ordinary startup never calls this seeder, and even an
    // operator-requested install rerun must not leak these defaults into non-default tenants.
    await bootstrapRoutingAndWorkflowDefaults(getDb());
    expect(await devLeaseMappingCount(1)).toBe(expectedDevLeaseMappings);
    expect(await devLeaseMappingCount(2)).toBe(0);
  });
});
