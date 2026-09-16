import { Decimal } from './decimal';
import { calendarBucket, evaluateMetric, evaluatePredicate, rollupRatios, validateMetricDefinition } from './evaluator';
import { blockedSnapshotRecipe, coreRuntimeRecipes, durationRecipe, firstPassRecipe, funnelRecipe, milestoneRecipe, numericRecipe, percentTimeBlockedRecipe } from './recipes';
import type { CatalogDescriptor, MetricDefinition, Predicate, TelemetryEntity, TelemetryObservation } from './contracts';

const asOf = '2026-09-09T12:00:00Z';
const startAt = '2026-09-09T00:00:00Z';
const status = (value: string): Predicate => ({ field: 'event.to_status', op: 'eq', value });
const eventType = (value: string): Predicate => ({ field: 'event.type', op: 'eq', value });
const start = eventType('task.created');
function entity(id: string, fields: Record<string, unknown> = {}, complete = true): TelemetryEntity {
  return { id, kind: 'task', fields: { assigned_agent_id: 7, status: 'draft', ...fields }, coverage: { from: startAt, complete } };
}
function event(id: string, entityId: string, type: string, hour: number, fields: Record<string, unknown> = {}, extra: Partial<TelemetryObservation> = {}): TelemetryObservation {
  return { id, entity_id: entityId, entity_kind: 'task', type, occurred_at: `2026-09-09T${String(hour).padStart(2, '0')}:00:00Z`, fields, ...extra };
}
function created(id: string, hour = 1): TelemetryObservation { return event(`${id}.created`, id, 'task.created', hour, {}, { after: { assigned_agent_id: 7, status: 'draft' } }); }
function transition(id: string, entityId: string, to: string, hour: number, extra: Partial<TelemetryObservation> = {}): TelemetryObservation {
  return event(id, entityId, 'task.changed', hour, { to_status: to }, { before: { status: 'draft' }, after: { status: to, assigned_agent_id: 7 }, ...extra });
}
function firstPass(success = 'approved'): MetricDefinition {
  return firstPassRecipe({ key: 'first_pass', name: 'First pass', start, success: status(success), rework: eventType('revision_requested'), unsuccessful: status('rejected'), cancelled: status('cancelled') });
}
function sixTasks(): { entities: TelemetryEntity[]; observations: TelemetryObservation[] } {
  return {
    entities: ['A', 'B', 'C', 'D', 'E', 'F'].map(id => entity(id)),
    observations: [
      ...['A', 'B', 'C', 'D', 'E', 'F'].map(id => created(id)),
      transition('A.success', 'A', 'approved', 5),
      event('B.rework', 'B', 'revision_requested', 2), transition('B.success', 'B', 'approved', 5),
      event('C.runtime_failure', 'C', 'runtime.failed', 2), transition('C.success', 'C', 'approved', 5),
      transition('D.failed', 'D', 'rejected', 5), transition('F.cancel', 'F', 'cancelled', 5),
    ],
  };
}
function number(value: unknown): number | null { return value === null ? null : Decimal.parse(value)?.toNumber() ?? NaN; }

