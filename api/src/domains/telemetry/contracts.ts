/** Storage-independent, bounded telemetry language. Every field is a catalog ID or a built-in. */
export type DecimalValue = { decimal: string };
export type Scalar = string | number | boolean | null | DecimalValue;
export type ValueBasis = 'current' | 'at_entry' | 'at_event' | 'at_resolution';
export type Grain = 'task' | 'run' | 'runtime_execution' | 'event' | 'journey' | 'workflow' | 'project' | 'agent';
export type Comparison = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'contains' | 'is_missing' | 'is_present';
export type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | { field: string; basis?: ValueBasis; op: 'matches_regex'; value: string; flags?: string }
  | { field: string; basis?: ValueBasis; op: Comparison; value?: Scalar | Scalar[] }
  | { left: ValueExpression; op: Comparison; right?: ValueExpression };
export type ValueExpression =
  | { field: string; basis?: ValueBasis }
  | { literal: Scalar }
  | { op: 'add' | 'subtract' | 'multiply' | 'divide'; args: ValueExpression[] }
  | { if: Predicate; then: ValueExpression; else: ValueExpression }
  | { event_count: Predicate }
  | { event_exists: Predicate }
  | { duration: DurationDefinition };
export interface DurationDefinition {
  start: Predicate;
  end: Predicate;
  pairing: 'first' | 'last' | 'each';
  open: 'exclude' | 'as_of';
  pause_start?: Predicate;
  pause_end?: Predicate;
}
export interface AggregateMeasure {
  kind: 'aggregate';
  aggregate: 'count' | 'count_if' | 'distinct_count' | 'sum' | 'mean' | 'min' | 'max' | 'percentile' | 'distribution';
  value?: ValueExpression;
  where?: Predicate;
  percentile?: number;
  /** Explicit upper bounds; last bucket has no upper bound. */
  buckets?: number[];
}
export interface RatioMeasure { kind: 'ratio'; numerator: AggregateMeasure; denominator: AggregateMeasure }
export interface FunnelMeasure { kind: 'funnel'; steps: { key: string; label?: string; where: Predicate }[] }
export type Measure = AggregateMeasure | RatioMeasure | FunnelMeasure;
export interface JourneyDefinition {
  start: Predicate;
  success: Predicate;
  rework?: Predicate;
  unsuccessful?: Predicate;
  cancelled?: Predicate;
  reset?: Predicate;
  attempt?: Predicate;
  max_attempts?: number;
  counting: 'first_per_entity' | 'per_reset' | 'per_stage_visit';
  denominator: 'evaluated' | 'successful' | 'all_started';
  additional_starts?: 'ignore' | 'attempt';
  cancellation?: 'exclude' | 'unsuccessful';
  timeout?: { milliseconds: number; resolution: 'unsuccessful' | 'excluded' } | null;
  pause_start?: Predicate;
  pause_end?: Predicate;
}
export type Attribution = 'assigned_agent_current' | 'assigned_agent_at_entry' | 'executing_agent' | 'event_actor' | 'outcome_agent';
export interface MetricDefinition {
  version: 1;
  key: string;
  name: string;
  description?: string;
  grain: Grain;
  population?: Predicate;
  measure: Measure;
  journey?: JourneyDefinition;
  time_basis: 'current' | 'event_occurred_at' | 'journey_started_at' | 'journey_resolved_at';
  attribution?: Attribution;
  missing_policy: 'exclude_and_report' | 'zero';
  unit?: string;
  group_by?: ValueExpression[];
  bucket?: 'hour' | 'day' | 'week' | 'month';
  comparison_contract?: { key: string; semantic_version: string };
}
export interface CatalogDescriptor {
  id: string;
  key?: string;
  label?: string;
  type: 'text' | 'textarea' | 'url' | 'select' | 'number' | 'checkbox' | 'date' | 'datetime';
  unit?: string | null;
  bases?: ValueBasis[];
  retired?: boolean;
  supported_grains?: Grain[];
}
export interface HistoryCoverage { from: string; to?: string; complete: boolean; sources?: string[]; reason?: string }
export interface TelemetryEntity {
  id: string | number;
  kind: Exclude<Grain, 'event' | 'journey'>;
  fields: Record<string, unknown>;
  coverage?: HistoryCoverage;
}
export interface TelemetryObservation {
  id: string | number;
  entity_id: string | number;
  entity_kind?: TelemetryEntity['kind'];
  type: string;
  occurred_at: string;
  recorded_at?: string;
  sequence?: number;
  causation_id?: string | null;
  /** Event attributes, exposed as both their key and event.<key>. */
  fields: Record<string, unknown>;
  /** Complete canonical field snapshots when available; never substitute current values. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  context?: Record<string, unknown>;
  supersedes?: string | number | null;
  provenance?: string;
}
export interface EvaluateMetricInput {
  definition: MetricDefinition;
  entities: TelemetryEntity[];
  observations?: TelemetryObservation[];
  catalog?: CatalogDescriptor[];
  as_of: string;
  from?: string;
  to?: string;
  timezone?: string;
  group_by?: ValueExpression[];
  filter?: Predicate;
  data_revision?: string;
  max_samples?: number;
  max_observations?: number;
  max_groups?: number;
}
export type NumericResult = number | DecimalValue | null;
export interface Contribution {
  sample_id: string;
  entity_id: string | number;
  entity_kind: TelemetryEntity['kind'];
  included: boolean;
  reason: string;
  value: Scalar;
  numerator?: NumericResult;
  denominator?: NumericResult;
  group: Scalar[];
  occurred_at?: string;
  started_at?: string;
  resolved_at?: string;
  resolution?: string;
  agent_id?: Scalar;
  observation_ids: (string | number)[];
  details?: Record<string, unknown>;
}
export interface DistributionBucket { from: number | null; to: number | null; count: number }
export interface FunnelStepResult { key: string; label?: string; count: number; from_entry: NumericResult; from_previous: NumericResult }
export interface GroupResult {
  key: Scalar[];
  value: NumericResult;
  numerator?: NumericResult;
  denominator?: NumericResult;
  sample_count: number;
  distribution?: DistributionBucket[];
  funnel?: FunnelStepResult[];
}
export interface CoverageCounts {
  total: number;
  eligible: number;
  included: number;
  excluded: number;
  missing: number;
  invalid: number;
  pending: number;
  cancelled: number;
  timed_out: number;
  unknown: number;
}
export interface MetricResult {
  definition_key: string;
  value: NumericResult;
  numerator?: NumericResult;
  denominator?: NumericResult;
  unit: string;
  sample_count: number;
  groups: GroupResult[];
  distribution?: DistributionBucket[];
  funnel?: FunnelStepResult[];
  coverage: CoverageCounts;
  quality: 'complete' | 'partial' | 'unavailable';
  warnings: string[];
  contributors: Contribution[];
  as_of: string;
  data_revision?: string;
  description: string;
}
export interface DefinitionIssue { code: string; path: string; message: string }
export interface DefinitionValidation { valid: boolean; errors: DefinitionIssue[]; references: string[] }
export class TelemetryDefinitionError extends Error {
  readonly code: string;
  constructor(message: string, readonly issues: DefinitionIssue[] = [], code = 'invalid_definition') {
    super(message); this.name = 'TelemetryDefinitionError'; this.code = code;
  }
}
