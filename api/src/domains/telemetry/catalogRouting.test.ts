import type { Db } from '../../db/adapter/types';
import { setupTestDb,teardownTestDb } from '../../db/testDb';
import { getTelemetryCatalog,BUILTIN_FIELDS } from './catalog';
import { evaluateMetric,validateMetricDefinition } from './evaluator';
import { milestoneRecipe } from './recipes';

let db:Db;
const access={tenantId:1,projectId:1,actor:'test'};
beforeEach(async()=>{
  db=await setupTestDb();
  await db.run("INSERT INTO tenants(id,name,slug) VALUES(1,'One','one'),(2,'Private','private')");
  await db.run("INSERT INTO projects(id,tenant_id,name) VALUES(1,1,'One'),(2,1,'Other'),(3,2,'Private')");
  await db.run("INSERT INTO workflow_types(tenant_id,key,name,project_id) VALUES(1,'article','Article',1),(1,'other','Other',2),(2,'secret','Private',3)");
  await db.run("INSERT INTO workflows(id,tenant_id,project_id,name,workflow_type) VALUES(1,1,1,'One','article'),(2,1,1,'Sibling','article'),(3,1,2,'Other','other'),(4,2,3,'Private','secret')");
});
afterEach(teardownTestDb);
async function transition(id:number,tenant:number,project:number|null,workflow:number|null,type:string,enabled=1){
  await db.run("INSERT INTO workflow_task_transitions(id,tenant_id,project_id,workflow_id,workflow_type,from_status,outcome,to_status,enabled) VALUES(?,?,?,?,?,'draft','submitted','review',?)",id,tenant,project,workflow,type,enabled);
}
async function mapping(id:number,tenant:number,project:number|null,workflow:number|null,type:string|null,event='article_received'){
  await db.run("INSERT INTO external_event_mappings(id,tenant_id,project_id,workflow_id,workflow_type,source,event_name,action_kind,action_target,status_includes_json,status_excludes_json) VALUES(?,?,?,?,?,'webhook',?,'status','review','[\"draft\"]','[\"cancelled\"]')",id,tenant,project,workflow,type,event);
}
it('discovers canonical scoped transitions with disabled overrides and excludes sibling/private routing',async()=>{
  await transition(1,1,1,null,'article');await transition(2,1,1,1,'article',0);await transition(3,1,1,2,'article');
  await transition(4,1,2,3,'other');await transition(5,2,3,4,'secret');
  const catalog=await getTelemetryCatalog(db,access,{workflow_id:1});
  expect(catalog.routing_transitions.map(item=>item.id)).toEqual(['transition:1','transition:2']);
  expect(catalog.routing_transitions[0]).toMatchObject({is_inherited:true,effective_for_workflow:false});
  expect(catalog.routing_transitions[1]).toMatchObject({enabled:false,is_override:true,effective_for_workflow:true,scope:{project_id:1,workflow_id:1,workflow_type:'article'}});
  expect(JSON.stringify(catalog.routing_transitions)).not.toContain('secret');
  const typeCatalog=await getTelemetryCatalog(db,access,{workflow_type:'article'});
  expect(typeCatalog.routing_transitions.map(item=>item.id)).toEqual(['transition:1']);
});
it('discovers global event defaults and authorized overrides while preserving canonical event constraints',async()=>{
  await mapping(1,1,null,null,null);await mapping(2,1,1,1,'article');await mapping(3,1,1,2,'article','sibling_event');
  await mapping(4,1,2,3,'other','private_project_event');await mapping(5,2,3,4,'secret','private_tenant_event');
  const catalog=await getTelemetryCatalog(db,access,{workflow_id:1});
  expect(catalog.event_mappings.map(item=>item.id)).toEqual(['event_mapping:1','event_mapping:2']);
  expect(catalog.event_mappings[1]).toMatchObject({event_name:'article_received',event_source:'webhook',action_kind:'status',action_target:'review',status_includes:['draft'],status_excludes:['cancelled'],is_override:true});
  expect(JSON.stringify(catalog.event_mappings)).not.toContain('private_');
  // Corrupt cross-tenant workflow references must not bypass catalog containment.
  await mapping(6,1,null,4,null,'mismatched_owner');
  expect(JSON.stringify((await getTelemetryCatalog(db,access,{})).event_mappings)).not.toContain('mismatched_owner');
});
it('expands selected mapping and transition templates into executable predicates over recorded evidence',async()=>{
  await transition(1,1,1,1,'article');await mapping(1,1,1,1,'article');
  const catalog=await getTelemetryCatalog(db,access,{workflow_id:1});
  const context={project_id:1,workflow_id:1,workflow_type:'article'},as_of='2026-09-10T12:00:00Z';
  const entities=[1,2,3,4].map(id=>({id,kind:'task' as const,fields:context}));
  const observations=[
    {id:'received',entity_id:2,entity_kind:'task' as const,type:'task.external_event',occurred_at:as_of,context,fields:{event:'article_received',mapping_id:1,processing_state:'received'}},
    {id:'processed',entity_id:1,entity_kind:'task' as const,type:'task.external_event',occurred_at:as_of,context,fields:{event:'article_received',mapping_id:1,processing_state:'processed'}},
    {id:'other_mapping',entity_id:3,entity_kind:'task' as const,type:'task.external_event',occurred_at:as_of,context,fields:{event:'article_received',mapping_id:2,processing_state:'processed'}},
    {id:'transition',entity_id:1,entity_kind:'task' as const,type:'task.changed',occurred_at:as_of,context,fields:{from_status:'draft',to_status:'review',outcome:'submitted'}},
    {id:'wrong_outcome',entity_id:4,entity_kind:'task' as const,type:'task.changed',occurred_at:as_of,context,fields:{from_status:'draft',to_status:'review',outcome:'other'}},
  ];
  for(const signal of [catalog.routing_transitions[0],catalog.event_mappings[0]]){
    const definition=milestoneRecipe({key:'selected',name:signal.label,milestone:signal.predicate});
    expect(validateMetricDefinition(definition,BUILTIN_FIELDS).valid).toBe(true);
    expect(evaluateMetric({definition,catalog:BUILTIN_FIELDS,entities,observations:observations.map(event=>({...event,after:context})),as_of}).value).toBe(1);
  }
});
