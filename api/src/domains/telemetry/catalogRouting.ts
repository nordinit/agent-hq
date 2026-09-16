import type { Db } from '../../db/adapter/types';
import { annotateTransitionScope } from '../routing/scope';
import { TelemetryError, type TelemetryAccess, type TelemetryScope } from './access';
import type { Predicate } from './contracts';

/** Inspectable predicate templates over recorded evidence, not new routing rules. */
export interface TelemetryRoutingSignal {
  id:string; key:string; label:string; scope:TelemetryScope; predicate:Predicate;
  source:{table:'sprint_task_transitions'|'external_event_mappings';id:number};
  enabled:boolean; priority:number;
}
function scopeOf(row:Record<string,any>):TelemetryScope {
  return {...(row.project_id==null?{}:{project_id:Number(row.project_id)}),
    ...(row.workflow_id==null?{}:{workflow_id:Number(row.workflow_id)}),
    ...(row.workflow_type?{workflow_type:row.workflow_type}:{}),...(row.task_type?{task_type:row.task_type}:{})};
}
function inRecordedScope(scope:TelemetryScope,predicates:Predicate[]):Predicate {
  return {all:[...Object.entries(scope).map(([field,value]):Predicate=>({field,basis:'at_event',op:'eq',value})),...predicates]};
}
function strings(value:unknown):string[] {
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{return [];}}
  return Array.isArray(value)?value.filter((entry):entry is string=>typeof entry==='string'):[];
}

export async function getRoutingCatalogSignals(db:Db,access:TelemetryAccess,scope:TelemetryScope,allowedTypes:Set<string>){
  const project=scope.project_id??access.projectId;
  async function rows(table:'sprint_task_transitions'|'external_event_mappings',columns:string,inheritGlobal:boolean){
    const projectExpr='COALESCE(r.project_id,s.project_id)',typeExpr='COALESCE(r.sprint_type,s.sprint_type)';
    const clauses=['r.tenant_id=?','(r.sprint_id IS NULL OR s.id IS NOT NULL)',
      `(r.project_id IS NULL OR p.id IS NOT NULL)`,
      '(r.sprint_id IS NULL OR r.project_id IS NULL OR r.project_id=s.project_id)',
      '(r.sprint_id IS NULL OR r.sprint_type IS NULL OR r.sprint_type=s.sprint_type)'];
    const params:unknown[]=[access.tenantId];
    if(project!=null){clauses.push(`(${projectExpr}=?${inheritGlobal?` OR ${projectExpr} IS NULL`:''})`);params.push(project);}
    if(scope.workflow_type){clauses.push(`(${typeExpr}=?${inheritGlobal?` OR ${typeExpr} IS NULL`:''})`);params.push(scope.workflow_type);}
    if(scope.workflow_id){clauses.push('(r.sprint_id IS NULL OR r.sprint_id=?)');params.push(scope.workflow_id);}
    else if(scope.workflow_type)clauses.push('r.sprint_id IS NULL');
    if(scope.task_type){clauses.push('(r.task_type IS NULL OR r.task_type=?)');params.push(scope.task_type);}
    const result=await db.all<Record<string,any>>(`SELECT r.id,r.sprint_id AS workflow_id,${projectExpr} AS project_id,
      ${typeExpr} AS workflow_type,r.task_type,r.enabled,r.priority,${columns}
      FROM ${table} r LEFT JOIN sprints s ON s.id=r.sprint_id AND s.tenant_id=r.tenant_id
      LEFT JOIN projects p ON p.id=r.project_id AND p.tenant_id=r.tenant_id
      WHERE ${clauses.join(' AND ')} ORDER BY r.priority DESC,r.id LIMIT 1001`,...params);
    if(result.length>1000)throw new TelemetryError('query_limit_exceeded','Routing catalog exceeds 1,000 entries. Narrow the workflow scope.',413);
    return result.filter(row=>!row.workflow_type||allowedTypes.has(row.workflow_type));
  }
  const transitionRows=await rows('sprint_task_transitions','r.from_status,r.outcome,r.to_status',false);
  const annotated=annotateTransitionScope(transitionRows.map(row=>({...row,sprint_id:row.workflow_id,
    rule_scope_kind:row.workflow_id==null?'sprint_type_default':'sprint_override'})),scope.workflow_id??null);
  const routing_transitions=annotated.map(raw=>{
    const row=raw as Record<string,any>,signalScope=scopeOf(row);
    return {id:`transition:${row.id}`,key:String(row.id),label:`${row.from_status} → ${row.to_status} (${row.outcome})`,
      scope:signalScope,source:{table:'sprint_task_transitions' as const,id:Number(row.id)},enabled:Number(row.enabled)===1,priority:Number(row.priority),
      from_status:row.from_status,outcome:row.outcome,to_status:row.to_status,
      is_inherited:row.is_inherited,is_override:row.is_override,effective_for_workflow:row.effective_for_sprint,
      predicate:inRecordedScope(signalScope,[{field:'event.type',op:'eq',value:'task.changed'},
        {field:'event.from_status',op:'eq',value:row.from_status},{field:'event.outcome',op:'eq',value:row.outcome},
        {field:'event.to_status',op:'eq',value:row.to_status}])} satisfies TelemetryRoutingSignal & Record<string,unknown>;
  });
  const mappingRows=await rows('external_event_mappings','r.source,r.event_name,r.status_includes_json,r.status_excludes_json,r.action_kind,r.action_target',true);
  const event_mappings=mappingRows.map(row=>{
    const signalScope=scopeOf(row);
    return {id:`event_mapping:${row.id}`,key:String(row.id),label:`${row.event_name}${row.source?` (${row.source})`:''} → ${row.action_kind}${row.action_target?` ${row.action_target}`:''}`,
      scope:signalScope,source:{table:'external_event_mappings' as const,id:Number(row.id)},enabled:Number(row.enabled)===1,priority:Number(row.priority),
      event_name:row.event_name,event_source:row.source,action_kind:row.action_kind,action_target:row.action_target,
      status_includes:strings(row.status_includes_json),status_excludes:strings(row.status_excludes_json),
      is_inherited:row.workflow_id==null,is_override:scope.workflow_id!=null&&Number(row.workflow_id)===scope.workflow_id,
      predicate:inRecordedScope(signalScope,[{field:'event.type',op:'eq',value:'task.external_event'},
        {field:'event.event',op:'eq',value:row.event_name},{field:'event.mapping_id',op:'eq',value:Number(row.id)},
        {field:'event.processing_state',op:'eq',value:'processed'}])} satisfies TelemetryRoutingSignal & Record<string,unknown>;
  });
  return {routing_transitions,event_mappings};
}
