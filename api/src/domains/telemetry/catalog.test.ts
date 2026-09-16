import type { Db } from '../../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { BUILTIN_FIELDS, catalogFieldValues, getTelemetryCatalog } from './catalog';
import { drainTelemetryOutbox } from './capture';
import { numericRecipe } from './recipes';
import { validateMetricDefinition } from './evaluator';
import type { TelemetryAccess } from './access';
import { createDefinition, listBindings, saveBinding } from './definitions';

let db:Db;
const access:TelemetryAccess={tenantId:1,projectId:null,actor:'test'};
const schema=(type='number',label='Amount',key='amount')=>JSON.stringify({fields:[{key,type,label}]});
beforeEach(async()=>{
  db=await setupTestDb();
  await db.run("INSERT INTO tenants(id,name,slug) VALUES(1,'One','one'),(2,'Two','two')");
  await db.run("INSERT INTO projects(id,tenant_id,name) VALUES(1,1,'Article'),(3,1,'Other'),(2,2,'Private')");
  await db.run("INSERT INTO sprint_types(tenant_id,key,name,project_id) VALUES(1,'article','Article',1),(1,'other','Other',3),(2,'private','Private',2)");
  await db.run("INSERT INTO sprints(id,tenant_id,project_id,name,sprint_type) VALUES(1,1,1,'Article','article'),(3,1,3,'Other','other'),(2,2,2,'Private','private')");
  await db.run("INSERT INTO task_field_schemas(id,tenant_id,sprint_type_key,schema_json) VALUES(1,1,'article',?),(3,1,'other',?),(2,2,'private',?)",schema(),schema(),schema());
});
afterEach(async()=>{await teardownTestDb();});
async function field(){return (await getTelemetryCatalog(db,access,{project_id:1,workflow_type:'article'})).fields.find(item=>item.source?.schema_id===1)!;}
async function snapshot(){return await db.value<Record<string,any>>('SELECT telemetry_task_snapshot(to_jsonb(t)) FROM tasks t WHERE id=1');}
async function task(){await db.run("INSERT INTO tasks(id,tenant_id,project_id,sprint_id,title,status,custom_fields_json) VALUES(1,1,1,1,'One','draft',?)",JSON.stringify({amount:12}));}

it('changes only the descriptor revision when a label changes',async()=>{
  const old=await field();
  await db.run('UPDATE task_field_schemas SET schema_json=? WHERE id=1',schema('number','Price'));
  const changed=await field();
  expect(changed.id).toBe(old.id);expect(changed.source?.generation).toBe(old.source?.generation);
  expect(changed.revision_id).not.toBe(old.revision_id);expect(changed.label).toBe('Price');
});

it('removal and same-key re-addition get a new identity even without an intervening catalog read',async()=>{
  const old=await field();
  await db.run('UPDATE task_field_schemas SET schema_json=? WHERE id=1',JSON.stringify({fields:[]}));
  expect(await db.value('SELECT retired_at IS NOT NULL FROM telemetry_catalog_entries WHERE id=?',old.id)).toBe(true);
  await db.run('UPDATE task_field_schemas SET schema_json=? WHERE id=1',schema());
  const current=await field();expect(current.id).not.toBe(old.id);expect(current.source?.generation).not.toBe(old.source?.generation);
});

it('binding health checks pinned metric and profile fields against canonical generations without a catalog refresh',async()=>{
  const old=await field(),scope={project_id:1,workflow_type:'article'};
  const metric=await createDefinition(db,access,'metric',{key:'amount',name:'Amount',scope,definition:numericRecipe({key:'amount',name:'Amount',field:old.id})});
  const profile=await createDefinition(db,access,'profile',{key:'amount_profile',name:'Amount profile',scope,definition:{signals:{positive:{field:old.id,op:'gt',value:0}}}});
  const builtin=await createDefinition(db,access,'metric',{key:'points',name:'Points',scope,definition:numericRecipe({key:'points',name:'Points',field:'story_points'})});
  await saveBinding(db,access,{family_key:'metric_and_profile',scope,metric_revision_id:metric.latest_revision_id,profile_revision_id:profile.latest_revision_id});
  await saveBinding(db,access,{family_key:'profile_only',scope,metric_revision_id:builtin.latest_revision_id,profile_revision_id:profile.latest_revision_id});
  await db.run('UPDATE task_field_schemas SET schema_json=? WHERE id=1',schema('number','Renamed amount'));
  expect((await listBindings(db,access,scope)).map(binding=>binding.validation_state)).toEqual(['active','active']);
  await db.run('UPDATE task_field_schemas SET schema_json=? WHERE id=1',JSON.stringify({fields:[]}));
  await db.run('UPDATE task_field_schemas SET schema_json=? WHERE id=1',schema());
  // A stale registry must not conceal the retirement of the saved generation.
  await db.run('UPDATE telemetry_catalog_entries SET retired_at=NULL WHERE id=?',old.id);
  const bindings=await listBindings(db,access,scope);
  expect(bindings).toHaveLength(2);
  for(const binding of bindings){
    expect(binding.validation_state).toBe('needs_attention');
    expect(binding.validation_issues).toEqual(['Custom field Amount (amount) was retired; historical identity remains pinned.']);
  }
});

