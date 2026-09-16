import type { MetricDefinition, Predicate, ValueBasis } from './telemetryTypes.ts';
import { numericRecipe, milestoneRecipe, firstPassRecipe, durationRecipe, blockedSnapshotRecipe, everBlockedRecipe, percentTimeBlockedRecipe, funnelRecipe } from './telemetry-contracts/recipes.ts';

export type TelemetryRecipe = 'numeric' | 'count' | 'milestone' | 'first_pass' | 'duration' | 'blocked' | 'ever_blocked' | 'percent_blocked' | 'funnel';
export interface TelemetryGuide {
  recipe: TelemetryRecipe;
  key: string;
  name: string;
  field: string;
  aggregate: 'sum' | 'mean' | 'min' | 'max' | 'percentile' | 'distribution';
  percentile: number;
  basis: ValueBasis;
  unit: string;
  start: string;
  success: string;
  rework: string;
  unsuccessful: string;
  cancelled: string;
  blocked: string;
  unblocked: string;
  denominator: 'evaluated' | 'successful' | 'all_started';
  counting: 'first_per_entity' | 'per_reset' | 'per_stage_visit';
  reset: string;
  attribution: NonNullable<MetricDefinition['attribution']>;
  filterField: string;
  filterOp: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_present' | 'is_missing';
  filterValue: string;
  filterType: string;
  steps: string[];
  bucket: '' | 'hour' | 'day' | 'week' | 'month';
}
export function newTelemetryGuide(): TelemetryGuide {
  return { recipe: 'count', key: 'task_count', name: 'Task count', field: '', aggregate: 'sum', percentile: 0.95, basis: 'current', unit: '', start: 'event:task.created', success: '', rework: '', unsuccessful: '', cancelled: '', blocked: '', unblocked: '', denominator: 'evaluated', counting: 'first_per_entity', reset: '', attribution: 'assigned_agent_current', filterField: '', filterOp: 'eq', filterValue: '', filterType: 'text', steps: ['', ''], bucket: '' };
}
export function telemetrySignal(value: string, catalogSignals: Record<string, Predicate> = {}): Predicate {
  const separator = value.indexOf(':');
  const kind = value.slice(0, separator);
  const selected = value.slice(separator + 1);
  if (separator < 0 || !selected) throw new Error('Choose the required milestone or condition.');
  if (kind === 'catalog') {
    if (!catalogSignals[selected]) throw new Error('The selected routing signal is unavailable in this catalog scope. Select an available signal.');
    return structuredClone(catalogSignals[selected]);
  }
  if (kind === 'status') return { field: 'event.to_status', op: 'eq', value: selected };
  if (kind === 'outcome') return { field: 'event.outcome', op: 'eq', value: selected };
  if (kind === 'event') return { field: 'event.type', op: 'eq', value: selected };
  if (kind === 'field') return { field: selected, op: 'eq', value: true };
  throw new Error('This signal type is unavailable.');
}
export function buildTelemetryDefinition(guide: TelemetryGuide, catalogSignals: Record<string, Predicate> = {}): MetricDefinition {
  const selectedSignal = (value: string) => telemetrySignal(value, catalogSignals);
  const optionalSignal = (value: string) => value ? selectedSignal(value) : undefined;
  if (!guide.name.trim() || !guide.key.trim()) throw new Error('Give the metric a name and a key.');
  const named = { key: guide.key.trim(), name: guide.name.trim() };
  const journey = () => ({ ...named, start: selectedSignal(guide.start), success: selectedSignal(guide.success), rework: optionalSignal(guide.rework), unsuccessful: optionalSignal(guide.unsuccessful), cancelled: optionalSignal(guide.cancelled), counting: guide.counting, denominator: guide.denominator, ...(guide.counting === 'per_reset' ? { reset: selectedSignal(guide.reset) } : {}) });
  let definition: MetricDefinition;
  if (guide.recipe === 'numeric') {
    if (!guide.field) throw new Error('Choose a numeric field from the canonical catalog.');
    definition = numericRecipe({ ...named, field: guide.field, aggregate: guide.aggregate === 'distribution' ? 'sum' : guide.aggregate, basis: guide.basis, unit: guide.unit || 'number', percentile: guide.percentile });
    if (guide.aggregate === 'distribution') definition.measure = { kind: 'aggregate', aggregate: 'distribution', value: { field: guide.field, basis: guide.basis }, buckets: [0, 10, 50, 100, 500, 1000] };
    if (guide.basis === 'at_event') { definition.grain = 'event'; definition.time_basis = 'event_occurred_at'; definition.population = selectedSignal(guide.success); }
    else if (guide.basis !== 'current') { definition.grain = 'journey'; definition.time_basis = 'journey_started_at'; definition.journey = firstPassRecipe(journey()).journey; }
  } else if (guide.recipe === 'milestone') definition = milestoneRecipe({ ...named, milestone: selectedSignal(guide.success) });
  else if (guide.recipe === 'first_pass') definition = firstPassRecipe(journey());
  else if (guide.recipe === 'duration') {
    definition = durationRecipe({ ...named, start: selectedSignal(guide.start), end: selectedSignal(guide.success), aggregate: guide.aggregate });
    if (definition.measure.kind === 'aggregate' && guide.aggregate === 'percentile') definition.measure.percentile = guide.percentile;
    if (definition.measure.kind === 'aggregate' && guide.aggregate === 'distribution') definition.measure.buckets = [60000, 3600000, 86400000, 604800000];
  } else if (guide.recipe === 'blocked') {
    const blocked: Predicate = guide.blocked.startsWith('status:') ? { field: 'status', op: 'eq', value: guide.blocked.slice(7) } : selectedSignal(guide.blocked);
    definition = blockedSnapshotRecipe({ ...named, blocked });
  } else if (guide.recipe === 'ever_blocked') definition = everBlockedRecipe({ ...journey(), blocked: selectedSignal(guide.blocked) });
  else if (guide.recipe === 'percent_blocked') definition = percentTimeBlockedRecipe({ ...journey(), blocked_start: selectedSignal(guide.blocked), blocked_end: selectedSignal(guide.unblocked) });
  else if (guide.recipe === 'funnel') definition = funnelRecipe({ ...journey(), steps: guide.steps.map((step, index) => ({ key: `step_${index + 1}`, label: step.slice(step.indexOf(':') + 1), where: selectedSignal(step) })) });
  else definition = { version: 1, ...named, grain: 'task', measure: { kind: 'aggregate', aggregate: 'count' }, time_basis: 'current', missing_policy: 'exclude_and_report', unit: 'count' };
  definition.attribution = guide.attribution;
  if (guide.filterField) {
    let value: string | number | boolean = guide.filterValue;
    if (guide.filterType === 'number' && !['is_present', 'is_missing'].includes(guide.filterOp)) {
      if (!guide.filterValue.trim() || !Number.isFinite(Number(guide.filterValue))) throw new Error('The numeric population filter needs a valid number.');
      value = Number(guide.filterValue);
    }
    if (guide.filterType === 'checkbox') {
      if (!['true', 'false'].includes(guide.filterValue) && !['is_present', 'is_missing'].includes(guide.filterOp)) throw new Error('Choose true or false for a checkbox population filter.');
      value = guide.filterValue === 'true';
    }
    const population: Predicate = { field: guide.filterField, op: guide.filterOp, ...(['is_present', 'is_missing'].includes(guide.filterOp) ? {} : { value }) };
    definition.population = definition.population ? { all: [definition.population, population] } : population;
  }
  if (guide.bucket) definition.bucket = guide.bucket;
  return definition;
}