describe('workflow metric definitions determine business meaning', () => {
  test('six-task first pass has explicit components and excluded pending/cancelled work', () => {
    const result = evaluateMetric({ definition: firstPass(), ...sixTasks(), as_of: asOf });
    expect(result.value).toBe(0.5); expect(result.numerator).toBe(2); expect(result.denominator).toBe(4);
    expect(result.coverage).toMatchObject({ total: 6, included: 4, pending: 1, cancelled: 1, unknown: 0 });
    expect(result.contributors.find(row => row.entity_id === 'B')).toMatchObject({ numerator: 0, denominator: 1, details: { disqualified: true } });
    expect(result.contributors.find(row => row.entity_id === 'C')).toMatchObject({ numerator: 1, denominator: 1 });
    expect(result.contributors.find(row => row.entity_id === 'E')).toMatchObject({ included: false, resolution: 'pending' });
  });
  test('runtime failure disqualifies only when explicitly selected', () => {
    const definition = firstPass(); definition.journey!.rework = { any: [eventType('revision_requested'), eventType('runtime.failed')] };
    const result = evaluateMetric({ definition, ...sixTasks(), as_of: asOf });
    expect(result.value).toBe(0.25); expect(result.numerator).toBe(1); expect(result.denominator).toBe(4);
  });
  test('population and query filters also narrow pending, cancellation, and timeout coverage', () => {
    for(const kind of ['population','filter'] as const)for(const timeout of [false,true]){
      const definition=firstPass(),selected:Predicate={field:'id',op:'eq',value:'A'};
      if(timeout)definition.journey!.timeout={milliseconds:10*3600000,resolution:'excluded'};
      if(kind==='population')definition.population=selected;
      const result=evaluateMetric({definition,...sixTasks(),as_of:asOf,...(kind==='filter'?{filter:selected}:{})});
      expect(result.value).toBe(1);expect(result.coverage).toMatchObject({eligible:1,pending:0,cancelled:0,timed_out:0});
    }
  });
  test('successful-only and all-started denominators are separate configurable rates', () => {
    const successful = firstPassRecipe({ ...firstPass(), start, success: status('approved'), rework: eventType('revision_requested'), unsuccessful: status('rejected'), cancelled: status('cancelled'), denominator: 'successful' });
    const result = evaluateMetric({ definition: successful, ...sixTasks(), as_of: asOf });
    expect(result.numerator).toBe(2); expect(result.denominator).toBe(3); expect(number(result.value)).toBeCloseTo(2 / 3);
    const all = firstPassRecipe({ key: 'all', name: 'All', start, success: status('approved'), rework: eventType('revision_requested'), unsuccessful: status('rejected'), cancelled: status('cancelled'), denominator: 'all_started' });
    const allResult = evaluateMetric({ definition: all, ...sixTasks(), as_of: asOf });
    expect(allResult.numerator).toBe(2); expect(allResult.denominator).toBe(5); expect(allResult.value).toBe(0.4);
  });
  test.each(['done', 'approved', 'submitted'])('%s is just a configured success milestone', milestone => {
    const result = evaluateMetric({ definition: firstPass(milestone), entities: [entity('A')], observations: [created('A'), transition('success', 'A', milestone, 2)], as_of: asOf });
    expect(result.value).toBe(1);
  });
  test('no history does not prove absence and excludes BOTH ratio components', () => {
    const result = evaluateMetric({ definition: firstPass(), entities: [entity('A', {}, false)], observations: [created('A'), transition('ok', 'A', 'approved', 3)], as_of: asOf });
    expect(result.value).toBeNull(); expect(result.numerator).toBe(0); expect(result.denominator).toBe(0);
    expect(result.quality).toBe('unavailable'); expect(result.coverage.unknown).toBe(1);
  });
  test('bootstrap truth is not an entry transition', () => {
    const definition = milestoneRecipe({ key: 'approved', name: 'Approved', milestone: status('approved') });
    const result = evaluateMetric({ definition, entities: [entity('A', { status: 'approved' })], observations: [event('bootstrap', 'A', 'task.bootstrap', 1, {}, { after: { status: 'approved' } })], as_of: asOf });
    expect(result.value).toBe(0);
  });
  test('reopening does not mutate a completed first journey; explicit reset starts another', () => {
    const observations = [created('A'), transition('ok1', 'A', 'approved', 2), transition('reopen', 'A', 'draft', 3), transition('ok2', 'A', 'approved', 4)];
    const definition = firstPass();
    expect(evaluateMetric({ definition, entities: [entity('A')], observations, as_of: asOf }).denominator).toBe(1);
    definition.journey!.counting = 'per_reset'; definition.journey!.reset = status('draft');
    const reset = evaluateMetric({ definition, entities: [entity('A')], observations, as_of: asOf });
    expect(reset.denominator).toBe(2); expect(reset.numerator).toBe(2);
  });
  test('attempts use causal IDs so outcome and transition do not count twice', () => {
    const definition = firstPass(); definition.journey!.attempt = { any: [eventType('submission'), status('review')] }; definition.journey!.max_attempts = 2;
    const observations = [created('A'), event('submit', 'A', 'submission', 2, {}, { causation_id: 'cause-1' }), transition('review', 'A', 'review', 2, { causation_id: 'cause-1' }), transition('ok', 'A', 'approved', 3)];
    const result = evaluateMetric({ definition, entities: [entity('A')], observations, as_of: asOf });
    expect(result.contributors[0].details?.attempts).toBe(2); expect(result.value).toBe(1);
  });
  test('timeouts follow an explicit unsuccessful or exclusion policy', () => {
    const definition = firstPass(); definition.journey!.timeout = { milliseconds: 3600000, resolution: 'unsuccessful' };
    const result = evaluateMetric({ definition, entities: [entity('A')], observations: [created('A')], as_of: asOf });
    expect(result.value).toBe(0); expect(result.denominator).toBe(1); expect(result.coverage.timed_out).toBe(1);
    definition.journey!.timeout.resolution = 'excluded';
    const excluded = evaluateMetric({ definition, entities: [entity('A')], observations: [created('A')], as_of: asOf });
    expect(excluded.denominator).toBe(0); expect(excluded.coverage.timed_out).toBe(1);
  });
});

