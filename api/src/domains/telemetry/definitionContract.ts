import { z } from 'zod';
import { telemetryDefinitionSchemas } from './inputSchemas';
import { firstPassRecipe } from './recipes';

const leadCount = {
  version: 1, key: 'lead_search_count', name: 'Lead search count', grain: 'task',
  population: { field: 'title', op: 'matches_regex', value: '^Lead Search', flags: 'i' },
  measure: { kind: 'aggregate', aggregate: 'count' }, time_basis: 'current',
  attribution: 'assigned_agent_current', missing_policy: 'exclude_and_report', group_by: [{ field: 'agent_id' }],
};

export const telemetryDefinitionExamples = {
  lead_search_count: {
    description: 'Current matching tasks, grouped by current assigned agent. Use catalog scope choices to select the project, workflow/type and task type together.',
    definition: leadCount,
  },
  custom_field_calculation: {
    description: 'Sum a custom numeric field, multiplying each value by two. Replace FIELD_ID with fields[].id for the desired numeric field from the scoped catalog.',
    definition: { ...leadCount, key: 'custom_total', name: 'Custom total', measure: { kind: 'aggregate', aggregate: 'sum', value: { op: 'multiply', args: [{ field: 'FIELD_ID' }, { literal: 2 }] } } },
  },
  combined_filter: {
    description: 'An additional query or widget filter. AND/OR/NOT conditions and the saved population intersect; scope can only narrow access.',
    filter: { all: [leadCount.population, { any: [{ field: 'priority', op: 'eq', value: 'high' }, { not: { field: 'assigned_agent_id', op: 'is_missing' } }] }] },
  },
  first_pass_by_entry_agent: {
    description: 'Journeys starting at task creation. Replace SUCCESS_OUTCOME_ID and REWORK_OUTCOME_ID with catalog outcomes[].id selected for your workflow/task type. Success is explicit, not inferred from a label.',
    definition: {
      ...firstPassRecipe({
        key: 'first_pass_by_entry_agent', name: 'First pass by entry agent',
        start: { field: 'event.type', op: 'eq', value: 'task.created' },
        success: { field: 'event.outcome', op: 'eq', value: 'SUCCESS_OUTCOME_ID' },
        rework: { field: 'event.outcome', op: 'eq', value: 'REWORK_OUTCOME_ID' },
      }),
      attribution: 'assigned_agent_at_entry', group_by: [{ field: 'agent_id' }],
    },
  },
  profile: {
    description: 'Reusable event signals. Replace SUCCESS_OUTCOME_ID with the chosen catalog outcome ID, save this profile, then pin its returned revision in a metric.',
    definition: { signals: { success: { field: 'event.outcome', op: 'eq', value: 'SUCCESS_OUTCOME_ID' } } },
  },
  profile_metric: {
    description: 'Replace PROFILE_REVISION_ID with the saved profile revision. Symbolic signals belong in metric definitions; query/widget overrides use explicit predicates.',
    definition: {
      version: 1, key: 'success_events', name: 'Success events', grain: 'event', time_basis: 'event_occurred_at',
      missing_policy: 'exclude_and_report', measure: { kind: 'aggregate', aggregate: 'count_if', where: { signal_ref: 'profile.success' } },
      profile_revision_id: 'PROFILE_REVISION_ID',
    },
  },
  component_metric: {
    description: 'Replace METRIC_REVISION_ID with a compatible aggregate metric revision. The referenced metric must match grain, time basis and attribution.',
    definition: { ...leadCount, key: 'component_count', name: 'Component count', measure: { metric_ref: 'METRIC_REVISION_ID' } },
  },
  dashboard: {
    description: 'Replace METRIC_REVISION_ID with a saved metric revision. presentation:view instead creates a saved single-metric view. Table/bar/card support current counts; line charts require historical measurements and a bucket.',
    definition: {
      presentation: 'dashboard', metrics: [{
        id: 'lead_search_agents', metric_revision_id: 'METRIC_REVISION_ID', title: 'Lead searches by agent', display: 'bar',
        view: { group_by: [{ field: 'agent_id' }], filter: leadCount.population, bucket: null, sort: 'value_desc' },
        layout: { width: 6, height: 'regular' },
      }],
    },
  },
  dashboard_page: {
    description: 'A configurable dashboard page. Save with save_telemetry_dashboard; metric bindings pin saved revisions and blocks reference their local binding IDs. Replace METRIC_REVISION_ID before saving.',
    definition: {
      version: 1, timezone: 'UTC', appearance: { width: 'wide', density: 'comfortable' },
      metrics: [{ id: 'searches', metric_revision_id: 'METRIC_REVISION_ID' }],
      sections: [{ id: 'overview', title: 'Overview', columns: [{ id: 'main', width: 12, blocks: [
        { id: 'summary', type: 'metric', binding_id: 'searches', title: 'Lead searches', display: 'card', accent: 'blue', precision: 0 },
        { id: 'context', type: 'note', text: 'Use the metric details to inspect contributing records.' },
      ] }] }],
    },
  },
};

let contract: ReturnType<typeof buildContract> | undefined;
function buildContract() {
  return {
    version: 1,
    schemas: Object.fromEntries(Object.entries(telemetryDefinitionSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema, { reused: 'ref' })])),
    guidance: [
      'Each schema is a self-contained JSON Schema document; resolve its local $ref against that document.',
      'Read this scoped catalog first. Use fields[].id for custom fields and statuses[].id/outcomes[].id for canonical workflow signals. Replace uppercase placeholders in examples before calling tools.',
      'Scope selects project, workflow, workflow type and task type; population persists a filter in the metric. Query and widget filter overrides are ANDed with that population.',
      'Group by agent_id to use the selected attribution policy. assigned_agent_at_entry requires journey grain and an explicit journey.start. Current snapshot counts use assigned_agent_current.',
      'Journeys to include is the UI label for journey.denominator: evaluated, successful or all_started. Ratio measure.denominator is the separate numeric divisor.',
      'Metric signal_ref requires a pinned profile revision; metric_ref requires a compatible pinned aggregate metric revision. Profiles and query/widget filter overrides use explicit predicates.',
      'Current snapshots cannot be historical trends. Use an explicit created_at population predicate for a creation cohort, or event/journey grain with from/to, timezone and bucket for historical measurements.',
      'The shared backend validates canonical references, scope, type/basis compatibility, RE2 patterns, journey/attribution requirements and bounded expressions (500 nodes, depth 12). Structural schemas do not replace semantic validation.',
      'Validate and preview a metric before saving. Save/revise reports for saved metric views and legacy dashboards. Save/revise dashboards for configurable pages with sections, columns and blocks. Revisions require expected_revision_id. Inspect query contributors using the retained query_id and exact JSON group key.',
    ],
    examples: telemetryDefinitionExamples,
  };
}

export function getTelemetryDefinitionContract() {
  return contract ??= buildContract();
}
