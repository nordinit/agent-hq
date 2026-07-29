import { STARTER_SPRINT_OUTCOME_SEEDS } from '../../lib/starterCatalog';
import { isValidTaskType } from '../../lib/taskTypes';
import { RUNTIME_FAILED_OUTCOME } from '../../lib/outcomeCatalog';
import { WORKFLOW_EVENT_ACTION_KINDS } from '../../lib/workflowVocabulary';
import { listSprintTaskStatuses, listSprintTypeTaskStatuses } from './policy';
import { type Db } from "../../db/adapter/types";

export const AGENT_HQ_RUNTIME_SOURCE = 'agent_hq_runtime';
export const AGENT_HQ_DISPATCHER_SOURCE = 'agent_hq_dispatcher';
export const DEV_ENV_LEASE_MANAGER_SOURCE = 'dev_environment_lease_manager';
export const RUNTIME_FAILED_EVENT = 'runtime_failed';
export const MISSING_OUTCOME_WORKFLOW_EVENTS = ['no_semantic_handoff_posted', 'missing_outcome', 'unknown_outcome'] as const;
export const PRIMARY_MISSING_OUTCOME_WORKFLOW_EVENT = MISSING_OUTCOME_WORKFLOW_EVENTS[0];
export const DISPATCH_STARTUP_FAILED_EVENT = 'dispatch_startup_failed';

export type WorkflowEventSourceKind = 'agent_hq_internal' | 'external_integration' | 'wildcard_compatibility';

function describeWorkflowEventSource(source: string | null): { event_model: 'workflow_event'; source_kind: WorkflowEventSourceKind; source_label: string } {
  if (source === AGENT_HQ_RUNTIME_SOURCE) {
    return { event_model: 'workflow_event', source_kind: 'agent_hq_internal', source_label: 'Agent HQ runtime' };
  }
  if (source === AGENT_HQ_DISPATCHER_SOURCE) {
    return { event_model: 'workflow_event', source_kind: 'agent_hq_internal', source_label: 'Agent HQ dispatcher' };
  }
  if (source === DEV_ENV_LEASE_MANAGER_SOURCE) {
    return { event_model: 'workflow_event', source_kind: 'external_integration', source_label: 'Dev Environment Lease Manager' };
  }
  if (!source) {
    return { event_model: 'workflow_event', source_kind: 'wildcard_compatibility', source_label: 'Any workflow event source' };
  }
  return { event_model: 'workflow_event', source_kind: 'external_integration', source_label: source };
}

export const DEV_ENV_DEPLOY_FAILURE_EVENTS = [
  'database_backup_failed',
  'database_migration_failed',
  'database_integrity_failed',
  'api_boot_failed',
  'api_health_failed',
  'ui_health_failed',
  'process_restart_failed',
  'checkout_failed',
  'build_failed',
] as const;

type StatusError = Error & { status?: number };

type MappingRecord = {
  id: number;
  tenant_id?: number | null;
  project_id: number | null;
  sprint_id?: number | null;
  sprint_type?: string | null;
  source: string | null;
  event_name: string;
  task_type: string | null;
  status_includes_json: string;
  status_excludes_json: string;
  action_kind: 'ignore' | 'outcome' | 'status';
  action_target: string | null;
  apply_review_evidence: number;
  apply_failure_detail: number;
  enabled: number;
  priority: number;
  created_at?: string;
  updated_at?: string;
};

export type WorkflowEventMapping = Omit<MappingRecord, 'status_includes_json' | 'status_excludes_json'> & {
  status_includes: string[];
  status_excludes: string[];
  conflicts_with: number[];
  scope_kind: 'sprint_type_default' | 'sprint_override';
  is_inherited: boolean;
  is_override: boolean;
  event_model: 'workflow_event';
  source_kind: WorkflowEventSourceKind;
  source_label: string;
};

export type ExternalEventMapping = WorkflowEventMapping;

export type WorkflowEventContext = {
  source: string;
  eventName: string;
  tenantId?: number | null;
  projectId: number | null;
  sprintId?: number | null;
  sprintType?: string | null;
  taskType: string | null;
  currentStatus: string;
};

export type ExternalEventContext = WorkflowEventContext;

const DEFAULT_DEPLOY_FAILURE_EVENT_MAPPINGS = DEV_ENV_DEPLOY_FAILURE_EVENTS.map((eventName) => ({
  source: DEV_ENV_LEASE_MANAGER_SOURCE,
  event_name: eventName,
  status_includes: [],
  status_excludes: ['stalled', 'failed', 'done', 'cancelled'],
  action_kind: 'outcome',
  action_target: 'env_blocked',
  apply_review_evidence: 0,
  apply_failure_detail: 1,
  enabled: 1,
  priority: 110,
}));

