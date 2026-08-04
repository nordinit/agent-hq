import { getDb } from '../../db/client';
import { ensureRoutingConfigAuditLogTable } from '../../db/schema';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { tableExists } from '../../db/introspection';
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

/**
 * The tenant every row here is scoped to.
 *
 * initSchema() seeds one on SQLite, but the PostgreSQL fixture template carries DDL only and is
 * truncated between tests — and routing_config_audit_log.tenant_id is a real foreign key there.
 */
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
    await ensureRoutingConfigAuditLogTable(getDb());
    await ensureTenant();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('creates the table through the ensure path', async () => {
    expect(await tableExists(getDb(), 'routing_config_audit_log')).toBe(true);
  });

  it('is idempotent when the ensure path runs again', async () => {
    await ensureRoutingConfigAuditLogTable(getDb());
    expect(await tableExists(getDb(), 'routing_config_audit_log')).toBe(true);
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
    // Deliberately NOT a bad foreign key. SQLite only enforces FKs when the pragma is on,
    // and initSchema turns `foreign_keys = OFF` while rebuilding tables, so an FK-based
    // assertion passes in isolation and fails whenever another suite has left it off.
    // Dropping the table fails identically on both engines and tests the actual intent:
    // this write must propagate, because it is the only record of the change.
    const db = getDb();
    await db.exec(`DROP TABLE routing_config_audit_log`);
    try {
      await expect(writeRoutingAudit(db, {
        tenantId: TENANT_ID,
        workflowType: 'dev',
        entityTable: 'routing_transitions',
        action: 'updated',
      })).rejects.toThrow();
    } finally {
      await ensureRoutingConfigAuditLogTable(db);
    }
  });
});