describe('deterministic historical reduction', () => {
  test('a missing catalog identity never falls back to a display key or a colliding built-in',()=>{
    const definition=numericRecipe({key:'pinned',name:'Pinned',field:'custom_retry_count'});
    const catalog:CatalogDescriptor[]=[{id:'custom_retry_count',key:'retry_count',type:'number'}];
    const missing=evaluateMetric({definition,catalog,entities:[entity('A',{retry_count:9})],as_of:asOf});
    expect(missing.value).toBeNull();expect(missing.coverage.missing).toBe(1);
    expect(evaluateMetric({definition,catalog,entities:[entity('A',{retry_count:9,custom_retry_count:4})],as_of:asOf}).value).toBe(4);
  });
  test('replay, duplicated delivery, and input order converge', () => {
    const data = sixTasks(); const expected = evaluateMetric({ definition: firstPass(), ...data, as_of: asOf });
    const replay = evaluateMetric({ definition: firstPass(), entities: data.entities, observations: [...data.observations].reverse().concat(data.observations), as_of: asOf });
    expect(replay).toEqual(expected);
  });
  test('explicit correction supersedes one logical fact; conflicting corrections remain unknown', () => {
    const original = transition('old', 'A', 'rejected', 2);
    const correction = transition('new', 'A', 'approved', 2, { supersedes: 'old' });
    const result = evaluateMetric({ definition: firstPass(), entities: [entity('A')], observations: [created('A'), original, correction], as_of: asOf });
    expect(result.value).toBe(1);
    const conflict = transition('other', 'A', 'rejected', 2, { supersedes: 'old' });
    expect(evaluateMetric({ definition: firstPass(), entities: [entity('A')], observations: [created('A'), original, correction, conflict], as_of: asOf }).coverage.unknown).toBe(1);
  });
  test('corrections retract old facts before applying effective-time limits, including chains and forks', () => {
    const original = transition('old', 'A', 'approved', 2);
    const future = transition('future', 'A', 'approved', 14, { supersedes: 'old' });
    const input = { definition: firstPass(), entities: [entity('A')], as_of: '2026-09-09T12:00:00Z' };
    const moved = evaluateMetric({ ...input, observations: [created('A'), original, future] });
    expect(moved.denominator).toBe(0); expect(moved.coverage.pending).toBe(1);
    const latest = transition('latest', 'A', 'approved', 3, { supersedes: 'future' });
    expect(evaluateMetric({ ...input, observations: [created('A'), original, future, latest] }).value).toBe(1);
    const fork = transition('fork', 'A', 'rejected', 4, { supersedes: 'old' });
    expect(evaluateMetric({ ...input, observations: [created('A'), original, future, fork] }).coverage.unknown).toBe(1);
  });
  test('simultaneous independent contradictory resolutions are unknown without sequence', () => {
    const observations = [created('A'), transition('a', 'A', 'approved', 2), transition('b', 'A', 'rejected', 2)];
    expect(evaluateMetric({ definition: firstPass(), entities: [entity('A')], observations, as_of: asOf }).coverage.unknown).toBe(1);
    observations[1].sequence = 1; observations[2].sequence = 2;
    expect(evaluateMetric({ definition: firstPass(), entities: [entity('A')], observations, as_of: asOf }).value).toBe(1);
  });
  test('same-time rework at resolution is counted even with a later lexical observation ID', () => {
    const observations = [created('A'), transition('a.success', 'A', 'approved', 2), event('z.rework', 'A', 'revision_requested', 2)];
    expect(evaluateMetric({ definition: firstPass(), entities: [entity('A')], observations, as_of: asOf }).value).toBe(0);
  });
  test('current and resolution values are distinct snapshots, and agent attribution uses the chosen basis', () => {
    const definition = firstPass(); definition.measure = { kind: 'aggregate', aggregate: 'sum', value: { field: 'amount', basis: 'at_resolution' } };
    definition.group_by = [{ field: 'agent_id' }];
    const observations = [created('A'), transition('done', 'A', 'approved', 2, { after: { amount: 10, assigned_agent_id: 11 } })];
    const catalog: CatalogDescriptor[] = [{ id: 'amount', type: 'number', bases: ['current', 'at_resolution', 'at_entry'] }];
    const result = evaluateMetric({ definition, catalog, entities: [entity('A', { amount: 99, assigned_agent_id: 22 })], observations, as_of: asOf });
    expect(result.value).toBe(10); expect(result.groups[0].key).toEqual([7]);
    definition.attribution = 'assigned_agent_current';
    expect(evaluateMetric({ definition, catalog, entities: [entity('A', { amount: 99, assigned_agent_id: 22 })], observations, as_of: asOf }).groups[0].key).toEqual([22]);
    definition.measure.value = { field: 'amount', basis: 'current' };
    expect(evaluateMetric({ definition, catalog, entities: [entity('A', { amount: 99 })], observations, as_of: asOf }).value).toBe(99);
  });
  test('runtime state failures do not depend on business task statuses', () => {
    const definition = coreRuntimeRecipes().find(recipe => recipe.key === 'core.runtime_failure_rate.v1')!;
    const entities: TelemetryEntity[] = ['succeeded', 'failed', 'cancelled', 'lost'].map((state, i) => ({ id: i, kind: 'runtime_execution', fields: { runtime_state: state } }));
    const result = evaluateMetric({ definition, entities, as_of: asOf });
    expect(result.numerator).toBe(1); expect(result.denominator).toBe(2); expect(result.value).toBe(0.5);
  });
});