export const DEFAULT_WORKFLOW_EVENT_MAPPINGS = [
  {
    source: AGENT_HQ_RUNTIME_SOURCE,
    event_name: 'agent_started',
    status_includes: [],
    status_excludes: ['in_progress', 'blocked', 'review', 'qa_pass', 'ready_to_merge', 'deployed', 'done', 'cancelled', 'failed'],
    action_kind: 'status',
    action_target: 'in_progress',
    apply_review_evidence: 0,
    apply_failure_detail: 0,
    enabled: 1,
    priority: 100,
  },
  {
    source: AGENT_HQ_RUNTIME_SOURCE,
    event_name: RUNTIME_FAILED_EVENT,
    status_includes: [],
    status_excludes: ['failed', 'done', 'cancelled'],
    action_kind: 'outcome',
    action_target: RUNTIME_FAILED_OUTCOME,
    apply_review_evidence: 0,
    apply_failure_detail: 1,
    enabled: 1,
    priority: 100,
  },
  ...MISSING_OUTCOME_WORKFLOW_EVENTS.map((eventName) => ({
    source: AGENT_HQ_RUNTIME_SOURCE,
    event_name: eventName,
    status_includes: [],
    status_excludes: [],
    action_kind: 'ignore',
    action_target: null,
    apply_review_evidence: 0,
    apply_failure_detail: 0,
    enabled: 1,
    priority: 100,
  })),
  {
    source: AGENT_HQ_DISPATCHER_SOURCE,
    event_name: DISPATCH_STARTUP_FAILED_EVENT,
    status_includes: [],
    status_excludes: ['stalled', 'failed', 'done', 'cancelled'],
    action_kind: 'status',
    action_target: 'stalled',
    apply_review_evidence: 0,
    apply_failure_detail: 1,
    enabled: 1,
    priority: 100,
  },
  {
    source: DEV_ENV_LEASE_MANAGER_SOURCE,
    event_name: 'dev_deploy_queued',
    status_includes: [],
    status_excludes: ['review', 'qa_pass', 'ready_to_merge', 'deployed', 'done', 'cancelled', 'failed'],
    action_kind: 'status',
    action_target: 'dev_deploy_queued',
    apply_review_evidence: 0,
    apply_failure_detail: 0,
    enabled: 1,
    priority: 100,
  },
  {
    source: DEV_ENV_LEASE_MANAGER_SOURCE,
    event_name: 'dev_deploying',
    status_includes: [],
    status_excludes: ['review', 'qa_pass', 'ready_to_merge', 'deployed', 'done', 'cancelled', 'failed'],
    action_kind: 'status',
    action_target: 'dev_deploying',
    apply_review_evidence: 0,
    apply_failure_detail: 0,
    enabled: 1,
    priority: 100,
  },
  {
    source: DEV_ENV_LEASE_MANAGER_SOURCE,
    event_name: 'deployed_for_qa',
    status_includes: [],
    status_excludes: ['review', 'qa_pass', 'ready_to_merge', 'deployed', 'done', 'cancelled', 'failed'],
    action_kind: 'outcome',
    action_target: 'completed_for_review',
    apply_review_evidence: 1,
    apply_failure_detail: 0,
    enabled: 1,
    priority: 100,
  },
  {
    source: DEV_ENV_LEASE_MANAGER_SOURCE,
    event_name: 'deploy_failed',
    status_includes: [],
    status_excludes: ['stalled', 'failed', 'done', 'cancelled'],
    action_kind: 'outcome',
    action_target: 'env_blocked',
    apply_review_evidence: 0,
    apply_failure_detail: 1,
    enabled: 1,
    priority: 100,
  },
  ...DEFAULT_DEPLOY_FAILURE_EVENT_MAPPINGS,
  {
    source: DEV_ENV_LEASE_MANAGER_SOURCE,
    event_name: 'cancelled',
    status_includes: [],
    status_excludes: [],
    action_kind: 'ignore',
    action_target: null,
    apply_review_evidence: 0,
    apply_failure_detail: 0,
    enabled: 1,
    priority: 100,
  },
  {
    source: DEV_ENV_LEASE_MANAGER_SOURCE,
    event_name: 'superseded',
    status_includes: [],
    status_excludes: [],
    action_kind: 'ignore',
    action_target: null,
    apply_review_evidence: 0,
    apply_failure_detail: 0,
    enabled: 1,
    priority: 100,
  },
] as const;

export const DEFAULT_TENANT_WORKFLOW_EVENT_SOURCES = [
  AGENT_HQ_RUNTIME_SOURCE,
  AGENT_HQ_DISPATCHER_SOURCE,
] as const;

export const DEFAULT_TENANT_WORKFLOW_EVENT_MAPPINGS = DEFAULT_WORKFLOW_EVENT_MAPPINGS.filter((mapping) => (
  DEFAULT_TENANT_WORKFLOW_EVENT_SOURCES.includes(mapping.source as typeof DEFAULT_TENANT_WORKFLOW_EVENT_SOURCES[number])
));

async function tableHasColumn(db: Db, tableName: string, columnName: string): Promise<boolean> {
  try {
    return (await db.all(`PRAGMA table_info(${tableName})`) as Array<{ name: string }>).some((column) => column.name === columnName);
  } catch {
    return false;
  }
}

function parseJsonStringList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(item => String(item).trim()).filter(Boolean);
  } catch {
    return [];
  }
}


async function migrateAgentStartedWorkflowEventSource(db: Db): Promise<void> {
  const wildcardRows = await db.all(`
    SELECT id
    FROM external_event_mappings
    WHERE event_name = 'agent_started'
      AND source IS NULL
      AND action_kind = 'status'
      AND action_target = 'in_progress'
  `) as Array<{ id: number }>;
  if (wildcardRows.length === 0) return;

  const explicit = await db.get(`
    SELECT id
    FROM external_event_mappings
    WHERE event_name = 'agent_started'
      AND source = ?
      AND action_kind = 'status'
      AND action_target = 'in_progress'
    LIMIT 1
  `, AGENT_HQ_RUNTIME_SOURCE) as { id: number } | undefined;
  if (explicit) return;

  await db.run(`
    UPDATE external_event_mappings
    SET source = ?, updated_at = datetime('now')
    WHERE id = ?
  `, AGENT_HQ_RUNTIME_SOURCE, wildcardRows[0].id);
}

async function ensureAgentStartedBlockedGuard(db: Db): Promise<void> {
  const rows = await db.all(`
    SELECT id, status_excludes_json
    FROM external_event_mappings
    WHERE event_name = 'agent_started'
      AND action_kind = 'status'
      AND action_target = 'in_progress'
      AND enabled = 1
  `) as Array<{ id: number; status_excludes_json: string | null }>;

  const updateSql = `
    UPDATE external_event_mappings
    SET status_excludes_json = ?, updated_at = datetime('now')
    WHERE id = ?
  `;

  for (const row of rows) {
    const excludes = parseJsonStringList(row.status_excludes_json);
    if (excludes.includes('blocked')) continue;
    await db.run(updateSql, JSON.stringify([...excludes, 'blocked']), row.id);
  }
}

function withStatus(message: string, status: number): StatusError {
  const err = new Error(message) as StatusError;
  err.status = status;
  return err;
}

function parseOptionalProjectId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw withStatus('project_id must be a positive integer', 400);
  return parsed;
}

function parseOptionalTenantId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw withStatus('tenant_id must be a positive integer', 400);
  return parsed;
}

function parseId(value: unknown, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw withStatus(`${fieldName} must be a positive integer`, 400);
  return parsed;
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw withStatus('Expected string value', 400);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw withStatus(`${fieldName} is required`, 400);
  return normalized;
}

function normalizeBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  throw withStatus('Boolean field must be true or false', 400);
}

function normalizeInteger(value: unknown, fieldName: string, defaultValue: number): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw withStatus(`${fieldName} must be an integer`, 400);
  return parsed;
}

function normalizeStatusList(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : null;
  if (!raw) throw withStatus(`${fieldName} must be an array of status keys`, 400);
  const normalized = raw.map((entry) => {
    if (typeof entry !== 'string') throw withStatus(`${fieldName} must contain only strings`, 400);
    return entry.trim();
  }).filter(Boolean);
  return [...new Set(normalized)];
}

function parseOptionalSprintId(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw withStatus('sprint_id must be a positive integer', 400);
  return parsed;
}

