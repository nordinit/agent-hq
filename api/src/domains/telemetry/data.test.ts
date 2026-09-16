import type { Db } from '../../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { loadMetricData, requiredMetricSources } from './data';
import { getTelemetryCatalog } from './catalog';
import { drainTelemetryOutbox, TELEMETRY_CAPTURE_SOURCES } from './capture';
import { evaluateMetric } from './evaluator';
import { blockedSnapshotRecipe, coreRuntimeRecipes, firstPassRecipe, milestoneRecipe, numericRecipe } from './recipes';
import type { MetricDefinition, Predicate } from './contracts';
import type { TelemetryAccess, TelemetryScope } from './access';

let db:Db;
const operator:TelemetryAccess={tenantId:1,projectId:null,actor:'test'};
const status=(value:string):Predicate=>({field:'event.to_status',op:'eq',value});
const created:Predicate={field:'event.type',op:'eq',value:'task.created'};
beforeEach(async()=>{
  db=await setupTestDb();
  await db.run("INSERT INTO tenants(id,name,slug) VALUES(1,'One','one'),(2,'Two','two')");
  await db.run("INSERT INTO projects(id,tenant_id,name) VALUES(1,1,'Editorial'),(3,1,'Proposals'),(2,2,'Private tenant')");
  await db.run("INSERT INTO sprint_types(tenant_id,key,name) VALUES(1,'article','Article'),(1,'proposal','Proposal'),(2,'private','Private')");
  await db.run("INSERT INTO sprints(id,tenant_id,project_id,name,sprint_type,status) VALUES(1,1,1,'Articles','article','active'),(3,1,3,'Proposals','proposal','active'),(2,2,2,'Private','private','active')");
  await db.run("INSERT INTO agents(id,tenant_id,project_id,name,session_key) VALUES(1,1,1,'Editor','agent:data-editor:main'),(3,1,3,'Writer','agent:data-writer:main'),(2,2,2,'Private','agent:data-private:main')");
  const schema=JSON.stringify({fields:[{key:'amount',type:'number',label:'Amount'},{key:'accepted',type:'checkbox',label:'Accepted'}]});
  await db.run("INSERT INTO task_field_schemas(tenant_id,sprint_type_key,schema_json) VALUES(1,'article',?),(1,'proposal',?),(2,'private',?)",schema,schema,schema);
  // All producers are installed by the real migration. Explicit fixture boundaries
  // isolate semantic tests from the template database's metadata-reset behavior.
  for(const source of TELEMETRY_CAPTURE_SOURCES)await db.run("INSERT INTO telemetry_capture_sources(source,capture_started_at) VALUES(?,clock_timestamp()-interval '1 hour') ON CONFLICT(source) DO UPDATE SET capture_started_at=EXCLUDED.capture_started_at",source);
});
afterEach(async()=>{await teardownTestDb();});
async function task(id=1,project=1,tenant=1,amount=10){
  await db.run("INSERT INTO tasks(id,tenant_id,project_id,sprint_id,title,status,task_type,assigned_agent_id,custom_fields_json) VALUES(?,?,?,?,?,'draft','article',?,?)",id,tenant,project,project,`Task ${id}`,tenant===1?1:2,JSON.stringify({amount,accepted:false}));
}
async function calculate(definition:MetricDefinition,scope:TelemetryScope={},access=operator){
  await drainTelemetryOutbox(db,{batchSize:1000});
  const catalog=await getTelemetryCatalog(db,access,scope);
  const asOf=new Date().toISOString();
  const data=await loadMetricData(db,access,scope,definition,catalog.fields,asOf,1000);
  return {data,result:evaluateMetric({definition,entities:data.entities,observations:data.observations,catalog:catalog.fields,as_of:asOf,filter:data.scopePredicate})};
}

it('selects an old project event cohort using recorded scope after a task moves',async()=>{
  await task();
  await db.run("UPDATE tasks SET status='submitted',custom_fields_json=? WHERE id=1",JSON.stringify({amount:20,accepted:true}));
  await db.run("UPDATE tasks SET project_id=3,sprint_id=3,status='draft',custom_fields_json=? WHERE id=1",JSON.stringify({amount:99,accepted:false}));
  const definition=milestoneRecipe({key:'submissions',name:'Submissions',milestone:status('submitted')});
  definition.group_by=[{field:'project_id'}];
  const {data,result}=await calculate(definition,{project_id:1,workflow_id:1,workflow_type:'article'});
  expect(data.entities).toHaveLength(1);expect(data.entities[0].fields.project_id).toBe(3);
  expect(result.value).toBe(1);expect(result.groups[0].key).toEqual([1]);
  expect(result.contributors.find(row=>row.included)?.observation_ids.length).toBeGreaterThan(0);
});