describe('numeric statistics and evidence', () => {
  const catalog: CatalogDescriptor[] = [{ id: 'amount', type: 'number', unit: 'USD' }, { id: 'quantity', type: 'number' }, { id: 'flag', type: 'checkbox' }];
  test('decimal sums retain cents beyond IEEE precision and encode unsafe JSON numbers', () => {
    const definition = numericRecipe({ key: 'sum', name: 'Amount', field: 'amount', unit: 'USD' });
    expect(evaluateMetric({ definition, catalog, entities: [entity('A', { amount: 0.1 }), entity('B', { amount: 0.2 })], as_of: asOf }).value).toBe(0.3);
    const result = evaluateMetric({ definition, catalog, entities: [entity('A', { amount: { decimal: '9007199254740992.01' } }), entity('B', { amount: { decimal: '0.02' } })], as_of: asOf });
    expect(result.value).toEqual({ decimal: '9007199254740992.03' });
  });
  test('derived values reduce once per entity regardless of related observations', () => {
    const definition = numericRecipe({ key: 'total', name: 'Revenue', field: 'amount' });
    definition.measure = { kind: 'aggregate', aggregate: 'sum', value: { op: 'multiply', args: [{ field: 'amount' }, { field: 'quantity' }] } };
    const result = evaluateMetric({ definition, catalog, entities: [entity('A', { amount: 1.25, quantity: 3 })], observations: [created('A'), event('run1', 'A', 'run.created', 2), event('run2', 'A', 'run.created', 3)], as_of: asOf });
    expect(result.value).toBe(3.75); expect(result.sample_count).toBe(1);
    expect(() => evaluateMetric({ definition, catalog, entities: [entity('A'), entity('A')], as_of: asOf })).toThrow(/Duplicate entities/);
  });
  test('zero, missing, and malformed numeric values stay distinct', () => {
    const definition = numericRecipe({ key: 'mean', name: 'Mean', field: 'amount', aggregate: 'mean' });
    const entities = [entity('zero', { amount: 0 }), entity('missing'), entity('bad', { amount: 'nope' })];
    const result = evaluateMetric({ definition, catalog, entities, as_of: asOf });
    expect(result.value).toBe(0); expect(result.coverage).toMatchObject({ included: 1, missing: 1, invalid: 1 }); expect(result.quality).toBe('partial');
    definition.missing_policy = 'zero';
    expect(evaluateMetric({ definition, catalog, entities, as_of: asOf }).coverage).toMatchObject({ included: 2, missing: 0, invalid: 1 });
  });
  test('conditional missing evidence excludes both components before calculating a rate', () => {
    const definition = blockedSnapshotRecipe({ key: 'blocked', name: 'Blocked', blocked: { field: 'flag', op: 'eq', value: true } });
    const result = evaluateMetric({ definition, catalog, entities: [entity('A', { flag: true }), entity('B', { flag: false }), entity('C')], as_of: asOf });
    expect(result.numerator).toBe(1); expect(result.denominator).toBe(2); expect(result.coverage.unknown).toBe(1);
  });
  test('continuous percentiles and distributions obey configured bucket edges', () => {
    const definition = numericRecipe({ key: 'p', name: 'Percentile', field: 'amount', aggregate: 'percentile', percentile: 0.25 });
    const entities = [0, 10, 20, 30].map((amount, i) => entity(String(i), { amount }));
    expect(evaluateMetric({ definition, catalog, entities, as_of: asOf }).value).toBe(7.5);
    definition.measure = { kind: 'aggregate', aggregate: 'distribution', value: { field: 'amount' }, buckets: [10, 20] };
    expect(evaluateMetric({ definition, catalog, entities, as_of: asOf }).distribution).toEqual([{ from: null, to: 10, count: 1 }, { from: 10, to: 20, count: 1 }, { from: 20, to: null, count: 2 }]);
  });
  test('weighted rollups require an explicit compatible comparison contract', () => {
    const definition = firstPass(); definition.comparison_contract = { key: 'delivery', semantic_version: '1' };
    const result = rollupRatios([{ definition, result: { numerator: 8, denominator: 10, unit: 'percent' } }, { definition, result: { numerator: 1, denominator: 2, unit: 'percent' } }]);
    expect(result).toEqual({ value: 0.75, numerator: 9, denominator: 12 });
    const incompatible = structuredClone(definition); incompatible.journey!.denominator = 'successful';
    expect(() => rollupRatios([{ definition, result: { numerator: 8, denominator: 10, unit: 'percent' } }, { definition: incompatible, result: { numerator: 1, denominator: 2, unit: 'percent' } }])).toThrow(/compatible/);
  });
  test('three-valued predicates do not turn unknown into false', () => {
    expect(evaluatePredicate({ not: { field: 'flag', op: 'eq', value: true } }, { entity: entity('A'), as_of: asOf })).toBeNull();
    expect(evaluatePredicate({ all: [{ field: 'flag', op: 'eq', value: true }, { field: 'status', op: 'eq', value: 'done' }] }, { entity: entity('A'), as_of: asOf })).toBe(false);
  });
});