function normalizeOptionalSprintType(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw withStatus('sprint_type must be a string', 400);
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function parseStatusListJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : [];
  } catch {
    return [];
  }
}

async function listKnownStatusKeys(db: Db): Promise<Set<string>> {
  const keys = new Set((await listSprintTaskStatuses(db)).map((status) => status.name));

  try {
    const sprintRows = await db.all(`SELECT DISTINCT status_key FROM sprint_task_statuses`) as Array<{ status_key: string }>;
    for (const row of sprintRows) {
      if (typeof row.status_key === 'string' && row.status_key.trim()) keys.add(row.status_key);
    }
  } catch {
    // table may be absent in isolated tests
  }

  try {
    const sprintTypeRows = await db.all(`SELECT DISTINCT status_key FROM sprint_type_task_statuses`) as Array<{ status_key: string }>;
    for (const row of sprintTypeRows) {
      if (typeof row.status_key === 'string' && row.status_key.trim()) keys.add(row.status_key);
    }
  } catch {
    // table may be absent in isolated tests
  }

  return keys;
}

async function listWorkflowContextStatusKeys(
  db: Db,
  context: { sprintId: number | null; sprintType: string | null; tenantId: number | null },
): Promise<Set<string> | null> {
  if (context.sprintId) {
    if (context.tenantId != null && await tableHasColumn(db, 'sprints', 'tenant_id')) {
      const sprint = await db.get(`SELECT id FROM sprints WHERE id = ? AND tenant_id = ? LIMIT 1`, context.sprintId, context.tenantId) as { id: number } | undefined;
      if (!sprint) return new Set();
    }
    return new Set((await listSprintTaskStatuses(db, context.sprintId)).map((status) => status.name));
  }
  if (context.sprintType) {
    return new Set((await listSprintTypeTaskStatuses(db, context.sprintType, { tenantId: context.tenantId })).map((status) => status.name));
  }
  return null;
}

async function listKnownOutcomeKeys(db: Db): Promise<Set<string>> {
  const keys = new Set<string>([RUNTIME_FAILED_OUTCOME]);
  for (const seed of STARTER_SPRINT_OUTCOME_SEEDS) {
    for (const outcome of seed.outcomes) {
      if ((outcome.enabled ?? 1) === 1 && outcome.behavior !== 'disable') {
        keys.add(outcome.outcome_key);
      }
    }
  }

  try {
    const rows = await db.all(`
      SELECT DISTINCT outcome_key, enabled, behavior
      FROM sprint_type_outcomes
    `) as Array<{ outcome_key: string; enabled: number; behavior: string | null }>;
    for (const row of rows) {
      if (row.enabled === 1 && row.behavior !== 'disable') keys.add(row.outcome_key);
    }
  } catch {
    // sprint_type_outcomes is not available in every test/runtime path.
  }

  return keys;
}

async function validateProjectExists(db: Db, projectId: number | null): Promise<void> {
  if (!projectId) return;
  const exists = await db.get('SELECT id FROM projects WHERE id = ?', projectId) as { id: number } | undefined;
  if (!exists) throw withStatus(`Project ${projectId} not found`, 404);
}

async function validateTenantExists(db: Db, tenantId: number | null): Promise<void> {
  if (!tenantId || !await tableHasColumn(db, 'external_event_mappings', 'tenant_id')) return;
  const exists = await db.get('SELECT id FROM tenants WHERE id = ?', tenantId) as { id: number } | undefined;
  if (!exists) throw withStatus(`Tenant ${tenantId} not found`, 404);
}

async function resolveTenantIdForProject(db: Db, projectId: number | null): Promise<number | null> {
  if (!projectId || !await tableHasColumn(db, 'projects', 'tenant_id')) return null;
  return (await db.get('SELECT tenant_id FROM projects WHERE id = ?', projectId) as { tenant_id?: number | null } | undefined)?.tenant_id ?? null;
}

async function resolveWorkflowEventScope(
  db: Db,
  input: Record<string, unknown>,
  existing?: MappingRecord | null,
): Promise<{ projectId: number | null; sprintId: number | null; sprintType: string | null; tenantId: number | null }> {
  const inputProjectId = input.project_id !== undefined ? parseOptionalProjectId(input.project_id) : existing?.project_id ?? null;
  const inputSprintId = input.sprint_id !== undefined || input.workflow_id !== undefined
    ? parseOptionalSprintId(input.sprint_id ?? input.workflow_id)
    : existing?.sprint_id ?? null;
  const inputSprintType = input.sprint_type !== undefined || input.workflow_type !== undefined
    ? normalizeOptionalSprintType(input.sprint_type ?? input.workflow_type)
    : existing?.sprint_type ?? null;
  const inputTenantId = input.tenant_id !== undefined
    ? parseOptionalTenantId(input.tenant_id)
    : existing?.tenant_id ?? (await resolveTenantIdForProject(db, inputProjectId));

  if (inputSprintId != null) {
    const hasTenantId = await tableHasColumn(db, 'sprints', 'tenant_id');
    const sprint = await db.get(`
      SELECT id, project_id, sprint_type${hasTenantId ? ', tenant_id' : ''}
      FROM sprints
      WHERE id = ?${hasTenantId && inputTenantId != null ? ' AND tenant_id = ?' : ''}
      LIMIT 1
    `, ...(hasTenantId && inputTenantId != null ? [inputSprintId, inputTenantId] : [inputSprintId])) as {
      id: number;
      project_id: number | null;
      sprint_type: string | null;
      tenant_id?: number | null;
    } | undefined;
    if (!sprint) throw withStatus(`Workflow ${inputSprintId} not found`, 404);
    if (inputProjectId != null && sprint.project_id !== inputProjectId) {
      throw withStatus(`Workflow ${inputSprintId} belongs to project ${sprint.project_id}, not project ${inputProjectId}`, 400);
    }
    if (inputSprintType && sprint.sprint_type !== inputSprintType) {
      throw withStatus(`Workflow ${inputSprintId} uses workflow_type ${sprint.sprint_type}, not ${inputSprintType}`, 400);
    }
    return {
      projectId: sprint.project_id ?? inputProjectId,
      sprintId: inputSprintId,
      sprintType: sprint.sprint_type ?? inputSprintType,
      tenantId: inputTenantId ?? sprint.tenant_id ?? null,
    };
  }

  await validateProjectExists(db, inputProjectId);
  return {
    projectId: inputProjectId,
    sprintId: null,
    sprintType: inputSprintType,
    tenantId: inputTenantId,
  };
}

