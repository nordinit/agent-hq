import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { closeDb, getDb } from './client';
import { initSchema } from './schema';
import { resolveWorkflowMetadata } from '../domains/sprint-definitions/workflowMetadata';
import { seedSprintTaskPolicy } from '../domains/routing/policy';
import { SqliteAdapter } from "./adapter/SqliteAdapter";

let tempDir = '';
const originalDbPath = process.env.AGENT_HQ_DB_PATH;

function resetDb(): void {
  closeDb();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-field-schema-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
}

async function defaultTenantId(): Promise<number> {
  const row = await getDb().get(`SELECT id FROM tenants WHERE is_default = 1 ORDER BY id ASC LIMIT 1`) as { id: number } | undefined;
  if (!row) throw new Error('default tenant missing');
  return row.id;
}

describe('sprint field schema migration', () => {
  beforeEach(() => {
    resetDb();
  });

  afterEach(() => {
    closeDb();
    if (originalDbPath == null) delete process.env.AGENT_HQ_DB_PATH;
    else process.env.AGENT_HQ_DB_PATH = originalDbPath;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('seeds dev sprint fields as unified task fields', async () => {
    // expect(fn).toThrow() calls fn SYNCHRONOUSLY. An async fn returns a promise instead of
    // throwing, so not.toThrow() passed trivially while the call ran DETACHED — and then
    // rejected after teardown closed the connection, killing the jest worker. toThrow() on an
    // async fn simply never matched. Both forms must go through the promise.
    await initSchema();
    const db = getDb();

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
    await initSchema();
    const db = getDb();

    await db.run(`
      INSERT INTO projects (id, name, description, context_md, created_at)
      VALUES (910, 'Agent HQ', '', '', datetime('now'))
    `);
    await db.run(`
      INSERT INTO sprints (id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at)
      VALUES (9101, 910, 'Dev Sprint', '', 'dev', 'active', 'time', '2w', datetime('now'))
    `);
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
    await initSchema();
    const db = getDb();
    const tenantId = await defaultTenantId();

    await db.run(`
      INSERT INTO projects (id, tenant_id, name, description, context_md, created_at)
      VALUES (990, ?, 'Agency', '', '', datetime('now'))
    `, tenantId);
    await db.run(`
      INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, task_policy_seeded_at, length_kind, length_value, created_at)
      VALUES (9901, ?, 990, 'Lead Generation', '', 'lead_generation', 'active', datetime('now'), 'time', 'ongoing', datetime('now'))
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
        (?, 9901, 990, 'lead_generation', NULL, 'in_progress', 'completed', 'review', 1, 20, 0, datetime('now'), datetime('now')),
        (?, 9901, 990, 'lead_generation', NULL, 'review', 'approved', 'approved', 1, 19, 0, datetime('now'), datetime('now')),
        (?, 9901, 990, 'lead_generation', NULL, 'review', 'qa_pass', 'qa_pass', 1, 18, 0, datetime('now'), datetime('now')),
        (?, 9901, 990, 'lead_generation', NULL, 'ready_to_merge', 'deployed_live', 'deployed', 1, 17, 0, datetime('now'), datetime('now')),
        (?, 9901, 990, 'lead_generation', NULL, 'submitted', 'disabled_close', 'closed', 0, 16, 0, datetime('now'), datetime('now'))
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
    await initSchema();
    const db = getDb();

    const keys = await db.all(`
      SELECT key
      FROM sprint_types
      WHERE key IN ('generic', 'dev', 'ops', 'bugs', 'enhancements', 'pm')
      ORDER BY key ASC
    `) as Array<{ key: string }>;

    expect(keys.map(row => row.key)).toEqual(['dev', 'generic', 'ops']);
  });

  it('seeds simplified generic workflow definitions and preserves them on rerun', async () => {
    await initSchema();
    const db = getDb();
    const tenantId = await defaultTenantId();

    const genericStatuses = await db.all(`
      SELECT status_key, label
      FROM sprint_type_task_statuses
      WHERE tenant_id = ? AND sprint_type_key = 'generic'
      ORDER BY stage_order ASC
    `, tenantId) as Array<{ status_key: string; label: string }>;
    expect(genericStatuses.map(row => row.status_key)).toEqual(['todo', 'ready', 'in_progress', 'review', 'done']);
    expect(genericStatuses.map(row => row.label)).toEqual(['Todo', 'Ready', 'In Progress', 'Review', 'Done']);

    const genericRelationships = await db.all(`
      SELECT key, category, affects_dispatch_eligibility, direction_semantics
      FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'generic'
      ORDER BY key ASC
    `, tenantId) as Array<{
      key: string;
      category: string;
      affects_dispatch_eligibility: number;
      direction_semantics: string;
    }>;
    expect(genericRelationships).toEqual([
      {
        key: 'blocked_by',
        category: 'dependency',
        affects_dispatch_eligibility: 1,
        direction_semantics: 'target_blocks_source',
      },
    ]);

    await db.run(`
      UPDATE sprint_type_task_statuses
      SET label = 'Doing'
      WHERE tenant_id = ? AND sprint_type_key = 'generic' AND status_key = 'in_progress'
    `, tenantId);
    await db.run(`
      DELETE FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'generic' AND key = 'blocked_by'
    `, tenantId);

    closeDb();
    await initSchema();
    const reopened = getDb();
    expect(await reopened.get(`
      SELECT label
      FROM sprint_type_task_statuses
      WHERE tenant_id = ? AND sprint_type_key = 'generic' AND status_key = 'in_progress'
    `, tenantId)).toEqual({ label: 'Doing' });
    expect((await reopened.get(`
      SELECT COUNT(*) AS n
      FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'generic'
    `, tenantId) as { n: number }).n).toBe(0);
  });

  it('reconciles stale seeded generic and ops starter rows on existing installs', async () => {
    await initSchema();
    const db = getDb();
    const tenantId = await defaultTenantId();

    await db.run(`
      INSERT INTO sprint_type_task_statuses (
        tenant_id, sprint_type_key, status_key, label, color, terminal, is_system,
        allowed_transitions_json, stage_order, is_default_entry, metadata_json
      ) VALUES
        (?, 'generic', 'dev_deploy_queued', 'Dev Deploy Queued', 'amber', 0, 1, '[]', 10, 0, '{}'),
        (?, 'generic', 'dev_deploying', 'Dev Deploying', 'cyan', 0, 1, '[]', 11, 0, '{}'),
        (?, 'generic', 'qa_pass', 'QA Pass', 'emerald', 0, 1, '[]', 12, 0, '{}'),
        (?, 'generic', 'ready_to_merge', 'Ready to Merge', 'cyan', 0, 1, '[]', 13, 0, '{}'),
        (?, 'generic', 'deployed', 'Deployed', 'green', 0, 1, '[]', 14, 0, '{}'),
        (?, 'generic', 'needs_attention', 'Needs Attention', 'amber', 0, 1, '[]', 15, 0, '{}'),
        (?, 'generic', 'cancelled', 'Cancelled', 'red', 1, 1, '[]', 16, 0, '{}'),
        (?, 'generic', 'stalled', 'Stalled', 'orange', 0, 1, '[]', 17, 0, '{}'),
        (?, 'generic', 'failed', 'Failed', 'red', 1, 1, '[]', 18, 0, '{}'),
        (?, 'generic', 'blocked', 'Blocked', 'rose', 0, 1, '[]', 19, 0, '{}')
    `, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId);
    await db.run(`
      INSERT INTO sprint_type_relationship_types (
        tenant_id, sprint_type_key, key, label, inverse_label, category, affects_dispatch_eligibility,
        direction_semantics, active_statuses_json, resolved_statuses_json, allow_create_related_task,
        default_related_task_type, default_related_task_status, is_system, metadata_json
      ) VALUES
        (?, 'generic', 'blocks', 'Blocks', 'Blocked by', 'dependency', 1, 'source_blocks_target', '[]', '[]', 0, NULL, NULL, 1, '{}'),
        (?, 'generic', 'defect_of', 'Defect of', 'Has defect', 'quality', 0, 'informational', '[]', '[]', 1, 'backend', 'todo', 1, '{}'),
        (?, 'generic', 'follow_up_to', 'Follow-up to', 'Has follow-up', 'continuity', 0, 'informational', '[]', '[]', 1, NULL, 'todo', 1, '{}'),
        (?, 'generic', 'duplicate_of', 'Duplicate of', 'Has duplicate', 'dedupe', 0, 'informational', '[]', '[]', 0, NULL, NULL, 1, '{}')
    `, tenantId, tenantId, tenantId, tenantId);
    await db.run(`
      INSERT INTO sprint_type_relationship_types (
        tenant_id, sprint_type_key, key, label, inverse_label, category, affects_dispatch_eligibility,
        direction_semantics, active_statuses_json, resolved_statuses_json, allow_create_related_task,
        default_related_task_type, default_related_task_status, is_system, metadata_json
      ) VALUES
        (?, 'ops', 'blocks', 'Blocks', 'Blocked by', 'dependency', 1, 'source_blocks_target', '[]', '[]', 0, NULL, NULL, 1, '{}'),
        (?, 'ops', 'defect_of', 'Defect of', 'Has defect', 'quality', 0, 'informational', '[]', '[]', 1, 'backend', 'todo', 1, '{}'),
        (?, 'ops', 'follow_up_to', 'Follow-up to', 'Has follow-up', 'continuity', 0, 'informational', '[]', '[]', 1, NULL, 'todo', 1, '{}'),
        (?, 'ops', 'duplicate_of', 'Duplicate of', 'Has duplicate', 'dedupe', 0, 'informational', '[]', '[]', 0, NULL, NULL, 1, '{}')
    `, tenantId, tenantId, tenantId, tenantId);
    await db.run(`
      INSERT INTO sprint_type_outcomes (
        tenant_id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior,
        badge_variant, stage_order, is_system, metadata_json, created_at, updated_at
      ) VALUES
        (?, 'generic', NULL, 'blocked', 'Blocked duplicate', 'Duplicate generic blocker', 1, 'base', 'stalled', 1, 1, '{"blocked_like":true}', datetime('now'), datetime('now')),
        (?, 'generic', NULL, 'blocked', 'Blocked duplicate 2', 'Duplicate generic blocker', 1, 'base', 'stalled', 1, 1, '{"blocked_like":true}', datetime('now'), datetime('now')),
        (?, 'ops', NULL, 'infra_failed', 'Infra failed duplicate', 'Duplicate ops infra failure', 1, 'base', 'failed', 5, 1, '{"failure_like":true}', datetime('now'), datetime('now')),
        (?, 'ops', NULL, 'infra_failed', 'Infra failed duplicate 2', 'Duplicate ops infra failure', 1, 'base', 'failed', 5, 1, '{"failure_like":true}', datetime('now'), datetime('now'))
    `, tenantId, tenantId, tenantId, tenantId);

    closeDb();
    await initSchema();
    const reopened = getDb();

    const genericStatuses = await reopened.all(`
      SELECT status_key
      FROM sprint_type_task_statuses
      WHERE tenant_id = ? AND sprint_type_key = 'generic'
      ORDER BY stage_order ASC
    `, tenantId) as Array<{ status_key: string }>;
    expect(genericStatuses.map(row => row.status_key)).toEqual(['todo', 'ready', 'in_progress', 'review', 'done']);

    const genericRelationships = await reopened.all(`
      SELECT key
      FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'generic'
      ORDER BY key ASC
    `, tenantId) as Array<{ key: string }>;
    expect(genericRelationships.map(row => row.key)).toEqual(['blocked_by']);

    const opsRelationships = await reopened.all(`
      SELECT key
      FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'ops'
      ORDER BY key ASC
    `, tenantId) as Array<{ key: string }>;
    expect(opsRelationships.map(row => row.key)).toEqual(['blocked_by']);

    const outcomeDuplicates = await reopened.all(`
      SELECT sprint_type_key, outcome_key, COUNT(*) AS n
      FROM sprint_type_outcomes
      WHERE tenant_id = ?
        AND sprint_type_key IN ('generic', 'ops')
        AND outcome_key IN ('blocked', 'infra_failed')
      GROUP BY sprint_type_key, COALESCE(task_type, ''), outcome_key
      HAVING COUNT(*) > 1
    `, tenantId) as Array<{ sprint_type_key: string; outcome_key: string; n: number }>;
    expect(outcomeDuplicates).toEqual([]);
  });

  it('seeds ops as a distinct operational workflow', async () => {
    await initSchema();
    const db = getDb();
    const tenantId = await defaultTenantId();

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
      INSERT INTO projects (id, name, description, context_md, created_at)
      VALUES (920, 'Ops Project', '', '', datetime('now'))
    `);
    await db.run(`
      INSERT INTO sprints (id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at)
      VALUES (9201, 920, 'Ops Sprint', '', 'ops', 'active', 'time', '2w', datetime('now'))
    `);
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

  it('does not repair or add workflow relationship type config on API restart', async () => {
    await initSchema();
    const db = getDb();
    const tenantId = await defaultTenantId();

    await db.run(`
      UPDATE sprint_type_relationship_types
      SET label = 'Custom Blocked By', updated_at = '2026-01-01T00:00:00Z'
      WHERE tenant_id = ? AND sprint_type_key = 'dev' AND key = 'blocked_by'
    `, tenantId);
    await db.run(`
      DELETE FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'dev' AND key = 'duplicate_of'
    `, tenantId);
    await db.run(`
      INSERT INTO sprint_types (tenant_id, key, name, description, is_system)
      VALUES (?, 'custom_workflow', 'Custom Workflow', 'Operator-owned workflow', 0)
    `, tenantId);

    await initSchema();

    expect(await db.get(`
      SELECT label
      FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'dev' AND key = 'blocked_by'
    `, tenantId)).toEqual({ label: 'Custom Blocked By' });
    expect((await db.get(`
      SELECT COUNT(*) AS n
      FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'dev' AND key = 'duplicate_of'
    `, tenantId) as { n: number }).n).toBe(0);
    expect((await db.get(`
      SELECT COUNT(*) AS n
      FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'custom_workflow'
    `, tenantId) as { n: number }).n).toBe(0);
  });

  it('adds tenant-local sprint type key uniqueness before starter sprint type upserts', async () => {
    const legacyDbRaw = new Database(process.env.AGENT_HQ_DB_PATH!);
      const legacyDb = new SqliteAdapter(legacyDbRaw);
    await legacyDb.exec(`
      CREATE TABLE sprint_types (
        key TEXT,
        name TEXT NOT NULL,
        description TEXT,
        is_system INTEGER,
        created_at TEXT,
        updated_at TEXT
      );
      INSERT INTO sprint_types (key, name, description, is_system, created_at, updated_at)
      VALUES
        ('custom_dupe', 'Custom System', '', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('custom_dupe', 'Custom Tenant', '', 0, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');
    `);
    legacyDbRaw.close();

    await initSchema();

    const db = getDb();
    const duplicateCount = await db.get(`SELECT COUNT(*) AS n FROM sprint_types WHERE key = 'custom_dupe'`) as { n: number };
    const customRow = await db.get(`SELECT name, is_system FROM sprint_types WHERE key = 'custom_dupe'`) as { name: string; is_system: number };
    const tenantKeyIndex = (await db.all(`PRAGMA index_list(sprint_types)`))
      .find(index => (index as { name: string }).name === 'idx_sprint_types_tenant_key') as { unique: number } | undefined;
    const tenantColumn = (await db.all(`PRAGMA table_info(sprint_types)`))
      .find(column => (column as { name: string }).name === 'tenant_id') as { notnull: number } | undefined;

    expect(duplicateCount.n).toBe(1);
    expect(customRow).toEqual({ name: 'Custom Tenant', is_system: 0 });
    expect(tenantKeyIndex?.unique).toBe(1);
    expect(tenantColumn?.notnull).toBe(1);
    // Asserted on the rejection VALUE. A bare .rejects.toThrow() is order-dependent here:
    // better-sqlite3 is a native addon, and a SqliteError raised from the second test file
    // loaded in a jest worker fails `instanceof Error` (the addon keeps the constructor from
    // the first module-registry load), so toThrow cannot classify it and reports "did not
    // throw" despite a correct rejection.
    await expect((async () => {
            await db.run(`INSERT INTO sprint_types (key, name, description, is_system) VALUES ('custom_dupe', 'Duplicate', '', 0)`);
          })()).rejects.toMatchObject({ message: expect.stringContaining('UNIQUE constraint failed') });
  });

  it('removes stale sprint type key foreign keys when sprint types are tenant-scoped', async () => {
    const legacyDbRaw = new Database(process.env.AGENT_HQ_DB_PATH!);
      const legacyDb = new SqliteAdapter(legacyDbRaw);
    legacyDbRaw.pragma('foreign_keys = OFF');
    await legacyDb.exec(`
      CREATE TABLE tenants (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sprint_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        is_system INTEGER,
        created_at TEXT,
        updated_at TEXT,
        UNIQUE(tenant_id, key)
      );
      CREATE TABLE sprint_task_transition_requirements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sprint_id INTEGER,
        project_id INTEGER,
        sprint_type TEXT REFERENCES sprint_types(key) ON DELETE CASCADE,
        task_type TEXT,
        outcome TEXT NOT NULL,
        field_name TEXT NOT NULL,
        requirement_type TEXT NOT NULL DEFAULT 'required'
          CHECK(requirement_type IN ('required','match','from_status')),
        match_field TEXT,
        severity TEXT NOT NULL DEFAULT 'block'
          CHECK(severity IN ('block','warn')),
        message TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'One', 'one', 1), (2, 'Two', 'two', 0);
      INSERT INTO sprint_types (tenant_id, key, name, description, is_system, created_at, updated_at)
      VALUES
        (1, 'dev', 'Tenant One Dev', '', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        (2, 'dev', 'Tenant Two Dev', '', 0, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');
      INSERT INTO sprint_task_transition_requirements (sprint_type, outcome, field_name)
      VALUES ('dev', 'completed_for_review', 'review_branch');
    `);
    legacyDbRaw.close();

    await initSchema();

    const db = getDb();
    const sprintTypeRows = await db.get(`SELECT COUNT(*) AS n FROM sprint_types WHERE key = 'dev'`) as { n: number };
    const requirementsDdl = (await db.get(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'sprint_task_transition_requirements'
    `) as { sql: string }).sql;
    const globalUniqueIndex = (await db.all(`PRAGMA index_list(sprint_types)`))
      .find(index => (index as { name: string }).name === 'idx_sprint_types_key_unique');
    const requirementRow = await db.get(`
      SELECT sprint_type, outcome, field_name
      FROM sprint_task_transition_requirements
      WHERE outcome = 'completed_for_review'
    `);

    expect(sprintTypeRows.n).toBe(2);
    expect(requirementsDdl).not.toContain('REFERENCES sprint_types(key)');
    expect(globalUniqueIndex).toBeUndefined();
    expect(requirementRow).toEqual({
      sprint_type: 'dev',
      outcome: 'completed_for_review',
      field_name: 'review_branch',
    });
  });

  it('removes deprecated runtime lifecycle config from existing agents', async () => {
    await initSchema();
    const db = getDb();

    await db.run(`
      INSERT INTO agents (id, name, session_key, runtime_type, runtime_config)
      VALUES (?, ?, ?, ?, ?)
    `, 910, 'Webhook Legacy', 'agent:webhook-legacy:main', 'webhook', JSON.stringify({ dispatchUrl: 'https://remote.example/dispatch', lifecycleProxy: true }));
    await db.run(`
      INSERT INTO agents (id, name, session_key, runtime_type, runtime_config)
      VALUES (?, ?, ?, ?, ?)
    `, 911, 'Hermes Legacy', 'agent:hermes-legacy:main', 'hermes', JSON.stringify({ profile: 'agent-hq-cinder', lifecycleMode: 'proxy' }));

    await initSchema();

    const rows = await db.all(`
      SELECT id, runtime_config
      FROM agents
      WHERE id IN (910, 911)
      ORDER BY id ASC
    `) as Array<{ id: number; runtime_config: string }>;

    expect(rows.map(row => JSON.parse(row.runtime_config))).toEqual([
      { dispatchUrl: 'https://remote.example/dispatch' },
      { profile: 'agent-hq-cinder' },
    ]);
  });

  it('migrates deprecated bug, enhancement, and pm sprint types to dev and removes their type rows', async () => {
    await initSchema();
    const db = getDb();
    const tenantId = await defaultTenantId();
    await db.run(`
      INSERT INTO sprint_types (tenant_id, key, name, description, is_system)
      VALUES (?, 'bugs', 'Bugs', '', 0), (?, 'enhancements', 'Enhancements', '', 0), (?, 'pm', 'PM', '', 0)
    `, tenantId, tenantId, tenantId);
    await db.run(`
      INSERT INTO projects (id, name, description, context_md, created_at)
      VALUES (901, 'Custom Project', '', '', datetime('now'))
    `);
    await db.run(`
      INSERT INTO sprints (id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at)
      VALUES
        (9011, 901, 'Bug Sprint', '', 'bugs', 'active', 'time', '2w', datetime('now')),
        (9012, 901, 'Enhancement Sprint', '', 'enhancements', 'paused', 'time', '2w', datetime('now')),
        (9013, 901, 'PM Sprint', '', 'pm', 'active', 'time', '2w', datetime('now'))
    `);

    await initSchema();

    const sprints = await db.all(`
      SELECT id, sprint_type
      FROM sprints
      WHERE id IN (9011, 9012, 9013)
      ORDER BY id ASC
    `) as Array<{ id: number; sprint_type: string }>;
    expect(sprints).toEqual([
      { id: 9011, sprint_type: 'dev' },
      { id: 9012, sprint_type: 'dev' },
      { id: 9013, sprint_type: 'dev' },
    ]);

    const deprecated = await db.all(`
      SELECT key
      FROM sprint_types
      WHERE key IN ('bugs', 'enhancements', 'pm')
    `);
    expect(deprecated).toEqual([]);
  });

  it('migrates active Agent HQ sprints to the dev sprint type only', async () => {
    await initSchema();
    const db = getDb();
    await db.run(`
      INSERT INTO projects (id, name, description, context_md, created_at)
      VALUES (900, 'Agent HQ', '', '', datetime('now'))
    `);
    await db.run(`
      INSERT INTO sprints (id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at)
      VALUES
        (9001, 900, 'Active Bugs', '', 'generic', 'active', 'time', '2w', datetime('now')),
        (9002, 900, 'Completed Work', '', 'generic', 'complete', 'time', '2w', datetime('now'))
    `);

    await initSchema();

    const rows = await db.all(`
      SELECT id, sprint_type
      FROM sprints
      WHERE id IN (9001, 9002)
      ORDER BY id ASC
    `) as Array<{ id: number; sprint_type: string }>;

    expect(rows).toEqual([
      { id: 9001, sprint_type: 'dev' },
      { id: 9002, sprint_type: 'generic' },
    ]);
  });

  it('does not recreate deleted or customized starter sprint-definition rows on reopen', async () => {
    await initSchema();
    const db = getDb();

    const seededType = await db.get(`
      SELECT key
      FROM sprint_types
      WHERE key = 'ops'
      ORDER BY key ASC
      LIMIT 1
    `) as { key: string } | undefined;
    expect(seededType).toBeDefined();

    const seededFieldSchema = await db.get(`
      SELECT id
      FROM task_field_schemas
      ORDER BY id ASC
      LIMIT 1
    `) as { id: number } | undefined;
    expect(seededFieldSchema).toBeDefined();

    const seededOutcome = await db.get(`
      SELECT id
      FROM sprint_type_outcomes
      ORDER BY id ASC
      LIMIT 1
    `) as { id: number } | undefined;
    expect(seededOutcome).toBeDefined();

    const seededSprintTypeStatus = await db.get(`
      SELECT sprint_type_key, status_key
      FROM sprint_type_task_statuses
      WHERE sprint_type_key = 'dev'
      ORDER BY id ASC
      LIMIT 1
    `) as { sprint_type_key: string; status_key: string } | undefined;
    expect(seededSprintTypeStatus).toBeDefined();

    await db.run(`
      INSERT INTO projects (id, name, description, context_md, created_at)
      VALUES (990, 'Starter Project', '', '', datetime('now'))
    `);
    await db.run(`
      INSERT INTO sprints (id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at)
      VALUES (9901, 990, 'Starter Sprint', '', 'dev', 'active', 'time', '2w', datetime('now'))
    `);
    await seedSprintTaskPolicy(db, 9901);
    const seededSprintStatus = await db.get(`
      SELECT status_key
      FROM sprint_task_statuses
      WHERE sprint_id = ?
      ORDER BY id ASC
      LIMIT 1
    `, 9901) as { status_key: string } | undefined;
    expect(seededSprintStatus).toBeDefined();

    await db.run(`DELETE FROM sprint_types WHERE key = ?`, seededType!.key);
    await db.run(`DELETE FROM task_field_schemas WHERE id = ?`, seededFieldSchema!.id);
    await db.run(`UPDATE sprint_type_outcomes SET label = 'Customized starter outcome' WHERE id = ?`, seededOutcome!.id);
    await db.run(`DELETE FROM sprint_type_task_statuses WHERE sprint_type_key = ? AND status_key = ?`, seededSprintTypeStatus!.sprint_type_key, seededSprintTypeStatus!.status_key);
    await db.run(`DELETE FROM sprint_task_statuses WHERE sprint_id = ? AND status_key = ?`, 9901, seededSprintStatus!.status_key);

    closeDb();
    await initSchema();

    const reopened = getDb();
    const deletedType = await reopened.get(`SELECT key FROM sprint_types WHERE key = ?`, seededType!.key);
    expect(deletedType).toBeUndefined();

    const deletedFieldSchema = await reopened.get(`SELECT id FROM task_field_schemas WHERE id = ?`, seededFieldSchema!.id);
    expect(deletedFieldSchema).toBeUndefined();

    const customizedOutcome = await reopened.get(`SELECT label FROM sprint_type_outcomes WHERE id = ?`, seededOutcome!.id) as { label: string } | undefined;
    expect(customizedOutcome).toEqual({ label: 'Customized starter outcome' });

    const deletedSprintTypeStatus = await reopened.get(`
      SELECT id
      FROM sprint_type_task_statuses
      WHERE sprint_type_key = ? AND status_key = ?
    `, seededSprintTypeStatus!.sprint_type_key, seededSprintTypeStatus!.status_key);
    expect(deletedSprintTypeStatus).toBeUndefined();

    const deletedSprintStatus = await reopened.get(`
      SELECT id
      FROM sprint_task_statuses
      WHERE sprint_id = ? AND status_key = ?
    `, 9901, seededSprintStatus!.status_key);
    expect(deletedSprintStatus).toBeUndefined();
  });

  it('preserves custom workflow and sprint statuses across startup schema checks', async () => {
    await initSchema();
    const db = getDb();

    const tenantId = await defaultTenantId();
    await db.run(`
      INSERT INTO sprint_types (tenant_id, key, name, description, is_system, status_seeded_at)
      VALUES (?, 'federal_preconstruction', 'Federal Preconstruction', 'Custom tenant workflow', 0, NULL)
    `, tenantId);
    await db.run(`
      INSERT INTO sprint_type_task_statuses (
        tenant_id, sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json
      ) VALUES
        (?, 'federal_preconstruction', 'estimating', 'Estimating', 'purple', 0, 0, '["permit_review"]', 0, 1, '{}'),
        (?, 'federal_preconstruction', 'permit_review', 'Permit Review', 'amber', 0, 0, '["awarded"]', 1, 0, '{}'),
        (?, 'federal_preconstruction', 'awarded', 'Awarded', 'green', 1, 0, '[]', 2, 0, '{}')
    `, tenantId, tenantId, tenantId);
    await db.run(`
      INSERT INTO projects (id, name, description, context_md, created_at)
      VALUES (991, 'Elevation Build', '', '', datetime('now'))
    `);
    await db.run(`
      INSERT INTO sprints (id, project_id, name, goal, sprint_type, status, task_policy_seeded_at, length_kind, length_value, created_at)
      VALUES (9911, 991, 'Federal Package', '', 'federal_preconstruction', 'active', datetime('now'), 'time', 'ongoing', datetime('now'))
    `);
    await db.run(`
      INSERT INTO sprint_task_statuses (
        sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json
      ) VALUES
        (9911, 'estimating', 'Estimating', 'purple', 0, 0, '["permit_review"]', 0, 1, '{}'),
        (9911, 'permit_review', 'Permit Review', 'amber', 0, 0, '["awarded"]', 1, 0, '{}'),
        (9911, 'awarded', 'Awarded', 'green', 1, 0, '[]', 2, 0, '{}')
    `);

    closeDb();
    await initSchema();

    const reopened = getDb();
    const sprintType = await reopened.get(`
      SELECT status_seeded_at
      FROM sprint_types
      WHERE key = 'federal_preconstruction'
    `) as { status_seeded_at: string | null };
    expect(sprintType.status_seeded_at).toBeNull();

    const typeStatuses = await reopened.all(`
      SELECT status_key
      FROM sprint_type_task_statuses
      WHERE sprint_type_key = 'federal_preconstruction'
      ORDER BY stage_order ASC
    `) as Array<{ status_key: string }>;
    expect(typeStatuses.map((row) => row.status_key)).toEqual(['estimating', 'permit_review', 'awarded']);

    const sprintStatuses = await reopened.all(`
      SELECT status_key
      FROM sprint_task_statuses
      WHERE sprint_id = 9911
      ORDER BY stage_order ASC
    `) as Array<{ status_key: string }>;
    expect(sprintStatuses.map((row) => row.status_key)).toEqual(['estimating', 'permit_review', 'awarded']);
  });
});
