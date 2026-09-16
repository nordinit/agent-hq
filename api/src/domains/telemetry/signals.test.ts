import type {Db} from '../../db/adapter/types';
import {setupTestDb,teardownTestDb} from '../../db/testDb';
import {getTelemetryCatalog} from './catalog';
import {compileDefinition,createDefinition,listBindings,saveBinding} from './definitions';
import {queryTelemetry} from './queries';
import {drainTelemetryOutbox,getTelemetryCoverage} from './capture';
import {milestoneRecipe} from './recipes';
import type {MetricDefinition} from './contracts';
let db:Db;
const access={tenantId:1,projectId:null,actor:'test'},scope={project_id:1,workflow_type:'article'};
beforeEach(async()=>{
  db=await setupTestDb();
  await db.run(`INSERT INTO tenants(id,name,slug) VALUES(1,'One','one'),(2,'Other','other')`);
  await db.run(`INSERT INTO projects(id,tenant_id,name) VALUES(1,1,'Article'),(2,2,'Private')`);
  await db.run(`INSERT INTO sprint_types(tenant_id,key,name,project_id) VALUES(1,'article','Article',1),(2,'private','Private',2)`);
  await db.run(`INSERT INTO sprints(id,tenant_id,project_id,name,sprint_type) VALUES(1,1,1,'Article','article'),(2,2,2,'Private','private')`);
  await db.run(`INSERT INTO task_field_schemas(tenant_id,sprint_type_key,schema_json) VALUES(1,'article','{"fields":[{"key":"amount","type":"number"}]}')`);
  await db.run(`INSERT INTO sprint_type_task_statuses(id,tenant_id,sprint_type_key,status_key,label) VALUES(1,1,'article','approved','Approved'),(2,1,'article','review','Review')`);
  await db.run(`INSERT INTO sprint_type_outcomes(id,tenant_id,sprint_type_key,outcome_key,label) VALUES(1,1,'article','changes','Changes requested')`);
});
afterEach(async()=>teardownTestDb());
async function catalog(){return getTelemetryCatalog(db,access,scope);}
async function task(id:number,status='approved'){await db.run(`INSERT INTO tasks(id,tenant_id,project_id,sprint_id,title,status,task_type) VALUES(?,1,1,1,?,?, 'article')`,id,`Task ${id}`,status);}
const statusMetric=():MetricDefinition=>({version:1,key:'approved',name:'Approved',grain:'task',time_basis:'current',missing_policy:'exclude_and_report',measure:{kind:'aggregate',aggregate:'count_if',where:{field:'status',op:'eq',value:'approved'}}});
async function save(definition:MetricDefinition){return createDefinition(db,access,'metric',{key:definition.key,name:definition.name,scope,definition});}

it('pins label revisions without retiring live status/outcome identities during catalog reads',async()=>{
  const before=await catalog(),status=before.statuses.find(s=>s.key==='approved')!,outcome=before.outcomes[0];
  await db.run(`UPDATE sprint_type_task_statuses SET label='Accepted' WHERE id=1`);
  await db.run(`UPDATE sprint_type_outcomes SET label='Revise' WHERE id=1`);
  const after=await catalog();await catalog();
  expect(after.statuses.find(s=>s.key==='approved')).toMatchObject({id:status.id,identity:status.identity,label:'Accepted'});
  expect(after.statuses.find(s=>s.key==='approved')!.revision_id).not.toBe(status.revision_id);
  expect(after.outcomes[0]).toMatchObject({id:outcome.id,identity:outcome.identity,label:'Revise'});
  expect(await db.value('SELECT retired_at FROM telemetry_catalog_entries WHERE id=?',status.id)).toBeNull();
});

it('new same-key generations cannot reinterpret saved status metrics or a task assigned before retirement',async()=>{
  const old=(await catalog()).statuses.find(s=>s.key==='approved')!;
  const saved=await save(statusMetric());await task(1);
  await saveBinding(db,access,{family_key:'approval',scope,metric_revision_id:saved.latest_revision_id});
  await db.run('DELETE FROM sprint_type_task_statuses WHERE id=1');
  await db.run(`INSERT INTO sprint_type_task_statuses(id,tenant_id,sprint_type_key,status_key,label) VALUES(1,1,'article','approved','New approval')`);
  await task(2);await db.run(`UPDATE tasks SET priority='high' WHERE id=1`);
  const current=(await catalog()).statuses.find(s=>s.key==='approved')!;
  expect(current.id).not.toBe(old.id);expect(current.identity).not.toBe(old.identity);
  expect((await queryTelemetry(db,access,{metric_revision_id:saved.latest_revision_id})).value).toBe(1);
  expect((await queryTelemetry(db,access,{definition:statusMetric(),scope})).value).toBe(1);
  expect((await listBindings(db,access,scope))[0]).toMatchObject({validation_state:'needs_attention'});
  await expect(saveBinding(db,access,{family_key:'new',scope,metric_revision_id:saved.latest_revision_id})).rejects.toThrow(/Retired/);
  expect(saved.definition.measure.where.value).toBe('approved');
});

