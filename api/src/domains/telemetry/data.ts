import type { Db } from '../../db/adapter/types';
import { type TelemetryAccess, type TelemetryScope, TelemetryError } from './access';
import { catalogFieldValues, contentHash, parseObject, type TelemetryField } from './catalog';
import type { MetricDefinition, Predicate, TelemetryEntity, TelemetryObservation } from './contracts';
import { getTelemetryCoverage, type TelemetryObservationRow } from './capture';
import { validateMetricDefinition } from './evaluator';

export function isoTimestamp(raw:unknown):string|undefined {
  if(raw instanceof Date) return raw.toISOString();
  if(typeof raw!=='string'||!raw.trim()) return undefined;
  const text=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(raw)?raw.replace(' ','T')+'Z':raw;
  const date=new Date(text);return Number.isFinite(date.getTime())?date.toISOString():undefined;
}
function normalize(snapshot:Record<string,any>,fields:TelemetryField[]):Record<string,any> {
  const value=catalogFieldValues(snapshot,fields);
  for(const key of ['created_at','updated_at','started_at','ended_at','completed_at','runtime_ended_at']) if(value[key]!=null) value[key]=isoTimestamp(value[key])??null;
  if('token_input' in snapshot) value.tokens_in=snapshot.token_input;
  if('token_output' in snapshot) value.tokens_out=snapshot.token_output;
  if('runtime_end_success' in snapshot) value.runtime_ended_success=snapshot.runtime_end_success==null?null:Number(snapshot.runtime_end_success)===1;
  if('semantic_outcome_missing' in snapshot) value.semantic_outcome_missing=snapshot.semantic_outcome_missing==null?null:[0,1].includes(Number(snapshot.semantic_outcome_missing))?Number(snapshot.semantic_outcome_missing)===1:null;
  if('state' in snapshot) value.runtime_state=snapshot.state;
  if('effective_model' in snapshot) value.model=snapshot.effective_model;
  if(!value.ended_at) value.ended_at=value.runtime_ended_at??value.completed_at??null;
  const start=isoTimestamp(value.started_at),end=isoTimestamp(value.ended_at);
  value.runtime_duration_ms=start&&end?Math.max(0,Date.parse(end)-Date.parse(start)):null;
  return value;
}
function taskWhere(access:TelemetryAccess,scope:TelemetryScope,alias='t') {
  const conditions=[`${alias}.tenant_id = ?`],params:unknown[]=[access.tenantId];
  if(scope.project_id!=null){conditions.push(`${alias}.project_id = ?`);params.push(scope.project_id);}
  if(scope.workflow_id!=null){conditions.push(`${alias}.sprint_id = ?`);params.push(scope.workflow_id);}
  if(scope.workflow_type){conditions.push('s.sprint_type = ?');params.push(scope.workflow_type);}
  if(scope.task_type){conditions.push(`${alias}.task_type = ?`);params.push(scope.task_type);}
  if(scope.include_archived===false)conditions.push("s.status <> 'closed'");
  return {sql:conditions.join(' AND '),params};
}