describe('durations, blockage, and funnels use configured boundaries', () => {
  const observations = [created('A'), transition('blocked1', 'A', 'blocked', 2), transition('resumed1', 'A', 'working', 3), transition('blocked2', 'A', 'blocked', 4), transition('resumed2', 'A', 'working', 6), transition('approved', 'A', 'approved', 7)];
  test('elapsed duration pauses only at the selected conditions', () => {
    const definition = durationRecipe({ key: 'duration', name: 'Active hours', start, end: status('approved'), pause_start: status('blocked'), pause_end: status('working') });
    const result = evaluateMetric({ definition, entities: [entity('A')], observations, as_of: asOf });
    expect(result.value).toBe(3 * 3600000);
  });
  test('percent blocked time sums disjoint intervals over observed journey duration', () => {
    const definition = percentTimeBlockedRecipe({ key: 'blocked', name: 'Blocked time', start, success: status('approved'), blocked_start: status('blocked'), blocked_end: status('working') });
    const result = evaluateMetric({ definition, entities: [entity('A')], observations, as_of: asOf });
    expect(result.numerator).toBe(3 * 3600000); expect(result.denominator).toBe(6 * 3600000); expect(result.value).toBe(0.5);
  });
  test('open durations stop at one fixed as-of and may be explicitly excluded', () => {
    const definition = durationRecipe({ key: 'dwell', name: 'Dwell', start: status('blocked'), end: status('working'), open: 'as_of', pairing: 'each' });
    const open = [created('A'), transition('blocked', 'A', 'blocked', 2)];
    expect(evaluateMetric({ definition, entities: [entity('A')], observations: open, as_of: asOf }).value).toBe(10 * 3600000);
    definition.measure = { kind: 'aggregate', aggregate: 'mean', value: { duration: { start: status('blocked'), end: status('working'), pairing: 'each', open: 'exclude' } } };
    expect(evaluateMetric({ definition, entities: [entity('A')], observations: open, as_of: asOf }).value).toBeNull();
  });
  test('ordered funnels count each journey once even with repeated visits', () => {
    const definition = funnelRecipe({ key: 'funnel', name: 'Approval funnel', start, success: status('approved'), steps: [{ key: 'created', where: start }, { key: 'working', where: status('working') }, { key: 'approved', where: status('approved') }] });
    const result = evaluateMetric({ definition, entities: [entity('A'), entity('B')], observations: [...observations, created('B'), transition('B.approved', 'B', 'approved', 5)], as_of: asOf });
    expect(result.funnel?.map(step => step.count)).toEqual([2, 1, 1]);
    expect(result.funnel?.[2]).toMatchObject({ from_entry: 0.5, from_previous: 1 });
  });
});