async function ensureMappingVisibleToTenant(db: Db, row: MappingRecord, tenantId: number | null): Promise<void> {
  if (tenantId == null || !await tableHasColumn(db, 'external_event_mappings', 'tenant_id')) return;
  if (row.tenant_id === tenantId) return;
  throw withStatus('Workflow event mapping not found', 404);
}

function serializeMappingRow(row: MappingRecord, conflictsWith: number[] = [], selectedSprintId: number | null = null): WorkflowEventMapping {
  const rowSprintId = row.sprint_id == null ? null : Number(row.sprint_id);
  const scopeKind = rowSprintId == null ? 'sprint_type_default' : 'sprint_override';
  return {
    ...row,
    status_includes: parseStatusListJson(row.status_includes_json),
    status_excludes: parseStatusListJson(row.status_excludes_json),
    conflicts_with: conflictsWith,
    scope_kind: scopeKind,
    is_inherited: scopeKind === 'sprint_type_default',
    is_override: selectedSprintId != null && rowSprintId === selectedSprintId,
    ...describeWorkflowEventSource(row.source),
  };
}

function statusesOverlap(leftIncludes: string[], leftExcludes: string[], rightIncludes: string[], rightExcludes: string[]): boolean {
  const leftIncludeSet = new Set(leftIncludes);
  const rightIncludeSet = new Set(rightIncludes);
  const leftExcludeSet = new Set(leftExcludes);
  const rightExcludeSet = new Set(rightExcludes);

  if (leftIncludes.length > 0 && rightIncludes.length > 0) {
    for (const status of leftIncludeSet) {
      if (!rightIncludeSet.has(status)) continue;
      if (leftExcludeSet.has(status) || rightExcludeSet.has(status)) continue;
      return true;
    }
    return false;
  }

  if (leftIncludes.length > 0) {
    return leftIncludes.some((status) => !leftExcludeSet.has(status) && !rightExcludeSet.has(status));
  }

  if (rightIncludes.length > 0) {
    return rightIncludes.some((status) => !leftExcludeSet.has(status) && !rightExcludeSet.has(status));
  }

  return true;
}

function buildConflictMap(rows: MappingRecord[]): Map<number, number[]> {
  const conflictMap = new Map<number, number[]>();
  for (const row of rows) conflictMap.set(row.id, []);

  for (let index = 0; index < rows.length; index += 1) {
    const left = rows[index];
    if (!left.enabled) continue;
    const leftIncludes = parseStatusListJson(left.status_includes_json);
    const leftExcludes = parseStatusListJson(left.status_excludes_json);

    for (let offset = index + 1; offset < rows.length; offset += 1) {
      const right = rows[offset];
      if (!right.enabled) continue;
      if (left.priority !== right.priority) continue;
      if ((left.project_id ?? null) !== (right.project_id ?? null)) continue;
      if ((left.sprint_id ?? null) !== (right.sprint_id ?? null)) continue;
      if ((left.sprint_type ?? null) !== (right.sprint_type ?? null)) continue;
      if ((left.source ?? null) !== (right.source ?? null)) continue;
      if (left.event_name !== right.event_name) continue;
      if ((left.task_type ?? null) !== (right.task_type ?? null)) continue;

      const rightIncludes = parseStatusListJson(right.status_includes_json);
      const rightExcludes = parseStatusListJson(right.status_excludes_json);
      if (!statusesOverlap(leftIncludes, leftExcludes, rightIncludes, rightExcludes)) continue;

      conflictMap.get(left.id)?.push(right.id);
      conflictMap.get(right.id)?.push(left.id);
    }
  }

  return conflictMap;
}

async function ensureNoConflicts(db: Db, candidate: {
  id?: number;
  tenant_id?: number | null;
  project_id: number | null;
  sprint_id?: number | null;
  sprint_type?: string | null;
  source: string | null;
  event_name: string;
  task_type: string | null;
  status_includes: string[];
  status_excludes: string[];
  enabled: boolean;
  priority: number;
}): Promise<void> {
  if (!candidate.enabled) return;
  const hasTenantId = await tableHasColumn(db, 'external_event_mappings', 'tenant_id');
  const hasWorkflowScope = await tableHasColumn(db, 'external_event_mappings', 'sprint_id')
    && await tableHasColumn(db, 'external_event_mappings', 'sprint_type');
  const rows = await db.all(`
    SELECT *
    FROM external_event_mappings
    WHERE event_name = ?
      ${hasTenantId ? 'AND ((tenant_id IS NULL AND ? IS NULL) OR tenant_id = ?)' : ''}
      AND ((project_id IS NULL AND ? IS NULL) OR project_id = ?)
      ${hasWorkflowScope ? 'AND ((sprint_id IS NULL AND ? IS NULL) OR sprint_id = ?)' : ''}
      ${hasWorkflowScope ? 'AND ((sprint_type IS NULL AND ? IS NULL) OR sprint_type = ?)' : ''}
      AND ((source IS NULL AND ? IS NULL) OR source = ?)
      AND ((task_type IS NULL AND ? IS NULL) OR task_type = ?)
      AND priority = ?
      AND enabled = 1
      ${candidate.id ? 'AND id != ?' : ''}
  `, candidate.event_name, ...(hasTenantId ? [candidate.tenant_id ?? null, candidate.tenant_id ?? null] : []), candidate.project_id, candidate.project_id, ...(hasWorkflowScope ? [candidate.sprint_id ?? null, candidate.sprint_id ?? null] : []), ...(hasWorkflowScope ? [candidate.sprint_type ?? null, candidate.sprint_type ?? null] : []), candidate.source, candidate.source, candidate.task_type, candidate.task_type, candidate.priority, ...(candidate.id ? [candidate.id] : [])) as MappingRecord[];

  for (const row of rows) {
    if (statusesOverlap(
      candidate.status_includes,
      candidate.status_excludes,
      parseStatusListJson(row.status_includes_json),
      parseStatusListJson(row.status_excludes_json),
    )) {
      throw withStatus(
        `Conflicting enabled mapping already exists at priority ${candidate.priority} for source=${candidate.source ?? '*'} event=${candidate.event_name} (mapping #${row.id})`,
        409,
      );
    }
  }
}

function normalizeActionKind(value: unknown): 'ignore' | 'outcome' | 'status' {
  const normalized = normalizeRequiredString(value ?? 'ignore', 'action_kind');
  if ((WORKFLOW_EVENT_ACTION_KINDS as readonly string[]).includes(normalized)) {
    return normalized as 'ignore' | 'outcome' | 'status';
  }
  throw withStatus(`action_kind must be one of: ${WORKFLOW_EVENT_ACTION_KINDS.join(', ')}`, 400);
}

