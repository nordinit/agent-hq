'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, BarChart3, CheckCircle2, Database, FolderOpen, Library, Play, Plus, Save, Settings2, ShieldCheck, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { telemetryClient } from '@/lib/api/telemetry';
import { buildTelemetryDefinition, newTelemetryGuide, telemetryGuideFromDefinition, telemetryUtcBoundary, type TelemetryGuide } from '@/lib/telemetryBuilder';
import { createTelemetryRequestGuard, parseTelemetryDraft, telemetryErrorMessage } from '@/lib/telemetryPresentation';
import { savedTelemetryReportFilters, telemetryFamilyCoverageNotice, telemetryReportQuery } from '@/lib/telemetryReports';
import type { MetricDefinition, TelemetryCatalog, TelemetryMetric, TelemetryQuery, TelemetryQueryResponse, TelemetryReport, TelemetryReportDefinition, TelemetryResult, TelemetryScope } from '@/lib/telemetryTypes';
import TelemetryScopeBar, { type TelemetryFilters } from './TelemetryScopeBar';
import TelemetryBuilder from './TelemetryBuilder';
import TelemetryResults from './TelemetryResults';
import TelemetryLibrary, { type LibraryData } from './TelemetryLibrary';
import { ErrorNotice, JsonDetails } from './TelemetryControls';

type WorkspaceTab = 'explore' | 'metrics' | 'reports' | 'bindings' | 'profiles' | 'coverage' | 'portability';
const tabs = [
  { id: 'explore', label: 'Explorer', icon: BarChart3 }, { id: 'metrics', label: 'Metric library', icon: Library },
  { id: 'reports', label: 'Reports', icon: FolderOpen }, { id: 'bindings', label: 'Scoped meanings', icon: Settings2 },
  { id: 'profiles', label: 'Profiles', icon: ShieldCheck }, { id: 'coverage', label: 'Coverage', icon: Database },
  { id: 'portability', label: 'Import / export', icon: Upload },
] as const;
const emptyLibrary: LibraryData = { metrics: [], reports: [], profiles: [], bindings: [] };
const initialGuide = newTelemetryGuide();
function extractResults(response: TelemetryQueryResponse): TelemetryResult[] {
  const rows = response.results ?? (response.coverage && response.quality ? [response as TelemetryResult] : []);
  return rows.map(row => ({ ...row, query_id: row.query_id ?? response.query_id, as_of: row.as_of ?? response.as_of!, expires_at: row.expires_at ?? response.expires_at }));
}

