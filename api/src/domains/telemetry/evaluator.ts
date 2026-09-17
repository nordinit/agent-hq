import {
  AggregateMeasure, CatalogDescriptor, Contribution, DefinitionIssue, DefinitionValidation,
  EvaluateMetricInput, FunnelStepResult, GroupResult, JourneyDefinition, MetricDefinition,
  MetricResult, NumericResult, Predicate, Scalar, TelemetryDefinitionError, TelemetryEntity,
  TelemetryObservation, ValueExpression,
} from './contracts';
import { Decimal, sumDecimals } from './decimal';
import { compileTelemetryRegex } from './regex';
import { metricAttributionIssues } from './requirements';

const MAX_NODES = 500;
const MAX_DEPTH = 12;
const MAX_SAMPLES = 50000;
const MAX_OBSERVATIONS = 250000;
const MAX_GROUPS = 1000;
const bases = ['current', 'at_entry', 'at_event', 'at_resolution'];
const comparisons = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'is_missing', 'is_present'];
const aggregates = ['count', 'count_if', 'distinct_count', 'sum', 'mean', 'min', 'max', 'percentile', 'distribution'];
const builtins: Record<string, string> = {
  id: 'text', title: 'text', name: 'text', status: 'text', priority: 'text', task_type: 'text', workflow_type: 'text',
  project_id: 'number', workflow_id: 'number',  agent_id: 'number', assigned_agent_id: 'number',
  executing_agent_id: 'number', outcome_agent_id: 'number', actor_agent_id: 'number', created_at: 'datetime', updated_at: 'datetime',
  started_at: 'datetime', ended_at: 'datetime', duration_ms: 'number', story_points: 'number', retry_count: 'number',
  tokens_in: 'number', tokens_out: 'number', tokens_total: 'number', input_tokens: 'number', output_tokens: 'number',
  runtime_state: 'text', state: 'text', runtime_type: 'text', model: 'text', instruction_version: 'text',
  instruction_fingerprint: 'text', runtime_failed: 'checkbox', missing_handoff: 'checkbox', failure_reason: 'text',
  'event.type': 'text', 'event.from_status': 'text', 'event.to_status': 'text', 'event.outcome': 'text',
  'event.occurred_at': 'datetime', 'event.actor_agent_id': 'number', 'event.runtime_state': 'text',
  'journey.resolution': 'text', 'journey.disqualified': 'checkbox', 'journey.attempts': 'number',
  'journey.duration_ms': 'number', 'journey.blocked_ms': 'number', 'journey.started_at': 'datetime',
  'journey.resolved_at': 'datetime', 'journey.ever_blocked': 'checkbox',
};
function record(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function scalar(value: unknown): value is Scalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
    (record(value) && Object.keys(value).length === 1 && typeof value.decimal === 'string' && Decimal.parse(value) !== null);
}

