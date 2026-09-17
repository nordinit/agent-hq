import type {Db} from '../../db/adapter/types';
import {setupTestDb,teardownTestDb} from '../../db/testDb';
import {createDefinition,getDefinition} from './definitions';
import {getTelemetryCatalog} from './catalog';
import {exportTelemetry,importTelemetry} from './portability';
import {milestoneRecipe,numericRecipe} from './recipes';
import type {MetricDefinition,Predicate} from './contracts';

let db:Db;
const access={tenantId:1,projectId:null,actor:'portability_test'};
const source={project_id:1,workflow_type:'source'},target={project_id:2,workflow_type:'target'};
const schema=JSON.stringify({fields:[{key:'amount',label:'Amount',type:'number'}]});
beforeEach(async()=>{
  db=await setupTestDb();
  await db.exec(`INSERT INTO tenants(id,name,slug) VALUES(1,'One','one');
    INSERT INTO projects(id,tenant_id,name) VALUES(1,1,'Source'),(2,1,'Destination');
    INSERT INTO workflow_types(tenant_id,key,name,project_id) VALUES(1,'source','Source',1),(1,'target','Target',2),(1,'other','Other target schema',2);
    INSERT INTO workflows(id,tenant_id,project_id,name,workflow_type) VALUES(1,1,1,'Source','source'),(2,1,2,'Destination','target');
    INSERT INTO agents(id,tenant_id,project_id,name,session_key) VALUES(1,1,1,'Source agent','source'),(2,1,2,'Destination agent','target');
    INSERT INTO workflow_type_task_types(tenant_id,workflow_type_key,task_type) VALUES(1,'source','draft_article'),(1,'target','publish_article');
    INSERT INTO workflow_type_task_statuses(tenant_id,workflow_type_key,status_key,label) VALUES(1,'source','approved_old','Old approval'),(1,'target','accepted_new','New acceptance');
    INSERT INTO workflow_type_outcomes(tenant_id,workflow_type_key,outcome_key,label) VALUES(1,'source','handoff_old','Old handoff'),(1,'target','handoff_new','New handoff');`);
  await db.run("INSERT INTO task_field_schemas(id,tenant_id,workflow_type_key,schema_json) VALUES(1,1,'source',?),(2,1,'target',?),(3,1,'other',?)",schema,schema,schema);
});
afterEach(async()=>{await teardownTestDb();});
async function pack(definition:MetricDefinition,scope=source){
  const metric=await createDefinition(db,access,'metric',{key:definition.key,name:definition.name,scope,definition});
  return {metric,bundle:await exportTelemetry(db,access,{scope,metric_ids:[metric.id]})};
}
async function importedDefinition(result:any){return (await getDefinition(db,access,'metric',result.imported[0].id)).definition;}
const eventMetric=(key:string,population?:Predicate):MetricDefinition=>({...milestoneRecipe({key,name:key,milestone:{field:'event.type',op:'eq',value:'task.created'}}),...(population?{population}:{})});

it('remaps before/after field IDs using the mapped workflow schema rather than another same-key schema',async()=>{
  const old=(await getTelemetryCatalog(db,access,source)).fields.find(field=>field.source?.schema_id===1)!;
  const current=(await getTelemetryCatalog(db,access,target)).fields.find(field=>field.source?.schema_id===2)!;
  const definition=eventMetric('amount_events',{field:`event.before.${old.id}`,op:'gte',value:0});
  definition.measure={kind:'aggregate',aggregate:'sum',value:{field:`event.after.${old.id}`}};
  const {bundle}=await pack(definition),result=await importTelemetry(db,access,{bundle,scope:target});
  expect(result.drafts).toBe(0);expect(result.reference_map[old.id]).toBe(current.id);
  const imported=await importedDefinition(result);
  expect(imported.population.field).toBe(`event.before.${current.id}`);expect(imported.measure.value.field).toBe(`event.after.${current.id}`);
});