it('an entry cohort follows its complete journey through a later project/workflow move',async()=>{
  await task();
  await db.run("UPDATE tasks SET project_id=3,sprint_id=3,status='working' WHERE id=1");
  await db.run("UPDATE tasks SET status='approved' WHERE id=1");
  const definition=firstPassRecipe({key:'approval',name:'Approval',start:created,success:status('approved'),rework:status('revision')});
  definition.group_by=[{field:'project_id'}];
  const {result}=await calculate(definition,{project_id:1,workflow_type:'article'});
  expect(result.numerator).toBe(1);expect(result.denominator).toBe(1);expect(result.groups[0].key).toEqual([1]);
  expect(result.contributors.find(row=>row.included)?.resolution).toBe('success');
});

it('scoped credentials require current source access and never load another project history',async()=>{
  await task();
  await db.run("UPDATE tasks SET status='secret-old-stage' WHERE id=1");
  await db.run("UPDATE tasks SET project_id=3,sprint_id=3,status='submitted' WHERE id=1");
  const definition=milestoneRecipe({key:'submissions',name:'Submissions',milestone:status('submitted')});
  const former=await calculate(definition,{project_id:1},{tenantId:1,projectId:1,actor:'former'});
  expect(former.data.entities).toHaveLength(0);
  const current=await calculate(definition,{project_id:3},{tenantId:1,projectId:3,actor:'current'});
  expect(current.result.value).toBe(1);
  expect(current.data.observations.some(observation=>observation.type==='task.created')).toBe(false);
  expect(JSON.stringify(current.data.observations)).not.toContain('secret-old-stage');
});

it('captures custom values at the actual milestone rather than today or another schema with the same key',async()=>{
  await task();
  await db.run("UPDATE tasks SET status='submitted',custom_fields_json=? WHERE id=1",JSON.stringify({amount:20}));
  await db.run("UPDATE tasks SET custom_fields_json=? WHERE id=1",JSON.stringify({amount:99}));
  const catalog=await getTelemetryCatalog(db,operator,{project_id:1,workflow_type:'article'});
  const amount=catalog.fields.find(field=>field.key==='amount')!;
  const definition=firstPassRecipe({key:'value',name:'Submitted value',start:created,success:status('submitted')});
  definition.measure={kind:'aggregate',aggregate:'sum',value:{field:amount.id,basis:'at_resolution'}};
  expect((await calculate(definition,{project_id:1,workflow_type:'article'})).result.value).toBe(20);
  const current=numericRecipe({key:'current',name:'Current amount',field:amount.id});
  expect((await calculate(current,{project_id:1,workflow_type:'article'})).result.value).toBe(99);
  const other=await getTelemetryCatalog(db,operator,{project_id:3,workflow_type:'proposal'});
  expect(other.fields.find(field=>field.key==='amount')!.id).not.toBe(amount.id);
});

it('a current scalar aggregate skips unrelated history while explicit event expressions retain it',async()=>{
  await task();await db.run("UPDATE tasks SET status='approved' WHERE id=1");
  const catalog=await getTelemetryCatalog(db,operator,{project_id:1,workflow_type:'article'}),amount=catalog.fields.find(field=>field.key==='amount')!;
  const definition=numericRecipe({key:'amount',name:'Amount',field:amount.id});
  const current=await calculate(definition,{project_id:1});
  expect(current.data.observations).toEqual([]);expect(current.result.value).toBe(10);
  expect(current.data.history.required_sources).toContain('tasks');
  definition.measure={kind:'aggregate',aggregate:'sum',value:{event_count:{field:'event.type',op:'eq',value:'task.changed'}}};
  const events=await calculate(definition,{project_id:1});
  expect(events.data.observations.length).toBeGreaterThan(0);expect(events.result.value).toBe(1);
});

it('a run terminal status never becomes a task workflow milestone and usage is cumulative per run',async()=>{
  await task();
  await db.run("INSERT INTO job_instances(id,tenant_id,agent_id,task_id,status,token_input) VALUES(1,1,1,1,'running',10)");
  await db.run("UPDATE job_instances SET status='failed',runtime_end_success=1,semantic_outcome_missing=1,token_input=20 WHERE id=1");
  await db.run("UPDATE job_instances SET token_input=25 WHERE id=1");
  const milestone=milestoneRecipe({key:'task_failure',name:'Configured task failure',milestone:status('failed')});
  expect((await calculate(milestone,{project_id:1})).result.value).toBe(0);
  const tokens=coreRuntimeRecipes().find(recipe=>recipe.key==='core.input_tokens.v1')!;
  const result=(await calculate(tokens,{project_id:1})).result;
  expect(result.value).toBe(25);expect(result.sample_count).toBe(1);
  const failures=coreRuntimeRecipes().find(recipe=>recipe.key==='core.missing_handoffs.v1')!;
  expect((await calculate(failures,{project_id:1})).result.value).toBe(1);
});

