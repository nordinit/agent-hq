import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { Db } from '../../db/adapter/types';
import { TelemetryError, type TelemetryAccess, type TelemetryScope, resolveScope, scopeKey, scopeMatches, bindingRank, scopeSchema, intersectScopes } from './access';
import { telemetryWidgetSchema, viewDisplayIssue } from './views';
import { contentHash, getTelemetryCatalog, type TelemetryField } from './catalog';
import { parseMetricDefinition, validateMetricDefinition } from './evaluator';
import type { CatalogDescriptor, MetricDefinition } from './contracts';
import {compileSignalPredicates,signalReferenceHealth,type TelemetrySignal} from './signals';

export type DefinitionKind = 'metric'|'profile'|'report';
export interface DefinitionRow {
  id:string;tenant_id:number;kind:DefinitionKind;key:string;name:string;description:string;scope:TelemetryScope;project_id:number|null;
  latest_revision_id:string;revision:number;definition:any;dependencies:any;archived_at:string|null;created_at:string;
}
const creationSchema = z.object({key:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).max(128),name:z.string().trim().min(1).max(200),description:z.string().max(4000).optional(),scope:scopeSchema.optional(),definition:z.unknown(),profile_revision_id:z.string().optional()}).strict();
const revisionSchema = z.object({definition:z.unknown(),expected_revision_id:z.string().min(1),name:z.string().trim().min(1).max(200).optional(),description:z.string().max(4000).optional(),profile_revision_id:z.string().optional()}).strict();
const querySelect = `SELECT d.*,r.definition,r.dependencies FROM telemetry_definitions d JOIN telemetry_definition_revisions r ON r.tenant_id=d.tenant_id AND r.id=d.latest_revision_id`;

export function checkDefinitionAccess(row: {project_id:number|null;dependencies?:unknown}, access:TelemetryAccess, write=false) {
  if(access.projectId!=null && (write ? Number(row.project_id)!==access.projectId : row.project_id!=null&&Number(row.project_id)!==access.projectId)) throw new TelemetryError('not_found','Definition not found in your scope.',404);
  if(access.projectId!=null){
    const inspect=(value:any)=>{
      if(Array.isArray(value)){value.forEach(inspect);return;}
      if(!value||typeof value!=='object')return;
      if(value.scope?.project_id!=null&&Number(value.scope.project_id)!==access.projectId)throw new TelemetryError('not_found','A referenced resource is outside your telemetry scope.',404);
      for(const child of Object.values(value))inspect(child);
    };
    inspect(row.dependencies);
  }
}
export async function listDefinitions(db:Db,access:TelemetryAccess,kind:DefinitionKind,scope:TelemetryScope={}) {
  const project=scope.project_id??access.projectId;
  const rows=await db.all<DefinitionRow>(`${querySelect} WHERE d.tenant_id=? AND d.kind=? AND d.archived_at IS NULL${project==null?'':' AND (d.project_id IS NULL OR d.project_id=?)'} ORDER BY d.name,d.id`,access.tenantId,kind,...(project==null?[]:[project]));
  return rows.filter(row=>{
    try{checkDefinitionAccess(row,access);}catch(error){if(error instanceof TelemetryError)return false;throw error;}
    return (!scope.workflow_id||!row.scope.workflow_id||row.scope.workflow_id===scope.workflow_id)&&(!scope.workflow_type||!row.scope.workflow_type||row.scope.workflow_type===scope.workflow_type)&&(!scope.task_type||!row.scope.task_type||row.scope.task_type===scope.task_type);
  });
}
export async function getDefinition(db:Db,access:TelemetryAccess,kind:DefinitionKind,id:string,withRevisions=true) {
  const row=await db.get<DefinitionRow>(`${querySelect} WHERE d.tenant_id=? AND d.kind=? AND d.id=?`,access.tenantId,kind,id);
  if(!row) throw new TelemetryError('not_found','Definition not found.',404);
  checkDefinitionAccess(row,access);
  const revisions=withRevisions?await db.all<any>('SELECT id,revision,definition,dependencies,hash,actor,created_at FROM telemetry_definition_revisions WHERE tenant_id=? AND definition_id=? ORDER BY revision DESC',access.tenantId,id):undefined;
  // A safe latest revision must not grant access to older private dependencies.
  for(const revision of revisions??[])checkDefinitionAccess({project_id:row.project_id,dependencies:revision.dependencies},access);
  return {...row,...(revisions?{revisions}:{})};
}
export async function getRevision(db:Db,access:TelemetryAccess,id:string,kind?:DefinitionKind) {
  const row=await db.get<any>(`SELECT r.*,d.kind,d.scope,d.project_id,d.key,d.name,d.archived_at,d.validation_state FROM telemetry_definition_revisions r JOIN telemetry_definitions d ON d.tenant_id=r.tenant_id AND d.id=r.definition_id WHERE r.tenant_id=? AND r.id=?`,access.tenantId,id);
  if(!row || (kind&&row.kind!==kind)) throw new TelemetryError('unknown_reference','Definition revision not found.',404);
  checkDefinitionAccess(row,access);
  if(row.validation_state==='draft')throw new TelemetryError('invalid_definition','This imported definition has unresolved references. Edit and validate it before use.');
  return row;
}