/** This is the single runtime validator used by storage, UI preview, imports and MCP. */
export function validateMetricDefinition(value: unknown, catalog?: CatalogDescriptor[]): DefinitionValidation {
  const errors: DefinitionIssue[] = [];
  const references = new Set<string>();
  const descriptors = new Map((catalog ?? []).map(field => [field.id, field]));
  let nodes = 0;
  const issue = (path: string, message: string, code = 'invalid_definition'): void => { if (errors.length < 30) errors.push({ path, message, code }); };
  const keys = (node: Record<string, unknown>, allowed: string[], path: string): void => {
    for (const key of Object.keys(node)) if (!allowed.includes(key)) issue(`${path}.${key}`, 'Unsupported expression property.', 'unsupported_operation');
  };
  const enter = (node: unknown, path: string, depth: number): node is Record<string, any> => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) { issue(path, `Expressions are limited to ${MAX_NODES} nodes and depth ${MAX_DEPTH}.`, 'query_limit_exceeded'); return false; }
    if (!record(node)) { issue(path, 'Expected an object.'); return false; }
    // Depth/node limits also stop cyclic in-process input; normal JSON may repeat subtrees.
    return true;
  };
  const field = (node: Record<string, any>, path: string): { type: string; unit?: string | null } => {
    if (typeof node.field !== 'string' || !node.field || node.field.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(node.field)) {
      issue(path, 'Field reference must be a bounded catalog identity.'); return { type: 'unknown' };
    }
    const snapshotField = node.field.startsWith('event.before.') ? node.field.slice(13) : node.field.startsWith('event.after.') ? node.field.slice(12) : undefined;
    references.add(snapshotField ?? node.field);
    const descriptor = descriptors.get(snapshotField ?? node.field);
    if (catalog && !descriptor && !builtins[snapshotField ?? node.field]) issue(path, `Unknown field reference: ${node.field}`, 'unknown_reference');
    if (node.basis !== undefined && !bases.includes(node.basis)) issue(path, 'Unsupported value basis.');
    if (record(value) && ['at_entry', 'at_resolution'].includes(node.basis) && value.grain !== 'journey') issue(path, 'Entry and resolution values require a defined journey.', 'insufficient_history');
    if (record(value) && node.basis === 'at_event' && value.grain !== 'event' && !path.startsWith('journey.') && !/\.(duration|event_count|event_exists)\./.test(path)) issue(path, 'Event values require an event measurement or an explicit event condition.', 'insufficient_history');
    if (descriptor?.bases && node.basis && !descriptor.bases.includes(node.basis)) issue(path, `Field is unavailable at ${node.basis}.`, 'insufficient_history');
    if(descriptor?.supported_grains&&record(value)&&!descriptor.supported_grains.includes(value.grain))issue(path,`Field ${node.field} is unavailable for ${value.grain} grain. Select its supported entity grain.`,'incompatible_field_type');
    return { type: descriptor?.type ?? builtins[node.field] ?? 'unknown', unit: descriptor?.unit };
  };
  const predicate = (node: unknown, path: string, depth: number): void => {
    if (!enter(node, path, depth)) return;
    if ('all' in node || 'any' in node) {
      const key = 'all' in node ? 'all' : 'any';
      keys(node, [key], path);
      if (!Array.isArray(node[key]) || node[key].length < 1 || node[key].length > 50) issue(path, `${key} requires 1–50 conditions.`);
      else node[key].forEach((child: unknown, i: number) => predicate(child, `${path}.${key}[${i}]`, depth + 1));
      return;
    }
    if ('not' in node) { keys(node, ['not'], path); predicate(node.not, `${path}.not`, depth + 1); return; }
    if (node.op === 'matches_regex') {
      keys(node, ['field', 'basis', 'op', 'value', 'flags'], path);
      const descriptor = field(node, path);
      if (!['text', 'textarea', 'url', 'select', 'unknown'].includes(descriptor.type)) issue(path, 'Regex matching requires a text field.', 'incompatible_field_type');
      try { compileTelemetryRegex(node.value, node.flags); }
      catch (error) { issue(`${path}.value`, error instanceof Error ? error.message : String(error)); }
      return;
    }
    keys(node, 'field' in node ? ['field', 'basis', 'op', 'value'] : ['left', 'op', 'right'], path);
    if (!comparisons.includes(node.op)) issue(path, 'Unknown comparison operator.', 'unsupported_operation');
    const left = 'field' in node ? field(node, path) : expression(node.left, `${path}.left`, depth + 1);
    if (!['is_missing', 'is_present'].includes(node.op)) {
      if ('field' in node) {
        if (['in', 'not_in'].includes(node.op)) {
          if (!Array.isArray(node.value) || node.value.length > 100 || !node.value.every(scalar)) issue(path, 'Membership requires at most 100 scalar values.');
        } else if (!scalar(node.value)) issue(path, 'Comparison requires a scalar value.');
        if (left.type === 'number' && node.value !== null && !['in', 'not_in'].includes(node.op) && !Decimal.parse(node.value)) issue(path, 'Numeric fields require numeric comparison values.', 'incompatible_field_type');
        if (left.type === 'checkbox' && node.value !== null && !['in', 'not_in'].includes(node.op) && typeof node.value !== 'boolean') issue(path, 'Checkbox fields require boolean comparison values.', 'incompatible_field_type');
        if (left.type==='datetime'||left.type==='date')for(const item of Array.isArray(node.value)?node.value:[node.value]){
          if(item===null)continue;
          if(typeof item!=='string'||!Number.isFinite(Date.parse(item))||(left.type==='datetime'&&!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(item))||(left.type==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(item)||new Date(item).toISOString().slice(0,10)!==item)))issue(path,'Date comparisons require a valid canonical date; datetime comparisons require an explicit UTC offset.','incompatible_field_type');
        }
      } else {
        if (['in', 'not_in'].includes(node.op)) issue(path, 'Membership requires the field/value-list predicate form.');
        const right = expression(node.right, `${path}.right`, depth + 1);
        if (left.type !== 'unknown' && right.type !== 'unknown' && left.type !== right.type && !(['text', 'select', 'url', 'textarea'].includes(left.type) && ['text', 'select', 'url', 'textarea'].includes(right.type))) issue(path, 'Comparison operands have incompatible types.', 'incompatible_field_type');
      }
    }
  };
  const expression = (node: unknown, path: string, depth: number): { type: string; unit?: string | null } => {
    if (!enter(node, path, depth)) return { type: 'unknown' };
    if ('field' in node) { keys(node, ['field', 'basis'], path); return field(node, path); }
    if ('literal' in node) {
      keys(node, ['literal'], path);
      if (!scalar(node.literal)) issue(path, 'Literal must be a finite scalar.');
      return { type: typeof node.literal === 'number' || record(node.literal) ? 'number' : typeof node.literal === 'boolean' ? 'checkbox' : node.literal === null ? 'unknown' : 'text' };
    }
    if ('if' in node) {
      keys(node, ['if', 'then', 'else'], path);
      predicate(node.if, `${path}.if`, depth + 1);
      const then = expression(node.then, `${path}.then`, depth + 1); const otherwise = expression(node.else, `${path}.else`, depth + 1);
      if (then.type !== 'unknown' && otherwise.type !== 'unknown' && (then.type !== otherwise.type || (then.unit && otherwise.unit && then.unit !== otherwise.unit))) issue(path, 'Conditional branches must have compatible types/units.', 'incompatible_field_type');
      return then;
    }
    if ('event_count' in node || 'event_exists' in node) {
      const key = 'event_count' in node ? 'event_count' : 'event_exists'; predicate(node[key], `${path}.${key}`, depth + 1);
      keys(node, [key], path);
      return { type: key === 'event_count' ? 'number' : 'checkbox' };
    }
    if ('duration' in node) {
      keys(node, ['duration'], path);
      const duration = node.duration;
      if (!record(duration)) { issue(path, 'Duration requires explicit boundaries.'); return { type: 'number', unit: 'milliseconds' }; }
      keys(duration, ['start', 'end', 'pairing', 'open', 'pause_start', 'pause_end'], `${path}.duration`);
      predicate(duration.start, `${path}.duration.start`, depth + 1); predicate(duration.end, `${path}.duration.end`, depth + 1);
      if (!['first', 'last', 'each'].includes(duration.pairing)) issue(path, 'Duration pairing must be first, last, or each.');
      if (!['exclude', 'as_of'].includes(duration.open)) issue(path, 'Duration open policy must be exclude or as_of.');
      if (duration.pause_start) predicate(duration.pause_start, `${path}.duration.pause_start`, depth + 1);
      if (duration.pause_end) predicate(duration.pause_end, `${path}.duration.pause_end`, depth + 1);
      if (Boolean(duration.pause_start) !== Boolean(duration.pause_end)) issue(path, 'Both pause boundaries are required.');
      return { type: 'number', unit: 'milliseconds' };
    }
    if (!['add', 'subtract', 'multiply', 'divide'].includes(node.op)) { issue(path, 'Unknown value operator.', 'unsupported_operation'); return { type: 'unknown' }; }
    keys(node, ['op', 'args'], path);
    if (!Array.isArray(node.args) || node.args.length < 2 || node.args.length > 10 || (['subtract', 'divide'].includes(node.op) && node.args.length !== 2)) { issue(path, 'Arithmetic requires 2–10 operands (exactly two for subtract/divide).'); return { type: 'number' }; }
    const types = node.args.map((child: unknown, i: number) => expression(child, `${path}.args[${i}]`, depth + 1));
    if (types.some((type: { type: string }) => type.type !== 'number' && type.type !== 'unknown')) issue(path, 'Arithmetic requires numeric fields.', 'incompatible_field_type');
    const units = new Set(types.map((type: { unit?: string | null }) => type.unit).filter(Boolean));
    if (['add', 'subtract'].includes(node.op) && units.size > 1) issue(path, 'Cannot add incompatible units or currencies.', 'incompatible_field_type');
    return { type: 'number', unit: ['add', 'subtract'].includes(node.op) ? types[0].unit : undefined };
  };
  const aggregate = (node: unknown, path: string): void => {
    if (!record(node) || node.kind !== 'aggregate' || !aggregates.includes(node.aggregate)) { issue(path, 'Unknown aggregation.', 'unsupported_operation'); return; }
    keys(node, ['kind', 'aggregate', 'value', 'where', 'percentile', 'buckets'], path);
    if (node.where) predicate(node.where, `${path}.where`, 1);
    if (node.aggregate === 'count_if' && !node.where) issue(path, 'count_if requires a condition.');
    if (!['count', 'count_if'].includes(node.aggregate) && !node.value) issue(path, 'This aggregation requires a value expression.');
    if (node.value) {
      const type = expression(node.value, `${path}.value`, 1);
      if (!['count', 'count_if', 'distinct_count'].includes(node.aggregate) && !['number', 'unknown'].includes(type.type)) issue(path, 'This aggregation requires numeric values.', 'incompatible_field_type');
    }
    if (node.aggregate === 'percentile' && (typeof node.percentile !== 'number' || node.percentile < 0 || node.percentile > 1)) issue(path, 'Percentile must be a fraction from zero through one.');
    if (node.aggregate === 'distribution' && (!Array.isArray(node.buckets) || node.buckets.length > 50 || node.buckets.some((bound: unknown, i: number) => typeof bound !== 'number' || !Number.isFinite(bound) || (i > 0 && bound <= node.buckets[i - 1])))) issue(path, 'Distribution requires up to 50 increasing finite bucket boundaries.');
  };
  if (!record(value)) return { valid: false, errors: [{ code: 'invalid_definition', path: '', message: 'Definition must be an object.' }], references: [] };
  if (value.version !== 1) issue('version', 'Unsupported definition version.');
  for (const key of ['key', 'name']) if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 200) issue(key, `${key} must contain 1–200 characters.`);
  if (!['task', 'run', 'runtime_execution', 'event', 'journey', 'workflow', 'project', 'agent'].includes(value.grain)) issue('grain', 'Unsupported population grain.');
  if (!['current', 'event_occurred_at', 'journey_started_at', 'journey_resolved_at'].includes(value.time_basis)) issue('time_basis', 'Select a supported time basis.');
  if (!['exclude_and_report', 'zero'].includes(value.missing_policy)) issue('missing_policy', 'Select an explicit missing-data policy.');
  if (value.attribution && !['assigned_agent_current', 'assigned_agent_at_entry', 'executing_agent', 'event_actor', 'outcome_agent'].includes(value.attribution)) issue('attribution', 'Unsupported attribution.');
  for (const requirement of metricAttributionIssues(value as MetricDefinition)) issue(requirement.path, requirement.message, requirement.code);
  if (value.bucket && !['hour', 'day', 'week', 'month'].includes(value.bucket)) issue('bucket', 'Unsupported calendar bucket.');
  if (value.bucket && value.time_basis === 'current') issue('bucket', 'Current snapshots cannot be presented as a historical time series.');
  if (value.population) predicate(value.population, 'population', 1);
  if (value.group_by) {
    if (!Array.isArray(value.group_by) || value.group_by.length > 3) issue('group_by', 'At most three group dimensions are supported.');
    else value.group_by.forEach((expr: unknown, i: number) => expression(expr, `group_by[${i}]`, 1));
  }
  if (value.measure?.kind === 'aggregate') aggregate(value.measure, 'measure');
  else if (value.measure?.kind === 'ratio') {
    aggregate(value.measure.numerator, 'measure.numerator'); aggregate(value.measure.denominator, 'measure.denominator');
    if (['distribution', 'distinct_count'].includes(value.measure.numerator?.aggregate) || ['distribution', 'distinct_count'].includes(value.measure.denominator?.aggregate)) issue('measure', 'Ratio components must be additive numeric aggregations.');
  } else if (value.measure?.kind === 'funnel') {
    if (!Array.isArray(value.measure.steps) || value.measure.steps.length < 2 || value.measure.steps.length > 10) issue('measure.steps', 'Funnels require 2–10 ordered steps.');
    else {
      const keys = new Set<string>();
      value.measure.steps.forEach((step: any, i: number) => {
        if (!record(step) || typeof step.key !== 'string' || !step.key || keys.has(step.key)) issue(`measure.steps[${i}]`, 'Funnel steps require unique keys.');
        else { keys.add(step.key); predicate(step.where, `measure.steps[${i}].where`, 1); }
      });
    }
  } else issue('measure', 'Select an aggregate, ratio, or funnel measure.');
  if (value.grain === 'journey') {
    const journey = value.journey;
    if (!record(journey)) issue('journey', 'Journey metrics require explicit boundaries.');
    else {
      predicate(journey.start, 'journey.start', 1); predicate(journey.success, 'journey.success', 1);
      for (const key of ['rework', 'unsuccessful', 'cancelled', 'reset', 'attempt', 'pause_start', 'pause_end']) if (journey[key]) predicate(journey[key], `journey.${key}`, 1);
      if (!['first_per_entity', 'per_reset', 'per_stage_visit'].includes(journey.counting)) issue('journey.counting', 'Unsupported journey counting policy.');
      if (journey.counting === 'per_reset' && !journey.reset) issue('journey.reset', 'Reset counting requires an explicit reset signal.');
      if (!['evaluated', 'successful', 'all_started'].includes(journey.denominator)) issue('journey.denominator', 'Unsupported journey denominator.');
      if (journey.additional_starts && !['ignore', 'attempt'].includes(journey.additional_starts)) issue('journey.additional_starts', 'Unsupported additional-start policy.');
      if (journey.cancellation && !['exclude', 'unsuccessful'].includes(journey.cancellation)) issue('journey.cancellation', 'Unsupported cancellation policy.');
      if (journey.max_attempts !== undefined && (!Number.isSafeInteger(journey.max_attempts) || journey.max_attempts < 1)) issue('journey.max_attempts', 'Attempt limit must be a positive integer.');
      if (journey.timeout && (!Number.isSafeInteger(journey.timeout.milliseconds) || journey.timeout.milliseconds <= 0 || !['unsuccessful', 'excluded'].includes(journey.timeout.resolution))) issue('journey.timeout', 'Timeout requires positive milliseconds and an explicit resolution.');
      if (Boolean(journey.pause_start) !== Boolean(journey.pause_end)) issue('journey', 'Both pause boundaries are required.');
    }
    if (!['journey_started_at', 'journey_resolved_at'].includes(value.time_basis)) issue('time_basis', 'Journey metrics require an entry or resolution time basis.');
  } else if (value.journey) issue('journey', 'Journey boundaries require journey grain.');
  if (value.grain === 'event' && value.time_basis !== 'event_occurred_at') issue('time_basis', 'Event grain uses event occurrence time.');
  if (!['event', 'journey'].includes(value.grain) && value.time_basis !== 'current') issue('time_basis', 'This grain uses current inventory; historical cohorts require event or journey grain.');
  if (value.measure?.kind === 'funnel' && value.grain !== 'journey') issue('grain', 'Ordered funnels require bounded journey grain.');
  return { valid: errors.length === 0, errors, references: [...references].sort() };
}