it('taskless run and runtime histories stay in their recorded project after their agent moves',async()=>{
  await db.run("UPDATE agents SET job_instructions='private original instructions' WHERE id=1");
  await db.run("INSERT INTO job_instances(id,tenant_id,agent_id,status,token_input) VALUES(1,1,1,'running',42)");
  await db.run("INSERT INTO runtime_executions(id,tenant_id,instance_id,boundary_json,boundary_fingerprint,runtime_type,driver,backend,execution_target_id,state) VALUES(1,1,1,'{}','original_boundary','openclaw','openclaw','local','test','running')");
  const fingerprints:MetricDefinition={version:1,key:'fingerprints',name:'Instruction fingerprints',grain:'run',time_basis:'current',missing_policy:'exclude_and_report',measure:{kind:'aggregate',aggregate:'distinct_count',value:{field:'instruction_fingerprint'}}};
  const original=await calculate(fingerprints,{project_id:1},{tenantId:1,projectId:1,actor:'former_owner'});
  const oldFingerprint=original.data.entities[0].fields.instruction_fingerprint;
  expect(typeof oldFingerprint).toBe('string');expect(original.result.value).toBe(1);
  await db.run("UPDATE agents SET project_id=3,job_instructions='new project instructions' WHERE id=1");
  const newOwner={tenantId:1,projectId:3,actor:'new_owner'};
  const current=await calculate(fingerprints,{project_id:3},newOwner);
  expect(current.data.entities).toHaveLength(1);expect(current.data.observations).toEqual([]);
  expect(current.data.entities[0].fields.instruction_fingerprint).toBeUndefined();
  expect(current.result.quality).toBe('unavailable');expect(current.result.coverage.missing).toBe(1);
  for(const grain of ['run','runtime_execution'] as const){
    const definition:MetricDefinition={version:1,key:`${grain}_history`,name:'Observed starts',grain,time_basis:'current',missing_policy:'exclude_and_report',measure:{kind:'aggregate',aggregate:'sum',value:{event_count:{field:'event.type',op:'eq',value:grain==='run'?'run.created':'runtime.created'}}}};
    const hidden=await calculate(definition,{project_id:3},newOwner);
    expect(hidden.data.observations).toEqual([]);expect(hidden.data.entities[0].coverage?.complete).toBe(false);
    expect(hidden.result.value).toBeNull();expect(hidden.result.quality).toBe('unavailable');
    const operatorResult=await calculate(definition,{project_id:3});
    expect(operatorResult.result.value).toBe(1);
  }
  const tokens=coreRuntimeRecipes().find(recipe=>recipe.key==='core.input_tokens.v1')!;
  expect((await calculate(tokens,{project_id:3},newOwner)).result.value).toBe(42);
  expect((await calculate(tokens,{project_id:1},{tenantId:1,projectId:1,actor:'former_owner'})).data.entities).toEqual([]);
  await db.run('UPDATE job_instances SET token_input=43 WHERE id=1');
  await db.run("UPDATE runtime_executions SET state='failed' WHERE id=1");
  const later=await calculate(fingerprints,{project_id:3},newOwner);
  expect(later.data.observations.length).toBeGreaterThan(0);
  expect(later.data.observations.every(observation=>observation.context?.project_id===3)).toBe(true);
  expect(JSON.stringify(later.data.observations)).not.toContain(String(oldFingerprint));
});

it('applies recorded corrections instead of counting both the old and corrected outcome',async()=>{
  await task();
  await db.run("INSERT INTO task_history(id,tenant_id,task_id,field,new_value) VALUES(1,1,1,'lifecycle_outcome','rejected')");
  await db.run("UPDATE task_history SET new_value='approved' WHERE id=1");
  const old=milestoneRecipe({key:'old',name:'Old outcome',milestone:{field:'event.outcome',op:'eq',value:'rejected'}});
  const current=milestoneRecipe({key:'new',name:'Corrected outcome',milestone:{field:'event.outcome',op:'eq',value:'approved'}});
  const original=await calculate(old,{project_id:1});
  expect(original.data.observations.some(observation=>observation.supersedes!==undefined)).toBe(true);
  expect(original.result.value).toBe(0);expect((await calculate(current,{project_id:1})).result.value).toBe(1);
});

