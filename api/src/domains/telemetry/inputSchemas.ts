import { z } from 'zod';
import { scopeSchema } from './access';
import { reportSchema, telemetryViewSchema, telemetryWidgetSchema } from './views';

/** Discoverable input shapes. The shared compiler remains authoritative for types,
 * scope, history, reference resolution, expression budgets and semantic requirements. */
const basis = z.enum(['current', 'at_entry', 'at_event', 'at_resolution'])
  .describe('Value snapshot. Entry/resolution require journey grain; at_event requires an event context.');
const field = z.string().min(1).max(256).describe('Built-in field or canonical fields[].id from the scoped telemetry catalog. Use custom-field IDs, not labels or display keys.');
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null(), z.object({ decimal: z.string() }).strict()]);
const comparison = z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'is_missing', 'is_present']);

export const telemetryPredicateSchema: z.ZodType = z.lazy(() => z.union([
  z.object({ all: z.array(telemetryPredicateSchema).min(1).max(50) }).strict(),
  z.object({ any: z.array(telemetryPredicateSchema).min(1).max(50) }).strict(),
  z.object({ not: telemetryPredicateSchema }).strict(),
  z.object({ field, basis: basis.optional(), op: z.literal('matches_regex'), value: z.string().max(512), flags: z.string().max(3).regex(/^[ims]*$/).optional() }).strict()
    .describe('RE2 text match, e.g. {field:"title",op:"matches_regex",value:"^Lead Search",flags:"i"}. Optional flags i/m/s may each appear once.'),
  z.object({ field, basis: basis.optional(), op: comparison, value: z.union([scalar, z.array(scalar).max(100)]).optional() }).strict()
    .describe('in/not_in require a scalar list; is_missing/is_present need no value. Other comparisons require a scalar. For status/outcome equality, use the corresponding catalog signal ID or key.'),
  z.object({ left: telemetryValueSchema, op: comparison, right: telemetryValueSchema.optional() }).strict()
    .describe('Compare two value expressions. Membership uses the field/value-list form; missing/present need no right operand.'),
  z.object({ signal_ref: z.string().min(1) }).strict()
    .describe('Named signal from the pinned profile_revision_id, e.g. {signal_ref:"profile.success"}. Not valid inside profile definitions or query/widget filter overrides.'),
])).describe('Population or event condition. Combine with all/any/not. Full grammar and examples are returned by agent_hq_list_telemetry_catalog in definition_contract.');

export const telemetryDurationSchema = z.object({
  start: telemetryPredicateSchema, end: telemetryPredicateSchema,
  pairing: z.enum(['first', 'last', 'each']), open: z.enum(['exclude', 'as_of']),
  pause_start: telemetryPredicateSchema.optional(), pause_end: telemetryPredicateSchema.optional(),
}).strict().describe('Elapsed milliseconds between explicit event boundaries. Pause conditions must be supplied together.');

export const telemetryValueSchema: z.ZodType = z.lazy(() => z.union([
  z.object({ field, basis: basis.optional() }).strict(),
  z.object({ literal: scalar }).strict(),
  z.object({ op: z.enum(['add', 'subtract', 'multiply', 'divide']), args: z.array(telemetryValueSchema).min(2).max(10) }).strict()
    .describe('Numeric arithmetic; subtract/divide require exactly two operands. Add/subtract require compatible units.'),
  z.object({ if: telemetryPredicateSchema, then: telemetryValueSchema, else: telemetryValueSchema }).strict(),
  z.object({ event_count: telemetryPredicateSchema }).strict(),
  z.object({ event_exists: telemetryPredicateSchema }).strict(),
  z.object({ duration: telemetryDurationSchema }).strict(),
])).describe('Field, literal, arithmetic, conditional, event count/existence, or duration expression. Group by {field:"agent_id"} to use the metric attribution policy.');

export const telemetryAggregateSchema = z.object({
  kind: z.literal('aggregate'),
  aggregate: z.enum(['count', 'count_if', 'distinct_count', 'sum', 'mean', 'min', 'max', 'percentile', 'distribution']),
  value: telemetryValueSchema.optional(), where: telemetryPredicateSchema.optional(),
  percentile: z.number().min(0).max(1).optional(),
  buckets: z.array(z.number()).max(50).optional(),
}).strict().describe('count_if requires where; all aggregates except count/count_if require value. percentile requires a 0–1 fraction; distribution requires increasing upper bounds.');
const metricReference = z.object({ metric_ref: z.string().min(1) }).strict()
  .describe('Pinned metric revision whose measure reduces to an aggregate. Scope, grain, attribution and time basis must be compatible.');