export function parseMetricDefinition(value: unknown, catalog?: CatalogDescriptor[]): MetricDefinition {
  const result = validateMetricDefinition(value, catalog);
  if (!result.valid) throw new TelemetryDefinitionError(result.errors.map(error => `${error.path}: ${error.message}`).join(' '), result.errors);
  return value as MetricDefinition;
}

type Truth = true | false | null;
const MISSING = Symbol('missing');
const INVALID = Symbol('invalid');
type Computed = Scalar | Decimal | typeof MISSING | typeof INVALID;
interface Sample {
  id: string; entity: TelemetryEntity; observations: TelemetryObservation[]; event?: TelemetryObservation;
  entry?: TelemetryObservation; resolutionEvent?: TelemetryObservation; started?: number; resolved?: number;
  resolution?: 'success' | 'unsuccessful' | 'pending' | 'cancelled' | 'timed_out' | 'unknown';
  disqualified?: boolean | null; attempts?: number; blocked?: number | null; everBlocked?: boolean | null;
  unknown?: boolean; reason?: string; asOf: number; catalog: Map<string, CatalogDescriptor>; attribution?: MetricDefinition['attribution'];
}

function has(object: Record<string, unknown> | undefined, key: string): boolean { return !!object && Object.prototype.hasOwnProperty.call(object, key); }
function own(object: Record<string, unknown> | undefined, key: string): unknown { return has(object, key) ? object![key] : undefined; }
function readSnapshot(snapshot: Record<string, unknown> | undefined, key: string): unknown {
  // The adapter pins custom values under catalog IDs. Falling back to a display
  // key could reinterpret a retired field, another schema, or a built-in value.
  return own(snapshot,key);
}
function readField(field: string, basis: string | undefined, sample: Sample): Computed {
  const event = sample.event;
  let value: unknown;
  if (field.startsWith('journey.')) {
    value = ({ resolution: sample.resolution, disqualified: sample.disqualified, attempts: sample.attempts,
      duration_ms: sample.started === undefined ? undefined : (sample.resolved ?? sample.asOf) - sample.started,
      blocked_ms: sample.blocked, ever_blocked: sample.everBlocked,
      started_at: sample.started === undefined ? undefined : new Date(sample.started).toISOString(),
      resolved_at: sample.resolved === undefined ? undefined : new Date(sample.resolved).toISOString(),
    } as Record<string, unknown>)[field.slice(8)];
  } else if (field.startsWith('event.')) {
    if (!event) return MISSING;
    const key = field.slice(6);
    if (key === 'type') value = event.type;
    else if (key === 'occurred_at') value = event.occurred_at;
    else if (key.startsWith('before.')) value = readSnapshot(event.before, key.slice(7));
    else if (key.startsWith('after.')) value = readSnapshot(event.after, key.slice(6));
    else if (key === 'from_status') value = own(event.fields, key) ?? own(event.before, 'status');
    else if (key === 'to_status') value = own(event.fields, key) ?? ((event.type === 'task.created' || (has(event.before, 'status') && event.before?.status !== event.after?.status)) ? own(event.after, 'status') : undefined);
    else value = own(event.fields, key) ?? own(event.context, key);
  } else if (field === 'agent_id') {
    const source = sample.attribution === 'assigned_agent_at_entry' ? sample.entry?.after : sample.entity.fields;
    const selectedEvent=event??sample.resolutionEvent;
    if (sample.attribution === 'event_actor') value = own(selectedEvent?.fields, 'actor_agent_id') ?? own(selectedEvent?.context, 'actor_agent_id');
    else if (sample.attribution === 'outcome_agent') value = own(selectedEvent?.fields, 'outcome_agent_id');
    else if (sample.attribution === 'executing_agent') {
      if (event) value=own(event.fields,'executing_agent_id');
      else if(sample.started!==undefined){
        const agents=new Set(sample.observations.map(observation=>own(observation.fields,'executing_agent_id')).filter(agent=>agent!==null&&agent!==undefined));
        value=agents.size===1?[...agents][0]:undefined;
      } else value=own(sample.entity.fields,'executing_agent_id')??(['run','runtime_execution'].includes(sample.entity.kind)?own(sample.entity.fields,'agent_id'):undefined);
    }
    else value = own(source, 'assigned_agent_id') ?? (sample.entity.kind !== 'task' ? own(source, 'agent_id') : undefined);
  } else if (field === 'id') value = sample.entity.id;
  else {
    const effectiveBasis = basis ?? (event ? 'at_event' : sample.started !== undefined ? 'at_entry' : 'current');
    const snapshot = effectiveBasis === 'at_entry' ? sample.entry?.after : effectiveBasis === 'at_resolution' ? sample.resolutionEvent?.after : effectiveBasis === 'at_event' ? event?.after : sample.entity.fields;
    value = readSnapshot(snapshot, field);
  }
  if (value === undefined || value === null) return MISSING;
  if (!scalar(value)) return INVALID;
  const descriptor = sample.catalog.get(field);
  const type = descriptor?.type ?? builtins[field];
  if (type === 'number') return Decimal.parse(value) ?? INVALID;
  if (type === 'checkbox' && typeof value !== 'boolean') return INVALID;
  if (['date', 'datetime'].includes(type ?? '') && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) return INVALID;
  if (['date','datetime'].includes(type??''))return new Date(value as string).toISOString();
  return value;
}
function scalarResult(value: Computed): Scalar { return value === MISSING || value === INVALID ? null : value instanceof Decimal ? value.toJSON() : value; }
function numeric(value: Computed): Decimal | null { return value instanceof Decimal ? value : value === MISSING || value === INVALID ? null : Decimal.parse(value); }
function compare(left: Computed, right: Computed, op: string): Truth {
  if (op === 'is_missing') return left === MISSING;
  if (op === 'is_present') return left === INVALID ? null : left !== MISSING;
  if (left === MISSING || right === MISSING || left === INVALID || right === INVALID) return null;
  if (right === null || left === null) return null;
  const numericMode = left instanceof Decimal || right instanceof Decimal || typeof left === 'number' || typeof right === 'number' || record(left) || record(right);
  const lNumeric = numericMode ? numeric(left) : null; const rNumeric = numericMode ? numeric(right) : null;
  const cmp = numericMode ? (lNumeric && rNumeric ? lNumeric.compare(rNumeric) : null) : (typeof left === 'string' && typeof right === 'string' ? (left < right ? -1 : left > right ? 1 : 0) : left === right ? 0 : null);
  if (op === 'eq') return cmp === 0;
  if (op === 'ne') return cmp !== 0;
  if (op === 'contains') return typeof left === 'string' && typeof right === 'string' ? left.includes(right) : null;
  if (cmp === null) return null;
  return op === 'gt' ? cmp > 0 : op === 'gte' ? cmp >= 0 : op === 'lt' ? cmp < 0 : op === 'lte' ? cmp <= 0 : null;
}
export function evaluatePredicate(predicate: Predicate, context: { entity: TelemetryEntity; event?: TelemetryObservation; catalog?: CatalogDescriptor[]; as_of: string }): Truth {
  return test(predicate, { id: String(context.entity.id), entity: context.entity, event: context.event, observations: context.event ? [context.event] : [], asOf: Date.parse(context.as_of), catalog: new Map(context.catalog?.map(field => [field.id, field])) });
}
function test(predicate: Predicate, sample: Sample): Truth {
  if ('all' in predicate) { const values = predicate.all.map(child => test(child, sample)); return values.includes(false) ? false : values.includes(null) ? null : true; }
  if ('any' in predicate) { const values = predicate.any.map(child => test(child, sample)); return values.includes(true) ? true : values.includes(null) ? null : false; }
  if ('not' in predicate) { const value = test(predicate.not, sample); return value === null ? null : !value; }
  const left = 'field' in predicate ? readField(predicate.field, predicate.basis, sample) : expressionValue(predicate.left, sample);
  if (predicate.op === 'matches_regex') {
    return typeof left === 'string' ? compileTelemetryRegex(predicate.value, predicate.flags).matcher(left).find() : null;
  }
  const comparisonType='field'in predicate?(sample.catalog.get(predicate.field)?.type??builtins[predicate.field]):undefined;
  const normalizeLiteral=(value:Scalar):Scalar=>['date','datetime'].includes(comparisonType??'')&&typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():value;
  // Event envelopes are sparse: a runtime event does not have a destination task status.
  // Missing snapshot field evidence remains unknown; coverage separately qualifies absence claims.
  if ('field' in predicate && predicate.field.startsWith('event.') && !predicate.field.startsWith('event.before.') && !predicate.field.startsWith('event.after.') &&
      left === MISSING && sample.event && !['is_missing', 'is_present'].includes(predicate.op)) return false;
  if ('field' in predicate && ['in', 'not_in'].includes(predicate.op)) {
    const values = (predicate.value as Scalar[]).map(value => compare(left, normalizeLiteral(value), 'eq'));
    const result: Truth = values.includes(true) ? true : values.includes(null) ? null : false;
    return predicate.op === 'not_in' && result !== null ? !result : result;
  }
  const right = 'field' in predicate ? normalizeLiteral(predicate.value as Scalar) : predicate.right ? expressionValue(predicate.right, sample) : MISSING;
  return compare(left, right, predicate.op);
}
function covered(sample: Sample, from = sample.started, to = sample.resolved ?? sample.asOf): boolean {
  const coverage = sample.entity.coverage;
  return !!coverage?.complete && from !== undefined && Date.parse(coverage.from) <= from && (!coverage.to || Date.parse(coverage.to) >= to);
}
function eventSample(sample: Sample, event: TelemetryObservation): Sample { return { ...sample, event }; }
function causalKey(event: TelemetryObservation): string { return event.causation_id ? `cause:${event.causation_id}` : `event:${event.id}`; }
function expressionValue(expression: ValueExpression, sample: Sample): Computed {
  if ('field' in expression) return readField(expression.field, expression.basis, sample);
  if ('literal' in expression) return expression.literal === null ? MISSING : expression.literal;
  if ('if' in expression) { const condition = test(expression.if, sample); return condition === null ? MISSING : expressionValue(condition ? expression.then : expression.else, sample); }
  if ('event_count' in expression || 'event_exists' in expression) {
    const predicate = 'event_count' in expression ? expression.event_count : expression.event_exists;
    const matched = new Set<string>(); let unknown = false;
    for (const event of sample.observations) {
      const value = test(predicate, eventSample(sample, event));
      if (value) matched.add(causalKey(event)); else if (value === null) unknown = true;
    }
    if ('event_exists' in expression && matched.size) return true;
    if (unknown || !covered(sample, sample.started ?? Date.parse(sample.entity.coverage?.from ?? 'invalid'))) return MISSING;
    return 'event_count' in expression ? Decimal.parse(matched.size)! : false;
  }
  if ('duration' in expression) {
    const duration = expression.duration;
    const intervals: { start: number; end: number; paused: number }[] = [];
    let start: number | undefined; let pausedAt: number | undefined; let paused = 0; let invalid = false;
    for (const event of sample.observations) {
      const at = Date.parse(event.occurred_at); const context = eventSample(sample, event);
      const starts = test(duration.start, context); const ends = test(duration.end, context);
      if (starts === null || ends === null) invalid = true;
      if (starts && (start === undefined || duration.pairing === 'last')) { start = at; paused = 0; pausedAt = undefined; }
      if (start === undefined) continue;
      if (duration.pause_start && test(duration.pause_start, context)) pausedAt ??= at;
      if (duration.pause_end && test(duration.pause_end, context) && pausedAt !== undefined) { paused += at - pausedAt; pausedAt = undefined; }
      if (ends) {
        intervals.push({ start, end: at, paused: paused + (pausedAt === undefined ? 0 : at - pausedAt) });
        start = undefined; paused = 0; pausedAt = undefined;
        if (duration.pairing === 'first') break;
      }
    }
    if (start !== undefined && duration.open === 'as_of') intervals.push({ start, end: sample.asOf, paused: paused + (pausedAt === undefined ? 0 : sample.asOf - pausedAt) });
    if (!intervals.length || invalid || intervals.some(interval => !covered(sample, interval.start, interval.end))) return MISSING;
    const selected = duration.pairing === 'last' ? intervals.slice(-1) : intervals;
    return Decimal.parse(selected.reduce((total, interval) => total + interval.end - interval.start - interval.paused, 0))!;
  }
  const operands = expression.args.map(arg => expressionValue(arg, sample));
  if (operands.some(value => value === INVALID)) return INVALID;
  if (operands.some(value => value === MISSING)) return MISSING;
  const decimals = operands.map(numeric);
  if (decimals.some(value => !value)) return INVALID;
  const values = decimals as Decimal[];
  if (expression.op === 'add') return sumDecimals(values);
  if (expression.op === 'subtract') return values[0].subtract(values[1]);
  if (expression.op === 'multiply') return values.reduce((total, value) => total.multiply(value), Decimal.one());
  return values[0].divide(values[1]) ?? INVALID;
}

