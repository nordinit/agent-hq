import {createHash,randomUUID} from 'crypto';
import type {Db} from '../../db/adapter/types';
import {TelemetryError,type TelemetryAccess,type TelemetryScope} from './access';
import type {Grain} from './contracts';

export interface TelemetrySignal {
  id:string;kind:'status'|'outcome';key:string;label:string;identity:string;scope:TelemetryScope;
  revision_id?:string;terminal?:number;retired?:boolean;unregistered?:boolean;
  source?:{table:string;id:string;generation:string};
}
type SourceSignal={kind:TelemetrySignal['kind'];key:string;label:string;scope:TelemetryScope;terminal?:number;source:{table:string;id:string}};
/** Called under the catalog locks, after the canonical scope is authorized. */
export async function registerTelemetrySignals(db:Db,access:TelemetryAccess,records:SourceSignal[]):Promise<TelemetrySignal[]>{
  const generations=await db.all<{generation:string;source_table:string;source_id:string}>(`SELECT generation,source_table,source_id
    FROM telemetry_signal_generations WHERE active AND (tenant_id=? OR tenant_id IS NULL)`,access.tenantId);
  const bySource=new Map(generations.map(row=>[`${row.source_table}:${row.source_id}`,row.generation]));
  const prior=await db.all<{id:string;source_key:string;hash:string;revision_id:string}>(`SELECT e.id,e.source_key,e.hash,r.id AS revision_id
    FROM telemetry_catalog_entries e LEFT JOIN telemetry_catalog_revisions r ON r.tenant_id=e.tenant_id AND r.entry_id=e.id AND r.hash=e.hash
    WHERE e.tenant_id=? AND e.source_key LIKE 'signal:%' AND e.retired_at IS NULL`,access.tenantId);
  const entries=new Map(prior.map(row=>[row.source_key,row]));
  const result:TelemetrySignal[]=[];
  for(const record of records){
    const generation=bySource.get(`${record.source.table}:${record.source.id}`);if(!generation)continue;
    const descriptor={...record,identity:generation,source:{...record.source,generation}};
    const sourceKey=`signal:${generation}`,hash=createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
    const previous=entries.get(sourceKey);
    if(previous?.hash===hash&&previous.revision_id){result.push({...descriptor,id:previous.id,revision_id:previous.revision_id});continue;}
    let entry:{id:string}|undefined=previous;
    if(!entry){entry={id:`signal_${randomUUID()}`};await db.run(`INSERT INTO telemetry_catalog_entries(id,tenant_id,source_key,project_id,descriptor,hash)
      VALUES(?,?,?,?,?::jsonb,?)`,entry.id,access.tenantId,sourceKey,record.scope.project_id??null,JSON.stringify(descriptor),hash);}
    else await db.run('UPDATE telemetry_catalog_entries SET descriptor=?::jsonb,hash=?,project_id=? WHERE tenant_id=? AND id=?',JSON.stringify(descriptor),hash,record.scope.project_id??null,access.tenantId,entry.id);
    await db.run(`INSERT INTO telemetry_catalog_revisions(id,tenant_id,entry_id,descriptor,hash) VALUES(?,?,?,?::jsonb,?)
      ON CONFLICT(tenant_id,entry_id,hash) DO NOTHING`,randomUUID(),access.tenantId,entry.id,JSON.stringify(descriptor),hash);
    const revision=await db.value<string>('SELECT id FROM telemetry_catalog_revisions WHERE tenant_id=? AND entry_id=? AND hash=?',access.tenantId,entry.id,hash);
    result.push({...descriptor,id:entry.id,revision_id:revision});
  }
  return result;
}

/** Raw key selectors remain user-facing. Compilation substitutes the immutable
 * identities selected by that definition revision, including explicit legacy
 * unregistered keys. Missing historical identities remain unknown in data.ts.
 */