/** Resolve revision references with one authority, a bounded DAG and scope checks. */
export async function compileDefinition(db:Db,access:TelemetryAccess,raw:any,scope:TelemetryScope,profileRevisionId?:string,stack:string[]=[],catalog?:CatalogDescriptor[],pinnedSignals?:TelemetrySignal[]):Promise<{definition:MetricDefinition;dependencies:any}> {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw new TelemetryError('invalid_definition','Metric definition must be an object.');
  const profileId=profileRevisionId??raw.profile_revision_id;
  if(profileRevisionId&&raw.profile_revision_id&&profileRevisionId!==raw.profile_revision_id) throw new TelemetryError('invalid_definition','Binding conflicts with the pinned profile revision.');
  const profile=profileId?await getRevision(db,access,profileId,'profile'):null;
  if(profile && !scopeMatches(profile.scope,scope)) throw new TelemetryError('incompatible_scope','Profile scope does not cover this metric population.');
  const dependencies:any={profile_revision_id:profileId??null,metric_revision_ids:[],catalog:[],signals:[]};
  const liveCatalog=await getTelemetryCatalog(db,access,scope),liveSignals=[...liveCatalog.statuses,...liveCatalog.outcomes];
  let nodes=0;
  async function expand(value:any):Promise<any> {
    if(++nodes>500) throw new TelemetryError('query_limit_exceeded','Definition exceeds 500 expression nodes.');
    if(Array.isArray(value)) return Promise.all(value.map(expand));
    if(!value||typeof value!=='object') return value;
    if('signal_ref' in value) {
      const key=String(value.signal_ref).replace(/^profile\./,'');
      if(!profile?.definition?.signals?.[key]) throw new TelemetryError('unknown_reference',`Missing profile signal: ${key}.`);
      const compiled=compileSignalPredicates(profile.definition.signals[key],liveSignals,scope,raw.grain,profile.dependencies?.signals);
      dependencies.signals.push(...compiled.signals);
      return expand(compiled.value);
    }
    if('metric_ref' in value) {
      const id=String(value.metric_ref);
      if(stack.includes(id)||stack.length>=10) throw new TelemetryError('invalid_definition','Metric dependencies contain a cycle or exceed 10 components.');
      const revision=await getRevision(db,access,id,'metric');
      if(!scopeMatches(revision.scope,scope)) throw new TelemetryError('incompatible_scope','Component scope is incompatible with the query population.');
      const component=await compileDefinition(db,access,revision.definition,scope,undefined,[...stack,id],catalog,revision.dependencies?.signals);
      if(component.definition.grain!==raw.grain||component.definition.time_basis!==raw.time_basis||component.definition.attribution!==raw.attribution) throw new TelemetryError('incompatible_comparison','Component grain, attribution and time basis must match.');
      if(component.definition.measure.kind!=='aggregate') throw new TelemetryError('unsupported_operation','Ratio components must reduce to an aggregate.');
      dependencies.metric_revision_ids.push(id,...component.dependencies.metric_revision_ids);
      dependencies.signals.push(...component.dependencies.signals);
      const measure={...component.definition.measure};
      if(component.definition.population) measure.where=measure.where?{all:[component.definition.population,measure.where]}:component.definition.population;
      return measure;
    }
    const next:Record<string,unknown>={};
    for(const [key,item] of Object.entries(value)) {
      if(key==='__proto__'||key==='constructor'||key==='prototype') throw new TelemetryError('invalid_definition','Invalid expression key.');
      next[key]=await expand(item);
    }
    return next;
  }
  const source={...raw};delete source.profile_revision_id;
  const expanded=await expand(source);
  const descriptors=catalog??liveCatalog.fields;
  const signals=compileSignalPredicates(expanded,liveSignals,scope,raw.grain,pinnedSignals);
  const definition=parseMetricDefinition(signals.value,descriptors);
  dependencies.signals=[...new Map([...dependencies.signals,...signals.signals].map((signal:TelemetrySignal)=>[signal.id,signal])).values()];
  const refs=validateMetricDefinition(definition,descriptors).references;
  dependencies.catalog=descriptors.filter(field=>refs.includes(field.id));
  dependencies.metric_revision_ids=[...new Set(dependencies.metric_revision_ids)];
  if(dependencies.metric_revision_ids.length>10) throw new TelemetryError('query_limit_exceeded','At most 10 component metrics are supported.');
  return {definition,dependencies};
}

