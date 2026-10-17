import { historicalTestFixture } from './historicalTestFixture';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { runMigrations } from './migrationRunner';
import { seedTelemetryScenario } from '../../domains/telemetry/testScenario';

it('checks many retained manifests together while preserving same-project proofs and revoking moved sources', async () => {
  const fixture = await historicalTestFixture(41), db = fixture.db;
  try {
    await seedTelemetryScenario(db);
    await db.run(`INSERT INTO telemetry_query_results(id,tenant_id,project_id,request,result,state,actor)
      SELECT 'proof-'||n,1,11,'{}','{"value":6}','complete','migration-test' FROM generate_series(1,40) n`);
    await db.run(`INSERT INTO telemetry_query_sources(tenant_id,query_id,source_type,source_id,project_id)
      SELECT 1,q.id,'tasks',t.id,t.project_id FROM telemetry_query_results q CROSS JOIN tasks t WHERE t.tenant_id=1 AND t.project_id=11`);
    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toContain('42-telemetry-invalidation-scan.sql');
    await db.withTransaction(async tx => {
      await tx.exec("SET LOCAL statement_timeout='2000'");
      await tx.run('UPDATE tasks SET agent_id=102 WHERE id=1001');
      expect(await tx.value('SELECT count(*) FROM telemetry_query_results')).toBe(40);
      await tx.run('UPDATE tasks SET workflow_id=112,project_id=12 WHERE id=1001');
      expect(await tx.value('SELECT count(*) FROM telemetry_query_results')).toBe(0);
    });
  } finally { await fixture.close(); }
}, 60000);
