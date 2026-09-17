import type { TelemetryGuide } from './telemetryBuilder.ts';
import type { TelemetryCatalog, TelemetryCatalogEntry, TelemetryScope } from './telemetryTypes.ts';
import { metricAttributionIssues } from './telemetry-contracts/requirements.ts';

export interface TelemetryChoice {
  value: string;
  label: string;
  category: string;
  description: string;
  keywords?: string;
  scopes?: TelemetryScope[];
}

export type TelemetryChoiceScopeCatalog = Pick<TelemetryCatalog, 'workflow_types' | 'task_types'>;

/** Browse the configured task types, including types with only shared fields. */
export function telemetryChoiceScopeOptions(choices: TelemetryChoice[], catalog?: TelemetryChoiceScopeCatalog, workflowType = '') {
  const scopes = choices.flatMap(choice => choice.scopes ?? []);
  const workflows = catalog?.workflow_types ?? scopes.flatMap(scope => scope.workflow_type ? [{ key: scope.workflow_type, name: scope.workflow_type }] : []);
  const tasks: TelemetryCatalog['task_types'] = catalog?.task_types ?? scopes.flatMap(scope => scope.task_type ? [{ key: scope.task_type, workflow_type: scope.workflow_type }] : []);
  const workflowTypes = [...new Map(workflows.map(type => [type.key, { value: type.key, label: type.name }])).values()].sort((a, b) => a.label.localeCompare(b.label));
  const taskTypes = [...new Map(tasks.filter(type => !workflowType || !type.workflow_type || type.workflow_type === workflowType)
    .map(type => [type.key, { value: type.key, label: type.label || type.key }])).values()].sort((a, b) => a.label.localeCompare(b.label));
  // Visibility must not depend on the number of matches after choosing a workflow.
  return { workflowTypes, taskTypes, showTaskTypes: tasks.length > 0 || workflows.length > 0 };
}

export function telemetryGuideRequirements(guide: TelemetryGuide) {
  const journey = ['journey_count', 'first_pass', 'ever_blocked', 'percent_blocked', 'funnel'].includes(guide.recipe)
    || (guide.recipe === 'numeric' && ['at_entry', 'at_resolution'].includes(guide.basis));
  const start = journey || guide.recipe === 'duration';
  return {
    journey, start,
    success: start || guide.recipe === 'milestone' || (guide.recipe === 'numeric' && guide.basis === 'at_event'),
    bucket: journey || guide.recipe === 'milestone' || (guide.recipe === 'numeric' && guide.basis === 'at_event'),
    grain: journey ? 'journey' : guide.recipe === 'milestone' || (guide.recipe === 'numeric' && guide.basis === 'at_event') ? 'event' : 'task',
  };
}

function scopeLabels(scope: TelemetryScope | undefined, catalog: TelemetryCatalog): string[] {
  if (!scope) return [];
  return [
    catalog.workflow_types.find(type => type.key === scope.workflow_type)?.name ?? scope.workflow_type,
    scope.task_type,
    scope.workflow_id ? catalog.workflows.find(workflow => workflow.id === scope.workflow_id)?.name ?? `Workflow ${scope.workflow_id}` : '',
    scope.project_id ? catalog.projects.find(project => project.id === scope.project_id)?.name ?? `Project ${scope.project_id}` : '',
  ].filter((label): label is string => Boolean(label));
}
function scopeDescription(scope: TelemetryScope | undefined, catalog: TelemetryCatalog) {
  return [...new Set(scopeLabels(scope, catalog))].join(' · ');
}

export function telemetryFieldChoices(fields: TelemetryCatalogEntry[], catalog: TelemetryCatalog): TelemetryChoice[] {
  return fields.filter(field => !field.retired).map(field => ({
    value: field.id, label: field.label || field.key,
    category: field.id.startsWith('field_') ? 'Custom fields' : field.id.startsWith('event.') ? 'Event fields'
      : field.supported_grains && !field.supported_grains.some(grain => ['task', 'event', 'journey'].includes(grain)) ? 'Runtime fields' : 'Task fields',
    description: [field.type, field.unit, scopeDescription(field.scope, catalog)].filter(Boolean).join(' · '),
    keywords: `${field.key} ${field.id}`, scopes: field.scope ? [field.scope] : [],
  }));
}

