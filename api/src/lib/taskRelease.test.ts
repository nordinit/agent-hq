import Database from 'better-sqlite3';
import { getDb } from '../db/client';
import { initSchema } from '../db/schema';
import { getDefaultTenantId } from './tenantContext';
import { assertAtlasDirectStatusGate, canonicalOutcomeRoute, evaluateTaskIntegrity } from './taskRelease';

describe('taskRelease configurable outcome routing', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = getDb();
    initSchema();
    db.exec(`
      DELETE FROM sprint_task_transitions;
      DELETE FROM sprint_type_task_types;
      DELETE FROM sprint_type_outcomes;
      DELETE FROM sprint_types;
      DELETE FROM sprints;
      DELETE FROM tasks;
      DELETE FROM projects;
    `);

    const tenantId = getDefaultTenantId(db);
    db.prepare(`INSERT INTO projects (id, tenant_id, name, description, context_md, created_at) VALUES (1, ?, 'Agent HQ', '', '', datetime('now'))`).run(tenantId);
    db.prepare(`INSERT INTO sprint_types (tenant_id, key, name, description, is_system, created_at, updated_at) VALUES (?, 'enhancements', 'Enhancements', '', 0, datetime('now'), datetime('now'))`).run(tenantId);
    db.prepare(`INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at) VALUES (10, ?, 1, 'Configurable outcomes', '', 'enhancements', 'active', 'time', '2w', datetime('now'))`).run(tenantId);
    db.prepare(`INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at) VALUES (?, 10, NULL, 'in_progress', 'ship_it', 'review', 1, 10, 0, datetime('now'), datetime('now')), (?, 10, NULL, 'in_progress', 'blocked_custom', 'blocked_custom', 1, 5, 0, datetime('now'), datetime('now'))`).run(tenantId, tenantId);
    db.prepare(`INSERT INTO sprint_type_outcomes (tenant_id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at) VALUES (?, 'enhancements', NULL, 'ship_it', 'Ship It', 'Move to review', 1, 'base', NULL, 0, 0, '{}', datetime('now'), datetime('now')), (?, 'enhancements', NULL, 'blocked_custom', 'Blocked Custom', 'Custom blocked state', 1, 'base', NULL, 1, 0, '{}', datetime('now'), datetime('now'))`).run(tenantId, tenantId);
    db.prepare(`INSERT INTO tasks (id, tenant_id, title, status, sprint_id, task_type, created_at, updated_at) VALUES (42, ?, 'Configurable outcome task', 'in_progress', 10, 'backend', datetime('now'), datetime('now'))`).run(tenantId);
  });

  it('allows a direct status move when a configured custom outcome routes there', () => {
    expect(() => assertAtlasDirectStatusGate(db, {
      id: 42,
      title: 'Configurable outcome task',
      status: 'in_progress',
      sprint_id: 10,
      task_type: 'backend',
    } as never, 'review')).not.toThrow();
  });

  it('still rejects unknown status keys even when direct overrides are allowed', () => {
    expect(() => assertAtlasDirectStatusGate(db, {
      id: 42,
      title: 'Configurable outcome task',
      status: 'in_progress',
      sprint_id: 10,
      task_type: 'backend',
    } as never, 'not_a_real_status')).toThrow('"not_a_real_status" is not a valid task status for this workflow');
  });

  it('documents that direct status overrides are no longer constrained by the routing graph', () => {
    expect(() => assertAtlasDirectStatusGate(db, {
      id: 42,
      title: 'Configurable outcome task',
      status: 'in_progress',
      sprint_id: 10,
      task_type: 'backend',
    } as never, 'done')).not.toThrow();
  });

  it('does not resolve through legacy lifecycle_rules when no explicit sprint transition exists', () => {
    db.prepare(`DELETE FROM sprint_task_transitions WHERE sprint_id = ? AND from_status = ? AND outcome = ?`).run(10, 'review', 'qa_pass');
    db.prepare(`DELETE FROM lifecycle_rules WHERE from_status = ? AND outcome = ?`).run('review', 'qa_pass');
    db.prepare(`
      INSERT INTO lifecycle_rules (task_type, from_status, outcome, to_status, enabled, priority)
      VALUES ('backend', 'review', 'qa_pass', 'ready_to_merge', 1, 100)
    `).run();

    expect(canonicalOutcomeRoute(db, 'review', 'qa_pass', 'backend', 10, 'enhancements')).toBeNull();
  });

  it('does not mark configuration-style done tasks legacy/unverified when deploy evidence is not part of the workflow', () => {
    const tenantId = getDefaultTenantId(db);
    db.prepare(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
      VALUES (?, 10, NULL, 'in_progress', 'completed', 'done', 1, 20, 0, datetime('now'), datetime('now'))
    `).run(tenantId);

    const result = evaluateTaskIntegrity({
      status: 'done',
      sprint_id: 10,
      task_type: 'configuration',
    }, db);

    expect(result.integrity_state).toBe('clean');
    expect(result.integrity_warnings).not.toContain('Done task is missing deploy evidence.');
    expect(result.integrity_warnings).not.toContain('Done task is missing live verification evidence.');
    expect(result.release_state_badge).toBeNull();
    expect(result.release_state_label).toBeNull();
    expect(result.is_legacy_unverified_done).toBe(false);
  });

  it('does not let generic deploy/live transitions make configuration-specific done tasks legacy/unverified', () => {
    const tenantId = getDefaultTenantId(db);
    db.prepare(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
      VALUES
        (?, 10, NULL, 'deployed', 'live_verified', 'done', 1, 20, 0, datetime('now'), datetime('now')),
        (?, 10, 'configuration', 'review', 'qa_pass', 'done', 1, 200, 0, datetime('now'), datetime('now'))
    `).run(tenantId, tenantId);

    const result = evaluateTaskIntegrity({
      status: 'done',
      sprint_id: 10,
      task_type: 'configuration',
    }, db);

    expect(result.integrity_state).toBe('clean');
    expect(result.integrity_warnings).not.toContain('Done task is missing deploy evidence.');
    expect(result.integrity_warnings).not.toContain('Done task is missing live verification evidence.');
    expect(result.release_state_badge).toBeNull();
    expect(result.release_state_label).toBeNull();
    expect(result.is_legacy_unverified_done).toBe(false);
  });

  it('keeps missing deploy/live warnings for done tasks in deploy-verification workflows', () => {
    const tenantId = getDefaultTenantId(db);
    db.prepare(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
      VALUES (?, 10, NULL, 'deployed', 'live_verified', 'done', 1, 20, 0, datetime('now'), datetime('now'))
    `).run(tenantId);

    const result = evaluateTaskIntegrity({
      status: 'done',
      sprint_id: 10,
      task_type: 'backend',
    }, db);

    expect(result.integrity_state).toBe('invalid_done_state');
    expect(result.integrity_warnings).toContain('Done task is missing deploy evidence.');
    expect(result.integrity_warnings).toContain('Done task is missing live verification evidence.');
    expect(result.release_state_label).toBe('Done (legacy, unverified)');
    expect(result.is_legacy_unverified_done).toBe(true);
  });
});
