import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { writeRoutingAudit } from './audit';

const TENANT_ID = 1;

interface AuditRow {
  id: number;
  tenant_id: number;
  project_id: number | null;
  workflow_type: string;
  workflow_id: number | null;
  entity_table: string;
  entity_id: number | null;
  entity_key: string;
  action: string;
  actor: string;
  actor_kind: string;
  before_json: string;
  after_json: string;
  changes: string;
  batch_id: string;
  affected_workflow_count: number | null;
  created_at: string;
}

/** The tenant parent required by routing_config_audit_log.tenant_id. */
async function ensureTenant(): Promise<void> {
  const db = getDb();
  if (await db.get(`SELECT id FROM tenants WHERE id = ?`, TENANT_ID)) return;
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (?, ?, ?, 1)`, TENANT_ID, 'Default', 'default');
}

async function createProject(): Promise<number> {
  const db = getDb();
  const result = await db.run(`INSERT INTO projects (name, tenant_id) VALUES (?, ?)`, 'Audit Fixture', TENANT_ID);
  return Number(result.lastInsertId);
}

async function lastAuditRow(): Promise<AuditRow> {
  const row = await getDb().get<AuditRow>(`SELECT * FROM routing_config_audit_log ORDER BY id DESC LIMIT 1`);
  if (!row) throw new Error('expected a routing_config_audit_log row');
  return row;
}

describe('routing config audit log', () => {
  beforeEach(async () => {
    await setupTestDb();
    await ensureTenant();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('round-trips a written entry', async () => {
    const projectId = await createProject();

    await writeRoutingAudit(getDb(), {
      tenantId: TENANT_ID,
      projectId,
      workflowType: 'dev',
      entityTable: 'sprint_task_transitions',
      entityId: 42,
      entityKey: 'review:qa_pass',
      action: 'updated',
      actor: 'masiah',
      actorKind: 'user',
      before: { to_status: 'qa_pass', enabled: 1 },
      after: { to_status: 'ready_to_merge', enabled: 1 },
      batchId: 'batch-7',
      affectedWorkflowCount: 3,
    });

    const row = await lastAuditRow();
    expect(row).toMatchObject({
      tenant_id: TENANT_ID,
      project_id: projectId,
      workflow_type: 'dev',
      workflow_id: null,
      entity_table: 'sprint_task_transitions',
      entity_id: 42,
      entity_key: 'review:qa_pass',
      action: 'updated',
      actor: 'masiah',
      actor_kind: 'user',
      batch_id: 'batch-7',
      affected_workflow_count: 3,
    });
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('stores the before/after snapshots and only the changed fields', async () => {
    await writeRoutingAudit(getDb(), {
      tenantId: TENANT_ID,
      workflowType: 'dev',
      entityTable: 'sprint_task_transitions',
      entityId: 42,
      action: 'updated',
      before: { to_status: 'qa_pass', enabled: 1, priority: 0 },
      after: { to_status: 'ready_to_merge', enabled: 0, priority: 0 },
    });

    const row = await lastAuditRow();
    expect(JSON.parse(row.before_json)).toEqual({ to_status: 'qa_pass', enabled: 1, priority: 0 });
    expect(JSON.parse(row.after_json)).toEqual({ to_status: 'ready_to_merge', enabled: 0, priority: 0 });
    // priority is unchanged, so it is absent — the shape the existing ChangesDiff renderer reads.
    expect(JSON.parse(row.changes)).toEqual({
      to_status: { old: 'qa_pass', new: 'ready_to_merge' },
      enabled: { old: 1, new: 0 },
    });
  });

  it('records a creation as a diff from nothing', async () => {
    await writeRoutingAudit(getDb(), {
      tenantId: TENANT_ID,
      workflowType: 'dev',
      entityTable: 'sprint_task_transitions',
      entityId: 7,
      action: 'created',
      after: { to_status: 'review' },
    });

    const row = await lastAuditRow();
    expect(JSON.parse(row.before_json)).toBeNull();
    expect(JSON.parse(row.changes)).toEqual({ to_status: { old: null, new: 'review' } });
  });

  it('accepts a null project_id for globally scoped routing config', async () => {
    await writeRoutingAudit(getDb(), {
      tenantId: TENANT_ID,
      projectId: null,
      workflowType: 'dev',
      entityTable: 'routing_transitions',
      entityKey: 'in_progress:completed_for_review',
      action: 'deleted',
      before: { to_status: 'review' },
    });

    const row = await lastAuditRow();
    expect(row.project_id).toBeNull();
    expect(row.entity_id).toBeNull();
    // Defaults, so an unwired caller cannot produce a row that claims a known author.
    expect(row.actor).toBe('unknown');
    expect(row.actor_kind).toBe('unknown');
    expect(row.batch_id).toBe('');
    expect(JSON.parse(row.after_json)).toBeNull();
  });

  it('throws rather than swallowing a failed write', async () => {
    // Injected failure rather than a real one. Two earlier versions of this test provoked
    // the error through the database — a bad foreign key, then a dropped table — and both
    // were order-dependent: SQLite only enforces foreign keys when the pragma is on and
    // initSchema turns it off while rebuilding, and a :memory: handle reopened mid-test is
    // a different database entirely. Each passed alone and failed under a full run.
    //
    // The behaviour under test has nothing to do with the schema: writeRoutingAudit must
    // propagate whatever the write throws, because this row is the only record of the
    // change. Asserting that directly is both truer and deterministic.
    const failing = {
      run: async () => { throw new Error('write failed'); },
    } as unknown as Parameters<typeof writeRoutingAudit>[0];

    await expect(writeRoutingAudit(failing, {
      tenantId: TENANT_ID,
      workflowType: 'dev',
      entityTable: 'routing_transitions',
      action: 'updated',
    })).rejects.toThrow('write failed');
  });
});
