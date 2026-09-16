import type {Db} from '../db/adapter/types';
import {setupTestDb,teardownTestDb} from '../db/testDb';
import {exportProjectManifest,importProjectManifest,manifestJson,validateProjectManifest} from './projectPortability';
import {createDefinition,saveBinding} from '../domains/telemetry/definitions';
import {getTelemetryCatalog} from '../domains/telemetry/catalog';
import {milestoneRecipe,numericRecipe} from '../domains/telemetry/recipes';
import {queryTelemetry} from '../domains/telemetry/queries';

let db:Db;
const access={tenantId:1,projectId:null,actor:'project_export_test'},scope={project_id:101,workflow_id:102,task_type:'article'};
beforeEach(async()=>{
  db=await setupTestDb();
  await db.exec(`INSERT INTO tenants(id,name,slug) VALUES(1,'Source','source'),(2,'Destination','destination');
    INSERT INTO projects(id,tenant_id,name) VALUES(101,1,'Source project'),(202,2,'Private existing project');
    INSERT INTO sprint_types(id,tenant_id,project_id,key,name,description,repo_required) VALUES(101,1,101,'delivery','Editorial delivery','Source semantics',1),(202,2,202,'delivery','Private delivery','Do not overwrite',0);
    INSERT INTO sprints(id,tenant_id,project_id,name,sprint_type) VALUES(102,1,101,'Editorial','delivery');
    INSERT INTO agents(id,tenant_id,project_id,name,session_key) VALUES(103,1,101,'Editor','project-source'),(203,2,202,'Private agent','project-private');
    INSERT INTO sprint_type_task_types(tenant_id,sprint_type_key,task_type) VALUES(1,'delivery','article'),(2,'delivery','private_task');
    INSERT INTO sprint_type_task_statuses(tenant_id,sprint_type_key,status_key,label,terminal) VALUES(1,'delivery','approved_source','Approved source',1),(2,'delivery','private_status','Private status',1);
    INSERT INTO sprint_task_statuses(sprint_id,status_key,label,terminal) VALUES(102,'submitted_instance','Submitted instance',1);
    INSERT INTO sprint_type_outcomes(tenant_id,sprint_type_key,task_type,outcome_key,label) VALUES(1,'delivery','article','handoff_source','Source handoff');
    INSERT INTO task_field_schemas(id,tenant_id,sprint_type_key,task_type,schema_json) VALUES
      (104,1,'delivery',NULL,'{"fields":[{"key":"amount","type":"number","label":"Amount"}]}'),
      (105,1,'delivery','article','{"fields":[{"key":"amount","type":"number","label":"Article amount"}]}'),
      (204,2,'delivery',NULL,'{"fields":[{"key":"private_amount","type":"number","label":"Private field"}]}');`);
  const catalog=await getTelemetryCatalog(db,access,scope),amount=catalog.fields.find(field=>field.source?.schema_id===105)!;
  const profile=await createDefinition(db,access,'profile',{key:'review_profile',name:'Review profile',scope,definition:{signals:{accepted:{field:'event.to_status',op:'eq',value:'submitted_instance'},handoff:{field:'event.outcome',op:'eq',value:'handoff_source'}}}});
  const definition=numericRecipe({key:'proposal_amount',name:'Proposal amount',field:amount.id});
  definition.population={all:[{field:'assigned_agent_id',op:'eq',value:103},{field:'workflow_id',op:'eq',value:102},{field:'task_type',op:'eq',value:'article'}]};
  const metric=await createDefinition(db,access,'metric',{key:definition.key,name:definition.name,scope,definition});
  await saveBinding(db,access,{family_key:'proposal_amount',scope,metric_revision_id:metric.latest_revision_id,profile_revision_id:profile.latest_revision_id});
  await createDefinition(db,access,'report',{key:'delivery_report',name:'Delivery report',scope,definition:{scope,metrics:[{metric_id:metric.id,metric_revision_id:metric.latest_revision_id}]}});
});
afterEach(async()=>{await teardownTestDb();});

