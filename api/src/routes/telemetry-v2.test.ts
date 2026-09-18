import express from 'express';
import type {Server} from 'http';
import type {AddressInfo} from 'net';
import type {Db} from '../db/adapter/types';
import {setupTestDb,teardownTestDb} from '../db/testDb';
import {seedTelemetryScenario} from '../domains/telemetry/testScenario';
import {numericRecipe,firstPassRecipe,milestoneRecipe,coreRuntimeRecipes} from '../domains/telemetry/recipes';
import {runTelemetryQueryJobs} from '../domains/telemetry/queries';
import {winningBinding} from '../domains/telemetry/definitions';
import {calendarBucket} from '../domains/telemetry/evaluator';
let db:Db;
jest.mock('../db/client',()=>({getDb:()=>db}));
import router from './telemetry-v2';
let server:Server,base:string;
beforeAll(async()=>{
  const app=express();app.use(express.json({limit:'10mb'}));

  app.use((req,_res,next)=>{if(req.headers['x-test-project'])req.telemetryProjectId=Number(req.headers['x-test-project']);next();});
  app.use('/api/v1/telemetry/v2',router);
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address()as AddressInfo).port}/api/v1/telemetry/v2`;
});
beforeEach(async()=>{db=await setupTestDb();await seedTelemetryScenario(db);});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await teardownTestDb();});
async function request(path:string,body?:any,options:{method?:string;project?:number}={}){
  const response=await fetch(base+path,{method:options.method??(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json',...(options.project?{'x-test-project':String(options.project)}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json()as any};
}
async function amount(scope={project_id:11}){
  const catalog=(await request(`/catalog?project_id=${scope.project_id}`)).body;
  const field=catalog.fields.find((field:any)=>field.key==='amount');
  expect(field).toBeDefined();return numericRecipe({key:'amount',name:'Proposal amount',field:field.id});
}

test('entry attribution is rejected consistently by validation, preview, and save',async()=>{
  const definition={...await amount(),attribution:'assigned_agent_at_entry'};
  for(const path of ['/definitions/validate','/queries/preview']){
    const response=await request(path,{definition,scope:{project_id:11}});
    expect(response.status).toBe(400);expect(JSON.stringify(response.body)).toContain('defined entry');
  }
  expect((await request('/metrics',{key:'invalid_entry',name:'Invalid entry',scope:{project_id:11},definition})).status).toBe(400);
});
test('saved views and dashboard widgets preserve pins and filter contributor groups before pagination',async()=>{
  const metric=await saveMetric({...await amount(),attribution:'assigned_agent_current'});
  const widget={id:'agent_view',metric_id:metric.id,metric_revision_id:metric.latest_revision_id,title:'By agent',display:'bar',view:{group_by:[{field:'agent_id'}],bucket:null,sort:'value_desc'},layout:{width:6,height:'regular'}};
  const view=await request('/reports',{key:'agent_view',name:'By agent',scope:{project_id:11},definition:{presentation:'view',metrics:[widget]}});
  expect(view.status).toBe(201);expect(view.body.definition.metrics[0]).toEqual(widget);
  const dashboard=await request('/reports',{key:'agent_dashboard',name:'Team',scope:{project_id:11},definition:{presentation:'dashboard',from:'2026-01-01T00:00:00Z',metrics:[widget,{...widget,id:'filtered',view:{...widget.view,filter:{field:'id',op:'eq',value:1002}},display:'table'}]}});
  expect(dashboard.status).toBe(201);
  const result=await request('/queries',{report_revision_id:dashboard.body.latest_revision_id});
  expect(result.status).toBe(200);expect(result.body.results.map((item:any)=>item.value)).toEqual([210,20]);
  expect(result.body.results[0].groups[0].key).toEqual([101]);
  const group=encodeURIComponent(JSON.stringify([101]));
  const proof=await request(`/queries/${result.body.query_id}/contributors?metric_index=1&metric_revision_id=${metric.latest_revision_id}&included=true&group=${group}&limit=1`);
  expect(proof.body.total).toBe(1);expect(proof.body.contributors[0].entity_id).toBe(1002);
  const absent=await request(`/queries/${result.body.query_id}/contributors?metric_index=0&included=true&group=${encodeURIComponent('[null]')}`);
  expect(absent.body.total).toBe(0);
  const restricted=await request('/queries',{report_revision_id:dashboard.body.latest_revision_id,filter:{field:'id',op:'eq',value:1001}});
  expect(restricted.body.results.map((item:any)=>item.value)).toEqual([10,null]);
  await request(`/metrics/${metric.id}`,undefined,{method:'DELETE'});
  expect((await request('/queries',{report_revision_id:dashboard.body.latest_revision_id})).status).toBe(200);
});
test('views reject fabricated snapshot trends, duplicate widget IDs, and conflicting scope',async()=>{
  const metric=await saveMetric(await amount());
  const widget={id:'one',metric_id:metric.id,metric_revision_id:metric.latest_revision_id,display:'line',view:{bucket:'day'}};
  const save=(metrics:any[])=>request('/reports',{key:'bad_view',name:'Bad view',scope:{project_id:11},definition:{presentation:'dashboard',metrics}});
  expect((await save([widget])).status).toBe(400);
  expect((await save([{...widget,display:'table',view:{}},{...widget,display:'table',view:{}}])).status).toBe(400);
  expect((await save([{...widget,display:'table',view:{scope:{project_id:12}}}])).status).toBe(400);
});
test('archive filters intersect with saved view scopes instead of broadening or conflicting',async()=>{
  const metric=await saveMetric(await amount(),{project_id:11,include_archived:true});
  await db.run("UPDATE workflows SET status='closed' WHERE id=111");
  const result=await request('/queries',{metric_revision_id:metric.latest_revision_id,scope:{project_id:11,include_archived:false}});
  expect(result.status).toBe(200);expect(result.body.coverage.total).toBe(0);
});
test('a saved historical view preserves its own bucket timezone inside a dashboard',async()=>{
  const metric=await saveMetric(milestoneRecipe({key:'created',name:'Created',milestone:{field:'event.type',op:'eq',value:'task.created'}}));
  const widget={id:'created',metric_revision_id:metric.latest_revision_id,display:'line',view:{bucket:'hour',timezone:'America/New_York'}};
  const saved=await request('/reports',{key:'local_time',name:'Local time',scope:{project_id:11},definition:{presentation:'dashboard',timezone:'UTC',metrics:[widget]}});
  expect(saved.status).toBe(201);expect(saved.body.definition.metrics[0].metric_id).toBe(metric.id);
  const response=await request('/queries',{report_revision_id:saved.body.latest_revision_id});
  expect(response.status).toBe(200);expect(response.body.results[0].groups[0].key[0]).toBe(calendarBucket(response.body.as_of,'hour','America/New_York'));
  const invalid=await request('/reports',{key:'bad_timezone',name:'Bad zone',scope:{project_id:11},definition:{presentation:'view',metrics:[{...widget,view:{...widget.view,timezone:'Nowhere'}}]}});
  expect(invalid.status).toBe(400);
});
async function saveMetric(definition?:any,scope:any={project_id:11}){
  const actual=definition??await amount(scope);
  const saved=await request('/metrics',{key:actual.key,name:actual.name,scope,definition:actual});expect(saved.status).toBe(201);return saved.body;
}
const firstPass=()=>firstPassRecipe({key:'first_pass',name:'First-pass approval',start:{field:'event.type',op:'eq',value:'task.created'},success:{field:'event.to_status',op:'eq',value:'approved'},rework:{field:'event.outcome',op:'eq',value:'changes_requested'},unsuccessful:{field:'event.to_status',op:'eq',value:'rejected'},cancelled:{field:'event.to_status',op:'eq',value:'cancelled'}});

test('catalog uses authorized canonical fields and has no fabricated business metrics',async()=>{
  const result=await request('/catalog?project_id=11');expect(result.status).toBe(200);
  expect(result.body.definition_contract.version).toBe(1);
  expect(result.body.definition_contract.schemas.metric.properties).toHaveProperty('population');
  expect(result.body.definition_contract.examples).toHaveProperty('first_pass_by_entry_agent');
  expect(result.body.fields.map((field:any)=>field.key)).toContain('amount');
  expect(result.body.fields.map((field:any)=>field.key)).not.toContain('private_amount');
  expect(result.body.core_metrics.every((metric:any)=>metric.key.startsWith('core.'))).toBe(true);
  expect((await request('/catalog?project_id=22')).status).toBe(404);
});

test('freezing with an expected report revision rejects mismatches without creating a snapshot',async()=>{
  const metric=await saveMetric();
  const report=(await request('/reports',{key:'revision_guard',name:'Revision guard',scope:{project_id:11},definition:{metrics:[{metric_revision_id:metric.latest_revision_id}]}})).body;
  const query=(await request('/queries',{report_revision_id:report.latest_revision_id})).body;
  const mismatched=await request(`/reports/${report.id}/snapshots`,{query_id:query.query_id,report_revision_id:'different-revision'});
  expect(mismatched.status).toBe(400);
  expect(mismatched.body.error).toContain('different report revision');
  expect(await db.value('SELECT snapshot FROM telemetry_query_results WHERE id=?',query.query_id)).toBe(false);
  const matched=await request(`/reports/${report.id}/snapshots`,{query_id:query.query_id,report_revision_id:report.latest_revision_id});
  expect(matched.status).toBe(201);
  expect(matched.body).toMatchObject({snapshot:true,report_revision_id:report.latest_revision_id});
});
test.each([
  {project_id:11,workflow_type:'content'},
  {project_id:11,workflow_id:111,workflow_type:'content',task_type:'article'},
])('workflow-scoped previews survive production alias middleware: %j',async(scope)=>{
  const definition=await amount();
  const preview=await request('/queries/preview',{definition,scope});
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({value:210,sample_count:6});
  expect((await request('/definitions/validate',{definition,scope})).status).toBe(200);
});
test('catalog preserves workflow query filters through production alias middleware',async()=>{
  const selected=await request('/catalog?project_id=11&workflow_id=111&workflow_type=content');
  expect(selected.status).toBe(200);
  expect(selected.body.scope).toMatchObject({project_id:11,workflow_id:111,workflow_type:'content'});
  expect(selected.body.workflows.map((workflow:any)=>workflow.id)).toEqual([111]);
  expect((await request('/catalog?project_id=11&workflow_type=missing')).status).toBe(404);
  expect((await request('/catalog?project_id=11&workflow_id=112')).status).toBe(404);
});
test('current numeric aggregate and retained contributors agree after values change',async()=>{
  const definition=await amount();const preview=await request('/queries/preview',{definition,scope:{project_id:11}});
  expect(preview.status).toBe(200);expect(preview.body.value).toBe(210);expect(preview.body.sample_count).toBe(6);
  expect(preview.body.contributors).toBeUndefined();
  await db.run(`UPDATE tasks SET custom_fields_json='{"amount":1000}' WHERE id=1001`);
  const proof=await request(`/queries/${preview.body.query_id}/contributors`);
  expect(proof.status).toBe(200);expect(proof.body.total).toBe(6);
  expect(proof.body.contributors.reduce((sum:number,row:any)=>sum+Number(row.value),0)).toBe(210);
  expect((await request(`/queries/${preview.body.query_id}`)).body.value).toBe(210);
  expect((await request('/queries/preview',{definition,scope:{project_id:11}})).body.value).toBe(1200);
});
test('all global filters narrow the same numerator denominator and proof',async()=>{
  const definition=await amount();const filter={field:'id',op:'in',value:[1001,1002]};
  const result=await request('/queries/preview',{definition,filter,scope:{project_id:11}});
  expect(result.status).toBe(200);expect(result.body.value).toBe(30);
  const proof=await request(`/queries/${result.body.query_id}/contributors?included=true`);
  expect(proof.body.contributors.map((item:any)=>item.entity_id)).toEqual([1001,1002]);
  const approved=await request('/queries/preview',{definition,filter:{field:'status',op:'eq',value:'approved'},scope:{project_id:11}});
  expect(approved.status).toBe(200);expect(approved.body.value).toBe(60);
  expect((await request(`/queries/${approved.body.query_id}/contributors?included=true`)).body.contributors.map((item:any)=>item.entity_id)).toEqual([1001,1002,1003]);
});
test('title regex survives metric and report saves and filters retained contributors',async()=>{
  const definition={...await amount(),population:{field:'title',op:'matches_regex',value:'^[ab] —',flags:'i'}};
  const scope={project_id:11,workflow_type:'content',workflow_id:111};
  const preview=await request('/queries/preview',{definition,scope});
  expect(preview.status).toBe(200);expect(preview.body).toMatchObject({value:30,sample_count:2});
  const proof=await request(`/queries/${preview.body.query_id}/contributors?included=true`);
  expect(proof.body.contributors.map((row:any)=>row.entity_id)).toEqual([1001,1002]);
  const metric=await saveMetric(definition,scope);
  expect(metric.definition.population).toEqual(definition.population);
  const report=await request('/reports',{key:'regex_report',name:'Matching titles',scope,definition:{scope,metrics:[{metric_id:metric.id,metric_revision_id:metric.latest_revision_id}]}});
  expect(report.status).toBe(201);
  const result=await request('/queries',{report_revision_id:report.body.latest_revision_id});
  expect(result.status).toBe(200);expect(result.body.results[0].value).toBe(30);
  const invalid=await request('/queries/preview',{definition:{...definition,population:{...definition.population,value:'['}},scope});
  expect(invalid.status).toBe(400);expect(invalid.body.error).toContain('Invalid regex');
});
test('six-task configurable first pass is 2/4 and runtime opt-in is 1/4',async()=>{
  const definition=firstPass();const result=await request('/queries/preview',{definition,scope:{project_id:11}});
  expect(result.status).toBe(200);expect(result.body).toMatchObject({numerator:2,denominator:4,value:.5});
  expect(result.body.coverage).toMatchObject({pending:1,cancelled:1});
  definition.journey!.rework={any:[definition.journey!.rework!,{field:'event.type',op:'eq',value:'runtime.failed'}]};
  const changed=await request('/queries/preview',{definition,scope:{project_id:11}});expect(changed.body).toMatchObject({numerator:1,denominator:4,value:.25});
  definition.journey!.rework={any:[{field:'event.outcome',op:'eq',value:'changes_requested'},{field:'event.type',op:'eq',value:'run.failed'}]};
  expect((await request('/queries/preview',{definition,scope:{project_id:11}})).body).toMatchObject({numerator:1,denominator:4,value:.25});
});
test('selected milestone is configuration and closed workflows stay in history',async()=>{
  const definition=milestoneRecipe({key:'submitted',name:'Submissions',milestone:{field:'event.to_status',op:'eq',value:'submitted'}});
  expect((await request('/queries/preview',{definition,scope:{project_id:12}})).body.value).toBe(1);
  await db.run("UPDATE workflows SET status='closed' WHERE id=112");
  expect((await request('/queries/preview',{definition,scope:{project_id:12}})).body.value).toBe(1);
});
test('revisions are optimistic and reports preserve their pinned definition',async()=>{
  const metric=await saveMetric();const report=await request('/reports',{key:'report',name:'Report',scope:{project_id:11},definition:{metrics:[{metric_id:metric.id,metric_revision_id:metric.latest_revision_id}],scope:{project_id:11}}});expect(report.status).toBe(201);
  const changed={...metric.definition,measure:{kind:'aggregate',aggregate:'count'}};
  const revision=await request(`/metrics/${metric.id}/revisions`,{definition:changed,expected_revision_id:metric.latest_revision_id});expect(revision.status).toBe(201);
  expect((await request(`/metrics/${metric.id}/revisions`,{definition:changed,expected_revision_id:metric.latest_revision_id})).status).toBe(409);
  const result=await request('/queries',{report_revision_id:report.body.latest_revision_id});expect(result.status).toBe(200);expect(result.body.results[0].value).toBe(210);
  const frozen=await request(`/reports/${report.body.id}/snapshots`,{query_id:result.body.query_id});expect(frozen.status).toBe(201);
  expect((await request(`/reports/${report.body.id}/snapshots`)).body.snapshots).toHaveLength(1);
});
test('binding override disable and optimistic version work through the API',async()=>{
  const metric=await saveMetric();
  const saved=await request('/bindings',{family_key:'value',scope:{project_id:11},metric_revision_id:metric.latest_revision_id},{method:'PUT'});expect(saved.status).toBe(200);
  expect((await request('/queries',{family_key:'value',scope:{project_id:11}})).body.results[0].value).toBe(210);
  const disabled=await request('/bindings',{family_key:'value',scope:{project_id:11,workflow_id:111},disabled:true},{method:'PUT'});expect(disabled.status).toBe(200);
  const result=await request('/queries',{family_key:'value',scope:{project_id:11}});expect(result.body).toMatchObject({results:[],disabled:6});
  expect((await request('/bindings',{family_key:'value',scope:{project_id:11},disabled:true},{method:'PUT'})).status).toBe(409);
});
test('all eight precedence levels resolve and disabled binding is not skipped',()=>{
  const context={project_id:11,workflow_id:111,workflow_type:'content',task_type:'article'};
  const scopes=[{}, {project_id:11}, {workflow_type:'content'}, {workflow_type:'content',task_type:'article'}, {project_id:11,workflow_type:'content'}, {project_id:11,workflow_type:'content',task_type:'article'}, {project_id:11,workflow_id:111,workflow_type:'content'},context];
  const bindings=scopes.map((scope,index)=>({family_key:'test',id:String(index),scope,disabled:index===7}));
  for(let count=1;count<=8;count++)expect(winningBinding(bindings.slice(0,count),'test',context).id).toBe(String(count-1));
  expect(winningBinding(bindings,'test',context).disabled).toBe(true);
});
test('binding preview explains inherited exact shadowed and deeper meanings without saving',async()=>{
  const metric=await saveMetric();
  const broad=(await request('/bindings',{family_key:'value',scope:{project_id:11},metric_revision_id:metric.latest_revision_id},{method:'PUT'})).body.binding;
  const narrow=(await request('/bindings',{family_key:'value',scope:{workflow_id:111},disabled:true},{method:'PUT'})).body.binding;
  const context={project_id:11,workflow_type:'content'};
  const preview=await request('/bindings/preview',{family_key:'value',scope:context,override:{metric_revision_id:metric.latest_revision_id,disabled:false}});
  expect(preview.status).toBe(200);
  expect(preview.body.current).toMatchObject({origin:'inherited',winner:{id:broad.id},shadowed:[],narrower:[{id:narrow.id}]});
  expect(preview.body.proposed).toMatchObject({origin:'exact',winner:{id:'proposed'},shadowed:[{id:broad.id}],narrower:[{id:narrow.id}]});
  expect(preview.body.effect).toBe('create');
  expect(Number(await db.value('SELECT count(*) FROM telemetry_metric_bindings'))).toBe(2);
  const disabled=await request('/bindings/preview',{family_key:'value',scope:{workflow_id:111},override:{disabled:true}});
  expect(disabled.body).toMatchObject({effect:'unchanged',scope:{project_id:11,workflow_id:111,workflow_type:'content'},current:{origin:'exact',winner:{disabled:true},shadowed:[{id:broad.id}]} });
  const unbound=await request('/bindings/preview',{family_key:'absent',scope:{project_id:11}});
  expect(unbound.body.current).toEqual({origin:'unbound',winner:null,shadowed:[],narrower:[]});
  expect((await request('/bindings/preview',{family_key:'value',scope:{project_id:12}},{project:11})).status).toBe(403);
  const other=await saveMetric(await amount({project_id:12}),{project_id:12});
  expect((await request('/bindings/preview',{family_key:'value',scope:{project_id:11},override:{metric_revision_id:other.latest_revision_id}},{project:11})).status).toBe(404);
});
test('scoped access cannot widen catalog query resources or stored proofs',async()=>{
  const other=await saveMetric(await amount({project_id:12}),{project_id:12});
  expect((await request(`/metrics/${other.id}`,undefined,{project:11})).status).toBe(404);
  expect((await request('/queries',{metric_revision_id:other.latest_revision_id},{project:11})).status).toBe(404);
  expect((await request('/catalog?project_id=12',undefined,{project:11})).status).toBe(403);
  const result=await request('/queries',{definition:await amount(),scope:{project_id:11}},{project:11});expect(result.status).toBe(200);
  expect((await request(`/queries/${result.body.query_id}/contributors`,undefined,{project:12})).status).toBe(404);
  await db.run('UPDATE tasks SET project_id=12,workflow_id=112 WHERE id=1001');
  expect((await request(`/queries/${result.body.query_id}`,undefined,{project:11})).status).toBe(409);
});
test('unsafe unknown fields and unbounded formulas fail without SQL execution',async()=>{
  const result=await request('/queries/preview',{definition:numericRecipe({key:'unsafe',name:'Unsafe',field:"x'); SELECT pg_sleep(10); --"}),scope:{project_id:11}});
  expect(result.status).toBe(400);expect(result.body.code).toBe('invalid_definition');
  expect(Number(await db.value('SELECT count(*) FROM tasks'))).toBe(8);
});
test('public time inputs require offsets and current inventory never pretends to be historical',async()=>{
  const definition=await amount();
  expect((await request('/queries',{definition,scope:{project_id:11},as_of:'2026-09-01T10:00:00'})).status).toBe(400);
  expect((await request('/queries',{definition,scope:{project_id:11},as_of:'2026-09-01T10:00:00Z'})).body.code).toBe('unsupported_operation');
  expect((await request('/queries',{definition,scope:{project_id:11},from:'2026-09-01T10:00:00Z'})).status).toBe(400);
});
test('empty denominators return null with coverage, never a fabricated zero',async()=>{
  const definition=firstPass();definition.population={field:'id',op:'eq',value:-1};
  const result=await request('/queries',{definition,scope:{project_id:11}});expect(result.body.value).toBeNull();expect(result.body.denominator).toBe(0);
});
test('runtime failures use actual execution facts and token snapshots are not summed repeatedly',async()=>{
  const failure=coreRuntimeRecipes().find(recipe=>recipe.key==='core.runtime_failures.v1')!;
  expect((await request('/queries',{definition:failure,scope:{project_id:11}})).body.value).toBe(1);
  await db.run('UPDATE job_instances SET token_input=10 WHERE id=501');await db.run('UPDATE job_instances SET token_input=20 WHERE id=501');
  const tokens=coreRuntimeRecipes().find(recipe=>recipe.key==='core.input_tokens.v1')!;
  expect((await request('/queries',{definition:tokens,scope:{project_id:11}})).body.value).toBe(20);
});
test('background evaluations run from pinned plans, support cancellation and recover expired claims',async()=>{
  const metric=await saveMetric();const queued=await request('/queries',{metric_revision_id:metric.latest_revision_id,background:true});expect(queued.status).toBe(202);
  await runTelemetryQueryJobs(db);expect((await request(`/queries/${queued.body.query_id}`)).body.value).toBe(210);
  const cancel=await request('/queries',{metric_revision_id:metric.latest_revision_id,background:true});
  expect((await request(`/queries/${cancel.body.query_id}`,undefined,{method:'DELETE'})).body.cancelled).toBe(true);
  const retry=await request('/queries',{metric_revision_id:metric.latest_revision_id,background:true});
  await db.run("UPDATE telemetry_query_results SET state='running',lease_until=clock_timestamp()-interval '1 second' WHERE id=?",retry.body.query_id);
  await runTelemetryQueryJobs(db);expect((await request(`/queries/${retry.body.query_id}`)).body.state).toBe('complete');
});
test('expired and deleted-source proofs are unavailable',async()=>{
  const first=await request('/queries',{definition:await amount(),scope:{project_id:11}});
  await db.run("UPDATE telemetry_query_results SET expires_at=clock_timestamp()-interval '1 second' WHERE id=?",first.body.query_id);
  expect((await request(`/queries/${first.body.query_id}`)).status).toBe(410);
  const next=await request('/queries',{definition:await amount(),scope:{project_id:11}});await db.run('DELETE FROM tasks WHERE id=1006');
  expect((await request(`/queries/${next.body.query_id}`)).status).toBe(404);
});
test('definitions export/import remaps identities and preserves runnable formulas',async()=>{
  const metric=await saveMetric();const bundle=await request('/export',{scope:{project_id:11},metric_ids:[metric.id]});expect(bundle.status).toBe(200);
  const imported=await request('/import',{bundle:bundle.body,scope:{project_id:12},reference_map:{}});expect(imported.status).toBe(201);expect(imported.body.drafts).toBe(0);
  const copied=imported.body.imported[0];expect(copied.id).not.toBe(metric.id);
  expect((await request('/queries',{metric_revision_id:copied.latest_revision_id})).body.value).toBe(100);
});
test('unmapped fields import as drafts and cannot be queried or activated',async()=>{
  const metric=await saveMetric(),bundle=(await request('/export',{scope:{project_id:11},metric_ids:[metric.id]})).body;
  bundle.catalog[0].key='nonexistent';bundle.catalog[0].id='missing_field';bundle.resources[0].revisions[0].definition.measure.value.field='missing_field';
  const imported=await request('/import',{bundle,scope:{project_id:12},reference_map:{}});expect(imported.status).toBe(201);expect(imported.body.drafts).toBe(1);
  expect((await request('/queries',{metric_revision_id:imported.body.imported[0].latest_revision_id})).status).toBe(400);
});
test('profile references are pinned and aggregate component references enforce ownership',async()=>{
  const profile=await request('/profiles',{key:'signals',name:'Signals',scope:{project_id:11},definition:{signals:{success:{field:'event.to_status',op:'eq',value:'approved'}}}});expect(profile.status).toBe(201);
  const definition:any=milestoneRecipe({key:'profile_count',name:'Profile count',milestone:{field:'event.to_status',op:'eq',value:'approved'}});
  definition.measure.where={signal_ref:'profile.success'};
  const saved=await request('/metrics',{key:definition.key,name:definition.name,scope:{project_id:11},definition,profile_revision_id:profile.body.latest_revision_id});expect(saved.status).toBe(201);
  expect((await request('/queries',{metric_revision_id:saved.body.latest_revision_id})).body.value).toBe(3);
  const other=await saveMetric(await amount({project_id:12}),{project_id:12});
  const component:any={...await amount(),measure:{metric_ref:other.latest_revision_id}};
  expect((await request('/metrics',{key:'foreign',name:'Foreign component',scope:{project_id:11},definition:component},{project:11})).status).toBe(404);
});

test('tenant-default definitions cannot expose another project through pinned dependencies',async()=>{
  await db.exec(`INSERT INTO workflow_types(tenant_id,key,name,project_id) VALUES(1,'private_copy','Private project type',12);
    INSERT INTO task_field_schemas(tenant_id,workflow_type_key,schema_json) VALUES(1,'private_copy','{"fields":[{"key":"secret_amount","label":"Private amount","type":"number"}]}');`);
  const catalog=(await request('/catalog')).body;const secret=catalog.fields.find((field:any)=>field.key==='secret_amount');
  const metric=await saveMetric(numericRecipe({key:'private_default',name:'Private default',field:secret.id}),{});
  expect((await request(`/metrics/${metric.id}`,undefined,{project:11})).status).toBe(404);
  expect((await request('/queries',{metric_revision_id:metric.latest_revision_id},{project:11})).status).toBe(404);
  const listed=(await request('/metrics',undefined,{project:11})).body.metrics;expect(listed.some((row:any)=>row.id===metric.id)).toBe(false);
  const safe={...metric.definition,measure:{kind:'aggregate',aggregate:'count'}};
  const revised=await request(`/metrics/${metric.id}/revisions`,{definition:safe,expected_revision_id:metric.latest_revision_id});expect(revised.status).toBe(201);
  expect((await request('/metrics',undefined,{project:11})).body.metrics.some((row:any)=>row.id===metric.id)).toBe(true);
  expect((await request(`/metrics/${metric.id}`,undefined,{project:11})).status).toBe(404);
  expect((await request('/export',{metric_ids:[metric.id]},{project:11})).status).toBe(404);
});

test('project-wide imports preserve workflow overrides with explicit destination mappings',async()=>{
  const definition=await amount();const metric=await saveMetric(definition,{project_id:11,workflow_id:111});
  expect((await request('/bindings',{family_key:'workflow_amount',scope:{workflow_id:111},metric_revision_id:metric.latest_revision_id},{method:'PUT'})).status).toBe(200);
  const bundle=(await request('/export',{scope:{project_id:11},metric_ids:[metric.id]})).body;
  const imported=await request('/import',{bundle,scope:{project_id:12},reference_map:{'workflow:111':'112'}});
  expect(imported.status).toBe(201);expect(imported.body.drafts).toBe(0);expect(imported.body.imported[0].scope).toMatchObject({project_id:12,workflow_id:112,workflow_type:'content'});
  expect((await request('/queries',{family_key:'workflow_amount',scope:{project_id:12}})).body.results[0].value).toBe(100);
});

test('comparison rejects mismatched denominator aggregation and overlapping samples',async()=>{
  const first=firstPass();first.comparison_contract={key:'approval',semantic_version:'1'};
  const metric=await saveMetric(first);
  const report={metrics:[{metric_revision_id:metric.latest_revision_id},{metric_revision_id:metric.latest_revision_id}],scope:{project_id:11},comparison:{compatible:true,key:'approval',semantic_version:'1'}};
  const saved=await request('/reports',{key:'comparison',name:'Comparison',scope:{project_id:11},definition:report});expect(saved.status).toBe(201);
  const result=await request('/queries',{report_revision_id:saved.body.latest_revision_id});expect(result.status).toBe(400);expect(result.body.code).toBe('incompatible_comparison');
});

test('identical pinned background requests deduplicate but changed evidence does not',async()=>{
  const metric=await saveMetric();const input={metric_revision_id:metric.latest_revision_id,background:true,as_of:new Date().toISOString()};
  const first=await request('/queries',input),second=await request('/queries',input);
  expect(first.status).toBe(202);expect(second.body).toMatchObject({query_id:first.body.query_id,deduplicated:true});
  await db.run(`UPDATE tasks SET custom_fields_json='{"amount":1000}' WHERE id=1001`);
  const changed=await request('/queries',input);expect(changed.body.query_id).not.toBe(first.body.query_id);
});

test('re-freezing a report is idempotent while the snapshot limit remains enforced',async()=>{
  const metric=await saveMetric();const report=(await request('/reports',{key:'limited',name:'Limited',scope:{project_id:11},definition:{metrics:[{metric_revision_id:metric.latest_revision_id}]}})).body;
  expect((await request('/settings',{max_snapshots:1},{method:'PUT'})).status).toBe(200);
  const query=(await request('/queries',{report_revision_id:report.latest_revision_id})).body;
  expect((await request(`/reports/${report.id}/snapshots`,{query_id:query.query_id})).status).toBe(201);
  expect((await request(`/reports/${report.id}/snapshots`,{query_id:query.query_id})).status).toBe(201);
  const another=(await request('/queries',{report_revision_id:report.latest_revision_id})).body;
  expect((await request(`/reports/${report.id}/snapshots`,{query_id:another.query_id})).body.code).toBe('query_limit_exceeded');
});

test('project export preserves disabled workflow overrides and backfills validate bounded input',async()=>{
  await saveMetric();
  await request('/bindings',{family_key:'disabled_value',scope:{workflow_id:111},disabled:true},{method:'PUT'});
  const bundle=(await request('/export',{scope:{project_id:11}})).body;
  expect(bundle.bindings).toContainEqual(expect.objectContaining({family_key:'disabled_value',disabled:true}));
  const imported=await request('/import',{bundle,scope:{project_id:12},reference_map:{'workflow:111':'112'}});
  expect(imported.status).toBe(201);expect(imported.body.bindings).toContainEqual(expect.objectContaining({family_key:'disabled_value',disabled:true}));
  expect((await request('/backfills',{batch_size:'NaN'})).status).toBe(400);
});

test('interactive population limits offer a working bounded background calculation',async()=>{
  await db.run(`INSERT INTO tasks(tenant_id,title,workflow_id,project_id,status,task_type,custom_fields_json)
    SELECT 1,'Budget sample '||n,111,11,'draft','article','{"amount":1}' FROM generate_series(1,101) n`);
  expect((await request('/settings',{interactive_entities:100},{method:'PUT'})).status).toBe(200);
  const definition=await amount();
  const rejected=await request('/queries',{definition,scope:{project_id:11}});
  expect(rejected.status).toBe(413);expect(rejected.body.code).toBe('query_limit_exceeded');
  const queued=await request('/queries',{definition,scope:{project_id:11},background:true});expect(queued.status).toBe(202);
  await runTelemetryQueryJobs(db);
  expect((await request(`/queries/${queued.body.query_id}`)).body).toMatchObject({state:'complete',value:311,sample_count:107});
});

test('missing capture and uncovered time windows never turn empty history into an ordinary zero',async()=>{
  const definition=milestoneRecipe({key:'unseen',name:'Unseen milestone',milestone:{field:'event.to_status',op:'eq',value:'not_reached'}});
  const from=new Date(Date.now()-7*86400000).toISOString();
  const uncovered=await request('/queries',{definition,scope:{project_id:11},from});
  expect(uncovered.body).toMatchObject({value:null,quality:'unavailable',history:{interval_complete:false}});
  const observed=milestoneRecipe({key:'seen',name:'Observed milestones',milestone:{field:'event.to_status',op:'eq',value:'approved'}});
  const partial=await request('/queries',{definition:observed,scope:{project_id:11},from});
  expect(partial.body).toMatchObject({value:3,quality:'partial',history:{interval_complete:false}});
  await db.exec('ALTER TABLE tasks DISABLE TRIGGER telemetry_capture');
  try{
    const unavailable=await request('/queries',{definition,scope:{project_id:11}});
    expect(unavailable.body).toMatchObject({value:null,quality:'unavailable'});
    expect(unavailable.body.warnings.join(' ')).toContain('missing observations');
  }finally{await db.exec('ALTER TABLE tasks ENABLE TRIGGER telemetry_capture');}
});