it('uses mapped task-type scope to select the corresponding custom-field override',async()=>{
  await db.run("INSERT INTO task_field_schemas(id,tenant_id,workflow_type_key,task_type,schema_json) VALUES(4,1,'source','draft_article',?),(5,1,'target','publish_article',?)",schema,schema);
  const old=(await getTelemetryCatalog(db,access,source)).fields.find(field=>field.source?.schema_id===4)!;
  const current=(await getTelemetryCatalog(db,access,target)).fields.find(field=>field.source?.schema_id===5)!;
  const {bundle}=await pack(numericRecipe({key:'typed_amount',name:'Typed amount',field:old.id}));
  const result=await importTelemetry(db,access,{bundle,scope:target,reference_map:{'task_type:draft_article':'publish_article'}});
  expect(result.drafts).toBe(0);expect(result.reference_map[old.id]).toBe(current.id);
});

it('rewrites entity references in both expression operand orders and validates the destination',async()=>{
  const definition=eventMetric('scoped_events',{all:[
    {left:{field:'workflow_id'},op:'eq',right:{literal:1}},
    {left:{literal:1},op:'eq',right:{field:'project_id'}},
    {left:{field:'event.to_status'},op:'eq',right:{literal:'approved_old'}},
  ]});
  const {bundle}=await pack(definition);
  const result=await importTelemetry(db,access,{bundle,scope:{...target,workflow_id:2},reference_map:{'status:approved_old':'accepted_new'}});
  expect(result.drafts).toBe(0);
  expect((await importedDefinition(result)).population.all).toEqual([
    {left:{field:'workflow_id'},op:'eq',right:{literal:2}},
    {left:{literal:2},op:'eq',right:{field:'project_id'}},
    {left:{field:'event.to_status'},op:'eq',right:{literal:'accepted_new'}},
  ]);
});

it.each([
  ['event.to_status','approved_old','status','accepted_new'],
  ['event.outcome','handoff_old','outcome','handoff_new'],
  ['task_type','draft_article','task_type','publish_article'],
])('keeps an unavailable %s signal as a draft until explicitly mapped',async(field,old,prefix,current)=>{
  const {bundle}=await pack(eventMetric(`signal_${prefix}`,{field,op:'in',value:[old]}));
  const unresolved=await importTelemetry(db,access,{bundle,scope:target});
  expect(unresolved.drafts).toBe(1);expect(unresolved.imported[0].issues.join(' ')).toContain(`reference_map["${prefix}:${old}"]`);
  const mapped=await importTelemetry(db,access,{bundle,scope:target,reference_map:{[`${prefix}:${old}`]:current}});
  expect(mapped.drafts).toBe(0);expect((await importedDefinition(mapped)).population.value).toEqual([current]);
});

it('requires explicit scope mapping when workflow types differ and no destination type was selected',async()=>{
  const {bundle}=await pack(eventMetric('workflow_signal',{field:'workflow_type',op:'eq',value:'source'}));
  expect((await importTelemetry(db,access,{bundle,scope:{project_id:2}})).drafts).toBe(1);
  const mapped=await importTelemetry(db,access,{bundle,scope:{project_id:2},reference_map:{'workflow_type:source':'target'}});
  expect(mapped.drafts).toBe(0);expect((await importedDefinition(mapped)).population.value).toBe('target');
});

it('never silently maps a retired field generation onto a new same-key field',async()=>{
  const old=(await getTelemetryCatalog(db,access,source)).fields.find(field=>field.source?.schema_id===1)!;
  const {metric}=await pack(numericRecipe({key:'retired_amount',name:'Retired amount',field:old.id}));
  await db.run('UPDATE task_field_schemas SET schema_json=? WHERE id=1',JSON.stringify({fields:[]}));
  await db.run('UPDATE task_field_schemas SET schema_json=? WHERE id=1',schema);
  const current=(await getTelemetryCatalog(db,access,source)).fields.find(field=>field.source?.schema_id===1)!;
  const bundle=await exportTelemetry(db,access,{scope:source,metric_ids:[metric.id]});
  expect(bundle.catalog.find(field=>field.id===old.id)?.retired).toBe(true);
  const unresolved=await importTelemetry(db,access,{bundle,scope:source});
  expect(unresolved.drafts).toBe(1);expect(unresolved.reference_map[old.id]).toBeUndefined();
  const mapped=await importTelemetry(db,access,{bundle,scope:source,reference_map:{[old.id]:current.id}});
  expect(mapped.drafts).toBe(0);expect((await importedDefinition(mapped)).measure.value.field).toBe(current.id);
});