it('exports deterministic scoped telemetry and canonical workflow metadata without another tenant schema',async()=>{
  const first=await exportProjectManifest(db,101,false),second=await exportProjectManifest(db,101,false);
  expect(manifestJson(first.manifest)).toBe(manifestJson(second.manifest));
  expect(first.manifest.telemetry?.resources).toHaveLength(3);expect(first.manifest.telemetry).not.toHaveProperty('exported_at');
  expect(first.manifest.workflow_types?.[0]).toMatchObject({key:'delivery',configuration:{description:'Source semantics',repo_required:1},task_types:[{task_type:'article'}],statuses:[{status_key:'approved_source',terminal:1}],outcomes:[{outcome_key:'handoff_source',task_type:'article'}]});
  expect(first.manifest.workflows[0].field_schemas.map(schema=>schema.source_schema_id).sort()).toEqual([104,105]);
  expect(first.manifest.workflows[0].statuses?.[0]).toMatchObject({status_key:'submitted_instance',terminal:1});
  expect(manifestJson(first.manifest)).not.toContain('private_amount');expect(manifestJson(first.manifest)).not.toContain('private_status');
  expect((await validateProjectManifest(db,first.manifest)).counts).toMatchObject({telemetry_definitions:3,telemetry_bindings:1});
});

it('copies schemas and telemetry into a new tenant project with mapped workflow, agent, type and revision identities',async()=>{
  const manifest=(await exportProjectManifest(db,101,false)).manifest;
  const result=await importProjectManifest(db,manifest,{tenantId:2,projectName:'Copied telemetry',actor:'test'});
  expect(result.telemetry?.drafts).toBe(0);expect(result.telemetry?.imported).toHaveLength(3);
  expect(result.preview.warnings.filter(warning=>warning.section==='telemetry')).toEqual([]);
  const targetType=result.id_map.workflow_types!.delivery,targetWorkflow=result.id_map.workflows['workflow:102'],targetAgent=result.id_map.agents['agent:103'];
  expect(targetType).not.toBe('delivery');
  expect(await db.get('SELECT project_id,description,repo_required FROM sprint_types WHERE tenant_id=2 AND key=?',targetType)).toMatchObject({project_id:result.project_id,description:'Source semantics',repo_required:1});
  expect(await db.value("SELECT description FROM sprint_types WHERE tenant_id=2 AND key='delivery'")).toBe('Do not overwrite');
  expect(await db.get('SELECT tenant_id,sprint_type_key,task_type FROM task_field_schemas WHERE id=?',result.id_map.schemas!['105'])).toEqual({tenant_id:2,sprint_type_key:targetType,task_type:'article'});
  const targetField=(await getTelemetryCatalog(db,{tenantId:2,projectId:result.project_id,actor:'test'},{workflow_id:targetWorkflow,task_type:'article'})).fields.find(field=>field.source?.schema_id===result.id_map.schemas!['105'])!;
  const metric=result.telemetry!.imported.find(row=>row.kind==='metric')!,profile=result.telemetry!.imported.find(row=>row.kind==='profile')!,report=result.telemetry!.imported.find(row=>row.kind==='report')!;
  const saved=await db.value<any>('SELECT definition FROM telemetry_definition_revisions WHERE id=?',metric.latest_revision_id);
  expect(saved.measure.value.field).toBe(targetField.id);
  expect(saved.population.all).toEqual([{field:'assigned_agent_id',op:'eq',value:targetAgent},{field:'workflow_id',op:'eq',value:targetWorkflow},{field:'task_type',op:'eq',value:'article'}]);
  expect(result.telemetry!.bindings[0]).toMatchObject({project_id:result.project_id,metric_revision_id:metric.latest_revision_id,profile_revision_id:profile.latest_revision_id,scope:{workflow_id:targetWorkflow,workflow_type:targetType,task_type:'article'}});
  await db.run("INSERT INTO tasks(tenant_id,project_id,sprint_id,assigned_agent_id,title,status,task_type,custom_fields_json) VALUES(2,?,?,?,'New task','submitted_instance','article','{\"amount\":12}')",result.project_id,targetWorkflow,targetAgent);
  const evaluated=await queryTelemetry(db,{tenantId:2,projectId:result.project_id,actor:'test'},{report_revision_id:report.latest_revision_id}) as any;
  expect(evaluated.results[0].value).toBe(12);
});

