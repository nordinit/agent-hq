import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from './client';
import { installInitialConfiguration } from './migrate';
import { setupTestDb, teardownTestDb } from './testDb';
import { resolveWorkflowMetadata } from '../domains/sprint-definitions/workflowMetadata';
import { seedSprintTaskPolicy } from '../domains/routing/policy';
import { ensureTenantSchema } from '../lib/tenantContext';
import type { Db } from './adapter/types';

/**
 * Validates the explicitly installed tenant before reading its starter workflow definitions.
 * ensureTenantSchema() is deliberately read-only; installation owns all seeding.
 */
async function seedStarterDefinitions(db: Db): Promise<number> {
  const install = await installInitialConfiguration(db);
  if (!install.installed) {
    throw new Error('sprint field schema fixture expected a fresh explicit installation');
  }
  return await ensureTenantSchema(db);
}

describe('sprint field schema seeding', () => {
  let workspaceRoot = '';

  beforeEach(async () => {
    // Keep any explicitly installed workspace files out of the developer's runtime directory.
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-field-schema-ws-'));
    process.env.WORKSPACE_PARENT = workspaceRoot;
    await setupTestDb();
  });

  afterEach(async () => {
    await teardownTestDb();
    delete process.env.WORKSPACE_PARENT;
    if (workspaceRoot) fs.rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = '';
  });

  it('seeds dev sprint fields as unified task fields', async () => {
    const db = getDb();
    await seedStarterDefinitions(db);

    const row = await db.get(`
      SELECT schema_json
      FROM task_field_schemas
      WHERE sprint_type_key = 'dev' AND task_type IS NULL
      LIMIT 1
    `) as { schema_json: string };

    const schema = JSON.parse(row.schema_json) as { fields: Array<Record<string, unknown>> };
    expect(schema.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'review_branch' }),
      expect.objectContaining({ key: 'qa_verified_commit' }),
      expect.objectContaining({ key: 'deployed_commit' }),
      expect.objectContaining({ key: 'live_verified_at' }),
      expect.objectContaining({ key: 'target_surface' }),
    ]));
    for (const field of schema.fields) {
      expect(field).not.toHaveProperty('source');
      expect(field).not.toHaveProperty('gate_requirement');
    }
    expect(schema.fields.map(field => field.key)).not.toEqual(expect.arrayContaining(['id', 'status']));
    expect(schema.fields.filter(field => field.system === true).map(field => field.key)).toEqual([]);
  });

  it('resolves dev task workflow metadata from sprint task policy', async () => {
    const db = getDb();
    const tenantId = await seedStarterDefinitions(db);

    await db.run(`
      INSERT INTO projects (id, tenant_id, name, description, context_md, created_at)
      VALUES (910, ?, 'Agent HQ', '', '', CURRENT_TIMESTAMP)
    `, tenantId);
    await db.run(`
      INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at)
      VALUES (9101, ?, 910, 'Dev Sprint', '', 'dev', 'active', 'time', '2w', CURRENT_TIMESTAMP)
    `, tenantId);
    await seedSprintTaskPolicy(db, 9101);

    const metadata = await resolveWorkflowMetadata(db, { sprintId: 9101, taskType: 'backend' });

    expect(metadata.statuses.map(status => status.name)).toEqual([
      'todo',
      'ready',
      'in_progress',
      'dev_deploy_queued',
      'dev_deploying',
      'review',
      'ready_to_merge',
      'deployed',
      'done',
      'needs_attention',
      'cancelled',
      'stalled',
      'failed',
      'blocked',
    ]);
    expect(metadata.statuses.map(status => status.name)).not.toEqual(expect.arrayContaining(['planned', 'building', 'verifying', 'shipped']));
    expect(metadata.outcomes.map(outcome => outcome.outcome_key)).toEqual(expect.arrayContaining([
      'completed_for_review',
      'dev_deploy_queued',
      'qa_pass',
      'qa_fail',
      'deployed_live',
      'live_verified',
      'blocked',
      'failed',
      'retry',
    ]));
    expect(metadata.statuses.map(status => status.name)).not.toContain('qa_pass');
    expect(metadata.non_failure_outcomes).toEqual(expect.arrayContaining(['qa_fail', 'blocked', 'live_verified']));
    expect(metadata.non_failure_outcomes).not.toContain('failed');
  });

  it('filters stale starter transitions out of custom workflow metadata readbacks', async () => {
    const db = getDb();
    const tenantId = await seedStarterDefinitions(db);

    await db.run(`
      INSERT INTO projects (id, tenant_id, name, description, context_md, created_at)
      VALUES (990, ?, 'Agency', '', '', CURRENT_TIMESTAMP)
    `, tenantId);
    await db.run(`
      INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, task_policy_seeded_at, length_kind, length_value, created_at)
      VALUES (9901, ?, 990, 'Lead Generation', '', 'lead_generation', 'active', CURRENT_TIMESTAMP, 'time', 'ongoing', CURRENT_TIMESTAMP)
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
      INSERT INTO sprint_task_transitions (
        tenant_id, sprint_id, project_id, sprint_type, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at
      ) VALUES
        (?, 9901, 990, 'lead_generation', NULL, 'in_progress', 'completed', 'review', 1, 20, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        (?, 9901, 990, 'lead_generation', NULL, 'review', 'approved', 'approved', 1, 19, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        (?, 9901, 990, 'lead_generation', NULL, 'review', 'qa_pass', 'qa_pass', 1, 18, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        (?, 9901, 990, 'lead_generation', NULL, 'ready_to_merge', 'deployed_live', 'deployed', 1, 17, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        (?, 9901, 990, 'lead_generation', NULL, 'submitted', 'disabled_close', 'closed', 0, 16, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, tenantId, tenantId, tenantId, tenantId, tenantId);

    const metadata = await resolveWorkflowMetadata(db, { sprintId: 9901, taskType: 'lead' });

    expect(metadata.statuses.map(status => status.name)).toEqual([
      'todo',
      'ready',
      'in_progress',
      'review',
      'approved',
      'submitted',
      'closed',
    ]);
    expect(metadata.transitions.map(transition => `${transition.from_status}:${transition.outcome}:${transition.to_status}`)).toEqual([
      'in_progress:completed:review',
      'review:approved:approved',
    ]);
    expect(metadata.statuses.find(status => status.name === 'review')?.allowed_transitions).toEqual(['approved']);
    expect(metadata.transitions.map(transition => transition.to_status)).not.toEqual(expect.arrayContaining(['qa_pass', 'deployed']));
    expect(metadata.transitions.map(transition => transition.from_status)).not.toContain('ready_to_merge');
  });

  it('seeds only generic, dev, and ops sprint types', async () => {
    const db = getDb();
    await seedStarterDefinitions(db);

    const keys = await db.all(`
      SELECT key
      FROM sprint_types
      WHERE key IN ('generic', 'dev', 'ops', 'bugs', 'enhancements', 'pm')
      ORDER BY key ASC
    `) as Array<{ key: string }>;

    expect(keys.map(row => row.key)).toEqual(['dev', 'generic', 'ops']);
  });

  it('seeds ops as a distinct operational workflow', async () => {
    const db = getDb();
    const tenantId = await seedStarterDefinitions(db);

    const opsStatuses = await db.all(`
      SELECT status_key
      FROM sprint_type_task_statuses
      WHERE tenant_id = ? AND sprint_type_key = 'ops'
      ORDER BY stage_order ASC
    `, tenantId) as Array<{ status_key: string }>;
    expect(opsStatuses.map(row => row.status_key)).toEqual([
      'todo',
      'intake',
      'triage',
      'risk_review',
      'impact_review',
      'action_plan',
      'stakeholder_update',
      'human_approval',
      'blocked',
      'stalled',
      'done',
    ]);

    await db.run(`
      INSERT INTO projects (id, tenant_id, name, description, context_md, created_at)
      VALUES (920, ?, 'Ops Project', '', '', CURRENT_TIMESTAMP)
    `, tenantId);
    await db.run(`
      INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at)
      VALUES (9201, ?, 920, 'Ops Sprint', '', 'ops', 'active', 'time', '2w', CURRENT_TIMESTAMP)
    `, tenantId);
    await seedSprintTaskPolicy(db, 9201);

    const metadata = await resolveWorkflowMetadata(db, { sprintId: 9201, taskType: 'ops' });
    expect(metadata.statuses.map(status => status.name)).toEqual([
      'todo',
      'intake',
      'triage',
      'risk_review',
      'impact_review',
      'action_plan',
      'stakeholder_update',
      'human_approval',
      'blocked',
      'stalled',
      'done',
    ]);
    expect(metadata.outcomes.map(outcome => outcome.outcome_key)).toEqual(expect.arrayContaining([
      'completed',
      'blocked',
      'env_blocked',
      'approval_blocked',
      'failed',
      'infra_failed',
    ]));

    const transitions = await db.all(`
      SELECT from_status, outcome, to_status
      FROM sprint_task_transitions
      WHERE sprint_id = ?
      ORDER BY from_status ASC, outcome ASC
    `, 9201) as Array<{ from_status: string; outcome: string; to_status: string }>;
    expect(transitions).toEqual(expect.arrayContaining([
      { from_status: 'action_plan', outcome: 'completed', to_status: 'stakeholder_update' },
      { from_status: 'stakeholder_update', outcome: 'completed', to_status: 'human_approval' },
      { from_status: 'human_approval', outcome: 'completed', to_status: 'done' },
      { from_status: 'action_plan', outcome: 'blocked', to_status: 'blocked' },
      { from_status: 'human_approval', outcome: 'approval_blocked', to_status: 'stalled' },
    ]));
    expect(transitions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'completed_for_review' }),
      expect.objectContaining({ to_status: 'dev_deploy_queued' }),
      expect.objectContaining({ to_status: 'qa_pass' }),
    ]));
  });
});
