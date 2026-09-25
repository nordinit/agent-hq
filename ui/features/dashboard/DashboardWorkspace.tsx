'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Pencil, RefreshCw, Undo2, Redo2, Copy, X, Save, Settings2, Download } from 'lucide-react';
import { telemetryClient } from '@/lib/api/telemetry';
import { blankDashboard, dashboardBlocks, dashboardId, dashboardSection, findDashboardBlock, operationsDashboard } from '@/lib/dashboardLayout';
import type { DashboardBlock, DashboardDocument, DashboardDraft, DashboardOperation, SavedDashboard } from '@/lib/dashboardTypes';
import { operationLabels } from '@/lib/dashboardLayout';
import type { TelemetryCatalog, TelemetryMetric, TelemetryReport, TelemetryScope, TelemetryWidget } from '@/lib/telemetryTypes';
import { telemetryErrorMessage } from '@/lib/telemetryPresentation';
import { telemetryScopeConflict, telemetryScopeConflictMessage, telemetryScopeValueLabel } from '@/lib/telemetryViews';
import { USER_NAME_KEY } from '@/components/OnboardingWizard';
import { useDashboardData } from './useDashboardData';
import DashboardCanvas from './DashboardCanvas';
import DashboardInspector from './DashboardInspector';
import { DashboardDetails, type DashboardInspection } from './DashboardBlocks';
import styles from './dashboard.module.css';