export default function TelemetryPage() {
  const [tab, setTab] = useState<WorkspaceTab>('explore');
  const [filters, setFilters] = useState<TelemetryFilters>({ scope: { include_archived: true }, from: '', to: '', timezone: 'UTC', grouping: '' });
  const [catalog, setCatalog] = useState<TelemetryCatalog | null>(null);
  const [library, setLibrary] = useState<LibraryData>(emptyLibrary);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftText, setDraftText] = useState(JSON.stringify(buildTelemetryDefinition(initialGuide), null, 2));
  const [guide, setGuide] = useState<TelemetryGuide>(initialGuide);
  const [builderVersion, setBuilderVersion] = useState(0);
  const [editing, setEditing] = useState<TelemetryMetric | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bindingNotice, setBindingNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [background, setBackground] = useState(false);
  const [results, setResults] = useState<TelemetryResult[]>([]);
  const [stale, setStale] = useState(false);
  const [coverage, setCoverage] = useState<Record<string, unknown> | null>(null);
  const [activeQueryId, setActiveQueryId] = useState<string | undefined>();
  const [activeReport, setActiveReport] = useState<TelemetryReport | null>(null);
  const queryGuard = useRef(createTelemetryRequestGuard());
  const queryAbort = useRef<AbortController | null>(null);
  const libraryGuard = useRef(createTelemetryRequestGuard());
  const lastAction = useRef<(() => void) | null>(null);
  const scopeKey = JSON.stringify(filters.scope);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const scope: TelemetryScope = { include_archived: true };
    const projectId = Number(params.get('project_id')); const workflowId = Number(params.get('workflow_id'));
    if (projectId > 0) scope.project_id = projectId;
    if (workflowId > 0) scope.workflow_id = workflowId;
    if (params.get('workflow_type')) scope.workflow_type = params.get('workflow_type')!;
    if (params.get('task_type')) scope.task_type = params.get('task_type')!;
    setFilters(previous => ({ ...previous, scope }));
    if (params.get('tab') === 'bindings') setTab('bindings');
    const signal = params.get('milestone') ? `status:${params.get('milestone')}` : params.get('outcome') ? `outcome:${params.get('outcome')}` : '';
    if (signal) {
      const next = { ...newTelemetryGuide(), recipe: 'milestone' as const, key: 'milestone_reached', name: `Reached ${params.get('milestone') ?? params.get('outcome')}`, success: signal };
      const definition = buildTelemetryDefinition(next);
      if (params.get('from_status') && params.get('to_status') && definition.measure.kind === 'aggregate') {
        definition.name = `${params.get('outcome')}: ${params.get('from_status')} → ${params.get('to_status')}`;
        definition.measure.where = { all: [definition.measure.where!, { field: 'event.from_status', op: 'eq', value: params.get('from_status') }, { field: 'event.to_status', op: 'eq', value: params.get('to_status') }] };
        setAdvanced(true);
      }
      setGuide(next); setDraftText(JSON.stringify(definition, null, 2)); setBuilderVersion(version => version + 1);
    }
    return () => { queryGuard.current.invalidate(); queryAbort.current?.abort(); };
  }, []);
  const reloadLibrary = useCallback(async () => {
    const token = libraryGuard.current.begin();
    const scope: TelemetryScope = JSON.parse(scopeKey);
    const responses = await Promise.all([telemetryClient.getTelemetryMetrics(scope), telemetryClient.getTelemetryReports(scope), telemetryClient.getTelemetryProfiles(scope), telemetryClient.getTelemetryBindings(scope)]);
    if (libraryGuard.current.isCurrent(token)) setLibrary({ metrics: responses[0].metrics, reports: responses[1].reports, profiles: responses[2].profiles, bindings: responses[3].bindings });
  }, [scopeKey]);
  useEffect(() => {
    const controller = new AbortController(); const scope: TelemetryScope = JSON.parse(scopeKey);
    setLoading(true); setLoadError(null); setLibrary(emptyLibrary); setCoverage(null);
    Promise.all([telemetryClient.getTelemetryCatalog(scope, controller.signal), reloadLibrary(), telemetryClient.getTelemetryCoverage(scope, controller.signal)])
      .then(([nextCatalog, , nextCoverage]) => { if (!controller.signal.aborted) { setCatalog(nextCatalog); setCoverage(nextCoverage); } })
      .catch(cause => { if (!controller.signal.aborted) setLoadError(telemetryErrorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); libraryGuard.current.invalidate(); };
  }, [scopeKey, reloadLibrary]);
  function invalidate(clear = false) {
    queryGuard.current.invalidate(); queryAbort.current?.abort(); setBusy(false); setError(null); setNotice(null); setBindingNotice(null);
    if (clear) { setResults([]); setActiveQueryId(undefined); setActiveReport(null); lastAction.current = null; }
    else if (results.length) setStale(true);
  }
  function changeFilters(next: TelemetryFilters) { const report = activeReport; invalidate(true); setActiveReport(report); setFilters(next); }
  function changeDraft(text: string, issue?: string) { invalidate(); setDraftText(text); setBuilderError(issue ?? null); }
  function queryContext(selected = filters): Partial<TelemetryQuery> {
    if (selected.grouping === '__saved__') throw new Error('Select a grouping for this measurement or run the saved report.');
    const from = telemetryUtcBoundary(selected.from, selected.timezone); const to = telemetryUtcBoundary(selected.to, selected.timezone);
    if (from && to && from >= to) throw new Error('The end of the time window must be later than its start.');
    return { scope: selected.scope, from, to, as_of: new Date().toISOString(), timezone: selected.timezone || 'UTC', background, ...(selected.grouping ? { group_by: [{ field: selected.grouping }] } : {}) };
  }
  async function settleQuery(query: TelemetryQuery, signal: AbortSignal, preview: boolean): Promise<TelemetryQueryResponse> {
    let response = await (preview ? telemetryClient.previewTelemetry(query, signal) : telemetryClient.queryTelemetry(query, signal));
    if (!signal.aborted) setActiveQueryId(response.query_id);
    while (['queued', 'pending', 'running'].includes(response.state ?? response.status ?? '')) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error('Query cancelled.')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
      response = await telemetryClient.getTelemetryQuery(response.query_id, signal);
    }
    if (response.error || ['failed', 'cancelled', 'expired', 'unavailable'].includes(response.state ?? response.status ?? '')) throw new Error((typeof response.error === 'string' ? response.error : response.error?.message) ?? `Query ${response.state ?? response.status}. Run it again for fresh evidence.`);
    return response;
  }
  async function execute(requests: { query: TelemetryQuery; title?: string; preview?: boolean }[], report?: TelemetryReport) {
    queryAbort.current?.abort(); const controller = new AbortController(); queryAbort.current = controller;
    const token = queryGuard.current.begin(); setBusy(true); setError(null); setNotice(null); setBindingNotice(null); setResults([]); setActiveQueryId(undefined); setActiveReport(report ?? null); setStale(false);
    try {
      const responses = await Promise.all(requests.map(async request => ({ response: await settleQuery(request.query, controller.signal, Boolean(request.preview)), request })));
      if (!queryGuard.current.isCurrent(token)) return;
      const nextResults = responses.flatMap(({ response, request }) => extractResults(response).map(result => ({ ...result, title: request.title ?? result.title, definition: result.definition ?? request.query.definition, display: report?.definition.metrics.find(card => card.metric_revision_id === result.metric_revision_id)?.display })));
      if (!nextResults.length) {
        const emptyFamily = responses.find(item => item.request.query.family_key && item.response.results);
        if (emptyFamily) { setBindingNotice(`No active metric definition applies: ${emptyFamily.response.unbound ?? 0} tasks have no binding; ${emptyFamily.response.disabled ?? 0} tasks have an explicit disable.`); return; }
        throw new Error('The query completed without an available result. Inspect coverage or try a smaller population.');
      }
      setResults(nextResults); setActiveQueryId(responses[0].response.query_id);
      const familyCoverage = responses.filter(item => item.request.query.family_key).map(item => telemetryFamilyCoverageNotice(item.response.unbound, item.response.disabled)).filter(Boolean);
      if (familyCoverage.length) setBindingNotice(familyCoverage.join('\n'));
    } catch (cause) { if (!controller.signal.aborted && queryGuard.current.isCurrent(token)) setError(telemetryErrorMessage(cause)); }
    finally { if (queryGuard.current.isCurrent(token)) setBusy(false); }
  }
  function preview() {
    try {
      if (builderError) throw new Error(builderError);
      const definition = parseTelemetryDraft(draftText) as unknown as MetricDefinition; const context = queryContext();
      const requests: { query: TelemetryQuery; title: string; preview: boolean }[] = [{ query: { ...context, definition }, title: editing ? `${definition.name} — proposed revision` : definition.name, preview: !background }];
      if (editing) requests.unshift({ query: { ...context, metric_revision_id: editing.latest_revision_id }, title: `${editing.name} — saved revision ${editing.revision}`, preview: false });
      lastAction.current = preview; void execute(requests);
    } catch (cause) { setError(telemetryErrorMessage(cause)); }
  }
  function runMetric(metric: TelemetryMetric) {
    try { lastAction.current = () => runMetric(metric); void execute([{ query: { ...queryContext(), metric_revision_id: metric.latest_revision_id }, title: metric.name }]); }
    catch (cause) { setError(telemetryErrorMessage(cause)); }
  }
  function runReport(report: TelemetryReport, restoreSavedFilters = true) {
    try {
      const saved = savedTelemetryReportFilters(report);
      if (restoreSavedFilters) { invalidate(true); setFilters(saved); }
      const query = { ...telemetryReportQuery(report, restoreSavedFilters ? undefined : filters), background };
      const run = () => { void execute([{ query: { ...query, as_of: new Date().toISOString() } }], report); };
      lastAction.current = run; run();
    }
    catch (cause) { setError(telemetryErrorMessage(cause)); }
  }
  function previewReport(definition: TelemetryReportDefinition) {
    try { const context = queryContext(); lastAction.current = () => previewReport(definition); void execute(definition.metrics.map(metric => ({ query: { ...context, metric_revision_id: metric.metric_revision_id }, title: metric.title }))); }
    catch (cause) { setError(telemetryErrorMessage(cause)); }
  }
  function runFamily(key: string) {
    try { lastAction.current = () => runFamily(key); void execute([{ query: { ...queryContext(), family_key: key } }]); }
    catch (cause) { setError(telemetryErrorMessage(cause)); }
  }
  async function openSnapshot(id: string) {
    invalidate(true); const token = queryGuard.current.begin(); const controller = new AbortController(); queryAbort.current = controller; setBusy(true);
    try { const response = await telemetryClient.getTelemetryQuery(id, controller.signal); if (queryGuard.current.isCurrent(token)) { setResults(extractResults(response)); setActiveQueryId(id); setNotice('Showing the retained frozen calculation. Its original definition, scope, and time boundary are displayed with the result.'); lastAction.current = () => { void openSnapshot(id); }; } }
    catch (cause) { if (!controller.signal.aborted) setError(telemetryErrorMessage(cause)); }
    finally { if (queryGuard.current.isCurrent(token)) setBusy(false); }
  }
  function editMetric(metric: TelemetryMetric) {
    const signals = Object.fromEntries([...(catalog?.routing_transitions ?? []), ...(catalog?.event_mappings ?? [])].filter(entry => entry.enabled).map(entry => [entry.id, entry.predicate]));
    const restored = telemetryGuideFromDefinition(metric.definition, signals);
    invalidate(true); setEditing(metric); setAdvanced(!restored); setGuide(restored ?? { ...newTelemetryGuide(), name: metric.name, key: metric.key }); setDraftText(JSON.stringify(metric.definition, null, 2)); setBuilderError(null); setBuilderVersion(version => version + 1); setTab('explore');
  }
  function newMetric() {
    invalidate(true); const next = newTelemetryGuide(); setEditing(null); setAdvanced(false); setGuide(next); setDraftText(JSON.stringify(buildTelemetryDefinition(next), null, 2)); setBuilderError(null); setBuilderVersion(version => version + 1); setTab('explore');
  }
  async function saveMetric() {
    setSaving(true); setError(null); setNotice(null);
    try {
      if (builderError) throw new Error(builderError);
      const definition = parseTelemetryDraft(draftText) as unknown as MetricDefinition;
      const validation = await telemetryClient.validateTelemetryDefinition(definition, filters.scope);
      if (!validation.valid) throw new Error(validation.errors.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
      const saved = editing ? await telemetryClient.reviseTelemetryMetric(editing.id, { definition, expected_revision_id: editing.latest_revision_id }) : await telemetryClient.createTelemetryMetric({ key: definition.key, name: definition.name, scope: filters.scope, definition });
      await reloadLibrary(); setEditing(saved); setNotice(`Saved ${saved.name}, revision ${saved.revision}. Existing reports keep their previous pins.`);
    } catch (cause) { setError(telemetryErrorMessage(cause)); } finally { setSaving(false); }
  }
  async function validate() {
    setError(null); setNotice(null);
    try {
      if (builderError) throw new Error(builderError);
      const response = await telemetryClient.validateTelemetryDefinition(parseTelemetryDraft(draftText) as unknown as MetricDefinition, filters.scope);
      if (!response.valid) throw new Error(response.errors.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
      setNotice(response.description ?? 'Definition is valid for the selected catalog and scope. Preview to inspect its actual evidence.');
    } catch (cause) { setError(telemetryErrorMessage(cause)); }
  }

  return <div className="mx-auto max-w-[1600px] space-y-6 p-4 md:p-6 lg:p-8">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-3"><BarChart3 className="h-6 w-6 text-amber-400"/><h1 className="text-2xl font-semibold tracking-tight text-white">Telemetry</h1></div><p className="mt-2 max-w-3xl text-sm text-slate-400">Define what matters in your workflows. Calculate from canonical fields and recorded events, then inspect the evidence behind every result.</p></div><Button size="sm" onClick={newMetric}><Plus className="h-4 w-4"/>New metric</Button></div>
    <TelemetryScopeBar catalog={catalog} filters={filters} onChange={changeFilters}/>
    {activeReport && <div className="flex items-center justify-between gap-3 text-sm text-slate-400"><span>Report: {activeReport.name} · pinned revision {activeReport.revision}</span><Button size="sm" onClick={() => runReport(activeReport, false)} disabled={busy}>Run report with current filters</Button></div>}
    <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={background} onChange={event => { invalidate(); setBackground(event.target.checked); }}/>Run larger calculations in the background</label>
    <nav aria-label="Telemetry workspace" className="flex gap-1 overflow-x-auto border-b border-slate-700/60 pb-2">{tabs.map(item => <button key={item.id} className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${tab === item.id ? 'bg-amber-500/10 text-amber-300' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`} onClick={() => setTab(item.id)} aria-current={tab === item.id ? 'page' : undefined}><item.icon className="h-4 w-4"/>{item.label}</button>)}</nav>
    <ErrorNotice message={loadError}/><ErrorNotice message={error}/>{notice && <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3 text-sm text-emerald-200"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0"/>{notice}</p>}
    {bindingNotice && <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-sm text-amber-200">{bindingNotice}</p>}
    {loading ? <p role="status" className="py-8 text-sm text-slate-400">Loading the scoped catalog and saved definitions…</p> : <>
      {tab === 'explore' && <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(260px,1fr)]"><Card>
        {editing && <p className="mb-4 rounded-lg border border-sky-500/20 bg-sky-950/20 p-3 text-xs text-sky-200">Editing {editing.name} from revision {editing.revision}. Preview compares the saved definition and your proposed revision over the same time boundary.</p>}
        <TelemetryBuilder key={builderVersion} catalog={catalog} draftText={draftText} initialGuide={guide} editing={advanced} lockedKey={Boolean(editing)} onChange={changeDraft} onGuideChange={setGuide} onModeChange={setAdvanced} onValidationChange={setBuilderError}/>
        {builderError && <p className="mt-4 text-xs text-amber-200">{builderError}</p>}
        <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-700/60 pt-4"><Button variant="primary" size="sm" loading={busy} disabled={Boolean(builderError) || !draftText} onClick={preview}><Play className="h-3 w-3"/>Preview calculation</Button><Button size="sm" onClick={validate} disabled={Boolean(builderError) || !draftText}>Validate definition</Button><Button size="sm" loading={saving} disabled={Boolean(builderError) || !draftText} onClick={saveMetric}><Save className="h-3 w-3"/>{editing ? 'Save new revision' : 'Save metric'}</Button></div>
      </Card><div className="space-y-4"><Card><h3 className="text-sm font-medium text-white">Actual workflow configuration</h3><p className="mt-2 text-xs leading-relaxed text-slate-400">{catalog?.fields.length ?? 0} canonical fields · {catalog?.statuses.length ?? 0} statuses · {catalog?.outcomes.length ?? 0} outcomes available in this scope.</p><p className="mt-3 text-xs leading-relaxed text-slate-500">Success and rework are choices in each definition. Runtime failures remain independent facts.</p><p className="mt-3 text-xs leading-relaxed text-slate-500">Occurrence-time filters require a historical time basis. Current inventory measurements reject those filters; use an explicit field predicate for a creation cohort.</p></Card>
        <Card><h3 className="text-sm font-medium text-white">Core measurements</h3><p className="mt-2 text-xs text-slate-500">Inspectable templates for recorded runtime facts.</p><div className="mt-3 space-y-1">{(catalog?.core_metrics ?? []).map(recipe => <button key={recipe.key} className="block w-full rounded-lg px-2 py-2 text-left text-xs text-slate-300 hover:bg-slate-700/50" onClick={() => { invalidate(true); setEditing(null); setAdvanced(true); setDraftText(JSON.stringify(recipe, null, 2)); setBuilderError(null); setBuilderVersion(version => version + 1); }}>{recipe.name}</button>)}{!catalog?.core_metrics?.length && <p className="text-xs text-slate-400">Templates appear when supported by the server.</p>}</div></Card>
      </div></div>}
      {tab === 'coverage' && <Card><div className="flex items-center gap-2"><Activity className="h-4 w-4 text-amber-300"/><h2 className="font-semibold text-white">Observation coverage</h2></div><p className="mt-3 max-w-3xl text-sm text-slate-400">Current field values describe the current snapshot. Historical measurements require recorded evidence for their selected interval. Missing history is excluded or reported as unknown; it is never proof of an uneventful first pass.</p>{coverage ? <div className="mt-4 space-y-3">{Object.entries(coverage).map(([key, value]) => <div key={key} className="rounded-lg border border-slate-700/50 p-3">{value != null && typeof value === 'object' ? <JsonDetails label={key.replace(/_/g, ' ')} value={value}/> : <p className="text-sm text-slate-300"><span className="mr-3 text-slate-500">{key.replace(/_/g, ' ')}</span>{String(value ?? 'Unavailable')}</p>}</div>)}</div> : <p className="mt-4 text-sm text-slate-400">Coverage has not been returned for this scope.</p>}</Card>}
      {!['explore', 'coverage'].includes(tab) && <TelemetryLibrary tab={tab as Exclude<WorkspaceTab, 'explore' | 'coverage'>} scope={filters.scope} data={library} reload={reloadLibrary} onEditMetric={editMetric} onRunMetric={runMetric} onRunReport={runReport} onPreviewReport={previewReport} onRunFamily={runFamily} onOpenSnapshot={id => { void openSnapshot(id); }} lastQueryId={stale ? undefined : activeQueryId} lastReportId={activeReport?.id}/>}
    </>}
    {busy && <div role="status" className="flex items-center justify-between rounded-xl border border-slate-700/60 bg-slate-900 p-4 text-sm text-slate-300"><span>Calculating from the submitted definition and scope…</span><Button size="sm" variant="ghost" onClick={async () => { const id = activeQueryId; invalidate(true); if (id) { try { await telemetryClient.cancelTelemetryQuery(id); } catch (cause) { setError(telemetryErrorMessage(cause)); } } }}>Cancel</Button></div>}
    {results.length > 0 && <TelemetryResults results={results} stale={stale} refreshing={busy} onRefresh={() => lastAction.current?.()}/>}
  </div>;
}
