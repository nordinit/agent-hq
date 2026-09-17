import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { Db } from '../../db/adapter/types';
import { TelemetryError, type TelemetryAccess, type TelemetryScope, scopeSchema, resolveScope, intersectScopes, bindingRank } from './access';
import { contentHash, getTelemetryCatalog, type TelemetryField } from './catalog';
import { compileDefinition, getRevision, listBindings, winningBinding, validateComparison, getDefinition } from './definitions';
import { loadMetricData, isoTimestamp } from './data';
import { drainTelemetryOutbox } from './capture';
import { compileSignalPredicates } from './signals';
import { enforceTelemetryRetention } from './retention';
import { evaluateMetric, rollupRatios, parseMetricDefinition } from './evaluator';
import type { MetricDefinition, MetricResult, Predicate, ValueExpression } from './contracts';

export const telemetryQuerySchema=z.object({
  definition:z.unknown().optional(),metric_revision_id:z.string().optional(),report_revision_id:z.string().optional(),family_key:z.string().optional(),
  scope:scopeSchema.optional(),from:z.string().optional(),to:z.string().optional(),as_of:z.string().optional(),timezone:z.string().optional(),
  group_by:z.array(z.unknown()).max(3).optional(),bucket:z.enum(['hour','day','week','month']).nullable().optional(),filter:z.unknown().optional(),background:z.boolean().optional(),profile_revision_id:z.string().optional(),
}).strict().refine(input=>[input.definition!==undefined,!!input.metric_revision_id,!!input.report_revision_id,!!input.family_key].filter(Boolean).length===1,'Choose one draft, metric revision, report revision, or metric family.');
export type TelemetryQuery=z.infer<typeof telemetryQuerySchema>;
type QueryPlan={definition:MetricDefinition;scope:TelemetryScope;dependencies:any;title:string;metric_revision_id?:string;binding_id?:string;fields:TelemetryField[];allowed_task_ids?:number[];window?:{from?:string;to?:string;timezone?:string};display?:string};
export const DEFAULT_TELEMETRY_SETTINGS={query_retention_hours:1,snapshot_retention_days:30,max_snapshots:100,interactive_entities:10000,background_entities:50000,history_retention_days:90};
export async function getTelemetrySettings(db:Db,tenantId:number){
  const row=await db.get<any>('SELECT * FROM telemetry_settings WHERE tenant_id=?',tenantId);return {...DEFAULT_TELEMETRY_SETTINGS,...row};
}
export async function updateTelemetrySettings(db:Db,access:TelemetryAccess,raw:unknown){
  if(access.projectId!=null)throw new TelemetryError('forbidden','Only a tenant operator can change telemetry retention and workload limits.',403);
  const current=await getTelemetrySettings(db,access.tenantId);delete current.tenant_id;delete current.updated_at;
  const values=z.object({query_retention_hours:z.number().int().min(1).max(168),snapshot_retention_days:z.number().int().min(1).max(365),max_snapshots:z.number().int().min(1).max(1000),interactive_entities:z.number().int().min(100).max(50000),background_entities:z.number().int().min(100).max(50000),history_retention_days:z.number().int().min(1).max(3650)}).strict().parse({...current,...raw as object});
  await db.run(`INSERT INTO telemetry_settings (tenant_id,query_retention_hours,snapshot_retention_days,max_snapshots,interactive_entities,background_entities,history_retention_days) VALUES (?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET query_retention_hours=EXCLUDED.query_retention_hours,snapshot_retention_days=EXCLUDED.snapshot_retention_days,max_snapshots=EXCLUDED.max_snapshots,interactive_entities=EXCLUDED.interactive_entities,background_entities=EXCLUDED.background_entities,history_retention_days=EXCLUDED.history_retention_days,updated_at=clock_timestamp()`,access.tenantId,...Object.keys(DEFAULT_TELEMETRY_SETTINGS).map(key=>values[key as keyof typeof values]));
  return getTelemetrySettings(db,access.tenantId);
}
function temporalQuery(input:TelemetryQuery):TelemetryQuery & {as_of:string;timezone:string}{
  for(const field of ['as_of','from','to'] as const)if(input[field]&&!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(input[field]!))throw new TelemetryError('invalid_definition',`${field} must be an ISO timestamp with an explicit UTC offset.`);
  const asOf=input.as_of?isoTimestamp(input.as_of):new Date().toISOString();
  if(!asOf)throw new TelemetryError('invalid_definition','Invalid as_of timestamp.');
  for(const field of ['from','to'] as const)if(input[field]&&!isoTimestamp(input[field]))throw new TelemetryError('invalid_definition',`Invalid ${field} timestamp.`);
  const from=input.from?isoTimestamp(input.from):undefined,to=input.to?isoTimestamp(input.to):undefined;
  if(from&&to&&from>=to)throw new TelemetryError('invalid_definition','The time range must end after it starts.');
  const timezone=input.timezone??'UTC';
  try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}catch{throw new TelemetryError('invalid_definition','Use a valid IANA timezone.');}
  if(Date.parse(asOf)>Date.now()+5000)throw new TelemetryError('invalid_definition','as_of cannot be in the future.');
  return {...input,from,to,as_of:asOf,timezone};
}
async function planQuery(db:Db,access:TelemetryAccess,input:TelemetryQuery):Promise<{plans:QueryPlan[];input:TelemetryQuery;scope:TelemetryScope;comparison?:any;unbound?:number;disabled?:number}>{
  let scope=await resolveScope(db,access,input.scope??{});
  const plans:QueryPlan[]=[];
  async function add(raw:any,metricScope:TelemetryScope,revision?:any,profileId?:string,extra?:Partial<QueryPlan>,view?:any){
    const settings={...input,...view,filter:input.filter&&view?.filter?{all:[input.filter,view.filter]}:view?.filter??input.filter};
    const merged=await resolveScope(db,access,intersectScopes(scope,metricScope));
    const catalog=await getTelemetryCatalog(db,access,merged);
    const fields=[...catalog.fields];
    // A saved revision retains descriptors even if the live field was retired.
    for(const descriptor of revision?.dependencies?.catalog??[]){
      const index=fields.findIndex(field=>field.id===descriptor.id);
      if(index<0)fields.push({...descriptor,retired:true});
      else fields[index]={...descriptor};
    }
    const compiled=await compileDefinition(db,access,raw,merged,profileId,revision?[revision.id]:[],fields,revision?.dependencies?.signals);
    const definition={...compiled.definition};
    if(settings.filter){
      // An ad-hoc filter is pinned for this calculation independently of the
      // saved definition's older signal identities.
      const filter=compileSignalPredicates(settings.filter,[...catalog.statuses,...catalog.outcomes],merged,definition.grain);
      definition.population=definition.population?{all:[definition.population,filter.value as Predicate]}:filter.value as Predicate;
      compiled.dependencies.signals=[...new Map([...(compiled.dependencies.signals??[]),...filter.signals].map(signal=>[signal.id,signal])).values()];
    }
    if(settings.group_by)definition.group_by=settings.group_by as ValueExpression[];
    if(settings.bucket!==undefined){if(settings.bucket===null)delete definition.bucket;else definition.bucket=settings.bucket;}
    parseMetricDefinition(definition,fields);
    plans.push({definition,scope:merged,dependencies:compiled.dependencies,title:revision?.name??definition.name,metric_revision_id:revision?.id,fields,...extra});
    if(plans.length>10)throw new TelemetryError('query_limit_exceeded','At most 10 definition partitions can be evaluated together. Narrow the scope.');
  }
  if(input.report_revision_id){
    const report=await getRevision(db,access,input.report_revision_id,'report');
    scope=await resolveScope(db,access,intersectScopes(scope,report.definition.scope??report.scope));
    input={...report.definition,...input,scope,from:input.from??report.definition.from,to:input.to??report.definition.to,timezone:input.timezone??report.definition.timezone,group_by:input.group_by??report.definition.group_by};
    for(const card of report.definition.metrics){
      const metric=await getRevision(db,access,card.metric_revision_id,'metric');
      const window=report.definition.presentation||card.view ? temporalQuery({...input,timezone:card.view?.timezone??input.timezone,from:metric.definition.time_basis==='current'?undefined:card.view?.from??input.from,to:metric.definition.time_basis==='current'?undefined:card.view?.to??input.to}) : undefined;
      await add(metric.definition,intersectScopes(metric.scope,card.view?.scope??{}),metric,undefined,{title:card.title??metric.name,display:card.display,...(window?{window:{from:window.from,to:window.to,timezone:window.timezone}}:{})},card.view);
    }
    if(report.definition.comparison?.compatible)validateComparison(plans.map(plan=>plan.definition),report.definition.comparison);
    return {plans,input,scope,comparison:report.definition.comparison};
  }
  if(input.metric_revision_id){const revision=await getRevision(db,access,input.metric_revision_id,'metric');await add(revision.definition,revision.scope,revision,input.profile_revision_id);}
  else if(input.definition!==undefined)await add(input.definition,scope,undefined,input.profile_revision_id);
  else {
    const bindings=(await listBindings(db,access,scope)).filter(binding=>binding.family_key===input.family_key);
    if(bindings.length>50)throw new TelemetryError('query_limit_exceeded','Family resolution supports at most 50 applicable bindings. Narrow the scope.');
    const sourceWhere=['t.tenant_id=?'],sourceParams:unknown[]=[access.tenantId];
    // Credentials authorize the current task before any historical context is read.
    if(access.projectId!=null){sourceWhere.push('t.project_id=?');sourceParams.push(access.projectId);}
    if(scope.include_archived===false)sourceWhere.push("s.status <> 'closed'");
    const currentWhere=[...sourceWhere],currentParams=[...sourceParams];
    const historicalWhere=[...sourceWhere,'o.tenant_id=t.tenant_id','o.task_id=t.id','o.occurred_at<=?::timestamptz'],historicalParams=[...sourceParams,temporalQuery(input).as_of];
    const recorded=(field:string)=>`COALESCE(o.payload->'context'->>'${field}',o.payload->'after'->>'${field}')`;
    if(access.projectId!=null){historicalWhere.push(`${recorded('project_id')}=?`);historicalParams.push(String(access.projectId));}
    for(const [field,column] of [['project_id','t.project_id'],['workflow_id','t.workflow_id'],['workflow_type','s.workflow_type'],['task_type','t.task_type']] as const){
      if(scope[field]===undefined)continue;
      currentWhere.push(`${column}=?`);currentParams.push(scope[field]);
      historicalWhere.push(`${recorded(field)}=?`);historicalParams.push(String(scope[field]));
    }
    // A task can have several historical contexts; task IDs alone cannot select
    // the correct formula after it moves. Context predicates below keep its
    // event or entry cohort in exactly one winning binding partition.
    const contexts=await db.all<any>(`SELECT t.id,t.project_id,t.workflow_id AS workflow_id,s.workflow_type AS workflow_type,t.task_type,true AS is_current
      FROM tasks t JOIN workflows s ON s.id=t.workflow_id AND s.tenant_id=t.tenant_id WHERE ${currentWhere.join(' AND ')}
      UNION SELECT t.id,(${recorded('project_id')})::bigint AS project_id,(${recorded('workflow_id')})::bigint AS workflow_id,
        ${recorded('workflow_type')} AS workflow_type,${recorded('task_type')} AS task_type,false AS is_current
      FROM tasks t JOIN workflows s ON s.id=t.workflow_id AND s.tenant_id=t.tenant_id JOIN telemetry_observations o ON o.task_id=t.id
      WHERE ${historicalWhere.join(' AND ')} ORDER BY id,is_current DESC LIMIT 100001`,...currentParams,...historicalParams);
    if(contexts.length>100000)throw new TelemetryError('query_limit_exceeded','Family resolution exceeds 100,000 task contexts. Narrow the scope.');
    const partitions=new Map<string,{binding:any;revision:any;ids:Set<number>}>(),revisions=new Map<string,any>();
    const unboundIds=new Set<number>(),disabledIds=new Set<number>();
    for(const context of contexts){
      const winner=winningBinding(bindings,input.family_key!,context),id=Number(context.id);
      if(!winner){unboundIds.add(id);continue;}if(winner.disabled){disabledIds.add(id);continue;}
      let revision=revisions.get(winner.metric_revision_id);
      if(!revision){revision=await getRevision(db,access,winner.metric_revision_id,'metric');revisions.set(winner.metric_revision_id,revision);}
      const historical=['event','journey'].includes(revision.definition.grain);
      // Current members without recorded context still need an unavailable
      // historical result, rather than disappearing as if no binding existed.
      if(!historical&&!context.is_current)continue;
      const partition=partitions.get(winner.id)??{binding:winner,revision,ids:new Set<number>()};partition.ids.add(id);partitions.set(winner.id,partition);
    }
    for(const {binding,revision,ids} of partitions.values()){
      if(!['task','event','journey','run','runtime_execution'].includes(revision.definition.grain))throw new TelemetryError('unsupported_operation','Task-context family bindings require task, event, journey, run, or runtime grain. Query other metrics by revision.');
      let definition=revision.definition;
      if(['event','journey'].includes(definition.grain)){
        const basis=definition.grain==='journey'?'at_entry':'at_event';
        const match=(bindingScope:TelemetryScope):Predicate=>{
          const parts:Predicate[]=Object.entries(bindingScope).filter(([field])=>field!=='include_archived').map(([field,value])=>({all:[{field,basis,op:'is_present'},{field,basis,op:'eq',value}]} as Predicate));
          return parts.length?{all:parts}:{left:{literal:true},op:'eq',right:{literal:true}};
        };
        const eligibility:Predicate[]=[match(binding.scope),...bindings.filter(other=>other.id!==binding.id&&bindingRank(other.scope)>=bindingRank(binding.scope)).map(other=>({not:match(other.scope)} as Predicate))];
        const selected:Predicate={all:eligibility};
        definition={...definition,population:definition.population?{all:[definition.population,selected]}:selected};
      }
      await add(definition,revision.scope,revision,binding.profile_revision_id??undefined,{binding_id:binding.id,allowed_task_ids:[...ids]});
    }
    const unbound=unboundIds.size,disabled=disabledIds.size;
    return {plans,input,scope,unbound,disabled};
  }
  return {plans,input,scope};
}
const publicResult=(result:any):any=>{
  if(!result)return result;
  const {contributors,...visible}=result;
  return {...visible,...(Array.isArray(result.results)?{results:result.results.map(publicResult)}:{})};
};
async function evaluatePlans(db:Db,access:TelemetryAccess,planned:Awaited<ReturnType<typeof planQuery>>,input:ReturnType<typeof temporalQuery>,entityLimit:number){
  const results:any[]=[],tasks=new Set<number>(),projects=new Set<number>();
  // One snapshot for all cards; the workload is bounded before proof retention.
  await db.withTransaction(async tx=>{
    if(!db.inTransaction)await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await tx.get('SELECT set_config(?, ?, true)','statement_timeout',input.background?'30000':'5000');
    for(const plan of planned.plans){
      const period=plan.window??input;
      if(plan.definition.time_basis==='current'&&input.as_of&&Date.now()-Date.parse(input.as_of)>5000)throw new TelemetryError('unsupported_operation','Historical as_of is unavailable for current inventory. Query recorded milestones or open the retained result.');
      const data=await loadMetricData(tx,access,plan.scope,plan.definition,plan.fields,input.as_of,entityLimit,plan.allowed_task_ids);
      const result=evaluateMetric({definition:plan.definition,entities:data.entities,observations:data.observations,catalog:plan.fields,as_of:input.as_of,from:period.from,to:period.to,timezone:period.timezone??input.timezone,data_revision:data.dataRevision,max_samples:entityLimit,max_observations:Math.min(250000,entityLimit*20),filter:data.scopePredicate});
      // A positive observed event is usable evidence, but an empty projection
      // during an outage (or an uncovered old interval) cannot establish zero.
      let intervalComplete=true;
      if(plan.definition.time_basis!=='current'){
        const starts=new Map<string,number>();
        for(const observation of data.observations)if(observation.type==='task.created')starts.set(`${observation.entity_kind??'task'}:${observation.entity_id}`,Date.parse(observation.occurred_at));
        intervalComplete=data.coverageWindow.complete&&(!period.from||Date.parse(period.from)>=Date.parse(data.coverageWindow.from));
        for(const entity of data.entities){
          const origin=starts.get(`${entity.kind}:${entity.id}`)??Date.parse(String(entity.fields.created_at??''));
          const requiredStart=period.from?Date.parse(period.from):origin;
          if(!entity.coverage?.complete||!Number.isFinite(requiredStart)||Date.parse(entity.coverage.from)>requiredStart)intervalComplete=false;
        }
        if(!intervalComplete){
          result.quality=result.sample_count>0?'partial':'unavailable';
          result.warnings.push('The requested history is not fully observed. Values describe retained evidence only; missing observations do not establish that no event occurred.');
          if(result.sample_count===0)result.value=null;
        }
      }
      for(const id of data.taskIds)tasks.add(id);for(const id of data.sourceProjects)projects.add(id);
      // Preserve source identity alongside engine proofs for reauthorization.
      const entityMap=new Map(data.entities.map(entity=>[`${entity.kind}:${entity.id}`,entity]));
      for(const contribution of result.contributors){const entity=entityMap.get(`${contribution.entity_kind}:${contribution.entity_id}`);contribution.details={...contribution.details,title:entity?.fields.title??null,project_id:entity?.fields.project_id??null,task_id:entity?.kind==='task'?entity.id:entity?.fields.task_id??null};}
      results.push({...result,title:plan.title,display:plan.display,metric_revision_id:plan.metric_revision_id,binding_id:plan.binding_id,definition:plan.definition,scope:plan.scope,versions:plan.dependencies,explanation:result.description,history:{...data.history,interval_complete:intervalComplete,available_window:data.coverageWindow}});
    }
  });
  let rollup:any;
  if(planned.comparison?.compatible&&results.every(result=>result.definition.measure.kind==='ratio')){
    const members=new Set<string>();
    for(const result of results){
      const local=new Set<string>();
      for(const contribution of result.contributors.filter((item:any)=>item.included)){
        const key=`${contribution.entity_kind}:${contribution.entity_id}:${result.definition.grain==='journey'?contribution.started_at??'':result.definition.grain==='event'?contribution.observation_ids.join(','):''}`;
        local.add(key);
      }
      for(const key of local){if(members.has(key))throw new TelemetryError('incompatible_comparison','These report measures contain overlapping samples. Show separate series or define disjoint populations.');members.add(key);}
    }
    rollup=rollupRatios(results.map((result,index)=>({result,definition:planned.plans[index].definition})));
  }
  const result=results.length===1&&!input.report_revision_id&&!input.family_key?results[0]:{results,as_of:input.as_of,unbound:planned.unbound??0,disabled:planned.disabled??0,...(rollup?{rollup}:{})};
  return {result,taskIds:[...tasks],sourceProjects:[...projects]};
}
export async function queryTelemetry(db:Db,access:TelemetryAccess,raw:unknown,options:{preview?:boolean}={}){
  let input=telemetryQuerySchema.parse(raw);
  await drainTelemetryOutbox(db,{tenantId:access.tenantId,batchSize:1000});
  const planned=await planQuery(db,access,input);input=planned.input;
  const temporal=temporalQuery(input),settings=await getTelemetrySettings(db,access.tenantId);
  const id=randomUUID(),expiresAt=new Date(Date.now()+settings.query_retention_hours*3600000).toISOString();
  if(input.background&&!options.preview){
    // Persist the resolved bundle before scheduling so later binding edits cannot
    // change the meaning of queued work. User JSON cannot supply internal plans.
    return db.withTransaction(async tx=>{
      // Reuse only the exact authorized request, pinned versions, observation
      // set, and evaluation time. This is not an approximate current-data cache.
      const dataRevision=await tx.get('SELECT count(*)::text AS rows,coalesce(sum(id),0)::text AS identity_sum FROM telemetry_outbox WHERE tenant_id=?',access.tenantId);
      const requestHash=contentHash({input:temporal,planned,access,dataRevision});
      await tx.get('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',`telemetry-query:${access.tenantId}:${requestHash}`);
      const existing=await tx.get<any>("SELECT id,state,expires_at FROM telemetry_query_results WHERE tenant_id=? AND request_hash=? AND state IN ('queued','running') AND expires_at>clock_timestamp()",access.tenantId,requestHash);
      if(existing)return {query_id:existing.id,state:existing.state,status:existing.state,expires_at:isoTimestamp(existing.expires_at),deduplicated:true};
      await tx.run("UPDATE telemetry_query_results SET state='cancelled' WHERE tenant_id=? AND request_hash=? AND state IN ('queued','running') AND expires_at<=clock_timestamp()",access.tenantId,requestHash);
      await tx.run(`INSERT INTO telemetry_query_results(id,tenant_id,project_id,scope,request,request_hash,state,actor,expires_at,report_revision_id) VALUES (?,?,?,?::jsonb,?::jsonb,?,'queued',?,?::timestamptz,?)`,id,access.tenantId,planned.scope.project_id??null,JSON.stringify(planned.scope),JSON.stringify({input:temporal,planned,access}),requestHash,access.actor,expiresAt,input.report_revision_id??null);
      return {query_id:id,state:'queued',status:'queued',expires_at:expiresAt};
    });
  }
  const evaluated=await evaluatePlans(db,access,planned,temporal,settings.interactive_entities);
  const result={...evaluated.result,query_id:id,state:'complete',status:'complete',expires_at:expiresAt,query_hash:contentHash({input:temporal,plans:planned.plans.map(({fields,...p})=>p)})};
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>32*1024*1024)throw new TelemetryError('query_limit_exceeded','Contribution evidence exceeds the 32 MB retained result limit. Narrow the query.',413);
  await db.run(`INSERT INTO telemetry_query_results(id,tenant_id,project_id,scope,request,result,state,actor,task_ids,source_projects,expires_at,report_revision_id) VALUES (?,?,?,?::jsonb,?::jsonb,?::jsonb,'complete',?,?::bigint[],?::bigint[],?::timestamptz,?)`,id,access.tenantId,planned.scope.project_id??null,JSON.stringify(planned.scope),JSON.stringify(temporal),JSON.stringify(result),access.actor,evaluated.taskIds,evaluated.sourceProjects,expiresAt,input.report_revision_id??null);
  return publicResult(result);
}
export async function getQueryRecord(db:Db,access:TelemetryAccess,id:string){
  const row=await db.get<any>('SELECT * FROM telemetry_query_results WHERE tenant_id=? AND id=?',access.tenantId,id);
  if(!row)throw new TelemetryError('not_found','Query result not found.',404);
  if(new Date(row.expires_at).getTime()<=Date.now())throw new TelemetryError('result_expired','This result expired. Recalculate it to obtain new evidence.',410);
  if(access.projectId!=null&&(Number(row.project_id)!==access.projectId||(row.source_projects??[]).some((p:any)=>Number(p)!==access.projectId)))throw new TelemetryError('not_found','Query result not found in this project.',404);
  if(row.task_ids.length){
    const live=await db.all<{id:number;project_id:number}>('SELECT id,project_id FROM tasks WHERE tenant_id=? AND id=ANY(?::bigint[])',access.tenantId,row.task_ids);
    if(live.length!==row.task_ids.length||(access.projectId!=null&&live.some(task=>Number(task.project_id)!==access.projectId)))throw new TelemetryError('result_unavailable','Source access changed. Recalculate this result.',409);
  }
  return row;
}
export async function readQuery(db:Db,access:TelemetryAccess,id:string){
  const row=await getQueryRecord(db,access,id);
  return row.result?publicResult({...row.result,expires_at:isoTimestamp(row.expires_at),snapshot:row.snapshot}):{query_id:id,state:row.state,status:row.state,error:row.error,expires_at:isoTimestamp(row.expires_at)};
}
export async function queryContributors(db:Db,access:TelemetryAccess,id:string,raw:Record<string,unknown>){
  const query=z.object({offset:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(200).default(50),metric_revision_id:z.string().optional(),metric_index:z.coerce.number().int().min(0).optional(),included:z.enum(['true','false']).optional(),group:z.string().max(4096).optional()}).strict().parse(raw);
  let group: unknown[] | undefined;
  if(query.group!==undefined){try{group=JSON.parse(query.group);}catch{throw new TelemetryError('invalid_definition','Group must be a JSON array.');}if(!Array.isArray(group)||group.length>4)throw new TelemetryError('invalid_definition','Group must contain at most four dimensions.');}
  const row=await getQueryRecord(db,access,id);
  if(row.state!=='complete')throw new TelemetryError('query_not_complete','Wait for this query to finish.',409);
  let result=row.result;
  if(result.results){
    result=query.metric_index!==undefined?result.results[query.metric_index]:query.metric_revision_id?result.results.find((item:any)=>item.metric_revision_id===query.metric_revision_id):result.results[0];
    if(!result)throw new TelemetryError('not_found','Metric result not found.',404);
  }
  const contributors=(result.contributors??[]).filter((item:any)=>(query.included===undefined||item.included===(query.included==='true'))&&(group===undefined||JSON.stringify(item.group)===JSON.stringify(group)));
  return {query_id:id,contributors:contributors.slice(query.offset,query.offset+query.limit),total:contributors.length,offset:query.offset,limit:query.limit,has_more:query.offset+query.limit<contributors.length,as_of:row.result.as_of};
}
export async function cancelQuery(db:Db,access:TelemetryAccess,id:string){
  await getQueryRecord(db,access,id);
  const result=await db.run("UPDATE telemetry_query_results SET state='cancelled' WHERE tenant_id=? AND id=? AND state IN ('queued','running')",access.tenantId,id);
  return {query_id:id,cancelled:result.changes>0};
}
export async function freezeReport(db:Db,access:TelemetryAccess,reportId:string,raw:unknown){
  const input=z.object({query_id:z.string(),name:z.string().max(200).optional(),report_revision_id:z.string().optional()}).strict().parse(raw);
  const report=await getDefinition(db,access,'report',reportId,false),query=await getQueryRecord(db,access,input.query_id);
  if(query.state!=='complete'||!query.report_revision_id)throw new TelemetryError('invalid_definition','Freeze a completed evaluation of this report.');
  const revision=await getRevision(db,access,query.report_revision_id,'report');
  if(revision.definition_id!==report.id||(input.report_revision_id&&input.report_revision_id!==revision.id))throw new TelemetryError('invalid_definition','The query belongs to a different report revision.');
  const settings=await getTelemetrySettings(db,access.tenantId);
  const expiresAt=new Date(Date.now()+settings.snapshot_retention_days*86400000).toISOString();
  await db.withTransaction(async tx=>{
    await tx.get('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',`telemetry-snapshots:${access.tenantId}`);
    await getQueryRecord(tx,access,query.id);
    const count=Number(await tx.value('SELECT count(*) FROM telemetry_query_results WHERE tenant_id=? AND snapshot=true AND id<>? AND expires_at>clock_timestamp()',access.tenantId,query.id));
    if(count>=settings.max_snapshots)throw new TelemetryError('query_limit_exceeded','Snapshot retention limit reached.');
    await tx.run('UPDATE telemetry_query_results SET snapshot=true,expires_at=?::timestamptz WHERE tenant_id=? AND id=?',expiresAt,access.tenantId,query.id);
  });
  return {query_id:query.id,snapshot:true,report_revision_id:revision.id,expires_at:expiresAt,as_of:query.result.as_of};
}
export async function listSnapshots(db:Db,access:TelemetryAccess,reportId?:string){
  if(reportId)await getDefinition(db,access,'report',reportId,false);
  const rows=await db.all<any>(`SELECT q.id AS query_id,q.report_revision_id,q.scope,q.created_at,q.expires_at,q.result->>'as_of' AS as_of FROM telemetry_query_results q LEFT JOIN telemetry_definition_revisions r ON r.tenant_id=q.tenant_id AND r.id=q.report_revision_id WHERE q.tenant_id=? AND q.snapshot=true AND q.expires_at>clock_timestamp()${access.projectId==null?'':' AND q.project_id=?'}${reportId?' AND r.definition_id=?':''} ORDER BY q.created_at DESC LIMIT 1000`,access.tenantId,...(access.projectId==null?[]:[access.projectId]),...(reportId?[reportId]:[]));
  const visible=[];for(const row of rows){try{await getQueryRecord(db,access,row.query_id);visible.push(row);}catch(error){if(!(error instanceof TelemetryError))throw error;}}
  return {snapshots:visible};
}