function timestamp(value: string, name: string): number {
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new TelemetryDefinitionError(`${name} requires an ISO timestamp with an explicit UTC offset.`);
  return Date.parse(value);
}
function normalizeObservations(input: TelemetryObservation[], asOf: number): { events: Map<string, TelemetryObservation[]>; conflicts: Set<string> } {
  const unique = new Map<string, TelemetryObservation>(); const conflicts = new Set<string>(); const superseded = new Set<string>(); const children = new Map<string, TelemetryObservation>();
  for (const event of input) {
    timestamp(event.occurred_at, 'observation.occurred_at');
    const key = String(event.id); const previous = unique.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) conflicts.add(`${event.entity_kind ?? 'task'}:${event.entity_id}`);
    else unique.set(key, event);
    if (event.supersedes !== undefined && event.supersedes !== null) {
      const parent = String(event.supersedes); const child = children.get(parent);
      if (child && child.id !== event.id) conflicts.add(`${event.entity_kind ?? 'task'}:${event.entity_id}`);
      children.set(parent, event); superseded.add(parent);
    }
  }
  const events = new Map<string, TelemetryObservation[]>();
  for (const event of unique.values()) {
    // A correction can move the logical event outside this effective-time
    // window. It still retracts the old fact from a live historical query.
    if (superseded.has(String(event.id)) || Date.parse(event.occurred_at) > asOf) continue;
    const key = `${event.entity_kind ?? 'task'}:${event.entity_id}`;
    if (!events.has(key)) events.set(key, []);
    events.get(key)!.push(event);
  }
  for (const group of events.values()) group.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) ||
    (a.sequence !== undefined && b.sequence !== undefined ? a.sequence - b.sequence : 0) || String(a.id).localeCompare(String(b.id)));
  return { events, conflicts };
}
function ordered(a: TelemetryObservation, b: TelemetryObservation): boolean {
  return Date.parse(a.occurred_at) !== Date.parse(b.occurred_at) ||
    (a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence) ||
    (!!a.causation_id && a.causation_id === b.causation_id);
}
function journeys(base: Sample, definition: JourneyDefinition): Sample[] {
  const completed: Sample[] = [];
  const ambiguousTimes=new Set<number>();const sequences=new Map<number,Set<number>>();
  for(const event of base.observations){const time=Date.parse(event.occurred_at);const existing=sequences.get(time)??new Set<number>();if(event.sequence===undefined||existing.has(event.sequence))ambiguousTimes.add(time);else existing.add(event.sequence);sequences.set(time,existing);}
  let active: Sample | undefined; let seenStart = false; let resetArmed = false; let pausedAt: number | undefined;
  let blocked = 0; let pauseUnknown = false; let reworkUnknown = false; let attemptUnknown = false;
  let attempted = new Set<string>();
  const finish = (at?: number): void => {
    if (!active) return;
    if (at !== undefined) active.resolved = at;
    const end = active.resolved ?? base.asOf;
    active.blocked = pauseUnknown || (definition.pause_start && !covered(active, active.started, end)) ? null : blocked + (pausedAt === undefined ? 0 : end - pausedAt);
    active.everBlocked = active.blocked === null ? null : active.blocked > 0;
    if ((definition.rework || definition.attempt || definition.max_attempts) && !covered(active, active.started, end)) reworkUnknown = true;
    if (reworkUnknown || attemptUnknown) { active.disqualified = null; active.unknown = true; active.reason = 'Incomplete evidence for disqualifiers or attempts.'; }
    if (active.unknown && active.resolution !== 'cancelled' && active.resolution !== 'timed_out' && active.resolution !== 'pending') active.resolution = 'unknown';
    // Observations are accumulated while the interval is open. Re-filtering all
    // history for every stage visit would turn one long task into quadratic work.
    active.observations = [...new Map(active.observations.map(event=>[String(event.id),event])).values()];
    completed.push(active); active = undefined; pausedAt = undefined; blocked = 0; pauseUnknown = false; reworkUnknown = false; attemptUnknown = false; attempted = new Set();
  };
  const start = (event: TelemetryObservation): void => {
    active = { ...base, id: `${base.entity.kind}:${base.entity.id}:journey:${event.id}`, observations: [], entry: event, started: Date.parse(event.occurred_at),
      resolution: 'pending', disqualified: false, attempts: 1, unknown: base.unknown };
    seenStart = true; resetArmed = false; attempted.add(causalKey(event));
  };
  for (let index = 0; index < base.observations.length; index++) {
    const event = base.observations[index]; const at = Date.parse(event.occurred_at);
    if (active && definition.timeout && at > active.started! + definition.timeout.milliseconds) {
      active.resolution = definition.timeout.resolution === 'unsuccessful' ? 'unsuccessful' : 'timed_out';
      active.reason = 'Configured elapsed-time limit reached.'; finish(active.started! + definition.timeout.milliseconds);
    }
    const context = eventSample(active ?? base, event);
    const isReset = definition.reset ? test(definition.reset, context) : false;
    const isStart = test(definition.start, context);
    if (isReset && definition.counting === 'per_reset') {
      if (active) { active.observations.push(event); active.resolutionEvent=event;active.resolution = 'cancelled'; active.reason = 'Journey ended by an explicit reset.'; finish(at); }
      resetArmed = true;
    }
    if (!active) {
      const mayStart = !seenStart || definition.counting === 'per_stage_visit' || (definition.counting === 'per_reset' && resetArmed);
      if (mayStart && (isStart || (isReset && definition.counting === 'per_reset'))) start(event);
      else continue;
    } else if (isStart && definition.additional_starts === 'attempt' && !attempted.has(causalKey(event))) {
      active.attempts!++; attempted.add(causalKey(event));
    }
    active!.observations.push(event);
    const sample = eventSample(active!, event);
    if (definition.attempt) {
      const attempt = test(definition.attempt, sample);
      if (attempt && !attempted.has(causalKey(event))) { active!.attempts!++; attempted.add(causalKey(event)); }
      if (attempt === null) attemptUnknown = true;
    }
    if (definition.rework) {
      const rework = test(definition.rework, sample);
      if (rework) active!.disqualified = true;
      if (rework === null) reworkUnknown = true;
    }
    if (definition.pause_start && definition.pause_end) {
      const pauses = test(definition.pause_start, sample); const resumes = test(definition.pause_end, sample);
      if (pauses === null || resumes === null) pauseUnknown = true;
      if (pauses) pausedAt ??= at;
      if (resumes && pausedAt !== undefined) { blocked += at - pausedAt; pausedAt = undefined; }
    }
    const success = test(definition.success, sample);
    const failure = definition.unsuccessful ? test(definition.unsuccessful, sample) : false;
    const cancelled = definition.cancelled ? test(definition.cancelled, sample) : false;
    if (success === null || failure === null || cancelled === null) active!.unknown = true;
    if (success || failure || cancelled) {
      let ambiguous = Number(success === true) + Number(failure === true) + Number(cancelled === true) > 1;
      // Contradictory independent signals at the same instant have no fabricated ID ordering.
      for (let next = index + 1; ambiguousTimes.has(at)&&next < base.observations.length && Date.parse(base.observations[next].occurred_at) === at; next++) {
        const other = base.observations[next]; if (ordered(event, other)) continue;
        const nextSample = eventSample(active!, other);
        const nextSuccess = test(definition.success, nextSample);
        const nextFailure = definition.unsuccessful ? test(definition.unsuccessful, nextSample) : false;
        const nextCancelled = definition.cancelled ? test(definition.cancelled, nextSample) : false;
        if ((success && (nextFailure || nextCancelled)) || (failure && (nextSuccess || nextCancelled)) || (cancelled && (nextSuccess || nextFailure))) {ambiguous = true;active!.observations.push(other);}
      }
      active!.resolution = ambiguous ? 'unknown' : cancelled ? (definition.cancellation === 'unsuccessful' ? 'unsuccessful' : 'cancelled') : success ? 'success' : 'unsuccessful';
      active!.resolutionEvent = event; active!.unknown ||= ambiguous;
      if (ambiguous) active!.reason = 'Conflicting resolution signals have no recorded causal order.';
      // A same-time rework signal counts before/at resolution regardless of lexical event ID.
      for (let next = index + 1; ambiguousTimes.has(at)&&next < base.observations.length && Date.parse(base.observations[next].occurred_at) === at; next++) {
        const other = base.observations[next];
        if (event.sequence !== undefined && other.sequence !== undefined && other.sequence > event.sequence) continue;
        if (definition.rework && test(definition.rework, eventSample(active!, other))) {active!.disqualified = true;active!.observations.push(other);}
      }
      finish(at);
    }
  }
  if (active) {
    if (definition.timeout && base.asOf >= active.started! + definition.timeout.milliseconds) {
      active.resolution = definition.timeout.resolution === 'unsuccessful' ? 'unsuccessful' : 'timed_out';
      active.reason = 'Configured elapsed-time limit reached.'; finish(active.started! + definition.timeout.milliseconds);
    } else finish();
  }
  if(!completed.length){
    const created=Date.parse(String(base.entity.fields.created_at??''));
    const creationObserved=base.observations.some(event=>event.type==='task.created');
    if(!base.entity.coverage?.complete||(!creationObserved&&(!Number.isFinite(created)||Date.parse(base.entity.coverage.from)>created))){
      completed.push({...base,id:`${base.entity.kind}:${base.entity.id}:unknown-start`,resolution:'unknown',unknown:true,reason:'Incomplete earlier history cannot establish whether a qualifying journey started.'});
    }
  }
  return completed;
}

