import type { Db } from '../../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { backfillTelemetry, drainTelemetryOutbox, drainTelemetryCaptureBudget, getTelemetryCoverage, purgeTelemetryTask,
  withTelemetryCausation } from './capture';

let db:Db;
beforeEach(async()=>{
  db=await setupTestDb();
  await db.run(`INSERT INTO tenants(id,name,slug) VALUES(1,'One','one'),(2,'Two','two')`);
  await db.run(`INSERT INTO projects(id,tenant_id,name) VALUES(1,1,'First'),(2,2,'Second')`);
  await db.run(`INSERT INTO sprint_types(tenant_id,key,name) VALUES(1,'article','Article'),(2,'article','Other article')`);
  await db.run(`INSERT INTO sprints(id,tenant_id,project_id,name,sprint_type) VALUES(1,1,1,'Articles','article'),(2,2,2,'Other','article')`);
  await db.run(`INSERT INTO task_field_schemas(tenant_id,sprint_type_key,schema_json) VALUES(1,'article',?), (2,'article',?)`,
    JSON.stringify({fields:[{key:'amount',type:'number',label:'Amount'},{key:'accepted',type:'checkbox'}]}),
    JSON.stringify({fields:[{key:'secret_other_tenant',type:'text'}]}));
  await db.run(`INSERT INTO agents(id,tenant_id,name,session_key,model,job_instructions) VALUES(1,1,'A','private-session','model-a','private instructions')`);
});
afterEach(async()=>{await teardownTestDb();});

async function task(id=1,tenantId=1){
  await db.run(`INSERT INTO tasks(id,tenant_id,title,sprint_id,project_id,status,task_type,assigned_agent_id,custom_fields_json)
    VALUES(?,?,?,?,?,'draft','article',?,?)`,id,tenantId,'A task',tenantId,tenantId,tenantId===1?1:null,
    JSON.stringify({amount:12.5,accepted:false,undeclared_secret:'must not survive',secret_other_tenant:'also hidden'}));
}
async function observedTask(id=1){
  return db.all<{kind:string;payload:any;causation_id:string|null}>(`SELECT kind,payload,causation_id FROM telemetry_observations WHERE task_id=? ORDER BY sequence`,id);
}

it('atomically captures direct task SQL, effective declared fields and before/after scope',async()=>{
  await task();
  await db.run(`UPDATE tasks SET status='submitted',custom_fields_json=?,agent_id=1 WHERE id=1`,JSON.stringify({amount:20,accepted:true}));
  const result=await drainTelemetryOutbox(db);
  expect(result.failed).toBe(0);
  const observations=await observedTask();
  expect(observations.map(row=>row.kind)).toEqual(['task.created','task.changed']);
  expect(observations[0].payload.after).toMatchObject({status:'draft',workflow_id:1,workflow_type:'article',assigned_agent_id:1,
    custom_fields:{amount:{decimal:'12.5'},accepted:false},fields_complete:true});
  expect(observations[1].payload).toMatchObject({before:{status:'draft',custom_fields:{amount:{decimal:'12.5'}}},after:{status:'submitted',custom_fields:{amount:{decimal:'20'}}},changed_fields:expect.arrayContaining(['status','custom_fields'])});
  expect(JSON.stringify(observations)).not.toContain('must not survive');
  expect(JSON.stringify(observations)).not.toContain('secret_other_tenant');
});