async function normalizePayload(db: Db, input: Record<string, unknown>, existing?: MappingRecord | null) {
  const { projectId, sprintId, sprintType, tenantId } = await resolveWorkflowEventScope(db, input, existing);
  await validateTenantExists(db, tenantId);

  const source = input.source !== undefined
    ? normalizeOptionalString(input.source)
    : existing?.source ?? null;
  const eventName = input.event_name !== undefined || input.event !== undefined
    ? normalizeRequiredString(input.event_name ?? input.event, 'event_name')
    : existing?.event_name;
  if (!eventName) throw withStatus('event_name is required', 400);

  const taskType = input.task_type !== undefined
    ? normalizeOptionalString(input.task_type)
    : existing?.task_type ?? null;
  if (taskType && !isValidTaskType(taskType)) {
    throw withStatus(`Invalid task_type "${taskType}". Task type keys must use lowercase letters, numbers, underscores, or hyphens.`, 400);
  }

  const statusIncludes = input.status_includes !== undefined
    ? normalizeStatusList(input.status_includes, 'status_includes')
    : parseStatusListJson(existing?.status_includes_json);
  const statusExcludes = input.status_excludes !== undefined
    ? normalizeStatusList(input.status_excludes, 'status_excludes')
    : parseStatusListJson(existing?.status_excludes_json);

  const contextualStatusKeys = await listWorkflowContextStatusKeys(db, { sprintId, sprintType, tenantId });
  const validStatusKeys = contextualStatusKeys ?? (await listKnownStatusKeys(db));
  const invalidGuardStatus = [...statusIncludes, ...statusExcludes].find((status) => !validStatusKeys.has(status));
  if (invalidGuardStatus) {
    throw withStatus(
      contextualStatusKeys
        ? `Status guard "${invalidGuardStatus}" is not valid for the selected workflow context`
        : `Unknown status guard "${invalidGuardStatus}"`,
      400,
    );
  }

  const overlap = statusIncludes.find((status) => statusExcludes.includes(status));
  if (overlap) throw withStatus(`status_includes and status_excludes both contain "${overlap}"`, 400);

  const actionKind = input.action_kind !== undefined
    ? normalizeActionKind(input.action_kind)
    : (existing?.action_kind ?? 'ignore');
  const actionTarget = input.action_target !== undefined
    ? normalizeOptionalString(input.action_target)
    : existing?.action_target ?? null;
  if (actionKind === 'ignore' && actionTarget) {
    throw withStatus('action_target must be empty when action_kind is ignore', 400);
  }
  if (actionKind !== 'ignore' && !actionTarget) {
    throw withStatus('action_target is required when action_kind is outcome or status', 400);
  }
  if (actionKind === 'status' && actionTarget && !validStatusKeys.has(actionTarget)) {
    throw withStatus(
      contextualStatusKeys
        ? `Status action_target "${actionTarget}" is not valid for the selected workflow context`
        : `Unknown status action_target "${actionTarget}"`,
      400,
    );
  }
  if (actionKind === 'outcome' && actionTarget && !(await listKnownOutcomeKeys(db)).has(actionTarget)) {
    throw withStatus(`Unknown outcome action_target "${actionTarget}"`, 400);
  }

  const applyReviewEvidence = normalizeBoolean(
    input.apply_review_evidence,
    existing ? Boolean(existing.apply_review_evidence) : false,
  );
  const applyFailureDetail = normalizeBoolean(
    input.apply_failure_detail,
    existing ? Boolean(existing.apply_failure_detail) : false,
  );
  const enabled = normalizeBoolean(input.enabled, existing ? Boolean(existing.enabled) : true);
  const priority = normalizeInteger(input.priority, 'priority', existing?.priority ?? 0);

  return {
    tenant_id: tenantId,
    project_id: projectId,
    sprint_id: sprintId,
    sprint_type: sprintType,
    source,
    event_name: eventName,
    task_type: taskType,
    status_includes: statusIncludes,
    status_excludes: statusExcludes,
    action_kind: actionKind,
    action_target: actionKind === 'ignore' ? null : actionTarget,
    apply_review_evidence: applyReviewEvidence,
    apply_failure_detail: applyFailureDetail,
    enabled,
    priority,
  };
}

async function getDefaultTenantIdIfAvailable(db: Db): Promise<number | null> {
  try {
    const tenant = await db.get(`SELECT id FROM tenants WHERE is_default = 1 ORDER BY id ASC LIMIT 1`) as { id: number } | undefined;
    return tenant?.id ?? null;
  } catch {
    return null;
  }
}

export async function repairDuplicateWorkflowEventMappings(db: Db): Promise<{ deleted: number }> {
  const hasTenantId = await tableHasColumn(db, 'external_event_mappings', 'tenant_id');
  const selectKeyColumns = [
    ...(hasTenantId ? ['COALESCE(tenant_id, 0) AS tenant_key'] : []),
    'COALESCE(project_id, 0) AS project_key',
    "COALESCE(source, '') AS source_key",
    'event_name',
    "COALESCE(task_type, '') AS task_type_key",
    'status_includes_json',
    'status_excludes_json',
    'action_kind',
    "COALESCE(action_target, '') AS action_target_key",
    'apply_review_evidence',
    'apply_failure_detail',
    'enabled',
    'priority',
  ].join(', ');
  const groupKeyColumns = [
    ...(hasTenantId ? ['tenant_key'] : []),
    'project_key',
    'source_key',
    'event_name',
    'task_type_key',
    'status_includes_json',
    'status_excludes_json',
    'action_kind',
    'action_target_key',
    'apply_review_evidence',
    'apply_failure_detail',
    'enabled',
    'priority',
  ].join(', ');
  const result = await db.run(`
    DELETE FROM external_event_mappings
    WHERE id IN (
      SELECT duplicate.id
      FROM external_event_mappings duplicate
      JOIN (
        SELECT MIN(id) AS keep_id, ${groupKeyColumns}
        FROM (
          SELECT id, ${selectKeyColumns}
          FROM external_event_mappings
        ) keyed
        GROUP BY ${groupKeyColumns}
        HAVING COUNT(*) > 1
      ) grouped
        ON duplicate.id != grouped.keep_id
       ${hasTenantId ? 'AND COALESCE(duplicate.tenant_id, 0) = grouped.tenant_key' : ''}
       AND COALESCE(duplicate.project_id, 0) = grouped.project_key
       AND COALESCE(duplicate.source, '') = grouped.source_key
       AND duplicate.event_name = grouped.event_name
       AND COALESCE(duplicate.task_type, '') = grouped.task_type_key
       AND duplicate.status_includes_json = grouped.status_includes_json
       AND duplicate.status_excludes_json = grouped.status_excludes_json
       AND duplicate.action_kind = grouped.action_kind
       AND COALESCE(duplicate.action_target, '') = grouped.action_target_key
       AND duplicate.apply_review_evidence = grouped.apply_review_evidence
       AND duplicate.apply_failure_detail = grouped.apply_failure_detail
       AND duplicate.enabled = grouped.enabled
       AND duplicate.priority = grouped.priority
    )
  `);
  return { deleted: result.changes };
}
async function ensureWorkflowEventMappingUniqueIndex(db: Db): Promise<void> {
  const hasTenantId = await tableHasColumn(db, 'external_event_mappings', 'tenant_id');
  await db.exec(`
    DROP INDEX IF EXISTS idx_external_event_mappings_effective_unique_no_tenant;
    DROP INDEX IF EXISTS idx_external_event_mappings_effective_unique_tenant;
  `);
  if (hasTenantId) {
    await db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_event_mappings_effective_unique_tenant
        ON external_event_mappings(
          COALESCE(tenant_id, 0),
          COALESCE(project_id, 0),
          COALESCE(source, ''),
          event_name,
          COALESCE(task_type, ''),
          status_includes_json,
          status_excludes_json,
          action_kind,
          COALESCE(action_target, ''),
          apply_review_evidence,
          apply_failure_detail,
          enabled,
          priority
        );
    `);
  } else {
    await db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_event_mappings_effective_unique_no_tenant
        ON external_event_mappings(
          COALESCE(project_id, 0),
          COALESCE(source, ''),
          event_name,
          COALESCE(task_type, ''),
          status_includes_json,
          status_excludes_json,
          action_kind,
          COALESCE(action_target, ''),
          apply_review_evidence,
          apply_failure_detail,
          enabled,
          priority
        );
    `);
  }
}

