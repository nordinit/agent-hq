import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTelemetryDefinition, newTelemetryGuide, telemetrySignal } from './telemetryBuilder.ts';
import { filterTelemetryChoices, telemetryFieldChoices, telemetryFilterOperations, telemetryFilterValues, telemetryGuideRequirements, telemetryGuideSelectionIssue, telemetryNumericFields, telemetryPopulationFields, telemetrySignalChoices } from './telemetryBuilderOptions.ts';
import type { TelemetryCatalog } from './telemetryTypes.ts';

const catalog: TelemetryCatalog = {
  fields: [
    { id: 'story_points', key: 'story_points', label: 'Story points', type: 'number', supported_grains: ['task', 'event', 'journey'] },
    { id: 'tokens_in', key: 'tokens_in', label: 'Input tokens', type: 'number', supported_grains: ['run'] },
    { id: 'field_budget', key: 'budget', label: 'Budget', type: 'number', unit: 'USD', scope: { workflow_type: 'sales', task_type: 'proposal' }, value_bases: ['current', 'at_event'] },
    { id: 'field_review', key: 'review', label: 'Needs review', type: 'checkbox', supported_grains: ['task', 'event', 'journey'], scope: { workflow_type: 'sales', task_type: 'lead' } },
    { id: 'field_removed', key: 'old', label: 'Old amount', type: 'number', retired: true },
    { id: 'status', key: 'status', label: 'Status', type: 'select' },
    { id: 'event.outcome', key: 'event.outcome', label: 'Event outcome', type: 'text', supported_grains: ['task', 'event', 'journey'] },
  ],
  statuses: [
    { id: 's1', key: 'review', label: 'Review', scope: { workflow_type: 'sales' } },
    { id: 's2', key: 'review', label: 'Editorial review', scope: { workflow_type: 'content' } },
  ],
  outcomes: [{ id: 'o1', key: 'approved', label: 'Approved', scope: { workflow_type: 'sales' } }],
  workflow_types: [{ key: 'sales', name: 'Sales workflow' }, { key: 'content', name: 'Content workflow' }],
  routing_transitions: [{ id: 'route:1', label: 'Approved route', enabled: true, scope: { workflow_type: 'sales' }, predicate: { all: [{ field: 'event.outcome', op: 'eq', value: 'approved' }, { field: 'event.from_status', op: 'eq', value: 'review' }] } }],
  event_mappings: [{ id: 'mapping:1', label: 'Disabled webhook', enabled: false, scope: {}, predicate: { field: 'event.mapping_id', op: 'eq', value: 1 } }],
  projects: [], workflows: [], task_types: [], agents: [], recipes: [], core_metrics: [],
};

test('categorized signals retain their existing predicates and disclose shared status keys', () => {
  const choices = telemetrySignalChoices(catalog);
  assert.equal(choices.filter(choice => choice.value === 'status:review').length, 1);
  const review = choices.find(choice => choice.value === 'status:review')!;
  assert.match(review.description, /Sales workflow/);
  assert.match(review.description, /Content workflow/);
  assert.equal(review.category, 'Statuses');
  assert.deepEqual(telemetrySignal(review.value), { field: 'event.to_status', op: 'eq', value: 'review' });
  assert.equal(choices.find(choice => choice.value === 'outcome:approved')?.category, 'Outcomes');
  assert.ok(!choices.some(choice => choice.value === 'catalog:mapping:1'));
  const snapshot = telemetrySignalChoices(catalog, true);
  assert.equal(snapshot.find(choice => choice.value === 'status:review')?.label, 'Currently Review');
  assert.ok(snapshot.every(choice => ['Statuses', 'Field conditions'].includes(choice.category)));
  assert.deepEqual(buildTelemetryDefinition({ ...newTelemetryGuide(), recipe: 'blocked', blocked: review.value }).measure,
    { kind: 'ratio', numerator: { kind: 'aggregate', aggregate: 'count_if', where: { field: 'status', op: 'eq', value: 'review' } }, denominator: { kind: 'aggregate', aggregate: 'count' } });
});

