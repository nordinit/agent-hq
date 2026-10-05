import { historicalTestFixture } from './historicalTestFixture';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { runMigrations } from './migrationRunner';

it('preserves old pending/failed uncertainty while retaining successful receipts', async () => {
  const fixture = await historicalTestFixture(38);
  const db = fixture.db;
  try {
    await db.run("INSERT INTO tenants (id,name,slug,is_default) VALUES (1,'Test','test',1)");
    await db.run("INSERT INTO agents (id,tenant_id,name,session_key) VALUES (1,1,'Test','agent:test:main')");
    for (const state of ['pending', 'failed', 'applied']) {
      await db.run(`INSERT INTO openclaw_mcp_reconciliation
        (target_key,agent_id,desired_revision,applied_revision,state,receipt_json)
        VALUES (?,1,'desired','old',?,'{"generation":2}')`, state, state);
    }
    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toContain('39-openclaw-mcp-recovery.sql');
    expect(await db.all(`SELECT target_key,recovery_required,operation_phase,receipt_json
      FROM openclaw_mcp_reconciliation ORDER BY target_key`)).toEqual([
      { target_key: 'applied', recovery_required: false, operation_phase: 'verified', receipt_json: '{"generation":2}' },
      { target_key: 'failed', recovery_required: true, operation_phase: 'reload', receipt_json: '{"generation":2}' },
      { target_key: 'pending', recovery_required: true, operation_phase: 'reload', receipt_json: '{"generation":2}' },
    ]);
  } finally { await fixture.close(); }
}, 60000);