/** Expiring leases permit recovery after a process dies during evaluation. */
export async function runTelemetryQueryJobs(db:Db){
  const claim=randomUUID();
  const row=await db.withTransaction(async tx=>{
    const next=await tx.get<any>("SELECT * FROM telemetry_query_results WHERE (state='queued' OR (state='running' AND lease_until<clock_timestamp())) AND expires_at>clock_timestamp() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED");
    if(next)await tx.run("UPDATE telemetry_query_results SET state='running',claim_key=?,lease_until=clock_timestamp()+interval '5 minutes' WHERE id=? AND tenant_id=?",claim,next.id,next.tenant_id);return next;
  });
  if(!row)return {processed:0};
  try{
    const {input,planned,access}=row.request;
    // Current-state background queries evaluate at their actual start. Historical
    // queries retain the requested boundary; this change is visible in as_of.
    if(planned.plans.some((p:QueryPlan)=>p.definition.time_basis==='current'))input.as_of=new Date().toISOString();
    const settings=await getTelemetrySettings(db,row.tenant_id);
    const evaluated=await evaluatePlans(db,access,planned,input,settings.background_entities);
    const result={...evaluated.result,query_id:row.id,state:'complete',status:'complete',expires_at:isoTimestamp(row.expires_at)};
    if(Buffer.byteLength(JSON.stringify(result),'utf8')>32*1024*1024)throw new TelemetryError('query_limit_exceeded','Contribution evidence exceeds 32 MB. Narrow the query.');
    await db.run("UPDATE telemetry_query_results SET result=?::jsonb,state='complete',task_ids=?::bigint[],source_projects=?::bigint[],lease_until=NULL WHERE tenant_id=? AND id=? AND state='running' AND claim_key=?",JSON.stringify(result),evaluated.taskIds,evaluated.sourceProjects,row.tenant_id,row.id,claim);
  }catch(error){
    const safe={code:(error as any).code??'query_failed',message:error instanceof TelemetryError?error.message:'Query failed. Narrow the scope or inspect operator logs.'};
    await db.run("UPDATE telemetry_query_results SET state='failed',error=?::jsonb,lease_until=NULL WHERE tenant_id=? AND id=? AND state='running' AND claim_key=?",JSON.stringify(safe),row.tenant_id,row.id,claim);
  }
  return {processed:1};
}
export function startTelemetryQueryWorker(db:Db){
  let active=false;let stopped=false;
  const tick=async()=>{if(active||stopped)return;active=true;try{await runTelemetryQueryJobs(db);await enforceTelemetryRetention(db);}catch(error){console.error('[telemetry] Query worker failed:',error instanceof Error?error.message:error);}finally{active=false;}};
  const timer=setInterval(()=>void tick(),1000);timer.unref();return ()=>{stopped=true;clearInterval(timer);};
}