const aggregateComponent = z.union([telemetryAggregateSchema, metricReference]);
export const telemetryMeasureSchema = z.union([
  aggregateComponent,
  z.object({ kind: z.literal('ratio'), numerator: aggregateComponent, denominator: aggregateComponent }).strict()
    .describe('Ratio of numeric aggregates. Components cannot use distribution or distinct_count.'),
  z.object({ kind: z.literal('funnel'), steps: z.array(z.object({ key: z.string().min(1), label: z.string().optional(), where: telemetryPredicateSchema }).strict()).min(2).max(10) }).strict()
    .describe('Ordered steps with unique keys; requires journey grain.'),
]);

export const telemetryJourneySchema = z.object({
  start: telemetryPredicateSchema.describe('Explicit journey entry condition. Required for assigned_agent_at_entry attribution.'),
  success: telemetryPredicateSchema, rework: telemetryPredicateSchema.optional(), unsuccessful: telemetryPredicateSchema.optional(),
  cancelled: telemetryPredicateSchema.optional(), reset: telemetryPredicateSchema.optional(), attempt: telemetryPredicateSchema.optional(),
  max_attempts: z.number().int().positive().optional(),
  counting: z.enum(['first_per_entity', 'per_reset', 'per_stage_visit']).describe('per_reset requires a reset condition.'),
  denominator: z.enum(['evaluated', 'successful', 'all_started'])
    .describe('Journeys to include (UI label). evaluated: resolved success/unsuccessful; successful: successful only; all_started: also pending. JSON key remains denominator.'),
  additional_starts: z.enum(['ignore', 'attempt']).optional(), cancellation: z.enum(['exclude', 'unsuccessful']).optional(),
  timeout: z.object({ milliseconds: z.number().int().positive(), resolution: z.enum(['unsuccessful', 'excluded']) }).strict().nullable().optional(),
  pause_start: telemetryPredicateSchema.optional(), pause_end: telemetryPredicateSchema.optional(),
}).strict().describe('Explicit journey boundaries and policies. Supply both pause boundaries or neither.');

export const telemetryMetricSchema = z.object({
  version: z.literal(1), key: z.string().min(1).max(200), name: z.string().min(1).max(200), description: z.string().optional(),
  grain: z.enum(['task', 'run', 'runtime_execution', 'event', 'journey', 'workflow', 'project', 'agent']),
  population: telemetryPredicateSchema.optional().describe('Persistent population filter, ANDed with any query/widget filter. Title regex belongs here when it should be saved.'),
  measure: telemetryMeasureSchema, journey: telemetryJourneySchema.optional(),
  time_basis: z.enum(['current', 'event_occurred_at', 'journey_started_at', 'journey_resolved_at'])
    .describe('Event grain uses event_occurred_at; journey uses entry/resolution time; all other grains use current.'),
  attribution: z.enum(['assigned_agent_current', 'assigned_agent_at_entry', 'executing_agent', 'event_actor', 'outcome_agent']).optional()
    .describe('assigned_agent_at_entry requires journey grain and journey.start. Current task counts use assigned_agent_current; event/outcome attribution needs event or journey; executing_agent needs executions, events or journeys.'),
  missing_policy: z.enum(['exclude_and_report', 'zero']), unit: z.string().optional(),
  group_by: z.array(telemetryValueSchema).max(3).optional(), bucket: z.enum(['hour', 'day', 'week', 'month']).optional(),
  comparison_contract: z.object({ key: z.string(), semantic_version: z.string() }).strict().optional(),
  profile_revision_id: z.string().optional().describe('Optional inline pinned profile, also accepted as a separate tool argument. If both are supplied they must agree.'),
}).strict().describe('Version 1 metric definition. Validate before saving. Semantic validation and canonical reference resolution use the same backend as the UI.');

export const telemetryProfileSchema = z.object({
  signals: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/), telemetryPredicateSchema)
    .refine(signals => Object.keys(signals).length > 0 && Object.keys(signals).length <= 30, 'Provide 1–30 named signals.')
    .describe('1–30 named event predicates. Metrics reference these via signal_ref and a pinned profile revision.'),
}).strict();

export const telemetryWidgetInputSchema = telemetryWidgetSchema.safeExtend({
  view: telemetryViewSchema.safeExtend({
    group_by: z.array(telemetryValueSchema).max(3).optional(), filter: telemetryPredicateSchema.optional(),
  }).optional(),
});
export const telemetryReportSchema = reportSchema.safeExtend({
  metrics: z.array(telemetryWidgetInputSchema).min(1).max(10),
  group_by: z.array(telemetryValueSchema).max(3).optional(),
}).describe('Pinned report, saved view (exactly one widget), or dashboard (up to 10 widgets). Widget filters narrow metric populations. Line charts require a historical metric and time bucket.');

export const telemetryDefinitionSchemas = {
  metric: telemetryMetricSchema, profile: telemetryProfileSchema, report: telemetryReportSchema,
  predicate: telemetryPredicateSchema, value_expression: telemetryValueSchema, journey: telemetryJourneySchema,
  scope: scopeSchema,
};
