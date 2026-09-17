'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { telemetryClient } from '@/lib/api/telemetry';
import { telemetryErrorMessage } from '@/lib/telemetryPresentation';
import { availableTelemetryDisplays, telemetryResponseResults, telemetryWidgetQuery } from '@/lib/telemetryViews';
import type { MetricDefinition, TelemetryCatalog, TelemetryDisplay, TelemetryMetric, TelemetryResult, TelemetryScope, TelemetryWidget } from '@/lib/telemetryTypes';
import { ErrorNotice, Field, inputClass, Select } from '../telemetry/TelemetryControls';
import { TelemetryResultCard } from '../telemetry/TelemetryResults';

export default function MetricDashboardWidget({widget,metrics,catalog,scope,window,refresh,editing,onChange,reportId,onDuplicate,onRemove,onMove,index,count}: {
  widget:TelemetryWidget;metrics:TelemetryMetric[];catalog:TelemetryCatalog|null;scope:TelemetryScope;window:{from?:string;to?:string;timezone?:string};refresh:number;editing:boolean;onChange:(widget:TelemetryWidget)=>void;reportId?:string;onDuplicate:()=>void;onRemove:()=>void;onMove:(delta:number)=>void;index:number;count:number;
}) {
  const [definition,setDefinition]=useState<MetricDefinition|null>(null);
  const [result,setResult]=useState<TelemetryResult|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false),[expanded,setExpanded]=useState(false),[executed,setExecuted]=useState('');
  const dialog=useRef<HTMLDialogElement>(null);
  const {attributes,listeners,setNodeRef,transform,transition,isDragging}=useSortable({id:widget.id!,disabled:!editing});
  const width=widget.layout?.width??6,height=widget.layout?.height??'regular';
  const queryKey=JSON.stringify({revision:widget.metric_revision_id,view:widget.view?{...widget.view,sort:undefined}:undefined,scope,window});
  const widgetRef=useRef(widget);widgetRef.current=widget;
  useEffect(()=>{
    let active=true;setDefinition(null);setError(null);setResult(null);
    const metric=metrics.find(item=>item.id===widget.metric_id||item.latest_revision_id===widget.metric_revision_id);
    const load=async()=>{
      if(!metric&&!widget.metric_id)throw new Error('The pinned metric is unavailable.');
      const resource=metric?.latest_revision_id===widget.metric_revision_id?metric:await telemetryClient.getTelemetryResource<MetricDefinition>('metrics',metric?.id??widget.metric_id!);
      const pinned=resource.latest_revision_id===widget.metric_revision_id?resource.definition:resource.revisions?.find(revision=>revision.id===widget.metric_revision_id)?.definition;
      if(!pinned)throw new Error('The pinned revision is unavailable.');if(active)setDefinition(pinned);
    };
    void load().catch(cause=>{if(active)setError(telemetryErrorMessage(cause));});return()=>{active=false;};
  },[metrics,widget.metric_id,widget.metric_revision_id]);
  useEffect(()=>{
    if(!definition)return;
    const controller=new AbortController();setBusy(true);setError(null);
    const run=async()=>{
      const response=await telemetryClient.queryTelemetry(telemetryWidgetQuery(widgetRef.current,definition,scope,window),controller.signal);
      const next=telemetryResponseResults(response)[0];if(!next)throw new Error('No result returned.');
      if(!controller.signal.aborted){setResult(next);setExecuted(queryKey);}
    };
    void run().catch(cause=>{if(!controller.signal.aborted)setError(telemetryErrorMessage(cause));}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return()=>controller.abort();
    // Query edits are applied by the explicit dashboard refresh action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[definition,refresh]);
  useEffect(()=>{if(expanded)dialog.current?.showModal();else dialog.current?.close();},[expanded]);
  const group=widget.view?.group_by?.[0],grouping=group&&'field'in group?group.field:'';
  const patchView=(patch:Partial<NonNullable<TelemetryWidget['view']>>)=>onChange({...widget,view:{...widget.view,...patch}});
  const resize=(nextWidth:4|6|12,nextHeight:'compact'|'regular'|'tall')=>onChange({...widget,layout:{width:nextWidth,height:nextHeight}});
  const content=result?<TelemetryResultCard key={result.query_id} result={{...result,title:widget.title??result.title}} catalog={catalog} display={widget.display} sort={widget.view?.sort} compact stale={executed!==queryKey}/>:null;
  return <article ref={setNodeRef} style={{transform:CSS.Transform.toString(transform),transition,zIndex:isDragging?20:undefined,minHeight:height==='tall'?650:height==='compact'?260:400}} className={`relative min-w-0 rounded-xl border ${editing?'border-amber-500/30':'border-transparent'} ${width===12?'lg:col-span-12':width===4?'lg:col-span-4':'lg:col-span-6'} ${isDragging?'opacity-70':''}`}>
    {editing&&<div className="flex items-center justify-between bg-slate-900/70 px-3 py-2"><button type="button" {...attributes} {...listeners} aria-label={`Move ${widget.title??'widget'}`} className="touch-none text-xs text-slate-300">⠿ Drag to arrange</button><span className="text-xs text-slate-500">{width}/12 columns · {height}</span></div>}
    <div className="space-y-2 p-2"><div className="flex flex-wrap items-center gap-1"><Button type="button" size="sm" variant="ghost" disabled={!result} onClick={()=>setExpanded(true)}>Expand</Button>{reportId&&<Link className="px-2 text-xs text-amber-300 hover:underline" href={`/telemetry?tab=analyze&report_id=${encodeURIComponent(reportId)}&widget_id=${encodeURIComponent(widget.id!)}${scope.project_id?`&project_id=${scope.project_id}`:''}`}>Open in Analyze</Link>}{editing&&<><Button type="button" variant="ghost" size="sm" disabled={index===0} onClick={()=>onMove(-1)}>↑ Earlier</Button><Button type="button" variant="ghost" size="sm" disabled={index===count-1} onClick={()=>onMove(1)}>↓ Later</Button><Button type="button" variant="ghost" size="sm" disabled={count>=10} onClick={onDuplicate}>Duplicate</Button><Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove</Button></>}</div>
    {editing&&<details className="rounded border border-slate-700 p-3"><summary className="cursor-pointer text-xs text-slate-300">Widget settings</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">
      <Field label="Widget title"><input className={inputClass} value={widget.title??''} onChange={event=>onChange({...widget,title:event.target.value})}/></Field>
      <Select label="Chart" value={widget.display??'bar'} onChange={value=>onChange({...widget,display:value as TelemetryDisplay,...(value==='line'&&!widget.view?.bucket?{view:{...widget.view,bucket:'day'}}:{})})} options={availableTelemetryDisplays(definition??undefined)}/>
      <Select label="Breakdown" value={grouping} onChange={field=>patchView({group_by:field?[{field}]:[]})} options={[{value:'',label:'One total'},{value:'agent_id',label:'Agent'},{value:'project_id',label:'Project'},{value:'workflow_id',label:'Workflow'},{value:'task_type',label:'Task type'},{value:'status',label:'Status'},...(grouping&&!['agent_id','project_id','workflow_id','task_type','status'].includes(grouping)?[{value:grouping,label:'Saved grouping'}]:[])]}/>
      <Select label="Width" value={String(width)} onChange={value=>resize(Number(value) as 4|6|12,height)} options={[{value:'4',label:'One third'},{value:'6',label:'Half'},{value:'12',label:'Full width'}]}/>
      <Select label="Height" value={height} onChange={value=>resize(width,value as 'compact'|'regular'|'tall')} options={[{value:'compact',label:'Compact'},{value:'regular',label:'Regular'},{value:'tall',label:'Tall'}]}/>
      <Select label="Sort" value={widget.view?.sort??'value_desc'} onChange={value=>patchView({sort:value as 'value_desc'|'value_asc'|'label'})} options={[{value:'value_desc',label:'Largest first'},{value:'value_asc',label:'Smallest first'},{value:'label',label:'Name'}]}/>
      {definition&&definition.time_basis!=='current'&&<><Select label="Time bucket" value={widget.view?.bucket??''} onChange={value=>patchView({bucket:(value||null) as NonNullable<TelemetryWidget['view']>['bucket']})} options={[{value:'',label:'Whole interval'},{value:'day',label:'Day'},{value:'week',label:'Week'},{value:'month',label:'Month'},{value:'hour',label:'Hour'}]}/><Field label="Bucket timezone override" hint="Blank follows the dashboard timezone."><input className={inputClass} value={widget.view?.timezone??''} onChange={event=>patchView({timezone:event.target.value||undefined})}/></Field><Field label="Override from (UTC)" hint="Blank follows the dashboard."><input className={inputClass} type="datetime-local" value={widget.view?.from?.slice(0,16)??''} onChange={event=>patchView({from:event.target.value?`${event.target.value}:00.000Z`:undefined})}/></Field><Field label="Override to (UTC)"><input className={inputClass} type="datetime-local" value={widget.view?.to?.slice(0,16)??''} onChange={event=>patchView({to:event.target.value?`${event.target.value}:00.000Z`:undefined})}/></Field></>}
    </div></details>}
    {(widget.view?.from||widget.view?.to||widget.view?.timezone||widget.view?.scope&&Object.keys(widget.view.scope).some(key=>key!=='include_archived'))&&<p className="px-2 text-xs text-sky-200">Widget filters: {widget.view?.scope?.project_id?`project ${catalog?.projects.find(item=>item.id===widget.view?.scope?.project_id)?.name??widget.view.scope.project_id} · `:''}{widget.view?.scope?.workflow_type??''} {widget.view?.scope?.task_type??''}{widget.view?.from??''} {widget.view?.to?`through ${widget.view.to}`:''} {widget.view?.timezone??''}</p>}
    {busy&&<p role="status" className="p-3 text-xs text-slate-400">Refreshing {widget.title}…</p>}<ErrorNotice message={error}/>{result&&executed!==queryKey&&<p className="px-2 text-xs text-amber-200">Settings changed. Refresh dashboard to recalculate.</p>}{result&&<div className="overflow-auto" style={{maxHeight:height==='tall'?850:height==='compact'?300:520}}>{content}</div>}
    <dialog ref={dialog} onClose={()=>setExpanded(false)} className="m-auto max-h-[90vh] w-[min(1100px,95vw)] overflow-auto rounded-xl border border-slate-600 bg-slate-950 p-5 text-slate-200 backdrop:bg-black/70"><div className="mb-3 flex justify-end"><Button type="button" onClick={()=>setExpanded(false)}>Close</Button></div>{expanded&&content}</dialog></div>
    {editing&&<button type="button" aria-label={`Resize ${widget.title??'widget'}`} title="Drag to resize; width and height controls also support keyboard resizing." className="absolute bottom-0 right-0 touch-none rounded bg-slate-700 px-3 py-2 text-amber-200" onPointerDown={event=>{
      event.preventDefault();const element=event.currentTarget,bounds=element.closest('article')!.getBoundingClientRect(),grid=element.closest('[data-dashboard-grid]')!.getBoundingClientRect(),startX=event.clientX,startY=event.clientY;element.setPointerCapture(event.pointerId);
      const end=(finish:PointerEvent)=>{const ratio=(bounds.width+finish.clientX-startX)/grid.width,pixels=bounds.height+finish.clientY-startY;resize(ratio<.42?4:ratio<.75?6:12,pixels<330?'compact':pixels>550?'tall':'regular');cleanup();};
      const cleanup=()=>{element.removeEventListener('pointerup',end);element.removeEventListener('pointercancel',cleanup);};element.addEventListener('pointerup',end,{once:true});element.addEventListener('pointercancel',cleanup,{once:true});
    }}>↘</button>}
  </article>;
}