it('rolls back observations with the canonical mutation',async()=>{
  await task();
  const prior=await db.value(`SELECT COUNT(*) FROM telemetry_outbox`);
  await expect(db.withTransaction(async tx=>{
    await tx.run(`UPDATE tasks SET status='submitted' WHERE id=1`);
    throw new Error('abort');
  })).rejects.toThrow('abort');
  expect(await db.value(`SELECT status FROM tasks WHERE id=1`)).toBe('draft');
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_outbox`)).toBe(prior);
});

it('does not report a canonical write successful when durable capture fails',async()=>{
  await task();
  await db.exec(`ALTER TABLE telemetry_outbox ADD CONSTRAINT capture_failure_fixture CHECK(kind <> 'task.changed') NOT VALID`);
  try{
    await expect(db.run(`UPDATE tasks SET status='submitted' WHERE id=1`)).rejects.toThrow();
    expect(await db.value(`SELECT status FROM tasks WHERE id=1`)).toBe('draft');
  }finally{await db.exec(`ALTER TABLE telemetry_outbox DROP CONSTRAINT capture_failure_fixture`);}
});

it('retries projection idempotently and does not skip a late lower outbox identity',async()=>{
  await task();
  await drainTelemetryOutbox(db);
  const count=await db.value(`SELECT COUNT(*) FROM telemetry_observations`);
  await db.run(`UPDATE telemetry_outbox SET processed_at=NULL`);
  expect((await drainTelemetryOutbox(db)).processed).toBeGreaterThan(0);
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_observations`)).toBe(count);
  // An earlier identity becoming visible after a later one has already drained
  // is the same state the worker sees when transactions commit out of ID order.
  await db.run(`INSERT INTO telemetry_outbox(id,tenant_id,source,source_key,entity_type,entity_id,task_id,kind,occurred_at,payload)
    VALUES(-1,1,'tasks','late-commit','task',1,1,'task.changed',clock_timestamp(),?::jsonb)`,JSON.stringify({before:{status:'draft'},after:{status:'submitted'}}));
  expect((await drainTelemetryOutbox(db)).processed).toBe(1);
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_observations WHERE source_key='late-commit'`)).toBe(1);
});

it('catches up multiple batches in one bounded worker turn and stops at an empty queue',async()=>{
  await drainTelemetryOutbox(db);
  await db.run(`INSERT INTO telemetry_outbox(tenant_id,source,source_key,entity_type,entity_id,kind,occurred_at,payload)
    SELECT 1,'tasks','worker-catchup-'||n,'task',n,'task.changed',clock_timestamp(),'{}' FROM generate_series(1,5) n`);
  expect(await drainTelemetryCaptureBudget(db,{batchSize:2,budgetMs:5000})).toMatchObject({processed:5,pending:0,failed:0,batches:3});
});

it('stops worker catch-up when pending rows are not eligible for retry',async()=>{
  await drainTelemetryOutbox(db);
  await db.run(`INSERT INTO telemetry_outbox(tenant_id,source,source_key,entity_type,entity_id,kind,occurred_at,payload,retry_at)
    VALUES(1,'tasks','worker-delayed','task',1,'task.changed',clock_timestamp(),'{}',clock_timestamp()+interval '1 hour')`);
  expect(await drainTelemetryCaptureBudget(db)).toEqual({processed:0,pending:1,failed:0,batches:1});
});

it('stops worker catch-up at the elapsed budget while keeping the remaining batch durable',async()=>{
  await drainTelemetryOutbox(db);
  await db.run(`INSERT INTO telemetry_outbox(tenant_id,source,source_key,entity_type,entity_id,kind,occurred_at,payload)
    SELECT 1,'tasks','worker-budget-'||n,'task',n,'task.changed',clock_timestamp(),'{}' FROM generate_series(1,3) n`);
  const now=jest.spyOn(Date,'now').mockReturnValueOnce(0).mockReturnValue(501);
  try{expect(await drainTelemetryCaptureBudget(db,{batchSize:2})).toMatchObject({processed:2,pending:1,batches:1});}
  finally{now.mockRestore();}
  expect(await drainTelemetryCaptureBudget(db)).toMatchObject({processed:1,pending:0,batches:1});
});

it('keeps failed projections pending without blocking other rows and reports retry state',async()=>{
  await task();
  await db.run(`INSERT INTO telemetry_outbox(tenant_id,source,source_key,entity_type,entity_id,task_id,project_id,kind,occurred_at,payload)
    VALUES(1,'tasks','poison-fixture','task',1,1,1,'task.changed',clock_timestamp(),'{}'::jsonb)`);
  await db.exec(`ALTER TABLE telemetry_observations ADD CONSTRAINT projection_failure_fixture CHECK(source_key<>'poison-fixture') NOT VALID`);
  try{
    const result=await drainTelemetryOutbox(db);
    expect(result).toMatchObject({pending:1,failed:1});expect(result.processed).toBeGreaterThan(0);
    const coverage=await getTelemetryCoverage(db,1,[1]);
    expect(coverage.sources.find(row=>row.source==='tasks')).toMatchObject({failed_pending:1,max_attempts:1,last_error:expect.stringContaining('23514')});
  }finally{await db.exec(`ALTER TABLE telemetry_observations DROP CONSTRAINT projection_failure_fixture`);}
  await db.run(`UPDATE telemetry_outbox SET retry_at=clock_timestamp() WHERE source_key='poison-fixture'`);
  expect(await drainTelemetryOutbox(db)).toMatchObject({processed:1,pending:0,failed:0});
});

it('actually projects transactions committed out of identity order',async()=>{
  await task();
  await task(3);
  await drainTelemetryOutbox(db);
  let release!:()=>void;let allocated!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const ready=new Promise<void>(resolve=>{allocated=resolve;});
  const earlier=db.withTransaction(async tx=>{
    await tx.run(`UPDATE tasks SET status='first' WHERE id=1`);
    allocated();await held;
  });
  await ready;
  try{
    await db.run(`UPDATE tasks SET status='second' WHERE id=3`);
    expect((await drainTelemetryOutbox(db)).processed).toBe(1);
  }finally{release();await earlier;}
  expect((await drainTelemetryOutbox(db)).processed).toBe(1);
  expect((await observedTask(1)).at(-1)?.payload.after.status).toBe('first');
});

it('propagates one accepted cause through outcomes and transitions and restores nested context',async()=>{
  await task();
  await withTelemetryCausation(db,'external:receipt-1',async tx=>{
    await tx.run(`UPDATE tasks SET status='submitted' WHERE id=1`);
    await withTelemetryCausation(tx,'outcome:inner',async nested=>{
      await nested.run(`INSERT INTO task_history(tenant_id,task_id,field,new_value) VALUES(1,1,'lifecycle_outcome','submit')`);
    });
  },{outcomeAgentId:1});
  await db.run(`UPDATE tasks SET priority='high' WHERE id=1`);
  await drainTelemetryOutbox(db);
  const observations=await observedTask();
  expect(observations[1].causation_id).toBeTruthy();
  expect(observations[2].causation_id).toBe(observations[1].causation_id);
  expect(observations[3].causation_id).toBeNull();
  expect(observations[2].payload.outcome_agent_id).toBe(1);
  expect(observations[3].payload.outcome_agent_id).toBeNull();
  expect(observations[2]).toMatchObject({kind:'task.outcome',payload:{after:{outcome:'submit'}}});
});

it('separates runtime success from run failure and never captures runtime secrets',async()=>{
  await task();
  await db.run(`INSERT INTO job_instances(id,tenant_id,agent_id,task_id,status,payload_sent,response)
    VALUES(1,1,1,1,'running','secret prompt','secret transcript')`);
  await db.run(`INSERT INTO runtime_executions(tenant_id,instance_id,boundary_json,boundary_fingerprint,runtime_type,driver,backend,
    execution_target_id,opaque_handle,state) VALUES(1,1,'{}'::jsonb,'fingerprint','openclaw','driver','backend','target',?::jsonb,'running')`,JSON.stringify({token:'never-copy'}));
  await db.run(`UPDATE runtime_executions SET state='succeeded',ended_at='2026-09-09 12:00:00' WHERE instance_id=1`);
  await db.run(`UPDATE job_instances SET status='failed',runtime_end_success=1,semantic_outcome_missing=1,token_input=20,token_output=10,token_total=30 WHERE id=1`);
  await db.run(`UPDATE job_instances SET token_input=25,token_total=35 WHERE id=1`);
  await drainTelemetryOutbox(db);
  const observations=await observedTask();
  expect(observations.find(row=>row.kind==='runtime.changed')?.payload.after.state).toBe('succeeded');
  expect(observations.filter(row=>row.kind==='run.changed').at(-1)?.payload.after).toMatchObject({status:'failed',runtime_end_success:1,semantic_outcome_missing:1,token_total:35});
  const encoded=JSON.stringify(observations);
  for(const secret of ['secret prompt','secret transcript','never-copy','private-session','private instructions'])expect(encoded).not.toContain(secret);
});

it('captures dependencies without conflating them with configured blockage',async()=>{
  await task();await task(3);
  await db.run(`INSERT INTO task_dependencies(blocker_id,blocked_id) VALUES(1,3)`);
  await db.run(`DELETE FROM task_dependencies WHERE blocker_id=1 AND blocked_id=3`);
  await drainTelemetryOutbox(db);
  expect((await observedTask(3)).filter(row=>row.kind.startsWith('task.relationship')).map(row=>row.kind))
    .toEqual(['task.relationship_added','task.relationship_removed']);
  expect((await observedTask(3)).filter(row=>row.kind==='task.dependencies_changed').map(row=>row.payload.after.unresolved_dependencies)).toEqual([1,0]);
});

it('applies task-type schema overrides and preserves descriptors when fields later change',async()=>{
  await db.run(`INSERT INTO task_field_schemas(tenant_id,sprint_type_key,task_type,schema_json) VALUES(1,'article','article',?)`,
    JSON.stringify({fields:[{key:'amount',type:'select',options:['negotiated']},{key:'typed',type:'number'}]}));
  await task();
  await db.run(`UPDATE task_field_schemas SET schema_json=? WHERE tenant_id=1 AND task_type='article'`,JSON.stringify({fields:[{key:'amount',type:'text'}]}));
  await drainTelemetryOutbox(db);
  expect((await observedTask())[0].payload.after.field_descriptors).toEqual(expect.arrayContaining([expect.objectContaining({key:'amount',type:'select'})]));
});

it('does not retain arbitrary schema metadata or field help text',async()=>{
  await db.run(`UPDATE task_field_schemas SET schema_json=? WHERE tenant_id=1`,JSON.stringify({
    private_context:'do-not-copy-top-level',fields:[{key:'amount',type:'number',help_text:'do-not-copy-help'}],
  }));
  await drainTelemetryOutbox(db);
  const rows=await db.all(`SELECT payload FROM telemetry_observations WHERE source='task_field_schemas'`);
  expect(JSON.stringify(rows)).not.toContain('do-not-copy');
});

it('marks oversized declared values missing instead of copying unbounded payloads',async()=>{
  await db.run(`UPDATE task_field_schemas SET schema_json=? WHERE tenant_id=1`,JSON.stringify({fields:[{key:'memo',type:'text'}]}));
  await task();
  await db.run(`UPDATE tasks SET custom_fields_json=? WHERE id=1`,JSON.stringify({memo:'x'.repeat(9000)}));
  await drainTelemetryOutbox(db);
  expect((await observedTask()).at(-1)?.payload.after).toMatchObject({fields_complete:false,custom_fields:{}});
});

it('preserves numeric custom fields beyond JavaScript integer precision',async()=>{
  await task();
  await db.run(`UPDATE tasks SET custom_fields_json=? WHERE id=1`,'{"amount":9007199254740993.123456789}');
  await drainTelemetryOutbox(db);
  expect((await observedTask()).at(-1)?.payload.after.custom_fields.amount).toEqual({decimal:'9007199254740993.123456789'});
});

it('links edited outcomes and corrected runtime end times to their superseded logical facts',async()=>{
  await task();
  await db.run(`INSERT INTO task_history(id,tenant_id,task_id,field,new_value) VALUES(1,1,1,'lifecycle_outcome','old')`);
  await db.run(`UPDATE task_history SET new_value='corrected' WHERE id=1`);
  await db.run(`INSERT INTO job_instances(id,tenant_id,agent_id,task_id,status) VALUES(1,1,1,1,'running')`);
  await db.run(`INSERT INTO runtime_executions(tenant_id,instance_id,boundary_json,boundary_fingerprint,runtime_type,driver,backend,execution_target_id,state)
    VALUES(1,1,'{}'::jsonb,'fingerprint','runtime','driver','backend','target','running')`);
  await db.run(`UPDATE runtime_executions SET state='failed',ended_at='2026-09-09 12:00:00' WHERE instance_id=1`);
  await db.run(`UPDATE runtime_executions SET ended_at='2026-09-09 13:00:00' WHERE instance_id=1`);
  await drainTelemetryOutbox(db);
  const outcomes=await db.all<{source_key:string;payload:any}>(`SELECT source_key,payload FROM telemetry_observations WHERE kind='task.outcome' ORDER BY sequence`);
  expect(outcomes[1].payload).toMatchObject({after:{outcome:'corrected'},supersedes_source_key:outcomes[0].source_key});
  const runtimes=await db.all<{source_key:string;payload:any;occurred_at:Date}>(`SELECT source_key,payload,occurred_at FROM telemetry_observations WHERE kind='runtime.changed' ORDER BY sequence`);
  expect(runtimes[1].payload).toMatchObject({before:{state:'running'},after:{state:'failed'},supersedes_source_key:runtimes[0].source_key});
  expect(runtimes[1].occurred_at.toISOString()).toBe('2026-09-09T13:00:00.000Z');
});

it('preserves original event context when an old outcome is corrected after a task moves',async()=>{
  await task();
  await db.run(`INSERT INTO task_history(id,tenant_id,task_id,field,new_value) VALUES(1,1,1,'lifecycle_outcome','old')`);
  await db.run(`INSERT INTO projects(id,tenant_id,name) VALUES(3,1,'New project')`);
  await db.run(`INSERT INTO sprints(id,tenant_id,project_id,name,sprint_type) VALUES(3,1,3,'New workflow','article')`);
  await db.run(`UPDATE tasks SET project_id=3,sprint_id=3,custom_fields_json='{"amount":99}' WHERE id=1`);
  await db.run(`UPDATE task_history SET new_value='corrected' WHERE id=1`);
  await drainTelemetryOutbox(db);
  const correction=await db.get<{project_id:number;workflow_id:number;payload:any}>(`SELECT project_id,workflow_id,payload
    FROM telemetry_observations WHERE kind='task.outcome' ORDER BY sequence DESC LIMIT 1`);
  expect(correction).toMatchObject({project_id:1,workflow_id:1,payload:{context:{project_id:1,workflow_id:1,custom_fields:{amount:{decimal:'12.5'}}}}});
});

it('backfills only source-proven old transitions and labels their historical context unknown',async()=>{
  await task();await drainTelemetryOutbox(db);
  await db.run(`INSERT INTO task_events(tenant_id,task_id,from_status,to_status,created_at) VALUES(1,1,'draft','submitted','2020-01-01 12:00:00')`);
  const first=await backfillTelemetry(db,{tenantId:1,source:'task_events',batchSize:1});
  expect(first).toMatchObject({queued:1,cursor:1,history_complete:false});
  expect((await backfillTelemetry(db,{tenantId:1,source:'task_events'}))).toMatchObject({queued:0,complete:true});
  await drainTelemetryOutbox(db);
  const last=(await observedTask()).at(-1);
  expect(last).toMatchObject({kind:'task.changed',payload:{historical_context_known:false,after:{status:'submitted'}}});
  expect(last?.payload.after).not.toHaveProperty('custom_fields');
});

it('does not backfill a second copy of a live transition or lifecycle outcome',async()=>{
  await task();await drainTelemetryOutbox(db);
  await db.run(`UPDATE tasks SET status='submitted' WHERE id=1`);
  await db.run(`INSERT INTO task_events(tenant_id,task_id,from_status,to_status) VALUES(1,1,'draft','submitted')`);
  await db.run(`INSERT INTO task_history(tenant_id,task_id,field,new_value) VALUES(1,1,'lifecycle_outcome','submit')`);
  expect((await backfillTelemetry(db,{tenantId:1,source:'task_events'})).queued).toBe(0);
  expect((await backfillTelemetry(db,{tenantId:1,source:'task_history'})).queued).toBe(0);
});

it('keeps tenant and project coverage separated and never calls a backfill complete history',async()=>{
  await task();await task(2,2);
  await drainTelemetryOutbox(db,{tenantId:1});
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_observations WHERE tenant_id=2`)).toBe(0);
  const own=await getTelemetryCoverage(db,1,[1]);
  const none=await getTelemetryCoverage(db,1,[]);
  expect(own.pending).toBe(0);expect(none.pending).toBe(0);
  expect(own.sources.find(row=>row.source==='tasks')).toMatchObject({instrumented:true,history_complete:false});
  expect((await getTelemetryCoverage(db,2,[2])).pending).toBeGreaterThan(0);
});