async function insertDefaultWorkflowEventMappings(db: Db, mappings: readonly typeof DEFAULT_WORKFLOW_EVENT_MAPPINGS[number][], tenantId: number | null): Promise<void> {
  const hasTenantId = await tableHasColumn(db, 'external_event_mappings', 'tenant_id');
  const defaultTenantId = hasTenantId && tenantId == null ? await getDefaultTenantIdIfAvailable(db) : null;
  const effectiveTenantId = tenantId ?? defaultTenantId;
  const tenantScoped = hasTenantId && effectiveTenantId != null;
  const tenantPredicate = hasTenantId
    ? (tenantScoped
      ? (tenantId == null ? '(tenant_id = ? OR tenant_id IS NULL)' : 'tenant_id = ?')
      : 'tenant_id IS NULL')
    : '1 = 1';

  const insertSql = `
    INSERT OR IGNORE INTO external_event_mappings (
      ${hasTenantId ? 'tenant_id,' : ''}
      project_id,
      source,
      event_name,
      task_type,
      status_includes_json,
      status_excludes_json,
      action_kind,
      action_target,
      apply_review_evidence,
      apply_failure_detail,
      enabled,
      priority,
      created_at,
      updated_at
    ) VALUES (${hasTenantId ? '?,' : ''} ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `;

  const existsSql = `
    SELECT id
    FROM external_event_mappings
    WHERE ${tenantPredicate}
      AND COALESCE(project_id, 0) = 0
      AND COALESCE(source, '') = COALESCE(?, '')
      AND event_name = ?
      AND COALESCE(task_type, '') = ''
      AND status_includes_json = ?
      AND status_excludes_json = ?
      AND action_kind = ?
      AND COALESCE(action_target, '') = COALESCE(?, '')
      AND apply_review_evidence = ?
      AND apply_failure_detail = ?
      AND enabled = ?
      AND priority = ?
    LIMIT 1
  `;

  for (const mapping of mappings) {
    const exists = await db.get(
      existsSql,
      ...(tenantScoped ? [effectiveTenantId] : []),
      mapping.source,
      mapping.event_name,
      JSON.stringify(mapping.status_includes),
      JSON.stringify(mapping.status_excludes),
      mapping.action_kind,
      mapping.action_target,
      mapping.apply_review_evidence,
      mapping.apply_failure_detail,
      mapping.enabled,
      mapping.priority,
    ) as { id: number } | undefined;
    if (exists) continue;

    await db.run(
      insertSql,
      ...(hasTenantId ? [effectiveTenantId] : []),
      null,
      mapping.source,
      mapping.event_name,
      null,
      JSON.stringify(mapping.status_includes),
      JSON.stringify(mapping.status_excludes),
      mapping.action_kind,
      mapping.action_target,
      mapping.apply_review_evidence,
      mapping.apply_failure_detail,
      mapping.enabled,
      mapping.priority,
    );
  }
}

export async function seedDefaultWorkflowEventMappings(db: Db): Promise<void> {
  await db.withTransaction(async (db) => {
    await migrateAgentStartedWorkflowEventSource(db);
    await ensureAgentStartedBlockedGuard(db);
    await repairDuplicateWorkflowEventMappings(db);
    await ensureWorkflowEventMappingUniqueIndex(db);
    await insertDefaultWorkflowEventMappings(db, DEFAULT_WORKFLOW_EVENT_MAPPINGS, null);
  });
}

export async function seedTenantDefaultWorkflowEventMappings(db: Db, tenantId: number): Promise<void> {
  await validateTenantExists(db, tenantId);
  await db.withTransaction(async (db) => {
    await ensureAgentStartedBlockedGuard(db);
    await repairDuplicateWorkflowEventMappings(db);
    await ensureWorkflowEventMappingUniqueIndex(db);
    await insertDefaultWorkflowEventMappings(db, DEFAULT_TENANT_WORKFLOW_EVENT_MAPPINGS, tenantId);
  });
}

export async function removeDevEnvironmentLeaseManagerWorkflowEventDefaultsForTenant(db: Db, tenantId: number): Promise<{ deleted: number }> {
  await validateTenantExists(db, tenantId);
  if (!await tableHasColumn(db, 'external_event_mappings', 'tenant_id')) return { deleted: 0 };

  const deleteSql = `
    DELETE FROM external_event_mappings
    WHERE tenant_id = ?
      AND project_id IS NULL
      AND source = ?
      AND event_name = ?
      AND task_type IS NULL
      AND action_kind = ?
      AND COALESCE(action_target, '') = COALESCE(?, '')
  `;

  let deleted = 0;
  for (const mapping of DEFAULT_WORKFLOW_EVENT_MAPPINGS.filter((row) => row.source === DEV_ENV_LEASE_MANAGER_SOURCE)) {
    deleted += (await db.run(
      deleteSql,
      tenantId,
      mapping.source,
      mapping.event_name,
      mapping.action_kind,
      mapping.action_target,
    )).changes;
  }
  return { deleted };
}

