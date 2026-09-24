/** Presentation helpers deliberately do not calculate metrics from task rows. */
export type TelemetryScalar = number | string | { decimal: string } | null;

/** Ratio row values are numerator contributions, not per-record percentages. */
export function formatTelemetryContribution(row: { value: TelemetryScalar | boolean; numerator?: TelemetryScalar; denominator?: TelemetryScalar }, unit?: string): string {
  if (row.denominator != null) return `${formatTelemetryValue(row.numerator)} / ${formatTelemetryValue(row.denominator)}`;
  return typeof row.value === 'boolean' ? String(row.value) : formatTelemetryValue(row.value, unit);
}

export function formatTelemetryValue(value: TelemetryScalar | undefined, unit?: string): string {
  if (value == null) return '—';
  const raw = typeof value === 'object' ? value.decimal : value;
  // Decimal strings exist specifically to avoid loss of precision in JSON.
  if (typeof raw === 'string') {
    if (unit === 'percent') return `${roundDecimalText(shiftDecimal(raw, 2), 2)}%`;
    return unit && !['count', 'number', 'dimensionless'].includes(unit) ? `${raw} ${unit}` : raw;
  }
  if (!Number.isFinite(raw)) return '—';
  if (unit === 'percent') return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 2 }).format(raw);
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(raw);
  return unit && !['count', 'number', 'dimensionless'].includes(unit) ? `${formatted} ${unit}` : formatted;
}

export function telemetryExactValue(value: TelemetryScalar | undefined): string {
  return value == null ? 'No value' : typeof value === 'object' ? value.decimal : String(value);
}
function roundDecimalText(value: string, places: number): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return value;
  const fraction = (match[3] ?? '').padEnd(places + 1, '0');
  const digits = `${match[2]}${fraction.slice(0, places)}`.split('');
  if (Number(fraction[places]) >= 5) {
    let carry = 1;
    for (let index = digits.length - 1; index >= 0 && carry; index--) { const next = Number(digits[index]) + carry; digits[index] = String(next % 10); carry = next >= 10 ? 1 : 0; }
    if (carry) digits.unshift('1');
  }
  const combined = digits.join('').padStart(places + 1, '0');
  const integer = combined.slice(0, -places).replace(/^0+(?=\d)/, '');
  const decimals = combined.slice(-places).replace(/0+$/, '');
  const sign = /^0*$/.test(combined) ? '' : match[1];
  return `${sign}${integer}${decimals ? `.${decimals}` : ''}`;
}

function shiftDecimal(value: string, places: number): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return value;
  const decimals = (match[3] ?? '').padEnd(places, '0');
  const integer = `${match[2]}${decimals.slice(0, places)}`.replace(/^0+(?=\d)/, '');
  const remainder = decimals.slice(places).replace(/0+$/, '');
  return `${match[1]}${integer}${remainder ? `.${remainder}` : ''}`;
}

export function parseTelemetryDraft(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('A definition must be a JSON object.');
  return parsed as Record<string, unknown>;
}

/** All request effects use a sequence token, including scope changes before a response arrives. */
export function createTelemetryRequestGuard() {
  let generation = 0;
  return {
    begin: () => ++generation,
    invalidate: () => { generation += 1; },
    isCurrent: (token: number) => token === generation,
  };
}

export function telemetryScopeQuery(scope: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(scope)) {
    if (value != null && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function telemetryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function telemetryGroupLabel(group: Record<string, unknown> | undefined): string {
  if (!group || !Object.keys(group).length) return 'All included records';
  return Object.entries(group).map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value == null ? 'Unassigned' : String(value)}`).join(' · ');
}

export function telemetryBindingScopeLabel(scope: { project_id?: number; workflow_id?: number; workflow_type?: string; task_type?: string }): string {
  if (scope.workflow_id) return scope.task_type ? 'Workflow + task type override' : 'Workflow override';
  if (scope.workflow_type) return `${scope.project_id ? 'Project' : 'Tenant'} + workflow type${scope.task_type ? ' + task type' : ''}`;
  return scope.project_id ? 'Project default' : 'Tenant default';
}
