'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ListFilter, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { telemetryClient } from '@/lib/api/telemetry';
import { formatTelemetryValue, telemetryErrorMessage, telemetryExactValue } from '@/lib/telemetryPresentation';
import type { Contribution, Scalar, TelemetryResult, TelemetryCatalog, TelemetryDisplay, TelemetryView } from '@/lib/telemetryTypes';
import { ErrorNotice, JsonDetails, Select } from './TelemetryControls';
import TelemetryVisualization from './TelemetryVisualization';
import { availableTelemetryDisplays, telemetryDimensionLabel, telemetryGroupLabel } from '@/lib/telemetryViews';

function Contributors({ result, index, group, catalog }: { result: TelemetryResult; index?: number; group?: Scalar[]; catalog?: TelemetryCatalog | null }) {
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState(group ? 'included' : 'all');
  const groupKey = group ? JSON.stringify(group) : undefined;
  const [rows, setRows] = useState<Contribution[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(null); setRows([]);
    telemetryClient.getTelemetryContributors(result.query_id, { offset, limit: 25, metric_revision_id: result.metric_revision_id, metric_index: index, group: groupKey, ...(filter === 'all' ? {} : { included: filter === 'included' }) }, controller.signal)
      .then(response => { if (!controller.signal.aborted) { setRows(response.contributors); setTotal(response.total); } })
      .catch(cause => { if (!controller.signal.aborted) setError(telemetryErrorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [result.query_id, result.metric_revision_id, index, offset, filter, groupKey]);
  return <div className="mt-5 space-y-3 border-t border-slate-700/60 pt-4">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h4 className="text-sm font-medium text-white">Contributing records</h4><p className="text-xs text-slate-500">{group ? `Group: ${telemetryGroupLabel(group, result.definition, catalog)}. ` : ''}Membership and evidence retained with this result.</p></div><Select label="Show" value={filter} onChange={value => { setOffset(0); setFilter(value); }} options={[{ value: 'all', label: 'Included and excluded' }, { value: 'included', label: 'Included only' }, { value: 'excluded', label: 'Excluded only' }]}/></div>
    <ErrorNotice message={error}/>
    {busy ? <p role="status" className="text-sm text-slate-400">Loading contributing records…</p> : !error && <>
      <div className="overflow-auto"><table className="w-full text-left text-xs"><thead className="text-slate-500"><tr><th className="py-2 pr-3">Record</th><th className="pr-3">Attributed agent</th><th className="pr-3">Included</th><th className="pr-3">Value</th><th className="pr-3">Explanation</th><th>Evidence</th></tr></thead><tbody className="divide-y divide-slate-700/40">{rows.map(row => <tr key={row.sample_id} className="align-top"><td className="py-3 pr-3">{row.entity_kind === 'task' ? <Link className="text-amber-300 hover:underline" href={`/tasks/${row.entity_id}`}>{String(row.details?.title ?? `Task #${row.entity_id}`)}</Link> : <span>{row.entity_kind} #{row.entity_id}</span>}{row.started_at && <p className="mt-1 text-slate-500">{new Date(row.started_at).toLocaleString()}</p>}</td><td className="py-3 pr-3">{telemetryDimensionLabel(row.agent_id ?? null, 'agent_id', catalog)}</td><td className="py-3 pr-3"><Badge variant={row.included ? 'done' : 'default'}>{row.included ? 'Yes' : 'No'}</Badge></td><td className="py-3 pr-3 font-mono">{typeof row.value === 'boolean' ? String(row.value) : formatTelemetryValue(row.value, result.unit)}{row.denominator != null && <p className="mt-1 text-slate-500">{formatTelemetryValue(row.numerator)} / {formatTelemetryValue(row.denominator)}</p>}</td><td className="min-w-48 py-3 pr-3 text-slate-300">{row.reason}{row.resolution && <p className="mt-1 text-slate-500">{row.resolution}</p>}</td><td className="py-3"><JsonDetails label={`${row.observation_ids.length} observations`} value={{ observations: row.observation_ids, ...row.details }}/></td></tr>)}</tbody></table></div>
      {!rows.length && <p className="py-3 text-sm text-slate-400">No records match this inclusion filter.</p>}
      <div className="flex items-center justify-between gap-2 text-xs text-slate-400"><span>{total ? `${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}` : '0 records'}</span><div className="flex gap-2"><Button size="sm" variant="ghost" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}><ChevronLeft className="h-3 w-3"/>Previous</Button><Button size="sm" variant="ghost" disabled={offset + rows.length >= total} onClick={() => setOffset(offset + 25)}>Next<ChevronRight className="h-3 w-3"/></Button></div></div>
    </>}
  </div>;
}

export function TelemetryResultCard({result,index,catalog,display:requestedDisplay,sort,compact=false,stale=false}: {
  result:TelemetryResult;index?:number;catalog?:TelemetryCatalog|null;display?:TelemetryDisplay;sort?:TelemetryView['sort'];compact?:boolean;stale?:boolean;
}) {
  const [display,setDisplay]=useState<TelemetryDisplay|null>(null);
  const [expanded,setExpanded]=useState(false);
  const [group,setGroup]=useState<Scalar[]|undefined>();
  const chart=display??requestedDisplay??result.display??(result.funnel?'funnel':result.distribution?'distribution':'bar');
  const coverage=result.coverage;
  return <Card className={stale?'opacity-65':''}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-medium text-white">{result.title??result.definition?.name??result.definition_key}</h3><div className="mt-2 flex flex-wrap gap-2"><Badge variant={result.quality==='complete'?'done':result.quality==='unavailable'?'error':'warn'}>{result.quality}</Badge><span className="text-xs text-slate-400">{result.definition?.time_basis==='current'?'Current snapshot':'Recorded history'}</span></div></div><Button type="button" size="sm" variant="ghost" onClick={()=>{setExpanded(!expanded);setGroup(undefined);}}><ListFilter className="h-3 w-3"/>{expanded?'Hide records':'Records'}</Button></div>
    {!compact&&<p className="mt-3 text-sm text-slate-400">{result.explanation??result.description}</p>}
    <div className="my-5 flex flex-wrap items-end gap-x-6 gap-y-2"><p className="text-4xl font-semibold text-white" title={`Exact value: ${telemetryExactValue(result.value)}`}>{formatTelemetryValue(result.value,result.unit)}</p><p className="pb-1 text-xs text-slate-400">{result.sample_count} samples{result.denominator!=null&&<> · {formatTelemetryValue(result.numerator)} / {formatTelemetryValue(result.denominator)} eligible</>}</p></div>
    {coverage.total===0&&<p className="mb-3 text-sm text-slate-400">No records meet this population and time window.</p>}
    {result.attribution_coverage&&<p className={`mb-3 text-xs ${result.attribution_coverage.unknown?'text-amber-200':'text-slate-400'}`}>{result.attribution_coverage.known} attributed · {result.attribution_coverage.unknown} unknown agent</p>}
    {!compact&&<div className="mb-4 max-w-56"><Select label="Chart" value={chart} onChange={value=>setDisplay(value as TelemetryDisplay)} options={availableTelemetryDisplays(result.definition)}/></div>}
    <TelemetryVisualization result={result} catalog={catalog} display={chart} sort={sort} onSelectGroup={key=>{setGroup(key);setExpanded(true);}}/>
    {(result.warnings??[]).map((warning,i)=><p key={i} className="mt-3 rounded border border-amber-500/20 bg-amber-950/20 p-2 text-xs text-amber-200">{warning}</p>)}
    <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">{Object.entries(coverage).filter(([key,count])=>!['total','eligible'].includes(key)&&(count>0||key==='included')).map(([key,count])=><span key={key}>{count} {key.replace(/_/g,' ')}</span>)}</div>
    <p className="mt-4 border-t border-slate-700/50 pt-3 text-xs text-slate-500">As of {new Date(result.as_of).toLocaleString()}{result.expires_at&&<> · Evidence expires {new Date(result.expires_at).toLocaleString()}</>}</p>
    {!compact&&<div className="mt-3"><JsonDetails label="Definition, scope, and pinned versions" value={{exact_value:result.value,numerator:result.numerator,denominator:result.denominator,definition:result.definition,scope:result.scope,versions:result.versions,query_id:result.query_id}}/></div>}
    {expanded&&<Contributors key={`${result.query_id}:${JSON.stringify(group)}`} result={result} index={index} group={group} catalog={catalog}/>}
  </Card>;
}

export default function TelemetryResults({results,onRefresh,refreshing,stale=false,catalog}: {results:TelemetryResult[];onRefresh?:()=>void;refreshing?:boolean;stale?:boolean;catalog?:TelemetryCatalog|null}) {
  return <div className="space-y-4"><div className="flex items-center justify-between gap-3"><h2 className="font-semibold text-white">Results</h2>{onRefresh&&<Button type="button" size="sm" variant="ghost" onClick={onRefresh} loading={refreshing}><RefreshCw className="h-3 w-3"/>Refresh</Button>}</div>{stale&&<p role="status" className="rounded border border-amber-500/30 p-3 text-sm text-amber-200">The draft or filters changed. Preview again to calculate the current selection.</p>}{results.map((result,index)=><TelemetryResultCard key={`${result.query_id}:${index}`} result={result} index={index} catalog={catalog} stale={stale}/>)}</div>;
}