export async function removeDevEnvironmentLeaseManagerWorkflowEventDefaultsForNonDefaultTenants(db: Db): Promise<{ deleted: number; tenants: number }> {
  if (!await tableHasColumn(db, 'external_event_mappings', 'tenant_id')) return { deleted: 0, tenants: 0 };
  const tenants = await db.all(`
    SELECT id
    FROM tenants
    WHERE is_default = 0
    ORDER BY id ASC
  `) as Array<{ id: number }>;
  let deleted = 0;
  for (const tenant of tenants) {
    deleted += (await removeDevEnvironmentLeaseManagerWorkflowEventDefaultsForTenant(db, tenant.id)).deleted;
  }
  return { deleted, tenants: tenants.length };
}

export async function listWorkflowEventMappings(db: Db, input: { tenant_id?: unknown; project_id?: unknown; sprint_id?: unknown; workflow_id?: unknown; sprint_type?: unknown; workflow_type?: unknown; source?: unknown; event_name?: unknown; task_type?: unknown }) {
  const tenantId = parseOptionalTenantId(input.tenant_id);
  const projectId = parseOptionalProjectId(input.project_id);
  const sprintId = parseOptionalSprintId(input.sprint_id ?? input.workflow_id);
  const sprintType = normalizeOptionalSprintType(input.sprint_type ?? input.workflow_type);
  const hasWorkflowScope = await tableHasColumn(db, 'external_event_mappings', 'sprint_id')
    && await tableHasColumn(db, 'external_event_mappings', 'sprint_type');
  const source = normalizeOptionalString(input.source);
  const eventName = normalizeOptionalString(input.event_name);
  const taskType = normalizeOptionalString(input.task_type);
  if (taskType && !isValidTaskType(taskType)) {
    throw withStatus(`Invalid task_type "${taskType}". Task type keys must use lowercase letters, numbers, underscores, or hyphens.`, 400);
  }

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (tenantId != null && await tableHasColumn(db, 'external_event_mappings', 'tenant_id')) {
    clauses.push('tenant_id = ?');
    params.push(tenantId);
  }
  if (projectId) {
    clauses.push('(project_id = ? OR project_id IS NULL)');
    params.push(projectId);
  }
  if (hasWorkflowScope && sprintType) {
    clauses.push('(sprint_type = ? OR sprint_type IS NULL)');
    params.push(sprintType);
  }
  if (hasWorkflowScope && sprintId) {
    clauses.push('(sprint_id = ? OR sprint_id IS NULL)');
    params.push(sprintId);
  } else if (hasWorkflowScope && sprintType) {
    clauses.push('sprint_id IS NULL');
  }
  if (source) {
    clauses.push('(source = ? OR source IS NULL)');
    params.push(source);
  }
  if (eventName) {
    clauses.push('event_name = ?');
    params.push(eventName);
  }
  if (taskType) {
    clauses.push('(task_type = ? OR task_type IS NULL)');
    params.push(taskType);
  }

  let query = 'SELECT * FROM external_event_mappings';
  if (clauses.length > 0) query += ` WHERE ${clauses.join(' AND ')}`;
  if (projectId) {
    query += ` ORDER BY ${hasWorkflowScope ? 'CASE WHEN sprint_id = ? THEN 0 WHEN sprint_id IS NULL THEN 1 ELSE 2 END, ' : ''}CASE WHEN project_id = ? THEN 0 WHEN project_id IS NULL THEN 1 ELSE 2 END, event_name ASC, priority DESC, id ASC`;
    if (hasWorkflowScope) params.push(sprintId);
    params.push(projectId);
  } else {
    query += ` ORDER BY ${hasWorkflowScope ? 'CASE WHEN sprint_id = ? THEN 0 WHEN sprint_id IS NULL THEN 1 ELSE 2 END, ' : ''}event_name ASC, priority DESC, id ASC`;
    if (hasWorkflowScope) params.push(sprintId);
  }

  const rows = await db.all(query, ...params) as MappingRecord[];
  const conflictMap = buildConflictMap(rows);
  return {
    mappings: rows.map((row) => serializeMappingRow(row, conflictMap.get(row.id) ?? [], sprintId)),
  };
}

export async function getWorkflowEventMapping(db: Db, input: { id: unknown; tenant_id?: unknown }) {
  const id = parseId(input.id, 'id');
  const tenantId = parseOptionalTenantId(input.tenant_id);
  const row = await db.get('SELECT * FROM external_event_mappings WHERE id = ?', id) as MappingRecord | undefined;
  if (!row) throw withStatus('Workflow event mapping not found', 404);
  await ensureMappingVisibleToTenant(db, row, tenantId);
  const conflictMap = buildConflictMap([row]);
  return serializeMappingRow(row, conflictMap.get(row.id) ?? []);
}

export async function createWorkflowEventMapping(db: Db, input: Record<string, unknown>) {
  const normalized = await normalizePayload(db, input);
  await ensureNoConflicts(db, normalized);

  const insertValues: Record<string, unknown> = {
    project_id: normalized.project_id,
    source: normalized.source,
    event_name: normalized.event_name,
    task_type: normalized.task_type,
    status_includes_json: JSON.stringify(normalized.status_includes),
    status_excludes_json: JSON.stringify(normalized.status_excludes),
    action_kind: normalized.action_kind,
    action_target: normalized.action_target,
    apply_review_evidence: normalized.apply_review_evidence ? 1 : 0,
    apply_failure_detail: normalized.apply_failure_detail ? 1 : 0,
    enabled: normalized.enabled ? 1 : 0,
    priority: normalized.priority,
  };
  if (await tableHasColumn(db, 'external_event_mappings', 'sprint_id')) {
    insertValues.sprint_id = normalized.sprint_id;
  }
  if (await tableHasColumn(db, 'external_event_mappings', 'sprint_type')) {
    insertValues.sprint_type = normalized.sprint_type;
  }
  if (await tableHasColumn(db, 'external_event_mappings', 'tenant_id')) {
    insertValues.tenant_id = normalized.tenant_id;
  }
  const columns = Object.keys(insertValues);
  const placeholders = columns.map(() => '?').join(', ');
  const result = await db.run(`
    INSERT INTO external_event_mappings (${columns.join(', ')}, created_at, updated_at)
    VALUES (${placeholders}, datetime('now'), datetime('now'))
  `, ...columns.map((column) => insertValues[column]));

  const row = await db.get('SELECT * FROM external_event_mappings WHERE id = ?', result.lastInsertId) as MappingRecord;
  return serializeMappingRow(row);
}

