import type { DashboardBlock, DashboardColumn, DashboardDocument, DashboardDraft, DashboardOperation, DashboardSection } from './dashboardTypes.ts';
import type { Scalar, TelemetryReport, TelemetryResult } from './telemetryTypes.ts';
import { createClientId } from './clientId.ts';

export const dashboardId = createClientId;
export const operationLabels: Record<DashboardOperation, string> = {
  agents: 'Total agents', active_runs: 'Active runs', templates: 'Enabled templates', runs: 'Runs · last 24h',
  completed_runs: 'Completed runs · last 24h', tokens: 'Tokens · last 24h', failed_runs: 'Failed runs · last 24h',
  failures: 'Recent failures', completed_tasks: 'Completed tasks · last 24h', links: 'Quick links',
};
export function dashboardSection(title: string, blocks: DashboardBlock[] = [], count = 1): DashboardSection {
  const columns: DashboardColumn[] = Array.from({ length: count }, () => ({ id: dashboardId(), width: 12 / count, blocks: [] }));
  blocks.forEach((block, index) => columns[index % count].blocks.push(block));
  return { id: dashboardId(), title, columns };
}
export function blankDashboard(): DashboardDraft {
  return { name: 'My dashboard', definition: { version: 1, template: 'blank', description: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    scope: { include_archived: true }, appearance: { width: 'wide', density: 'comfortable' }, metrics: [], sections: [dashboardSection('Overview')] } };
}
export function operationsDashboard(): DashboardDraft {
  const draft = blankDashboard(); draft.name = 'Operational overview';
  const operations: DashboardOperation[] = ['agents', 'active_runs', 'templates', 'runs', 'completed_runs', 'tokens'];
  const accents = ['blue', 'amber', 'violet', 'neutral', 'green', 'cyan'] as const;
  const icons = ['bot', 'activity', 'layers', 'clock', 'check', 'coins'] as const;
  draft.definition.template = 'operations';
  draft.definition.description = 'Your agents, execution activity, and recently completed work.';
  draft.definition.sections = [dashboardSection('', operations.map((operation, i) => ({ id: dashboardId(), type: 'operation', operation, accent: accents[i], icon: icons[i] })), 3),
    dashboardSection('Execution health', [{ id: dashboardId(), type: 'operation', operation: 'failed_runs', accent: 'red' }, { id: dashboardId(), type: 'operation', operation: 'failures' }], 2),
    dashboardSection('', [{ id: dashboardId(), type: 'operation', operation: 'completed_tasks' }]),
    dashboardSection('', [{ id: dashboardId(), type: 'operation', operation: 'links' }])];
  return draft;
}
/** Read-only conversion: immutable metric pins, exact boundaries and saved overrides survive. */
export function dashboardFromReport(report: TelemetryReport): DashboardDraft {
  const source = structuredClone(report.definition);
  const metrics = source.metrics.map(metric => ({ ...metric, id: metric.id ?? dashboardId() }));
  const agencyIds = ['searches', 'raw_hits', 'reviewed', 'qualification_rate', 'qualified_per_search', 'drafts_per_search', 'rejection_rate', 'average_score', 'commercial_refusal'];
  const agency = agencyIds.every(id => metrics.some(metric => metric.id === id)) && metrics.length === 9;
  const titles: Record<string, string> = { searches: 'Verified searches', raw_hits: 'Retrieved entries', reviewed: 'Fresh candidates reviewed', qualification_rate: 'Qualification rate', qualified_per_search: 'Qualified per search', drafts_per_search: 'Drafts per search', rejection_rate: 'Screening rejection', average_score: 'Weighted score / 10', commercial_refusal: 'Commercial refusals' };
  const ordered = agency ? agencyIds.map(id => metrics.find(metric => metric.id === id)!) : metrics;
  const colors = ['blue', 'cyan', 'violet', 'green', 'amber', 'blue'] as const;
  const icons = ['search', 'layers', 'users', 'check', 'target', 'file'] as const;
  const blocks: DashboardBlock[] = ordered.map((metric, i) => ({ id: dashboardId(), type: 'metric', binding_id: metric.id, title: agency ? titles[metric.id] : metric.title,
    display: 'card', precision: agency && ['qualification_rate', 'rejection_rate', 'commercial_refusal'].includes(metric.id) ? 1 : 2, accent: colors[i % colors.length], icon: icons[i % icons.length] }));
  const sections = [dashboardSection('', agency ? blocks.slice(0, 6) : blocks, 3)];
  if (agency) {
    const section = dashboardSection('Query performance & outcomes', [], 2);
    section.columns[0].width = 8; section.columns[1].width = 4;
    section.columns[0].blocks = [{ id: dashboardId(), title: 'Query performance', type: 'comparison', binding_ids: ['qualified_per_search', 'drafts_per_search', 'qualification_rate'], rows: 9, sort: 'value_desc', sort_by: 'qualified_per_search' }];
    section.columns[1].blocks = blocks.slice(6).map(block => ({ ...block, surface: 'plain', accent: 'neutral' }));
    sections.push(section);
  }
  if (report.description) sections.push({ ...dashboardSection('About these metrics', [{ id: dashboardId(), type: 'note', text: report.description, surface: 'plain' }]), collapsed: true });
  return { name: report.name, definition: { version: 1, template: agency ? 'agency' : 'imported', description: agency ? 'Search activity, candidate quality, and outreach outcomes.' : report.description?.slice(0, 2000),
    metrics, sections, appearance: { density: 'comfortable', width: 'wide' }, scope: { include_archived: true, ...report.scope, ...source.scope }, from: source.from, to: source.to, timezone: source.timezone ?? 'UTC' } };
}
export function dashboardBlocks(page: DashboardDocument) { return page.sections.flatMap(section => section.columns.flatMap(column => column.blocks)); }
export function findDashboardBlock(page: DashboardDocument, id: string) { return dashboardBlocks(page).find(block => block.id === id); }
export function updateDashboardBlock(page: DashboardDocument, id: string, update: (block: DashboardBlock) => DashboardBlock): DashboardDocument {
  return { ...page, sections: page.sections.map(section => ({ ...section, columns: section.columns.map(column => ({ ...column, blocks: column.blocks.map(block => block.id === id ? update(block) : block) })) })) };
}
export function removeDashboardBlock(page: DashboardDocument, id: string): DashboardDocument {
  const next = { ...page, sections: page.sections.map(section => ({ ...section, columns: section.columns.map(column => ({ ...column, blocks: column.blocks.filter(block => block.id !== id) })) })) };
  const used = new Set(dashboardBlocks(next).flatMap(block => block.type === 'metric' ? [block.binding_id] : block.type === 'comparison' ? block.binding_ids : []));
  return { ...next, metrics: next.metrics.filter(metric => used.has(metric.id)) };
}
/** Moves use stable identities; empty columns are valid drop targets. */
export function moveDashboardBlock(page: DashboardDocument, id: string, targetColumnId: string, beforeId?: string): DashboardDocument {
  const block = findDashboardBlock(page, id);
  if (!block || beforeId === id || !page.sections.some(section => section.columns.some(column => column.id === targetColumnId))) return page;
  const next = structuredClone(page);
  for (const section of next.sections) for (const column of section.columns) column.blocks = column.blocks.filter(item => item.id !== id);
  const target = next.sections.flatMap(section => section.columns).find(column => column.id === targetColumnId)!;
  const at = beforeId ? target.blocks.findIndex(item => item.id === beforeId) : target.blocks.length;
  target.blocks.splice(at < 0 ? target.blocks.length : at, 0, block);
  return next;
}
export function resizeDashboardColumns(page: DashboardDocument, sectionId: string, columnIndex: number, width: number): DashboardDocument {
  const next = structuredClone(page); const columns = next.sections.find(section => section.id === sectionId)?.columns;
  if (!columns?.[columnIndex + 1]) return page;
  const total = columns[columnIndex].width + columns[columnIndex + 1].width;
  columns[columnIndex].width = Math.max(1, Math.min(total - 1, Math.round(width)));
  columns[columnIndex + 1].width = total - columns[columnIndex].width;
  return next;
}
export function setDashboardColumns(page: DashboardDocument, sectionId: string, count: number): DashboardDocument {
  return { ...page, sections: page.sections.map(section => section.id === sectionId ? { ...section, columns: dashboardSection('', section.columns.flatMap(column => column.blocks), count).columns } : section) };
}
/** Formatting only; preserve source decimal strings and do not coerce them to a float. */
export function formatDashboardValue(value: Scalar | undefined, unit?: string, precision = 2): string {
  if (value == null) return '—';
  const raw = typeof value === 'object' ? value.decimal : String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: precision }).format(value) : '—';
  const places = Math.max(0, Math.min(6, precision));
  let integer = match[2], fraction = match[3] ?? '';
  if (unit === 'percent') { fraction = fraction.padEnd(2, '0'); integer += fraction.slice(0, 2); fraction = fraction.slice(2); }
  const kept = fraction.padEnd(places + 1, '0');
  let digits = BigInt(integer + kept.slice(0, places));
  if (Number(kept[places]) >= 5) digits += BigInt(1);
  const text = digits.toString().padStart(places + 1, '0');
  const whole = (places ? text.slice(0, -places) : text).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const tail = places ? text.slice(-places).replace(/0+$/, '') : '';
  return `${match[1] && digits !== BigInt(0) ? '-' : ''}${whole}${tail ? `.${tail}` : ''}${unit === 'percent' ? '%' : ''}`;
}
/** Compare exact group keys only when dimensions, scope and time semantics agree. */
export function dashboardComparisonIssue(results: TelemetryResult[]): string | null {
  if (!results.length) return null;
  const signature = (result: TelemetryResult) => JSON.stringify({ grain: result.definition?.grain, time: result.definition?.time_basis, group: result.definition?.group_by, bucket: result.definition?.bucket, attribution: result.definition?.attribution, scope: result.scope });
  if (results.some(result => !result.definition?.group_by?.length && !result.definition?.bucket)) return 'Choose metrics with a saved breakdown to compare groups.';
  if (results.some(result => signature(result) !== signature(results[0]))) return 'These metrics use different groups, scopes, or time bases. Inspect them separately.';
  return null;
}