it('type changes and key renames create new logical field identities',async()=>{
  const old=await field();
  await db.run('UPDATE task_field_schemas SET schema_json=? WHERE id=1',schema('text'));
  const changed=await field();expect(changed.id).not.toBe(old.id);
  await db.run('UPDATE task_field_schemas SET schema_json=? WHERE id=1',schema('text','Renamed','renamed'));
  const renamed=await field();expect(renamed.id).not.toBe(changed.id);expect(renamed.key).toBe('renamed');
});

it('a schema delete/recreate cannot revive the old field even if its numeric source ID is reused',async()=>{
  const old=await field();
  await db.run('DELETE FROM task_field_schemas WHERE id=1');
  await db.run("INSERT INTO task_field_schemas(id,tenant_id,sprint_type_key,schema_json) VALUES(1,1,'article',?)",schema());
  expect((await field()).id).not.toBe(old.id);
});

it('pinned historical fields map only their recorded generation and cannot read new same-key values',async()=>{
  const old=await field();await task();const oldSnapshot=await snapshot();
  await db.run('UPDATE task_field_schemas SET schema_json=? WHERE id=1',JSON.stringify({fields:[]}));
  await db.run('UPDATE task_field_schemas SET schema_json=? WHERE id=1',schema());
  await db.run('UPDATE tasks SET custom_fields_json=? WHERE id=1',JSON.stringify({amount:999}));
  const current=await field();const newSnapshot=await snapshot();
  expect(catalogFieldValues(oldSnapshot!,[old])[old.id]).toEqual({decimal:'12'});
  expect(catalogFieldValues(newSnapshot!,[old])[old.id]).toBeUndefined();
  expect(catalogFieldValues(oldSnapshot!,[current])[current.id]).toBeUndefined();
  expect(catalogFieldValues(newSnapshot!,[current])[current.id]).toEqual({decimal:'999'});
  for(const fields of [[old,current],[current,old]]){
    expect(catalogFieldValues(oldSnapshot!,fields)[old.id]).toEqual({decimal:'12'});
    expect(catalogFieldValues(oldSnapshot!,fields)[current.id]).toBeUndefined();
    expect(catalogFieldValues(newSnapshot!,fields)[current.id]).toEqual({decimal:'999'});
    expect(catalogFieldValues(newSnapshot!,fields)[old.id]).toBeUndefined();
  }
  await drainTelemetryOutbox(db,{batchSize:1000});
  const observed=await db.all<any>("SELECT payload FROM telemetry_observations WHERE source='tasks' AND task_id=1 ORDER BY sequence");
  expect(observed[0].payload.after.field_descriptors[0].generation).toBe(old.source?.generation);
  expect(observed.at(-1).payload.after.field_descriptors[0].generation).toBe(current.source?.generation);
});

it('rolling back a schema mutation also rolls back generation changes and retirement',async()=>{
  const old=await field();
  await expect(db.withTransaction(async tx=>{await tx.run('UPDATE task_field_schemas SET schema_json=? WHERE id=1',JSON.stringify({fields:[]}));throw new Error('abort');})).rejects.toThrow('abort');
  expect((await field()).id).toBe(old.id);
  expect(await db.value('SELECT retired_at FROM telemetry_catalog_entries WHERE id=?',old.id)).toBeNull();
});

it('scoped catalog reads authorize workflow references and do not expose other project fields',async()=>{
  const scoped={...access,projectId:1};
  const catalog=await getTelemetryCatalog(db,scoped,{});
  expect(catalog.fields.filter(item=>item.source).map(item=>item.source!.schema_id)).toEqual([1]);
  await expect(getTelemetryCatalog(db,scoped,{project_id:3})).rejects.toThrow(/scope/);
  await expect(getTelemetryCatalog(db,scoped,{workflow_id:3})).rejects.toThrow(/Workflow/);
  const other=await getTelemetryCatalog(db,{tenantId:2,projectId:2,actor:'private'},{});
  expect(other.fields.filter(item=>item.source).map(item=>item.source!.schema_id)).toEqual([2]);
});

it('field granularity rejects run facts in task metrics while allowing the corresponding core grain',async()=>{
  const definition=numericRecipe({key:'tokens',name:'Tokens',field:'tokens_in'});
  expect(validateMetricDefinition(definition,BUILTIN_FIELDS).errors).toEqual(expect.arrayContaining([expect.objectContaining({code:'incompatible_field_type'})]));
  definition.grain='run';expect(validateMetricDefinition(definition,BUILTIN_FIELDS).valid).toBe(true);
  const amount=await field();definition.measure={kind:'aggregate',aggregate:'sum',value:{field:amount.id}};
  expect(validateMetricDefinition(definition,[amount]).valid).toBe(false);
  definition.grain='task';expect(validateMetricDefinition(definition,[amount]).valid).toBe(true);
});
