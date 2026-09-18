/** Run only after migration 33 and the matching API build are deployed. */
import fs from 'node:fs';
import { fields, instructions, marker, gateFields, scope, planBackfill } from './agency-lead-search-contract.mjs';
const mode=process.argv[2];
if (!['--config','--backfill'].includes(mode)) throw Error('Use --config or --backfill <CRM-runs.json> <task-snapshot.json>');
const base=process.env.AGENT_HQ_API_BASE??'http://127.0.0.1:3501/api/v1';
const output=fs.mkdtempSync('/private/tmp/agency-lead-search-rollout-');
fs.chmodSync(output,0o700);
const save=(name,value)=>fs.writeFileSync(`${output}/${name}.json`,JSON.stringify(value,null,2),{mode:0o600});
async function api(route,method='GET',body) {
  const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const value=await r.json(); if(!r.ok)throw Error(`${method} ${route}: ${r.status} ${value.error??'request failed'}`);return value;
}
const append=text=>text.includes(marker)?text:text+instructions;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
if(mode==='--config'){
  const schemas=await api('/workflow-definitions/types/lead_generation/field-schemas');save('schemas-before',schemas);
  const existing=schemas.field_schemas.find(s=>s.task_type==='ops');
  const merged=new Map((existing?.schema.fields??[]).map(f=>[f.key,f]));for(const field of fields)merged.set(field.key,field);
  const body={task_type:'ops',schema:{fields:[...merged.values()]}};
  const schema=await api(`/workflow-definitions/types/lead_generation/field-schemas${existing?'/'+existing.id:''}`,existing?'PUT':'POST',body);
  if(!schema.schema.fields.some(f=>f.key==='qualified'&&f.minimum===0&&f.integer===true))throw Error('Numeric validation is not deployed; instructions were not changed');
  for(const id of [99974436,99974437]){
    const agent=await api(`/agents/${id}`);save(`agent-${id}-before`,{id,name:agent.name,job_instructions:agent.job_instructions});
    const desired=append(agent.job_instructions??'');
    await api(`/agents/${id}`,'PUT',{job_instructions:desired});
    if((await api(`/agents/${id}`)).job_instructions!==desired)throw Error(`Instruction readback failed for ${id}`);
  }
  const series=await api('/recurring-task-series/3');save('series-before',series);
  const description=append(series.description_template.replace('record metrics_persistence_failure/configuration drift in the task note and end the occurrence for review.', 'record metrics_persistence_failure/configuration drift in the task note and use the existing blocked path.'));
  await api('/recurring-task-series/3','PUT',{description_template:description,updated_by:'user:codex'});
  if((await api('/recurring-task-series/3')).description_template!==description)throw Error('Recurring instructions readback failed');
  const requirements=await api('/routing/transition-requirements?workflow_id=114');save('gates-before',requirements);
  for(const outcome of ['ready_for_review','close'])for(const field_name of gateFields){
    const existingGate=requirements.transition_requirements.find(r=>r.workflow_id===114&&r.recurring_series_id===3&&r.task_type==='ops'&&r.outcome===outcome&&r.field_name===field_name&&r.requirement_type==='required');
    const gate={workflow_id:114,recurring_series_id:3,task_type:'ops',outcome,field_name,requirement_type:'required',severity:'block',enabled:1,priority:100,message:`Search series #3: ${outcome} requires ${field_name} from the verified CRM run; zero is valid. Use blocked for unavailable results.`};
    const result=await api(`/routing/transition-requirements${existingGate?'/'+existingGate.id:''}`,existingGate?'PUT':'POST',gate);
    if(result.recurring_series_id!==3)throw Error('Gate scope was not preserved');
  }
  const after=await api('/routing/transition-requirements?workflow_id=114');save('gates-after',after);
  const count=after.transition_requirements.filter(r=>r.recurring_series_id===3&&r.enabled).length;
  if(count!==gateFields.length*2)throw Error('Gate count mismatch');
  console.log(JSON.stringify({configured:true,schema_id:schema.id,new_fields:fields.length,gates:count,instructions_updated:['James','Casper','recurring_series_3'],backup:output}));
}else{
  const runs=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
  const tasks=JSON.parse(fs.readFileSync(process.argv[4],'utf8'));
  const results=[];
  for(const snapshot of tasks){
    const current=await api(`/tasks/${snapshot.id}`);
    if(!same(current.custom_fields??{},snapshot.custom_fields??{})||current.status!==snapshot.status){results.push({task_id:current.id,status:'skipped',reason:'task_changed_after_preview'});continue;}
    const plan=planBackfill(current,runs,new Date().toISOString());
    if(plan.status!=='ready'){results.push(plan);continue;}
    save(`task-${current.id}-before`,current);
    try{
      const desired={...(current.custom_fields??{}),...plan.patch};
      await api(`/tasks/${current.id}`,'PUT',{custom_fields:desired,changed_by:'user:codex-crm-backfill'});
      const verified=await api(`/tasks/${current.id}`);
      if(!same(verified.custom_fields,desired)||verified.status!==current.status||verified.assigned_agent_id!==current.assigned_agent_id)throw Error('Readback differs from requested field-only update');
      results.push({...plan,status:'filled',field_count:Object.keys(plan.patch).length});
    }catch(e){results.push({task_id:current.id,status:'error',reason:e.message});save('results',results);throw e;}
    save('results',results);
  }
  save('results',results);
  console.log(JSON.stringify({results:results.reduce((a,p)=>{const key=p.status==='skipped'?p.reason:p.status;a[key]=(a[key]??0)+1;return a;},{}),skipped:results.filter(p=>p.status==='skipped').map(p=>({task_id:p.task_id,reason:p.reason})),backup:output}));
}
