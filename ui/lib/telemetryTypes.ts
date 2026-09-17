// Generated from the canonical API contract; UI Docker builds need no API source files.
export type { MetricDefinition, Predicate, ValueExpression, ValueBasis, Scalar, Contribution, GroupResult, MetricResult, DefinitionValidation } from './telemetry-contracts/contracts';
import type { MetricDefinition, Predicate, MetricResult, Contribution, ValueExpression } from './telemetry-contracts/contracts';

export interface TelemetryScope {
  project_id?: number;
  workflow_id?: number;
  workflow_type?: string;
  task_type?: string;
  include_archived?: boolean;
}
export interface TelemetryCatalogEntry {
  id: string;
  key: string;
  label: string;
  type?: string;
  unit?: string | null;
  scope?: TelemetryScope;
  bases?: string[];
  value_bases?: string[];
  options?: string[];
  retired?: boolean;
  supported_grains?: string[];
}
export interface TelemetryCatalog {
  fields: TelemetryCatalogEntry[];
  statuses: TelemetryCatalogEntry[];
  outcomes: TelemetryCatalogEntry[];
  projects: { id: number; name: string }[];
  workflows: { id: number; name: string; project_id: number; workflow_type: string }[];
  workflow_types: { key: string; name: string; project_id?: number }[];
  task_types: { key: string; label?: string; workflow_type?: string }[];
  agents: { id: number; name: string; project_id?: number }[];
  recipes: { key: string; name: string; description?: string }[];
  core_metrics: MetricDefinition[];
  routing_transitions?: { id: string; label: string; predicate: Predicate; enabled: boolean; scope: TelemetryScope }[];
  event_mappings?: { id: string; label: string; predicate: Predicate; enabled: boolean; scope: TelemetryScope }[];
  coverage?: Record<string, unknown>;
  operations?: string[];
}
export interface TelemetryRevision<T> {
  id: string;
  revision: number;
  definition: T;
  created_at?: string;
}
export interface TelemetryResource<T> {
  id: string;
  key: string;
  name: string;
  description?: string;
  project_id?: number | null;
  scope?: TelemetryScope;
  latest_revision_id: string;
  revision: number;
  definition: T;
  revisions?: TelemetryRevision<T>[];
  archived_at?: string | null;
}
export type TelemetryMetric = TelemetryResource<MetricDefinition>;
export type TelemetryProfile = TelemetryResource<{ signals: Record<string, Predicate> }>;
export type TelemetryDisplay = 'card' | 'table' | 'bar' | 'line' | 'funnel' | 'distribution';
export interface TelemetryView {
  group_by?: ValueExpression[];
  bucket?: MetricDefinition['bucket'] | null;
  filter?: Predicate;
  scope?: TelemetryScope;
  from?: string;
  to?: string;
  timezone?: string;
  sort?: 'value_desc' | 'value_asc' | 'label';
}
export interface TelemetryWidget {
  id?: string;
  metric_id?: string;
  metric_revision_id: string;
  title?: string;
  display?: TelemetryDisplay;
  view?: TelemetryView;
  layout?: { width: 4 | 6 | 12; height: 'compact' | 'regular' | 'tall' };
}
export interface TelemetryReportDefinition {
  metrics: TelemetryWidget[];
  presentation?: 'report' | 'view' | 'dashboard';
  scope?: TelemetryScope;
  from?: string;
  to?: string;
  timezone?: string;
  group_by?: ValueExpression[];
}
export type TelemetryReport = TelemetryResource<TelemetryReportDefinition>;
export interface TelemetryQuery {
  definition?: MetricDefinition;
  metric_revision_id?: string;
  report_revision_id?: string;
  family_key?: string;
  scope?: TelemetryScope;
  from?: string;
  to?: string;
  as_of?: string;
  timezone?: string;
  group_by?: ValueExpression[];
  filter?: Predicate;
  bucket?: MetricDefinition['bucket'] | null;
  background?: boolean;
}
export interface TelemetryResult extends MetricResult {
  query_id: string;
  title?: string;
  metric_revision_id?: string;
  definition?: MetricDefinition;
  expires_at?: string;
  explanation?: string;
  versions?: Record<string, unknown>;
  state?: string;
  status?: string;
  display?: TelemetryDisplay;
  scope?: TelemetryScope;
  binding_id?: string;
}
export interface TelemetryQueryResponse extends Partial<TelemetryResult> {
  query_id: string;
  results?: TelemetryResult[];
  error?: string | { code?: string; message?: string };
  unbound?: number;
  disabled?: number;
}
export interface TelemetryContributors {
  contributors: Contribution[];
  total: number;
  offset: number;
  limit: number;
  has_more?: boolean;
}
export interface TelemetryBinding {
  id?: string;
  family_key: string;
  scope: TelemetryScope;
  metric_revision_id?: string | null;
  profile_revision_id?: string | null;
  disabled?: boolean;
  version?: number;
  precedence?: number;
  validation_state?: 'active' | 'needs_attention';
  validation_issues?: string[];
}
export interface TelemetryBindingResolution {
  winner: TelemetryBinding | null;
  origin: 'exact' | 'inherited' | 'unbound';
  shadowed: TelemetryBinding[];
  narrower: TelemetryBinding[];
}
export interface TelemetryBindingPreviewRequest {
  family_key: string;
  scope: TelemetryScope;
  override?: { metric_revision_id?: string | null; profile_revision_id?: string | null; disabled: boolean };
}
export interface TelemetryBindingPreview {
  family_key: string;
  scope: TelemetryScope;
  current: TelemetryBindingResolution;
  proposed?: TelemetryBindingResolution;
  effect?: 'create' | 'replace' | 'disable' | 'unchanged';
}