it('requires a scoped destination mapping for selected external event receipts',async()=>{
  await db.run("INSERT INTO external_event_mappings(id,tenant_id,project_id,workflow_type,event_name,action_kind,action_target) VALUES(1,1,1,'source','submitted','status','approved_old'),(2,1,2,'target','submitted','status','accepted_new')");
  const signal=(await getTelemetryCatalog(db,access,source)).event_mappings[0];
  const {bundle}=await pack(milestoneRecipe({key:'mapped_receipts',name:'Mapped receipts',milestone:signal.predicate}));
  expect(bundle.event_mappings?.[0]).toMatchObject({source:{id:1},event_name:'submitted'});
  expect((await importTelemetry(db,access,{bundle,scope:target})).drafts).toBe(1);
  const mapped=await importTelemetry(db,access,{bundle,scope:target,reference_map:{'event_mapping:1':'2'}});
  expect(mapped.drafts).toBe(0);expect((await importedDefinition(mapped)).measure.where.all).toContainEqual({field:'event.mapping_id',op:'eq',value:2});
  expect((await importTelemetry(db,access,{bundle,scope:target,reference_map:{'event_mapping:1':'1'}})).drafts).toBe(1);
});

it.each([
  ['status','event.to_status','approved_old','workflow_type_task_statuses','status_key'],
  ['outcome','event.outcome','handoff_old','workflow_type_outcomes','outcome_key'],
])('preserves pinned %s descriptors and requires explicit replacement of a retired generation',async(kind,field,key,table,column)=>{
  const {metric}=await pack(eventMetric(`retired_${kind}`,{field,op:'eq',value:key}));
  const before=(await db.value<any>('SELECT dependencies FROM telemetry_definition_revisions WHERE id=?',metric.latest_revision_id)).signals.find((signal:any)=>signal.kind===kind&&signal.source);
  await db.run(`DELETE FROM ${table} WHERE tenant_id=1 AND workflow_type_key='source' AND ${column}=?`,key);
  await db.run(`INSERT INTO ${table}(tenant_id,workflow_type_key,${column},label) VALUES(1,'source',?,'Replacement meaning')`,key);
  const bundle=await exportTelemetry(db,access,{scope:source,metric_ids:[metric.id]});
  expect(bundle.signals?.find(signal=>signal.id===before.id)).toMatchObject({retired:true,identity:before.identity,label:before.label});
  expect(bundle.resources[0].revisions[0].dependencies.signals).toEqual(expect.arrayContaining([expect.objectContaining({id:before.id,retired:true})]));
  const unresolved=await importTelemetry(db,access,{bundle,scope:source});
  expect(unresolved.drafts).toBe(1);expect(unresolved.imported[0].issues.join(' ')).toContain('retired signal generation');
  const mapped=await importTelemetry(db,access,{bundle,scope:source,reference_map:{[`${kind}:${key}`]:key}});
  expect(mapped.drafts).toBe(0);
  const deps=await db.value<any>('SELECT dependencies FROM telemetry_definition_revisions WHERE id=?',mapped.imported[0].latest_revision_id);
  expect(deps.signals.filter((signal:any)=>signal.source).map((signal:any)=>signal.identity)).not.toContain(before.identity);
});

it('remaps an explicit opaque status selector to the chosen destination descriptor',async()=>{
  const old=(await getTelemetryCatalog(db,access,source)).statuses.find(signal=>signal.key==='approved_old')!;
  const destination=(await getTelemetryCatalog(db,access,target)).statuses.find(signal=>signal.key==='accepted_new')!;
  const {bundle}=await pack(eventMetric('opaque_status',{field:'event.to_status',op:'eq',value:old.id}));
  const mapped=await importTelemetry(db,access,{bundle,scope:target,reference_map:{[old.id]:destination.id}});
  expect(mapped.drafts).toBe(0);expect((await importedDefinition(mapped)).population.value).toBe(destination.id);
});