export function compileSignalPredicates<T>(raw:T,live:TelemetrySignal[],scope:TelemetryScope,grain:Grain,pinned?:TelemetrySignal[]):{value:T;signals:TelemetrySignal[]}{
  const used=new Map<string,TelemetrySignal>();let nodes=0;
  const resolve=(kind:TelemetrySignal['kind'],key:unknown)=>{
    if(typeof key!=='string')throw new TelemetryError('invalid_definition','Status and outcome selectors require string keys or catalog identities.');
    const candidates=pinned??live;
    const explicit=candidates.find(signal=>signal.id===key&&signal.kind===kind);
    let selected=explicit?[explicit]:candidates.filter(signal=>signal.kind===kind&&signal.key===key);
    if(!explicit&&pinned===undefined)selected=[...selected,{id:`unregistered:${kind}:${key}`,kind,key,label:key,
      identity:`unregistered:${kind}:${key}`,scope,unregistered:true}];
    if(!selected.length)throw new TelemetryError('unknown_reference',`The saved ${kind} reference is not pinned. Create a new definition revision.`);
    for(const signal of selected)used.set(signal.id,signal);
    if(used.size>200)throw new TelemetryError('query_limit_exceeded','A metric can pin at most 200 status/outcome identities. Narrow its scope.');
    return selected.map(signal=>signal.identity);
  };
  const identityField=(field:unknown):{field:string;kind:TelemetrySignal['kind']}|null=>{
    if(typeof field!=='string')return null;
    if(field==='event.outcome')return {field:'event.outcome_identity',kind:'outcome'};
    if(field==='event.from_status'||field==='event.to_status')return {field:`${field}_identity`,kind:'status'};
    if(['task','event','journey'].includes(grain)&&['status','event.before.status','event.after.status'].includes(field))return {field:`${field}_identity`,kind:'status'};
    return null;
  };
  const visit=(value:any):any=>{
    if(++nodes>1000)throw new TelemetryError('query_limit_exceeded','Signal selectors exceed the expression limit.');
    if(Array.isArray(value))return value.map(visit);if(!value||typeof value!=='object')return value;
    const result=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)]));
    const target=identityField(value.field);
    if(target&&['eq','ne','in','not_in'].includes(value.op)){
      const values=(Array.isArray(value.value)?value.value:[value.value]).flatMap((key:unknown)=>resolve(target.kind,key));
      return {...result,field:target.field,op:['ne','not_in'].includes(value.op)?'not_in':'in',value:[...new Set(values)]};
    }
    const left=identityField(value.left?.field),right=identityField(value.right?.field);
    if((left&&value.right&&'literal' in value.right)||(right&&value.left&&'literal' in value.left)){
      if(!['eq','ne','in','not_in'].includes(value.op))throw new TelemetryError('unsupported_operation','Signal identity selectors support equality and membership.');
      const side=left?value.left:value.right,other=left?value.right.literal:value.left.literal;
      const t=left??right!;const values=(Array.isArray(other)?other:[other]).flatMap((key:unknown)=>resolve(t.kind,key));
      return {field:t.field,...(side.basis?{basis:side.basis}:{}),op:['ne','not_in'].includes(value.op)?'not_in':'in',value:[...new Set(values)]};
    }
    if(target&&value.op!==undefined&&!['is_missing','is_present'].includes(value.op))throw new TelemetryError('unsupported_operation','Signal identity selectors support equality and membership.');
    return result;
  };
  return {value:visit(raw),signals:[...used.values()]};
}

export async function signalReferenceHealth(db:Db,tenantId:number,signals:TelemetrySignal[]=[]){
  const generations=signals.flatMap(signal=>signal.source?[signal.source.generation]:[]);
  if(!generations.length)return {state:'active',issues:[] as string[]};
  const rows=await db.all<{generation:string}>(`SELECT generation FROM telemetry_signal_generations WHERE active
    AND (tenant_id=? OR tenant_id IS NULL) AND generation=ANY(?::uuid[])`,tenantId,generations);
  const live=new Set(rows.map(row=>row.generation));
  const issues=signals.filter(signal=>signal.source&&!live.has(signal.source.generation)).map(signal=>`${signal.kind} ${signal.label} (${signal.key}) was retired; historical identity remains pinned.`);
  return {state:issues.length?'needs_attention':'active',issues};
}
