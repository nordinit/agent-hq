import type Database from 'better-sqlite3';
import { resolveSprintOutcomeVocabulary, type SprintOutcomeDefinition } from './outcomes';
import { isRuntimeFailureOutcome } from '../../lib/outcomeCatalog';
import {
  listSprintTaskStatuses,
  listSprintTypeTaskStatuses,
  listSprintTaskTransitions,
} from '../routing/policy/statuses';
import { listExternalEventMappings } from '../routing/externalEventMappings';
import { listRelationshipTypesForSprintType, type TaskRelationshipTypeConfig } from '../tasks/relationships';

export interface WorkflowTaskTypeMeta {
  value: string;
  label: string;
  is_system: boolean;
}

export interface WorkflowStatusMeta {
  name: string;
  label: string;
  emoji?: string | null;
  color: string;
  terminal: boolean;
  is_system: boolean;
  stage_order: number;
  is_default_entry: boolean;
  allowed_transitions: string[];
  metadata: Record<string, unknown>;
}

export interface WorkflowTransitionMeta {
  from_status: string;
  to_status: string;
  transition_key: string;
  label: string;
  outcome: string | null;
  stage_order: number;
  is_system: boolean;
  metadata: Record<string, unknown>;
}

export interface WorkflowRoutingWarning {
  kind: 'routed_status_missing_external_event_or_outcome_transitions';
  sprint_id: number;
  sprint_type: string;
  status: string;
  status_label: string;
  task_types: string[];
  routing_rule_ids: number[];
  transition_task_types: string[];
  external_event_names: string[];
  message: string;
}

export interface ResolvedWorkflowMetadata {
  sprint_id: number | null;
  sprint_type: string;
  task_type: string | null;
  task_types: WorkflowTaskTypeMeta[];
  statuses: WorkflowStatusMeta[];
  transitions: WorkflowTransitionMeta[];
  outcomes: SprintOutcomeDefinition[];
  relationship_types: TaskRelationshipTypeConfig[];
  non_failure_outcomes: string[];
  routing_warnings: WorkflowRoutingWarning[];
}

interface SprintContext {
  sprintId: number | null;
  sprintType: string;
}