const preference = 'agent-hq-dashboard-page';
/** The retired legacy page left 'legacy' in shared links and browser storage; drop it so the overview loads by default again. */
function forgetRetiredDashboard() {
  const url = new URL(window.location.href);
  if (url.searchParams.get('dashboard') === 'legacy') { url.searchParams.delete('dashboard'); window.history.replaceState(null, '', url); }
  try { if (localStorage.getItem(preference) === 'legacy') localStorage.removeItem(preference); } catch { /* Storage is optional. */ }
}
function Dialog({ open, title, close, children }: { open: boolean; title: string; close: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close(); }, [open]);
  return <dialog ref={ref} className={styles.dialog} onClose={close} aria-label={title}><div className={styles.drawerHeader}><h2>{title}</h2><button className={styles.button} type="button" onClick={close} aria-label={`Close ${title}`}><X/></button></div>{children}</dialog>;
}
export default function DashboardWorkspace() {
  const [catalog, setCatalog] = useState<TelemetryCatalog | null>(null);
  const [metrics, setMetrics] = useState<TelemetryMetric[]>([]), [reports, setReports] = useState<TelemetryReport[]>([]), [saved, setSaved] = useState<SavedDashboard[]>([]);
  const [draft, setDraft] = useState<DashboardDraft>(() => operationsDashboard());
  const [selected, setSelected] = useState('overview'), [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [editing, setEditing] = useState(false), [saving, setSaving] = useState(false), [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<DashboardDraft[]>([]), [redo, setRedo] = useState<DashboardDraft[]>([]);
  const [baseline, setBaseline] = useState(() => JSON.stringify(draft));
  const [viewScope, setViewScope] = useState<TelemetryScope>(draft.definition.scope ?? {});
  const [viewWindow, setViewWindow] = useState({ from: draft.definition.from, to: draft.definition.to, timezone: draft.definition.timezone });
  const [newOpen, setNewOpen] = useState(false), [insertColumn, setInsertColumn] = useState<string | null>(null), [search, setSearch] = useState('');
  const [inspection, setInspection] = useState<DashboardInspection | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null), [userName, setUserName] = useState<string | null>(null);
  const dirty = editing && JSON.stringify(draft) !== baseline;
  const active = saved.find(item => item.id === selected);
  const page = draft.definition;
  const { data, operations } = useDashboardData(page, metrics, editing ? page.scope ?? {} : viewScope, editing ? { from: page.from, to: page.to, timezone: page.timezone } : viewWindow, refresh);
  const historical = page.metrics.some(binding => { const definition = data[binding.id]?.definition ?? metrics.find(metric => metric.latest_revision_id === binding.metric_revision_id)?.definition; return definition && definition.time_basis !== 'current'; });
  const isSnapshotOnly = page.metrics.length > 0 && page.metrics.every(binding => (data[binding.id]?.definition ?? metrics.find(metric => metric.latest_revision_id === binding.metric_revision_id)?.definition)?.time_basis === 'current');
  const scope = editing ? page.scope ?? {} : viewScope;
  const windowSettings = editing ? { from: page.from, to: page.to, timezone: page.timezone } : viewWindow;
  const applyDraft = useCallback((next: DashboardDraft, id: string, edit = false) => {
    setDraft(next); setBaseline(JSON.stringify(next)); setSelected(id); setEditing(edit); setSelectedBlock(null); setUndo([]); setRedo([]); setInspection(null); setError(null); setNotice(null);
    setViewScope(next.definition.scope ?? {}); setViewWindow({ from: next.definition.from, to: next.definition.to, timezone: next.definition.timezone });
  }, []);
  const remember = (id: string) => {
    const url = new URL(window.location.href); url.searchParams.set('dashboard', id); window.history.replaceState(null, '', url);
    try { localStorage.setItem(preference, id); } catch { /* Storage is optional. */ }
  };
  useEffect(() => { try { setUserName(localStorage.getItem(USER_NAME_KEY)?.trim() || null); } catch { /* The greeting is optional. */ } }, []);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([telemetryClient.getTelemetryCatalog(undefined, controller.signal), telemetryClient.getTelemetryMetrics(undefined, controller.signal), telemetryClient.getTelemetryReports(undefined, controller.signal), telemetryClient.getDashboards(undefined, controller.signal)]).then(([nextCatalog, nextMetrics, nextReports, nextSaved]) => {
      if (controller.signal.aborted) return;
      if (nextCatalog.status === 'fulfilled') setCatalog(nextCatalog.value);
      if (nextMetrics.status === 'fulfilled') setMetrics(nextMetrics.value.metrics);
      const reportList = nextReports.status === 'fulfilled' ? nextReports.value.reports : [], savedList = nextSaved.status === 'fulfilled' ? nextSaved.value.dashboards : [];
      setReports(reportList); setSaved(savedList);
      let preferred = new URLSearchParams(window.location.search).get('dashboard');
      if (!preferred) { try { preferred = localStorage.getItem(preference); } catch { /* Optional preference. */ } }
      const existing = savedList.find(item => item.id === preferred);
      if (existing) applyDraft({ name: existing.name, definition: existing.definition }, existing.id);
      else if (preferred === 'builder' || preferred === 'new') applyDraft(blankDashboard(), 'new', true);
      else if (preferred === 'legacy') forgetRetiredDashboard();
      if (nextSaved.status === 'rejected') setError(`Dashboard pages could not load: ${telemetryErrorMessage(nextSaved.reason)}`);
      else { const failed = [nextCatalog, nextMetrics, nextReports].find(result => result.status === 'rejected'); if (failed?.status === 'rejected') setError(`Some dashboard sources could not load: ${telemetryErrorMessage(failed.reason)}`); }
      setLoading(false);
    });
    return () => controller.abort();
  }, [applyDraft]);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const navigate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const link = (event.target as Element).closest('a[href]') as HTMLAnchorElement | null;
      if (!link || link.target === '_blank' || link.download || link.href === window.location.href) return;
      event.preventDefault(); event.stopPropagation(); setPendingNavigation(link.href);
    };
    window.addEventListener('beforeunload', unload); document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigate, true); };
  }, [dirty]);
  useEffect(() => {
    if (!editing) return;
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable=true], dialog') || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '/') { event.preventDefault(); const column = page.sections.flatMap(section => section.columns).find(column => column.blocks.some(block => block.id === selectedBlock)) ?? page.sections[0]?.columns[0]; if (column) { setSearch(''); setInsertColumn(column.id); } }
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [editing, page, selectedBlock]);
  function change(next: DashboardDraft) {
    if (saving) return;
    if (next.definition.sections.length > 24 || dashboardBlocks(next.definition).length > 80 || next.definition.metrics.length > 10) { setError('A dashboard supports up to 24 sections, 80 blocks, and 10 metric sources.'); return; }
    setUndo(items => [...items.slice(-49), draft]); setRedo([]); setDraft(next); setNotice(null); setError(null);
  }
  function selectDashboard(id: string) {
    if (dirty || saving) return;
    const resource = saved.find(item => item.id === id);
    applyDraft(resource ? { name: resource.name, definition: resource.definition } : operationsDashboard(), id);
    remember(id);
  }
  function startEditing() { setEditing(true); setBaseline(JSON.stringify(draft)); setViewScope(page.scope ?? {}); setViewWindow({ from: page.from, to: page.to, timezone: page.timezone }); setNotice(null); }
  async function save() {
    setSaving(true); setError(null);
    try {
      if (!draft.name.trim()) throw new Error('Give the dashboard a name.');
      const payload = { name: draft.name.trim(), definition: page };
      const result = active ? await telemetryClient.reviseDashboard(active.id, { ...payload, expected_revision_id: active.latest_revision_id }) : await telemetryClient.createDashboard({ ...payload, key: `dashboard_${dashboardId()}`, scope: page.scope ?? {} });
      setSaved(items => [...items.filter(item => item.id !== result.id), result]);
      applyDraft({ name: result.name, definition: result.definition }, result.id); remember(result.id);
      setNotice('Dashboard saved.');
    } catch (cause) { setError(telemetryErrorMessage(cause)); } finally { setSaving(false); }
  }
  function insert(block: DashboardBlock, binding?: TelemetryWidget & { id: string }) {
    if (!insertColumn) return;
    const next = structuredClone(page), column = next.sections.flatMap(section => section.columns).find(column => column.id === insertColumn);
    if (!column) return;
    if (binding) next.metrics.push(binding);
    column.blocks.push(block); change({ ...draft, definition: next }); setSelectedBlock(block.id); setInsertColumn(null);
  }
  function addMetric(metric: TelemetryMetric) {
    const id = dashboardId(); insert({ id: dashboardId(), type: 'metric', binding_id: id, title: metric.name, display: 'card', accent: 'blue', precision: 2 }, { id, metric_id: metric.id, metric_revision_id: metric.latest_revision_id, title: metric.name, view: { group_by: metric.definition.group_by } });
  }
  function addView(report: TelemetryReport) {
    const metric = structuredClone(report.definition.metrics[0]); if (!metric) return;
    const definition = metrics.find(item => item.latest_revision_id === metric.metric_revision_id)?.definition;
    const id = dashboardId(), view = { ...metric.view, scope: { ...report.scope, ...report.definition.scope, ...metric.view?.scope }, timezone: metric.view?.timezone ?? report.definition.timezone,
      from: definition?.time_basis === 'current' ? undefined : metric.view?.from ?? report.definition.from, to: definition?.time_basis === 'current' ? undefined : metric.view?.to ?? report.definition.to };
    insert({ id: dashboardId(), type: 'metric', binding_id: id, title: report.name, display: metric.display ?? 'card', precision: 2, accent: 'blue' }, { ...metric, id, view });
  }
  function setScope(next: TelemetryScope) { if (editing) change({ ...draft, definition: { ...page, scope: next } }); else { setViewScope(next); setInspection(null); } }
  function setWindow(next: typeof windowSettings) { if (editing) change({ ...draft, definition: { ...page, ...next } }); else { setViewWindow(next); setInspection(null); } }
  async function exportPage() {
    if (!active) return;
    try {
      const bundle = await telemetryClient.exportTelemetry({ scope: active.scope ?? {}, dashboard_ids: [active.id] });
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `${draft.name.replace(/[^a-zA-Z0-9_-]/g, '-')}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(telemetryErrorMessage(cause)); }
  }
  // Everything a block may draw from, checked against the dashboard's own scope (the saved
  // resource's scope plus the page filters) so incompatible metrics are explained up front.
  const pageScope: TelemetryScope = { ...(active?.scope ?? {}), ...(page.scope ?? {}) };
  const pageScopeSummary = (['project_id', 'workflow_id', 'workflow_type', 'task_type'] as const)
    .flatMap(key => pageScope[key] != null ? [telemetryScopeValueLabel(key, pageScope[key]!, catalog)] : []).join(', ') || 'all projects';
  const describeConflict = (scope: TelemetryScope | undefined) => {
    const conflict = telemetryScopeConflict(scope, pageScope);
    return conflict ? telemetryScopeConflictMessage(conflict, catalog) : null;
  };
  const sources = [
    ...metrics.filter(metric => matches(metric.name)).map(metric => ({ key: `metric-${metric.id}`, label: `Metric · ${metric.name}`, add: () => addMetric(metric), conflict: describeConflict(metric.scope) })),
    ...reports.filter(report => report.definition.presentation === 'view' && matches(report.name)).map(report => ({ key: `view-${report.id}`, label: `Saved view · ${report.name}`, add: () => addView(report),
      conflict: describeConflict({ ...report.scope, ...report.definition.scope, ...report.definition.metrics[0]?.view?.scope }) })),
  ];
  const latest = Object.values(data).flatMap(item => item.result?.as_of ? [item.result.as_of] : []).sort()[0];
  const matches = (text: string) => text.toLowerCase().includes(search.toLowerCase());
  const operationalAllowed = !scope.workflow_id && !scope.workflow_type && !scope.task_type;
  const metricBudgetFull = page.metrics.length >= 10;
  const viewingOverrides = !editing && (JSON.stringify(viewScope) !== JSON.stringify(page.scope ?? {}) || JSON.stringify(viewWindow) !== JSON.stringify({ from: page.from, to: page.to, timezone: page.timezone }));
  const currentResource = dirty || viewingOverrides || !active ? undefined : { dashboardId: active.id };
  return <div className={`${styles.page} ${styles[page.appearance.width]} ${page.appearance.density === 'compact' ? styles.compact : ''}`}>
    <div className={styles.toolbar} data-tour-target="dashboard-toolbar"><label className={styles.actions}><span className={styles.muted}>Dashboard</span><select className={styles.input} aria-label="Dashboard" disabled={dirty || saving || loading} value={selected} onChange={event => selectDashboard(event.target.value)}><option value="overview">Operational overview</option>{saved.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}{selected === 'new' && <option value="new">New dashboard</option>}</select></label>
      <div className={styles.actions}>{editing ? <><button className={styles.button} type="button" disabled={!undo.length || saving} aria-label="Undo layout change" onClick={() => { const previous = undo[undo.length - 1]; setRedo(items => [...items, draft]); setUndo(items => items.slice(0, -1)); setDraft(previous); }}><Undo2/></button><button className={styles.button} type="button" disabled={!redo.length || saving} aria-label="Redo layout change" onClick={() => { const next = redo[redo.length - 1]; setUndo(items => [...items, draft]); setRedo(items => items.slice(0, -1)); setDraft(next); }}><Redo2/></button><button className={styles.button} type="button" onClick={() => setSelectedBlock(null)}><Settings2/>Page settings</button><button className={styles.button} type="button" disabled={saving} onClick={() => { applyDraft(JSON.parse(baseline) as DashboardDraft, selected); }}>Cancel</button><button className={`${styles.button} ${styles.primary}`} type="button" disabled={saving} onClick={() => void save()}><Save/>{saving ? 'Saving…' : 'Save layout'}</button></> : <>
        <button className={styles.button} type="button" disabled={loading} onClick={() => setNewOpen(true)}><Plus/>New dashboard</button><button className={styles.button} type="button" onClick={() => { setRefresh(value => value + 1); setInspection(null); }} aria-label="Refresh dashboard"><RefreshCw/></button><button className={styles.button} type="button" disabled={loading} onClick={() => { applyDraft({ ...structuredClone(draft), name: `${draft.name} copy` }, 'new', true); }} aria-label="Duplicate dashboard"><Copy/></button>{active && <button className={styles.button} type="button" onClick={() => void exportPage()} aria-label="Export dashboard"><Download/></button>}<button className={styles.button} type="button" disabled={loading} onClick={startEditing}><Pencil/>Edit layout</button></>}
      </div>
    </div>
    {userName && !editing && <p className={`${styles.muted} mb-1`}>Welcome back, {userName}</p>}<h1 className={styles.title}>{draft.name}</h1>{page.description && <p className={styles.description}>{page.description}</p>}
    <div className={styles.filters}><label>Project<select className={styles.input} aria-label="Project scope" value={scope.project_id ?? ''} disabled={Boolean(active?.scope?.project_id) || saving} onChange={event => setScope({ include_archived: scope.include_archived, project_id: event.target.value ? Number(event.target.value) : undefined })}><option value="">All projects</option>{catalog?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {isSnapshotOnly && <span>Current snapshot</span>}{!page.metrics.length && dashboardBlocks(page).some(block => block.type === 'operation') && <span>Current inventory & last 24h activity</span>}
      {historical && <><label>History<select className={styles.input} aria-label="Historical date range" value="custom" onChange={event => { const days = Number(event.target.value); if (days) setWindow({ ...windowSettings, from: new Date(Date.now() - days * 86400000).toISOString(), to: new Date().toISOString() }); else if (event.target.value === 'all') setWindow({ ...windowSettings, from: undefined, to: undefined }); }}><option value="custom">Custom / saved</option><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="all">All recorded history</option></select></label><label>From (UTC)<input className={styles.input} type="datetime-local" value={windowSettings.from ? new Date(windowSettings.from).toISOString().slice(0, 16) : ''} onChange={event => setWindow({ ...windowSettings, from: event.target.value ? `${event.target.value}:00.000Z` : undefined })}/></label><label>To (UTC)<input className={styles.input} type="datetime-local" value={windowSettings.to ? new Date(windowSettings.to).toISOString().slice(0, 16) : ''} onChange={event => setWindow({ ...windowSettings, to: event.target.value ? `${event.target.value}:00.000Z` : undefined })}/></label><span>Historical metrics only</span></>}
      {latest && <span>Updated {new Date(latest).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}{dirty && <p className={styles.notice}>Unsaved layout changes · Save or cancel before switching dashboards.</p>}
    <div className={`${styles.body} ${editing ? styles.withInspector : ''}`}>
      <DashboardCanvas page={page} data={data} operations={operations} catalog={catalog} editing={editing && !saving} selected={selectedBlock} change={definition => change({ ...draft, definition })} select={setSelectedBlock} insert={id => { setSearch(''); setInsertColumn(id); }} inspect={setInspection}/>
      {editing && <DashboardInspector draft={draft} block={selectedBlock ? findDashboardBlock(page, selectedBlock) : undefined} data={data} catalog={catalog} change={change} close={() => setSelectedBlock(null)}/>}
    </div>
    <DashboardDetails selected={inspection} data={data} page={page} catalog={catalog} resource={currentResource} close={() => setInspection(null)}/>
    <Dialog open={newOpen} title="Start a dashboard" close={() => setNewOpen(false)}><div className={styles.insertList}><button className={styles.button} type="button" onClick={() => { applyDraft(blankDashboard(), 'new', true); setNewOpen(false); }}>Blank page</button><button className={styles.button} type="button" onClick={() => { const next = operationsDashboard(); next.name = 'My operational overview'; applyDraft(next, 'new', true); setNewOpen(false); }}>Operational overview template</button></div></Dialog>
    <Dialog open={Boolean(insertColumn)} title="Add a block" close={() => setInsertColumn(null)}><input autoFocus className={`${styles.input} w-full`} aria-label="Find a block or metric" placeholder="Search blocks, metrics, or saved views…" value={search} onChange={event => setSearch(event.target.value)}/><div className={styles.insertList}>
      {(['heading', 'note', 'callout', 'divider', 'link', 'comparison'] as const).filter(matches).map(type => <button className={styles.button} type="button" key={type} disabled={type === 'comparison' && !page.metrics.length} onClick={() => insert(type === 'comparison' ? { id: dashboardId(), type, title: 'Metric comparison', binding_ids: page.metrics.slice(0, 4).map(metric => metric.id) } : type === 'link' ? { id: dashboardId(), type, title: 'Tasks board', url: '/tasks' } : type === 'divider' ? { id: dashboardId(), type } : { id: dashboardId(), type, text: type === 'heading' ? 'New heading' : '', surface: type === 'note' ? 'plain' : 'card' })}>{type[0].toUpperCase() + type.slice(1)}</button>)}
      {operationalAllowed && Object.entries(operationLabels).filter(([, label]) => matches(label)).map(([operation, label]) => <button className={styles.button} type="button" key={operation} onClick={() => insert({ id: dashboardId(), type: 'operation', operation: operation as DashboardOperation, accent: 'blue' })}>{label}</button>)}
      {metricBudgetFull && <p className={styles.muted}>All 10 metric sources are in use. Duplicate an existing block to reuse its source.</p>}
      {sources.filter(source => !source.conflict).map(source => <button className={styles.button} type="button" key={source.key} disabled={metricBudgetFull} onClick={source.add}>{source.label}</button>)}
      {sources.some(source => source.conflict) && <p className={styles.muted}>Not available here: this dashboard only covers {pageScopeSummary}. Start a blank dashboard to combine metrics from other workflows or task types.</p>}
      {sources.filter(source => source.conflict).map(source => <button className={styles.button} type="button" key={source.key} disabled title={source.conflict ?? undefined}>{source.label}</button>)}
    </div></Dialog>
    <Dialog open={Boolean(pendingNavigation)} title="Leave unsaved changes?" close={() => setPendingNavigation(null)}><p className={styles.description}>Your layout has unsaved changes. Save it before leaving, or discard the changes.</p><div className={`${styles.actions} mt-5`}><button type="button" className={styles.button} onClick={() => setPendingNavigation(null)}>Keep editing</button><button type="button" className={styles.button} onClick={() => { const target = pendingNavigation; setEditing(false); setPendingNavigation(null); if (target) setTimeout(() => window.location.assign(target), 0); }}>Discard and leave</button></div></Dialog>
  </div>;
}
