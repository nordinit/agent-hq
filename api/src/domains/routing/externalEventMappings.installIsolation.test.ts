import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { seedTenantDefaultWorkflowEventMappings } from './externalEventMappings';

describe('tenant starter workflow-event installation isolation', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('does not normalize or alter another tenant configuration', async () => {
    const db = getDb();
    const firstTenantId = Number((await db.run(
      `INSERT INTO tenants (name, slug, is_default) VALUES (?, ?, 1)`,
      'First tenant', 'first-tenant',
    )).lastInsertId);
    const secondTenantId = Number((await db.run(
      `INSERT INTO tenants (name, slug, is_default) VALUES (?, ?, 0)`,
      'Second tenant', 'second-tenant',
    )).lastInsertId);

    // Preserve two deliberately operator-authored variants. Tenant-two installation is allowed
    // to create tenant-two defaults; neither first-tenant row is its configuration to normalize.
    await db.run(`
      INSERT INTO external_event_mappings (
        tenant_id, project_id, source, event_name, task_type,
        status_includes_json, status_excludes_json, action_kind, action_target,
        apply_review_evidence, apply_failure_detail, enabled, priority
      ) VALUES
        (?, NULL, 'agent-hq-runtime', 'agent_started', NULL,
          '[]', '[]', 'status', 'in_progress', 0, 0, 1, 100),
        (?, NULL, 'agent-hq-runtime', 'agent_started', NULL,
          '[]', '["blocked"]', 'status', 'in_progress', 0, 0, 1, 500)
    `, firstTenantId, firstTenantId);

    const before = await db.all(`
      SELECT id, tenant_id, source, event_name, status_excludes_json, action_kind,
             action_target, enabled, priority, created_at, updated_at
      FROM external_event_mappings
      WHERE tenant_id = ?
      ORDER BY id
    `, firstTenantId);

    await seedTenantDefaultWorkflowEventMappings(db, secondTenantId);

    expect(await db.all(`
      SELECT id, tenant_id, source, event_name, status_excludes_json, action_kind,
             action_target, enabled, priority, created_at, updated_at
      FROM external_event_mappings
      WHERE tenant_id = ?
      ORDER BY id
    `, firstTenantId)).toEqual(before);
    expect((await db.get(
      `SELECT COUNT(*) AS count FROM external_event_mappings WHERE tenant_id = ?`,
      secondTenantId,
    ) as { count: number }).count).toBeGreaterThan(0);
  });
});
