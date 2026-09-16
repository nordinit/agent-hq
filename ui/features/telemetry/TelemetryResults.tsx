'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ListFilter, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { telemetryClient } from '@/lib/api/telemetry';
import { formatTelemetryValue, telemetryErrorMessage, telemetryExactValue } from '@/lib/telemetryPresentation';
import type { Contribution, Scalar, TelemetryResult } from '@/lib/telemetryTypes';
import { ErrorNotice, JsonDetails, Select } from './TelemetryControls';

function label(value: Scalar): string { return value == null ? 'Unassigned' : typeof value === 'object' ? value.decimal : String(value); }
function Contributors({ result, index }: { result: TelemetryResult; index?: number }) {
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState('all');
  const [rows, setRows] = useState<Contribution[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(null); setRows([]);
    telemetryClient.getTelemetryContributors(result.query_id, { offset, limit: 25, metric_revision_id: result.metric_revision_id, metric_index: index, ...(filter === 'all' ? {} : { included: filter === 'included' }) }, controller.signal)
      .then(response => { if (!controller.signal.aborted) { setRows(response.contributors); setTotal(response.total); } })
      .catch(cause => { if (!controller.signal.aborted) setError(telemetryErrorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [result.query_id, result.metric_revision_id, index, offset, filter]);
  return <div className="mt-5 space-y-3 border-t border-slate-700/60 pt-4">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h4 className="text-sm font-medium text-white">Contributing records</h4><p className="text-xs text-slate-500">Membership and evidence retained with this result.</p></div><Select label="Show" value={filter} onChange={value => { setOffset(0); setFilter(value); }} options={[{ value: 'all', label: 'Included and excluded' }, { value: 'included', label: 'Included only' }, { value: 'excluded', label: 'Excluded only' }]}/></div>
    <ErrorNotice message={error}/>
    {busy ? <p role="status" className="text-sm text-slate-400">Loading contributing records…</p> : !error && <>
      <div className="overflow-auto"><table className="w-full text-left text-xs"><thead className="text-slate-500"><tr><th className="py-2 pr-3">Record</th><th className="pr-3">Included</th><th className="pr-3">Value</th><th className="pr-3">Explanation</th><th>Evidence</th></tr></thead><tbody className="divide-y divide-slate-700/40">{rows.map(row => <tr key={row.sample_id} className="align-top"><td className="py-3 pr-3">{row.entity_kind === 'task' ? <Link className="text-amber-300 hover:underline" href={`/tasks/${row.entity_id}`}>Task #{row.entity_id}</Link> : <span>{row.entity_kind} #{row.entity_id}</span>}{row.started_at && <p className="mt-1 text-slate-500">{new Date(row.started_at).toLocaleString()}</p>}</td><td className="py-3 pr-3"><Badge variant={row.included ? 'done' : 'default'}>{row.included ? 'Yes' : 'No'}</Badge></td><td className="py-3 pr-3 font-mono">{typeof row.value === 'boolean' ? String(row.value) : formatTelemetryValue(row.value, result.unit)}{row.denominator != null && <p className="mt-1 text-slate-500">{formatTelemetryValue(row.numerator)} / {formatTelemetryValue(row.denominator)}</p>}</td><td className="min-w-48 py-3 pr-3 text-slate-300">{row.reason}{row.resolution && <p className="mt-1 text-slate-500">{row.resolution}</p>}</td><td className="py-3"><JsonDetails label={`${row.observation_ids.length} observations`} value={{ observations: row.observation_ids, ...row.details }}/></td></tr>)}</tbody></table></div>
      {!rows.length && <p className="py-3 text-sm text-slate-400">No records match this inclusion filter.</p>}
      <div className="flex items-center justify-between gap-2 text-xs text-slate-400"><span>{total ? `${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}` : '0 records'}</span><div className="flex gap-2"><Button size="sm" variant="ghost" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}><ChevronLeft className="h-3 w-3"/>Previous</Button><Button size="sm" variant="ghost" disabled={offset + rows.length >= total} onClick={() => setOffset(offset + 25)}>Next<ChevronRight className="h-3 w-3"/></Button></div></div>
    </>}
  </div>;
}

export default function TelemetryResults({ results, onRefresh, refreshing, stale = false }: { results: TelemetryResult[]; onRefresh?: () => void; refreshing?: boolean; stale?: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [display, setDisplay] = useState<'table' | 'bar' | 'line' | null>(null);
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3"><h2 className="font-semibold text-white">Results</h2>{onRefresh && <Button size="sm" variant="ghost" onClick={onRefresh} loading={refreshing}><RefreshCw className="h-3 w-3"/>Refresh</Button>}</div>
    {stale && <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-sm text-amber-200">The draft or filters changed. Preview again to calculate the current selection.</p>}
    {results.map((result, index) => {
      const identity = `${result.query_id}:${index}`;
      const coverage = result.coverage;
      const numericGroups = result.groups.map(group => group.value == null ? NaN : Number(typeof group.value === 'object' ? group.value.decimal : group.value));
      const max = Math.max(1, ...numericGroups.filter(Number.isFinite).map(Math.abs));
      const chart = display ?? (result.display === 'line' ? 'line' : result.display === 'bar' ? 'bar' : 'table');
      const lineMin = Math.min(0, ...numericGroups.filter(Number.isFinite));
      const lineMax = Math.max(1, ...numericGroups.filter(Number.isFinite));
      const linePath = numericGroups.map((value, point) => Number.isFinite(value) ? `${point > 0 && Number.isFinite(numericGroups[point - 1]) ? 'L' : 'M'}${10 + point / Math.max(1, numericGroups.length - 1) * 580},${145 - (value - lineMin) / (lineMax - lineMin) * 130}` : '').join(' ');
      return <Card key={identity} className={stale ? 'opacity-65' : ''}>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="font-medium text-white">{result.title ?? result.definition?.name ?? result.definition_key}</h3><Badge variant={result.quality === 'complete' ? 'done' : result.quality === 'unavailable' ? 'error' : 'warn'}>{result.quality}</Badge></div><p className="mt-2 max-w-4xl text-sm text-slate-400">{result.explanation ?? result.description}</p></div><Button size="sm" variant="ghost" onClick={() => setExpanded(expanded === identity ? null : identity)}><ListFilter className="h-3 w-3"/>{expanded === identity ? 'Hide records' : 'Contributing records'}</Button></div>
        <div className="mt-5 flex flex-wrap items-end gap-x-8 gap-y-3"><p className="text-4xl font-semibold tracking-tight text-white" title={`Exact value: ${telemetryExactValue(result.value)}${result.unit === 'percent' ? ' (fraction)' : ''}`}>{formatTelemetryValue(result.value, result.unit)}</p>{result.denominator != null && <p className="pb-1 text-sm text-slate-400">{formatTelemetryValue(result.numerator)} / {formatTelemetryValue(result.denominator)} eligible</p>}<p className="pb-1 text-sm text-slate-400">{result.sample_count} samples</p></div>
        {coverage.total === 0 && <p className="mt-3 text-sm text-slate-400">No records meet this population and time window.</p>}
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">{Object.entries(coverage).filter(([key, count]) => !['total', 'eligible'].includes(key) && (count > 0 || key === 'included')).map(([key, count]) => <span key={key}>{count} {key.replace(/_/g, ' ')}</span>)}</div>
        {(result.warnings ?? []).map((warning, warningIndex) => <p key={warningIndex} className="mt-3 rounded-lg border border-amber-500/20 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">{warning}</p>)}
        {result.groups.length > 1 && <div className="mt-5"><div className="mb-2 flex items-center justify-between"><h4 className="text-sm text-slate-300">Groups</h4><div className="flex gap-1"><Button size="sm" variant={chart === 'table' ? 'secondary' : 'ghost'} onClick={() => setDisplay('table')}>Table</Button><Button size="sm" variant={chart === 'bar' ? 'secondary' : 'ghost'} onClick={() => setDisplay('bar')}>Bars</Button><Button size="sm" variant={chart === 'line' ? 'secondary' : 'ghost'} onClick={() => setDisplay('line')}>Line</Button></div></div>{chart === 'line' && <div className="mb-4 overflow-hidden rounded-lg bg-slate-950/50 p-3"><svg role="img" aria-label="Metric values across the ordered result groups" viewBox="0 0 600 160" className="h-40 w-full"><line x1="10" x2="590" y1="145" y2="145" stroke="#334155"/><path fill="none" stroke="#fbbf24" strokeWidth="2" d={linePath}/></svg><p className="text-xs text-slate-500">Groups follow the exact order shown in the table below; missing values remain marked in the table.</p></div>}<div className="overflow-auto"><table className="w-full text-left text-xs"><thead className="text-slate-500"><tr><th className="py-2 pr-3">Group</th><th className="pr-3">Value</th><th className="pr-3">Samples</th>{chart === 'bar' && <th className="w-1/3">Relative value</th>}</tr></thead><tbody className="divide-y divide-slate-700/40">{result.groups.map((group, groupIndex) => <tr key={JSON.stringify(group.key)}><td className="py-3 pr-3 text-slate-300">{group.key.map(label).join(' · ') || 'All included records'}</td><td className="pr-3 font-mono text-white">{formatTelemetryValue(group.value, result.unit)}{group.denominator != null && <span className="ml-2 text-slate-500">({formatTelemetryValue(group.numerator)} / {formatTelemetryValue(group.denominator)})</span>}</td><td className="pr-3 text-slate-400">{group.sample_count}</td>{chart === 'bar' && <td><div className="h-2 rounded bg-amber-400/70" style={{ width: `${Math.max(0, Math.min(100, Math.abs(numericGroups[groupIndex]) / max * 100))}%` }}/></td>}</tr>)}</tbody></table></div></div>}
        {result.funnel && <ol className="mt-5 space-y-2">{result.funnel.map(step => <li key={step.key} className="rounded-lg border border-slate-700/50 p-3"><div className="flex justify-between gap-3 text-sm"><span className="text-slate-200">{step.label ?? step.key}</span><span className="font-mono text-white">{step.count}</span></div><div className="mt-2 h-2 overflow-hidden rounded bg-slate-900"><div className="h-full bg-amber-500/70" style={{ width: `${Math.max(0, Math.min(100, Number(step.from_entry) * 100))}%` }}/></div><p className="mt-1 text-xs text-slate-500">{formatTelemetryValue(step.from_entry, 'percent')} of entry · {formatTelemetryValue(step.from_previous, 'percent')} of previous step</p></li>)}</ol>}
        {result.distribution && <div className="mt-5 grid gap-2 sm:grid-cols-3">{result.distribution.map((bucket, bucketIndex) => <div key={bucketIndex} className="rounded-lg border border-slate-700/50 p-3"><p className="text-xs text-slate-400">{bucket.from == null ? 'Below' : bucket.from} {bucket.to == null ? 'and above' : `to ${bucket.to}`}</p><p className="mt-1 text-lg text-white">{bucket.count}</p></div>)}</div>}
        <div className="mt-5 flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-700/50 pt-3 text-xs text-slate-500"><span>As of {new Date(result.as_of).toLocaleString()}</span>{result.data_revision && <span>Data revision {result.data_revision}</span>}{result.expires_at && <span>Evidence expires {new Date(result.expires_at).toLocaleString()}</span>}</div>
        <div className="mt-3"><JsonDetails label="Definition, scope, and pinned versions" value={{ exact_value: result.value, numerator: result.numerator, denominator: result.denominator, definition: result.definition, scope: result.scope, binding_id: result.binding_id, versions: result.versions, data_revision: result.data_revision, query_id: result.query_id }}/></div>
        {expanded === identity && <Contributors key={identity} result={result} index={index}/>}
      </Card>;
    })}
  </div>;
}