export function telemetrySignalChoices(catalog: TelemetryCatalog, snapshot = false): TelemetryChoice[] {
  const keyed = (entries: TelemetryCatalogEntry[], kind: 'status' | 'outcome'): TelemetryChoice[] => {
    const groups = new Map<string, TelemetryCatalogEntry[]>();
    for (const entry of entries.filter(item => !item.retired)) groups.set(entry.key, [...(groups.get(entry.key) ?? []), entry]);
    // The existing guided predicates compare keys, not catalog identities. Keep one choice
    // per key and disclose its shared scope instead of implying a narrower predicate.
    return [...groups].map(([key, matches]) => ({
      value: `${kind}:${key}`,
      label: kind === 'status' ? `${snapshot ? 'Currently' : 'Entered'} ${matches[0].label || key}` : matches[0].label || key,
      category: kind === 'status' ? 'Statuses' : 'Outcomes',
      description: [key, ...new Set(matches.flatMap(entry => {
        const labels = scopeLabels(entry.scope, catalog);
        return labels.length ? labels : ['Shared across workflows'];
      }))].join(' · '),
      keywords: matches.map(entry => entry.label).join(' '), scopes: matches.map(entry => entry.scope ?? {}),
    }));
  };
  const fields = catalog.fields.filter(field => !field.retired && field.type === 'checkbox'
    && (!field.supported_grains || field.supported_grains.includes(snapshot ? 'task' : 'event')));
  const fieldChoices = telemetryFieldChoices(fields, catalog).map(choice => ({ ...choice, value: `field:${choice.value}`, label: `${choice.label} is true`, category: 'Field conditions' }));
  const statuses = keyed(catalog.statuses, 'status');
  if (snapshot) return [...statuses, ...fieldChoices];
  return [
    ...statuses, ...keyed(catalog.outcomes, 'outcome'),
    { value: 'event:task.created', label: 'Task was created', category: 'Task events', description: 'A recorded task creation' },
    { value: 'event:runtime.failed', label: 'Runtime execution failed', category: 'Runtime events', description: 'A recorded runtime execution failure' },
    { value: 'event:run.failed', label: 'Run failed', category: 'Runtime events', description: 'A recorded run failure' },
    ...(catalog.routing_transitions ?? []).filter(entry => entry.enabled).map(entry => ({ value: `catalog:${entry.id}`, label: entry.label, category: 'Routing signals', description: scopeDescription(entry.scope, catalog), scopes: [entry.scope] })),
    ...(catalog.event_mappings ?? []).filter(entry => entry.enabled).map(entry => ({ value: `catalog:${entry.id}`, label: entry.label, category: 'External events', description: scopeDescription(entry.scope, catalog), scopes: [entry.scope] })),
    ...fieldChoices,
  ];
}

export function filterTelemetryChoices(choices: TelemetryChoice[], category: string, query: string, workflowType = '', taskType = '') {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return choices.filter(choice => (!category || category === '*' || choice.category === category)
    && words.every(word => `${choice.label} ${choice.description} ${choice.keywords ?? ''}`.toLocaleLowerCase().includes(word))
    && (!(workflowType || taskType) || !choice.scopes?.length || choice.scopes.some(scope =>
      (!workflowType || !scope.workflow_type || scope.workflow_type === workflowType)
      && (!taskType || !scope.task_type || scope.task_type === taskType))));
}

export function telemetryPopulationFields(catalog: TelemetryCatalog, guide: TelemetryGuide) {
  const { grain } = telemetryGuideRequirements(guide);
  return catalog.fields.filter(field => !field.retired && (!field.supported_grains || field.supported_grains.includes(grain))
    && (grain === 'event' || !field.id.startsWith('event.')));
}

export function telemetryNumericFields(catalog: TelemetryCatalog, guide: TelemetryGuide) {
  return catalog.fields.filter(field => !field.retired && field.type === 'number'
    && (!field.supported_grains || field.supported_grains.includes('task'))
    && (guide.basis === 'at_event' || !field.id.startsWith('event.'))
    && (!field.value_bases && !field.bases || (field.value_bases ?? field.bases)?.includes(guide.basis)));
}