interface ComponentValue { numeric: Decimal | null; raw: Computed; selected: boolean; issue?: 'missing' | 'invalid' | 'unknown' }
function componentValue(measure: AggregateMeasure, sample: Sample, missing: MetricDefinition['missing_policy']): ComponentValue {
  const condition = measure.where ? test(measure.where, sample) : true;
  if (condition === null) return { numeric: null, raw: MISSING, selected: false, issue: 'unknown' };
  if (!condition) return { numeric: Decimal.zero(), raw: null, selected: false };
  if (measure.aggregate === 'count' || measure.aggregate === 'count_if') return { numeric: Decimal.one(), raw: 1, selected: true };
  let value = expressionValue(measure.value!, sample);
  if (value === MISSING && missing === 'zero' && measure.aggregate !== 'distinct_count') value = Decimal.zero();
  if (value === MISSING) return { numeric: null, raw: value, selected: false, issue: 'missing' };
  if (value === INVALID) return { numeric: null, raw: value, selected: false, issue: 'invalid' };
  if (measure.aggregate === 'distinct_count') return { numeric: Decimal.one(), raw: value, selected: true };
  const number = numeric(value);
  if (!number) return { numeric: null, raw: value, selected: false, issue: 'invalid' };
  return { numeric: number, raw: value, selected: true };
}
function aggregateValues(measure: AggregateMeasure, values: ComponentValue[]): { value: NumericResult; distribution?: GroupResult['distribution'] } {
  const selected = values.filter(value => value.selected && !value.issue);
  if (measure.aggregate === 'distinct_count') return { value: new Set(selected.map(value => JSON.stringify(scalarResult(value.raw)))).size };
  if (['count', 'count_if'].includes(measure.aggregate)) return { value: sumDecimals(selected.map(value => value.numeric!)).toJSON() };
  if (!selected.length) return { value: null, ...(measure.aggregate === 'distribution' ? { distribution: [] } : {}) };
  const numbers = selected.map(value => value.numeric!); const sorted = [...numbers].sort((a, b) => a.compare(b));
  if (measure.aggregate === 'sum') return { value: sumDecimals(numbers).toJSON() };
  if (measure.aggregate === 'mean') return { value: sumDecimals(numbers).divide(Decimal.parse(numbers.length)!)!.toJSON() };
  if (measure.aggregate === 'min') return { value: sorted[0].toJSON() };
  if (measure.aggregate === 'max') return { value: sorted[sorted.length - 1].toJSON() };
  if (measure.aggregate === 'percentile') {
    const index = Decimal.parse(measure.percentile!)!.multiply(Decimal.parse(sorted.length - 1)!);
    const lower = Math.floor(index.toNumber()); const upper = Math.ceil(index.toNumber());
    return { value: sorted[lower].add(sorted[upper].subtract(sorted[lower]).multiply(index.subtract(Decimal.parse(lower)!))).toJSON() };
  }
  const boundaries = measure.buckets!;
  const distribution = [...boundaries, null].map((to, index) => ({ from: index ? boundaries[index - 1] : null, to, count: 0 }));
  for (const number of numbers) distribution[boundaries.findIndex(boundary => number.compare(Decimal.parse(boundary)!) < 0) < 0 ? boundaries.length : boundaries.findIndex(boundary => number.compare(Decimal.parse(boundary)!) < 0)].count++;
  return { value: selected.length, distribution };
}
interface EvaluatedSample { sample: Sample; proof: Contribution; numerator?: ComponentValue; denominator?: ComponentValue; value?: ComponentValue; steps?: boolean[] }
function aggregateGroup(rows: EvaluatedSample[], definition: MetricDefinition, key: Scalar[]): GroupResult {
  const accepted = rows.filter(row => row.proof.included);
  const base = { key, sample_count: accepted.length };
  if (definition.measure.kind === 'aggregate') return { ...base, ...aggregateValues(definition.measure, accepted.map(row => row.value!)) };
  if (definition.measure.kind === 'ratio') {
    const numerator = aggregateValues(definition.measure.numerator, accepted.map(row => row.numerator!)).value;
    const denominator = aggregateValues(definition.measure.denominator, accepted.map(row => row.denominator!)).value;
    const numeratorDecimal = Decimal.parse(numerator); const denominatorDecimal = Decimal.parse(denominator);
    return { ...base, numerator, denominator, value: numeratorDecimal && denominatorDecimal ? numeratorDecimal.divide(denominatorDecimal)?.toJSON() ?? null : null };
  }
  let previous = accepted.length;
  const funnel: FunnelStepResult[] = definition.measure.steps.map((step, i) => {
    const count = accepted.filter(row => row.steps?.[i]).length;
    const result = { key: step.key, ...(step.label ? { label: step.label } : {}), count,
      from_entry: accepted.length ? Decimal.parse(count)!.divide(Decimal.parse(accepted.length)!)!.toJSON() : null,
      from_previous: previous ? Decimal.parse(count)!.divide(Decimal.parse(previous)!)!.toJSON() : null };
    previous = count; return result;
  });
  return { ...base, value: funnel[funnel.length - 1]?.count ?? 0, funnel };
}

