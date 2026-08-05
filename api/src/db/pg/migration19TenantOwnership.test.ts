import type { Db } from '../adapter/types';
import { setupTestDb, teardownTestDb } from '../testDb';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { loadMigrations, migrationStatus, runMigrations } from './migrationRunner';

const MIGRATION_ID = '19-backfill-legacy-tenant-ownership.sql';

describe('migration 19 legacy tenant ownership repair', () => {
  let db: Db;
  const migration = loadMigrations(POSTGRES_MIGRATION_DIRS)
    .find(({ id }) => id === MIGRATION_ID);

  beforeEach(async () => {
    if (!migration) throw new Error(`${MIGRATION_ID} is missing from the release migration set`);
    db = await setupTestDb();
  });

  afterEach(async () => {
    try {
      if (!db) return;
      // Keep the shared worker database current even if an assertion fails before the migration
      // runs. Other suites reuse this schema and the ledger is deliberately not truncated by the
      // ordinary fixture reset.
      await db.exec(`
        TRUNCATE tenants, app_settings RESTART IDENTITY CASCADE;
      `);
      await db.run(
        `INSERT INTO schema_migrations (id, checksum)
         VALUES (?, ?)
         ON CONFLICT (id) DO UPDATE SET checksum = EXCLUDED.checksum`,
        MIGRATION_ID,
        migration!.checksum,
      );
    } finally {
      await teardownTestDb();
    }
  });

  it('applies to a fresh uninstalled database without inventing tenant configuration', async () => {
    expect(Number(await db.value(`SELECT COUNT(*) FROM tenants`))).toBe(0);
    expect(Number(await db.value(`SELECT COUNT(*) FROM app_settings`))).toBe(0);

    await db.run(`DELETE FROM schema_migrations WHERE id = ?`, MIGRATION_ID);
    const before = await migrationStatus(db, POSTGRES_MIGRATION_DIRS);
    expect(before.pending).toEqual([MIGRATION_ID]);
    expect(before.drifted).toEqual([]);
    expect(before.unexpected).toEqual([]);

    await expect(runMigrations(db, POSTGRES_MIGRATION_DIRS)).resolves.toEqual([MIGRATION_ID]);
    expect(Number(await db.value(`SELECT COUNT(*) FROM tenants`))).toBe(0);
    expect(Number(await db.value(`SELECT COUNT(*) FROM app_settings`))).toBe(0);
    expect(await db.all(`
      SELECT table_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND column_name = 'tenant_id'
        AND table_name IN ('projects', 'routing_config', 'task_history')
      ORDER BY table_name
    `)).toEqual([
      { table_name: 'projects', is_nullable: 'YES' },
      { table_name: 'routing_config', is_nullable: 'YES' },
      { table_name: 'task_history', is_nullable: 'YES' },
    ]);
    await expect(runMigrations(db, POSTGRES_MIGRATION_DIRS)).resolves.toEqual([]);
  });

  it('applies only once, repairs ownership, and preserves baseline schema and operator routing config', async () => {
    // Tenant 1 intentionally exists but is not the default. A fallback to a hard-coded tenant 1
    // would either violate the expected result or fail the migration's default-tenant checks.
    await db.run(
      `INSERT INTO tenants (id, name, slug, is_default) VALUES
        (1, 'First tenant', 'first-tenant', 0),
        (42, 'Configured default', 'configured-default', 1),
        (77, 'Parent owner', 'parent-owner', 0)`,
    );
    await db.run(
      `INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '42')`,
    );

    await db.run(`DELETE FROM schema_migrations WHERE id = ?`, MIGRATION_ID);

    // A root row has no stronger owner and must use the configured default (42, not 1).
    await db.run(
      `INSERT INTO projects (id, name, tenant_id) VALUES (?, ?, ?)`,
      100,
      'Legacy root without ownership',
      null,
    );

    // These rows establish a non-default parent chain. Both legacy NULL children must inherit 77.
    await db.run(
      `INSERT INTO projects (id, name, tenant_id) VALUES (?, ?, ?)`,
      200,
      'Operator project',
      77,
    );
    await db.run(
      `INSERT INTO sprints (id, project_id, name, tenant_id) VALUES (?, ?, ?, ?)`,
      300,
      200,
      'Operator sprint',
      77,
    );
    await db.run(
      `INSERT INTO tasks (id, title, project_id, sprint_id, tenant_id) VALUES (?, ?, ?, ?, ?)`,
      400,
      'Operator task',
      200,
      300,
      77,
    );
    await db.run(
      `INSERT INTO task_history (id, task_id, field, old_value, new_value, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      500,
      400,
      'status',
      'ready',
      'review',
      null,
    );
    await db.run(
      `INSERT INTO routing_config
        (id, project_id, from_status, outcome, to_status, enabled, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      600,
      200,
      'review',
      'approve',
      'done',
      0,
      null,
    );

    // One operator-owned transition remains; its sibling is explicitly deleted before migration.
    // Migration must neither overwrite the survivor nor recreate the deleted row.
    await db.run(
      `INSERT INTO sprint_task_transitions
        (id, sprint_id, project_id, task_type, from_status, outcome, to_status,
         enabled, priority, is_protected, tenant_id)
       VALUES
        (700, 300, 200, 'operator-task', 'review', 'approve', 'done', 0, 37, 0, 77),
        (701, 300, 200, 'operator-task', 'review', 'reject', 'ready', 1, 11, 0, 77)`,
    );
    const operatorTransition = await db.get(`
      SELECT id, sprint_id, project_id, task_type, from_status, outcome, to_status,
             enabled, priority, is_protected, tenant_id
      FROM sprint_task_transitions
      WHERE id = 700
    `);
    expect(operatorTransition).toBeDefined();
    await db.run(`DELETE FROM sprint_task_transitions WHERE id = ?`, 701);

    expect(await db.get(`
      SELECT
        (SELECT tenant_id FROM projects WHERE id = 100) AS fallback_owner,
        (SELECT tenant_id FROM task_history WHERE id = 500) AS history_owner,
        (SELECT tenant_id FROM routing_config WHERE id = 600) AS routing_owner
    `)).toEqual({ fallback_owner: null, history_owner: null, routing_owner: null });

    const before = await migrationStatus(db, POSTGRES_MIGRATION_DIRS);
    expect(before.pending).toEqual([MIGRATION_ID]);
    expect(before.drifted).toEqual([]);
    expect(before.unexpected).toEqual([]);

    await expect(runMigrations(db, POSTGRES_MIGRATION_DIRS)).resolves.toEqual([MIGRATION_ID]);

    expect(await db.get(`
      SELECT
        (SELECT tenant_id FROM projects WHERE id = 100) AS fallback_owner,
        (SELECT tenant_id FROM task_history WHERE id = 500) AS history_owner,
        (SELECT tenant_id FROM routing_config WHERE id = 600) AS routing_owner,
        (SELECT value FROM app_settings WHERE key = 'default_tenant_id') AS configured_default
    `)).toEqual({
      fallback_owner: 42,
      history_owner: 77,
      routing_owner: 77,
      configured_default: '42',
    });
    expect(await db.get(`
      SELECT id, sprint_id, project_id, task_type, from_status, outcome, to_status,
             enabled, priority, is_protected, tenant_id
      FROM sprint_task_transitions
      WHERE id = 700
    `)).toEqual(operatorTransition);
    expect(await db.get(`SELECT id FROM sprint_task_transitions WHERE id = 701`)).toBeUndefined();
    expect(Number(await db.value(`SELECT COUNT(*) FROM sprint_task_transitions`))).toBe(1);

    expect(await db.all(`
      SELECT table_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND column_name = 'tenant_id'
        AND table_name IN ('projects', 'routing_config', 'task_history')
      ORDER BY table_name
    `)).toEqual([
      { table_name: 'projects', is_nullable: 'YES' },
      { table_name: 'routing_config', is_nullable: 'YES' },
      { table_name: 'task_history', is_nullable: 'YES' },
    ]);
    expect(await db.get(
      `SELECT id, checksum FROM schema_migrations WHERE id = ?`,
      MIGRATION_ID,
    )).toEqual({ id: MIGRATION_ID, checksum: migration!.checksum });

    const stateAfterFirstRun = await db.get(`
      SELECT
        (SELECT tenant_id FROM projects WHERE id = 100) AS fallback_owner,
        (SELECT tenant_id FROM task_history WHERE id = 500) AS history_owner,
        (SELECT tenant_id FROM routing_config WHERE id = 600) AS routing_owner,
        (SELECT COUNT(*) FROM sprint_task_transitions) AS transition_count,
        (SELECT COUNT(*) FROM sprint_task_transitions WHERE id = 701) AS deleted_count
    `);
    await expect(runMigrations(db, POSTGRES_MIGRATION_DIRS)).resolves.toEqual([]);
    expect(await db.get(`
      SELECT
        (SELECT tenant_id FROM projects WHERE id = 100) AS fallback_owner,
        (SELECT tenant_id FROM task_history WHERE id = 500) AS history_owner,
        (SELECT tenant_id FROM routing_config WHERE id = 600) AS routing_owner,
        (SELECT COUNT(*) FROM sprint_task_transitions) AS transition_count,
        (SELECT COUNT(*) FROM sprint_task_transitions WHERE id = 701) AS deleted_count
    `)).toEqual(stateAfterFirstRun);
  });
});