const coreHistoricalSources = ['tasks','job_instances','runtime_executions','task_history','external_task_event_receipts','task_dependencies','task_relationships'];
/** Absence claims need coverage for every selected producer, not just task status writes. */
export function requiredMetricSources(definition:MetricDefinition):string[] {
  const sources = new Set<string>(['tasks']);
  const visit = (value:unknown):void => {
    if(Array.isArray(value)){value.forEach(visit);return;}
    if(!value||typeof value!=='object')return;
    const row=value as Record<string,any>;
    if(row.field==='event.type'){
      const types=Array.isArray(row.value)?row.value:[row.value];
      if(!['eq','in'].includes(row.op)||types.some(type=>typeof type!=='string'))coreHistoricalSources.forEach(source=>sources.add(source));
      else for(const type of types){
        if(type.startsWith('runtime.'))sources.add('runtime_executions');
        else if(type.startsWith('run.'))sources.add('job_instances');
        else if(type==='task.outcome')sources.add('task_history');
        else if(type==='task.external_event')sources.add('external_task_event_receipts');
        else if(type.startsWith('task.relationship'))sources.add('task_relationships');
        else if(type==='task.dependencies_changed')sources.add('task_dependencies');
        else if(!['task.created','task.changed','task.deleted','task.bootstrap'].includes(type))coreHistoricalSources.forEach(source=>sources.add(source));
      }
    }
    if(row.field==='event.outcome'||row.field==='event.outcome_identity')sources.add('task_history');
    if(typeof row.field==='string'&&/(?:^|\.)(?:status|from_status|to_status|outcome)_identity$/.test(row.field))sources.add('telemetry_signals');
    if(typeof row.field==='string'&&(/event\.(runtime|semantic)/.test(row.field))){sources.add('runtime_executions');sources.add('job_instances');}
    if(typeof row.field==='string'&&row.field.includes('unresolved_dependencies'))['tasks','task_dependencies','task_relationships','task_statuses','sprint_task_statuses','sprint_type_task_statuses'].forEach(source=>sources.add(source));
    for(const child of Object.values(row))visit(child);
  };
  visit(definition);
  if(definition.grain==='run')sources.add('job_instances');
  if(definition.grain==='runtime_execution')sources.add('runtime_executions');
  return [...sources];
}
function requiresObservations(definition:MetricDefinition,references:string[]):boolean{
  if(definition.time_basis!=='current'||references.includes('instruction_fingerprint'))return true;
  if(definition.attribution&&definition.attribution!=='assigned_agent_current')return true;
  const historicalValue=(value:unknown):boolean=>{
    if(Array.isArray(value))return value.some(historicalValue);
    if(!value||typeof value!=='object')return false;
    const node=value as Record<string,unknown>;
    return 'event_count' in node||'event_exists' in node||'duration' in node||
      (typeof node.basis==='string'&&node.basis!=='current')||
      (typeof node.field==='string'&&(node.field.startsWith('event.')||node.field.startsWith('journey.')))||Object.values(node).some(historicalValue);
  };
  return historicalValue(definition);
}
function historicalScopePredicate(scope:TelemetryScope,grain:MetricDefinition['grain']):Predicate|undefined {
  const conditions:Predicate[]=[];
  for(const field of ['project_id','workflow_id','workflow_type','task_type'] as const)if(scope[field]!==undefined)conditions.push({field,basis:grain==='journey'?'at_entry':'at_event',op:'eq',value:scope[field]!});
  return conditions.length?{all:conditions}:undefined;
}
function historicalTaskWhere(access:TelemetryAccess,scope:TelemetryScope,asOf:string){
  const conditions=['t.tenant_id=?'],params:unknown[]=[access.tenantId];
  // Current source authorization and historical population selection are independent.
  if(access.projectId!=null){conditions.push('t.project_id=?');params.push(access.projectId);}
  const observed=['o.tenant_id=t.tenant_id','o.task_id=t.id','o.occurred_at<=?::timestamptz'],observedParams:unknown[]=[asOf];
  for(const field of ['project_id','workflow_id','workflow_type','task_type'] as const)if(scope[field]!==undefined){
    observed.push(`COALESCE(o.payload->'context'->>?,o.payload->'after'->>?)=?`); observedParams.push(field,field,String(scope[field]));
  }
  if(observed.length>3){
    // Current members without old observations must remain visible as unknown
    // history. Only the event/entry predicate can admit historical samples.
    const current=taskWhere(access,scope);
    conditions.push(`(EXISTS(SELECT 1 FROM telemetry_observations o WHERE ${observed.join(' AND ')}) OR (${current.sql}))`);
    params.push(...observedParams,...current.params);
  }
  if(scope.include_archived===false)conditions.push("s.status <> 'closed'");
  return {sql:conditions.join(' AND '),params};
}
export async function loadMetricData(db:Db,access:TelemetryAccess,scope:TelemetryScope,definition:MetricDefinition,fields:TelemetryField[],asOf:string,entityLimit:number,allowedTaskIds?:number[]) {
  if(access.projectId!=null){
    if(scope.project_id!=null&&scope.project_id!==access.projectId)throw new TelemetryError('forbidden','Telemetry source scope cannot exceed the credential project.',403);
    scope={...scope,project_id:access.projectId};
  }
  const grain=definition.grain;
  const historical=grain==='event'||grain==='journey';
  const references=validateMetricDefinition(definition,fields).references;
  const loadObservations=requiresObservations(definition,references);
  if(!['task','event','journey'].includes(grain)&&fields.some(field=>field.source&&references.includes(field.id)))throw new TelemetryError('unsupported_operation','Task custom fields require task, event or journey grain. Run/entity allocation of task values is not defined.');
  const where=historical?historicalTaskWhere(access,scope,asOf):taskWhere(access,scope);
  if(allowedTaskIds){where.sql+=' AND t.id=ANY(?::bigint[])';where.params.push(allowedTaskIds);}
  const taskRows=['task','event','journey','run','runtime_execution'].includes(grain)?await db.all<{id:number;snapshot:Record<string,any>;workflow_status:string}>(`SELECT t.id,telemetry_task_snapshot(to_jsonb(t)) AS snapshot,s.status AS workflow_status
    FROM tasks t JOIN sprints s ON s.id=t.sprint_id AND s.tenant_id=t.tenant_id
    WHERE ${where.sql} ORDER BY t.id LIMIT ?`,...where.params,entityLimit+1):[];
  if(taskRows.length>entityLimit) throw new TelemetryError('query_limit_exceeded',`This population exceeds ${entityLimit} tasks. Narrow the scope or use a background query.`,413);
  const taskIds=taskRows.map(row=>Number(row.id));
  const taskSnapshots=new Map<number,Record<string,any>>(taskRows.map(row=>[Number(row.id),{...row.snapshot,workflow_status:row.workflow_status}]));
  // Prerequisites are unresolved according to the blocker workflow's configured
  // terminality. Existence of a dependency alone is never a blockage signal.
  const dependencyRows=taskIds.length?await db.all<any>(`SELECT d.blocked_id,b.project_id,b.id IS NOT NULL AS visible,
    COALESCE(ws.terminal,ts.terminal,gs.terminal,0) AS terminal
    FROM task_dependencies d LEFT JOIN tasks b ON b.id=d.blocker_id AND b.tenant_id=?
    LEFT JOIN sprints bs ON bs.id=b.sprint_id AND bs.tenant_id=b.tenant_id
    LEFT JOIN sprint_task_statuses ws ON ws.sprint_id=b.sprint_id AND ws.status_key=b.status
    LEFT JOIN sprint_type_task_statuses ts ON ts.tenant_id=b.tenant_id AND ts.sprint_type_key=bs.sprint_type AND ts.status_key=b.status
    LEFT JOIN task_statuses gs ON gs.name=b.status WHERE d.blocked_id = ANY(?::bigint[])`,access.tenantId,taskIds):[];
  const dependenciesByTask=new Map<number,any[]>();
  for(const dependency of dependencyRows){const id=Number(dependency.blocked_id);const rows=dependenciesByTask.get(id)??[];rows.push(dependency);dependenciesByTask.set(id,rows);}
  for(const [id,snapshot] of taskSnapshots){
    const deps=dependenciesByTask.get(id)??[];
    snapshot.unresolved_dependencies=deps.some(row=>!row.visible)||(access.projectId!=null&&deps.some(row=>Number(row.project_id)!==access.projectId))?null:deps.filter(row=>Number(row.terminal)!==1).length;
  }
  const history=await getTelemetryCoverage(db,access.tenantId,access.projectId==null?undefined:[access.projectId]);
  const requiredSources=requiredMetricSources(definition);
  const requiredCoverage=requiredSources.map(source=>history.sources.find(row=>row.source===source));
  const boundary=new Date(Math.max(...requiredCoverage.map(row=>Math.max(Date.parse(isoTimestamp(row?.capture_started_at)??asOf),row?.retained_from?Date.parse(isoTimestamp(row.retained_from)!):-Infinity)))).toISOString();
  const complete=requiredCoverage.every(row=>row?.instrumented&&row.capture_started_at&&row.pending===0);
  const baseCoverage={from:boundary,to:asOf,complete,sources:requiredSources,reason:complete?'Durable capture covers all producers selected by this definition.':'A selected producer is uninstrumented or observations are pending.'};
  const entities:TelemetryEntity[]=[];
  if(['task','event','journey'].includes(grain)) for(const [id,snapshot] of taskSnapshots) entities.push({id,kind:'task',fields:normalize(snapshot,fields),coverage:baseCoverage});
  if(grain==='run'||grain==='runtime_execution') {
    const joins='LEFT JOIN tasks t ON t.id=j.task_id AND t.tenant_id=j.tenant_id LEFT JOIN sprints s ON s.id=t.sprint_id AND s.tenant_id=t.tenant_id JOIN agents a ON a.id=j.agent_id AND a.tenant_id=j.tenant_id';
    const conditions=['j.tenant_id=?'],params:unknown[]=[access.tenantId];
    if(scope.project_id!=null){conditions.push('COALESCE(t.project_id,a.project_id)=?');params.push(scope.project_id);}
    if(scope.workflow_id!=null){conditions.push('t.sprint_id=?');params.push(scope.workflow_id);}
    if(scope.workflow_type){conditions.push('s.sprint_type=?');params.push(scope.workflow_type);}
    if(scope.task_type){conditions.push('t.task_type=?');params.push(scope.task_type);}
    if(scope.include_archived===false)conditions.push("(s.id IS NULL OR s.status <> 'closed')");
    if(allowedTaskIds){conditions.push('j.task_id=ANY(?::bigint[])');params.push(allowedTaskIds);}
    const rows=grain==='run'?await db.all<any>(`SELECT j.id,j.task_id,COALESCE(t.project_id,a.project_id) AS project_id,telemetry_run_snapshot(to_jsonb(j)) AS snapshot FROM job_instances j ${joins} WHERE ${conditions.join(' AND ')} ORDER BY j.id LIMIT ?`,...params,entityLimit+1):
      await db.all<any>(`SELECT r.id,j.task_id,j.agent_id,COALESCE(t.project_id,a.project_id) AS project_id,
        jsonb_build_object('id',r.id,'state',r.state,'runtime_type',r.runtime_type,'started_at',r.started_at,'ended_at',r.ended_at,'created_at',r.created_at,'instance_id',r.instance_id,'boundary_fingerprint',r.boundary_fingerprint) AS snapshot
        FROM runtime_executions r JOIN job_instances j ON j.id=r.instance_id AND j.tenant_id=r.tenant_id ${joins} WHERE ${conditions.join(' AND ')} ORDER BY r.id LIMIT ?`,...params,entityLimit+1);
    if(rows.length>entityLimit) throw new TelemetryError('query_limit_exceeded',`This population exceeds ${entityLimit} executions.`,413);
    for(const row of rows){
      const snapshot={...(taskSnapshots.get(Number(row.task_id))??{}),...row.snapshot,project_id:row.project_id,task_id:row.task_id};
      if(row.agent_id!=null)snapshot.agent_id=Number(row.agent_id);
      delete snapshot.agent_config_at_observation; // Current agent instructions are not historical run attribution.
      entities.push({id:row.id,kind:grain,fields:normalize(snapshot,fields),coverage:baseCoverage});
    }
  }
  if(grain==='project'||grain==='workflow'||grain==='agent') {
    let rows:any[]=[];
    if(grain==='project') rows=await db.all(`SELECT id,name AS title,id AS project_id,created_at FROM projects WHERE tenant_id=?${scope.project_id==null?'':' AND id=?'} ORDER BY id LIMIT ?`,access.tenantId,...(scope.project_id==null?[]:[scope.project_id]),entityLimit+1);
    else if(grain==='workflow') rows=await db.all(`SELECT id,name AS title,id AS workflow_id,project_id,sprint_type AS workflow_type,status,created_at FROM sprints WHERE tenant_id=?${scope.project_id==null?'':' AND project_id=?'}${scope.workflow_id==null?'':' AND id=?'}${scope.workflow_type?' AND sprint_type=?':''} ORDER BY id LIMIT ?`,access.tenantId,...(scope.project_id==null?[]:[scope.project_id]),...(scope.workflow_id==null?[]:[scope.workflow_id]),...(scope.workflow_type?[scope.workflow_type]:[]),entityLimit+1);
    else rows=await db.all(`SELECT id,name AS title,id AS agent_id,project_id,runtime_type,created_at FROM agents WHERE tenant_id=?${scope.project_id==null?'':' AND project_id=?'} ORDER BY id LIMIT ?`,access.tenantId,...(scope.project_id==null?[]:[scope.project_id]),entityLimit+1);
    if(rows.length>entityLimit)throw new TelemetryError('query_limit_exceeded','Entity limit exceeded.',413);
    for(const row of rows)entities.push({id:row.id,kind:grain,fields:normalize(row,fields),coverage:baseCoverage});
  }
  // Load the complete observed journey for a tenant operator, even if it moves
  // scopes after entry. Project credentials additionally constrain historical
  // context; a gap moves the coverage boundary instead of proving absence.
  const entityIds=entities.map(entity=>Number(entity.id));
  const isTask=['task','event','journey'].includes(grain);
  const obsWhere=isTask?'o.task_id = ANY(?::bigint[])':'o.entity_type = ? AND o.entity_id = ANY(?::bigint[])';
  const observationLimit=Math.min(250000,entityLimit*20);
  const historicalProject="COALESCE(o.payload->'context'->>'project_id',o.payload->'after'->>'project_id')";
  const constrainHistory=loadObservations&&access.projectId!=null;
  // Effective time limits contributions, not knowledge of corrections. Load
  // every superseder in the authorized population so chains/forks retract
  // their parents even when the corrected event moves beyond as_of.
  const observationRows=loadObservations&&entityIds.length?await db.all<TelemetryObservationRow>(`SELECT o.* FROM telemetry_observations o WHERE o.tenant_id=? AND ${obsWhere} AND (o.occurred_at<=?::timestamptz OR jsonb_exists(o.payload,'supersedes_source_key'))${constrainHistory?` AND ${historicalProject}=?`:''} ORDER BY o.occurred_at,o.sequence LIMIT ?`,access.tenantId,...(isTask?[entityIds]:[grain,entityIds]),asOf,...(constrainHistory?[String(access.projectId)]:[]),observationLimit+1):[];
  if(constrainHistory&&entityIds.length){
    const entityColumn=isTask?'task_id':'entity_id';
    const gaps=await db.all<{entity_id:number;through:Date}>(`SELECT o.${entityColumn} AS entity_id,MAX(o.occurred_at) AS through FROM telemetry_observations o WHERE o.tenant_id=? AND ${obsWhere} AND o.occurred_at<=?::timestamptz AND ${historicalProject} IS DISTINCT FROM ? GROUP BY o.${entityColumn}`,access.tenantId,...(isTask?[entityIds]:[grain,entityIds]),asOf,String(access.projectId));
    const gapMap=new Map(gaps.map(gap=>[Number(gap.entity_id),Date.parse(isoTimestamp(gap.through)!)+1]));
    for(const entity of entities){const through=gapMap.get(Number(entity.id));if(through!==undefined)entity.coverage={...baseCoverage,from:new Date(Math.max(Date.parse(baseCoverage.from),through)).toISOString(),
      // A current inventory's event_count/duration has no new entry boundary
      // after a move; redacted history cannot establish a complete zero count.
      complete:historical?baseCoverage.complete:false,reason:'Historical context outside the current project is unavailable before this boundary.'};}
  }
  if(observationRows.length>observationLimit) throw new TelemetryError('query_limit_exceeded','Observation budget exceeded. Narrow the population or use a background query.',413);
  const observations:TelemetryObservation[]=[];
  const entitiesById=new Map(entities.map(entity=>[Number(entity.id),entity]));
  const observationIdsBySource=new Map(observationRows.map(row=>[row.source_key,row.id]));
  const supersededSources=new Set(observationRows.map(row=>parseObject(row.payload).supersedes_source_key).filter((key):key is string=>typeof key==='string'));
  const causalOutcomes=new Map<string,Set<string>>();
  const causalOutcomeIdentities=new Map<string,Set<string>>();
  for(const row of observationRows)if(row.causation_id&&row.kind==='task.outcome'&&!supersededSources.has(row.source_key)&&Date.parse(isoTimestamp(row.occurred_at)!)<=Date.parse(asOf)){
    const outcomeSnapshot=parseObject(parseObject(row.payload).after),outcome=outcomeSnapshot.outcome;
    if(typeof outcome==='string'){
      const key=`${row.task_id}:${row.causation_id}`;const values=causalOutcomes.get(key)??new Set<string>();values.add(outcome);causalOutcomes.set(key,values);
      if(typeof outcomeSnapshot.outcome_identity==='string'){const identities=causalOutcomeIdentities.get(key)??new Set<string>();identities.add(outcomeSnapshot.outcome_identity);causalOutcomeIdentities.set(key,identities);}
    }
  }
  for(const row of observationRows){
    const payload=parseObject(row.payload),context=normalize(parseObject(payload.context),fields);
    const stateSnapshots=row.source==='tasks'||row.kind==='task.dependencies_changed';
    const before=normalize({...(!stateSnapshots?parseObject(payload.context):{}),...parseObject(payload.before)},fields),after=normalize({...(!stateSnapshots?parseObject(payload.context):{}),...parseObject(payload.after)},fields);
    const beforeVisible=access.projectId==null||Number(before.project_id)===access.projectId;
    // A scope-move event belongs to its new context, but its before snapshot can
    // still contain another project's private fields. Never expose that side.
    if(!beforeVisible)for(const key of Object.keys(before))delete before[key];
    for(const snapshot of [before,after,context])if(snapshot.dependencies_within_tenant===false||(access.projectId!=null&&snapshot.dependencies_within_project===false))snapshot.unresolved_dependencies=null;
    const eventFields:Record<string,unknown>={...after,source:row.source,outcome:after.outcome??null,actor:payload.actor??null,
      actor_agent_id:payload.actor_agent_id??null,executing_agent_id:['run','runtime_execution'].includes(row.entity_type)?row.agent_id??null:null,
      ...(row.kind==='task.outcome'?{outcome_agent_id:payload.outcome_agent_id??null}:{})};
    const correction=typeof payload.supersedes_source_key==='string'?{supersedes:observationIdsBySource.get(payload.supersedes_source_key)}:{};
    const outcomes=row.causation_id?causalOutcomes.get(`${row.task_id}:${row.causation_id}`):null;
    if(outcomes?.size===1){
      eventFields.outcome=[...outcomes][0];
      const identities=causalOutcomeIdentities.get(`${row.task_id}:${row.causation_id}`);
      eventFields.outcome_identity=identities?.size===1?[...identities][0]:null;
    }
    let type=row.kind;
    if(row.entity_type==='runtime_execution'&&after.runtime_state==='failed'&&before.runtime_state!=='failed')type='runtime.failed';
    if(row.entity_type==='runtime_execution'&&after.runtime_state==='succeeded'&&before.runtime_state!=='succeeded')type='runtime.succeeded';
    if(row.entity_type==='run'&&after.status==='failed'&&before.status!=='failed')type='run.failed';
    if(row.entity_type==='run'&&after.runtime_ended_success===false&&before.runtime_ended_success!==false)eventFields.runtime_failed=true;
    // Run/runtime state is not a task status transition; preserve its evidence
    // as event fields without letting a provider status act as a business milestone.
    if(isTask&&row.entity_type!=='task') {
      observations.push({id:row.id,entity_id:row.task_id!,entity_kind:'task',type,occurred_at:isoTimestamp(row.occurred_at)!,recorded_at:isoTimestamp(row.recorded_at),sequence:Number(row.sequence),causation_id:row.causation_id,fields:eventFields,before:context,after:context,context,provenance:row.provenance,...correction});
    } else {
      const rawBefore=parseObject(payload.before),rawAfter=parseObject(payload.after);
      if(row.source==='tasks'&&row.kind!=='task.bootstrap'&&(row.kind==='task.created'||(rawBefore.status!==undefined&&rawBefore.status!==rawAfter.status))){
        eventFields.from_status=beforeVisible?rawBefore.status??null:null;eventFields.to_status=rawAfter.status??null;
        eventFields.from_status_identity=beforeVisible?rawBefore.status_identity??null:null;eventFields.to_status_identity=rawAfter.status_identity??null;
      }
      observations.push({id:row.id,entity_id:row.entity_id,entity_kind:row.entity_type as TelemetryEntity['kind'],type,occurred_at:isoTimestamp(row.occurred_at)!,recorded_at:isoTimestamp(row.recorded_at),sequence:Number(row.sequence),causation_id:row.causation_id,fields:eventFields,before,after,context,provenance:row.provenance,...correction});
    }
    if(row.kind==='run.created'&&grain==='run'){
      const entity=entitiesById.get(Number(row.entity_id));
      const config=parseObject(parseObject(payload.after).agent_config_at_observation);
      if(entity) {entity.fields.instruction_fingerprint=config.instructions_fingerprint??null;entity.fields.runtime_type=config.runtime_type??entity.fields.runtime_type;}
    }
  }
  // Backfill does not establish complete old history. Its evidence can contribute
  // positive milestones, but cannot prove absence of rework before the boundary.
  const dataRevision=contentHash({entities,observations:observationRows.map(row=>row.id),coverage:baseCoverage});
  const sourceProjects=[...new Set(entities.map(entity=>entity.fields.project_id).filter(value=>value!=null).map(Number).filter(Number.isFinite))];
  return {entities,observations,history:{...history,required_sources:requiredSources},coverageWindow:baseCoverage,dataRevision,taskIds,sourceProjects,scopePredicate:historical?historicalScopePredicate(scope,grain):undefined};
}