export async function updateWorkflowEventMapping(db: Db, input: Record<string, unknown> & { id: unknown }) {
  const id = parseId(input.id, 'id');
  const existing = await db.get('SELECT * FROM external_event_mappings WHERE id = ?', id) as MappingRecord | undefined;
  if (!existing) throw withStatus('Workflow event mapping not found', 404);
  await ensureMappingVisibleToTenant(db, existing, parseOptionalTenantId(input.tenant_id));

  const normalized = await normalizePayload(db, input, existing);
  await ensureNoConflicts(db, { id, ...normalized });

  const hasTenantId = await tableHasColumn(db, 'external_event_mappings', 'tenant_id');
  const hasSprintId = await tableHasColumn(db, 'external_event_mappings', 'sprint_id');
  const hasSprintType = await tableHasColumn(db, 'external_event_mappings', 'sprint_type');
  await db.run(`
    UPDATE external_event_mappings
    SET ${hasTenantId ? 'tenant_id = ?,' : ''}
        project_id = ?,
        ${hasSprintId ? 'sprint_id = ?,' : ''}
        ${hasSprintType ? 'sprint_type = ?,' : ''}
        source = ?,
        event_name = ?,
        task_type = ?,
        status_includes_json = ?,
        status_excludes_json = ?,
        action_kind = ?,
        action_target = ?,
        apply_review_evidence = ?,
        apply_failure_detail = ?,
        enabled = ?,
        priority = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `, ...(hasTenantId ? [normalized.tenant_id] : []), normalized.project_id, ...(hasSprintId ? [normalized.sprint_id] : []), ...(hasSprintType ? [normalized.sprint_type] : []), normalized.source, normalized.event_name, normalized.task_type, JSON.stringify(normalized.status_includes), JSON.stringify(normalized.status_excludes), normalized.action_kind, normalized.action_target, normalized.apply_review_evidence ? 1 : 0, normalized.apply_failure_detail ? 1 : 0, normalized.enabled ? 1 : 0, normalized.priority, id);

  const row = await db.get('SELECT * FROM external_event_mappings WHERE id = ?', id) as MappingRecord;
  return serializeMappingRow(row);
}

export async function deleteWorkflowEventMapping(db: Db, input: { id: unknown; tenant_id?: unknown }) {
  const id = parseId(input.id, 'id');
  const existing = await db.get('SELECT * FROM external_event_mappings WHERE id = ?', id) as MappingRecord | undefined;
  if (!existing) throw withStatus('Workflow event mapping not found', 404);
  await ensureMappingVisibleToTenant(db, existing, parseOptionalTenantId(input.tenant_id));
  await db.run('DELETE FROM external_event_mappings WHERE id = ?', id);
  return { ok: true, deleted: true, id };
}

export async function resolveWorkflowEventMapping(db: Db, context: ExternalEventContext): Promise<ExternalEventMapping | null> {
  const tenantId = context.tenantId ?? (await resolveTenantIdForProject(db, context.projectId));
  const hasTenantId = await tableHasColumn(db, 'external_event_mappings', 'tenant_id');
  const hasWorkflowScope = await tableHasColumn(db, 'external_event_mappings', 'sprint_id')
    && await tableHasColumn(db, 'external_event_mappings', 'sprint_type');
  const rows = await db.all(`
    SELECT em.*
    FROM external_event_mappings em
    WHERE em.enabled = 1
      AND em.event_name = ?
      ${hasTenantId && tenantId != null ? 'AND em.tenant_id = ?' : ''}
      AND (em.source = ? OR em.source IS NULL)
      AND (em.project_id = ? OR em.project_id IS NULL)
      ${hasWorkflowScope && context.sprintType ? 'AND (em.sprint_type = ? OR em.sprint_type IS NULL)' : ''}
      ${hasWorkflowScope && context.sprintId != null ? 'AND (em.sprint_id = ? OR em.sprint_id IS NULL)' : hasWorkflowScope && context.sprintType ? 'AND em.sprint_id IS NULL' : ''}
      AND (em.task_type = ? OR em.task_type IS NULL)
    ORDER BY
      CASE WHEN em.source = ? THEN 1 ELSE 0 END DESC,
      ${hasWorkflowScope ? 'CASE WHEN em.sprint_id = ? THEN 1 ELSE 0 END DESC,' : ''}
      ${hasWorkflowScope ? 'CASE WHEN em.sprint_type = ? THEN 1 ELSE 0 END DESC,' : ''}
      CASE WHEN em.project_id = ? THEN 1 ELSE 0 END DESC,
      CASE WHEN em.task_type = ? THEN 1 ELSE 0 END DESC,
      em.priority DESC,
      em.id ASC
  `, context.eventName, ...(hasTenantId && tenantId != null ? [tenantId] : []), context.source, context.projectId, ...(hasWorkflowScope && context.sprintType ? [context.sprintType] : []), ...(hasWorkflowScope && context.sprintId != null ? [context.sprintId] : []), context.taskType, context.source, ...(hasWorkflowScope ? [context.sprintId ?? null] : []), ...(hasWorkflowScope ? [context.sprintType ?? null] : []), context.projectId, context.taskType) as MappingRecord[];

  for (const row of rows) {
    const mapping = serializeMappingRow(row, [], context.sprintId ?? null);
    const included = mapping.status_includes.length === 0 || mapping.status_includes.includes(context.currentStatus);
    if (!included) continue;
    if (mapping.status_excludes.includes(context.currentStatus)) continue;
    return mapping;
  }

  return null;
}


export const DEFAULT_EXTERNAL_EVENT_MAPPINGS = DEFAULT_WORKFLOW_EVENT_MAPPINGS;
export const EXTERNAL_EVENT_ACTION_KINDS = WORKFLOW_EVENT_ACTION_KINDS;
export const seedDefaultExternalEventMappings = seedDefaultWorkflowEventMappings;
export const listExternalEventMappings = listWorkflowEventMappings;
export const getExternalEventMapping = getWorkflowEventMapping;
export const createExternalEventMapping = createWorkflowEventMapping;
export const updateExternalEventMapping = updateWorkflowEventMapping;
export const deleteExternalEventMapping = deleteWorkflowEventMapping;
export const resolveExternalEventMapping = resolveWorkflowEventMapping;