it('purges frozen facts when a task is hard deleted and keeps only a field-free tombstone',async()=>{
  await task();await drainTelemetryOutbox(db);
  await db.run(`DELETE FROM tasks WHERE id=1`);
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_observations WHERE task_id=1`)).toBe(0);
  await drainTelemetryOutbox(db);
  const rows=await observedTask();
  expect(rows).toHaveLength(1);expect(rows[0].kind).toBe('task.deleted');
  expect(rows[0].payload).toMatchObject({before:{id:1},after:{},context:{}});
  expect(JSON.stringify(rows)).not.toContain('custom_fields');
  await purgeTelemetryTask(db,1,1);
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_outbox WHERE task_id=1`)).toBe(0);
});

it('purges tenant facts on canonical tenant deletion',async()=>{
  await task();await drainTelemetryOutbox(db);
  await db.run(`DELETE FROM tenants WHERE id=1`);
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_outbox WHERE tenant_id=1`)).toBe(0);
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_observations WHERE tenant_id=1`)).toBe(0);
});

it('purges project snapshots and associated task history when the project is deleted',async()=>{
  await task();await drainTelemetryOutbox(db);
  await db.run(`DELETE FROM projects WHERE id=1`);
  await drainTelemetryOutbox(db);
  const rows=await db.all<{payload:unknown}>(`SELECT payload FROM telemetry_observations WHERE tenant_id=1 AND project_id=1`);
  expect(rows.length).toBeGreaterThan(0);
  for(const row of rows) expect(JSON.stringify(row)).not.toContain('custom_fields');
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_observations WHERE source='projects' AND entity_id=1 AND kind<>'configuration.deleted'`)).toBe(0);
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_observations WHERE source='sprints' AND entity_id=1 AND kind<>'configuration.deleted'`)).toBe(0);
});