describe('bounded language and precise time semantics', () => {
  test('typed datetime predicates normalize offsets and text comparisons preserve spelling',()=>{
    const context={entity:entity('A',{created_at:'2026-09-09T12:00:00Z',code:'01'}),as_of:asOf};
    expect(evaluatePredicate({field:'created_at',op:'eq',value:'2026-09-09T08:00:00-04:00'},context)).toBe(true);
    expect(evaluatePredicate({field:'code',op:'eq',value:'1'},context)).toBe(false);
    const definition=numericRecipe({key:'n',name:'N',field:'story_points'});definition.population={field:'created_at',op:'gte',value:'2026-09-09T12:00:00'};
    expect(validateMetricDefinition(definition).valid).toBe(false);
  });
  test('long event histories retain linear evidence rather than copying every event into every proof',()=>{
    const observations=Array.from({length:2000},(_,i)=>({id:i,entity_id:'A',type:i%2?'stage.done':'stage.start',occurred_at:new Date(Date.parse(startAt)+i*1000).toISOString(),sequence:i,fields:{},after:{assigned_agent_id:7}}));
    const definition=firstPassRecipe({key:'visits',name:'Visits',start:eventType('stage.start'),success:eventType('stage.done'),counting:'per_stage_visit'});
    const result=evaluateMetric({definition,entities:[entity('A')],observations,as_of:asOf});
    expect(result.denominator).toBe(1000);
    expect(result.contributors.reduce((total,row)=>total+row.observation_ids.length,0)).toBe(2000);
    const events=milestoneRecipe({key:'events',name:'Events',milestone:eventType('stage.done')});
    const counted=evaluateMetric({definition:events,entities:[entity('A')],observations,as_of:asOf});
    expect(counted.contributors.every(row=>row.observation_ids.length===1)).toBe(true);
  });
  test('time windows are half-open and buckets use the requested timezone', () => {
    const definition = milestoneRecipe({ key: 'success', name: 'Submitted', milestone: status('submitted') }); definition.bucket = 'day';
    const result = evaluateMetric({ definition, entities: [entity('A'), entity('B')], observations: [transition('A', 'A', 'submitted', 2), transition('B', 'B', 'submitted', 3)], as_of: asOf, from: '2026-09-09T02:00:00Z', to: '2026-09-09T03:00:00Z', timezone: 'America/New_York' });
    expect(result.value).toBe(1); expect(result.groups[0].key).toEqual(['2026-09-08']);
  });
  test('DST repeated hours remain separate and nonexistent local timestamps are not guessed', () => {
    expect(calendarBucket('2026-11-01T05:30:00Z', 'hour', 'America/New_York')).toBe('2026-11-01T01:00-04:00');
    expect(calendarBucket('2026-11-01T06:30:00Z', 'hour', 'America/New_York')).toBe('2026-11-01T01:00-05:00');
    expect(() => evaluateMetric({ definition: firstPass(), entities: [], as_of: '2026-03-08T02:30:00' })).toThrow(/UTC offset/);
  });
  test('snapshot time windows require an explicit cohort rather than updated_at substitution', () => {
    expect(() => evaluateMetric({ definition: numericRecipe({ key: 'n', name: 'N', field: 'story_points' }), entities: [], as_of: asOf, from: startAt })).toThrow(/Current inventory/);
  });
  test('rejects unknown operators, unsafe field references, invalid types, and incompatible currencies', () => {
    const definition = numericRecipe({ key: 'n', name: 'N', field: 'amount' });
    definition.measure = { kind: 'aggregate', aggregate: 'sum', value: { op: 'eval', args: [] } as any };
    expect(validateMetricDefinition(definition).valid).toBe(false);
    definition.measure = { kind: 'aggregate', aggregate: 'sum', value: { field: '__proto__' } };
    expect(validateMetricDefinition(definition).valid).toBe(false);
    definition.measure = { kind: 'aggregate', aggregate: 'sum', value: { field: 'secret_unknown' } };
    expect(validateMetricDefinition(definition, []).errors.some(issue => issue.code === 'unknown_reference')).toBe(true);
    definition.measure = { kind: 'aggregate', aggregate: 'sum', value: { op: 'add', args: [{ field: 'usd' }, { field: 'eur' }] } };
    expect(validateMetricDefinition(definition, [{ id: 'usd', type: 'number', unit: 'USD' }, { id: 'eur', type: 'number', unit: 'EUR' }]).errors.some(issue => issue.code === 'incompatible_field_type')).toBe(true);
  });
  test('expression depth, group cardinality, record budgets, and query override ASTs are bounded', () => {
    const definition = firstPass(); let nested: Predicate = status('approved'); for (let i = 0; i < 15; i++) nested = { not: nested }; definition.population = nested;
    expect(validateMetricDefinition(definition).errors.some(issue => issue.code === 'query_limit_exceeded')).toBe(true);
    const numeric = numericRecipe({ key: 'sum', name: 'Sum', field: 'story_points' });
    expect(() => evaluateMetric({ definition: numeric, entities: [entity('A'), entity('B')], as_of: asOf, max_samples: 1 })).toThrow(/budget/);
    expect(() => evaluateMetric({ definition: numeric, entities: [entity('A', { story_points: 1, project_id: 1 }), entity('B', { story_points: 2, project_id: 2 })], as_of: asOf, group_by: [{ field: 'project_id' }], max_groups: 1 })).toThrow(/cardinality/);
    expect(() => evaluateMetric({ definition: numeric, entities: [], as_of: asOf, group_by: [{ op: 'sql', args: [] } as any] })).toThrow(/Invalid query/);
  });
});
