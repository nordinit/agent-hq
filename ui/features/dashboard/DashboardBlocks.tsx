'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Activity, Bot, Search, Users, Target, CheckCircle2, Coins, FileText, Layers, Clock, X, ArrowUpRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { timeAgo } from '@/lib/date';
import { dashboardComparisonIssue, formatDashboardValue, operationLabels } from '@/lib/dashboardLayout';
import { sortedTelemetryGroups, telemetryGroupLabel } from '@/lib/telemetryViews';
import { telemetryExactValue } from '@/lib/telemetryPresentation';
import type { DashboardBlock, DashboardDocument, DashboardIcon } from '@/lib/dashboardTypes';
import type { Scalar, TelemetryCatalog, TelemetryResult } from '@/lib/telemetryTypes';
import TelemetryVisualization from '../telemetry/TelemetryVisualization';
import { TelemetryResultCard } from '../telemetry/TelemetryResults';
import type { DashboardMetricState, DashboardOperations } from './useDashboardData';
import styles from './dashboard.module.css';

export const dashboardIcons = { activity: Activity, bot: Bot, search: Search, users: Users, target: Target, check: CheckCircle2, coins: Coins, file: FileText, layers: Layers, clock: Clock };
export interface DashboardInspection { bindingId?: string; group?: Scalar[]; operation?: string; title: string }
interface Props { block: DashboardBlock; page: DashboardDocument; data: Record<string, DashboardMetricState>; operations: DashboardOperations; catalog: TelemetryCatalog | null; inspect: (value: DashboardInspection) => void }
function Quality({ result }: { result: TelemetryResult }) {
  const concerns = [result.quality !== 'complete' ? `Data ${result.quality}` : '', result.attribution_coverage?.unknown ? `${result.attribution_coverage.unknown} unknown agent` : '', ...(result.warnings ?? [])].filter(Boolean);
  return concerns.length ? <span className={styles.warning} role="status">{concerns.join(' · ')}</span> : null;
}
export function DashboardStat({ title, value, caption, icon = 'activity', accent = 'neutral', plain, onClick, warning }: { title: string; value: string; caption?: string; icon?: DashboardIcon; accent?: string; plain?: boolean; onClick?: () => void; warning?: React.ReactNode }) {
  const Icon = dashboardIcons[icon];
  return <button type="button" onClick={onClick} className={`${styles.panel} ${styles.stat} ${plain ? styles.plain : ''}`} aria-label={`${title}: ${value}. View details`}>
    <span className={styles.statLabel}>{title}</span><span className={`${styles.statIcon} ${styles[accent]}`}><Icon aria-hidden="true"/></span>
    <span className={`${styles.statValue} ${styles[accent]}`}>{value}</span><span className={styles.statCaption}>{caption}</span>{warning}
  </button>;
}
function MetricBlock({ block, page, data, catalog, inspect }: Props & { block: Extract<DashboardBlock, { type: 'metric' }> }) {
  const binding = page.metrics.find(metric => metric.id === block.binding_id), state = data[block.binding_id];
  const title = block.title || binding?.title || state?.definition?.name || 'Metric';
  const surface = `${styles.panel} ${block.surface === 'plain' ? styles.plain : ''}`;
  if (!binding) return <div className={surface}><h3 className={styles.blockTitle}>{title}</h3><p className={styles.error}>This metric binding is unavailable.</p></div>;
  if (!state || state.busy) return <div className={`${surface} ${styles.stat}`} aria-busy="true"><p className={styles.statLabel}>{title}</p><p className={`${styles.statValue} ${styles.loading}`}>—</p><p className={styles.muted}>Loading metric…</p></div>;
  if (state.error || !state.result) return <div className={surface}><h3 className={styles.blockTitle}>{title}</h3><p className={styles.error} role="alert">{state.error || 'No result available.'}</p></div>;
  const result = state.result, precision = block.precision ?? 2;
  const override = binding.view?.from || binding.view?.to || binding.view?.timezone || Object.keys(binding.view?.scope ?? {}).some(key => key !== 'include_archived');
  const caption = [result.denominator != null ? `${formatDashboardValue(result.numerator)} / ${formatDashboardValue(result.denominator)} eligible` : `${result.sample_count} contributing ${result.sample_count === 1 ? 'record' : 'records'}`,
    !['percent', 'count', 'number', 'dimensionless'].includes(result.unit) ? result.unit : '', override ? 'Custom filters' : ''].filter(Boolean).join(' · ');
  const open = (group?: Scalar[]) => inspect({ bindingId: binding.id, title, group });
  if (!block.display || block.display === 'card') return <DashboardStat title={title} value={formatDashboardValue(result.value, result.unit, precision)} caption={caption} icon={block.icon} accent={block.accent} plain={block.surface === 'plain'} onClick={() => open()} warning={<Quality result={result}/>}/>;
  return <div className={surface}><div className={styles.sectionHeader}><h3 className={styles.blockTitle}>{title}</h3><button className={styles.button} type="button" onClick={() => open()}>Details <ArrowUpRight/></button></div><TelemetryVisualization result={result} catalog={catalog} display={block.display} sort={binding.view?.sort} onSelectGroup={open}/><Quality result={result}/></div>;
}
function ComparisonBlock({ block, page, data, catalog, inspect }: Props & { block: Extract<DashboardBlock, { type: 'comparison' }> }) {
  const [all, setAll] = useState(false);
  const bindings = block.binding_ids.map(id => page.metrics.find(metric => metric.id === id));
  const metricTitle = (id: string) => page.sections.flatMap(section => section.columns.flatMap(column => column.blocks)).find(item => item.type === 'metric' && item.binding_id === id)?.title || page.metrics.find(item => item.id === id)?.title || data[id]?.definition?.name || 'Metric';
  const states = block.binding_ids.map(id => data[id]);
  const results = states.flatMap(state => state?.result ? [state.result] : []);
  const busy = states.some(state => !state || state.busy);
  let issue = bindings.some(binding => !binding) ? 'A selected metric is unavailable.' : states.find(state => state?.error)?.error ?? dashboardComparisonIssue(results);
  const queryWindows = states.filter(state => state?.query).map(state => JSON.stringify({ scope: state.query!.scope, from: state.query!.from, to: state.query!.to, timezone: state.query!.timezone }));
  if (new Set(queryWindows).size > 1) issue = 'These metrics use different time windows or filters. Inspect them separately.';
  const groups = new Map<string, Scalar[]>(); results.forEach(result => result.groups.forEach(group => groups.set(JSON.stringify(group.key), group.key)));
  const groupMaps = results.map(result => new Map(result.groups.map(group => [JSON.stringify(group.key), group])));
  const sortIndex = Math.max(0, block.binding_ids.indexOf(block.sort_by ?? block.binding_ids[0]));
  const sortRows = [...groups.entries()].map(([key, group]) => groupMaps[sortIndex]?.get(key) ?? { key: group, value: null, sample_count: 0 });
  const rows = sortedTelemetryGroups(sortRows, block.sort ?? 'label', group => telemetryGroupLabel(group.key, results[0]?.definition, catalog)).map(group => [JSON.stringify(group.key), group.key] as const);
  const visible = all ? rows : rows.slice(0, block.rows ?? 9);
  return <div className={`${styles.panel} ${block.surface === 'plain' ? styles.plain : ''}`}><h3 className={styles.blockTitle}>{block.title || 'Metric comparison'}</h3>
    {busy ? <p className={styles.loading}>Loading comparison…</p> : issue ? <p role="status" className={styles.warning}>{issue}</p> : !rows.length ? <p className={styles.muted}>No groups match this scope.</p> : <>
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th scope="col">Group</th>{bindings.map(binding => <th scope="col" key={binding!.id}>{metricTitle(binding!.id)}</th>)}</tr></thead><tbody>{visible.map(([key, group]) => <tr key={key}><td>{telemetryGroupLabel(group, results[0]?.definition, catalog)}</td>{bindings.map((binding, i) => {
        const row = groupMaps[i]?.get(key); return <td key={binding!.id}>{row ? <button type="button" className={styles.cellButton} aria-label={`Inspect ${binding!.title ?? 'metric'} for ${telemetryGroupLabel(group, results[i]?.definition, catalog)}`} onClick={() => inspect({ bindingId: binding!.id, title: binding!.title || 'Metric details', group })}>{formatDashboardValue(row.value, results[i]?.unit)}{row.denominator != null && <span className={styles.statCaption}>{formatDashboardValue(row.numerator)} / {formatDashboardValue(row.denominator)}</span>}</button> : '—'}</td>;
      })}</tr>)}</tbody></table></div><div className={styles.tableCaption}><span>{rows.length} groups · metric-specific populations apply</span>{rows.length > (block.rows ?? 9) && <button className={styles.cellButton} type="button" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button>}</div>
    </>}{results.map((result, i) => <Quality key={`${result.query_id}:${i}`} result={result}/>)}</div>;
}
function OperationBlock({ block, operations, inspect }: Props & { block: Extract<DashboardBlock, { type: 'operation' }> }) {
  const title = block.title || operationLabels[block.operation];
  const error = block.operation === 'completed_tasks' ? operations.tasksError : operations.statsError;
  const wrap = `${styles.panel} ${block.surface === 'plain' ? styles.plain : ''}`;
  if (block.operation === 'links') return <div className={wrap}><h3 className={styles.blockTitle}>{title}</h3><div className={styles.shortcuts}>{[['/agents', 'Manage agents', 'Register and configure'], ['/tasks', 'Tasks board', 'Plan and track work'], ['/capabilities', 'Capabilities', 'Skills and tools'], ['/settings/logs', 'Execution logs', 'Debug and audit']].map(([href, label, help]) => <Link key={href} href={href}>{label}<small>{help}</small></Link>)}</div></div>;
  if (operations.busy) return <div className={`${wrap} ${styles.stat}`}><p className={styles.statLabel}>{title}</p><p className={styles.loading}>Loading…</p></div>;
  if (error) return <div className={wrap}><h3 className={styles.blockTitle}>{title}</h3><p className={styles.error}>{error}</p></div>;
  if (block.operation === 'failures') return <div className={wrap}><h3 className={styles.blockTitle}>{title} <span className={styles.muted}>· last 24h</span></h3>{!operations.stats?.recentFailed.length ? <p className={styles.muted}>No recent failed runs.</p> : operations.stats.recentFailed.map(run => <div key={run.id} className={styles.row}><div className={styles.rowTitle}>{run.job_title || `Run #${run.id}`}<p className={styles.muted}>{run.agent_name || 'Unassigned agent'} · {timeAgo(run.created_at)}</p></div><Link href={`/chat?agentId=${run.agent_id}&instanceId=${run.id}`}>View run</Link></div>)}</div>;
  if (block.operation === 'completed_tasks') return <div className={wrap}><h3 className={styles.blockTitle}>{title}</h3>{!operations.tasks?.length ? <p className={styles.muted}>No tasks completed in the last 24 hours.</p> : operations.tasks.slice(0, 12).map(task => <div key={task.id} className={styles.row}><div className={styles.rowTitle}>{task.title}<p className={styles.muted}>{task.agent_name || 'Unassigned'}{task.project_name ? ` · ${task.project_name}` : ''}{task.outcome ? ` · ${task.outcome}` : ''}</p></div><Link href={`/tasks?id=${task.id}`}>View task</Link></div>)}{(operations.tasks?.length ?? 0) > 12 && <Link className={styles.link} href="/tasks">Open tasks board →</Link>}</div>;
  const stats = operations.stats;
  const values = { agents: stats?.totalAgents, active_runs: stats?.activeJobs, templates: stats?.enabledTemplates, runs: stats?.recentRuns, completed_runs: stats?.doneRecent, tokens: stats?.tokensLast24h, failed_runs: stats?.failedRecent };
  const caption = block.operation === 'active_runs' ? 'Queued + running' : block.operation === 'tokens' ? 'Tracked run tokens' : ['runs', 'completed_runs', 'failed_runs'].includes(block.operation) ? 'Runs created in the last 24 hours' : 'Current inventory';
  return <DashboardStat title={title} value={formatDashboardValue(values[block.operation], undefined, 0)} caption={caption} icon={block.icon} accent={block.accent} plain={block.surface === 'plain'} onClick={() => inspect({ operation: block.operation, title })}/>;
}
export function DashboardBlockContent(props: Props) {
  const { block } = props;
  if (block.type === 'metric') return <MetricBlock {...props} block={block}/>;
  if (block.type === 'comparison') return <ComparisonBlock {...props} block={block}/>;
  if (block.type === 'operation') return <OperationBlock {...props} block={block}/>;
  if (block.type === 'divider') return <hr className={styles.divider}/>;
  if (block.type === 'heading') return <h3 className={styles.sectionTitle}>{block.text || 'Heading'}</h3>;
  if (block.type === 'link') return <a className={`${styles.panel} ${styles.link}`} href={block.url} rel="noopener noreferrer">{block.title || block.url} ↗</a>;
  return <div className={`${styles.panel} ${block.surface === 'plain' ? styles.plain : ''} ${block.type === 'callout' ? styles.callout : ''}`}>{block.title && <h3 className={styles.blockTitle}>{block.title}</h3>}<div className={styles.prose}><ReactMarkdown>{block.text || 'Add a note in block settings.'}</ReactMarkdown></div></div>;
}
export function DashboardDetails({ selected, data, page, catalog, close, resource }: { selected: DashboardInspection | null; data: Record<string, DashboardMetricState>; page: DashboardDocument; catalog: TelemetryCatalog | null; close: () => void; resource?: { dashboardId: string } }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (selected) ref.current?.showModal(); else ref.current?.close(); }, [selected]);
  const state = selected?.bindingId ? data[selected.bindingId] : undefined;
  const binding = page.metrics.find(metric => metric.id === selected?.bindingId);
  return <dialog ref={ref} className={`${styles.dialog} ${styles.drawer}`} onClose={close} aria-labelledby="dashboard-detail-title"><div className={styles.drawerHeader}><h2 id="dashboard-detail-title">{selected?.title}</h2><button autoFocus type="button" className={styles.button} onClick={close} aria-label="Close details"><X/></button></div>
    {selected?.operation ? <><p className={styles.description}>Operational statistics use the existing project-scoped run and task records. Run totals cover runs created in the last 24 hours; completed tasks use their recorded completion time.</p><div className={styles.filters}><Link className={styles.button} href={['agents', 'templates'].includes(selected.operation) ? '/agents' : '/settings/logs'}>Open {['agents', 'templates'].includes(selected.operation) ? 'agents' : 'execution logs'} <ArrowUpRight/></Link></div></> : state?.result ? <>
      <div className={styles.filters}><span>Exact value: {telemetryExactValue(state.result.value)}</span>{binding && resource && <Link className={styles.button} href={`/telemetry?tab=analyze&dashboard_id=${encodeURIComponent(resource.dashboardId)}&widget_id=${encodeURIComponent(binding.id)}${page.scope?.project_id ? `&project_id=${page.scope.project_id}` : ''}`}>Open in Analyze <ArrowUpRight/></Link>}</div>
      <TelemetryResultCard key={`${state.result.query_id}:${JSON.stringify(selected?.group)}`} result={{ ...state.result, title: selected?.title }} catalog={catalog} display="table" initialGroup={selected?.group} showRecords/>
    </> : <p className={styles.error}>{state?.error || 'This result is loading or no longer available. Refresh the dashboard to try again.'}</p>}
  </dialog>;
}
