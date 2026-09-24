'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { telemetryClient } from '@/lib/api/telemetry';
import { telemetryUtcBoundary } from '@/lib/telemetryBuilder';
import { metricAttributionIssues } from '@/lib/telemetry-contracts/requirements';
import { availableTelemetryDisplays, telemetryResponseResults, telemetryWidgetQuery } from '@/lib/telemetryViews';
import { telemetryErrorMessage } from '@/lib/telemetryPresentation';
import { savedTelemetryReportFilters } from '@/lib/telemetryReports';
import type { MetricDefinition, TelemetryCatalog, TelemetryDisplay, TelemetryMetric, TelemetryReport, TelemetryResult, TelemetryWidget } from '@/lib/telemetryTypes';
import type { TelemetryFilters } from './TelemetryScopeBar';
import { TelemetryResultCard } from './TelemetryResults';
import { ErrorNotice, Field, inputClass, Select } from './TelemetryControls';
import TelemetryChoicePicker from './TelemetryChoicePicker';

export default function TelemetryAnalyze({catalog,metrics,reports,filters,onFilters,reload,onEdit,initialMetricId}: {
  catalog:TelemetryCatalog|null;metrics:TelemetryMetric[];reports:TelemetryReport[];filters:TelemetryFilters;onFilters:(filters:TelemetryFilters)=>void;reload:()=>Promise<void>;onEdit:(metric:TelemetryMetric)=>void;initialMetricId?:string;
}) {
  const [metricId,setMetricId]=useState(initialMetricId??metrics[0]?.id??'');
  const [widget,setWidget]=useState<TelemetryWidget|null>(null);
  const [definition,setDefinition]=useState<MetricDefinition|null>(null);
  const [pinnedMetric,setPinnedMetric]=useState<TelemetryMetric|null>(null);
  const [saved,setSaved]=useState<TelemetryReport|null>(null);
  const [name,setName]=useState('');
  const [result,setResult]=useState<TelemetryResult|null>(null);
  const [queryKey,setQueryKey]=useState('');
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [saving,setSaving]=useState(false);
  const abort=useRef<AbortController|null>(null);
  const loadGeneration=useRef(0);
  const initialized=useRef(false);
  const metric=metrics.find(item=>item.id===metricId)??(pinnedMetric?.id===metricId?pinnedMetric:undefined);
  const views=reports.filter(report=>report.definition.presentation==='view');
  const revisionId=widget?.metric_revision_id;
  const fingerprint=JSON.stringify({revisionId,view:widget?.view ? {...widget.view,sort:undefined} : undefined,scope:filters.scope,from:filters.from,to:filters.to,timezone:filters.timezone});
  const stale=Boolean(result&&queryKey!==fingerprint);
  const issue=definition?metricAttributionIssues(definition)[0]?.message:undefined;
  const chartIssue=widget?.display==='line'&&!widget.view?.bucket?'Select a time bucket for the time chart.':undefined;
  function selectMetric(selected:TelemetryMetric){
    loadGeneration.current++;abort.current?.abort();setBusy(false);setError(null);setNotice(null);setSaved(null);setResult(null);
    setMetricId(selected.id);setPinnedMetric(selected);setDefinition(selected.definition);setName(`${selected.name} by agent`);
    setWidget({metric_id:selected.id,metric_revision_id:selected.latest_revision_id,title:selected.name,display:'bar',view:{group_by:[{field:'agent_id'}],bucket:null,sort:'value_desc'}});
  }
  async function openView(report:TelemetryReport,widgetId?:string){
    const token=++loadGeneration.current;
    const selected=report.definition.metrics.find(item=>widgetId&&item.id===widgetId)??report.definition.metrics[0];
    abort.current?.abort();setBusy(false);setError(null);setResult(null);setDefinition(null);
    try{
      const parent=(selected.metric_id?metrics.find(item=>item.id===selected.metric_id):metrics.find(item=>item.latest_revision_id===selected.metric_revision_id))??(selected.metric_id?await telemetryClient.getTelemetryResource<MetricDefinition>('metrics',selected.metric_id):undefined);
      if(!parent)throw new Error('The metric is unavailable in this scope. Open the view from its saved project.');
      const resource=parent.latest_revision_id===selected.metric_revision_id?parent:await telemetryClient.getTelemetryResource<MetricDefinition>('metrics',parent.id);
      if(token!==loadGeneration.current)return;
      const pinned=resource.latest_revision_id===selected.metric_revision_id?resource.definition:resource.revisions?.find(revision=>revision.id===selected.metric_revision_id)?.definition;
      if(!pinned)throw new Error('The pinned metric revision is unavailable.');
      setMetricId(parent.id);setPinnedMetric(parent);setWidget({...structuredClone(selected),view:{...selected.view,scope:undefined,from:undefined,to:undefined,timezone:undefined}});setDefinition(pinned);setSaved(report.definition.presentation==='view'?report:null);setName(report.definition.presentation==='view'?report.name:selected.title??parent.name);
      onFilters(savedTelemetryReportFilters({...report,definition:{...report.definition,scope:{...report.scope,...report.definition.scope,...selected.view?.scope,include_archived:report.definition.scope?.include_archived===false||selected.view?.scope?.include_archived===false?false:selected.view?.scope?.include_archived??report.definition.scope?.include_archived},from:selected.view?.from??report.definition.from,to:selected.view?.to??report.definition.to,timezone:selected.view?.timezone??report.definition.timezone}}));
    }catch(cause){if(token===loadGeneration.current)setError(telemetryErrorMessage(cause));}
  }
  useEffect(()=>{
    if(initialized.current)return;initialized.current=true;
    const params=new URLSearchParams(window.location.search),report=reports.find(item=>item.id===params.get('report_id'));
    if(params.get('dashboard_id')) {
      void telemetryClient.getTelemetryResource<import('@/lib/dashboardTypes').DashboardDocument>('dashboards',params.get('dashboard_id')!).then(page=>openView({...page,definition:{presentation:'dashboard',metrics:page.definition.metrics,scope:page.definition.scope,from:page.definition.from,to:page.definition.to,timezone:page.definition.timezone}},params.get('widget_id')??undefined)).catch(cause=>setError(telemetryErrorMessage(cause)));
    }
    else if(report)void openView(report,params.get('widget_id')??undefined);
    else if(params.get('report_id'))setError('This saved view or dashboard is unavailable in the selected scope.');
    else {const selected=metrics.find(item=>item.id===(initialMetricId??params.get('metric_id')))??metrics[0];if(selected)selectMetric(selected);}
    // The initial selection is restored once; later choices belong to this workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  useEffect(()=>()=>{abort.current?.abort();loadGeneration.current++;},[]);
  useEffect(()=>{abort.current?.abort();setBusy(false);},[fingerprint]);
  function patchWidget(patch:Partial<TelemetryWidget>){setWidget(current=>current?{...current,...patch}:current);setNotice(null);}
  function windowSettings(){return {from:telemetryUtcBoundary(filters.from,filters.timezone),to:telemetryUtcBoundary(filters.to,filters.timezone),timezone:filters.timezone};}
  async function run(){
    if(!widget||!definition)return;
    abort.current?.abort();const controller=new AbortController();abort.current=controller;setBusy(true);setError(null);
    try{
      if(issue||chartIssue)throw new Error(issue??chartIssue);
      const response=await telemetryClient.queryTelemetry(telemetryWidgetQuery(widget,definition,filters.scope,windowSettings()),controller.signal);
      const next=telemetryResponseResults(response)[0];if(!next)throw new Error('No result was returned.');
      if(!controller.signal.aborted){setResult(next);setQueryKey(fingerprint);}
    }catch(cause){if(!controller.signal.aborted)setError(telemetryErrorMessage(cause));}
    finally{if(!controller.signal.aborted)setBusy(false);}
  }
  async function save(asNew=false){
    if(!widget||!definition)return;setSaving(true);setError(null);setNotice(null);
    try{
      if(!name.trim())throw new Error('Give the view a name.');
      const window=windowSettings();
      const next={presentation:'view' as const,metrics:[widget],scope:filters.scope,timezone:filters.timezone,...(definition.time_basis==='current'?{}:window)};
      const updated=saved&&!asNew?await telemetryClient.reviseTelemetryReport(saved.id,{definition:next,expected_revision_id:saved.latest_revision_id,name:name.trim()}):await telemetryClient.createTelemetryReport({key:`view_${crypto.randomUUID()}`,name:name.trim(),scope:filters.scope,definition:next});
      setSaved(updated);await reload();setNotice('View saved with its pinned metric revision. It is now available in the dashboard builder.');
    }catch(cause){setError(telemetryErrorMessage(cause));}finally{setSaving(false);}
  }
  const expressions=widget?.view?.group_by??definition?.group_by??[];
  const grouping=expressions.length===0?'':expressions.length===1&&'field' in expressions[0]?expressions[0].field:'__custom__';
  const filter=widget?.view?.filter;
  const agentFilter=filter&&'field'in filter&&filter.field==='agent_id'&&filter.op==='eq'?String(filter.value):'';
  return <div className="space-y-5">
    <Card><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold text-white">Analyze a metric</h2><p className="mt-1 text-sm text-slate-400">Compare agents, inspect individual records, and save a view for your dashboard.</p></div><Link href="/?dashboard=builder" className="text-sm text-amber-300 hover:underline">Open dashboard builder →</Link></div>
      <div className="mt-5 grid gap-4 md:grid-cols-2"><Select label="Metric" value={metricId} onChange={id=>{const selected=metrics.find(item=>item.id===id);if(selected)selectMetric(selected);}} options={[{value:'',label:'Choose a saved metric'},...metrics.map(item=>({value:item.id,label:item.name})),...(metric&&!metrics.some(item=>item.id===metric.id)?[{value:metric.id,label:`${metric.name} (archived)`}]:[])]}/><Select label="Saved view" value={saved?.id??''} onChange={id=>{const report=views.find(item=>item.id===id);if(report)void openView(report);else if(metric)selectMetric(metric);}} options={[{value:'',label:'Unsaved view'},...views.map(item=>({value:item.id,label:item.name}))]}/></div>
      {widget&&definition&&<><p className="mt-3 text-xs text-slate-500">Pinned revision {widget.metric_revision_id.slice(0,8)} · {definition.time_basis==='current'?'Current snapshot: date range does not apply.':'Historical measurement: selected date range applies.'}{metric&&metric.latest_revision_id!==widget.metric_revision_id?' · A newer metric revision is available. Selecting the metric again uses it.':''}</p>
      {issue&&<div role="alert" className="mt-4 rounded border border-amber-500/30 p-3 text-sm text-amber-200"><p>{issue}</p>{metric&&!metric.archived_at&&<Button type="button" size="sm" variant="secondary" className="mt-2" onClick={()=>onEdit(metric)}>Repair metric definition</Button>}</div>}
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Select label="Break down by" value={grouping} onChange={field=>{if(field!=='__custom__')patchWidget({view:{...widget.view,group_by:field?[{field}]:[]}});}} options={[{value:'',label:'One total'},{value:'agent_id',label:'Agent (selected attribution)'},{value:'project_id',label:'Project'},{value:'workflow_id',label:'Workflow'},{value:'task_type',label:'Task type'},{value:'status',label:'Status'},...catalog?.fields.filter(field=>field.id.startsWith('field_')&&!field.retired).map(field=>({value:field.id,label:field.label}))??[],...(grouping==='__custom__'?[{value:'__custom__',label:'Saved custom grouping'}]:[])]}/>
      <Select label="Chart style" value={widget.display??'bar'} onChange={value=>patchWidget({display:value as TelemetryDisplay,...(value==='line'&&!widget.view?.bucket?{view:{...widget.view,bucket:'day'}}:{})})} options={availableTelemetryDisplays(definition)}/>
      {definition.time_basis!=='current'&&<Select label="Time bucket" value={widget.view?.bucket??''} onChange={value=>patchWidget({view:{...widget.view,bucket:(value||null) as NonNullable<TelemetryWidget['view']>['bucket']}})} options={[{value:'',label:'Whole interval'},{value:'hour',label:'Hour'},{value:'day',label:'Day'},{value:'week',label:'Week'},{value:'month',label:'Month'}]}/>}
      <Select label="Sort groups" value={widget.view?.sort??'value_desc'} onChange={value=>patchWidget({view:{...widget.view,sort:value as NonNullable<TelemetryWidget['view']>['sort']}})} options={[{value:'value_desc',label:'Largest first'},{value:'value_asc',label:'Smallest first'},{value:'label',label:'Name'}]}/></div>
      <div className="mt-4 max-w-md">{!filter||agentFilter?<TelemetryChoicePicker label="Agent filter" value={agentFilter||'all'} onChange={value=>patchWidget({view:{...widget.view,filter:value==='all'?undefined:{field:'agent_id',op:'eq',value:Number(value)}}})} options={[{value:'all',label:'All agents, including unknown',category:'Agents',description:'Compare the whole population'},...(catalog?.agents.map(agent=>({value:String(agent.id),label:agent.name,category:'Agents',description:'Uses the metric’s selected attribution policy'}))??[])]} hint="This narrows the calculation and is saved with the view. Group search below only changes what is displayed."/>:<p className="text-xs text-slate-400">This saved view has a custom population filter, which is preserved when saving.</p>}</div>
      {chartIssue&&<p role="alert" className="mt-3 text-sm text-amber-200">{chartIssue}</p>}
      <div className="mt-5 flex flex-wrap items-end gap-3"><Button type="button" variant="primary" onClick={run} loading={busy} disabled={Boolean(issue||chartIssue)}>Run analysis</Button>{metric&&!metric.archived_at&&<Button type="button" size="sm" onClick={()=>onEdit(metric)}>Edit metric</Button>}<div className="min-w-48 flex-1"><Field label="View name"><input className={inputClass} value={name} onChange={event=>setName(event.target.value)}/></Field></div><Button type="button" loading={saving} disabled={Boolean(issue||chartIssue)} onClick={()=>void save()}>{saved?'Update view':'Save view'}</Button>{saved&&<Button type="button" size="sm" onClick={()=>void save(true)} disabled={saving||Boolean(issue||chartIssue)}>Save a copy</Button>}</div></>}
      {!metrics.length&&!widget&&<p className="mt-5 text-sm text-slate-400">Create a metric in Explorer to start analyzing it.</p>}
    </Card>
    <ErrorNotice message={error}/>{notice&&<p role="status" className="text-sm text-emerald-200">{notice}</p>}
    {stale&&<p role="status" className="text-sm text-amber-200">Query settings changed. Run analysis to refresh the data below.</p>}
    {result&&<TelemetryResultCard key={result.query_id} result={result} catalog={catalog} display={widget?.display} sort={widget?.view?.sort} compact stale={stale}/>}
    {!result&&widget&&!busy&&<p className="p-6 text-center text-sm text-slate-400">Run analysis to see this metric and its attribution breakdown.</p>}
  </div>;
}
