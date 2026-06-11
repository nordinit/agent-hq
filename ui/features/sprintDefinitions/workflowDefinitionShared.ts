'use client';

import type { CustomFieldDefinition, SprintTypeOutcome, TaskFieldSchema, TaskRelationshipTypeConfig } from '@/lib/api';

export type Notice = { type: 'success' | 'error'; message: string } | null;
export type SprintDefinitionTab = 'overview' | 'task-statuses' | 'task-fields' | 'relationship-types' | 'outcomes';
export type SprintTypeForm = { key: string; name: string; description: string };
export type FieldSchemaForm = { id?: number; task_type: string; fields: CustomFieldDefinition[] };
export type SchemaEditorPlacement =
  | { kind: 'default' }
  | { kind: 'new-task-type' }
  | { kind: 'task-type'; schemaId: number };
export type OutcomeEditorPlacement = 'add-base' | 'add-task-type' | 'edit';
export type RelationshipTypeForm = {
  id?: number;
  key: string;
  label: string;
  inverse_label: string;
  category: string;
  direction_semantics: TaskRelationshipTypeConfig['direction_semantics'];
  affects_dispatch_eligibility: boolean;
  active_statuses_text: string;
  resolved_statuses_text: string;
  allow_create_related_task: boolean;
  default_related_task_type: string;
  default_related_task_status: string;
};

export type OutcomeForm = {
  id?: number;
  task_type: string;
  outcome_key: string;
  label: string;
  description: string;
  enabled: boolean;
  behavior: 'base' | 'extend' | 'override' | 'disable';
  badge_variant: string;
  failure_like: boolean;
  blocked_like: boolean;
};

export type SchemaDeleteDialogState = {
  schema: TaskFieldSchema;
  expectedText: string;
  label: string;
};

export const emptySprintTypeForm: SprintTypeForm = { key: '', name: '', description: '' };
export const emptyField: CustomFieldDefinition = { key: '', label: '', type: 'text', required: false, options: [], help_text: '' };
export const BACKEND_ONLY_OUTCOMES = new Set(['runtime_failed']);
export const COLOR_OPTIONS = [
  'slate', 'red', 'orange', 'amber', 'yellow', 'green', 'blue', 'indigo', 'purple', 'pink', 'rose', 'cyan', 'emerald',
];

export const COLOR_CLASSES: Record<string, string> = {
  slate: 'bg-slate-500',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  yellow: 'bg-yellow-500',
  green: 'bg-green-500',
  blue: 'bg-blue-500',
  indigo: 'bg-indigo-500',
  purple: 'bg-purple-500',
  pink: 'bg-pink-500',
  rose: 'bg-rose-500',
  cyan: 'bg-cyan-500',
  emerald: 'bg-emerald-500',
};

export const TAB_HELP: Record<SprintDefinitionTab, string> = {
  overview: 'Edit the workflow details and the task types users and agents can create inside this workflow type.',
  'task-statuses': 'Edit the task status labels and colors users and agents see for this workflow type.',
  'task-fields': 'Define the task fields users and agents will see on tasks in this workflow type. Use the default schema for shared fields and task-type schemas only when a specific task type needs different fields.',
  outcomes: 'Configure the run outcome keys agents can report for this workflow type. Base outcomes apply across the workflow type; task-type overlays can extend, override, or disable those outcomes.',
  'relationship-types': 'Configure relationship types users can attach between tasks in this workflow type, including whether a relationship impacts dispatch eligibility.',
};

export const STATUS_COLUMN_HELP = {
  code: 'The status key agents and assignment rules use for this step.',
  label: 'The operator-facing name shown on tasks and boards.',
  emoji: 'The icon shown with this status in task views.',
  color: 'The badge color used for this status.',
  terminal: 'Whether this status means work is finished and should not continue moving.',
  transitions: 'The statuses a task can move to from this status.',
  actions: 'Edit or remove this status.',
};

