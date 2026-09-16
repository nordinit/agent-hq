// Generated from api/src/domains/telemetry; run node ui/scripts/sync-telemetry-contracts.js.
import type { AggregateMeasure, JourneyDefinition, MetricDefinition, Predicate, ValueBasis } from './contracts';

interface Named { key: string; name: string }
interface JourneyRecipe extends Named {
  start: Predicate; success: Predicate; rework?: Predicate; unsuccessful?: Predicate; cancelled?: Predicate;
  denominator?: JourneyDefinition['denominator']; counting?: JourneyDefinition['counting']; reset?: Predicate;
  attempt?: Predicate; max_attempts?: number; timeout?: JourneyDefinition['timeout'];
}
const base = (args: Named): Pick<MetricDefinition, 'version' | 'key' | 'name' | 'missing_policy'> => ({ version: 1, key: args.key, name: args.name, missing_policy: 'exclude_and_report' });
export function numericRecipe(args: Named & { field: string; aggregate?: 'sum' | 'mean' | 'min' | 'max' | 'percentile'; basis?: ValueBasis; unit?: string; percentile?: number }): MetricDefinition {
  return { ...base(args), grain: 'task', time_basis: 'current', unit: args.unit ?? 'number',
    measure: { kind: 'aggregate', aggregate: args.aggregate ?? 'sum', value: { field: args.field, basis: args.basis ?? 'current' }, ...(args.aggregate === 'percentile' ? { percentile: args.percentile ?? 0.5 } : {}) } };
}
export function milestoneRecipe(args: Named & { milestone: Predicate }): MetricDefinition {
  return { ...base(args), grain: 'event', time_basis: 'event_occurred_at', unit: 'tasks',
    measure: { kind: 'aggregate', aggregate: 'distinct_count', value: { field: 'id' }, where: args.milestone } };
}
export function firstPassRecipe(args: JourneyRecipe): MetricDefinition {
  const journey: JourneyDefinition = { start: args.start, success: args.success, counting: args.counting ?? 'first_per_entity', denominator: args.denominator ?? 'evaluated', additional_starts: 'ignore', cancellation: 'exclude', timeout: args.timeout ?? null,
    ...(args.rework ? { rework: args.rework } : {}), ...(args.unsuccessful ? { unsuccessful: args.unsuccessful } : {}),
    ...(args.cancelled ? { cancelled: args.cancelled } : {}), ...(args.reset ? { reset: args.reset } : {}),
    ...(args.attempt ? { attempt: args.attempt } : {}), ...(args.max_attempts ? { max_attempts: args.max_attempts } : {}) };
  const numerator: Predicate[] = [{ field: 'journey.resolution', op: 'eq', value: 'success' }, { field: 'journey.disqualified', op: 'eq', value: false }];
  if (args.max_attempts) numerator.push({ field: 'journey.attempts', op: 'lte', value: args.max_attempts });
  return { ...base(args), grain: 'journey', journey, time_basis: 'journey_started_at', attribution: 'assigned_agent_at_entry', unit: 'percent',
    measure: { kind: 'ratio', numerator: { kind: 'aggregate', aggregate: 'count_if', where: { all: numerator } },
      denominator: { kind: 'aggregate', aggregate: 'count_if', where: journey.denominator === 'successful' ? { field: 'journey.resolution', op: 'eq', value: 'success' } :
        { field: 'journey.resolution', op: 'in', value: journey.denominator === 'all_started' ? ['success', 'unsuccessful', 'pending'] : ['success', 'unsuccessful'] } } } };
}
export function durationRecipe(args: Named & { start: Predicate; end: Predicate; pairing?: 'first' | 'last' | 'each'; open?: 'exclude' | 'as_of'; aggregate?: AggregateMeasure['aggregate']; pause_start?: Predicate; pause_end?: Predicate }): MetricDefinition {
  return { ...base(args), grain: 'task', time_basis: 'current', unit: 'milliseconds', measure: { kind: 'aggregate', aggregate: args.aggregate ?? 'mean',
    value: { duration: { start: args.start, end: args.end, pairing: args.pairing ?? 'first', open: args.open ?? 'exclude', ...(args.pause_start ? { pause_start: args.pause_start } : {}), ...(args.pause_end ? { pause_end: args.pause_end } : {}) } } } };
}
export function blockedSnapshotRecipe(args: Named & { blocked: Predicate }): MetricDefinition {
  return { ...base(args), grain: 'task', time_basis: 'current', unit: 'percent', measure: { kind: 'ratio',
    numerator: { kind: 'aggregate', aggregate: 'count_if', where: args.blocked }, denominator: { kind: 'aggregate', aggregate: 'count' } } };
}
export function everBlockedRecipe(args: JourneyRecipe & { blocked: Predicate }): MetricDefinition {
  const metric = firstPassRecipe(args);
  metric.journey!.rework = args.blocked;
  metric.measure = { kind: 'ratio', numerator: { kind: 'aggregate', aggregate: 'count_if', where: { field: 'journey.disqualified', op: 'eq', value: true } },
    denominator: { kind: 'aggregate', aggregate: 'count' } };
  return metric;
}
export function percentTimeBlockedRecipe(args: JourneyRecipe & { blocked_start: Predicate; blocked_end: Predicate }): MetricDefinition {
  const metric = firstPassRecipe(args);
  metric.journey!.pause_start = args.blocked_start; metric.journey!.pause_end = args.blocked_end;
  metric.measure = { kind: 'ratio', numerator: { kind: 'aggregate', aggregate: 'sum', value: { field: 'journey.blocked_ms' } },
    denominator: { kind: 'aggregate', aggregate: 'sum', value: { field: 'journey.duration_ms' } } };
  return metric;
}
export function funnelRecipe(args: JourneyRecipe & { steps: { key: string; label?: string; where: Predicate }[] }): MetricDefinition {
  const metric = firstPassRecipe({ ...args, denominator: args.denominator ?? 'all_started' });
  metric.measure = { kind: 'funnel', steps: args.steps };
  metric.unit = 'journeys';
  return metric;
}