it('purges deleted agent execution data while retaining surviving task observations',async()=>{
  await task();
  await db.run(`INSERT INTO job_instances(id,tenant_id,agent_id,task_id,status) VALUES(1,1,1,1,'running')`);
  await drainTelemetryOutbox(db);
  await db.run(`DELETE FROM agents WHERE id=1`);
  await drainTelemetryOutbox(db);
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_observations WHERE entity_type IN ('run','runtime_execution') AND agent_id=1`)).toBe(0);
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_observations WHERE entity_type='task' AND task_id=1`)).toBeGreaterThan(0);
});

it.each(['project','agent','run'])('captures taskless execution scope and purges its facts on %s deletion',async(target)=>{
  await db.run('UPDATE agents SET project_id=1 WHERE id=1');
  await db.run(`INSERT INTO job_instances(id,tenant_id,agent_id,status) VALUES(1,1,1,'running')`);
  await db.run(`INSERT INTO runtime_executions(tenant_id,instance_id,boundary_json,boundary_fingerprint,runtime_type,driver,backend,execution_target_id,state)
    VALUES(1,1,'{}'::jsonb,'fingerprint','runtime','driver','backend','target','running')`);
  await drainTelemetryOutbox(db);
  const rows=await db.all<any>(`SELECT project_id,task_id,payload FROM telemetry_observations WHERE entity_type IN ('run','runtime_execution')`);
  expect(rows).toHaveLength(2);
  for(const row of rows)expect(row).toMatchObject({project_id:1,task_id:null,payload:{context:{project_id:1,agent_id:1}}});
  await db.run(`INSERT INTO telemetry_query_results(id,tenant_id,scope,request,state,actor,expires_at)
    VALUES('taskless-proof',1,'{}','{}','complete','test',clock_timestamp()+interval '1 hour')`);
  if(target==='project')await db.run('DELETE FROM projects WHERE id=1');
  else if(target==='agent')await db.run('DELETE FROM agents WHERE id=1');
  else await db.run('DELETE FROM job_instances WHERE id=1');
  await drainTelemetryOutbox(db);
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_observations WHERE entity_type IN ('run','runtime_execution')`)).toBe(0);
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_outbox WHERE entity_type IN ('run','runtime_execution')`)).toBe(0);
  expect(await db.value(`SELECT COUNT(*) FROM telemetry_query_results`)).toBe(0);
});

