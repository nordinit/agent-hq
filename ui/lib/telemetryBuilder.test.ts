import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTelemetryDefinition, newTelemetryGuide, telemetryGuideFromDefinition, telemetrySignal, telemetryUtcBoundary } from './telemetryBuilder.ts';

test('a fresh metric does not assume a business success status or first-pass rate', () => {
  const definition = buildTelemetryDefinition(newTelemetryGuide());
  assert.equal(definition.measure.kind, 'aggregate');
  assert.equal(definition.grain, 'task');
  assert.equal(definition.journey, undefined);
  assert.throws(() => buildTelemetryDefinition({ ...newTelemetryGuide(), recipe: 'first_pass' }), /required milestone/);
});
test('guided milestones configure done, approved, and submitted through the same recipe', () => {
  for (const status of ['done', 'approved', 'submitted']) {
    const definition = buildTelemetryDefinition({ ...newTelemetryGuide(), recipe: 'milestone', success: `status:${status}` });
    assert.equal(definition.grain, 'event');
    assert.deepEqual(definition.measure, { kind: 'aggregate', aggregate: 'distinct_count', value: { field: 'id' }, where: { field: 'event.to_status', op: 'eq', value: status } });
  }
});
test('first-pass definition preserves selected denominator and does not add runtime failures as rework', () => {
  const guide = { ...newTelemetryGuide(), recipe: 'first_pass' as const, success: 'status:approved', denominator: 'successful' as const };
  const definition = buildTelemetryDefinition(guide);
  assert.equal(definition.journey?.rework, undefined);
  assert.equal(definition.journey?.denominator, 'successful');
  assert.equal(definition.journey?.counting, 'first_per_entity');
  assert.equal(definition.measure.kind, 'ratio');
  if (definition.measure.kind === 'ratio') assert.deepEqual(definition.measure.denominator.where, { field: 'journey.resolution', op: 'eq', value: 'success' });
  const selected = buildTelemetryDefinition({ ...guide, rework: 'event:runtime.failed' });
  assert.deepEqual(selected.journey?.rework, { field: 'event.type', op: 'eq', value: 'runtime.failed' });
});
test('numeric field measurement keeps canonical identity and historical value basis', () => {
  const definition = buildTelemetryDefinition({ ...newTelemetryGuide(), recipe: 'numeric', field: 'field_project_a_amount', basis: 'at_event', success: 'status:submitted', aggregate: 'sum' });
  assert.equal(definition.grain, 'event');
  assert.equal(definition.time_basis, 'event_occurred_at');
  assert.deepEqual(definition.population, { field: 'event.to_status', op: 'eq', value: 'submitted' });
  assert.equal(definition.measure.kind, 'aggregate');
  if (definition.measure.kind === 'aggregate') assert.deepEqual(definition.measure.value, { field: 'field_project_a_amount', basis: 'at_event' });
});
test('custom population filters are typed and never treat an invalid checkbox as false', () => {
  const guide = { ...newTelemetryGuide(), filterField: 'field_amount', filterType: 'number', filterValue: '12.5', filterOp: 'gte' as const };
  assert.deepEqual(buildTelemetryDefinition(guide).population, { field: 'field_amount', op: 'gte', value: 12.5 });
  assert.throws(() => buildTelemetryDefinition({ ...guide, filterValue: 'not a number' }), /valid number/);
  assert.throws(() => buildTelemetryDefinition({ ...guide, filterType: 'checkbox', filterValue: 'perhaps' }), /true or false/);
});
test('reset needs an explicit configured signal and status labels are not inferred', () => {
  assert.throws(() => buildTelemetryDefinition({ ...newTelemetryGuide(), recipe: 'first_pass', success: 'status:approved', counting: 'per_reset' }), /required milestone/);
  assert.deepEqual(telemetrySignal('outcome:changes_requested'), { field: 'event.outcome', op: 'eq', value: 'changes_requested' });
});
test('time boundaries use selected timezone independent of browser locale', () => {
  assert.equal(telemetryUtcBoundary('2026-09-09T12:30', 'America/New_York'), '2026-09-09T16:30:00.000Z');
  assert.equal(telemetryUtcBoundary('2026-01-09T12:30', 'America/New_York'), '2026-01-09T17:30:00.000Z');
  assert.equal(telemetryUtcBoundary('2026-09-09T12:30', 'UTC'), '2026-09-09T12:30:00.000Z');
  assert.equal(telemetryUtcBoundary('', 'UTC'), undefined);
  assert.throws(() => telemetryUtcBoundary('2026-03-08T02:30', 'America/New_York'), /does not exist/);
  assert.throws(() => telemetryUtcBoundary('2026-11-01T01:30', 'America/New_York'), /occurs twice/);
  assert.throws(() => telemetryUtcBoundary('2026-04-05T01:45', 'Australia/Lord_Howe'), /occurs twice/);
  assert.throws(() => telemetryUtcBoundary('2026-02-31T12:00', 'UTC'), /valid calendar/);
});

test('guided edits reopen saved definitions losslessly and preserve complex definitions in advanced mode', () => {
  const original = buildTelemetryDefinition({ ...newTelemetryGuide(), recipe: 'first_pass', success: 'status:approved', rework: 'outcome:revise', denominator: 'successful' });
  const restored = telemetryGuideFromDefinition(original);
  assert.ok(restored);
  assert.deepEqual(buildTelemetryDefinition(restored), original);
  assert.equal(telemetryGuideFromDefinition({ ...original, description: 'A custom advanced interpretation to preserve.' }), null);
});

test('guided routing and external mapping choices persist the exact scoped catalog predicate', () => {
  const predicate = { all: [{ field: 'event.type', op: 'eq' as const, value: 'task.external_event' }, { field: 'event.mapping_id', op: 'eq' as const, value: 45 }, { field: 'project_id', op: 'eq' as const, value: 11 }] };
  const guide = { ...newTelemetryGuide(), recipe: 'milestone' as const, success: 'catalog:mapping:45' };
  const definition = buildTelemetryDefinition(guide, { 'mapping:45': predicate });
  assert.equal(definition.measure.kind, 'aggregate');
  if (definition.measure.kind === 'aggregate') { assert.deepEqual(definition.measure.where, predicate); assert.notEqual(definition.measure.where, predicate); }
  assert.throws(() => buildTelemetryDefinition(guide), /unavailable in this catalog scope/);
});