/** Reopen a guided definition only when the form can represent it without dropping settings. */
export function telemetryGuideFromDefinition(definition: MetricDefinition): TelemetryGuide | null {
  const guide: TelemetryGuide = { ...newTelemetryGuide(), key: definition.key, name: definition.name, unit: definition.unit ?? '', attribution: definition.attribution ?? 'assigned_agent_current', bucket: definition.bucket ?? '' };
  const signal = (predicate?: Predicate): string => {
    if (!predicate) return '';
    if (!('field' in predicate) || predicate.op !== 'eq') throw new Error('Advanced signal');
    if (predicate.field === 'event.to_status') return `status:${predicate.value}`;
    if (predicate.field === 'event.outcome') return `outcome:${predicate.value}`;
    if (predicate.field === 'event.type') return `event:${predicate.value}`;
    if (predicate.value === true) return `field:${predicate.field}`;
    throw new Error('Advanced signal');
  };
  try {
    const measure = definition.measure;
    if (definition.journey) {
      const journey = definition.journey;
      Object.assign(guide, { start: signal(journey.start), success: signal(journey.success), rework: signal(journey.rework), unsuccessful: signal(journey.unsuccessful), cancelled: signal(journey.cancelled), reset: signal(journey.reset), counting: journey.counting, denominator: journey.denominator });
      if (measure.kind === 'funnel') { guide.recipe = 'funnel'; guide.steps = measure.steps.map(step => signal(step.where)); }
      else if (measure.kind === 'ratio' && measure.numerator.value && 'field' in measure.numerator.value && measure.numerator.value.field === 'journey.blocked_ms') { guide.recipe = 'percent_blocked'; guide.blocked = signal(journey.pause_start); guide.unblocked = signal(journey.pause_end); }
      else if (measure.kind === 'ratio' && measure.numerator.where && 'field' in measure.numerator.where && measure.numerator.where.field === 'journey.disqualified' && measure.numerator.where.value === true) { guide.recipe = 'ever_blocked'; guide.blocked = signal(journey.rework); guide.rework = ''; }
      else guide.recipe = 'first_pass';
    }
    if (measure.kind === 'aggregate') {
      if (measure.value && 'duration' in measure.value) { guide.recipe = 'duration'; guide.start = signal(measure.value.duration.start); guide.success = signal(measure.value.duration.end); }
      else if (definition.grain === 'event' && measure.aggregate === 'distinct_count') { guide.recipe = 'milestone'; guide.success = signal(measure.where); }
      else if (measure.value && 'field' in measure.value) { guide.recipe = 'numeric'; guide.field = measure.value.field; guide.basis = measure.value.basis ?? 'current'; if (definition.grain === 'event') guide.success = signal(definition.population); }
      else guide.recipe = 'count';
      if (['sum', 'mean', 'min', 'max', 'percentile', 'distribution'].includes(measure.aggregate)) guide.aggregate = measure.aggregate as TelemetryGuide['aggregate'];
      guide.percentile = measure.percentile ?? 0.95;
    } else if (measure.kind === 'ratio' && !definition.journey) {
      guide.recipe = 'blocked';
      const blocked = measure.numerator.where;
      guide.blocked = blocked && 'field' in blocked && blocked.field === 'status' && blocked.op === 'eq' ? `status:${blocked.value}` : signal(blocked);
    }
    if (definition.population && !(guide.recipe === 'numeric' && guide.basis === 'at_event')) {
      const population = definition.population;
      if (!('field' in population) || Array.isArray(population.value) || typeof population.value === 'object') return null;
      guide.filterField = population.field; guide.filterOp = population.op as TelemetryGuide['filterOp']; guide.filterValue = String(population.value ?? '');
      guide.filterType = typeof population.value === 'number' ? 'number' : typeof population.value === 'boolean' ? 'checkbox' : 'text';
    }
    const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
    return canonical(buildTelemetryDefinition(guide)) === canonical(definition) ? guide : null;
  } catch { return null; }
}

