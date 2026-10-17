import {historicalTestFixture} from './historicalTestFixture';
import {POSTGRES_MIGRATION_DIRS} from './migrationDirs';
import {runMigrations} from './migrationRunner';

it('upgrades old observations without rewriting history and maintains correction evidence on new writes',async()=>{
  const fixture=await historicalTestFixture(40),db=fixture.db;
  try{
    await db.run("INSERT INTO tenants(id,name,slug) VALUES(1,'Test','test')");
    const payload={before:{project_id:1,outcome:'old',private_large_snapshot:'x'.repeat(5000)},after:{project_id:2,outcome:'new',outcome_identity:'signal-new'},context:{project_id:2},supersedes_source_key:'parent'};
    await db.run(`INSERT INTO telemetry_observations(tenant_id,source,source_key,entity_type,entity_id,kind,occurred_at,recorded_at,sequence,provenance,producer_version,payload) VALUES(1,'task_history','child','task',1,'task.outcome',clock_timestamp(),clock_timestamp(),1,'observed',1,?::jsonb)`,JSON.stringify(payload));
    await runMigrations(db,POSTGRES_MIGRATION_DIRS);
    expect(await db.value("SELECT outcome_evidence FROM telemetry_observations WHERE source_key='child'")).toBeNull();
    await db.run("UPDATE telemetry_observations SET outcome_evidence=telemetry_outcome_evidence(payload) WHERE source_key='child'");
    const evidence=await db.value<any>("SELECT outcome_evidence FROM telemetry_observations WHERE source_key='child'");
    expect(evidence).toEqual({before:{project_id:1,outcome:'old'},after:{project_id:2,outcome:'new',outcome_identity:'signal-new'},context:{project_id:2},supersedes_source_key:'parent'});
    expect(await db.value("SELECT payload FROM telemetry_observations WHERE source_key='child'")).toEqual(payload);
    await db.run("UPDATE telemetry_observations SET payload=jsonb_set(payload,'{after,outcome}','\"corrected\"'::jsonb) WHERE source_key='child'");
    expect(await db.value("SELECT outcome_evidence->'after'->>'outcome' FROM telemetry_observations WHERE source_key='child'")).toBe('corrected');
  }finally{await fixture.close();}
},60000);