/** Local-calendar labels include the UTC offset for hours so the repeated DST hour stays distinct. */
export function calendarBucket(value: string, bucket: NonNullable<MetricDefinition['bucket']>, timezone: string): string {
  const at = timestamp(value, 'bucket timestamp');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(new Date(at));
  const get = (key: string): string => parts.find(part => part.type === key)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  if (bucket === 'hour') return `${date}T${get('hour')}:00${get('timeZoneName').replace('GMT', '') || '+00:00'}`;
  if (bucket === 'day') return date;
  if (bucket === 'month') return date.slice(0, 7);
  const midnight = new Date(`${date}T00:00:00Z`); const weekday = midnight.getUTCDay();
  midnight.setUTCDate(midnight.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
  return midnight.toISOString().slice(0, 10);
}

function explain(definition: MetricDefinition): string {
  if (definition.description) return definition.description;
  if (definition.grain === 'journey') return `${definition.name}: ${definition.journey!.counting.replaceAll('_', ' ')}; ${definition.journey!.denominator.replaceAll('_', ' ')} denominator; ${definition.time_basis.replaceAll('_', ' ')}; ${definition.missing_policy.replaceAll('_', ' ')}.`;
  if (definition.measure.kind === 'ratio') return `${definition.name}: configured numerator divided by denominator over the same eligible ${definition.grain} population. Missing evidence is reported separately.`;
  if (definition.measure.kind === 'funnel') return `${definition.name}: distinct samples reaching ${definition.measure.steps.length} configured steps in order.`;
  return `${definition.name}: ${definition.measure.aggregate.replaceAll('_', ' ')} over eligible ${definition.grain} records using ${definition.time_basis.replaceAll('_', ' ')} values.`;
}

export function evaluateMetric(input: EvaluateMetricInput): MetricResult {
  const definition = parseMetricDefinition(input.definition, input.catalog);
  const asOf = timestamp(input.as_of, 'as_of'); const from = input.from ? timestamp(input.from, 'from') : -Infinity; const to = input.to ? timestamp(input.to, 'to') : Infinity;
  if (definition.time_basis === 'current' && (input.from || input.to)) throw new TelemetryDefinitionError('Current inventory does not have an occurrence-time window. Use an explicit created_at population predicate for a creation cohort.');
  if (from >= to) throw new TelemetryDefinitionError('The time window must have from < to.');
  const timezone = input.timezone ?? 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw new TelemetryDefinitionError('Unknown IANA timezone.'); }
  const groupBy = input.group_by ?? definition.group_by ?? [];
  if (groupBy.length > 3) throw new TelemetryDefinitionError('At most three group dimensions are supported.', [], 'query_limit_exceeded');
  if (input.group_by || input.filter) {
    const validation = validateMetricDefinition({ ...definition, group_by: groupBy, ...(input.filter ? { population: input.filter } : {}) }, input.catalog);
    if (!validation.valid) throw new TelemetryDefinitionError('Invalid query filter or grouping.', validation.errors);
  }
  if (input.entities.length > Math.min(input.max_samples ?? MAX_SAMPLES, MAX_SAMPLES) || (input.observations?.length ?? 0) > Math.min(input.max_observations ?? MAX_OBSERVATIONS, MAX_OBSERVATIONS)) throw new TelemetryDefinitionError('Evaluation exceeds the bounded record budget.', [], 'query_limit_exceeded');
  const catalog = new Map<string, CatalogDescriptor>();
  for (const field of input.catalog ?? []) catalog.set(field.id, field);
  const normalized = normalizeObservations(input.observations ?? [], asOf);
  const samples: Sample[] = []; const entityKeys = new Set<string>();
  for (const entity of input.entities) {
    const entityKey = `${entity.kind}:${entity.id}`;
    if (entityKeys.has(entityKey)) throw new TelemetryDefinitionError('Duplicate entities would multiply the population.', [], 'invalid_definition');
    entityKeys.add(entityKey);
    if (definition.grain !== 'event' && definition.grain !== 'journey' && entity.kind !== definition.grain) continue;
    if ((definition.grain === 'event' || definition.grain === 'journey') && entity.kind !== 'task') continue;
    const observations = normalized.events.get(entityKey) ?? [];
    const base: Sample = { id: entityKey, entity, observations, asOf, catalog, attribution: definition.attribution, unknown: normalized.conflicts.has(entityKey) };
    if (definition.grain === 'journey') samples.push(...journeys(base, definition.journey!));
    else if (definition.grain === 'event') samples.push(...observations.map(event => ({ ...base, id: `event:${event.id}`, event })));
    else samples.push(base);
  }
  if (samples.length > Math.min(input.max_samples ?? MAX_SAMPLES, MAX_SAMPLES)) throw new TelemetryDefinitionError('Journey/event expansion exceeds the sample budget.', [], 'query_limit_exceeded');
  const coverage: MetricResult['coverage'] = { total: samples.length, eligible: 0, included: 0, excluded: 0, missing: 0, invalid: 0, pending: 0, cancelled: 0, timed_out: 0, unknown: 0 };
  const evaluated: EvaluatedSample[] = []; const warnings = new Set<string>();
  const needsEventEvidence=(value:unknown):boolean=>Array.isArray(value)?value.some(needsEventEvidence):record(value)?('event_count'in value||'event_exists'in value||'duration'in value||Object.values(value).some(needsEventEvidence)):false;
  const retainsHistory=definition.time_basis!=='current'||needsEventEvidence(definition);
  for (const sample of samples) {
    const at = definition.time_basis === 'event_occurred_at' ? Date.parse(sample.event!.occurred_at) : definition.time_basis === 'journey_started_at' ? sample.started : definition.time_basis === 'journey_resolved_at' ? sample.resolved : asOf;
    const proof: Contribution = { sample_id: sample.id, entity_id: sample.entity.id, entity_kind: sample.entity.kind, included: false, reason: '', value: null, group: [], observation_ids: definition.grain==='event'&&sample.event?[sample.event.id]:retainsHistory?sample.observations.map(event => event.id):[],
      ...(sample.event ? { occurred_at: sample.event.occurred_at } : {}), ...(sample.started !== undefined ? { started_at: new Date(sample.started).toISOString() } : {}),
      ...(sample.resolved !== undefined ? { resolved_at: new Date(sample.resolved).toISOString() } : {}), ...(sample.resolution ? { resolution: sample.resolution } : {}),
      agent_id: scalarResult(readField('agent_id', undefined, sample)),
      ...(sample.started !== undefined ? { details: { attempts: sample.attempts, disqualified: sample.disqualified, duration_ms: (sample.resolved ?? asOf) - sample.started, blocked_ms: sample.blocked } } : {}) };
    const row: EvaluatedSample = { sample, proof }; evaluated.push(row);
    const exclude = (reason: string, category?: 'missing' | 'invalid' | 'unknown'): void => { proof.reason = reason; coverage.excluded++; if (category) coverage[category]++; };
    // Snapshot windows filter the snapshot instant; the engine never substitutes updated_at.
    if(at===undefined&&sample.unknown){exclude(sample.reason??'Historical cohort time is unknown.','unknown');continue;}
    if (at === undefined || at < from || at >= to) { exclude('Outside the selected time window.'); continue; }
    const population = definition.population ? test(definition.population, sample) : true;
    const filter = input.filter ? test(input.filter, sample) : true;
    if (!population || !filter) { exclude(population === null || filter === null ? 'Population predicate has missing evidence.' : 'Outside the configured population.', population === null || filter === null ? 'unknown' : undefined); continue; }
    coverage.eligible++;
    if (sample.resolution === 'pending') coverage.pending++;
    if (sample.resolution === 'cancelled') coverage.cancelled++;
    if (sample.resolution === 'timed_out' || sample.reason === 'Configured elapsed-time limit reached.') coverage.timed_out++;
    if (sample.unknown && definition.time_basis !== 'current') { exclude(sample.reason ?? 'Conflicting or incomplete historical evidence.', 'unknown'); continue; }
    if (definition.grain === 'journey') {
      if (['cancelled', 'timed_out'].includes(sample.resolution!)) { exclude(sample.reason ?? `Journey ${sample.resolution}.`); continue; }
      if (sample.resolution === 'pending' && definition.journey!.denominator !== 'all_started') { exclude('Journey is still open; this denominator excludes pending work.'); continue; }
      if (definition.journey!.denominator === 'successful' && sample.resolution !== 'success') { exclude('The configured denominator includes successful journeys only.'); continue; }
    }
    proof.group = groupBy.map(expression => scalarResult(expressionValue(expression, sample)));
    if (definition.bucket && at !== undefined) proof.group.unshift(calendarBucket(new Date(at).toISOString(), definition.bucket, timezone));
    if (definition.measure.kind === 'aggregate') {
      row.value = componentValue(definition.measure, sample, definition.missing_policy);
      if (row.value.issue) { exclude(`${row.value.issue} value or aggregation condition.`, row.value.issue); continue; }
      if (!row.value.selected) { exclude('Aggregation condition did not match.'); continue; }
      proof.value = scalarResult(row.value.raw); proof.included = true; proof.reason = 'Included by the configured population and measure.';
    } else if (definition.measure.kind === 'ratio') {
      row.numerator = componentValue(definition.measure.numerator, sample, definition.missing_policy);
      row.denominator = componentValue(definition.measure.denominator, sample, definition.missing_policy);
      const issue = row.numerator.issue ?? row.denominator.issue;
      if (issue) { exclude(`${issue} evidence excludes this sample from both ratio components.`, issue); continue; }
      proof.numerator = row.numerator.numeric?.toJSON() ?? null; proof.denominator = row.denominator.numeric?.toJSON() ?? null;
      proof.value = proof.numerator;
      proof.included = true; proof.reason = `Included: numerator contribution ${JSON.stringify(proof.numerator)}, denominator contribution ${JSON.stringify(proof.denominator)}.`;
    } else {
      let cursor = 0; let previousEvent: TelemetryObservation | undefined; const reached: boolean[] = [];
      let unknown = false;
      for (const step of definition.measure.steps) {
        let found = false;
        for (; cursor < sample.observations.length; cursor++) {
          const event = sample.observations[cursor]; const matches = test(step.where, eventSample(sample, event));
          if (matches === null) unknown = true;
          if (matches) {
            if (previousEvent && !ordered(previousEvent, event)) { unknown = true; break; }
            previousEvent = event; found = true; cursor++; break;
          }
        }
        reached.push(found);
        if (!found) { while (reached.length < definition.measure.steps.length) reached.push(false); break; }
      }
      if (unknown || (!reached.every(Boolean) && !covered(sample))) { exclude('Incomplete evidence for ordered funnel steps.', 'unknown'); continue; }
      row.steps = reached; proof.included = true; proof.value = reached.filter(Boolean).length; proof.reason = `Reached ${proof.value} configured steps in order.`;
      proof.details = { ...proof.details, steps: reached };
    }
    coverage.included++;
  }
  const grouped = new Map<string, EvaluatedSample[]>();
  for (const row of evaluated) {
    if (!row.proof.included) continue;
    const key = JSON.stringify(row.proof.group); if (!grouped.has(key)) grouped.set(key, []); grouped.get(key)!.push(row);
    if (grouped.size > Math.min(input.max_groups ?? MAX_GROUPS, MAX_GROUPS)) throw new TelemetryDefinitionError('Grouping exceeds the result cardinality budget.', [], 'query_limit_exceeded');
  }
  const total = aggregateGroup(evaluated, definition, []);
  const groups = groupBy.length || definition.bucket ? [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => aggregateGroup(rows, definition, JSON.parse(key))) : [];
  if (coverage.unknown || coverage.missing || coverage.invalid) warnings.add('Missing, invalid, or incomplete evidence is excluded and disclosed; it is not zero.');
  const problemCount = coverage.unknown + coverage.missing + coverage.invalid;
  const attributed = evaluated.filter(row => row.proof.included);
  const unknownAttribution = attributed.filter(row => row.proof.agent_id == null).length;
  if (definition.attribution && unknownAttribution) warnings.add(`${unknownAttribution} included records have unknown agent attribution. They remain in the total and are shown separately in agent breakdowns.`);
  return { definition_key: definition.key, value: total.value, ...(total.numerator !== undefined ? { numerator: total.numerator, denominator: total.denominator } : {}),
    unit: definition.unit ?? (definition.measure.kind === 'ratio' ? 'percent' : 'number'), sample_count: total.sample_count, groups,
    ...(total.distribution ? { distribution: total.distribution } : {}), ...(total.funnel ? { funnel: total.funnel } : {}), coverage,
    quality: problemCount ? coverage.included ? 'partial' : 'unavailable' : 'complete', warnings: [...warnings], contributors: evaluated.map(row => row.proof),
    ...(definition.attribution ? { attribution_coverage: { known: attributed.length - unknownAttribution, unknown: unknownAttribution } } : {}),
    as_of: new Date(asOf).toISOString(), ...(input.data_revision ? { data_revision: input.data_revision } : {}), description: explain(definition) };
}