it.each(['agent','workflow','run','runtime'])('revokes retained taskless proofs when %s source ownership changes',async(target)=>{
  await db.run(`INSERT INTO projects(id,tenant_id,name) VALUES(3,1,'New project')`);
  await db.run(`INSERT INTO agents(id,tenant_id,name,session_key,model) VALUES(3,1,'Other agent','other','model')`);
  await db.run(`INSERT INTO job_instances(id,tenant_id,agent_id,status) VALUES(1,1,1,'running'),(2,1,3,'running')`);
  await db.run(`INSERT INTO runtime_executions(tenant_id,instance_id,boundary_json,boundary_fingerprint,runtime_type,driver,backend,execution_target_id,state)
    VALUES(1,1,'{}'::jsonb,'fingerprint','runtime','driver','backend','target','running')`);
  await db.run(`INSERT INTO telemetry_query_results(id,tenant_id,scope,request,state,actor,expires_at)
    VALUES('proof',1,'{}','{}','complete','test',clock_timestamp()+interval '1 hour')`);
  if(target==='agent')await db.run('UPDATE agents SET project_id=3 WHERE id=1');
  else if(target==='workflow')await db.run('UPDATE sprints SET project_id=3 WHERE id=1');
  else if(target==='run')await db.run('UPDATE job_instances SET agent_id=3 WHERE id=1');
  else await db.run('UPDATE runtime_executions SET instance_id=2 WHERE instance_id=1');
  expect(await db.value('SELECT COUNT(*) FROM telemetry_query_results')).toBe(0);
});