it('keeps unresolved telemetry as drafts and warnings while completing the project copy',async()=>{
  const manifest=(await exportProjectManifest(db,101,false)).manifest;
  const metric=manifest.telemetry!.resources.find(resource=>resource.kind==='metric')!;
  for(const revision of metric.revisions)revision.definition.population={field:'status',op:'eq',value:'missing_destination_signal'};
  const result=await importProjectManifest(db,manifest,{tenantId:2,actor:'test'});
  expect(await db.get('SELECT id FROM projects WHERE id=?',result.project_id)).toBeDefined();
  expect(result.telemetry!.drafts).toBeGreaterThan(0);
  expect(result.preview.warnings).toEqual(expect.arrayContaining([expect.objectContaining({code:'missing_telemetry_reference',section:'telemetry'})]));
  expect(result.telemetry!.bindings.some(binding=>binding.activated===false)).toBe(true);
  expect(await db.value('SELECT COUNT(*) FROM telemetry_metric_bindings WHERE tenant_id=2 AND project_id=?',result.project_id)).toBe(0);
});

it.each([false,true])('maps a selected external event mapping to its cloned identity (tenant default: %s)',async tenantDefault=>{
  await db.run("INSERT INTO external_event_mappings(id,tenant_id,project_id,sprint_id,sprint_type,event_name,action_kind,action_target) VALUES(901,1,?,?,?,'submitted','status','submitted_instance')",tenantDefault?null:101,tenantDefault?null:102,tenantDefault?null:'delivery');
  const signal=(await getTelemetryCatalog(db,access,scope)).event_mappings[0];
  const definition=milestoneRecipe({key:'selected_mapping',name:'Selected mapping',milestone:signal.predicate});
  await createDefinition(db,access,'metric',{key:definition.key,name:definition.name,scope,definition});
  const manifest=(await exportProjectManifest(db,101,false)).manifest;
  expect(manifest.routing.external_event_mappings[0].source_mapping_id).toBe(901);
  const result=await importProjectManifest(db,manifest,{tenantId:2,actor:'test'});
  expect(result.telemetry?.drafts).toBe(0);
  const destinationId=Number(result.telemetry!.reference_map['event_mapping:901']);
  expect(destinationId).not.toBe(901);
  expect(await db.get('SELECT tenant_id,project_id,sprint_id FROM external_event_mappings WHERE id=?',destinationId)).toEqual({tenant_id:2,project_id:result.project_id,sprint_id:tenantDefault?null:result.id_map.workflows['workflow:102']});
  const metric=result.telemetry!.imported.find(row=>row.source_key==='selected_mapping')!;
  const saved=await db.value<any>('SELECT definition FROM telemetry_definition_revisions WHERE id=?',metric.latest_revision_id);
  expect(saved.measure.where.all).toContainEqual({field:'event.mapping_id',op:'eq',value:destinationId});
});

it('does not activate a retired historical signal against a recreated same-key status during project copy',async()=>{
  await db.run("DELETE FROM sprint_task_statuses WHERE sprint_id=102 AND status_key='submitted_instance'");
  await db.run("INSERT INTO sprint_task_statuses(sprint_id,status_key,label,terminal) VALUES(102,'submitted_instance','New meaning',1)");
  const manifest=(await exportProjectManifest(db,101,false)).manifest;
  expect(manifest.telemetry!.signals).toEqual(expect.arrayContaining([expect.objectContaining({key:'submitted_instance',retired:true})]));
  const result=await importProjectManifest(db,manifest,{tenantId:2,actor:'test'});
  const profile=result.telemetry!.imported.find(row=>row.kind==='profile');
  expect(profile).toMatchObject({state:'draft'});expect(profile.issues.join(' ')).toContain('retired signal generation');
  expect(result.telemetry!.bindings.some(binding=>binding.activated===false)).toBe(true);
});