/** Aggregate already-authorized compatible series without averaging their percentages. */
export function rollupRatios(results: { definition: MetricDefinition; result: Pick<MetricResult, 'numerator' | 'denominator' | 'unit'> }[]): { value: NumericResult; numerator: NumericResult; denominator: NumericResult } {
  if (!results.length) return { value: null, numerator: 0, denominator: 0 };
  const first = results[0].definition;
  const compatibility = (definition: MetricDefinition): string => JSON.stringify({ grain: definition.grain, unit: definition.unit, time_basis: definition.time_basis, attribution: definition.attribution,
    denominator: definition.journey?.denominator, counting: definition.journey?.counting, cancellation: definition.journey?.cancellation, timeout: definition.journey?.timeout,
    additional_starts: definition.journey?.additional_starts, max_attempts: definition.journey?.max_attempts, bucket: definition.bucket,
    missing_policy: definition.missing_policy, comparison_contract: definition.comparison_contract });
  if (!first.comparison_contract || results.some(({ definition, result }) => definition.measure.kind !== 'ratio' || !['count', 'count_if', 'sum'].includes(definition.measure.numerator.aggregate) || !['count', 'count_if', 'sum'].includes(definition.measure.denominator.aggregate) || result.unit !== results[0].result.unit || compatibility(definition) !== compatibility(first))) {
    throw new TelemetryDefinitionError('Ratio rollups require an explicit compatible comparison contract.', [], 'incompatible_comparison');
  }
  const components = results.map(({ result }) => ({ numerator: Decimal.parse(result.numerator), denominator: Decimal.parse(result.denominator) }));
  if (components.some(component => !component.numerator || !component.denominator)) return { value: null, numerator: null, denominator: null };
  const numerator = sumDecimals(components.map(component => component.numerator!)); const denominator = sumDecimals(components.map(component => component.denominator!));
  return { numerator: numerator.toJSON(), denominator: denominator.toJSON(), value: numerator.divide(denominator)?.toJSON() ?? null };
}