/** Drafts contain deliberately unbound milestones. The UI must ask for canonical choices. */
export const recipeCatalog = [
  { key: 'numeric', name: 'Numeric field', description: 'Sum, average, or summarize a configured numeric field.' },
  { key: 'milestone', name: 'Milestone reached', description: 'Count distinct tasks that reached a selected signal.' },
  { key: 'first_pass', name: 'First pass', description: 'Define success, rework, journey boundaries, and the denominator.' },
  { key: 'duration', name: 'Elapsed time', description: 'Measure between selected start/end signals, with optional pauses.' },
  { key: 'blocked_snapshot', name: 'Currently blocked', description: 'Choose which current condition means blocked.' },
  { key: 'ever_blocked', name: 'Ever blocked', description: 'Count journeys containing a configured blocked signal.' },
  { key: 'percent_time_blocked', name: 'Time blocked', description: 'Share of observed journey time between selected blockage boundaries.' },
  { key: 'funnel', name: 'Ordered funnel', description: 'Count journeys reaching configured milestones in order.' },
] as const;

export function coreRuntimeRecipes(): MetricDefinition[] {
  const terminal: Predicate = { field: 'runtime_state', op: 'in', value: ['succeeded', 'failed'] };
  return [
    { ...base({ key: 'core.runtime_failures.v1', name: 'Runtime failures' }), grain: 'runtime_execution', time_basis: 'current', unit: 'executions', measure: { kind: 'aggregate', aggregate: 'count_if', where: { field: 'runtime_state', op: 'eq', value: 'failed' } } },
    { ...base({ key: 'core.runtime_failure_rate.v1', name: 'Runtime failure rate' }), grain: 'runtime_execution', time_basis: 'current', population: terminal, unit: 'percent', measure: { kind: 'ratio', numerator: { kind: 'aggregate', aggregate: 'count_if', where: { field: 'runtime_state', op: 'eq', value: 'failed' } }, denominator: { kind: 'aggregate', aggregate: 'count' } } },
    { ...base({ key: 'core.runtime_cancelled.v1', name: 'Cancelled runtime executions' }), grain: 'runtime_execution', time_basis: 'current', unit: 'executions', measure: { kind: 'aggregate', aggregate: 'count_if', where: { field: 'runtime_state', op: 'eq', value: 'cancelled' } } },
    { ...base({ key: 'core.runtime_lost.v1', name: 'Lost runtime executions' }), description: 'Runtime executions explicitly classified as lost. Lost executions are excluded from the succeeded-or-failed runtime failure-rate denominator.', grain: 'runtime_execution', time_basis: 'current', unit: 'executions', measure: { kind: 'aggregate', aggregate: 'count_if', where: { field: 'runtime_state', op: 'eq', value: 'lost' } } },
    { ...base({ key: 'core.run_state_failures.v1', name: 'Run-state failures' }), description: 'Runs whose Agent HQ run status is failed. This classification is independent of runtime execution state and configured workflow outcomes.', grain: 'run', time_basis: 'current', unit: 'runs', measure: { kind: 'aggregate', aggregate: 'count_if', where: { field: 'status', op: 'eq', value: 'failed' } } },
    { ...base({ key: 'core.runtime_duration.v1', name: 'Elapsed runtime duration' }), grain: 'runtime_execution', time_basis: 'current', unit: 'milliseconds', measure: { kind: 'aggregate', aggregate: 'sum', value: { field: 'runtime_duration_ms' } } },
    { ...base({ key: 'core.input_tokens.v1', name: 'Recorded input tokens' }), grain: 'run', time_basis: 'current', unit: 'tokens', measure: { kind: 'aggregate', aggregate: 'sum', value: { field: 'tokens_in' } } },
    { ...base({ key: 'core.output_tokens.v1', name: 'Recorded output tokens' }), grain: 'run', time_basis: 'current', unit: 'tokens', measure: { kind: 'aggregate', aggregate: 'sum', value: { field: 'tokens_out' } } },
    { ...base({ key: 'core.missing_handoffs.v1', name: 'Missing required handoffs' }), grain: 'run', time_basis: 'current', unit: 'runs', measure: { kind: 'aggregate', aggregate: 'count_if', where: { field: 'semantic_outcome_missing', op: 'eq', value: true } } },
  ];
}
