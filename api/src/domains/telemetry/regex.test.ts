import { compileTelemetryRegex } from './regex';
import { evaluateMetric, evaluatePredicate, validateMetricDefinition } from './evaluator';
import { milestoneRecipe } from './recipes';
import type { MetricDefinition } from './contracts';

const asOf = '2026-09-17T12:00:00Z';
const definition: MetricDefinition = { version: 1, key: 'leads', name: 'Leads', grain: 'task', time_basis: 'current', missing_policy: 'exclude_and_report', measure: {kind: 'aggregate', aggregate: 'count'}, population: {field: 'title', op: 'matches_regex', value: '^(Lead|Proposal):', flags: 'i'} };

test('title regex filters counts and retains matching, excluded, and missing-title evidence', () => {
  const entities = ['Lead: Acme', 'proposal: Example', 'Other: Lead', null].map((title, id) => ({id, kind: 'task' as const, fields: {title}}));
  const result = evaluateMetric({definition, entities, as_of: asOf});
  expect(result.value).toBe(2);
  expect(result.contributors.filter(row => row.included).map(row => row.entity_id)).toEqual([0, 1]);
  expect(result.coverage.unknown).toBe(1);
  expect(evaluatePredicate({not: definition.population!}, {entity: entities[3], as_of: asOf})).toBeNull();
});

test('historical title matching uses the recorded title, not a later rename', () => {
  const metric = {...milestoneRecipe({key: 'created', name: 'Created leads', milestone: {field: 'event.type', op: 'eq', value: 'task.created'}}), population: definition.population};
  const result = evaluateMetric({definition: metric, as_of: asOf,
    entities: [{id: 1, kind: 'task', fields: {title: 'Renamed'}}],
    observations: [{id: 'created', entity_id: 1, type: 'task.created', occurred_at: '2026-09-17T10:00:00Z', fields: {}, after: {title: 'Lead: Original'}}]});
  expect(result.value).toBe(1);
});

test('matching searches within text, supports anchors, and does not retain match state', () => {
  const pattern = compileTelemetryRegex('proposal', 'i');
  expect(pattern.matcher('Draft PROPOSAL today').find()).toBe(true);
  expect(pattern.matcher('Draft PROPOSAL today').find()).toBe(true);
  expect(compileTelemetryRegex('^proposal$').matcher('Draft proposal').find()).toBe(false);
  expect(compileTelemetryRegex('^lead$', 'im').matcher('before\nLEAD\nafter').find()).toBe(true);
  expect(compileTelemetryRegex('a.b', 's').matcher('a\nb').find()).toBe(true);
  expect(compileTelemetryRegex('^(a+)+$').matcher('a'.repeat(20000) + '!').find()).toBe(false);
});

test.each(['[', '(?=lead)', '(lead)\\1', 'a'.repeat(513)])('invalid or unsupported patterns are rejected: %s', pattern => {
  expect(() => compileTelemetryRegex(pattern)).toThrow();
  expect(validateMetricDefinition({...definition, population: {field: 'title', op: 'matches_regex', value: pattern}}).valid).toBe(false);
});

test.each(['g', 'ii', 'x', 2, null])('unsupported flags are rejected: %s', flags => {
  expect(() => compileTelemetryRegex('lead', flags)).toThrow(/flags/);
});

test('regex requires a string pattern, a text field, and no unsupported properties', () => {
  for (const population of [
    {field: 'title', op: 'matches_regex', value: 42},
    {field: 'story_points', op: 'matches_regex', value: '4'},
    {field: 'title', op: 'matches_regex', value: 'lead', typo: true},
    {left: {field: 'title'}, op: 'matches_regex', value: 'lead'},
  ]) expect(validateMetricDefinition({...definition, population}).valid).toBe(false);
});
