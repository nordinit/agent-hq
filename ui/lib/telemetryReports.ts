import type { TelemetryQuery, TelemetryReport, TelemetryScope } from './telemetryTypes.ts';
import { telemetryUtcBoundary } from './telemetryBuilder.ts';

export interface TelemetryReportFilters { scope: TelemetryScope; from: string; to: string; timezone: string; grouping: string }
export function savedTelemetryReportFilters(report: TelemetryReport): TelemetryReportFilters {
  const definition = report.definition; const timezone = definition.timezone ?? 'UTC';
  const wallTime = (value?: string) => {
    if (!value) return '';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  };
  return { scope: { include_archived: true, ...(definition.scope ?? report.scope) }, from: wallTime(definition.from), to: wallTime(definition.to), timezone,
    grouping: !definition.group_by?.length ? '' : definition.group_by.length === 1 && 'field' in definition.group_by[0] ? definition.group_by[0].field : '__saved__' };
}
export function telemetryReportQuery(report: TelemetryReport, filters?: TelemetryReportFilters): TelemetryQuery {
  const saved = savedTelemetryReportFilters(report); const selected = filters ?? saved;
  if ((report.definition.from && !selected.from) || (report.definition.to && !selected.to)) throw new Error('This report revision has a saved time window. Edit the report definition to remove its boundary.');
  // Preserve an exact saved instant (including repeated DST wall times) until edited.
  const from = selected.from === saved.from && selected.timezone === saved.timezone ? report.definition.from : telemetryUtcBoundary(selected.from, selected.timezone);
  const to = selected.to === saved.to && selected.timezone === saved.timezone ? report.definition.to : telemetryUtcBoundary(selected.to, selected.timezone);
  if (from && to && from >= to) throw new Error('The end of the time window must be later than its start.');
  return { report_revision_id: report.latest_revision_id, scope: selected.scope, from, to, timezone: selected.timezone,
    group_by: selected.grouping === '__saved__' ? report.definition.group_by : selected.grouping ? [{ field: selected.grouping }] : [] };
}

export function telemetryFamilyCoverageNotice(unbound = 0, disabled = 0): string | null {
  return unbound || disabled ? `Scoped coverage: ${unbound} tasks have no metric binding; ${disabled} tasks have an explicit disable. Displayed measurements include only applicable active definitions.` : null;
}