export const populationOperations = [
  { value: 'eq', label: 'Equals' }, { value: 'ne', label: 'Does not equal' },
  { value: 'gt', label: 'Greater than' }, { value: 'gte', label: 'At least' },
  { value: 'lt', label: 'Less than' }, { value: 'lte', label: 'At most' },
  { value: 'is_present', label: 'Has a value' }, { value: 'is_missing', label: 'Has no value' },
];
export function telemetryFilterOperations(type?: string) {
  return populationOperations.filter(option => ['number', 'date', 'datetime'].includes(type ?? '') || !['gt', 'gte', 'lt', 'lte'].includes(option.value));
}

export function telemetryFilterValues(field: TelemetryCatalogEntry | undefined, catalog: TelemetryCatalog) {
  if (!field) return [];
  if (field.type === 'checkbox') return [{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }];
  const entries = ['status', 'event.from_status', 'event.to_status'].includes(field.id) ? catalog.statuses
    : field.id === 'event.outcome' ? catalog.outcomes : [];
  const values = entries.length ? entries.map(entry => ({ value: entry.key, label: entry.label || entry.key }))
    : (field.options ?? []).map(value => ({ value, label: value }));
  return values.filter((option, index) => values.findIndex(item => item.value === option.value) === index);
}

/** Validate active choices without deleting settings when the measurement or scope changes. */
export function telemetryGuideSelectionIssue(guide: TelemetryGuide, catalog: TelemetryCatalog): string | undefined {
  const requirements = telemetryGuideRequirements(guide);
  const attributionIssue = metricAttributionIssues({ grain: requirements.grain as 'task'|'event'|'journey', attribution: guide.attribution, ...(requirements.journey ? { journey: { start: { field: 'event.type', op: 'eq', value: 'task.created' } } as import('./telemetryTypes.ts').MetricDefinition['journey'] } : {}) })[0];
  if (attributionIssue) return attributionIssue.message;
  if (requirements.start && !guide.start) return 'Choose when the journey or interval starts. This also establishes entry attribution.';
  if (requirements.success && !guide.success) return 'Choose the milestone that finishes the journey or measurement.';
  if (guide.recipe === 'numeric' && guide.field && !telemetryNumericFields(catalog, guide).some(field => field.id === guide.field))
    return 'The selected numeric field is unavailable for this scope or value timing. Choose a compatible field.';
  if (guide.filterField) {
    const field = telemetryPopulationFields(catalog, guide).find(field => field.id === guide.filterField);
    if (!field) return 'The population field is unavailable for this scope or measurement. Change or remove the filter.';
    if (!telemetryFilterOperations(field.type).some(option => option.value === guide.filterOp))
      return 'The population operator is incompatible with this field. Choose an available operator.';
  }
  const signals = telemetrySignalChoices(catalog);
  const active: [string, string, TelemetryChoice[]?][] = [
    ...(requirements.start ? [['Journey start', guide.start] as [string, string]] : []),
    ...(requirements.success ? [['Success condition', guide.success] as [string, string]] : []),
    ...(requirements.journey ? [...(guide.recipe !== 'ever_blocked' ? [['Rework', guide.rework]] : []), ['Unsuccessful result', guide.unsuccessful], ['Cancellation', guide.cancelled],
      ...(guide.counting === 'per_reset' ? [['Reset', guide.reset]] : [])] as [string, string][] : []),
    ...(['blocked', 'ever_blocked', 'percent_blocked'].includes(guide.recipe) ? [['Blocked condition', guide.blocked, guide.recipe === 'blocked' ? telemetrySignalChoices(catalog, true) : signals] as [string, string, TelemetryChoice[]]] : []),
    ...(guide.recipe === 'percent_blocked' ? [['Unblocked condition', guide.unblocked] as [string, string]] : []),
    ...(guide.recipe === 'funnel' ? guide.steps.map((step, index) => [`Step ${index + 1}`, step] as [string, string]) : []),
  ];
  for (const [label, value, options = signals] of active) {
    if (value && !options.some(option => option.value === value)) return `${label} is unavailable in this scope. Choose an available condition.`;
  }
}