function normalizeKey(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

function normalizeTaskType(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function labelFromKey(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase());
}

function tableExists(db: Database.Database, tableName: string): boolean {
  try {
    const row = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `).get(tableName) as { name?: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function defaultSprintType(db: Database.Database): string {
  if (!tableExists(db, 'sprint_types')) return 'generic';
  const preferred = db.prepare(`
    SELECT key
    FROM sprint_types
    WHERE key IN ('dev', 'generic')
    ORDER BY CASE key WHEN 'dev' THEN 0 WHEN 'generic' THEN 1 ELSE 2 END
    LIMIT 1
  `).get() as { key?: string } | undefined;
  return normalizeKey(preferred?.key) ?? 'generic';
}

function resolveContext(
  db: Database.Database,
  input: { sprintId?: unknown; sprintType?: unknown; tenantId?: number | null },
): SprintContext {
  const sprintId = Number(input.sprintId);
  if (Number.isFinite(sprintId) && sprintId > 0 && tableExists(db, 'sprints')) {
    const tenantColumn = tableExists(db, 'sprints') && db.prepare(`PRAGMA table_info(sprints)`).all()
      .some((row) => (row as { name: string }).name === 'tenant_id');
    const tenantSql = tenantColumn && input.tenantId != null ? ' AND tenant_id = ?' : '';
    const tenantParams = tenantSql ? [input.tenantId] : [];
    const row = db.prepare(`
      SELECT id, sprint_type
      FROM sprints
      WHERE id = ?
        ${tenantSql}
      LIMIT 1
    `).get(sprintId, ...tenantParams) as { id: number; sprint_type: string | null } | undefined;
    if (row) {
      return {
        sprintId: row.id,
        sprintType: normalizeKey(row.sprint_type) ?? defaultSprintType(db),
      };
    }
  }

  return {
    sprintId: null,
    sprintType: normalizeKey(input.sprintType) ?? defaultSprintType(db),
  };
}

function loadTaskTypes(db: Database.Database, sprintType: string, tenantId?: number | null): WorkflowTaskTypeMeta[] {
  if (!tableExists(db, 'sprint_type_task_types')) return [];
  const tenantColumn = db.prepare(`PRAGMA table_info(sprint_type_task_types)`).all()
    .some((row) => (row as { name: string }).name === 'tenant_id');
  const tenantSql = tenantColumn && tenantId != null ? ' AND tenant_id = ?' : '';
  const tenantParams = tenantSql ? [tenantId] : [];
  const rows = db.prepare(`
    SELECT task_type, is_system
    FROM sprint_type_task_types
    WHERE sprint_type_key = ?
      ${tenantSql}
    ORDER BY task_type ASC
  `).all(sprintType, ...tenantParams) as Array<{ task_type: string | null; is_system: number | null }>;

  return rows
    .map(row => {
      const value = normalizeTaskType(row.task_type);
      return value ? { value, label: labelFromKey(value), is_system: Boolean(row.is_system) } : null;
    })
    .filter((value): value is WorkflowTaskTypeMeta => Boolean(value));
}

function loadTransitions(db: Database.Database, sprintId: number | null): WorkflowTransitionMeta[] {
  if (!sprintId) return [];
  return listSprintTaskTransitions(db, sprintId).map((transition, index) => ({
    from_status: transition.from_status,
    to_status: transition.to_status,
    transition_key: `${transition.from_status}-${transition.outcome}-${transition.to_status}`,
    label: labelFromKey(transition.outcome),
    outcome: normalizeTaskType(transition.outcome),
    stage_order: index,
    is_system: Boolean(transition.is_protected),
    metadata: {
      enabled: Boolean(transition.enabled),
      priority: transition.priority,
      task_type: transition.task_type,
      transition_id: transition.id,
    },
  }));
}

function effectiveTransitionsForStatuses(
  transitions: WorkflowTransitionMeta[],
  statuses: WorkflowStatusMeta[],
): WorkflowTransitionMeta[] {
  const effectiveStatusNames = new Set(statuses.map(status => status.name));
  return transitions.filter((transition) => {
    if (transition.metadata.enabled === false) return false;
    return effectiveStatusNames.has(transition.from_status) && effectiveStatusNames.has(transition.to_status);
  });
}

function statusesWithEffectiveTransitions(
  statuses: WorkflowStatusMeta[],
  transitions: WorkflowTransitionMeta[],
): WorkflowStatusMeta[] {
  const effectiveStatusNames = new Set(statuses.map(status => status.name));
  const allowedByStatus = new Map<string, Set<string>>();
  for (const transition of transitions) {
    if (!allowedByStatus.has(transition.from_status)) allowedByStatus.set(transition.from_status, new Set());
    allowedByStatus.get(transition.from_status)!.add(transition.to_status);
  }

  return statuses.map(status => ({
    ...status,
    allowed_transitions: allowedByStatus.has(status.name)
      ? [...allowedByStatus.get(status.name)!]
      : status.allowed_transitions.filter(target => effectiveStatusNames.has(target)),
  }));
}

function loadStatuses(db: Database.Database, sprintId: number | null, sprintType: string, transitions: WorkflowTransitionMeta[], tenantId?: number | null): WorkflowStatusMeta[] {
  const statuses = sprintId
    ? listSprintTaskStatuses(db, sprintId)
    : listSprintTypeTaskStatuses(db, sprintType, { tenantId });
  const allowedByStatus = new Map<string, Set<string>>();
  for (const transition of transitions) {
    if (transition.metadata.enabled === false) continue;
    if (!allowedByStatus.has(transition.from_status)) allowedByStatus.set(transition.from_status, new Set());
    allowedByStatus.get(transition.from_status)!.add(transition.to_status);
  }

  return statuses.map((status, index) => ({
    name: status.name,
    label: status.label,
    emoji: status.emoji ?? null,
    color: status.color,
    terminal: status.terminal,
    is_system: status.is_system,
    stage_order: Number.isFinite(Number(status.stage_order)) ? Number(status.stage_order) : index,
    is_default_entry: Boolean(status.is_default_entry) || index === 0,
    allowed_transitions: [...(allowedByStatus.get(status.name) ?? new Set(status.allowed_transitions))],
    metadata: status.metadata ?? {},
  })).sort((left, right) => left.stage_order - right.stage_order);
}

function loadRoutingWarnings(
  db: Database.Database,
  sprintId: number | null,
  sprintType: string,
  statuses: WorkflowStatusMeta[],
): WorkflowRoutingWarning[] {
  if (!sprintId) return [];

  const routingRules = db.prepare(`
    SELECT id, task_type, status
    FROM sprint_task_routing_rules
    WHERE sprint_id = ?
    ORDER BY status ASC, task_type ASC, id ASC
  `).all(sprintId) as Array<{ id: number; task_type: string | null; status: string }>;

  if (routingRules.length === 0) return [];

  const transitionRows = listSprintTaskTransitions(db, sprintId)
    .filter((transition) => transition.enabled === 1);
  const externalMappings = listExternalEventMappings(db, {}).mappings.filter((mapping) => {
    if (mapping.enabled !== 1) return false;
    if (mapping.action_kind === 'ignore') return false;
    if (mapping.project_id !== null) return false;
    return true;
  });

  const externalEventsByStatus = new Map<string, Set<string>>();
  for (const status of statuses) {
    if (status.name === 'needs_attention') continue;
    for (const mapping of externalMappings) {
      const included = mapping.status_includes.length === 0 || mapping.status_includes.includes(status.name);
      if (!included) continue;
      if (mapping.status_excludes.includes(status.name)) continue;
      if (!externalEventsByStatus.has(status.name)) externalEventsByStatus.set(status.name, new Set());
      externalEventsByStatus.get(status.name)!.add(mapping.event_name);
    }
  }

  const statusLabels = new Map(statuses.map((status) => [status.name, status.label || status.name]));
  const effectiveStatusNames = new Set(statuses.map((status) => status.name));
  const routableByStatus = new Map<string, Array<{ id: number; task_type: string | null }>>();
  for (const rule of routingRules) {
    if (!effectiveStatusNames.has(rule.status) && rule.status !== 'needs_attention') continue;
    if (!routableByStatus.has(rule.status)) routableByStatus.set(rule.status, []);
    routableByStatus.get(rule.status)!.push({ id: rule.id, task_type: rule.task_type });
  }

  const transitionsByStatus = new Map<string, Set<string>>();
  for (const transition of transitionRows) {
    if (!transitionsByStatus.has(transition.from_status)) transitionsByStatus.set(transition.from_status, new Set());
    transitionsByStatus.get(transition.from_status)!.add(transition.task_type ?? '*');
  }

  const warnings: WorkflowRoutingWarning[] = [];
  for (const [status, rules] of routableByStatus.entries()) {
    const configuredTransitionTaskTypes = transitionsByStatus.get(status);
    const configuredExternalEvents = externalEventsByStatus.get(status);
    if ((configuredTransitionTaskTypes && configuredTransitionTaskTypes.size > 0) || (configuredExternalEvents && configuredExternalEvents.size > 0)) continue;

    const taskTypes = Array.from(new Set(rules.map((rule) => rule.task_type).filter((value): value is string => Boolean(value)))).sort();
    warnings.push({
      kind: 'routed_status_missing_external_event_or_outcome_transitions',
      sprint_id: sprintId,
      sprint_type: sprintType,
      status,
      status_label: statusLabels.get(status) ?? status,
      task_types: taskTypes,
      routing_rule_ids: rules.map((rule) => rule.id),
      transition_task_types: [],
      external_event_names: [],
      message: taskTypes.length > 0
        ? `Status \"${status}\" is dispatchable for ${taskTypes.join(', ')}, but this sprint has no configured workflow-event or outcome transitions from that status.`
        : `Status \"${status}\" is dispatchable, but this sprint has no configured workflow-event or outcome transitions from that status.`,
    });
  }

  return warnings.sort((left, right) => left.status.localeCompare(right.status));
}