export const FIELD_COLUMN_HELP = {
  scope: 'Whether the field is shared by all task types or belongs to one task type.',
  code: 'The field key agents and task forms use to store the value.',
  label: 'The operator-facing name shown on task forms.',
  type: 'The kind of input users and agents provide for this field.',
  required: 'Whether tasks must include this field before submission or gated outcomes.',
  help: 'Allowed values and guidance shown to users and agents.',
  actions: 'Edit or remove this field definition.',
};

export const RELATIONSHIP_COLUMN_HELP = {
  key: 'The relationship key used to store this type of task link.',
  labels: 'The forward and inverse names operators see between linked tasks.',
  category: 'The broad purpose of this relationship type.',
  direction: 'How Agent HQ should interpret the direction between the two linked tasks.',
  dispatchImpact: 'Whether this relationship can hold a task back from dispatch.',
  createRelated: 'Whether operators can create a related task from this relationship type.',
  actions: 'Edit or remove this relationship type.',
};

export const OUTCOME_COLUMN_HELP = {
  scope: 'Whether the outcome applies to every task type or only one task type.',
  code: 'The outcome key agents report at the end of a run.',
  name: 'The operator-facing outcome name.',
  behavior: 'How this outcome changes or inherits the workflow type defaults.',
  badge: 'The badge style used when this outcome appears in the UI.',
  metadata: 'Flags that mark the outcome as failure-like or blocked-like.',
  enabled: 'Whether agents can use this outcome.',
  actions: 'Edit or remove this outcome.',
};

export function emptySchemaForm(): FieldSchemaForm {
  return { task_type: '', fields: [{ ...emptyField }] };
}

export function schemaToForm(schema: TaskFieldSchema): FieldSchemaForm {
  return {
    id: schema.id,
    task_type: schema.task_type ?? '',
    fields: schema.schema.fields?.length ? schema.schema.fields.map(field => ({ ...field, options: field.options ?? [] })) : [{ ...emptyField }],
  };
}

export function outcomeToForm(outcome: SprintTypeOutcome): OutcomeForm {
  return {
    id: outcome.id,
    task_type: outcome.task_type ?? '',
    outcome_key: outcome.outcome_key,
    label: outcome.label,
    description: outcome.description,
    enabled: outcome.enabled === 1,
    behavior: outcome.behavior,
    badge_variant: outcome.badge_variant ?? '',
    failure_like: outcome.metadata?.failure_like === true,
    blocked_like: outcome.metadata?.blocked_like === true,
  };
}

export function emptyOutcomeForm(taskType = ''): OutcomeForm {
  return {
    task_type: taskType,
    outcome_key: '',
    label: '',
    description: '',
    enabled: true,
    behavior: taskType ? 'extend' : 'base',
    badge_variant: '',
    failure_like: false,
    blocked_like: false,
  };
}

export function emptyRelationshipTypeForm(): RelationshipTypeForm {
  return {
    key: '',
    label: '',
    inverse_label: '',
    category: 'dependency',
    direction_semantics: 'informational',
    affects_dispatch_eligibility: false,
    active_statuses_text: '',
    resolved_statuses_text: 'done, deployed',
    allow_create_related_task: false,
    default_related_task_type: '',
    default_related_task_status: '',
  };
}

export function relationshipTypeToForm(type: TaskRelationshipTypeConfig): RelationshipTypeForm {
  return {
    id: type.id,
    key: type.key,
    label: type.label,
    inverse_label: type.inverse_label,
    category: type.category,
    direction_semantics: type.direction_semantics,
    affects_dispatch_eligibility: type.affects_dispatch_eligibility === 1,
    active_statuses_text: (type.active_statuses ?? []).join(', '),
    resolved_statuses_text: (type.resolved_statuses ?? []).join(', '),
    allow_create_related_task: type.allow_create_related_task === 1,
    default_related_task_type: type.default_related_task_type ?? '',
    default_related_task_status: type.default_related_task_status ?? '',
  };
}

export function splitListInput(value: string): string[] {
  return value.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
}

export function fieldOptionsSummary(field: CustomFieldDefinition): string {
  const options = field.type === 'select' ? (field.options ?? []).filter(Boolean) : [];
  if (options.length > 0) return options.join(', ');
  return field.help_text?.trim() || 'No help text';
}
