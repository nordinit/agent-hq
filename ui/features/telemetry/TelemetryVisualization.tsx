'use client';

import { useState } from 'react';
import { formatTelemetryValue, telemetryExactValue } from '@/lib/telemetryPresentation';
import { sortedTelemetryGroups, telemetryGroupLabel, telemetryNumber, telemetryTimeSeries } from '@/lib/telemetryViews';
import type { Scalar, TelemetryCatalog, TelemetryDisplay, TelemetryResult, TelemetryView } from '@/lib/telemetryTypes';
import { inputClass } from './TelemetryControls';

const colors=['#fbbf24','#38bdf8','#a78bfa','#34d399','#fb7185','#fb923c'];
export default function TelemetryVisualization({result,catalog,display='bar',sort='value_desc',onSelectGroup}: {
  result:TelemetryResult;catalog?:TelemetryCatalog|null;display?:TelemetryDisplay;sort?:TelemetryView['sort'];onSelectGroup?:(key:Scalar[])=>void;
}) {
  const [search,setSearch]=useState('');
  const groupLabel=(group:TelemetryResult['groups'][number])=>telemetryGroupLabel(group.key,result.definition,catalog);
  const sorted=sortedTelemetryGroups(result.groups,sort,groupLabel);
  const groups=sorted.filter(group=>groupLabel(group).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const values=(display==='line'?result.groups:groups).map(group=>telemetryNumber(group.value)).filter((value):value is number=>value!==null);
  const min=Math.min(0,...values),max=Math.max(0,...values),span=max-min||1,zero=-min/span*100;
  const time=telemetryTimeSeries(result.groups);
  const minTime=Date.parse(time.times[0]??''),timeSpan=(Date.parse(time.times.at(-1)??'')-minTime)||1;
  const x=(index:number)=>42+(Date.parse(time.times[index])-minTime)/timeSpan*600;
  const y=(value:number)=>166-(value-min)/span*136;
  const timeChart=display==='line'&&Boolean(result.definition?.bucket)&&result.definition?.time_basis!=='current';
  if(display==='card')return null;
  if(display==='funnel'&&result.funnel)return <ol className="space-y-3">{result.funnel.map(step=><li key={step.key}><div className="flex justify-between gap-3 text-sm"><span>{step.label??step.key}</span><strong>{step.count}</strong></div><div className="mt-1 h-3 rounded bg-slate-950"><div className="h-full rounded bg-amber-400/70" style={{width:`${Math.min(100,Math.max(0,Number(step.from_entry)*100))}%`}}/></div><p className="mt-1 text-xs text-slate-400">{formatTelemetryValue(step.from_entry,'percent')} of entry · {formatTelemetryValue(step.from_previous,'percent')} of previous step</p></li>)}</ol>;
  if(display==='distribution'&&result.distribution)return <div className="space-y-2">{result.distribution.map((bucket,index)=><div key={index} className="flex justify-between rounded border border-slate-700 p-3 text-sm"><span>{bucket.from==null?'Below':bucket.from} {bucket.to==null?'and above':`to ${bucket.to}`}</span><strong>{bucket.count}</strong></div>)}</div>;
  if(!result.groups.length)return <p className="text-sm text-slate-400">Choose a breakdown to compare groups. The number above is the full result.</p>;
  return <div className="space-y-3">
    {timeChart&&<div className="space-y-2"><svg role="img" aria-label="Metric over time, with separate series for each group" viewBox="0 0 680 206" className="h-56 w-full"><line x1="42" x2="642" y1={y(0)} y2={y(0)} stroke="#475569"/><text x="2" y="25" fill="#94a3b8" fontSize="10">{formatTelemetryValue(max,result.unit)}</text><text x="2" y="175" fill="#94a3b8" fontSize="10">{formatTelemetryValue(min,result.unit)}</text>{time.series.map((series,si)=>{
      const path=series.groups.map((group,i)=>{const value=telemetryNumber(group?.value);return value===null?'':`${i>0&&telemetryNumber(series.groups[i-1]?.value)!==null?'L':'M'}${x(i)},${y(value)}`;}).join(' ');
      return <g key={series.key}><path d={path} fill="none" stroke={colors[si%colors.length]} strokeWidth="2"/>{series.groups.map((group,i)=>{const value=telemetryNumber(group?.value);return group&&value!==null?<circle key={i} cx={x(i)} cy={y(value)} r="4" fill={colors[si%colors.length]}><title>{groupLabel(group)}: {formatTelemetryValue(group.value,result.unit)}</title></circle>:null;})}</g>;
    })}<text x="42" y="200" fill="#94a3b8" fontSize="10">{time.times[0]?.slice(0,16)}</text><text x="642" y="200" textAnchor="end" fill="#94a3b8" fontSize="10">{time.times.at(-1)?.slice(0,16)}</text></svg><div className="flex flex-wrap gap-3 text-xs">{time.series.map((series,index)=><span key={series.key} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{background:colors[index%colors.length]}}/>{telemetryGroupLabel(JSON.parse(series.key),{...result.definition!,bucket:undefined},catalog)}</span>)}</div><p className="text-xs text-slate-500">Buckets use the query timezone. Missing values are gaps, not zero. Select a table row to inspect its records.</p></div>}
    {display==='line'&&!timeChart&&<p className="text-sm text-amber-200">Select a time bucket and refresh to show a historical trend.</p>}
    <input aria-label="Find result group" placeholder="Find an agent or group…" className={`${inputClass} text-xs`} value={search} onChange={event=>setSearch(event.target.value)}/>
    {search&&<p className="text-xs text-slate-400">Showing {groups.length} of {result.groups.length} groups. The total includes all groups.</p>}
    <div className="max-h-[460px] overflow-auto"><table className="w-full text-left text-xs"><thead className="text-slate-400"><tr><th className="py-2 pr-3">Group</th><th className="pr-3">Value</th><th>Samples</th>{display==='bar'&&<th className="w-1/3">Comparison</th>}</tr></thead><tbody className="divide-y divide-slate-700/40">{groups.map(group=>{
      const value=telemetryNumber(group.value);const position=value===null?zero:(value-min)/span*100;
      return <tr key={JSON.stringify(group.key)}><td className="py-3 pr-3">{onSelectGroup?<button type="button" className="text-left text-amber-200 underline decoration-amber-400/30 underline-offset-4 hover:text-white" onClick={()=>onSelectGroup(group.key)}>{groupLabel(group)}</button>:groupLabel(group)}</td><td className="pr-3 font-mono text-white" title={`Exact: ${telemetryExactValue(group.value)}`}>{formatTelemetryValue(group.value,result.unit)}{group.denominator!=null&&<p className="mt-1 text-slate-500">{formatTelemetryValue(group.numerator)} / {formatTelemetryValue(group.denominator)}</p>}</td><td className="text-slate-400">{group.sample_count}</td>{display==='bar'&&<td><button type="button" aria-label={`Inspect ${groupLabel(group)}`} disabled={!onSelectGroup} onClick={()=>onSelectGroup?.(group.key)} className="relative block h-6 w-full"><span className="absolute h-full w-px bg-slate-500" style={{left:`${zero}%`}}/>{value!==null&&<span className={`absolute top-1 h-2 rounded ${value<0?'bg-sky-400':'bg-amber-400'}`} style={{left:`${Math.min(position,zero)}%`,width:`${Math.abs(position-zero)}%`}}/>}</button></td>}</tr>;
    })}</tbody></table></div>
    {!groups.length&&<p className="text-sm text-slate-400">No groups match this search.</p>}
  </div>;
}