export function resolveWorkflowMetadata(
  db: Database.Database,
  input: { sprintId?: unknown; sprintType?: unknown; taskType?: unknown; tenantId?: number | null } = {},
): ResolvedWorkflowMetadata {
  const context = resolveContext(db, input);
  const taskType = normalizeTaskType(input.taskType);
  const rawTransitions = loadTransitions(db, context.sprintId);
  const rawStatuses = loadStatuses(db, context.sprintId, context.sprintType, rawTransitions, input.tenantId);
  const transitions = effectiveTransitionsForStatuses(rawTransitions, rawStatuses);
  const statuses = statusesWithEffectiveTransitions(rawStatuses, transitions);
  const routingWarnings = loadRoutingWarnings(db, context.sprintId, context.sprintType, statuses);
  const outcomes = resolveSprintOutcomeVocabulary(db, {
    sprintId: context.sprintId,
    sprintType: context.sprintType,
    taskType,
    tenantId: input.tenantId,
  });
  const relationshipTypes = listRelationshipTypesForSprintType(db, context.sprintType, input.tenantId);

  return {
    sprint_id: context.sprintId,
    sprint_type: context.sprintType,
    task_type: taskType,
    task_types: loadTaskTypes(db, context.sprintType, input.tenantId),
    statuses,
    transitions,
    outcomes,
    relationship_types: relationshipTypes,
    non_failure_outcomes: outcomes
      .filter(outcome => outcome.outcome_key !== 'failed' && outcome.outcome_key !== 'infra_failed' && !isRuntimeFailureOutcome(outcome.outcome_key))
      .map(outcome => outcome.outcome_key),
    routing_warnings: routingWarnings,
  };
}
