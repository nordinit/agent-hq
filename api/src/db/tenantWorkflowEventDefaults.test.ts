import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from './client';
import { initSchema } from './schema';
import { bootstrapRoutingAndWorkflowDefaults } from './bootstrapDefaults';
import {
  AGENT_HQ_RUNTIME_SOURCE,
  DEFAULT_WORKFLOW_EVENT_MAPPINGS,
  DEV_ENV_LEASE_MANAGER_SOURCE,
  listWorkflowEventMappings,
  removeDevEnvironmentLeaseManagerWorkflowEventDefaultsForNonDefaultTenants,
} from '../domains/routing/externalEventMappings';

let tempDir = '';
let originalDbPath: string | undefined;

function devLeaseMappingCount(tenantId: number): number {
  const db = getDb();
  return Number((db.prepare(`
    SELECT COUNT(*) AS count
    FROM external_event_mappings
    WHERE tenant_id = ?
      AND project_id IS NULL
      AND source = ?
  `).get(tenantId, DEV_ENV_LEASE_MANAGER_SOURCE) as { count: number }).count);
}

function copyDefaultDevLeaseMappingsToTenant(targetTenantId: number): void {
  const db = getDb();
  db.prepare(`INSERT INTO tenants (id, name, slug, is_default) VALUES (?, ?, ?, 0)`).run(targetTenantId, 'Tenant Two', 'tenant-two');
  db.prepare(`
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
  `).run(targetTenantId, DEV_ENV_LEASE_MANAGER_SOURCE);
}

function workflowEventMappingCount(): number {
  return Number((getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM external_event_mappings
  `).get() as { count: number }).count);
}

function defaultMappingCloneCount(eventName: string): number {
  return Number((getDb().prepare(`
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
  `).get(AGENT_HQ_RUNTIME_SOURCE, eventName) as { count: number }).count);
}

describe('tenant workflow-event default seeding and repair', () => {
  beforeEach(() => {
    originalDbPath = process.env.AGENT_HQ_DB_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-workflow-event-defaults-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
    closeDb();
  });

  afterEach(() => {
    closeDb();
    if (originalDbPath === undefined) {
      delete process.env.AGENT_HQ_DB_PATH;
    } else {
      process.env.AGENT_HQ_DB_PATH = originalDbPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not duplicate default-tenant Dev Environment Lease Manager mappings when explicit bootstrap reruns', () => {
    const expectedDevLeaseMappings = DEFAULT_WORKFLOW_EVENT_MAPPINGS.filter((row) => row.source === DEV_ENV_LEASE_MANAGER_SOURCE).length;

    initSchema();
    bootstrapRoutingAndWorkflowDefaults(getDb());
    expect(devLeaseMappingCount(1)).toBe(expectedDevLeaseMappings);

    bootstrapRoutingAndWorkflowDefaults(getDb());
    expect(devLeaseMappingCount(1)).toBe(expectedDevLeaseMappings);
  });

  it('collapses legacy duplicate default mappings and keeps custom variants across reinstall reruns', () => {
    initSchema();
    bootstrapRoutingAndWorkflowDefaults(getDb());

    const db = getDb();
    db.exec(`
      DROP INDEX IF EXISTS idx_external_event_mappings_effective_unique_no_tenant;
      DROP INDEX IF EXISTS idx_external_event_mappings_effective_unique_tenant;
    `);
    db.prepare(`
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
    `).run(AGENT_HQ_RUNTIME_SOURCE);
    db.prepare(`
      INSERT INTO external_event_mappings (
        tenant_id, project_id, source, event_name, task_type,
        status_includes_json, status_excludes_json, action_kind, action_target,
        apply_review_evidence, apply_failure_detail, enabled, priority
      ) VALUES
        (1, NULL, ?, 'agent_started', NULL, '[]', '["in_progress","blocked","review","qa_pass","ready_to_merge","deployed","done","cancelled","failed"]', 'status', 'in_progress', 0, 0, 1, 100),
        (1, NULL, ?, 'agent_started', NULL, '[]', '["in_progress","blocked","review","qa_pass","ready_to_merge","deployed","done","cancelled","failed"]', 'status', 'in_progress', 0, 0, 0, 100),
        (1, NULL, ?, 'agent_started', NULL, '[]', '["in_progress","blocked","review","qa_pass","ready_to_merge","deployed","done","cancelled","failed"]', 'status', 'in_progress', 0, 0, 1, 500),
        (1, 1, ?, 'agent_started', NULL, '[]', '["in_progress","blocked","review","qa_pass","ready_to_merge","deployed","done","cancelled","failed"]', 'status', 'in_progress', 0, 0, 1, 100)
    `).run(AGENT_HQ_RUNTIME_SOURCE, AGENT_HQ_RUNTIME_SOURCE, AGENT_HQ_RUNTIME_SOURCE, AGENT_HQ_RUNTIME_SOURCE);

    expect(defaultMappingCloneCount('agent_started')).toBe(3);
    const beforeRepairTotal = workflowEventMappingCount();

    bootstrapRoutingAndWorkflowDefaults(db);

    expect(defaultMappingCloneCount('agent_started')).toBe(1);
    expect(workflowEventMappingCount()).toBe(beforeRepairTotal - 2);
    expect((db.prepare(`
      SELECT COUNT(*) AS count
      FROM external_event_mappings
      WHERE tenant_id = 1
        AND source = ?
        AND event_name = 'agent_started'
        AND (
          enabled = 0
          OR priority = 500
          OR project_id = 1
        )
    `).get(AGENT_HQ_RUNTIME_SOURCE) as { count: number }).count).toBe(3);

    const afterRepairTotal = workflowEventMappingCount();
    bootstrapRoutingAndWorkflowDefaults(db);
    expect(workflowEventMappingCount()).toBe(afterRepairTotal);

    const body = listWorkflowEventMappings(db, { tenant_id: 1, event_name: 'agent_started' });
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

  it('repairs leaked non-default tenant Dev Environment Lease Manager mappings without changing default rows', () => {
    const expectedDevLeaseMappings = DEFAULT_WORKFLOW_EVENT_MAPPINGS.filter((row) => row.source === DEV_ENV_LEASE_MANAGER_SOURCE).length;

    initSchema();
    bootstrapRoutingAndWorkflowDefaults(getDb());
    copyDefaultDevLeaseMappingsToTenant(2);
    expect(devLeaseMappingCount(1)).toBe(expectedDevLeaseMappings);
    expect(devLeaseMappingCount(2)).toBe(expectedDevLeaseMappings);

    const result = removeDevEnvironmentLeaseManagerWorkflowEventDefaultsForNonDefaultTenants(getDb());

    expect(result).toEqual({ deleted: expectedDevLeaseMappings, tenants: 1 });
    expect(devLeaseMappingCount(1)).toBe(expectedDevLeaseMappings);
    expect(devLeaseMappingCount(2)).toBe(0);

    initSchema();
    expect(devLeaseMappingCount(1)).toBe(expectedDevLeaseMappings);
    expect(devLeaseMappingCount(2)).toBe(0);
  });
});
