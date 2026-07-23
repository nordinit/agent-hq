import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { closeDb, getDb } from './client';
import { initSchema } from './schema';
import { resolveWorkflowMetadata } from '../domains/sprint-definitions/workflowMetadata';
import { seedSprintTaskPolicy } from '../domains/routing/policy';

let tempDir = '';
const originalDbPath = process.env.AGENT_HQ_DB_PATH;

function resetDb(): void {
  closeDb();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-field-schema-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
}

function defaultTenantId(): number {
  const row = getDb().prepare(`SELECT id FROM tenants WHERE is_default = 1 ORDER BY id ASC LIMIT 1`).get() as { id: number } | undefined;
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

  it('seeds dev sprint fields as unified task fields', () => {
    initSchema();
    const db = getDb();

    const row = db.prepare(`
      SELECT schema_json
      FROM task_field_schemas
      WHERE sprint_type_key = 'dev' AND task_type IS NULL
      LIMIT 1
    `).get() as { schema_json: string };

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

    const taskColumns = (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((column) => column.name);
    expect(taskColumns).not.toEqual(expect.arrayContaining([
      'review_branch',
      'review_commit',
      'review_url',
      'qa_verified_commit',
      'qa_tested_url',
      'merged_commit',
      'deployed_commit',
      'deploy_target',
      'deployed_at',
      'live_verified_by',
      'live_verified_at',
      'evidence_json',
    ]));
    expect(taskColumns).toContain('custom_fields_json');
  });

  it('resolves dev task workflow metadata from sprint task policy', () => {
    initSchema();
    const db = getDb();

    db.prepare(`
      INSERT INTO projects (id, name, description, context_md, created_at)
      VALUES (910, 'Agent HQ', '', '', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO sprints (id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at)
      VALUES (9101, 910, 'Dev Sprint', '', 'dev', 'active', 'time', '2w', datetime('now'))
    `).run();
    seedSprintTaskPolicy(db, 9101);

    const metadata = resolveWorkflowMetadata(db, { sprintId: 9101, taskType: 'backend' });

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

  it('filters stale starter transitions out of custom workflow metadata readbacks', () => {
    initSchema();
    const db = getDb();
    const tenantId = defaultTenantId();

    db.prepare(`
      INSERT INTO projects (id, tenant_id, name, description, context_md, created_at)
      VALUES (990, ?, 'Agency', '', '', datetime('now'))
    `).run(tenantId);
    db.prepare(`
      INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, task_policy_seeded_at, length_kind, length_value, created_at)
      VALUES (9901, ?, 990, 'Lead Generation', '', 'lead_generation', 'active', datetime('now'), 'time', 'ongoing', datetime('now'))
    `).run(tenantId);
    db.prepare(`
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
    `).run();
    db.prepare(`
      INSERT INTO sprint_task_transitions (
        tenant_id, sprint_id, project_id, sprint_type, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at
      ) VALUES
        (?, 9901, 990, 'lead_generation', NULL, 'in_progress', 'completed', 'review', 1, 20, 0, datetime('now'), datetime('now')),
        (?, 9901, 990, 'lead_generation', NULL, 'review', 'approved', 'approved', 1, 19, 0, datetime('now'), datetime('now')),
        (?, 9901, 990, 'lead_generation', NULL, 'review', 'qa_pass', 'qa_pass', 1, 18, 0, datetime('now'), datetime('now')),
        (?, 9901, 990, 'lead_generation', NULL, 'ready_to_merge', 'deployed_live', 'deployed', 1, 17, 0, datetime('now'), datetime('now')),
        (?, 9901, 990, 'lead_generation', NULL, 'submitted', 'disabled_close', 'closed', 0, 16, 0, datetime('now'), datetime('now'))
    `).run(tenantId, tenantId, tenantId, tenantId, tenantId);

    const metadata = resolveWorkflowMetadata(db, { sprintId: 9901, taskType: 'lead' });

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

  it('seeds only generic, dev, and ops sprint types', () => {
    initSchema();
    const db = getDb();

    const keys = db.prepare(`
      SELECT key
      FROM sprint_types
      WHERE key IN ('generic', 'dev', 'ops', 'bugs', 'enhancements', 'pm')
      ORDER BY key ASC
    `).all() as Array<{ key: string }>;

    expect(keys.map(row => row.key)).toEqual(['dev', 'generic', 'ops']);
  });

  it('seeds simplified generic workflow definitions and preserves them on rerun', () => {
    initSchema();
    const db = getDb();
    const tenantId = defaultTenantId();

    const genericStatuses = db.prepare(`
      SELECT status_key, label
      FROM sprint_type_task_statuses
      WHERE tenant_id = ? AND sprint_type_key = 'generic'
      ORDER BY stage_order ASC
    `).all(tenantId) as Array<{ status_key: string; label: string }>;
    expect(genericStatuses.map(row => row.status_key)).toEqual(['todo', 'ready', 'in_progress', 'review', 'done']);
    expect(genericStatuses.map(row => row.label)).toEqual(['Todo', 'Ready', 'In Progress', 'Review', 'Done']);

    const genericRelationships = db.prepare(`
      SELECT key, category, affects_dispatch_eligibility, direction_semantics
      FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'generic'
      ORDER BY key ASC
    `).all(tenantId) as Array<{
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

    db.prepare(`
      UPDATE sprint_type_task_statuses
      SET label = 'Doing'
      WHERE tenant_id = ? AND sprint_type_key = 'generic' AND status_key = 'in_progress'
    `).run(tenantId);
    db.prepare(`
      DELETE FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'generic' AND key = 'blocked_by'
    `).run(tenantId);

    closeDb();
    initSchema();
    const reopened = getDb();
    expect(reopened.prepare(`
      SELECT label
      FROM sprint_type_task_statuses
      WHERE tenant_id = ? AND sprint_type_key = 'generic' AND status_key = 'in_progress'
    `).get(tenantId)).toEqual({ label: 'Doing' });
    expect((reopened.prepare(`
      SELECT COUNT(*) AS n
      FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'generic'
    `).get(tenantId) as { n: number }).n).toBe(0);
  });

  it('reconciles stale seeded generic and ops starter rows on existing installs', () => {
    initSchema();
    const db = getDb();
    const tenantId = defaultTenantId();

    db.prepare(`
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
    `).run(tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId);
    db.prepare(`
      INSERT INTO sprint_type_relationship_types (
        tenant_id, sprint_type_key, key, label, inverse_label, category, affects_dispatch_eligibility,
        direction_semantics, active_statuses_json, resolved_statuses_json, allow_create_related_task,
        default_related_task_type, default_related_task_status, is_system, metadata_json
      ) VALUES
        (?, 'generic', 'blocks', 'Blocks', 'Blocked by', 'dependency', 1, 'source_blocks_target', '[]', '[]', 0, NULL, NULL, 1, '{}'),
        (?, 'generic', 'defect_of', 'Defect of', 'Has defect', 'quality', 0, 'informational', '[]', '[]', 1, 'backend', 'todo', 1, '{}'),
        (?, 'generic', 'follow_up_to', 'Follow-up to', 'Has follow-up', 'continuity', 0, 'informational', '[]', '[]', 1, NULL, 'todo', 1, '{}'),
        (?, 'generic', 'duplicate_of', 'Duplicate of', 'Has duplicate', 'dedupe', 0, 'informational', '[]', '[]', 0, NULL, NULL, 1, '{}')
    `).run(tenantId, tenantId, tenantId, tenantId);
    db.prepare(`
      INSERT INTO sprint_type_relationship_types (
        tenant_id, sprint_type_key, key, label, inverse_label, category, affects_dispatch_eligibility,
        direction_semantics, active_statuses_json, resolved_statuses_json, allow_create_related_task,
        default_related_task_type, default_related_task_status, is_system, metadata_json
      ) VALUES
        (?, 'ops', 'blocks', 'Blocks', 'Blocked by', 'dependency', 1, 'source_blocks_target', '[]', '[]', 0, NULL, NULL, 1, '{}'),
        (?, 'ops', 'defect_of', 'Defect of', 'Has defect', 'quality', 0, 'informational', '[]', '[]', 1, 'backend', 'todo', 1, '{}'),
        (?, 'ops', 'follow_up_to', 'Follow-up to', 'Has follow-up', 'continuity', 0, 'informational', '[]', '[]', 1, NULL, 'todo', 1, '{}'),
        (?, 'ops', 'duplicate_of', 'Duplicate of', 'Has duplicate', 'dedupe', 0, 'informational', '[]', '[]', 0, NULL, NULL, 1, '{}')
    `).run(tenantId, tenantId, tenantId, tenantId);
    db.prepare(`
      INSERT INTO sprint_type_outcomes (
        tenant_id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior,
        badge_variant, stage_order, is_system, metadata_json, created_at, updated_at
      ) VALUES
        (?, 'generic', NULL, 'blocked', 'Blocked duplicate', 'Duplicate generic blocker', 1, 'base', 'stalled', 1, 1, '{"blocked_like":true}', datetime('now'), datetime('now')),
        (?, 'generic', NULL, 'blocked', 'Blocked duplicate 2', 'Duplicate generic blocker', 1, 'base', 'stalled', 1, 1, '{"blocked_like":true}', datetime('now'), datetime('now')),
        (?, 'ops', NULL, 'infra_failed', 'Infra failed duplicate', 'Duplicate ops infra failure', 1, 'base', 'failed', 5, 1, '{"failure_like":true}', datetime('now'), datetime('now')),
        (?, 'ops', NULL, 'infra_failed', 'Infra failed duplicate 2', 'Duplicate ops infra failure', 1, 'base', 'failed', 5, 1, '{"failure_like":true}', datetime('now'), datetime('now'))
    `).run(tenantId, tenantId, tenantId, tenantId);

    closeDb();
    initSchema();
    const reopened = getDb();

    const genericStatuses = reopened.prepare(`
      SELECT status_key
      FROM sprint_type_task_statuses
      WHERE tenant_id = ? AND sprint_type_key = 'generic'
      ORDER BY stage_order ASC
    `).all(tenantId) as Array<{ status_key: string }>;
    expect(genericStatuses.map(row => row.status_key)).toEqual(['todo', 'ready', 'in_progress', 'review', 'done']);

    const genericRelationships = reopened.prepare(`
      SELECT key
      FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'generic'
      ORDER BY key ASC
    `).all(tenantId) as Array<{ key: string }>;
    expect(genericRelationships.map(row => row.key)).toEqual(['blocked_by']);

    const opsRelationships = reopened.prepare(`
      SELECT key
      FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'ops'
      ORDER BY key ASC
    `).all(tenantId) as Array<{ key: string }>;
    expect(opsRelationships.map(row => row.key)).toEqual(['blocked_by']);

    const outcomeDuplicates = reopened.prepare(`
      SELECT sprint_type_key, outcome_key, COUNT(*) AS n
      FROM sprint_type_outcomes
      WHERE tenant_id = ?
        AND sprint_type_key IN ('generic', 'ops')
        AND outcome_key IN ('blocked', 'infra_failed')
      GROUP BY sprint_type_key, COALESCE(task_type, ''), outcome_key
      HAVING COUNT(*) > 1
    `).all(tenantId) as Array<{ sprint_type_key: string; outcome_key: string; n: number }>;
    expect(outcomeDuplicates).toEqual([]);
  });

  it('seeds ops as a distinct operational workflow', () => {
    initSchema();
    const db = getDb();
    const tenantId = defaultTenantId();

    const opsStatuses = db.prepare(`
      SELECT status_key
      FROM sprint_type_task_statuses
      WHERE tenant_id = ? AND sprint_type_key = 'ops'
      ORDER BY stage_order ASC
    `).all(tenantId) as Array<{ status_key: string }>;
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

    db.prepare(`
      INSERT INTO projects (id, name, description, context_md, created_at)
      VALUES (920, 'Ops Project', '', '', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO sprints (id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at)
      VALUES (9201, 920, 'Ops Sprint', '', 'ops', 'active', 'time', '2w', datetime('now'))
    `).run();
    seedSprintTaskPolicy(db, 9201);

    const metadata = resolveWorkflowMetadata(db, { sprintId: 9201, taskType: 'ops' });
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

    const transitions = db.prepare(`
      SELECT from_status, outcome, to_status
      FROM sprint_task_transitions
      WHERE sprint_id = ?
      ORDER BY from_status ASC, outcome ASC
    `).all(9201) as Array<{ from_status: string; outcome: string; to_status: string }>;
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

  it('does not repair or add workflow relationship type config on API restart', () => {
    initSchema();
    const db = getDb();
    const tenantId = defaultTenantId();

    db.prepare(`
      UPDATE sprint_type_relationship_types
      SET label = 'Custom Blocked By', updated_at = '2026-01-01T00:00:00Z'
      WHERE tenant_id = ? AND sprint_type_key = 'dev' AND key = 'blocked_by'
    `).run(tenantId);
    db.prepare(`
      DELETE FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'dev' AND key = 'duplicate_of'
    `).run(tenantId);
    db.prepare(`
      INSERT INTO sprint_types (tenant_id, key, name, description, is_system)
      VALUES (?, 'custom_workflow', 'Custom Workflow', 'Operator-owned workflow', 0)
    `).run(tenantId);

    initSchema();

    expect(db.prepare(`
      SELECT label
      FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'dev' AND key = 'blocked_by'
    `).get(tenantId)).toEqual({ label: 'Custom Blocked By' });
    expect((db.prepare(`
      SELECT COUNT(*) AS n
      FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'dev' AND key = 'duplicate_of'
    `).get(tenantId) as { n: number }).n).toBe(0);
    expect((db.prepare(`
      SELECT COUNT(*) AS n
      FROM sprint_type_relationship_types
      WHERE tenant_id = ? AND sprint_type_key = 'custom_workflow'
    `).get(tenantId) as { n: number }).n).toBe(0);
  });

  it('adds tenant-local sprint type key uniqueness before starter sprint type upserts', () => {
    const legacyDb = new Database(process.env.AGENT_HQ_DB_PATH!);
    legacyDb.exec(`
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
    legacyDb.close();

    expect(() => initSchema()).not.toThrow();

    const db = getDb();
    const duplicateCount = db.prepare(`SELECT COUNT(*) AS n FROM sprint_types WHERE key = 'custom_dupe'`).get() as { n: number };
    const customRow = db.prepare(`SELECT name, is_system FROM sprint_types WHERE key = 'custom_dupe'`).get() as { name: string; is_system: number };
    const tenantKeyIndex = db.prepare(`PRAGMA index_list(sprint_types)`).all()
      .find(index => (index as { name: string }).name === 'idx_sprint_types_tenant_key') as { unique: number } | undefined;
    const tenantColumn = db.prepare(`PRAGMA table_info(sprint_types)`).all()
      .find(column => (column as { name: string }).name === 'tenant_id') as { notnull: number } | undefined;

    expect(duplicateCount.n).toBe(1);
    expect(customRow).toEqual({ name: 'Custom Tenant', is_system: 0 });
    expect(tenantKeyIndex?.unique).toBe(1);
    expect(tenantColumn?.notnull).toBe(1);
    expect(() => {
      db.prepare(`INSERT INTO sprint_types (key, name, description, is_system) VALUES ('custom_dupe', 'Duplicate', '', 0)`).run();
    }).toThrow();
  });

  it('removes stale sprint type key foreign keys when sprint types are tenant-scoped', () => {
    const legacyDb = new Database(process.env.AGENT_HQ_DB_PATH!);
    legacyDb.pragma('foreign_keys = OFF');
    legacyDb.exec(`
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
    legacyDb.close();

    expect(() => initSchema()).not.toThrow();

    const db = getDb();
    const sprintTypeRows = db.prepare(`SELECT COUNT(*) AS n FROM sprint_types WHERE key = 'dev'`).get() as { n: number };
    const requirementsDdl = (db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'sprint_task_transition_requirements'
    `).get() as { sql: string }).sql;
    const globalUniqueIndex = db.prepare(`PRAGMA index_list(sprint_types)`).all()
      .find(index => (index as { name: string }).name === 'idx_sprint_types_key_unique');
    const requirementRow = db.prepare(`
      SELECT sprint_type, outcome, field_name
      FROM sprint_task_transition_requirements
      WHERE outcome = 'completed_for_review'
    `).get();

    expect(sprintTypeRows.n).toBe(2);
    expect(requirementsDdl).not.toContain('REFERENCES sprint_types(key)');
    expect(globalUniqueIndex).toBeUndefined();
    expect(requirementRow).toEqual({
      sprint_type: 'dev',
      outcome: 'completed_for_review',
      field_name: 'review_branch',
    });
  });

  it('removes deprecated runtime lifecycle config from existing agents', () => {
    initSchema();
    const db = getDb();

    db.prepare(`
      INSERT INTO agents (id, name, session_key, runtime_type, runtime_config)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      910,
      'Webhook Legacy',
      'agent:webhook-legacy:main',
      'webhook',
      JSON.stringify({ dispatchUrl: 'https://remote.example/dispatch', lifecycleProxy: true }),
    );
    db.prepare(`
      INSERT INTO agents (id, name, session_key, runtime_type, runtime_config)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      911,
      'Hermes Legacy',
      'agent:hermes-legacy:main',
      'hermes',
      JSON.stringify({ profile: 'agent-hq-cinder', lifecycleMode: 'proxy' }),
    );

    initSchema();

    const rows = db.prepare(`
      SELECT id, runtime_config
      FROM agents
      WHERE id IN (910, 911)
      ORDER BY id ASC
    `).all() as Array<{ id: number; runtime_config: string }>;

    expect(rows.map(row => JSON.parse(row.runtime_config))).toEqual([
      { dispatchUrl: 'https://remote.example/dispatch' },
      { profile: 'agent-hq-cinder' },
    ]);
  });

  it('migrates deprecated bug, enhancement, and pm sprint types to dev and removes their type rows', () => {
    initSchema();
    const db = getDb();
    const tenantId = defaultTenantId();
    db.prepare(`
      INSERT INTO sprint_types (tenant_id, key, name, description, is_system)
      VALUES (?, 'bugs', 'Bugs', '', 0), (?, 'enhancements', 'Enhancements', '', 0), (?, 'pm', 'PM', '', 0)
    `).run(tenantId, tenantId, tenantId);
    db.prepare(`
      INSERT INTO projects (id, name, description, context_md, created_at)
      VALUES (901, 'Custom Project', '', '', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO sprints (id, project_id, name, goal, sprint_type, workflow_template_key, status, length_kind, length_value, created_at)
      VALUES
        (9011, 901, 'Bug Sprint', '', 'bugs', NULL, 'active', 'time', '2w', datetime('now')),
        (9012, 901, 'Enhancement Sprint', '', 'enhancements', NULL, 'paused', 'time', '2w', datetime('now')),
        (9013, 901, 'PM Sprint', '', 'pm', NULL, 'active', 'time', '2w', datetime('now'))
    `).run();

    initSchema();

    const sprints = db.prepare(`
      SELECT id, sprint_type, workflow_template_key
      FROM sprints
      WHERE id IN (9011, 9012, 9013)
      ORDER BY id ASC
    `).all() as Array<{ id: number; sprint_type: string; workflow_template_key: string | null }>;
    expect(sprints).toEqual([
      { id: 9011, sprint_type: 'dev', workflow_template_key: null },
      { id: 9012, sprint_type: 'dev', workflow_template_key: null },
      { id: 9013, sprint_type: 'dev', workflow_template_key: null },
    ]);

    const deprecated = db.prepare(`
      SELECT key
      FROM sprint_types
      WHERE key IN ('bugs', 'enhancements', 'pm')
    `).all();
    expect(deprecated).toEqual([]);
  });

  it('migrates active Agent HQ sprints to the dev sprint type only', () => {
    initSchema();
    const db = getDb();
    db.prepare(`
      INSERT INTO projects (id, name, description, context_md, created_at)
      VALUES (900, 'Agent HQ', '', '', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO sprints (id, project_id, name, goal, sprint_type, workflow_template_key, status, length_kind, length_value, created_at)
      VALUES
        (9001, 900, 'Active Bugs', '', 'generic', NULL, 'active', 'time', '2w', datetime('now')),
        (9002, 900, 'Completed Work', '', 'generic', NULL, 'complete', 'time', '2w', datetime('now'))
    `).run();

    initSchema();

    const rows = db.prepare(`
      SELECT id, sprint_type, workflow_template_key
      FROM sprints
      WHERE id IN (9001, 9002)
      ORDER BY id ASC
    `).all() as Array<{ id: number; sprint_type: string; workflow_template_key: string | null }>;

    expect(rows).toEqual([
      { id: 9001, sprint_type: 'dev', workflow_template_key: null },
      { id: 9002, sprint_type: 'generic', workflow_template_key: null },
    ]);
  });

  it('does not recreate deleted or customized starter sprint-definition rows on reopen', () => {
    initSchema();
    const db = getDb();

    const seededType = db.prepare(`
      SELECT key
      FROM sprint_types
      WHERE key = 'ops'
      ORDER BY key ASC
      LIMIT 1
    `).get() as { key: string } | undefined;
    expect(seededType).toBeDefined();

    const seededFieldSchema = db.prepare(`
      SELECT id
      FROM task_field_schemas
      ORDER BY id ASC
      LIMIT 1
    `).get() as { id: number } | undefined;
    expect(seededFieldSchema).toBeDefined();

    const seededOutcome = db.prepare(`
      SELECT id
      FROM sprint_type_outcomes
      ORDER BY id ASC
      LIMIT 1
    `).get() as { id: number } | undefined;
    expect(seededOutcome).toBeDefined();

    const seededSprintTypeStatus = db.prepare(`
      SELECT sprint_type_key, status_key
      FROM sprint_type_task_statuses
      WHERE sprint_type_key = 'dev'
      ORDER BY id ASC
      LIMIT 1
    `).get() as { sprint_type_key: string; status_key: string } | undefined;
    expect(seededSprintTypeStatus).toBeDefined();

    db.prepare(`
      INSERT INTO projects (id, name, description, context_md, created_at)
      VALUES (990, 'Starter Project', '', '', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO sprints (id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at)
      VALUES (9901, 990, 'Starter Sprint', '', 'dev', 'active', 'time', '2w', datetime('now'))
    `).run();
    seedSprintTaskPolicy(db, 9901);
    const seededSprintStatus = db.prepare(`
      SELECT status_key
      FROM sprint_task_statuses
      WHERE sprint_id = ?
      ORDER BY id ASC
      LIMIT 1
    `).get(9901) as { status_key: string } | undefined;
    expect(seededSprintStatus).toBeDefined();

    db.prepare(`DELETE FROM sprint_types WHERE key = ?`).run(seededType!.key);
    db.prepare(`DELETE FROM task_field_schemas WHERE id = ?`).run(seededFieldSchema!.id);
    db.prepare(`UPDATE sprint_type_outcomes SET label = 'Customized starter outcome' WHERE id = ?`).run(seededOutcome!.id);
    db.prepare(`DELETE FROM sprint_type_task_statuses WHERE sprint_type_key = ? AND status_key = ?`).run(seededSprintTypeStatus!.sprint_type_key, seededSprintTypeStatus!.status_key);
    db.prepare(`DELETE FROM sprint_task_statuses WHERE sprint_id = ? AND status_key = ?`).run(9901, seededSprintStatus!.status_key);

    closeDb();
    initSchema();

    const reopened = getDb();
    const deletedType = reopened.prepare(`SELECT key FROM sprint_types WHERE key = ?`).get(seededType!.key);
    expect(deletedType).toBeUndefined();

    const deletedFieldSchema = reopened.prepare(`SELECT id FROM task_field_schemas WHERE id = ?`).get(seededFieldSchema!.id);
    expect(deletedFieldSchema).toBeUndefined();

    const customizedOutcome = reopened.prepare(`SELECT label FROM sprint_type_outcomes WHERE id = ?`).get(seededOutcome!.id) as { label: string } | undefined;
    expect(customizedOutcome).toEqual({ label: 'Customized starter outcome' });

    const deletedSprintTypeStatus = reopened.prepare(`
      SELECT id
      FROM sprint_type_task_statuses
      WHERE sprint_type_key = ? AND status_key = ?
    `).get(seededSprintTypeStatus!.sprint_type_key, seededSprintTypeStatus!.status_key);
    expect(deletedSprintTypeStatus).toBeUndefined();

    const deletedSprintStatus = reopened.prepare(`
      SELECT id
      FROM sprint_task_statuses
      WHERE sprint_id = ? AND status_key = ?
    `).get(9901, seededSprintStatus!.status_key);
    expect(deletedSprintStatus).toBeUndefined();
  });

  it('preserves custom workflow and sprint statuses across startup schema checks', () => {
    initSchema();
    const db = getDb();

    const tenantId = defaultTenantId();
    db.prepare(`
      INSERT INTO sprint_types (tenant_id, key, name, description, is_system, status_seeded_at)
      VALUES (?, 'federal_preconstruction', 'Federal Preconstruction', 'Custom tenant workflow', 0, NULL)
    `).run(tenantId);
    db.prepare(`
      INSERT INTO sprint_type_task_statuses (
        tenant_id, sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json
      ) VALUES
        (?, 'federal_preconstruction', 'estimating', 'Estimating', 'purple', 0, 0, '["permit_review"]', 0, 1, '{}'),
        (?, 'federal_preconstruction', 'permit_review', 'Permit Review', 'amber', 0, 0, '["awarded"]', 1, 0, '{}'),
        (?, 'federal_preconstruction', 'awarded', 'Awarded', 'green', 1, 0, '[]', 2, 0, '{}')
    `).run(tenantId, tenantId, tenantId);
    db.prepare(`
      INSERT INTO projects (id, name, description, context_md, created_at)
      VALUES (991, 'Elevation Build', '', '', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO sprints (id, project_id, name, goal, sprint_type, status, task_policy_seeded_at, length_kind, length_value, created_at)
      VALUES (9911, 991, 'Federal Package', '', 'federal_preconstruction', 'active', datetime('now'), 'time', 'ongoing', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO sprint_task_statuses (
        sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json
      ) VALUES
        (9911, 'estimating', 'Estimating', 'purple', 0, 0, '["permit_review"]', 0, 1, '{}'),
        (9911, 'permit_review', 'Permit Review', 'amber', 0, 0, '["awarded"]', 1, 0, '{}'),
        (9911, 'awarded', 'Awarded', 'green', 1, 0, '[]', 2, 0, '{}')
    `).run();

    closeDb();
    initSchema();

    const reopened = getDb();
    const sprintType = reopened.prepare(`
      SELECT status_seeded_at
      FROM sprint_types
      WHERE key = 'federal_preconstruction'
    `).get() as { status_seeded_at: string | null };
    expect(sprintType.status_seeded_at).toBeNull();

    const typeStatuses = reopened.prepare(`
      SELECT status_key
      FROM sprint_type_task_statuses
      WHERE sprint_type_key = 'federal_preconstruction'
      ORDER BY stage_order ASC
    `).all() as Array<{ status_key: string }>;
    expect(typeStatuses.map((row) => row.status_key)).toEqual(['estimating', 'permit_review', 'awarded']);

    const sprintStatuses = reopened.prepare(`
      SELECT status_key
      FROM sprint_task_statuses
      WHERE sprint_id = 9911
      ORDER BY stage_order ASC
    `).all() as Array<{ status_key: string }>;
    expect(sprintStatuses.map((row) => row.status_key)).toEqual(['estimating', 'permit_review', 'awarded']);
  });
});
