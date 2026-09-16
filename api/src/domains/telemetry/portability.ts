import {randomUUID} from 'crypto';
import {z} from 'zod';
import type {Db} from '../../db/adapter/types';
import {TelemetryError,type TelemetryAccess,scopeSchema,resolveScope,scopeKey} from './access';
import {getDefinition,getRevision,listDefinitions,listBindings,validateStoredDefinition,saveBinding,type DefinitionKind} from './definitions';
import {contentHash,getTelemetryCatalog} from './catalog';
import type {TelemetrySignal} from './signals';

export async function exportTelemetry(db:Db,access:TelemetryAccess,raw:unknown){
  const input=z.object({scope:scopeSchema.optional(),metric_ids:z.array(z.string()).max(100).optional(),profile_ids:z.array(z.string()).max(100).optional(),report_ids:z.array(z.string()).max(100).optional()}).strict().parse(raw);
  const scope=await resolveScope(db,access,input.scope??{}),resources:any[]=[],seen=new Set<string>(),catalog=new Map<string,any>(),signals=new Map<string,TelemetrySignal>(),eventMappingIds=new Set<number>();
  async function add(kind:DefinitionKind,id:string){
    if(seen.has(id))return;seen.add(id);
    if(seen.size>100)throw new TelemetryError('query_limit_exceeded','Export supports up to 100 referenced definitions.');
    const row=await getDefinition(db,access,kind,id);
    const revisions=row.revisions!.map((revision:any)=>({id:revision.id,revision:revision.revision,definition:revision.definition,
      ...(revision.dependencies?.signals?.length?{dependencies:{signals:revision.dependencies.signals}}:{})}));
    resources.push({id:row.id,kind,key:row.key,name:row.name,description:row.description,scope:row.scope,latest_revision_id:row.latest_revision_id,revisions});
    for(const revision of row.revisions!){
      for(const descriptor of revision.dependencies?.catalog??[])catalog.set(descriptor.id,descriptor);
      for(const descriptor of revision.dependencies?.signals??[])signals.set(descriptor.id,descriptor);
      const references=new Set<string>();
      const visit=(value:any)=>{if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object'){
        const addMapping=(field:unknown,literal:unknown)=>{if(field==='event.mapping_id')for(const id of Array.isArray(literal)?literal:[literal])if(Number.isSafeInteger(Number(id)))eventMappingIds.add(Number(id));};
        addMapping(value.field,value.value);addMapping(value.left?.field,value.right?.literal);addMapping(value.right?.field,value.left?.literal);
        for(const [key,item]of Object.entries(value)){if(['metric_ref','metric_revision_id','profile_revision_id'].includes(key)&&typeof item==='string')references.add(item);else visit(item);}
      }};
      visit(revision.definition);
      for(const reference of references){const dependency=await getRevision(db,access,reference);await add(dependency.kind,dependency.definition_id);}
    }
  }
  const explicit=input.metric_ids!==undefined||input.profile_ids!==undefined||input.report_ids!==undefined;
  for(const [kind,key]of [['metric','metric_ids'],['profile','profile_ids'],['report','report_ids']] as const){
    const ids=explicit?(input[key]??[]):(await listDefinitions(db,access,kind,scope)).map(row=>row.id);
    for(const id of ids)await add(kind,id);
  }
  const revisions=new Set(resources.flatMap(resource=>resource.revisions.map((revision:any)=>revision.id)));
  const selectedBindings=(await listBindings(db,access,scope)).filter(binding=>revisions.has(binding.metric_revision_id)||(!explicit&&binding.disabled));
  for(const binding of selectedBindings){
    for(const [kind,id]of [['metric',binding.metric_revision_id],['profile',binding.profile_revision_id]]as const){
      if(id){const dependency=await getRevision(db,access,id,kind);await add(kind,dependency.definition_id);}
    }
  }
  const bindings=selectedBindings.map(binding=>({family_key:binding.family_key,scope:binding.scope,metric_revision_id:binding.metric_revision_id,profile_revision_id:binding.profile_revision_id,disabled:binding.disabled}));
  const registry=catalog.size?await db.all<{id:string;retired_at:unknown}>('SELECT id,retired_at FROM telemetry_catalog_entries WHERE tenant_id=? AND id=ANY(?::text[])',access.tenantId,[...catalog.keys()]):[];
  for(const field of registry)if(field.retired_at)catalog.set(field.id,{...catalog.get(field.id),retired:true});
  const signalRegistry=signals.size?await db.all<{id:string;retired_at:unknown}>('SELECT id,retired_at FROM telemetry_catalog_entries WHERE tenant_id=? AND id=ANY(?::text[])',access.tenantId,[...signals.keys()]):[];
  for(const signal of signalRegistry)if(signal.retired_at)signals.set(signal.id,{...signals.get(signal.id)!,retired:true});
  for(const resource of resources)for(const revision of resource.revisions)if(revision.dependencies?.signals)revision.dependencies.signals=revision.dependencies.signals.map((signal:TelemetrySignal)=>signals.get(signal.id)??signal);
  const eventMappings=eventMappingIds.size?(await getTelemetryCatalog(db,access,scope)).event_mappings.filter(mapping=>eventMappingIds.has(mapping.source.id)):[];
  return {format:'agent-hq-telemetry',version:1,exported_at:new Date().toISOString(),resources,catalog:[...catalog.values()],bindings,
    ...(eventMappingIds.size?{event_mappings:eventMappings}:{}),...(signals.size?{signals:[...signals.values()]}:{})};
}
const portableSignalSchema=z.object({id:z.string(),kind:z.enum(['status','outcome']),key:z.string(),label:z.string(),identity:z.string(),scope:scopeSchema,revision_id:z.string().optional(),terminal:z.number().optional(),retired:z.boolean().optional(),unregistered:z.boolean().optional(),source:z.object({table:z.string(),id:z.string(),generation:z.string()}).strict().optional()}).strict();
const resourceSchema=z.object({id:z.string(),kind:z.enum(['metric','profile','report']),key:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).max(128),name:z.string().min(1).max(200),description:z.string().max(4000).optional(),scope:scopeSchema,latest_revision_id:z.string(),revisions:z.array(z.object({id:z.string(),revision:z.number().int().positive(),definition:z.unknown(),dependencies:z.object({signals:z.array(portableSignalSchema).max(200)}).strict().optional()}).strict()).min(1).max(100)}).strict();
const bundleSchema=z.object({format:z.literal('agent-hq-telemetry'),version:z.literal(1),exported_at:z.string().optional(),resources:z.array(resourceSchema).max(100),catalog:z.array(z.record(z.string(),z.unknown())).max(5000),bindings:z.array(z.record(z.string(),z.unknown())).max(1000).optional(),event_mappings:z.array(z.record(z.string(),z.unknown())).max(1000).optional(),signals:z.array(portableSignalSchema).max(5000).optional()}).strict();
export async function importTelemetry(db:Db,access:TelemetryAccess,raw:unknown){
  const input=z.object({bundle:z.unknown(),scope:scopeSchema,reference_map:z.record(z.string(),z.string()).default({})}).strict().parse(raw);
  if(Buffer.byteLength(JSON.stringify(input.bundle),'utf8')>4*1024*1024)throw new TelemetryError('query_limit_exceeded','Telemetry packages are limited to 4 MB.');
  const bundle=bundleSchema.parse(input.bundle),scope=await resolveScope(db,access,input.scope,true);
  const catalog=await getTelemetryCatalog(db,access,scope),fieldIds=new Set(catalog.fields.map(field=>field.id));
  const remap:Record<string,string>={...input.reference_map};
  const allIds=new Set<string>();
  for(const resource of bundle.resources){
    if(allIds.has(resource.id))throw new TelemetryError('invalid_definition','Duplicate resource identity in package.');allIds.add(resource.id);remap[resource.id]=randomUUID();
    const revisions=new Set<number>();let latestFound=false;
    for(const revision of resource.revisions){if(allIds.has(revision.id)||revisions.has(revision.revision))throw new TelemetryError('invalid_definition','Duplicate revision in package.');allIds.add(revision.id);revisions.add(revision.revision);remap[revision.id]=randomUUID();if(revision.id===resource.latest_revision_id)latestFound=true;}
    if(!latestFound)throw new TelemetryError('invalid_definition','Latest revision missing from package.');
  }
  const destinationScope=(source:any)=>{
    const result={...source,...scope};
    for(const [key,prefix]of [['project_id','project'],['workflow_id','workflow']]as const){
      if(scope[key]!=null)result[key]=scope[key];
      else if(source?.[key]!=null){const target=remap[`${prefix}:${source[key]}`];if(!target)throw new TelemetryError('unknown_reference',`Scope mapping: supply reference_map["${prefix}:${source[key]}"] or select its destination scope.`);result[key]=Number(target);}
    }
    for(const key of ['workflow_type','task_type']as const)if(!scope[key]&&source?.[key]&&remap[`${key}:${source[key]}`])result[key]=remap[`${key}:${source[key]}`];
    return result;
  };
  const localRetired=bundle.catalog.length?await db.all<{id:string}>(`SELECT id FROM telemetry_catalog_entries WHERE tenant_id=? AND retired_at IS NOT NULL AND id=ANY(?::text[])${access.projectId==null?'':' AND (project_id IS NULL OR project_id=?)'}`,access.tenantId,bundle.catalog.map(field=>String(field.id)),...(access.projectId==null?[]:[access.projectId])):[];
  const retiredIds=new Set(localRetired.map(field=>field.id));
  const packageSignals=new Map<string,TelemetrySignal>((bundle.signals??[]).map(signal=>[signal.id,signal]));
  for(const resource of bundle.resources)for(const revision of resource.revisions)for(const signal of revision.dependencies?.signals??[])packageSignals.set(signal.id,signal);
  const localRetiredSignals=packageSignals.size?await db.all<{id:string}>(`SELECT id FROM telemetry_catalog_entries WHERE tenant_id=? AND retired_at IS NOT NULL AND id=ANY(?::text[])${access.projectId==null?'':' AND (project_id IS NULL OR project_id=?)'}`,access.tenantId,[...packageSignals.keys()],...(access.projectId==null?[]:[access.projectId])):[];
  const retiredSignalIds=new Set(localRetiredSignals.map(signal=>signal.id));
  for(const field of bundle.catalog){
    const id=String(field.id);
    if(remap[id])continue; // An explicit replacement remains reviewable in the response.
    if(field.retired===true||retiredIds.has(id))continue;
    if(fieldIds.has(id)){remap[id]=id;continue;}
    let mappedScope:any;try{mappedScope=destinationScope(field.scope??{});}catch{continue;}
    const sourceScope=field.scope&&typeof field.scope==='object'?field.scope as Record<string,unknown>:{};
    const matches=catalog.fields.filter(candidate=>candidate.key===field.key&&candidate.type===field.type&&(!field.unit||candidate.unit===field.unit)&&
      (!candidate.scope.project_id||candidate.scope.project_id===mappedScope.project_id)&&
      candidate.scope.workflow_type===mappedScope.workflow_type&&
      candidate.scope.task_type===(sourceScope.task_type?mappedScope.task_type:undefined));
    if(matches.length===1)remap[id]=matches[0].id;
  }
  const remapField=(field:string):string=>{
    const prefix=field.startsWith('event.before.')?'event.before.':field.startsWith('event.after.')?'event.after.':'';
    const id=field.slice(prefix.length);return prefix+(remap[id]??id);
  };
  const referenceKind=(field:string):string|null=>{
    const id=field.replace(/^event\.(?:before|after)\./,'');
    if(['status','event.from_status','event.to_status'].includes(id))return 'status';
    if(id==='event.outcome')return 'outcome';
    if(id==='event.mapping_id')return 'event_mapping';
    if(['project_id','workflow_id'].includes(id))return id==='project_id'?'project':'workflow';
    if(['agent_id','assigned_agent_id','executing_agent_id','actor_agent_id','outcome_agent_id','event.actor_agent_id'].includes(id))return 'agent';
    return ['workflow_type','task_type'].includes(id)?id:null;
  };
  const remapValue=(value:any,key?:string,targetCatalog=catalog,effectiveScope=scope,depth=0,pinnedSignals:TelemetrySignal[]=[]):any=>{
    if(depth>32)throw new TelemetryError('invalid_definition','Package expressions exceed the nesting limit.');
    if(Array.isArray(value))return value.map(item=>remapValue(item,key,targetCatalog,effectiveScope,depth+1,pinnedSignals));
    if(!value||typeof value!=='object'){
      if(typeof value==='string'&&['metric_ref','metric_revision_id','metric_id','profile_revision_id'].includes(key??''))return remap[value]??value;
      if(typeof value==='string'&&key==='field')return remapField(value);
      return value;
    }
    const mapped:Record<string,any>={};
    for(const [k,v]of Object.entries(value)){
      if(['__proto__','constructor','prototype'].includes(k))throw new TelemetryError('invalid_definition','Invalid package key.');
      mapped[k]=k==='scope'?destinationScope(v):remapValue(v,k,targetCatalog,effectiveScope,depth+1,pinnedSignals);
    }
    const rewriteReference=(field:string,rawValue:any):any=>{
      const prefix=referenceKind(field);
      if(prefix){
        const rewrite=(v:any)=>{
          if(v==null)return v;
          const sourceSignals=['status','outcome'].includes(prefix)?pinnedSignals.filter(signal=>signal.kind===prefix&&(signal.key===v||signal.id===v)):[];
          const sourceSignal=sourceSignals.find(signal=>signal.id===v),sourceKey=sourceSignal?.key??v;
          const explicit=remap[String(v)]??remap[`${prefix}:${sourceKey}`];
          if(sourceSignals.some(signal=>(signal.retired||retiredSignalIds.has(signal.id))&&explicit===undefined&&!remap[signal.id]))
            throw new TelemetryError('unknown_reference',`Supply reference_map["${prefix}:${sourceKey}"] before replacing a retired signal generation.`);
          const signalTarget=sourceSignals.map(signal=>remap[signal.id]).find(Boolean);
          let target=explicit!==undefined?(['project','workflow','agent','event_mapping'].includes(prefix)?Number(explicit):explicit):
            prefix==='project'&&effectiveScope.project_id!=null?effectiveScope.project_id:
            prefix==='workflow'&&effectiveScope.workflow_id!=null?effectiveScope.workflow_id:
            prefix==='workflow_type'&&effectiveScope.workflow_type?effectiveScope.workflow_type:
            prefix==='task_type'&&effectiveScope.task_type?effectiveScope.task_type:signalTarget??sourceKey;
          if(['project','workflow','agent','event_mapping'].includes(prefix)){
            if(explicit===undefined&&target===v&&!(prefix==='project'&&effectiveScope.project_id!=null)&&!(prefix==='workflow'&&effectiveScope.workflow_id!=null))throw new TelemetryError('unknown_reference',`Supply reference_map["${prefix}:${v}"] for this entity filter.`);
            const records=prefix==='project'?targetCatalog.projects:prefix==='workflow'?targetCatalog.workflows:prefix==='event_mapping'?targetCatalog.event_mappings:targetCatalog.agents;
            if(!records.some((record:any)=>Number(prefix==='event_mapping'?record.source.id:record.id)===target))throw new TelemetryError('unknown_reference',`Supply reference_map["${prefix}:${v}"] for an available destination entity.`);
          }else{
            const records=prefix==='status'?targetCatalog.statuses:prefix==='outcome'?targetCatalog.outcomes:prefix==='workflow_type'?targetCatalog.workflow_types:targetCatalog.task_types;
            if(sourceSignal&&explicit===undefined&&signalTarget===undefined){
              const selectedScope=destinationScope(sourceSignal.scope);
              const matches=records.filter((record:any)=>record.key===sourceKey&&
                (record.scope?.workflow_id??null)===(sourceSignal.scope.workflow_id?selectedScope.workflow_id:null)&&
                (record.scope?.workflow_type??null)===(sourceSignal.scope.workflow_type?selectedScope.workflow_type:null)&&
                (record.scope?.task_type??null)===(sourceSignal.scope.task_type?selectedScope.task_type:null)&&
                (!record.scope?.project_id||record.scope.project_id===selectedScope.project_id));
              if(matches.length!==1)throw new TelemetryError('unknown_reference',`Supply reference_map["${sourceSignal.id}"] for one available destination signal identity.`);
              target=matches[0].id;
            }
            if(!records.some((record:any)=>record.key===target||(['status','outcome'].includes(prefix)&&record.id===target)))throw new TelemetryError('unknown_reference',`Supply reference_map["${prefix}:${v}"] for an available destination signal.`);
          }
          return target;
        };
        return Array.isArray(rawValue)?rawValue.map(rewrite):rewrite(rawValue);
      }
      return rawValue;
    };
    if(typeof value.field==='string'&&'value' in value)mapped.value=rewriteReference(value.field,value.value);
    if(typeof value.left?.field==='string'&&value.right&&'literal' in value.right)mapped.right.literal=rewriteReference(value.left.field,value.right.literal);
    if(typeof value.right?.field==='string'&&value.left&&'literal' in value.left)mapped.left.literal=rewriteReference(value.right.field,value.left.literal);
    return mapped;
  };
  return db.withTransaction(async tx=>{
    const imported:any[]=[],issues=new Map<string,string[]>(),mappedRevisions=new Map<string,any[]>(),targetScopes=new Map<string,any>();
    for(const resource of bundle.resources){
      const id=remap[resource.id],latest=resource.revisions.find(revision=>revision.id===resource.latest_revision_id)!;
      let targetScope=scope;
      try{targetScope=await resolveScope(tx,access,destinationScope(resource.scope),true);}catch(error){issues.set(id,[`Scope mapping: ${error instanceof Error?error.message:'Destination scope requires review.'}`]);}
      targetScopes.set(id,targetScope);
      const resourceCatalog=await getTelemetryCatalog(tx,access,targetScope);
      const conflict=await tx.get('SELECT id FROM telemetry_definitions WHERE tenant_id=? AND kind=? AND key=? AND scope_key=?',access.tenantId,resource.kind,resource.key,scopeKey(targetScope));
      const importedKey=conflict?`${resource.key.slice(0,110)}_${id.slice(0,8)}`:resource.key;
      await tx.run(`INSERT INTO telemetry_definitions(id,tenant_id,kind,key,name,description,scope,scope_key,project_id,validation_state) VALUES(?,?,?,?,?,?,?::jsonb,?,?,'draft')`,id,access.tenantId,resource.kind,importedKey,resource.name,resource.description??'',JSON.stringify(targetScope),scopeKey(targetScope),targetScope.project_id??null);
      const revisions=[];
      for(const revision of resource.revisions){
        let definition:any;try{definition=remapValue(revision.definition,undefined,resourceCatalog,targetScope,0,revision.dependencies?.signals??[]);}catch(error){definition=revision.definition;issues.set(id,[...(issues.get(id)??[]),error instanceof Error?error.message:'Reference mapping failed.']);}
        if(resource.kind==='metric'&&definition&&typeof definition==='object')definition={...definition,key:importedKey};
        revisions.push({id:remap[revision.id],definition});
        await tx.run(`INSERT INTO telemetry_definition_revisions(id,tenant_id,definition_id,revision,definition,hash,actor) VALUES(?,?,?,?,?::jsonb,?,?)`,remap[revision.id],access.tenantId,id,revision.revision,JSON.stringify(definition),contentHash(definition),access.actor);
      }
      mappedRevisions.set(id,revisions);
      await tx.run('UPDATE telemetry_definitions SET latest_revision_id=?,revision=? WHERE tenant_id=? AND id=?',remap[resource.latest_revision_id],latest.revision,access.tenantId,id);
      imported.push({id,kind:resource.kind,key:importedKey,source_key:resource.key,name:resource.name,scope:targetScope,latest_revision_id:remap[resource.latest_revision_id],state:'draft'});
    }
    // Validate dependencies in topological passes. Unresolved references stay as
    // inspectable drafts; no arbitrary source tenant IDs become active bindings.
    let progress=true;
    while(progress){progress=false;
      for(const item of imported.filter(row=>row.state==='draft')){
        if(issues.get(item.id)?.some(issue=>issue.startsWith('Supply reference_map')||issue.startsWith('Scope mapping:')))continue;
        try{
          const checked=[];for(const revision of mappedRevisions.get(item.id)!)checked.push({id:revision.id,...await validateStoredDefinition(tx,access,item.kind,revision.definition,targetScopes.get(item.id))});
          for(const revision of checked)await tx.run('UPDATE telemetry_definition_revisions SET dependencies=?::jsonb WHERE tenant_id=? AND id=?',JSON.stringify(revision.dependencies),access.tenantId,revision.id);
          await tx.run("UPDATE telemetry_definitions SET validation_state='active' WHERE tenant_id=? AND id=?",access.tenantId,item.id);
          item.state='active';issues.delete(item.id);progress=true;
        }catch(error){issues.set(item.id,[error instanceof Error?error.message:'Definition validation failed.']);}
      }
    }
    for(const item of imported)if(item.state==='draft'){item.issues=issues.get(item.id)??['Unresolved dependency.'];await tx.run('UPDATE telemetry_definitions SET validation_issues=?::jsonb WHERE tenant_id=? AND id=?',JSON.stringify(item.issues),access.tenantId,item.id);}
    const bindings:any[]=[];
    for(const binding of bundle.bindings??[]){
      try{
        const bindingScope=await resolveScope(tx,access,destinationScope(binding.scope),true),bindingCatalog=await getTelemetryCatalog(tx,access,bindingScope);
        const mapped=remapValue(binding,undefined,bindingCatalog,bindingScope);mapped.scope=bindingScope;
        const saved=await saveBinding(tx,access,mapped);bindings.push(saved.binding);
      }catch(error){bindings.push({family_key:binding.family_key,activated:false,reason:error instanceof Error?error.message:'Binding requires review.'});}
    }
    return {imported,bindings,reference_map:remap,drafts:imported.filter(item=>item.state==='draft').length};
  });
}