test('search narrows by category, key, scope and multiple terms without changing choices', () => {
  const fields = telemetryFieldChoices(catalog.fields, catalog);
  assert.deepEqual(filterTelemetryChoices(fields, 'Custom fields', 'BUDGET usd', 'sales', 'proposal').map(choice => choice.value), ['field_budget']);
  assert.deepEqual(filterTelemetryChoices(fields, 'Custom fields', '', 'sales', 'proposal').map(choice => choice.value), ['field_budget']);
  assert.deepEqual(filterTelemetryChoices(fields, 'Custom fields', 'budget', 'content'), []);
  assert.ok(filterTelemetryChoices(fields, '*', 'story', 'sales', 'proposal').some(choice => choice.value === 'story_points'));
  assert.ok(filterTelemetryChoices(telemetrySignalChoices(catalog), 'Statuses', 'editorial', 'content').some(choice => choice.value === 'status:review'));
  assert.ok(!fields.some(choice => choice.value === 'field_removed'));
});

test('numeric and population choices honor compatible grains and value timing', () => {
  const guide = { ...newTelemetryGuide(), recipe: 'numeric' as const };
  assert.deepEqual(telemetryNumericFields(catalog, guide).map(field => field.id), ['story_points', 'field_budget']);
  assert.deepEqual(telemetryNumericFields(catalog, { ...guide, basis: 'at_entry' }).map(field => field.id), ['story_points']);
  assert.ok(!telemetryPopulationFields(catalog, newTelemetryGuide()).some(field => field.id === 'event.outcome'));
  assert.ok(telemetryPopulationFields(catalog, { ...guide, basis: 'at_event' }).some(field => field.id === 'event.outcome'));
  assert.ok(!telemetryPopulationFields(catalog, guide).some(field => field.id === 'tokens_in'));
});

test('typed population controls offer boolean and catalog values and valid comparisons', () => {
  assert.deepEqual(telemetryFilterValues(catalog.fields.find(field => field.id === 'field_review'), catalog), [{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }]);
  assert.deepEqual(telemetryFilterValues(catalog.fields.find(field => field.id === 'status'), catalog), [{ value: 'review', label: 'Review' }]);
  assert.ok(telemetryFilterOperations('number').some(option => option.value === 'gte'));
  assert.ok(!telemetryFilterOperations('checkbox').some(option => option.value === 'gte'));
  assert.ok(telemetryFilterOperations('text').some(option => option.value === 'is_missing'));
});

test('scope and recipe changes flag incompatible active selections without deleting them', () => {
  const guide = { ...newTelemetryGuide(), recipe: 'first_pass' as const, success: 'outcome:approved', rework: 'status:review' };
  const before = structuredClone(guide);
  assert.equal(telemetryGuideSelectionIssue(guide, catalog), undefined);
  assert.match(telemetryGuideSelectionIssue(guide, { ...catalog, outcomes: [] })!, /Success condition is unavailable/);
  assert.deepEqual(guide, before);
  assert.equal(telemetryGuideSelectionIssue({ ...guide, recipe: 'count' }, { ...catalog, outcomes: [] }), undefined);
  assert.match(telemetryGuideSelectionIssue({ ...guide, recipe: 'blocked', blocked: 'event:run.failed' }, catalog)!, /Blocked condition is unavailable/);
  assert.match(telemetryGuideSelectionIssue({ ...guide, filterField: 'tokens_in' }, catalog)!, /population field is unavailable/);
  assert.match(telemetryGuideSelectionIssue({ ...guide, filterField: 'field_review', filterOp: 'gt' }, catalog)!, /operator is incompatible/);
});

test('time buckets are offered only for recipes with a historical time basis', () => {
  for (const recipe of ['count', 'numeric', 'milestone', 'first_pass', 'duration', 'blocked', 'ever_blocked', 'percent_blocked', 'funnel'] as const) {
    const guide = { ...newTelemetryGuide(), recipe, field: 'story_points', success: 'status:approved', blocked: 'status:blocked', unblocked: 'status:review', steps: ['status:review', 'status:approved'] };
    assert.equal(telemetryGuideRequirements(guide).bucket, buildTelemetryDefinition(guide).time_basis !== 'current', recipe);
  }
});
