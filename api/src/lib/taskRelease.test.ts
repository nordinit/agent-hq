import { setupTestDb, teardownTestDb } from '../db/testDb';
import { assertAtlasDirectStatusGate, canonicalOutcomeRoute, evaluateTaskIntegrity } from './taskRelease';
import { type Db } from "../db/adapter/types";

describe('taskRelease configurable outcome routing', () => {
  let db: Db;
  let tenantId: number;

  beforeEach(async () => {
    db = await setupTestDb();
    // Clear workflow tables so the explicitly built policy below is authoritative.
    await db.exec(`
      DELETE FROM sprint_task_transitions;
      DELETE FROM sprint_type_task_types;
      DELETE FROM sprint_type_outcomes;
      DELETE FROM sprint_types;
      DELETE FROM sprints;
      DELETE FROM tasks;
      DELETE FROM projects;
    `);

    // Nothing under test resolves a tenant globally; the routing helpers derive it from the
    // sprint row, so an explicit non-default tenant keeps the fixture sufficient and unambiguous.
    tenantId = Number((await db.run(
      `INSERT INTO tenants (name, slug, is_default, created_at, updated_at)
       VALUES ('Task Release Test', 'task-release-test', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )).lastInsertId);
    await db.run(`INSERT INTO projects (id, tenant_id, name, description, context_md, created_at) VALUES (1, ?, 'Agent HQ', '', '', CURRENT_TIMESTAMP)`, tenantId);
    await db.run(`INSERT INTO sprint_types (tenant_id, key, name, description, is_system, created_at, updated_at) VALUES (?, 'enhancements', 'Enhancements', '', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, tenantId);
    await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at) VALUES (10, ?, 1, 'Configurable outcomes', '', 'enhancements', 'active', 'time', '2w', CURRENT_TIMESTAMP)`, tenantId);
    await db.run(`INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at) VALUES (?, 10, NULL, 'in_progress', 'ship_it', 'review', 1, 10, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP), (?, 10, NULL, 'in_progress', 'blocked_custom', 'blocked_custom', 1, 5, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, tenantId, tenantId);
    await db.run(`INSERT INTO sprint_type_outcomes (tenant_id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at) VALUES (?, 'enhancements', NULL, 'ship_it', 'Ship It', 'Move to review', 1, 'base', NULL, 0, 0, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP), (?, 'enhancements', NULL, 'blocked_custom', 'Blocked Custom', 'Custom blocked state', 1, 'base', NULL, 1, 0, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, tenantId, tenantId);
    await db.run(`INSERT INTO tasks (id, tenant_id, title, status, sprint_id, task_type, created_at, updated_at) VALUES (42, ?, 'Configurable outcome task', 'in_progress', 10, 'backend', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, tenantId);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('allows a direct status move when a configured custom outcome routes there', async () => {
    await expect(assertAtlasDirectStatusGate(db, {
      id: 42,
      title: 'Configurable outcome task',
      status: 'in_progress',
      sprint_id: 10,
      task_type: 'backend',
    } as never, 'review')).resolves.toBeUndefined();
  });

  it('still rejects unknown status keys even when direct overrides are allowed', async () => {
    await expect(assertAtlasDirectStatusGate(db, {
      id: 42,
      title: 'Configurable outcome task',
      status: 'in_progress',
      sprint_id: 10,
      task_type: 'backend',
    } as never, 'not_a_real_status')).rejects.toThrow('"not_a_real_status" is not a valid task status for this workflow');
  });

  it('documents that direct status overrides are no longer constrained by the routing graph', async () => {
    await expect(assertAtlasDirectStatusGate(db, {
      id: 42,
      title: 'Configurable outcome task',
      status: 'in_progress',
      sprint_id: 10,
      task_type: 'backend',
    } as never, 'done')).resolves.toBeUndefined();
  });

  it('does not resolve through legacy lifecycle_rules when no explicit sprint transition exists', async () => {
    await db.run(`DELETE FROM sprint_task_transitions WHERE sprint_id = ? AND from_status = ? AND outcome = ?`, 10, 'review', 'qa_pass');
    await db.run(`DELETE FROM lifecycle_rules WHERE from_status = ? AND outcome = ?`, 'review', 'qa_pass');
    await db.run(`
      INSERT INTO lifecycle_rules (task_type, from_status, outcome, to_status, enabled, priority)
      VALUES ('backend', 'review', 'qa_pass', 'ready_to_merge', 1, 100)
    `);

    expect(await canonicalOutcomeRoute(db, 'review', 'qa_pass', 'backend', 10, 'enhancements')).toBeNull();
  });

  it('does not mark configuration-style done tasks legacy/unverified when deploy evidence is not part of the workflow', async () => {
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
      VALUES (?, 10, NULL, 'in_progress', 'completed', 'done', 1, 20, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, tenantId);

    const result = await evaluateTaskIntegrity({
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

  it('uses task-type completion contracts over generic live-verification routes for done integrity', async () => {
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
      VALUES
        (?, 10, NULL, 'deployed', 'live_verified', 'done', 1, 10, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        (?, 10, 'configuration', 'in_progress', 'completed', 'done', 1, 20, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, tenantId, tenantId);

    const result = await evaluateTaskIntegrity({
          status: 'done',
          sprint_id: 10,
          task_type: 'configuration',
        }, db);

    expect(result.integrity_state).toBe('clean');
    expect(result.integrity_warnings).not.toContain('Done task is missing deploy evidence.');
    expect(result.integrity_warnings).not.toContain('Done task is missing live verification evidence.');
    expect(result.release_state_label).toBeNull();
    expect(result.is_legacy_unverified_done).toBe(false);
  });

  it('keeps missing deploy/live warnings for done tasks in deploy-verification workflows', async () => {
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
      VALUES (?, 10, NULL, 'deployed', 'live_verified', 'done', 1, 20, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, tenantId);

    const result = await evaluateTaskIntegrity({
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
