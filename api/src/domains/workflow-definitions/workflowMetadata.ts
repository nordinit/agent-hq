import { resolveWorkflowOutcomeVocabulary, type WorkflowOutcomeDefinition } from './outcomes';
import { isRuntimeFailureOutcome } from '../../lib/outcomeCatalog';
import {
  listWorkflowTaskStatuses,
  listWorkflowTypeTaskStatuses,
  listWorkflowTaskTransitions,
} from '../routing/policy/statuses';
import { listExternalEventMappings } from '../routing/externalEventMappings';
import { listRelationshipTypesForWorkflowType, type TaskRelationshipTypeConfig } from '../tasks/relationships';
import { type Db } from "../../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../../db/introspection";

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
  workflow_id: number;
  workflow_type: string;
  status: string;
  status_label: string;
  task_types: string[];
  routing_rule_ids: number[];
  transition_task_types: string[];
  external_event_names: string[];
  message: string;
}

export interface ResolvedWorkflowMetadata {
  workflow_id: number | null;
  workflow_type: string;
  task_type: string | null;
  task_types: WorkflowTaskTypeMeta[];
  statuses: WorkflowStatusMeta[];
  transitions: WorkflowTransitionMeta[];
  outcomes: WorkflowOutcomeDefinition[];
  relationship_types: TaskRelationshipTypeConfig[];
  non_failure_outcomes: string[];
  routing_warnings: WorkflowRoutingWarning[];
}