/** Interpret wall time in the selected zone, never in the browser or API host zone. */
export function telemetryUtcBoundary(value: string, timezone: string): string | undefined {
  if (!value) return undefined;
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value)) {
    const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) throw new Error('Enter a valid time boundary.'); return parsed.toISOString();
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error('Enter a complete date and time.');
  const numbers = match.slice(1).map(part => Number(part ?? 0));
  const desired = Date.UTC(numbers[0], numbers[1] - 1, numbers[2], numbers[3], numbers[4], numbers[5]);
  const calendar = new Date(desired);
  if (calendar.getUTCFullYear() !== numbers[0] || calendar.getUTCMonth() + 1 !== numbers[1] || calendar.getUTCDate() !== numbers[2] || calendar.getUTCHours() !== numbers[3] || calendar.getUTCMinutes() !== numbers[4] || calendar.getUTCSeconds() !== numbers[5]) throw new Error('Enter a valid calendar date and time.');
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const wallAt = (instant: number) => { const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value])); return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)); };
  let instant = desired;
  for (let count = 0; count < 4; count++) instant += desired - wallAt(instant);
  if (wallAt(instant) !== desired) throw new Error('That local time does not exist in the selected timezone (daylight-saving change). Choose another time.');
  const offsets = new Set([-172800000, -86400000, 0, 86400000, 172800000].map(delta => wallAt(instant + delta) - (instant + delta)));
  const matchingInstants = [...offsets].map(offset => desired - offset).filter(candidate => wallAt(candidate) === desired);
  if (new Set(matchingInstants).size > 1) throw new Error('That local time occurs twice in the selected timezone. Use UTC to select the intended instant.');
  return new Date(instant).toISOString();
}