it('bootstraps taskless execution scope from its canonical tenant-owned agent',async()=>{
  await db.run('UPDATE agents SET project_id=1 WHERE id=1');
  await db.run(`INSERT INTO job_instances(id,tenant_id,agent_id,status) VALUES(1,1,1,'running')`);
  // Model a run that predated capture, without changing any canonical ownership.
  await db.run(`DELETE FROM telemetry_outbox WHERE source='job_instances'`);
  expect((await backfillTelemetry(db,{tenantId:1,source:'job_instances'})).queued).toBe(1);
  await drainTelemetryOutbox(db);
  expect(await db.get(`SELECT project_id,task_id,payload FROM telemetry_observations WHERE source='job_instances'`))
    .toMatchObject({project_id:1,task_id:null,payload:{context:{project_id:1,agent_id:1,task_id:null}}});
});

it('records dependency resolution and reopening according to configured terminality',async()=>{
  await task();await task(3);
  await db.run(`INSERT INTO sprint_task_statuses(sprint_id,status_key,label,terminal) VALUES(1,'accepted','Accepted',1)`);
  await db.run(`INSERT INTO task_dependencies(blocker_id,blocked_id) VALUES(1,3)`);
  await db.run(`UPDATE tasks SET status='accepted' WHERE id=1`);
  await db.run(`UPDATE tasks SET status='draft' WHERE id=1`);
  await drainTelemetryOutbox(db);
  const changes=(await observedTask(3)).filter(row=>row.kind==='task.dependencies_changed');
  expect(changes.map(row=>row.payload.after.unresolved_dependencies)).toEqual([1,0,1]);
  expect(changes[1].payload).toMatchObject({before:{status:'draft',unresolved_dependencies:1},after:{status:'draft',unresolved_dependencies:0}});
});