it('a corrected outcome outside as_of retracts its old occurrence from live historical queries',async()=>{
  await task();
  await db.run("INSERT INTO task_history(id,tenant_id,task_id,field,new_value) VALUES(1,1,1,'lifecycle_outcome','approved')");
  const definition=milestoneRecipe({key:'approved',name:'Approved',milestone:{field:'event.outcome',op:'eq',value:'approved'}});
  const asOf=new Date().toISOString(),future=new Date(Date.parse(asOf)+3600000).toISOString();
  const catalog=await getTelemetryCatalog(db,operator,{project_id:1});
  const query=async()=>{
    await drainTelemetryOutbox(db,{batchSize:1000});
    const data=await loadMetricData(db,operator,{project_id:1},definition,catalog.fields,asOf,1000);
    return {data,result:evaluateMetric({definition,entities:data.entities,observations:data.observations,catalog:catalog.fields,as_of:asOf,filter:data.scopePredicate})};
  };
  const original=await query();expect(original.result.value).toBe(1);
  await db.run('UPDATE task_history SET created_at=? WHERE id=1',future);
  const corrected=await query();
  expect(corrected.data.observations.some(observation=>observation.supersedes!=null&&observation.occurred_at===future)).toBe(true);
  expect(corrected.result.value).toBe(0);expect(corrected.data.dataRevision).not.toBe(original.data.dataRevision);
});

it('does not fabricate event actors or outcome-producing agents from the currently active agent',async()=>{
  await task();await db.run('UPDATE tasks SET agent_id=1 WHERE id=1');
  await db.run("INSERT INTO task_history(tenant_id,task_id,field,new_value) VALUES(1,1,'lifecycle_outcome','approved')");
  const definition=milestoneRecipe({key:'approved',name:'Approved',milestone:{field:'event.outcome',op:'eq',value:'approved'}});
  definition.attribution='event_actor';definition.group_by=[{field:'agent_id'}];
  const {result}=await calculate(definition,{project_id:1});
  expect(result.groups[0].key).toEqual([null]);
});

it('requires coverage for the selected runtime producer before proving no runtime failure',async()=>{
  await task();await db.run("UPDATE tasks SET status='approved' WHERE id=1");
  const definition=firstPassRecipe({key:'first',name:'First',start:created,success:status('approved'),rework:{field:'event.type',op:'eq',value:'runtime.failed'}});
  expect(requiredMetricSources(definition)).toEqual(expect.arrayContaining(['tasks','runtime_executions']));
  await db.exec('ALTER TABLE runtime_executions DISABLE TRIGGER telemetry_capture');
  try{
    const {data,result}=await calculate(definition,{project_id:1});
    expect(data.entities[0].coverage?.complete).toBe(false);
    expect(result.value).toBeNull();expect(result.coverage.unknown).toBe(1);
  }finally{await db.exec('ALTER TABLE runtime_executions ENABLE TRIGGER telemetry_capture');}
});

it('a dependency outside readable scope produces unknown rather than a false zero count',async()=>{
  await task(1);await task(3,3);await task(2,2,2);
  await db.run('INSERT INTO task_dependencies(blocker_id,blocked_id) VALUES(3,1)');
  const definition=blockedSnapshotRecipe({key:'blocked',name:'Blocked',blocked:{field:'unresolved_dependencies',op:'gt',value:0}});
  const scoped=await calculate(definition,{project_id:1},{tenantId:1,projectId:1,actor:'scoped'});
  expect(scoped.result.value).toBeNull();expect(scoped.result.coverage.unknown).toBe(1);
  expect((await calculate(definition,{project_id:1})).result.value).toBe(1);
  await db.run('DELETE FROM task_dependencies WHERE blocked_id=1');
  await db.run('INSERT INTO task_dependencies(blocker_id,blocked_id) VALUES(2,1)');
  expect((await calculate(definition,{project_id:1})).result.value).toBeNull();
});

it('retains closed workflows by default and rejects implicit task-value multiplication across runs',async()=>{
  await task();await db.run("UPDATE tasks SET status='submitted' WHERE id=1");await db.run("UPDATE sprints SET status='closed' WHERE id=1");
  const definition=milestoneRecipe({key:'submitted',name:'Submitted',milestone:status('submitted')});
  expect((await calculate(definition,{project_id:1})).result.value).toBe(1);
  expect((await calculate(definition,{project_id:1,include_archived:false})).result.value).toBe(0);
  const catalog=await getTelemetryCatalog(db,operator,{project_id:1,workflow_type:'article'});
  const value=numericRecipe({key:'amount',name:'Amount',field:catalog.fields.find(field=>field.key==='amount')!.id});value.grain='run';
  await expect(calculate(value,{project_id:1,workflow_type:'article'})).rejects.toThrow(/allocation/);
});

it('metadata entity counts do not expand over related task populations',async()=>{
  await task();
  const definition:MetricDefinition={version:1,key:'projects',name:'Projects',grain:'project',time_basis:'current',missing_policy:'exclude_and_report',measure:{kind:'aggregate',aggregate:'count'}};
  const {data,result}=await calculate(definition);
  expect(data.taskIds).toEqual([]);expect(result.value).toBe(2);
});
