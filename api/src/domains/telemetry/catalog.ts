import { createHash, randomUUID } from 'crypto';
import type { Db } from '../../db/adapter/types';
import type { CatalogDescriptor, Grain, ValueBasis } from './contracts';
import { resolveScope, type TelemetryAccess, type TelemetryScope } from './access';
import {registerTelemetrySignals} from './signals';
import { getRoutingCatalogSignals } from './catalogRouting';

export interface TelemetryField extends CatalogDescriptor {
  key: string; label: string; scope: TelemetryScope; value_bases: ValueBasis[];
  source?: { schema_id: number; field_key: string; generation?: string };
  options?: string[]; revision_id?: string;
}
const bases: ValueBasis[] = ['current','at_entry','at_event','at_resolution'];
const taskGrains:Grain[]=['task','event','journey'];
const relatedGrains:Grain[]=[...taskGrains,'run','runtime_execution'];
const allGrains:Grain[]=[...relatedGrains,'project','workflow','agent'];
function supportedGrains(id:string):Grain[]{
  if(id.startsWith('event.'))return relatedGrains;
  if(id==='status_identity')return taskGrains;
  if(['tokens_in','tokens_out','runtime_ended_success','semantic_outcome_missing','instruction_fingerprint','model'].includes(id))return ['run'];
  if(id==='runtime_state')return ['runtime_execution'];
  if(id==='runtime_duration_ms'||id==='started_at'||id==='ended_at')return ['run','runtime_execution'];
  if(id==='runtime_type')return ['run','runtime_execution','agent'];
  if(['story_points','retry_count','total_dispatch_count','manual_intervention_count','active_instance_id','origin_task_id','unresolved_dependencies','priority'].includes(id))return taskGrains;
  if(id==='assigned_agent_id'||id==='task_type')return relatedGrains;
  if(id==='workflow_id'||id==='workflow_type'||id==='workflow_status')return [...relatedGrains,'workflow'];
  if(id==='status')return [...taskGrains,'run','workflow'];
  if(id==='updated_at')return relatedGrains;
  return allGrains;
}
const builtinTypes: Record<string, CatalogDescriptor['type']> = {
  id:'number',title:'text',status:'select',status_identity:'text',priority:'select',project_id:'number',workflow_id:'number',workflow_type:'text',task_type:'text',
  assigned_agent_id:'number',agent_id:'number',active_instance_id:'number',origin_task_id:'number',story_points:'number',retry_count:'number',
  total_dispatch_count:'number',manual_intervention_count:'number',created_at:'datetime',updated_at:'datetime',
  started_at:'datetime',ended_at:'datetime',runtime_state:'select',runtime_ended_success:'checkbox',semantic_outcome_missing:'checkbox',
  runtime_type:'text',model:'text',instruction_fingerprint:'text',tokens_in:'number',tokens_out:'number',runtime_duration_ms:'number',
  unresolved_dependencies:'number',workflow_status:'select',
  'event.type':'text','event.from_status':'text','event.to_status':'text','event.outcome':'text','event.actor':'text',
  'event.from_status_identity':'text','event.to_status_identity':'text','event.outcome_identity':'text',
  'event.event':'text','event.mapping_id':'number','event.processing_state':'text',
};
export const BUILTIN_FIELDS: TelemetryField[] = Object.entries(builtinTypes).map(([id,type]) => ({
  id, key:id, label:id.replace(/^event\./,'Event ').replace(/_/g,' '), type, scope:{}, bases,
  value_bases:bases,supported_grains:supportedGrains(id), ...(id.endsWith('_ms') ? {unit:'milliseconds'} : {}),
}));
export const parseObject = (value: unknown): Record<string, any> => {
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,any> : {};
};
export function contentHash(value: unknown): string {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

async function registerFields(db: Db, access: TelemetryAccess, sourceFields: Array<{source_key:string;descriptor:Omit<TelemetryField,'id'>}>): Promise<TelemetryField[]> {
  return db.withTransaction(async tx => {
    await tx.get('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', `telemetry:catalog:${access.tenantId}`);
    const projectWhere = access.projectId == null ? '' : ' AND (project_id IS NULL OR project_id = ?)';
    const prior = await tx.all<any>(`SELECT * FROM telemetry_catalog_entries WHERE tenant_id = ?${projectWhere} AND retired_at IS NULL AND source_key LIKE 'schema:%'`, access.tenantId, ...(access.projectId == null ? [] : [access.projectId]));
    const bySource = new Map(prior.map(row=>[row.source_key,row]));
    const sourceKeys = new Set(sourceFields.map(row=>row.source_key));
    for (const old of prior) {
      if (!sourceKeys.has(old.source_key)) await tx.run('UPDATE telemetry_catalog_entries SET retired_at = clock_timestamp() WHERE tenant_id = ? AND id = ?', access.tenantId, old.id);
    }
    const result: TelemetryField[] = [];
    for (const field of sourceFields) {
      const old = bySource.get(field.source_key); const hash = contentHash(field.descriptor);
      const id = old?.id ?? `field_${randomUUID()}`;
      if (!old) await tx.run(`INSERT INTO telemetry_catalog_entries (id,tenant_id,source_key,project_id,descriptor,hash) VALUES (?,?,?,?,?::jsonb,?)`, id,access.tenantId,field.source_key,field.descriptor.scope.project_id??null,JSON.stringify(field.descriptor),hash);
      else if (old.hash !== hash) await tx.run('UPDATE telemetry_catalog_entries SET descriptor = ?::jsonb, hash = ? WHERE tenant_id = ? AND id = ?', JSON.stringify(field.descriptor),hash,access.tenantId,id);
      await tx.run(`INSERT INTO telemetry_catalog_revisions (id,tenant_id,entry_id,descriptor,hash) VALUES (?,?,?,?::jsonb,?) ON CONFLICT (tenant_id,entry_id,hash) DO NOTHING`, randomUUID(),access.tenantId,id,JSON.stringify(field.descriptor),hash);
      const rev = await tx.get<{id:string}>('SELECT id FROM telemetry_catalog_revisions WHERE tenant_id = ? AND entry_id = ? AND hash = ?',access.tenantId,id,hash);
      result.push({...field.descriptor,id,revision_id:rev!.id});
    }
    return result;
  });
}

async function buildTelemetryCatalog(db: Db, access: TelemetryAccess, scope: TelemetryScope = {}) {
  const project = scope.project_id ?? access.projectId;
  const types = await db.all<any>(`SELECT key,name,project_id FROM workflow_types WHERE tenant_id = ?${access.projectId == null ? '' : ' AND (project_id IS NULL OR project_id = ?)'} ORDER BY name`,access.tenantId,...(access.projectId==null?[]:[access.projectId]));
  const typeMap = new Map(types.map(row=>[row.key,row]));
  // Read schema rows only through their canonical tenant/type ownership.
  const schemas = await db.all<any>(`SELECT fs.id,fs.workflow_type_key,fs.task_type,fs.schema_json,st.project_id FROM task_field_schemas fs JOIN workflow_types st ON st.tenant_id = fs.tenant_id AND st.key = fs.workflow_type_key WHERE fs.tenant_id = ?${access.projectId==null?'':' AND (st.project_id IS NULL OR st.project_id = ?)'} ORDER BY fs.id`,access.tenantId,...(access.projectId==null?[]:[access.projectId]));
  const generations=schemas.length?await db.all<{schema_id:number;field_key:string;field_type:string;generation:string}>('SELECT schema_id,field_key,field_type,generation FROM telemetry_field_generations WHERE tenant_id=? AND active AND schema_id=ANY(?::bigint[])',access.tenantId,schemas.map(schema=>Number(schema.id))):[];
  const generationMap=new Map(generations.map(row=>[`${row.schema_id}:${row.field_key}:${row.field_type}`,row.generation]));
  const fields: Array<{source_key:string;descriptor:Omit<TelemetryField,'id'>}> = [];
  for (const schema of schemas) {
    const raw = parseObject(schema.schema_json);
    for (const field of Array.isArray(raw.fields)?raw.fields:[]) {
      if (!field || typeof field.key!=='string' || !['text','textarea','url','select','number','checkbox'].includes(field.type??'text')) continue;
      const generation=generationMap.get(`${schema.id}:${field.key}:${field.type??'text'}`);
      if(!generation)continue; // A disabled/missing schema producer cannot invent identity continuity.
      const fieldScope: TelemetryScope = {workflow_type:schema.workflow_type_key,...(schema.project_id==null?{}:{project_id:Number(schema.project_id)}),...(schema.task_type?{task_type:schema.task_type}:{})};
      fields.push({source_key:`schema:${schema.id}:${field.key}:${field.type??'text'}:${generation}`,descriptor:{key:field.key,label:field.label||field.key,type:field.type??'text',scope:fieldScope,bases,value_bases:bases,supported_grains:taskGrains,source:{schema_id:Number(schema.id),field_key:field.key,generation},...(Array.isArray(field.options)?{options:field.options}: {})}});
    }
  }
  const registered = await registerFields(db,access,fields);
  const applicable = (s: TelemetryScope) => (project==null||s.project_id==null||s.project_id===project)&&(!scope.workflow_type||!s.workflow_type||s.workflow_type===scope.workflow_type)&&(!scope.task_type||!s.task_type||s.task_type===scope.task_type);
  const workflowTypes = types.filter(row=>applicable({project_id:row.project_id??undefined,workflow_type:row.key}));
  const allowedTypeKeys = new Set(workflowTypes.map(row=>row.key));
  const workflows = await db.all<any>(`SELECT id,name,project_id,workflow_type AS workflow_type,status FROM workflows WHERE tenant_id = ?${project==null?'':' AND project_id = ?'}${scope.workflow_id?' AND id = ?':''}${scope.workflow_type?' AND workflow_type = ?':''} ORDER BY name`,access.tenantId,...(project==null?[]:[project]),...(scope.workflow_id?[scope.workflow_id]:[]),...(scope.workflow_type?[scope.workflow_type]:[]));
  const projects = await db.all<any>(`SELECT id,name FROM projects WHERE tenant_id = ?${project==null?'':' AND id = ?'} ORDER BY name`,access.tenantId,...(project==null?[]:[project]));
  const agents = await db.all<any>(`SELECT id,name,project_id FROM agents WHERE tenant_id = ?${project==null?'':' AND project_id = ?'} ORDER BY name`,access.tenantId,...(project==null?[]:[project]));
  const taskTypes = await db.all<any>('SELECT task_type AS key, task_type AS label,workflow_type_key AS workflow_type FROM workflow_type_task_types WHERE tenant_id = ? ORDER BY task_type',access.tenantId);
  const typeStatuses = await db.all<any>('SELECT id,status_key AS key,label,workflow_type_key AS workflow_type,terminal FROM workflow_type_task_statuses WHERE tenant_id = ? ORDER BY stage_order,id',access.tenantId);
  const statusSources = typeStatuses.filter(row=>allowedTypeKeys.has(row.workflow_type)).map(row=>({kind:'status' as const,key:row.key,label:row.label,terminal:Number(row.terminal),source:{table:'workflow_type_task_statuses',id:String(row.id)},scope:{workflow_type:row.workflow_type,...(typeMap.get(row.workflow_type)?.project_id?{project_id:Number(typeMap.get(row.workflow_type).project_id)}:{})}} as any));
  if(workflows.length){
    const instanceStatuses=await db.all<any>('SELECT id,workflow_id,status_key AS key,label,terminal FROM workflow_task_statuses WHERE workflow_id=ANY(?::bigint[])',workflows.map(row=>row.id));
    const byId=new Map(workflows.map(row=>[Number(row.id),row]));
    for(const row of instanceStatuses){const workflow=byId.get(Number(row.workflow_id))!;statusSources.push({kind:'status',key:row.key,label:row.label,terminal:Number(row.terminal),source:{table:'workflow_task_statuses',id:String(row.id)},scope:{workflow_id:Number(row.workflow_id),workflow_type:workflow.workflow_type,project_id:Number(workflow.project_id)}});}
  }
  const globalStatuses=await db.all<any>('SELECT name AS key,label,terminal FROM task_statuses ORDER BY name');
  for(const row of globalStatuses)statusSources.push({kind:'status',key:row.key,label:row.label,terminal:Number(row.terminal),source:{table:'task_statuses',id:row.key},scope:{}});
  const outcomeSources=(await db.all<any>("SELECT id,outcome_key AS key,label,workflow_type_key AS workflow_type,task_type FROM workflow_type_outcomes WHERE tenant_id=? AND enabled=1 AND behavior<>'disable' ORDER BY stage_order,id",access.tenantId))
    .filter(row=>allowedTypeKeys.has(row.workflow_type)&&(!scope.task_type||!row.task_type||scope.task_type===row.task_type))
    .map(row=>({kind:'outcome' as const,key:row.key,label:row.label,source:{table:'workflow_type_outcomes',id:String(row.id)},scope:{workflow_type:row.workflow_type,...(typeMap.get(row.workflow_type)?.project_id?{project_id:Number(typeMap.get(row.workflow_type).project_id)}:{}),...(row.task_type?{task_type:row.task_type}:{})}}));
  const signals=await registerTelemetrySignals(db,access,[...statusSources,...outcomeSources]);
  const statuses=signals.filter(signal=>signal.kind==='status'),outcomes=signals.filter(signal=>signal.kind==='outcome');
  const routingSignals=await getRoutingCatalogSignals(db,access,scope,allowedTypeKeys);
  return {fields:[...BUILTIN_FIELDS,...registered.filter(field=>applicable(field.scope))],statuses,outcomes,projects,workflows,workflow_types:workflowTypes,task_types:taskTypes.filter(row=>allowedTypeKeys.has(row.workflow_type)),agents,...routingSignals};
}

/** Serialize canonical reads and descriptor registration against schema writes. */
export async function getTelemetryCatalog(db:Db,access:TelemetryAccess,scope:TelemetryScope={}){
  return db.withTransaction(async tx=>{
    await tx.get('SELECT pg_advisory_xact_lock_shared(hashtextextended(?, 0))','telemetry:signals');
    await tx.get('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',`telemetry:catalog:${access.tenantId}`);
    return buildTelemetryCatalog(tx,access,await resolveScope(tx,access,scope));
  });
}

/** Map only the effective canonical schema's declared field to its catalog identity. */
export function catalogFieldValues(snapshot: Record<string,any>, fields: TelemetryField[]): Record<string,unknown> {
  const result: Record<string,unknown> = {...snapshot};
  const custom = parseObject(snapshot.custom_fields??snapshot.custom_fields_json);
  delete result.custom_fields_json; delete result.custom_fields;
  const eligible = fields.filter(field=>field.source && (!field.scope.project_id || field.scope.project_id===Number(snapshot.project_id)) && field.scope.workflow_type===snapshot.workflow_type && (!field.scope.task_type || field.scope.task_type===snapshot.task_type));
  const descriptors=new Map<string,any>((Array.isArray(snapshot.field_descriptors)?snapshot.field_descriptors:[]).map((descriptor:any)=>[descriptor.key,descriptor]));
  // Live and pinned retired descriptors may share a display key. Resolve each
  // against the snapshot's authoritative schema/generation, never array order.
  for (const field of eligible) {
    const value = custom[field.key];
    if (value===undefined) continue;
    // History carries descriptors: never reinterpret an old string as a new number.
    const historical = descriptors.get(field.key);
    if(!historical || historical.type!==field.type || Number(historical.schema_id)!==field.source!.schema_id) continue;
    if(field.source!.generation!==historical?.generation)continue;
    result[field.id]=value;
  }
  return result;
}