it('pinned retired status milestones still evaluate their historical observations only',async()=>{
  const definition=milestoneRecipe({key:'milestone',name:'Approval entries',milestone:{field:'event.to_status',op:'eq',value:'approved'}});
  const saved=await save(definition);await task(1);
  await db.run(`UPDATE sprint_type_task_statuses SET status_key='accepted' WHERE id=1`);
  await db.run(`INSERT INTO sprint_type_task_statuses(id,tenant_id,sprint_type_key,status_key,label) VALUES(3,1,'article','approved','Different approved')`);
  await task(2);
  expect((await queryTelemetry(db,access,{metric_revision_id:saved.latest_revision_id})).value).toBe(1);
  expect((await queryTelemetry(db,access,{definition,scope})).value).toBe(1);
});

it('accepted outcomes retain their captured identity across retirement and timestamp corrections',async()=>{
  const definition=milestoneRecipe({key:'outcome',name:'Revision outcomes',milestone:{field:'event.outcome',op:'eq',value:'changes'}});
  const saved=await save(definition);await task(1,'review');await task(2,'review');
  await db.run(`INSERT INTO task_history(id,tenant_id,task_id,field,new_value) VALUES(1,1,1,'lifecycle_outcome','changes')`);
  await db.run('DELETE FROM sprint_type_outcomes WHERE id=1');
  await db.run(`INSERT INTO sprint_type_outcomes(id,tenant_id,sprint_type_key,outcome_key,label) VALUES(1,1,'article','changes','Different meaning')`);
  await db.run(`INSERT INTO task_history(id,tenant_id,task_id,field,new_value) VALUES(2,1,2,'lifecycle_outcome','changes')`);
  await db.run(`UPDATE task_history SET created_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') WHERE id=1`);
  expect((await queryTelemetry(db,access,{metric_revision_id:saved.latest_revision_id})).value).toBe(1);
  expect((await queryTelemetry(db,access,{definition,scope})).value).toBe(1);
});

it('profile and component references keep the originating revision signal pins',async()=>{
  const profile=await createDefinition(db,access,'profile',{key:'profile',name:'Profile',scope,definition:{signals:{success:{field:'event.to_status',op:'eq',value:'approved'}}}});
  const metric=await save(milestoneRecipe({key:'component',name:'Component',milestone:{field:'event.to_status',op:'eq',value:'approved'}}));
  await db.run('DELETE FROM sprint_type_task_statuses WHERE id=1');
  await db.run(`INSERT INTO sprint_type_task_statuses(id,tenant_id,sprint_type_key,status_key,label) VALUES(1,1,'article','approved','New')`);
  const raw=milestoneRecipe({key:'profile_metric',name:'Profile metric',milestone:{signal_ref:'success'} as any});
  const compiled=await compileDefinition(db,access,raw,scope,profile.latest_revision_id);
  expect(compiled.dependencies.signals.some((s:any)=>s.identity===profile.dependencies.signals[0].identity)).toBe(true);
  const component=await compileDefinition(db,access,{...metric.definition,key:'sum',measure:{metric_ref:metric.latest_revision_id}},scope);
  expect(component.dependencies.signals.some((s:any)=>s.identity===metric.dependencies.signals[0].identity)).toBe(true);
});

it('preserves raw unconfigured status selectors without adopting a later configured meaning',async()=>{
  const definition=statusMetric();(definition.measure as any).where.value='custom';
  const saved=await save(definition);await task(1,'custom');
  await db.run(`INSERT INTO sprint_type_task_statuses(id,tenant_id,sprint_type_key,status_key,label) VALUES(3,1,'article','custom','Configured now')`);
  await task(2,'custom');
  expect((await queryTelemetry(db,access,{metric_revision_id:saved.latest_revision_id})).value).toBe(1);
});

it('does not expose stale status identity when its assignment producer is disabled',async()=>{
  await task(1,'review');await drainTelemetryOutbox(db);
  await db.exec('ALTER TABLE tasks DISABLE TRIGGER telemetry_task_status_identity');
  try{
    await db.run(`UPDATE tasks SET status='approved' WHERE id=1`);
    expect(await db.value(`SELECT telemetry_task_snapshot(to_jsonb(t))->>'status_identity' FROM tasks t WHERE id=1`)).toBeNull();
    expect((await getTelemetryCoverage(db,1)).sources.find(s=>s.source==='telemetry_signals')!.instrumented).toBe(false);
  }finally{await db.exec('ALTER TABLE tasks ENABLE TRIGGER telemetry_task_status_identity');}
});

