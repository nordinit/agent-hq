import { historicalTestFixture } from './historicalTestFixture';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { runMigrations } from './migrationRunner';
import { seedTelemetryScenario } from '../../domains/telemetry/testScenario';
import { getQueryRecord } from '../../domains/telemetry/queries';

it('backfills retained and frozen proofs, leaves their values unchanged, and fails closed for opaque legacy rows',async()=>{
  const fixture=await historicalTestFixture(37),db=fixture.db;
  try {
    await seedTelemetryScenario(db);
    const proof={value:1,contributors:[{entity_kind:'task',entity_id:1001,included:true,observation_ids:[]}]};
    for(const id of ['retained','frozen','opaque']) await db.run(`INSERT INTO telemetry_query_results
      (id,tenant_id,project_id,request,result,state,actor,task_ids,source_projects,snapshot)
      VALUES(?,1,11,'{}',?::jsonb,'complete','migration','{1001}','{11}',?)`,id,JSON.stringify(id==='opaque'?{}:proof),id==='frozen');
    expect(await runMigrations(db,POSTGRES_MIGRATION_DIRS)).toContain('38-telemetry-source-invalidation.sql');
    for(const id of ['retained','frozen']){
      const row=await getQueryRecord(db,{tenantId:1,projectId:11,actor:'test'},id);
      expect(row.result).toEqual(proof); expect(row.source_count).toBe(3);
      expect(row.snapshot).toBe(id==='frozen');
    }
    await expect(getQueryRecord(db,{tenantId:1,projectId:11,actor:'test'},'opaque')).rejects.toMatchObject({code:'result_unavailable'});
    await db.run('DELETE FROM tasks WHERE id=1001');
    expect(await db.value("SELECT count(*) FROM telemetry_query_results WHERE id IN ('retained','frozen')")).toBe(0);
  } finally {await fixture.close();}
},60000);
