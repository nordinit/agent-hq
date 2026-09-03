import { setupTestDb, teardownTestDb } from '../db/testDb';
import { assertAtlasDirectStatusGate, canonicalOutcomeRoute, evaluateTaskIntegrity, requireReleaseGate } from './taskRelease';
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

  it('does not warn about review evidence, whatever the task type', async () => {
    // A design, PM, or configuration task reaches review with no branch or commit to cite. The
    // old unconditional check dated from a board where every task was development work.
    for (const task_type of ['backend', 'design', 'pm', 'configuration']) {
      const result = await evaluateTaskIntegrity({ status: 'review', sprint_id: 10, task_type }, db);

      expect({ task_type, warnings: result.integrity_warnings }).toEqual({ task_type, warnings: [] });
      expect({ task_type, state: result.integrity_state }).toEqual({ task_type, state: 'clean' });
    }
  });

  it('leaves evidence enforcement to the configured transition gate', async () => {
    // The integrity read no longer decides anything; requireReleaseGate does, per outcome and
    // task type, and it is the only place an evidence rule is written down.
    await db.run(`
      INSERT INTO sprint_task_transition_requirements
        (tenant_id, sprint_id, project_id, sprint_type, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority)
      VALUES (?, 10, 1, 'enhancements', NULL, 'qa_pass', 'qa_verified_commit', 'required', NULL, 'block', 'qa_pass requires qa_verified_commit', 1, 10)
    `, tenantId);

    const task = { id: 42, status: 'review', sprint_id: 10, task_type: 'backend' } as never;

    const blocked = await requireReleaseGate(db, task, 'qa_pass', 'backend');
    expect(blocked.errors).toContain('qa_pass requires qa_verified_commit');

    // An outcome the workflow does not gate stays ungated.
    const ungated = await requireReleaseGate(db, task, 'qa_fail', 'backend');
    expect(ungated).toEqual({ errors: [], warnings: [] });
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

  it('does not judge a done task on deploy or live evidence, even in a deploy-verification workflow', async () => {
    // This used to report invalid_done_state and label the task "Done (legacy, unverified)".
    // Whether done owes deploy and live evidence is the workflow's call, expressed as a gate on
    // the transition into done, not a verdict passed on every task that already got there.
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
      VALUES (?, 10, NULL, 'deployed', 'live_verified', 'done', 1, 20, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, tenantId);

    const result = await evaluateTaskIntegrity({
          status: 'done',
          sprint_id: 10,
          task_type: 'backend',
        }, db);

    expect(result.integrity_state).toBe('clean');
    expect(result.integrity_warnings).toEqual([]);
    expect(result.is_legacy_unverified_done).toBe(false);
    expect(result.release_state_label).toBeNull();
  });

  it('accumulates task-type gates on top of the all-types defaults', async () => {
    // A task-type row used to REPLACE the whole all-types set for that outcome, so adding one
    // narrow gate silently switched off every default. It now adds to them.
    await db.run(`
      INSERT INTO sprint_task_transition_requirements
        (tenant_id, sprint_id, project_id, sprint_type, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority)
      VALUES
        (?, 10, 1, 'enhancements', NULL,      'qa_pass', 'review_commit',      'required', NULL, 'block', 'default: review_commit', 1, 10),
        (?, 10, 1, 'enhancements', 'backend', 'qa_pass', 'qa_verified_commit', 'required', NULL, 'block', 'backend: qa_verified_commit', 1, 20)
    `, tenantId, tenantId);

    const task = { id: 42, status: 'review', sprint_id: 10, task_type: 'backend' } as never;

    const backend = await requireReleaseGate(db, task, 'qa_pass', 'backend');
    expect(backend.errors).toEqual(expect.arrayContaining([
      'default: review_commit',
      'backend: qa_verified_commit',
    ]));

    // A type with no rows of its own still sees the defaults, as before.
    const design = await requireReleaseGate(db, task, 'qa_pass', 'design');
    expect(design.errors).toEqual(['default: review_commit']);
  });

  it('lets a task-type gate override the single all-types gate it names', async () => {
    // Overriding one field is still possible — it just no longer takes the rest of the set with
    // it. Here backend softens review_commit to a warning while the other default still blocks.
    await db.run(`
      INSERT INTO sprint_task_transition_requirements
        (tenant_id, sprint_id, project_id, sprint_type, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority)
      VALUES
        (?, 10, 1, 'enhancements', NULL,      'qa_pass', 'review_commit', 'required', NULL, 'block', 'default: review_commit', 1, 10),
        (?, 10, 1, 'enhancements', NULL,      'qa_pass', 'qa_tested_url', 'required', NULL, 'block', 'default: qa_tested_url', 1, 10),
        (?, 10, 1, 'enhancements', 'backend', 'qa_pass', 'review_commit', 'required', NULL, 'warn',  'backend: review_commit is advisory', 1, 20)
    `, tenantId, tenantId, tenantId);

    const task = { id: 42, status: 'review', sprint_id: 10, task_type: 'backend' } as never;
    const result = await requireReleaseGate(db, task, 'qa_pass', 'backend');

    expect(result.warnings).toEqual(['backend: review_commit is advisory']);
    expect(result.errors).toEqual(['default: qa_tested_url']);
    expect(result.errors).not.toContain('default: review_commit');
  });

  it('still restates the task status as a release badge', async () => {
    // The badge survives because it describes where the task is, rather than ruling on it.
    const review = await evaluateTaskIntegrity({ status: 'review', sprint_id: 10, task_type: 'design' }, db);
    expect(review.release_state_badge).toBe('review build');
    expect(review.integrity_warnings).toEqual([]);

    const deployed = await evaluateTaskIntegrity({ status: 'deployed', sprint_id: 10, task_type: 'backend' }, db);
    expect(deployed.release_state_badge).toBe('live deployed');
    expect(deployed.integrity_warnings).toEqual([]);
  });
});