interface WorkflowContext {
  workflowId: number | null;
  workflowType: string;
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

async function tableExists(db: Db, tableName: string): Promise<boolean> {
    return await sharedTableExists(db, tableName);
}

async function defaultWorkflowType(db: Db): Promise<string> {
  if (!await tableExists(db, 'workflow_types')) return 'generic';
  const preferred = await db.get(`
    SELECT key
    FROM workflow_types
    WHERE key IN ('dev', 'generic')
    ORDER BY CASE key WHEN 'dev' THEN 0 WHEN 'generic' THEN 1 ELSE 2 END
    LIMIT 1
  `) as { key?: string } | undefined;
  return normalizeKey(preferred?.key) ?? 'generic';
}

async function resolveContext(
  db: Db,
  input: { workflowId?: unknown; workflowType?: unknown; tenantId?: number | null },
): Promise<WorkflowContext> {
  const workflowId = Number(input.workflowId);
  if (Number.isFinite(workflowId) && workflowId > 0 && await tableExists(db, 'workflows')) {
    const tenantColumn = await sharedColumnExists(db, 'workflows', 'tenant_id');
    const tenantSql = tenantColumn && input.tenantId != null ? ' AND tenant_id = ?' : '';
    const tenantParams = tenantSql ? [input.tenantId] : [];
    const row = await db.get(`
      SELECT id, workflow_type
      FROM workflows
      WHERE id = ?
        ${tenantSql}
      LIMIT 1
    `, workflowId, ...tenantParams) as { id: number; workflow_type: string | null } | undefined;
    if (row) {
      return {
        workflowId: row.id,
        workflowType: normalizeKey(row.workflow_type) ?? (await defaultWorkflowType(db)),
      };
    }
  }

  return {
    workflowId: null,
    workflowType: normalizeKey(input.workflowType) ?? (await defaultWorkflowType(db)),
  };
}

async function loadTaskTypes(db: Db, workflowType: string, tenantId?: number | null): Promise<WorkflowTaskTypeMeta[]> {
  if (!await tableExists(db, 'workflow_type_task_types')) return [];
  const tenantColumn = await sharedColumnExists(db, 'workflow_type_task_types', 'tenant_id');
  const tenantSql = tenantColumn && tenantId != null ? ' AND tenant_id = ?' : '';
  const tenantParams = tenantSql ? [tenantId] : [];
  const rows = await db.all(`
    SELECT task_type, is_system
    FROM workflow_type_task_types
    WHERE workflow_type_key = ?
      ${tenantSql}
    ORDER BY task_type ASC
  `, workflowType, ...tenantParams) as Array<{ task_type: string | null; is_system: number | null }>;

  return rows
    .map(row => {
      const value = normalizeTaskType(row.task_type);
      return value ? { value, label: labelFromKey(value), is_system: Boolean(row.is_system) } : null;
    })
    .filter((value): value is WorkflowTaskTypeMeta => Boolean(value));
}

async function loadTransitions(db: Db, workflowId: number | null): Promise<WorkflowTransitionMeta[]> {
  if (!workflowId) return [];
  return (await listWorkflowTaskTransitions(db, workflowId)).map((transition, index) => ({
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

async function loadStatuses(db: Db, workflowId: number | null, workflowType: string, transitions: WorkflowTransitionMeta[], tenantId?: number | null): Promise<WorkflowStatusMeta[]> {
  const statuses = workflowId
    ? await listWorkflowTaskStatuses(db, workflowId)
    : await listWorkflowTypeTaskStatuses(db, workflowType, { tenantId });
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

async function loadRoutingWarnings(
  db: Db,
  workflowId: number | null,
  workflowType: string,
  statuses: WorkflowStatusMeta[],
): Promise<WorkflowRoutingWarning[]> {
  if (!workflowId) return [];

  const routingRules = await db.all(`
    SELECT id, task_type, status
    FROM workflow_task_routing_rules
    WHERE workflow_id = ?
    ORDER BY status ASC, task_type ASC, id ASC
  `, workflowId) as Array<{ id: number; task_type: string | null; status: string }>;

  if (routingRules.length === 0) return [];

  const transitionRows = (await listWorkflowTaskTransitions(db, workflowId))
    .filter((transition) => transition.enabled === 1);
  const externalMappings = (await listExternalEventMappings(db, {})).mappings.filter((mapping) => {
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
      workflow_id: workflowId,
      workflow_type: workflowType,
      status,
      status_label: statusLabels.get(status) ?? status,
      task_types: taskTypes,
      routing_rule_ids: rules.map((rule) => rule.id),
      transition_task_types: [],
      external_event_names: [],
      message: taskTypes.length > 0
        ? `Status \"${status}\" is dispatchable for ${taskTypes.join(', ')}, but this workflow has no configured workflow-event or outcome transitions from that status.`
        : `Status \"${status}\" is dispatchable, but this workflow has no configured workflow-event or outcome transitions from that status.`,
    });
  }

  return warnings.sort((left, right) => left.status.localeCompare(right.status));
}

export async function resolveWorkflowMetadata(
  db: Db,
  input: { workflowId?: unknown; workflowType?: unknown; taskType?: unknown; tenantId?: number | null } = {},
): Promise<ResolvedWorkflowMetadata> {
  const context = await resolveContext(db, input);
  const taskType = normalizeTaskType(input.taskType);
  const rawTransitions = await loadTransitions(db, context.workflowId);
  const rawStatuses = await loadStatuses(db, context.workflowId, context.workflowType, rawTransitions, input.tenantId);
  const transitions = effectiveTransitionsForStatuses(rawTransitions, rawStatuses);
  const statuses = statusesWithEffectiveTransitions(rawStatuses, transitions);
  const routingWarnings = await loadRoutingWarnings(db, context.workflowId, context.workflowType, statuses);
  const outcomes = await resolveWorkflowOutcomeVocabulary(db, {
      workflowId: context.workflowId,
      workflowType: context.workflowType,
      taskType,
      tenantId: input.tenantId,
    });
  const relationshipTypes = await listRelationshipTypesForWorkflowType(db, context.workflowType, input.tenantId);

  return {
    workflow_id: context.workflowId,
    workflow_type: context.workflowType,
    task_type: taskType,
    task_types: await loadTaskTypes(db, context.workflowType, input.tenantId),
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