it('does not reuse a stale generation when its canonical producer is disabled',async()=>{
  await catalog();
  await db.exec('ALTER TABLE sprint_type_task_statuses DISABLE TRIGGER telemetry_signal_generation');
  try{
    await db.run('DELETE FROM sprint_type_task_statuses WHERE id=1');
    await db.run(`INSERT INTO sprint_type_task_statuses(id,tenant_id,sprint_type_key,status_key,label) VALUES(1,1,'article','approved','Replacement')`);
    await task(1);
    expect(await db.value('SELECT telemetry_status_identity FROM tasks WHERE id=1')).toBeNull();
  }finally{await db.exec('ALTER TABLE sprint_type_task_statuses ENABLE TRIGGER telemetry_signal_generation');}
});

it('rolls back signal retirement atomically and does not rewrite platform run statuses',async()=>{
  const old=(await catalog()).statuses.find(s=>s.key==='approved')!;
  await expect(db.withTransaction(async tx=>{await tx.run('DELETE FROM sprint_type_task_statuses WHERE id=1');throw new Error('abort');})).rejects.toThrow('abort');
  expect((await catalog()).statuses.find(s=>s.key==='approved')!.identity).toBe(old.identity);
  const compiled=await compileDefinition(db,access,{...statusMetric(),grain:'run',measure:{kind:'aggregate',aggregate:'count_if',where:{field:'status',op:'eq',value:'failed'}}},scope);
  expect((compiled.definition.measure as any).where).toEqual({field:'status',op:'eq',value:'failed'});
});

it.each([false,true])('pins comparison expressions with literal on either side (reverse=%s)',async(reverse)=>{
  const field={field:'event.to_status',basis:'at_event'},literal={literal:'approved'};
  const metric=milestoneRecipe({key:'expression',name:'Expression',milestone:{left:reverse?literal:field,op:'eq',right:reverse?field:literal} as any});
  const compiled=await compileDefinition(db,access,metric,scope);
  expect((compiled.definition.measure as any).where).toMatchObject({field:'event.to_status_identity',basis:'at_event',op:'in'});
  expect(compiled.dependencies.signals.some((signal:any)=>signal.key==='approved'&&signal.source)).toBe(true);
});

it('uses workflow overrides and global status lifecycles without leaking tenant-owned signals',async()=>{
  await db.run(`INSERT INTO task_statuses(name,label) VALUES('global','Global')`);
  await db.run(`INSERT INTO sprint_task_statuses(id,sprint_id,status_key,label) VALUES(10,1,'approved','Workflow approval')`);
  await db.run(`INSERT INTO sprint_type_task_statuses(id,tenant_id,sprint_type_key,status_key,label) VALUES(20,2,'private','secret','Secret')`);
  const records=await catalog(),override=records.statuses.find(signal=>signal.source?.table==='sprint_task_statuses')!;
  expect(records.statuses.some(signal=>signal.key==='secret')).toBe(false);
  await task(1);expect(await db.value('SELECT telemetry_status_identity FROM tasks WHERE id=1')).toBe(override.identity);
  const global=records.statuses.find(signal=>signal.key==='global')!;
  await db.run(`DELETE FROM task_statuses WHERE name='global'`);
  await db.run(`INSERT INTO task_statuses(name,label) VALUES('global','New global')`);
  expect((await catalog()).statuses.find(signal=>signal.key==='global')!.identity).not.toBe(global.identity);
});

it('allows concurrent tenant catalog reads while serializing canonical signal writers',async()=>{
  let release!:()=>void,ready!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{ready=resolve;});
  const first=db.withTransaction(async tx=>{await getTelemetryCatalog(tx,access,scope);ready();await held;});
  await started;
  try{
    await db.withTransaction(async tx=>{
      await tx.exec("SET LOCAL lock_timeout='1000ms'");
      const other=await getTelemetryCatalog(tx,{tenantId:2,projectId:2,actor:'other'},{project_id:2});
      expect(other.projects.map(project=>project.id)).toEqual([2]);
    });
    await expect(db.withTransaction(async tx=>{
      await tx.exec("SET LOCAL lock_timeout='50ms'");
      await tx.run("UPDATE sprint_type_task_statuses SET label='Cannot race read' WHERE id=1");
    })).rejects.toMatchObject({code:'55P03'});
  }finally{release();await first;}
});