it('records global and scoped terminality edits that change an existing dependency',async()=>{
  await task();await task(3);
  await db.run(`INSERT INTO task_dependencies(blocker_id,blocked_id) VALUES(1,3)`);
  await db.run(`INSERT INTO task_statuses(name,label,terminal) VALUES('draft','Draft',1)`);
  await db.run(`INSERT INTO sprint_type_task_statuses(tenant_id,sprint_type_key,status_key,label,terminal) VALUES(1,'article','draft','Draft',0)`);
  await drainTelemetryOutbox(db);
  const changes=(await observedTask(3)).filter(row=>row.kind==='task.dependencies_changed');
  expect(changes.map(row=>row.payload.after.unresolved_dependencies)).toEqual([1,0,1]);
});

it('marks dependencies outside the task project for historical scope redaction',async()=>{
  await db.run(`INSERT INTO projects(id,tenant_id,name) VALUES(3,1,'Third')`);
  await db.run(`INSERT INTO sprints(id,tenant_id,project_id,name,sprint_type) VALUES(3,1,3,'Third','article')`);
  await task();await task(3);
  await db.run(`UPDATE tasks SET project_id=3,sprint_id=3 WHERE id=1`);
  await db.run(`INSERT INTO task_dependencies(blocker_id,blocked_id) VALUES(1,3)`);
  await drainTelemetryOutbox(db);
  expect((await observedTask(3)).at(-1)?.payload.after).toMatchObject({unresolved_dependencies:1,dependencies_within_project:false,dependencies_within_tenant:true});
});

it('does not lose the final dependency count when different blockers resolve concurrently',async()=>{
  await task();await task(3);await task(4);
  await db.run(`INSERT INTO sprint_task_statuses(sprint_id,status_key,label,terminal) VALUES(1,'accepted','Accepted',1)`);
  await db.run(`INSERT INTO task_dependencies(blocker_id,blocked_id) VALUES(1,4),(3,4)`);
  let release!:()=>void;let notifyReady!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const ready=new Promise<void>(resolve=>{notifyReady=resolve;});
  const first=db.withTransaction(async tx=>{
    await tx.run(`UPDATE tasks SET status='accepted' WHERE id=1`);notifyReady();await held;
  });
  await ready;
  const second=db.run(`UPDATE tasks SET status='accepted' WHERE id=3`);
  await new Promise(resolve=>setTimeout(resolve,30));
  release();await first;await second;
  await drainTelemetryOutbox(db);
  const changes=(await observedTask(4)).filter(row=>row.kind==='task.dependencies_changed');
  expect(changes.at(-1)?.payload.after.unresolved_dependencies).toBe(0);
});