export const reportSchema=z.object({
  metrics:z.array(telemetryWidgetSchema).min(1).max(10),
  presentation:z.enum(['report','view','dashboard']).optional(),
  scope:scopeSchema.optional(),from:z.string().optional(),to:z.string().optional(),timezone:z.string().optional(),group_by:z.array(z.unknown()).max(3).optional(),
  comparison:z.object({compatible:z.boolean(),key:z.string().min(1),semantic_version:z.string().min(1)}).strict().optional(),
}).strict().superRefine((report,ctx)=>{
  if(report.presentation==='view'&&report.metrics.length!==1)ctx.addIssue({code:'custom',path:['metrics'],message:'A saved view contains exactly one metric.'});
  const ids=report.metrics.map(metric=>metric.id).filter(Boolean);
  if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',path:['metrics'],message:'Widget IDs must be unique.'});
});
export async function validateStoredDefinition(db:Db,access:TelemetryAccess,kind:DefinitionKind,definition:any,scope:TelemetryScope,profileId?:string) {
  if(kind==='metric') {
    const compiled=await compileDefinition(db,access,definition,scope,profileId);
    return {definition:profileId?{...definition,profile_revision_id:profileId}:definition,dependencies:compiled.dependencies};
  }
  if(kind==='profile') {
    const profile=z.object({signals:z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),z.unknown()).refine(v=>Object.keys(v).length>0&&Object.keys(v).length<=30,'Provide 1–30 named signals.')}).strict().parse(definition);
    const live=await getTelemetryCatalog(db,access,scope),catalog=live.fields,signals=new Map<string,TelemetrySignal>();
    const references=new Set<string>();
    for(const predicate of Object.values(profile.signals)){
      const compiled=compileSignalPredicates(predicate,[...live.statuses,...live.outcomes],scope,'event');
      for(const signal of compiled.signals)signals.set(signal.id,signal);
      const probe=parseMetricDefinition({version:1,key:'profile_validation',name:'Profile signal',grain:'event',time_basis:'event_occurred_at',missing_policy:'exclude_and_report',measure:{kind:'aggregate',aggregate:'count_if',where:compiled.value}},catalog);
      for(const reference of validateMetricDefinition(probe,catalog).references)references.add(reference);
    }
    return {definition:profile,dependencies:{catalog:catalog.filter(field=>references.has(field.id)),signals:[...signals.values()]}};
  }
  const report=reportSchema.parse(definition);
  if(report.presentation){
    for(const key of ['from','to'] as const)if(report[key]&&!z.string().datetime({offset:true}).safeParse(report[key]).success)throw new TelemetryError('invalid_definition',`${key} must be an ISO timestamp with an explicit offset.`);
    if(report.from&&report.to&&Date.parse(report.from)>=Date.parse(report.to))throw new TelemetryError('invalid_definition','The report time range must end after it starts.');
    try{new Intl.DateTimeFormat('en',{timeZone:report.timezone??'UTC'}).format();}catch{throw new TelemetryError('invalid_definition','Use a valid IANA timezone.');}
  }
  const reportScope=await resolveScope(db,access,report.scope??scope);
  if(!scopeMatches(scope,reportScope)) throw new TelemetryError('incompatible_scope','Report filters must stay inside its saved scope.');
  const definitions=[];
  for(const metric of report.metrics) {
    const revision=await getRevision(db,access,metric.metric_revision_id,'metric');
    if(metric.metric_id&&metric.metric_id!==revision.definition_id)throw new TelemetryError('invalid_definition','Metric family and revision disagree.');
    if(report.presentation)metric.metric_id=revision.definition_id;
    if(metric.view || report.presentation){
      try{new Intl.DateTimeFormat('en',{timeZone:metric.view?.timezone??report.timezone??'UTC'}).format();}catch{throw new TelemetryError('invalid_definition','Use a valid widget IANA timezone.');}
      const widgetScope=await resolveScope(db,access,intersectScopes(reportScope,intersectScopes(revision.scope,metric.view?.scope??{})));
      const raw={...revision.definition,...(metric.view?.group_by?{group_by:metric.view.group_by}:{}),...(metric.view?.bucket!==undefined?{bucket:metric.view.bucket??undefined}:{})};
      if(metric.view?.filter)raw.population=raw.population?{all:[raw.population,metric.view.filter]}:metric.view.filter;
      const live=await getTelemetryCatalog(db,access,widgetScope);
      const pinned=new Map(live.fields.map(field=>[field.id,field]));
      for(const field of revision.dependencies?.catalog??[])pinned.set(field.id,field);
      const checked=await compileDefinition(db,access,raw,widgetScope,undefined,[revision.id],[...pinned.values()],revision.dependencies?.signals);
      const issue=viewDisplayIssue(checked.definition,metric.display);
      if(issue)throw new TelemetryError('invalid_definition',issue);
      if(checked.definition.time_basis==='current'&&(metric.view?.from||metric.view?.to))throw new TelemetryError('invalid_definition','Current snapshot widgets cannot have a historical time override.');
      const from=metric.view?.from??report.from,to=metric.view?.to??report.to;
      if(checked.definition.time_basis!=='current'&&from&&to&&Date.parse(from)>=Date.parse(to))throw new TelemetryError('invalid_definition','The widget time override conflicts with the report time range.');
    }
    definitions.push({metric_revision_id:revision.id,definition:revision.definition,scope:revision.scope,dependencies:revision.dependencies});
  }
  if(report.comparison?.compatible) validateComparison(definitions.map(d=>d.definition),report.comparison);
  return {definition:{...report,scope:reportScope},dependencies:{metrics:definitions}};
}
export function validateComparison(definitions:MetricDefinition[],contract:{key:string;semantic_version:string}) {
  const first=definitions[0];
  for(const definition of definitions) {
    if(definition.comparison_contract?.key!==contract.key||definition.comparison_contract?.semantic_version!==contract.semantic_version) throw new TelemetryError('incompatible_comparison','Each metric must explicitly declare this comparison contract.');
    for(const key of ['grain','unit','time_basis','attribution','missing_policy'] as const) if((definition[key]??null)!==(first[key]??null)) throw new TelemetryError('incompatible_comparison',`Comparison ${key} differs.`);
    for(const key of ['counting','denominator','cancellation','max_attempts'] as const) if((definition.journey?.[key]??null)!==(first.journey?.[key]??null)) throw new TelemetryError('incompatible_comparison',`Journey ${key} differs.`);
    if(definition.measure.kind!==first.measure.kind) throw new TelemetryError('incompatible_comparison','Measure types differ.');
    if(definition.measure.kind==='ratio'&&first.measure.kind==='ratio'){
      for(const component of ['numerator','denominator']as const)if(definition.measure[component].aggregate!==first.measure[component].aggregate)throw new TelemetryError('incompatible_comparison',`The ${component} aggregation differs.`);
    }
  }
}
export async function createDefinition(db:Db,access:TelemetryAccess,kind:DefinitionKind,raw:unknown) {
  const input=creationSchema.parse(raw); const scope=await resolveScope(db,access,input.scope??{},true);
  const checked=await validateStoredDefinition(db,access,kind,input.definition,scope,input.profile_revision_id);
  const id=randomUUID(),revisionId=randomUUID();
  await db.withTransaction(async tx=>{
    await tx.run(`INSERT INTO telemetry_definitions (id,tenant_id,kind,key,name,description,scope,scope_key,project_id) VALUES (?,?,?,?,?,?,?::jsonb,?,?)`,id,access.tenantId,kind,input.key,input.name,input.description??'',JSON.stringify(scope),scopeKey(scope),scope.project_id??null);
    await tx.run(`INSERT INTO telemetry_definition_revisions (id,tenant_id,definition_id,revision,definition,dependencies,hash,actor) VALUES (?,?,?,1,?::jsonb,?::jsonb,?,?)`,revisionId,access.tenantId,id,JSON.stringify(checked.definition),JSON.stringify(checked.dependencies),contentHash(checked.definition),access.actor);
    await tx.run('UPDATE telemetry_definitions SET latest_revision_id=?,revision=1 WHERE tenant_id=? AND id=?',revisionId,access.tenantId,id);
  });
  return getDefinition(db,access,kind,id);
}
export async function reviseDefinition(db:Db,access:TelemetryAccess,kind:DefinitionKind,id:string,raw:unknown) {
  const input=revisionSchema.parse(raw); const old=await getDefinition(db,access,kind,id,false);checkDefinitionAccess(old,access,true);
  if(old.archived_at) throw new TelemetryError('archived_definition','Restore or clone this archived definition before editing.');
  if(old.latest_revision_id!==input.expected_revision_id) throw new TelemetryError('revision_conflict','The definition changed. Reload it before saving.',409);
  const checked=await validateStoredDefinition(db,access,kind,input.definition,old.scope,input.profile_revision_id);
  const revisionId=randomUUID();
  await db.withTransaction(async tx=>{
    const result=await tx.run("UPDATE telemetry_definitions SET latest_revision_id=?,revision=revision+1,name=?,description=?,validation_state='active',validation_issues='[]'::jsonb,updated_at=clock_timestamp() WHERE tenant_id=? AND id=? AND latest_revision_id=?",revisionId,input.name??old.name,input.description??old.description,access.tenantId,id,input.expected_revision_id);
    if(!result.changes) throw new TelemetryError('revision_conflict','The definition changed. Reload it before saving.',409);
    await tx.run(`INSERT INTO telemetry_definition_revisions (id,tenant_id,definition_id,revision,definition,dependencies,hash,actor) VALUES (?,?,?,?,?::jsonb,?::jsonb,?,?)`,revisionId,access.tenantId,id,old.revision+1,JSON.stringify(checked.definition),JSON.stringify(checked.dependencies),contentHash(checked.definition),access.actor);
  });
  const affected=await db.value<number>('SELECT count(*) FROM telemetry_metric_bindings WHERE tenant_id=? AND metric_revision_id=?',access.tenantId,old.latest_revision_id);
  return {...await getDefinition(db,access,kind,id),impact:{previous_revision_id:old.latest_revision_id,pinned_bindings_unchanged:Number(affected),definitions_changed:contentHash(old.definition)!==contentHash(checked.definition)}};
}
export async function archiveDefinition(db:Db,access:TelemetryAccess,kind:DefinitionKind,id:string) {
  const row=await getDefinition(db,access,kind,id,false);checkDefinitionAccess(row,access,true);
  await db.run('UPDATE telemetry_definitions SET archived_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=? AND id=?',access.tenantId,id);
  return {id,archived:true,referenced_revisions_preserved:true};
}
async function fieldReferenceIssues(db:Db,tenantId:number,fields:TelemetryField[]):Promise<string[]> {
  const pinned=[...new Map(fields.filter(field=>field.source?.generation).map(field=>[field.source!.generation!,field])).values()];
  if(!pinned.length)return [];
  // Canonical writers change this ledger even when no catalog has been read.
  const rows=await db.all<{generation:string}>('SELECT generation FROM telemetry_field_generations WHERE tenant_id=? AND active AND generation=ANY(?::uuid[])',tenantId,pinned.map(field=>field.source!.generation));
  const live=new Set(rows.map(row=>row.generation));
  return pinned.filter(field=>!live.has(field.source!.generation!)).map(field=>`Custom field ${field.label??field.key??field.id} (${field.key??field.source!.field_key}) was retired; historical identity remains pinned.`);
}
export async function listBindings(db:Db,access:TelemetryAccess,scope:TelemetryScope={}) {
  const project=scope.project_id??access.projectId;
  const rows=await db.all<any>(`SELECT * FROM telemetry_metric_bindings WHERE tenant_id=?${project==null?'':' AND (project_id IS NULL OR project_id=?)'} ORDER BY family_key,id`,access.tenantId,...(project==null?[]:[project]));
  const visible=[];
  for(const row of rows.filter(row=>!scope.workflow_id||!row.scope.workflow_id||row.scope.workflow_id===scope.workflow_id)){
    try{
      const revision=row.metric_revision_id?await getRevision(db,access,row.metric_revision_id,'metric'):null;
      const profile=row.profile_revision_id?await getRevision(db,access,row.profile_revision_id,'profile'):null;
      const health=await signalReferenceHealth(db,access.tenantId,[...(revision?.dependencies?.signals??[]),...(profile?.dependencies?.signals??[])]);
      const fieldIssues=await fieldReferenceIssues(db,access.tenantId,[...(revision?.dependencies?.catalog??[]),...(profile?.dependencies?.catalog??[])]);
      const issues=[...new Set([...health.issues,...fieldIssues])];
      visible.push({...row,validation_state:issues.length?'needs_attention':'active',validation_issues:issues});
    }catch(error){if(error instanceof TelemetryError&&[403,404].includes(error.status))continue;throw error;}
  }
  return visible.sort((a,b)=>bindingRank(b.scope)-bindingRank(a.scope));
}
export function winningBinding(bindings:any[],familyKey:string,context:TelemetryScope) {
  const matches=bindings.filter(row=>row.family_key===familyKey&&scopeMatches(row.scope,context)).sort((a,b)=>bindingRank(b.scope)-bindingRank(a.scope));
  if(matches.length>1&&bindingRank(matches[0].scope)===bindingRank(matches[1].scope)) throw new TelemetryError('ambiguous_binding','More than one binding wins at the same specificity.');
  return matches[0]??null;
}
const bindingChoiceSchema=z.object({metric_revision_id:z.string().nullable().optional(),profile_revision_id:z.string().nullable().optional(),disabled:z.boolean().default(false)}).strict();
async function validateBindingChoice(db:Db,access:TelemetryAccess,scope:TelemetryScope,input:z.infer<typeof bindingChoiceSchema>) {
  if(!input.disabled&&!input.metric_revision_id) throw new TelemetryError('invalid_definition','An enabled binding requires a metric revision.');
  if(input.metric_revision_id) {
    const revision=await getRevision(db,access,input.metric_revision_id,'metric');
    if(!scopeMatches(revision.scope,scope)) throw new TelemetryError('incompatible_scope','Metric scope does not cover this binding.');
    if(input.disabled){if(input.profile_revision_id)await getRevision(db,access,input.profile_revision_id,'profile');return;}
    const compiled=await compileDefinition(db,access,revision.definition,scope,input.profile_revision_id??undefined,[],undefined,revision.dependencies?.signals);
    const health=await signalReferenceHealth(db,access.tenantId,compiled.dependencies.signals);
    if(health.state==='needs_attention')throw new TelemetryError('unknown_reference','Retired status/outcome references require a new revision before activating this binding.',400,health.issues);
  } else if(input.profile_revision_id) await getRevision(db,access,input.profile_revision_id,'profile');
}
/** Read-only selected-context explanation; incomplete contexts disclose deeper overrides. */
export async function previewBinding(db:Db,access:TelemetryAccess,raw:unknown) {
  const input=z.object({family_key:z.string().min(1).max(128),scope:scopeSchema,override:bindingChoiceSchema.optional()}).strict().parse(raw);
  const scope=await resolveScope(db,access,input.scope,true);
  const bindings=(await listBindings(db,access,scope)).filter(row=>row.family_key===input.family_key);
  const inspect=(rows:any[])=>{
    const winner=winningBinding(rows,input.family_key,scope);
    const compatible=(row:any)=>Object.entries(row.scope).every(([key,value])=>key==='include_archived'||(scope as any)[key]===undefined||(scope as any)[key]===value);
    return {
      winner,
      origin:winner?(scopeKey(winner.scope)===scopeKey(scope)?'exact':'inherited'):'unbound',
      shadowed:rows.filter(row=>row!==winner&&scopeMatches(row.scope,scope)),
      narrower:rows.filter(row=>compatible(row)&&!scopeMatches(row.scope,scope)),
    };
  };
  const current=inspect(bindings);
  if(!input.override)return {family_key:input.family_key,scope,current};
  await validateBindingChoice(db,access,scope,input.override);
  const old=bindings.find(row=>scopeKey(row.scope)===scopeKey(scope));
  const proposed={...old,id:old?.id??'proposed',family_key:input.family_key,scope,metric_revision_id:input.override.metric_revision_id??null,profile_revision_id:input.override.profile_revision_id??null,disabled:input.override.disabled,version:old?.version??0};
  const unchanged=old&&['metric_revision_id','profile_revision_id','disabled'].every(key=>old[key]===proposed[key as keyof typeof proposed]);
  return {family_key:input.family_key,scope,current,proposed:inspect([...bindings.filter(row=>row!==old),proposed].sort((a,b)=>bindingRank(b.scope)-bindingRank(a.scope))),effect:unchanged?'unchanged':proposed.disabled?'disable':old?'replace':'create'};
}
export async function saveBinding(db:Db,access:TelemetryAccess,raw:unknown) {
  const input=z.object({family_key:z.string().min(1).max(128),scope:scopeSchema,metric_revision_id:z.string().nullable().optional(),profile_revision_id:z.string().nullable().optional(),disabled:z.boolean().default(false),expected_version:z.number().int().nonnegative().optional()}).strict().parse(raw);
  const scope=await resolveScope(db,access,input.scope,true);
  await validateBindingChoice(db,access,scope,input);
  return db.withTransaction(async tx=>{
    const old=await tx.get<any>('SELECT * FROM telemetry_metric_bindings WHERE tenant_id=? AND family_key=? AND scope_key=? FOR UPDATE',access.tenantId,input.family_key,scopeKey(scope));
    if(old&&input.expected_version!==old.version) throw new TelemetryError('revision_conflict','Supply the current binding version before replacing it.',409);
    if(!old&&input.expected_version&&input.expected_version!==0) throw new TelemetryError('revision_conflict','Binding no longer exists.',409);
    const id=old?.id??randomUUID();
    if(old) await tx.run('UPDATE telemetry_metric_bindings SET metric_revision_id=?,profile_revision_id=?,disabled=?,version=version+1,actor=?,updated_at=clock_timestamp() WHERE tenant_id=? AND id=?',input.metric_revision_id??null,input.profile_revision_id??null,input.disabled,access.actor,access.tenantId,id);
    else await tx.run(`INSERT INTO telemetry_metric_bindings (id,tenant_id,family_key,scope,scope_key,project_id,metric_revision_id,profile_revision_id,disabled,actor) VALUES (?,?,?,?::jsonb,?,?,?,?,?,?)`,id,access.tenantId,input.family_key,JSON.stringify(scope),scopeKey(scope),scope.project_id??null,input.metric_revision_id??null,input.profile_revision_id??null,input.disabled,access.actor);
    const binding=await tx.get<any>('SELECT * FROM telemetry_metric_bindings WHERE tenant_id=? AND id=?',access.tenantId,id);
    await tx.run('INSERT INTO telemetry_binding_audit (id,tenant_id,binding_id,before_value,after_value,actor) VALUES (?,?,?,?::jsonb,?::jsonb,?)',randomUUID(),access.tenantId,id,old?JSON.stringify(old):null,JSON.stringify(binding),access.actor);
    return {binding};
  });
}
