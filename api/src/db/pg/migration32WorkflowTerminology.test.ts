import {historicalTestFixture} from './historicalTestFixture';
import {POSTGRES_MIGRATION_DIRS} from './migrationDirs';
import {runMigrations} from './migrationRunner';

it('migrates existing workflows and telemetry without resetting identities, history, or grants',async()=>{
  const fixture=await historicalTestFixture(31);const db=fixture.db;
  try{
    await db.exec(`
      INSERT INTO tenants(id,name,slug) VALUES(1,'Migration','migration');
      INSERT INTO projects(id,tenant_id,name) VALUES(1,1,'Migration');
      INSERT INTO sprint_types(id,tenant_id,project_id,key,name) VALUES(1,1,1,'agency','Agency');
      INSERT INTO sprints(id,tenant_id,project_id,name,sprint_type) VALUES(1,1,1,'A sprint title stays user content','agency');
      INSERT INTO sprint_type_task_statuses(id,tenant_id,sprint_type_key,status_key,label) VALUES(1,1,'agency','ready','Ready');
      INSERT INTO sprint_type_outcomes(id,tenant_id,sprint_type_key,outcome_key,label) VALUES(1,1,'agency','finished','Finished');
      INSERT INTO tasks(id,tenant_id,project_id,sprint_id,title,status) VALUES(1,1,1,1,'sprint remains a literal regex target','ready');
      INSERT INTO agents(id,tenant_id,name,session_key,runtime_config,job_instructions) VALUES(1,1,'Migration','migration-agent','{"capabilities":["sprints.read_active_sprint"]}','Use sprint_id; keep sprintf intact.');
      INSERT INTO agent_mcp_capability_policies(agent_id,capability_key,enabled) VALUES(1,'sprints.read_active_sprint',1);
      INSERT INTO telemetry_source_coverage(tenant_id,source,backfill_cursor,backfill_complete) VALUES(1,'sprints',25,true);
    `);
    const signals=await db.all('SELECT generation,active,created_at FROM telemetry_signal_generations ORDER BY generation');
    const sources=await db.all("SELECT replace(source,'sprint','workflow') AS source,capture_started_at FROM telemetry_capture_sources ORDER BY 1");
    const events=await db.all('SELECT id,source_key,payload,occurred_at FROM telemetry_outbox ORDER BY id');
    const identity=await db.value('SELECT telemetry_status_identity FROM tasks WHERE id=1');
    expect(signals.length).toBeGreaterThan(0);expect(identity).toBeTruthy();
    expect(await runMigrations(db,POSTGRES_MIGRATION_DIRS)).toEqual(['32-workflow-terminology.sql']);
    expect(await db.get('SELECT id,workflow_id,title FROM tasks WHERE id=1')).toEqual({id:1,workflow_id:1,title:'sprint remains a literal regex target'});
    expect(await db.value('SELECT name FROM workflows WHERE id=1')).toBe('A sprint title stays user content');
    expect(await db.all('SELECT generation,active,created_at FROM telemetry_signal_generations ORDER BY generation')).toEqual(signals);
    expect(await db.all('SELECT source,capture_started_at FROM telemetry_capture_sources ORDER BY 1')).toEqual(sources);
    expect(await db.all('SELECT id,source_key,payload,occurred_at FROM telemetry_outbox WHERE id=ANY(?::bigint[]) ORDER BY id',events.map((e:any)=>e.id))).toEqual(events);
    expect(await db.get('SELECT source,backfill_cursor,backfill_complete FROM telemetry_source_coverage WHERE tenant_id=1')).toEqual({source:'workflows',backfill_cursor:25,backfill_complete:true});
    expect(await db.value('SELECT job_instructions FROM agents WHERE id=1')).toBe('Use workflow_id; keep sprintf intact.');
    expect(JSON.parse((await db.value<string>('SELECT runtime_config FROM agents WHERE id=1'))!)).toEqual({capabilities:['workflows.read_active_workflow']});
    expect(await db.value('SELECT capability_key FROM agent_mcp_capability_policies WHERE agent_id=1')).toBe('workflows.read_active_workflow');
    expect(await db.all("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND (table_name LIKE '%sprint%' OR column_name LIKE '%sprint%')")).toEqual([]);
    expect(await db.all("SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosrc LIKE '%sprint%'")).toEqual([]);
    await db.run("UPDATE tasks SET title='Updated title' WHERE id=1");
    expect(await db.value('SELECT telemetry_status_identity FROM tasks WHERE id=1')).toBe(identity);
    expect(await db.value("SELECT payload->'after'->>'workflow_type' FROM telemetry_outbox WHERE source='tasks' ORDER BY id DESC LIMIT 1")).toBe('agency');
    await db.run("UPDATE workflow_type_task_statuses SET label='Ready now' WHERE id=1");
    expect(await db.all('SELECT generation,active,created_at FROM telemetry_signal_generations ORDER BY generation')).toEqual(signals);
    expect(await runMigrations(db,POSTGRES_MIGRATION_DIRS)).toEqual([]);
  }finally{await fixture.close();}
},60000);
