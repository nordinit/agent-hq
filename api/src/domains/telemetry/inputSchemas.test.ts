import { telemetryMetricSchema, telemetryPredicateSchema, telemetryProfileSchema, telemetryReportSchema, telemetryValueSchema } from './inputSchemas';
import { getTelemetryDefinitionContract, telemetryDefinitionExamples as examples } from './definitionContract';
import { validateMetricDefinition } from './evaluator';
import { coreRuntimeRecipes, durationRecipe, funnelRecipe } from './recipes';

test('documented basic metric examples remain valid in the shared evaluator', () => {
  for (const definition of [examples.lead_search_count.definition, examples.custom_field_calculation.definition, examples.first_pass_by_entry_agent.definition]) {
    expect(telemetryMetricSchema.parse(definition)).toEqual(definition);
    expect(validateMetricDefinition(definition).errors).toEqual([]);
  }
  expect(telemetryPredicateSchema.parse(examples.combined_filter.filter)).toEqual(examples.combined_filter.filter);
  expect(telemetryProfileSchema.parse(examples.profile.definition)).toEqual(examples.profile.definition);
  expect(telemetryReportSchema.parse(examples.dashboard.definition)).toEqual(examples.dashboard.definition);
});

test('input schemas preserve symbolic references, runtime recipes, duration, and funnel definitions', () => {
  const start = { field: 'event.type', op: 'eq' as const, value: 'task.created' };
  const success = { field: 'event.to_status', op: 'eq' as const, value: 'approved' };
  for (const definition of [
    examples.profile_metric.definition, examples.component_metric.definition, ...coreRuntimeRecipes(),
    durationRecipe({ key: 'duration', name: 'Duration', start, end: success }),
    funnelRecipe({ key: 'funnel', name: 'Funnel', start, success, steps: [{ key: 'start', where: start }, { key: 'end', where: success }] }),
  ]) expect(telemetryMetricSchema.parse(definition)).toEqual(definition);
  const value = { if: { field: 'priority', op: 'eq', value: 'high' }, then: { event_count: start }, else: { literal: { decimal: '0.125' } } };
  expect(telemetryValueSchema.parse(value)).toEqual(value);
});

test('structural schemas reject unknown operators and malformed widget settings', () => {
  expect(telemetryPredicateSchema.safeParse({ field: 'title', op: 'sql', value: 'anything' }).success).toBe(false);
  expect(telemetryPredicateSchema.safeParse({ field: 'title', op: 'matches_regex', value: 'x'.repeat(513) }).success).toBe(false);
  expect(telemetryValueSchema.safeParse({ op: 'javascript', args: [] }).success).toBe(false);
  const widget = examples.dashboard.definition.metrics[0];
  expect(telemetryReportSchema.safeParse({ metrics: [{ ...widget, layout: { width: 5, height: 'huge' } }] }).success).toBe(false);
  expect(telemetryReportSchema.safeParse({ presentation: 'view', metrics: [widget, { ...widget, id: 'second' }] }).success).toBe(false);
});

test('semantic attribution errors still come from the shared validator with a useful field path', () => {
  const definition = telemetryMetricSchema.parse({ ...examples.lead_search_count.definition, attribution: 'assigned_agent_at_entry' });
  expect(validateMetricDefinition(definition).errors).toContainEqual(expect.objectContaining({ code: 'incompatible_attribution', path: 'journey.start' }));
  expect(getTelemetryDefinitionContract().schemas).toHaveProperty('journey');
});
