import { Router, type Request, type Response } from 'express';
import { getDb } from '../../db/client';
import { isStarterPolicySprintType } from '../routing/policy/metadata';
import { seedSprintTypeTaskStatuses } from '../routing/policy/seed';
import { listSprintTypeTaskStatuses } from '../routing/policy/statuses';
import {
  normalizeBooleanInt,
  normalizeConfigKey,
  normalizeOptionalText,
  parseFieldSchema,
  parseMetadataObject,
  parseStringArray,
} from './config';
import { resolveSprintOutcomeVocabulary } from './outcomes';
import { resolveWorkflowMetadata } from './workflowMetadata';
import { listRelationshipTypesForSprintType } from '../tasks/relationships';
import { resolveTenantIdFromRequest } from '../../lib/tenantContext';
import { RELATIONSHIP_DIRECTION_SEMANTICS } from '../../lib/workflowVocabulary';

interface SprintTypeRow {
  key: string;
  tenant_id?: number | null;
  project_id?: number | null;
  name: string;
  description: string;
  is_system: number;
  created_at: string;
  updated_at: string;
}

interface SprintTypeDeletionSummary {
  protected: boolean;
  reason: 'generic' | 'open_sprints' | null;
  open_sprint_count: number;
  total_sprint_count: number;
}

interface TaskFieldSchemaRow {
  id: number;
  tenant_id?: number | null;
  sprint_type_key: string;
  task_type: string | null;
  schema_json: string;
  is_system: number;
  created_at: string;
  updated_at: string;
}

interface SprintTypeOutcomeRow {
  id: number;
  sprint_type_key: string;
  task_type: string | null;
  outcome_key: string;
  label: string;
  description: string;
  enabled: number;
  behavior: 'base' | 'extend' | 'override' | 'disable';
  badge_variant: string | null;
  stage_order: number;
  is_system: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface SprintTypeOutcomeInput {
  task_type?: unknown;
  outcome_key?: unknown;
  label?: unknown;
  description?: unknown;
  enabled?: unknown;
  behavior?: unknown;
  badge_variant?: unknown;
  stage_order?: unknown;
  metadata?: unknown;
}

interface SprintTypeStatusRow {
  id: number;
  sprint_type_key: string;
  status_key: string;
  label: string;
  color: string;
  terminal: number;
  is_system: number;
  allowed_transitions_json: string;
  stage_order: number;
  is_default_entry: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface SprintTypeRelationshipTypeRow {
  id: number;
  sprint_type_key: string;
  key: string;
  label: string;
  inverse_label: string;
  category: string;
  affects_dispatch_eligibility: number;
  direction_semantics: string;
  active_statuses_json: string;
  resolved_statuses_json: string;
  allow_create_related_task: number;
  default_related_task_type: string | null;
  default_related_task_status: string | null;
  is_system: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

const router = Router();
const OUTCOME_BADGE_VARIANTS = new Set([
  'workspace',
  'queued',
  'review',
  'deployed',
  'done',
  'stalled',
  'failed',
  'blocked',
  'info',
  'warn',
  'error',
  'default',
]);
const RELATIONSHIP_DIRECTION_SEMANTICS_SET = new Set<string>(RELATIONSHIP_DIRECTION_SEMANTICS);

function resolveSprintTypeOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value.length > 0 ? value : null;
}

function normalizeBadgeVariant(raw: unknown, fieldName: string): string | null {
  const value = normalizeOptionalText(raw);
  if (!value) return null;
  if (!OUTCOME_BADGE_VARIANTS.has(value)) {
    throw new Error(`${fieldName} must be one of: ${Array.from(OUTCOME_BADGE_VARIANTS).join(', ')}`);
  }
  return value;
}

function normalizeOutcomeMetadata(raw: unknown, fieldName: string): Record<string, unknown> {
  const parsed = parseMetadataObject(raw, fieldName);
  const failureLike = parsed.failure_like === true;
  const blockedLike = parsed.blocked_like === true;
  if (failureLike && blockedLike) {
    throw new Error(`${fieldName} cannot set both failure_like and blocked_like`);
  }
  return {
    ...(failureLike ? { failure_like: true } : {}),
    ...(blockedLike ? { blocked_like: true } : {}),
  };
}

function normalizeStatusMetadata(
  rawMetadata: unknown,
  rawEmoji: unknown,
  fallbackMetadata: Record<string, unknown> = {},
): Record<string, unknown> {
  const metadata = {
    ...fallbackMetadata,
    ...parseMetadataObject(rawMetadata, 'metadata'),
  };
  const emoji = rawEmoji !== undefined
    ? normalizeOptionalText(rawEmoji)
    : typeof metadata.emoji === 'string'
      ? normalizeOptionalText(metadata.emoji)
      : null;

  if (emoji) metadata.emoji = emoji;
  else delete metadata.emoji;

  return metadata;
}

async function sprintTypeTenantPredicate(db: ReturnType<typeof getDb>, tenantId?: number | null, alias = 'sprint_types'): Promise<{ sql: string; params: unknown[] }> {
  if (tenantId == null || !await tableHasColumn(db, 'sprint_types', 'tenant_id')) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.tenant_id = ?`, params: [tenantId] };
}

async function sprintTypeTenantInsertFragment(db: ReturnType<typeof getDb>, tenantId?: number | null): Promise<{ columns: string; placeholders: string; params: unknown[] }> {
  if (tenantId == null || !await tableHasColumn(db, 'sprint_types', 'tenant_id')) return { columns: '', placeholders: '', params: [] };
  return { columns: 'tenant_id, ', placeholders: '?, ', params: [tenantId] };
}

async function sprintTypeProjectPredicate(db: ReturnType<typeof getDb>, rawProjectId: unknown, alias = 'sprint_types'): Promise<{ sql: string; params: unknown[]; projectId: number | null }> {
  if (!await tableHasColumn(db, 'sprint_types', 'project_id')) return { sql: '', params: [], projectId: null };
  const projectId = Number(rawProjectId);
  if (!Number.isInteger(projectId) || projectId <= 0) return { sql: '', params: [], projectId: null };
  return { sql: ` AND ${alias}.project_id = ?`, params: [projectId], projectId };
}

async function sprintTypeProjectInsertFragment(db: ReturnType<typeof getDb>, rawProjectId: unknown): Promise<{ columns: string; placeholders: string; params: unknown[]; projectId: number | null }> {
  if (!await tableHasColumn(db, 'sprint_types', 'project_id')) return { columns: '', placeholders: '', params: [], projectId: null };
  const projectId = Number(rawProjectId);
  if (!Number.isInteger(projectId) || projectId <= 0) return { columns: '', placeholders: '', params: [], projectId: null };
  return { columns: 'project_id, ', placeholders: '?, ', params: [projectId], projectId };
}

async function configTenantPredicate(db: ReturnType<typeof getDb>, table: string, tenantId?: number | null, alias = table): Promise<{ sql: string; params: unknown[] }> {
  if (tenantId == null || !await tableHasColumn(db, table, 'tenant_id')) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.tenant_id = ?`, params: [tenantId] };
}

async function configTenantInsertFragment(db: ReturnType<typeof getDb>, table: string, tenantId?: number | null): Promise<{ columns: string; placeholders: string; params: unknown[] }> {
  if (tenantId == null || !await tableHasColumn(db, table, 'tenant_id')) return { columns: '', placeholders: '', params: [] };
  return { columns: 'tenant_id, ', placeholders: '?, ', params: [tenantId] };
}

async function outcomeListTenantPredicate(db: ReturnType<typeof getDb>, tenantId?: number | null): Promise<{ sql: string; params: unknown[] }> {
  if (tenantId == null || !await tableHasColumn(db, 'sprint_type_outcomes', 'tenant_id')) return { sql: '', params: [] };
  return {
    sql: ` AND (tenant_id = ? OR (tenant_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM sprint_type_outcomes owned
      WHERE owned.sprint_type_key = sprint_type_outcomes.sprint_type_key
        AND owned.tenant_id = ?
      LIMIT 1
    )))`,
    params: [tenantId, tenantId],
  };
}

async function getSprintTypeOr404(db: ReturnType<typeof getDb>, sprintTypeKey: string, tenantId?: number | null): Promise<SprintTypeRow | null> {
  const tenant = await sprintTypeTenantPredicate(db, tenantId);
  return await db.get(`
    SELECT ${await tableHasColumn(db, 'sprint_types', 'tenant_id') ? 'tenant_id,' : ''}${await tableHasColumn(db, 'sprint_types', 'project_id') ? 'project_id,' : ''} key, name, description, is_system, created_at, updated_at
    FROM sprint_types
    WHERE key = ?
      ${tenant.sql}
    LIMIT 1
  `, sprintTypeKey, ...tenant.params) as SprintTypeRow | null;
}

async function tableHasColumn(db: ReturnType<typeof getDb>, table: string, column: string): Promise<boolean> {
  try {
    return (await db.all(`PRAGMA table_info(${table})`) as Array<{ name: string }>).some((row) => row.name === column);
  } catch {
    return false;
  }
}

async function getSprintTypeDeletionSummary(
  db: ReturnType<typeof getDb>,
  sprintTypeKey: string,
  tenantId?: number,
): Promise<SprintTypeDeletionSummary> {
  const hasSprintTenantId = await tableHasColumn(db, 'sprints', 'tenant_id');
  const hasProjectTenantId = await tableHasColumn(db, 'projects', 'tenant_id');
  const tenantJoin = !hasSprintTenantId && hasProjectTenantId
    ? 'LEFT JOIN projects p ON p.id = s.project_id'
    : '';
  const tenantPredicate = tenantId && hasSprintTenantId
    ? ' AND s.tenant_id = ?'
    : tenantId && hasProjectTenantId
      ? ' AND p.tenant_id = ?'
      : '';
  const params = tenantPredicate ? [sprintTypeKey, tenantId] : [sprintTypeKey];

  const counts = await db.get(`
    SELECT
      COUNT(*) as total_count,
      SUM(CASE WHEN s.status != 'closed' THEN 1 ELSE 0 END) as open_count
    FROM sprints s
    ${tenantJoin}
    WHERE s.sprint_type = ?${tenantPredicate}
  `, ...params) as { total_count: number; open_count: number | null };

  const openSprintCount = Number(counts.open_count ?? 0);
  const totalSprintCount = Number(counts.total_count ?? 0);

  return {
    protected: openSprintCount > 0,
    reason: openSprintCount > 0 ? 'open_sprints' : null,
    open_sprint_count: openSprintCount,
    total_sprint_count: totalSprintCount,
  };
}

async function getTaskTypesForSprintType(db: ReturnType<typeof getDb>, sprintTypeKey: string, tenantId?: number | null) {
  const tenant = await configTenantPredicate(db, 'sprint_type_task_types', tenantId);
  return await db.all(`
    SELECT ${await tableHasColumn(db, 'sprint_type_task_types', 'tenant_id') ? 'tenant_id,' : ''} id, sprint_type_key, task_type, is_system, created_at, updated_at
    FROM sprint_type_task_types
    WHERE sprint_type_key = ?
      ${tenant.sql}
    ORDER BY task_type ASC, id ASC
  `, sprintTypeKey, ...tenant.params) as Array<{
    id: number;
    tenant_id?: number | null;
    sprint_type_key: string;
    task_type: string;
    is_system: number;
    created_at: string;
    updated_at: string;
  }>;
}

async function getFieldSchemasForSprintType(db: ReturnType<typeof getDb>, sprintTypeKey: string, tenantId?: number | null) {
  const tenant = await configTenantPredicate(db, 'task_field_schemas', tenantId);
  const rows = await db.all(`
    SELECT ${await tableHasColumn(db, 'task_field_schemas', 'tenant_id') ? 'tenant_id,' : ''} id, sprint_type_key, task_type, schema_json, is_system, created_at, updated_at
    FROM task_field_schemas
    WHERE sprint_type_key = ?
      ${tenant.sql}
    ORDER BY CASE WHEN task_type IS NULL THEN 0 ELSE 1 END, task_type ASC, id ASC
  `, sprintTypeKey, ...tenant.params) as TaskFieldSchemaRow[];

  return rows.map((row) => ({
    ...row,
    schema: parseFieldSchema(JSON.parse(row.schema_json || '{}')),
  }));
}

function buildStatusResponse(status: {
  name: string;
  label: string;
  emoji?: string | null;
  color: string;
  terminal: boolean;
  is_system: boolean;
  allowed_transitions: string[];
  stage_order?: number | null;
  is_default_entry?: boolean | null;
  metadata?: Record<string, unknown> | null;
}) {
  const metadata = normalizeStatusMetadata(status.metadata ?? {}, status.emoji);
  const resolvedEmoji = typeof metadata.emoji === 'string' ? metadata.emoji : null;

  return {
    name: status.name,
    label: status.label,
    emoji: resolvedEmoji,
    color: status.color,
    terminal: status.terminal,
    is_system: status.is_system,
    allowed_transitions: status.allowed_transitions,
    stage_order: status.stage_order ?? 0,
    is_default_entry: status.is_default_entry ?? false,
    metadata,
  };
}

async function getStatusesForSprintType(db: ReturnType<typeof getDb>, sprintTypeKey: string, tenantId?: number | null) {
  return (await listSprintTypeTaskStatuses(db, sprintTypeKey, { tenantId })).map((status) => buildStatusResponse(status));
}

async function getSprintTypeStatusRow(db: ReturnType<typeof getDb>, sprintTypeKey: string, statusKey: string, tenantId?: number | null): Promise<SprintTypeStatusRow | undefined> {
  const tenant = await configTenantPredicate(db, 'sprint_type_task_statuses', tenantId);
  return await db.get(`
    SELECT id, sprint_type_key, status_key, label, color, terminal, is_system,
           allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
    FROM sprint_type_task_statuses
    WHERE sprint_type_key = ? AND status_key = ?
      ${tenant.sql}
  `, sprintTypeKey, statusKey, ...tenant.params) as SprintTypeStatusRow | undefined;
}

async function syncSprintTypeStatusToExistingSprints(
  db: ReturnType<typeof getDb>,
  sprintTypeKey: string,
  tenantId: number | null | undefined,
  row: {
    status_key: string;
    label: string;
    color: string;
    terminal: number;
    is_system: number;
    allowed_transitions_json: string;
    stage_order: number;
    is_default_entry: number;
    metadata_json: string;
  },
): Promise<void> {
  const tenant = await tableHasColumn(db, 'sprints', 'tenant_id') && tenantId != null
    ? { sql: ' AND tenant_id = ?', params: [tenantId] }
    : { sql: '', params: [] as unknown[] };
  const sprints = await db.all(`
    SELECT id
    FROM sprints
    WHERE sprint_type = ?
      ${tenant.sql}
  `, sprintTypeKey, ...tenant.params) as Array<{ id: number }>;
  const existingSql = `SELECT id FROM sprint_task_statuses WHERE sprint_id = ? AND status_key = ? LIMIT 1`;
  const updateSql = `
    UPDATE sprint_task_statuses
    SET label = ?,
        color = ?,
        terminal = ?,
        is_system = ?,
        allowed_transitions_json = ?,
        stage_order = ?,
        is_default_entry = ?,
        metadata_json = ?,
        updated_at = datetime('now')
    WHERE sprint_id = ? AND status_key = ?
  `;
  const insertSql = `
    INSERT INTO sprint_task_statuses (
      sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `;
  for (const sprint of sprints) {
    if (await db.get(existingSql, sprint.id, row.status_key)) {
      await db.run(
        updateSql,
        row.label,
        row.color,
        row.terminal,
        row.is_system,
        row.allowed_transitions_json,
        row.stage_order,
        row.is_default_entry,
        row.metadata_json,
        sprint.id,
        row.status_key,
      );
    } else {
      await db.run(
        insertSql,
        sprint.id,
        row.status_key,
        row.label,
        row.color,
        row.terminal,
        row.is_system,
        row.allowed_transitions_json,
        row.stage_order,
        row.is_default_entry,
        row.metadata_json,
      );
    }
  }
}

async function getOutcomesForSprintType(db: ReturnType<typeof getDb>, sprintTypeKey: string, tenantId?: number | null) {
  const tenant = await outcomeListTenantPredicate(db, tenantId);
  const rows = await db.all(`
    SELECT id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at
    FROM sprint_type_outcomes
    WHERE sprint_type_key = ?
      ${tenant.sql}
    ORDER BY CASE WHEN task_type IS NULL THEN 0 ELSE 1 END, task_type ASC, stage_order ASC, id ASC
  `, sprintTypeKey, ...tenant.params) as SprintTypeOutcomeRow[];

  return rows.map((row) => ({
    ...row,
    metadata: JSON.parse(row.metadata_json || '{}'),
  }));
}

async function getResolvedOutcomesForSprintType(db: ReturnType<typeof getDb>, sprintTypeKey: string, tenantId?: number | null) {
  const taskTypes = (await getTaskTypesForSprintType(db, sprintTypeKey)).map((row) => row.task_type);
  const base = (await resolveSprintOutcomeVocabulary(db, { sprintType: sprintTypeKey, tenantId })).map((row) => ({
    ...row,
    source: row.id ? 'configured' : 'fallback',
  }));

  const byTaskType = Object.fromEntries(taskTypes.map(async (taskType) => [
      taskType,
      (await resolveSprintOutcomeVocabulary(db, { sprintType: sprintTypeKey, taskType, tenantId })).map((row) => ({
      ...row,
      source: row.id ? 'configured' : 'fallback',
    })),
  ]));

  return {
    base,
    by_task_type: byTaskType,
  };
}

async function getRelationshipTypeRow(db: ReturnType<typeof getDb>, sprintTypeKey: string, relationshipTypeId: number, tenantId?: number | null): Promise<SprintTypeRelationshipTypeRow | undefined> {
  const tenant = await configTenantPredicate(db, 'sprint_type_relationship_types', tenantId);
  return await db.get(`
    SELECT *
    FROM sprint_type_relationship_types
    WHERE id = ? AND sprint_type_key = ?
      ${tenant.sql}
  `, relationshipTypeId, sprintTypeKey, ...tenant.params) as SprintTypeRelationshipTypeRow | undefined;
}

function shapeRelationshipType(row: SprintTypeRelationshipTypeRow) {
  return {
    ...row,
    active_statuses: JSON.parse(row.active_statuses_json || '[]'),
    resolved_statuses: JSON.parse(row.resolved_statuses_json || '[]'),
    metadata: JSON.parse(row.metadata_json || '{}'),
  };
}

function validateRelationshipTypePayload(input: Record<string, unknown>, index = 0) {
  const key = normalizeConfigKey(input.key, `relationship_types[${index}].key`);
  const label = normalizeOptionalText(input.label) || key;
  const inverseLabel = normalizeOptionalText(input.inverse_label);
  const category = normalizeOptionalText(input.category) || 'informational';
  const affectsDispatchEligibility = normalizeBooleanInt(input.affects_dispatch_eligibility);
  const directionSemantics = normalizeOptionalText(input.direction_semantics) || 'informational';
  if (!RELATIONSHIP_DIRECTION_SEMANTICS_SET.has(directionSemantics)) {
    throw new Error(`relationship_types[${index}].direction_semantics must be one of: ${RELATIONSHIP_DIRECTION_SEMANTICS.join(', ')}`);
  }
  if (affectsDispatchEligibility === 1 && directionSemantics === 'informational') {
    throw new Error(`relationship_types[${index}].direction_semantics must be directional when affects_dispatch_eligibility is true`);
  }
  return {
    key,
    label,
    inverse_label: inverseLabel,
    category,
    affects_dispatch_eligibility: affectsDispatchEligibility,
    direction_semantics: directionSemantics,
    active_statuses: parseStringArray(input.active_statuses, 'active_statuses'),
    resolved_statuses: parseStringArray(input.resolved_statuses, 'resolved_statuses'),
    allow_create_related_task: normalizeBooleanInt(input.allow_create_related_task),
    default_related_task_type: normalizeOptionalText(input.default_related_task_type) || null,
    default_related_task_status: normalizeOptionalText(input.default_related_task_status) || null,
    metadata: parseMetadataObject(input.metadata, 'metadata'),
  };
}

function validateOutcomePayload(input: SprintTypeOutcomeInput, index = 0) {
  const taskType = input.task_type == null || input.task_type === ''
    ? null
    : normalizeConfigKey(input.task_type, `outcomes[${index}].task_type`);
  const outcomeKey = normalizeConfigKey(input.outcome_key, `outcomes[${index}].outcome_key`);
  if (outcomeKey === 'runtime_failed') {
    throw new Error('runtime_failed is a backend system outcome and cannot be configured as a custom sprint outcome');
  }
  const label = normalizeOptionalText(input.label) || outcomeKey;
  const description = normalizeOptionalText(input.description);
  const enabled = input.enabled === undefined ? 1 : normalizeBooleanInt(input.enabled);
  const behaviorRaw = normalizeOptionalText(input.behavior) || (taskType ? 'extend' : 'base');
  if (!['base', 'extend', 'override', 'disable'].includes(behaviorRaw)) {
    throw new Error(`outcomes[${index}].behavior must be one of: base, extend, override, disable`);
  }
  if (!taskType && behaviorRaw !== 'base') {
    throw new Error('Base sprint-type outcomes must use behavior="base"');
  }
  if (taskType && behaviorRaw === 'base') {
    throw new Error('Task-type outcome overlays must use behavior extend, override, or disable');
  }
  const stageOrder = Number.isFinite(Number(input.stage_order)) ? Number(input.stage_order) : index;
  return {
    task_type: taskType,
    outcome_key: outcomeKey,
    label,
    description,
    enabled,
    behavior: behaviorRaw as 'base' | 'extend' | 'override' | 'disable',
    badge_variant: normalizeBadgeVariant(input.badge_variant, `outcomes[${index}].badge_variant`),
    stage_order: stageOrder,
    metadata: normalizeOutcomeMetadata(input.metadata, `outcomes[${index}].metadata`),
  };
}

async function buildWorkflowConfigSnapshot(db: ReturnType<typeof getDb>, tenantId?: number, rawProjectId?: unknown) {
  const tenant = await sprintTypeTenantPredicate(db, tenantId);
  const project = await sprintTypeProjectPredicate(db, rawProjectId);
  const sprintTypes = await db.all(`
    SELECT ${await tableHasColumn(db, 'sprint_types', 'tenant_id') ? 'tenant_id,' : ''}${await tableHasColumn(db, 'sprint_types', 'project_id') ? 'project_id,' : ''} key, name, description, is_system, created_at, updated_at
    FROM sprint_types
    WHERE 1 = 1
      ${tenant.sql}
      ${project.sql}
    ORDER BY is_system DESC, name ASC, key ASC
  `, ...tenant.params, ...project.params) as SprintTypeRow[];
  const visibleSprintTypes = sprintTypes.filter(async (sprintType) => {
    if (!(sprintType.key === 'pm' && sprintType.is_system === 1)) return true;
    return (await getSprintTypeDeletionSummary(db, sprintType.key, tenantId)).total_sprint_count > 0;
  });

  return {
    sprint_types: visibleSprintTypes.map(async (sprintType) => ({
      ...sprintType,
      deletion: await getSprintTypeDeletionSummary(db, sprintType.key, tenantId),
      task_types: await getTaskTypesForSprintType(db, sprintType.key),
      statuses: await getStatusesForSprintType(db, sprintType.key, tenantId),
      field_schemas: await getFieldSchemasForSprintType(db, sprintType.key),
      outcomes: await getOutcomesForSprintType(db, sprintType.key, tenantId),
      resolved_outcomes: await getResolvedOutcomesForSprintType(db, sprintType.key, tenantId),
      relationship_types: await listRelationshipTypesForSprintType(db, sprintType.key, tenantId),
    })),
  };
}

router.get('/types/list', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const tenant = await sprintTypeTenantPredicate(db, tenantId);
    const project = await sprintTypeProjectPredicate(db, req.query.project_id);
    const sprintTypes = await db.all(`
      SELECT ${await tableHasColumn(db, 'sprint_types', 'tenant_id') ? 'tenant_id,' : ''}${await tableHasColumn(db, 'sprint_types', 'project_id') ? 'project_id,' : ''} key, name, description, is_system, created_at, updated_at
      FROM sprint_types
      WHERE 1 = 1
        ${tenant.sql}
        ${project.sql}
      ORDER BY is_system DESC, name ASC
    `, ...tenant.params, ...project.params);

    res.json(sprintTypes);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/types/:key', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });

    const sprintType = await getSprintTypeOr404(db, sprintTypeKey, tenantId);
    if (!sprintType) return res.status(404).json({ error: 'Sprint type not found' });

    return res.json({
      ...sprintType,
      deletion: await getSprintTypeDeletionSummary(db, sprintTypeKey, tenantId),
      task_types: await getTaskTypesForSprintType(db, sprintTypeKey, tenantId),
      statuses: await getStatusesForSprintType(db, sprintTypeKey, tenantId),
      field_schemas: await getFieldSchemasForSprintType(db, sprintTypeKey, tenantId),
      outcomes: await getOutcomesForSprintType(db, sprintTypeKey, tenantId),
      resolved_outcomes: await getResolvedOutcomesForSprintType(db, sprintTypeKey, tenantId),
      relationship_types: await listRelationshipTypesForSprintType(db, sprintTypeKey, tenantId),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/workflow-metadata', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    return res.json(await resolveWorkflowMetadata(db, {
              sprintId: req.query.sprint_id,
              sprintType: req.query.sprint_type,
              taskType: req.query.task_type,
              tenantId,
            }));
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/types/:key/task-types', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });

    const sprintType = await getSprintTypeOr404(db, sprintTypeKey, tenantId);

    if (!sprintType) return res.status(404).json({ error: 'Sprint type not found' });

    const taskTypes = await db.all(`
      SELECT ${await tableHasColumn(db, 'sprint_type_task_types', 'tenant_id') ? 'tenant_id,' : ''} task_type, is_system, created_at, updated_at
      FROM sprint_type_task_types
      WHERE sprint_type_key = ?
        ${(await configTenantPredicate(db, 'sprint_type_task_types', tenantId)).sql}
      ORDER BY task_type ASC
    `, sprintTypeKey, ...(await configTenantPredicate(db, 'sprint_type_task_types', tenantId)).params);

    return res.json({
      sprint_type: sprintType,
      task_types: taskTypes,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/types/:key/statuses', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    const sprintType = await getSprintTypeOr404(db, sprintTypeKey, tenantId);
    if (!sprintType) return res.status(404).json({ error: 'Sprint type not found' });

    return res.json({
      sprint_type: sprintType,
      statuses: await getStatusesForSprintType(db, sprintTypeKey, tenantId),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/types/:key/statuses/:statusKey', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const statusKey = resolveSprintTypeOrNull(req.params.statusKey);
    if (!sprintTypeKey || !statusKey) return res.status(400).json({ error: 'Sprint type key and status key are required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });
    const status = (await getStatusesForSprintType(db, sprintTypeKey, tenantId)).find(row => row.name === statusKey);
    if (!status) return res.status(404).json({ error: 'Status not found' });
    return res.json(status);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/types/:key/field-schemas', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    const sprintType = await getSprintTypeOr404(db, sprintTypeKey, tenantId);
    if (!sprintType) return res.status(404).json({ error: 'Sprint type not found' });

    const rows = await db.all(`
      SELECT ${await tableHasColumn(db, 'task_field_schemas', 'tenant_id') ? 'tenant_id,' : ''} id, sprint_type_key, task_type, schema_json, is_system, created_at, updated_at
      FROM task_field_schemas
      WHERE sprint_type_key = ?
        ${(await configTenantPredicate(db, 'task_field_schemas', tenantId)).sql}
      ORDER BY CASE WHEN task_type IS NULL THEN 0 ELSE 1 END, task_type ASC, id ASC
    `, sprintTypeKey, ...(await configTenantPredicate(db, 'task_field_schemas', tenantId)).params) as TaskFieldSchemaRow[];

    return res.json({
      sprint_type: sprintType,
      field_schemas: rows.map((row) => ({
        ...row,
        schema: parseFieldSchema(JSON.parse(row.schema_json || '{}')),
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/types/:key/field-schemas/:schemaId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const schemaId = Number(req.params.schemaId);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });

    const row = await db.get(`
      SELECT ${await tableHasColumn(db, 'task_field_schemas', 'tenant_id') ? 'tenant_id,' : ''} id, sprint_type_key, task_type, schema_json, is_system, created_at, updated_at
      FROM task_field_schemas
      WHERE id = ? AND sprint_type_key = ?
        ${(await configTenantPredicate(db, 'task_field_schemas', tenantId)).sql}
      LIMIT 1
    `, schemaId, sprintTypeKey, ...(await configTenantPredicate(db, 'task_field_schemas', tenantId)).params) as TaskFieldSchemaRow | undefined;

    if (!row) return res.status(404).json({ error: 'Field schema not found' });

    return res.json({
      ...row,
      schema: parseFieldSchema(JSON.parse(row.schema_json || '{}')),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/config', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const snapshot = await buildWorkflowConfigSnapshot(db, tenantId, req.query.project_id);
    if (!await tableHasColumn(db, 'sprint_types', 'project_id') || req.query.project_id == null || req.query.project_id === '') {
      return res.json(snapshot);
    }
    const projectId = Number(req.query.project_id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ error: 'project_id must be a positive integer' });
    }
    return res.json({ ...snapshot, project_id: projectId });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post('/types', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const key = normalizeConfigKey(req.body?.key, 'key');
    const name = normalizeOptionalText(req.body?.name);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const description = normalizeOptionalText(req.body?.description);
    const project = await sprintTypeProjectInsertFragment(db, req.body?.project_id);

    const existing = await getSprintTypeOr404(db, key, tenantId);
    if (existing) return res.status(409).json({ error: `Sprint type "${key}" already exists` });
    const tenant = await sprintTypeTenantInsertFragment(db, tenantId);

    await db.withTransaction(async (db) => {
      await db.run(`
        INSERT INTO sprint_types (${tenant.columns}${project.columns}key, name, description, is_system, created_at, updated_at)
        VALUES (${tenant.placeholders}${project.placeholders}?, ?, ?, 0, datetime('now'), datetime('now'))
      `, ...tenant.params, ...project.params, key, name, description);
      if (isStarterPolicySprintType(key)) {
        await seedSprintTypeTaskStatuses(db, key, { tenantId });
      }
    });

    return res.status(201).json(await getSprintTypeOr404(db, key, tenantId));
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.put('/types/:key', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    const existing = await getSprintTypeOr404(db, sprintTypeKey, tenantId);
    if (!existing) return res.status(404).json({ error: 'Sprint type not found' });
    if (existing.tenant_id == null && await tableHasColumn(db, 'sprint_types', 'tenant_id')) {
      return res.status(409).json({ error: 'Global workflow definitions cannot be edited from a tenant-scoped route' });
    }

    const name = req.body?.name !== undefined ? normalizeOptionalText(req.body.name) : existing.name;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const description = req.body?.description !== undefined ? normalizeOptionalText(req.body.description) : existing.description;
    const project = await sprintTypeProjectInsertFragment(db, req.body?.project_id);

    const tenant = await sprintTypeTenantPredicate(db, tenantId);
    await db.run(`
      UPDATE sprint_types
      SET ${project.projectId != null ? 'project_id = ?, ' : ''}name = ?, description = ?, updated_at = datetime('now')
      WHERE key = ?
        ${tenant.sql}
    `, ...project.params, name, description, sprintTypeKey, ...tenant.params);

    return res.json(await getSprintTypeOr404(db, sprintTypeKey, tenantId));
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete('/types/:key', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    const existing = await getSprintTypeOr404(db, sprintTypeKey, tenantId);
    if (!existing) return res.status(404).json({ error: 'Sprint type not found' });
    if (existing.tenant_id == null && await tableHasColumn(db, 'sprint_types', 'tenant_id')) {
      return res.status(409).json({ error: 'Global workflow definitions cannot be deleted from a tenant-scoped route' });
    }

    const deletion = await getSprintTypeDeletionSummary(db, sprintTypeKey, tenantId);
    if (deletion.reason === 'generic') {
      return res.status(409).json({
        error: 'Cannot delete sprint type "generic" because it is the canonical fallback sprint type',
        code: 'protected_sprint_type',
      });
    }
    if (deletion.reason === 'open_sprints') {
      return res.status(409).json({
        error: `Cannot delete workflow type "${sprintTypeKey}" because ${deletion.open_sprint_count} open workflow(s) still use it in this tenant`,
        code: 'sprint_type_in_use',
        open_sprint_count: deletion.open_sprint_count,
        total_sprint_count: deletion.total_sprint_count,
      });
    }

    const tenant = await sprintTypeTenantPredicate(db, tenantId);
    await db.run(`DELETE FROM sprint_types WHERE key = ?${tenant.sql}`, sprintTypeKey, ...tenant.params);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.put('/types/:key/task-types', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const taskTypeTenant = await configTenantPredicate(db, 'sprint_type_task_types', tenantId);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    const sprintType = await getSprintTypeOr404(db, sprintTypeKey, tenantId);
    if (!sprintType) return res.status(404).json({ error: 'Sprint type not found' });

    if (!Array.isArray(req.body?.task_types)) {
      return res.status(400).json({ error: 'task_types must be an array' });
    }

    const taskTypes = req.body.task_types.map((taskType: unknown, index: number) => normalizeConfigKey(taskType, `task_types[${index}]`));
    const dedupedTaskTypes = [...new Set(taskTypes)];

    await db.withTransaction(async (db) => {
      await db.run(`DELETE FROM sprint_type_task_types WHERE sprint_type_key = ?${taskTypeTenant.sql}`, sprintTypeKey, ...taskTypeTenant.params);
      const insertTenant = await configTenantInsertFragment(db, 'sprint_type_task_types', tenantId);
      const insertSql = `
        INSERT INTO sprint_type_task_types (${insertTenant.columns}sprint_type_key, task_type, is_system, created_at, updated_at)
        VALUES (${insertTenant.placeholders}?, ?, 0, datetime('now'), datetime('now'))
      `;
      for (const taskType of dedupedTaskTypes) {
        await db.run(insertSql, ...insertTenant.params, sprintTypeKey, taskType);
      }
      const sprintTypeTenant = await sprintTypeTenantPredicate(db, tenantId);
      await db.run(`UPDATE sprint_types SET updated_at = datetime('now') WHERE key = ?${sprintTypeTenant.sql}`, sprintTypeKey, ...sprintTypeTenant.params);
    });

    return res.json({
      sprint_type: sprintType,
      task_types: await getTaskTypesForSprintType(db, sprintTypeKey, tenantId),
    });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/types/:key/statuses', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });

    const statusKey = normalizeConfigKey(req.body?.name ?? req.body?.status_key, 'name');
    const label = normalizeOptionalText(req.body?.label);
    if (!label) return res.status(400).json({ error: 'label is required' });
    const color = normalizeOptionalText(req.body?.color) || 'slate';
    const terminal = normalizeBooleanInt(req.body?.terminal);
    const allowedTransitions = parseStringArray(req.body?.allowed_transitions, 'allowed_transitions');
    const metadata = normalizeStatusMetadata(req.body?.metadata, req.body?.emoji);
    const nextStageOrder = (await db.get(`
      SELECT COALESCE(MAX(stage_order) + 1, 0) AS next_stage_order
      FROM sprint_type_task_statuses
      WHERE sprint_type_key = ?
    `, sprintTypeKey) as { next_stage_order: number }).next_stage_order;

    const duplicate = await getSprintTypeStatusRow(db, sprintTypeKey, statusKey, tenantId);
    if (duplicate) return res.status(409).json({ error: `Status "${statusKey}" already exists for sprint type "${sprintTypeKey}"` });

    const row = {
      status_key: statusKey,
      label,
      color,
      terminal,
      is_system: 0,
      allowed_transitions_json: JSON.stringify(allowedTransitions),
      stage_order: Number.isFinite(Number(req.body?.stage_order)) ? Number(req.body.stage_order) : nextStageOrder,
      is_default_entry: normalizeBooleanInt(req.body?.is_default_entry),
      metadata_json: JSON.stringify(metadata),
    };

    await db.withTransaction(async (db) => {
      const insertTenant = await configTenantInsertFragment(db, 'sprint_type_task_statuses', tenantId);
      await db.run(`
        INSERT INTO sprint_type_task_statuses (
          ${insertTenant.columns}sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
        ) VALUES (${insertTenant.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `, ...insertTenant.params, sprintTypeKey, row.status_key, row.label, row.color, row.terminal, row.is_system, row.allowed_transitions_json, row.stage_order, row.is_default_entry, row.metadata_json);
      await syncSprintTypeStatusToExistingSprints(db, sprintTypeKey, tenantId, row);
      await db.run(`UPDATE sprint_types SET updated_at = datetime('now') WHERE key = ?${(await sprintTypeTenantPredicate(db, tenantId)).sql}`, sprintTypeKey, ...(await sprintTypeTenantPredicate(db, tenantId)).params);
    });

    return res.status(201).json((await getStatusesForSprintType(db, sprintTypeKey, tenantId)).find(status => status.name === statusKey));
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.put('/types/:key/statuses/:statusKey', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const currentStatusKey = resolveSprintTypeOrNull(req.params.statusKey);
    if (!sprintTypeKey || !currentStatusKey) return res.status(400).json({ error: 'Sprint type key and status key are required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });
    const existing = await getSprintTypeStatusRow(db, sprintTypeKey, currentStatusKey, tenantId);
    if (!existing) return res.status(404).json({ error: 'Status not found' });

    const nextStatusKey = req.body?.name !== undefined || req.body?.status_key !== undefined
      ? normalizeConfigKey(req.body?.name ?? req.body?.status_key, 'name')
      : currentStatusKey;
    const label = req.body?.label !== undefined ? normalizeOptionalText(req.body.label) : existing.label;
    if (!label) return res.status(400).json({ error: 'label is required' });
    const color = req.body?.color !== undefined ? (normalizeOptionalText(req.body.color) || 'slate') : existing.color;
    const terminal = req.body?.terminal !== undefined ? normalizeBooleanInt(req.body.terminal) : Number(existing.terminal);
    const allowedTransitions = req.body?.allowed_transitions !== undefined
      ? parseStringArray(req.body.allowed_transitions, 'allowed_transitions')
      : JSON.parse(existing.allowed_transitions_json || '[]');
    const existingMetadata = parseMetadataObject(existing.metadata_json || '{}', 'metadata');
    const metadata = req.body?.metadata !== undefined || req.body?.emoji !== undefined
      ? normalizeStatusMetadata(req.body?.metadata, req.body?.emoji, existingMetadata)
      : normalizeStatusMetadata(existingMetadata, undefined);
    const stageOrder = Number.isFinite(Number(req.body?.stage_order)) ? Number(req.body.stage_order) : Number(existing.stage_order);
    const isDefaultEntry = req.body?.is_default_entry !== undefined ? normalizeBooleanInt(req.body.is_default_entry) : Number(existing.is_default_entry);

    if (nextStatusKey !== currentStatusKey) {
      const duplicate = await getSprintTypeStatusRow(db, sprintTypeKey, nextStatusKey, tenantId);
      if (duplicate) return res.status(409).json({ error: `Status "${nextStatusKey}" already exists for sprint type "${sprintTypeKey}"` });
    }

    const row = {
      status_key: nextStatusKey,
      label,
      color,
      terminal,
      is_system: Number(existing.is_system),
      allowed_transitions_json: JSON.stringify(allowedTransitions),
      stage_order: stageOrder,
      is_default_entry: isDefaultEntry,
      metadata_json: JSON.stringify(metadata),
    };

    await db.withTransaction(async (db) => {
      const statusTenant = await configTenantPredicate(db, 'sprint_type_task_statuses', tenantId);
      await db.run(`
        UPDATE sprint_type_task_statuses
        SET status_key = ?,
            label = ?,
            color = ?,
            terminal = ?,
            allowed_transitions_json = ?,
            stage_order = ?,
            is_default_entry = ?,
            metadata_json = ?,
            updated_at = datetime('now')
        WHERE sprint_type_key = ? AND status_key = ?
          ${statusTenant.sql}
      `, row.status_key, row.label, row.color, row.terminal, row.allowed_transitions_json, row.stage_order, row.is_default_entry, row.metadata_json, sprintTypeKey, currentStatusKey, ...statusTenant.params);
      if (nextStatusKey !== currentStatusKey) {
        const sprintTenantSql = await tableHasColumn(db, 'sprints', 'tenant_id') ? ' AND tenant_id = ?' : '';
        const sprintTenantParams = await tableHasColumn(db, 'sprints', 'tenant_id') ? [tenantId] : [];
        await db.run(`
          UPDATE tasks
          SET status = ?, updated_at = datetime('now')
          WHERE sprint_id IN (SELECT id FROM sprints WHERE sprint_type = ?${sprintTenantSql}) AND status = ?
        `, nextStatusKey, sprintTypeKey, ...sprintTenantParams, currentStatusKey);
        await db.run(`
          UPDATE sprint_task_transitions
          SET from_status = CASE WHEN from_status = ? THEN ? ELSE from_status END,
              to_status = CASE WHEN to_status = ? THEN ? ELSE to_status END,
              updated_at = datetime('now')
          WHERE sprint_id IN (SELECT id FROM sprints WHERE sprint_type = ?${sprintTenantSql})
            AND (from_status = ? OR to_status = ?)
        `, currentStatusKey, nextStatusKey, currentStatusKey, nextStatusKey, sprintTypeKey, ...sprintTenantParams, currentStatusKey, currentStatusKey);
      }
      await syncSprintTypeStatusToExistingSprints(db, sprintTypeKey, tenantId, row);
      await db.run(`UPDATE sprint_types SET updated_at = datetime('now') WHERE key = ?${(await sprintTypeTenantPredicate(db, tenantId)).sql}`, sprintTypeKey, ...(await sprintTypeTenantPredicate(db, tenantId)).params);
    });

    return res.json((await getStatusesForSprintType(db, sprintTypeKey, tenantId)).find(status => status.name === nextStatusKey));
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete('/types/:key/statuses/:statusKey', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const statusKey = resolveSprintTypeOrNull(req.params.statusKey);
    if (!sprintTypeKey || !statusKey) return res.status(400).json({ error: 'Sprint type key and status key are required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });
    const existing = await getSprintTypeStatusRow(db, sprintTypeKey, statusKey, tenantId);
    if (!existing) return res.status(404).json({ error: 'Status not found' });
    const sprintTenantSql = await tableHasColumn(db, 'sprints', 'tenant_id') ? ' AND tenant_id = ?' : '';
    const sprintTenantParams = await tableHasColumn(db, 'sprints', 'tenant_id') ? [tenantId] : [];
    const statusTenant = await configTenantPredicate(db, 'sprint_type_task_statuses', tenantId);

    const taskCount = (await db.get(`
      SELECT COUNT(*) AS n
      FROM tasks
      WHERE status = ?
        AND sprint_id IN (SELECT id FROM sprints WHERE sprint_type = ?${sprintTenantSql})
    `, statusKey, sprintTypeKey, ...sprintTenantParams) as { n: number }).n;
    if (taskCount > 0) {
      return res.status(409).json({
        error: `Cannot delete status "${statusKey}": ${taskCount} task${taskCount === 1 ? '' : 's'} currently use it`,
        reason: 'tasks_in_use',
        task_count: taskCount,
      });
    }

    const transitionRefs = await db.all(`
      SELECT id, sprint_id, from_status, outcome, to_status
      FROM sprint_task_transitions
      WHERE sprint_id IN (SELECT id FROM sprints WHERE sprint_type = ?${sprintTenantSql})
        AND (from_status = ? OR to_status = ?)
    `, sprintTypeKey, ...sprintTenantParams, statusKey, statusKey);
    if (transitionRefs.length > 0) {
      return res.status(409).json({
        error: `Cannot delete status "${statusKey}": referenced by ${transitionRefs.length} sprint transition${transitionRefs.length === 1 ? '' : 's'}`,
        reason: 'transitions_in_use',
        transitions: transitionRefs,
      });
    }

    const typeRows = await db.all(`
      SELECT status_key, allowed_transitions_json
      FROM sprint_type_task_statuses
      WHERE sprint_type_key = ? AND status_key != ?
        ${statusTenant.sql}
    `, sprintTypeKey, statusKey, ...statusTenant.params) as Array<{ status_key: string; allowed_transitions_json: string }>;
    const referencingStatuses = typeRows.filter(row => {
      try {
        return (JSON.parse(row.allowed_transitions_json || '[]') as string[]).includes(statusKey);
      } catch {
        return false;
      }
    }).map(row => row.status_key);
    if (referencingStatuses.length > 0) {
      return res.status(409).json({
        error: `Cannot delete status "${statusKey}": referenced by visible allowed transitions for ${referencingStatuses.join(', ')}`,
        reason: 'referenced_by_statuses',
        referencing_statuses: referencingStatuses,
      });
    }

    await db.withTransaction(async (db) => {
      await db.run(`DELETE FROM sprint_type_task_statuses WHERE sprint_type_key = ? AND status_key = ?${statusTenant.sql}`, sprintTypeKey, statusKey, ...statusTenant.params);
      await db.run(`
        DELETE FROM sprint_task_statuses
        WHERE status_key = ?
          AND sprint_id IN (SELECT id FROM sprints WHERE sprint_type = ?${sprintTenantSql})
      `, statusKey, sprintTypeKey, ...sprintTenantParams);
      await db.run(`UPDATE sprint_types SET updated_at = datetime('now') WHERE key = ?${(await sprintTypeTenantPredicate(db, tenantId)).sql}`, sprintTypeKey, ...(await sprintTypeTenantPredicate(db, tenantId)).params);
    });

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post('/types/:key/field-schemas', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const schemaTenant = await configTenantPredicate(db, 'task_field_schemas', tenantId);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });

    const taskType = req.body?.task_type === null || req.body?.task_type === '' || req.body?.task_type === undefined
      ? null
      : normalizeConfigKey(req.body.task_type, 'task_type');
    const schema = parseFieldSchema(req.body?.schema);

    const existing = await db.get(`
      SELECT id FROM task_field_schemas
      WHERE sprint_type_key = ?
        AND (task_type = ? OR (task_type IS NULL AND ? IS NULL))
        ${schemaTenant.sql}
    `, sprintTypeKey, taskType, taskType, ...schemaTenant.params) as { id: number } | undefined;
    if (existing) return res.status(409).json({ error: 'A field schema for this sprint type/task type already exists' });

    const insertTenant = await configTenantInsertFragment(db, 'task_field_schemas', tenantId);
    const result = await db.run(`
      INSERT INTO task_field_schemas (${insertTenant.columns}sprint_type_key, task_type, schema_json, is_system, created_at, updated_at)
      VALUES (${insertTenant.placeholders}?, ?, ?, 0, datetime('now'), datetime('now'))
    `, ...insertTenant.params, sprintTypeKey, taskType, JSON.stringify(schema));

    const created = await db.get(`
      SELECT ${await tableHasColumn(db, 'task_field_schemas', 'tenant_id') ? 'tenant_id,' : ''} id, sprint_type_key, task_type, schema_json, is_system, created_at, updated_at
      FROM task_field_schemas
      WHERE id = ?
    `, Number(result.lastInsertId)) as TaskFieldSchemaRow;

    return res.status(201).json({
      ...created,
      schema: parseFieldSchema(JSON.parse(created.schema_json || '{}')),
    });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.put('/types/:key/field-schemas/:schemaId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const schemaTenant = await configTenantPredicate(db, 'task_field_schemas', tenantId);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const schemaId = Number(req.params.schemaId);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });
    const existing = await db.get(`
      SELECT ${await tableHasColumn(db, 'task_field_schemas', 'tenant_id') ? 'tenant_id,' : ''} id, sprint_type_key, task_type, schema_json, is_system, created_at, updated_at
      FROM task_field_schemas
      WHERE id = ? AND sprint_type_key = ?
        ${schemaTenant.sql}
    `, schemaId, sprintTypeKey, ...schemaTenant.params) as TaskFieldSchemaRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Field schema not found' });

    const taskType = req.body?.task_type === null || req.body?.task_type === '' || req.body?.task_type === undefined
      ? null
      : normalizeConfigKey(req.body.task_type, 'task_type');
    const schema = req.body?.schema !== undefined ? parseFieldSchema(req.body.schema) : JSON.parse(existing.schema_json || '{}');

    const duplicate = await db.get(`
      SELECT id FROM task_field_schemas
      WHERE sprint_type_key = ?
        AND (task_type = ? OR (task_type IS NULL AND ? IS NULL))
        AND id != ?
        ${schemaTenant.sql}
    `, sprintTypeKey, taskType, taskType, schemaId, ...schemaTenant.params) as { id: number } | undefined;
    if (duplicate) return res.status(409).json({ error: 'A field schema for this sprint type/task type already exists' });

    await db.run(`
      UPDATE task_field_schemas
      SET task_type = ?, schema_json = ?, updated_at = datetime('now')
      WHERE id = ?
        ${schemaTenant.sql}
    `, taskType, JSON.stringify(schema), schemaId, ...schemaTenant.params);

    const updated = await db.get(`
      SELECT ${await tableHasColumn(db, 'task_field_schemas', 'tenant_id') ? 'tenant_id,' : ''} id, sprint_type_key, task_type, schema_json, is_system, created_at, updated_at
      FROM task_field_schemas
      WHERE id = ?
        ${schemaTenant.sql}
    `, schemaId, ...schemaTenant.params) as TaskFieldSchemaRow;

    return res.json({
      ...updated,
      schema: parseFieldSchema(JSON.parse(updated.schema_json || '{}')),
    });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete('/types/:key/field-schemas/:schemaId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const schemaTenant = await configTenantPredicate(db, 'task_field_schemas', tenantId);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const schemaId = Number(req.params.schemaId);

    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });

    const result = await db.run(`
      DELETE FROM task_field_schemas
      WHERE id = ? AND sprint_type_key = ?
        ${schemaTenant.sql}
    `, schemaId, sprintTypeKey, ...schemaTenant.params);

    if (result.changes === 0) return res.status(404).json({ error: 'Field schema not found' });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/types/:key/relationship-types', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });

    return res.json({ relationship_types: await listRelationshipTypesForSprintType(db, sprintTypeKey, tenantId) });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/types/:key/relationship-types/:relationshipTypeId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const relationshipTypeId = Number(req.params.relationshipTypeId);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });
    const row = await getRelationshipTypeRow(db, sprintTypeKey, relationshipTypeId, tenantId);
    if (!row) return res.status(404).json({ error: 'Relationship type not found' });
    return res.json(shapeRelationshipType(row));
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post('/types/:key/relationship-types', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });

    const payload = validateRelationshipTypePayload(req.body ?? {});
    const tenant = await configTenantPredicate(db, 'sprint_type_relationship_types', tenantId);
    const duplicate = await db.get(`
      SELECT id FROM sprint_type_relationship_types WHERE sprint_type_key = ? AND key = ?
        ${tenant.sql}
    `, sprintTypeKey, payload.key, ...tenant.params) as { id: number } | undefined;
    if (duplicate) return res.status(409).json({ error: 'A relationship type with this key already exists for this sprint type' });

    const isSystem = Number(req.body?.is_system ?? 0) ? 1 : 0;
    const insertTenant = await configTenantInsertFragment(db, 'sprint_type_relationship_types', tenantId);
    const result = await db.run(`
      INSERT INTO sprint_type_relationship_types (
        ${insertTenant.columns}sprint_type_key, key, label, inverse_label, category, affects_dispatch_eligibility, direction_semantics,
        active_statuses_json, resolved_statuses_json, allow_create_related_task,
        default_related_task_type, default_related_task_status, is_system, metadata_json, created_at, updated_at
      ) VALUES (${insertTenant.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `, ...insertTenant.params, sprintTypeKey, payload.key, payload.label, payload.inverse_label, payload.category, payload.affects_dispatch_eligibility, payload.direction_semantics, JSON.stringify(payload.active_statuses), JSON.stringify(payload.resolved_statuses), payload.allow_create_related_task, payload.default_related_task_type, payload.default_related_task_status, isSystem, JSON.stringify(payload.metadata));

    const created = await getRelationshipTypeRow(db, sprintTypeKey, Number(result.lastInsertId), tenantId);
    return res.status(201).json(created ? shapeRelationshipType(created) : null);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.put('/types/:key/relationship-types/:relationshipTypeId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const relationshipTypeId = Number(req.params.relationshipTypeId);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });
    const existing = await getRelationshipTypeRow(db, sprintTypeKey, relationshipTypeId, tenantId);
    if (!existing) return res.status(404).json({ error: 'Relationship type not found' });

    const payload = validateRelationshipTypePayload({
      key: req.body?.key ?? existing.key,
      label: req.body?.label ?? existing.label,
      inverse_label: req.body?.inverse_label ?? existing.inverse_label,
      category: req.body?.category ?? existing.category,
      affects_dispatch_eligibility: req.body?.affects_dispatch_eligibility ?? existing.affects_dispatch_eligibility,
      direction_semantics: req.body?.direction_semantics ?? existing.direction_semantics,
      active_statuses: req.body?.active_statuses ?? JSON.parse(existing.active_statuses_json || '[]'),
      resolved_statuses: req.body?.resolved_statuses ?? JSON.parse(existing.resolved_statuses_json || '[]'),
      allow_create_related_task: req.body?.allow_create_related_task ?? existing.allow_create_related_task,
      default_related_task_type: req.body?.default_related_task_type ?? existing.default_related_task_type,
      default_related_task_status: req.body?.default_related_task_status ?? existing.default_related_task_status,
      metadata: req.body?.metadata ?? JSON.parse(existing.metadata_json || '{}'),
    });
    const tenant = await configTenantPredicate(db, 'sprint_type_relationship_types', tenantId);
    const duplicate = await db.get(`
      SELECT id FROM sprint_type_relationship_types WHERE sprint_type_key = ? AND key = ? AND id != ?
        ${tenant.sql}
    `, sprintTypeKey, payload.key, relationshipTypeId, ...tenant.params) as { id: number } | undefined;
    if (duplicate) return res.status(409).json({ error: 'A relationship type with this key already exists for this sprint type' });
    const isSystem = req.body?.is_system === undefined ? Number(existing.is_system ?? 0) : (Number(req.body?.is_system) ? 1 : 0);

    await db.run(`
      UPDATE sprint_type_relationship_types
      SET key = ?, label = ?, inverse_label = ?, category = ?, affects_dispatch_eligibility = ?, direction_semantics = ?,
          active_statuses_json = ?, resolved_statuses_json = ?, allow_create_related_task = ?,
          default_related_task_type = ?, default_related_task_status = ?, is_system = ?, metadata_json = ?, updated_at = datetime('now')
      WHERE id = ?
        ${tenant.sql}
    `, payload.key, payload.label, payload.inverse_label, payload.category, payload.affects_dispatch_eligibility, payload.direction_semantics, JSON.stringify(payload.active_statuses), JSON.stringify(payload.resolved_statuses), payload.allow_create_related_task, payload.default_related_task_type, payload.default_related_task_status, isSystem, JSON.stringify(payload.metadata), relationshipTypeId, ...tenant.params);

    const updated = await getRelationshipTypeRow(db, sprintTypeKey, relationshipTypeId, tenantId);
    return res.json(updated ? shapeRelationshipType(updated) : null);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete('/types/:key/relationship-types/:relationshipTypeId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const relationshipTypeId = Number(req.params.relationshipTypeId);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });
    const existing = await getRelationshipTypeRow(db, sprintTypeKey, relationshipTypeId, tenantId);
    if (!existing) return res.status(404).json({ error: 'Relationship type not found' });
    const usage = (await db.get(`
      SELECT COUNT(*) AS n FROM task_relationships WHERE relationship_type_key = ?
    `, existing.key) as { n: number }).n;
    if (usage > 0) {
      return res.status(409).json({ error: `Cannot delete relationship type "${existing.key}": ${usage} relationship(s) use it`, reason: 'relationships_in_use', relationship_count: usage });
    }

    const tenant = await configTenantPredicate(db, 'sprint_type_relationship_types', tenantId);
    await db.run(`DELETE FROM sprint_type_relationship_types WHERE id = ? AND sprint_type_key = ?${tenant.sql}`, relationshipTypeId, sprintTypeKey, ...tenant.params);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/types/:key/outcomes', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });

    return res.json({
      outcomes: await getOutcomesForSprintType(db, sprintTypeKey, tenantId),
      resolved_outcomes: await getResolvedOutcomesForSprintType(db, sprintTypeKey, tenantId),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get('/types/:key/outcomes/:outcomeId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const outcomeId = Number(req.params.outcomeId);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });
    const tenant = await configTenantPredicate(db, 'sprint_type_outcomes', tenantId);
    const row = await db.get(`
      SELECT id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at
      FROM sprint_type_outcomes
      WHERE id = ? AND sprint_type_key = ?
        ${tenant.sql}
    `, outcomeId, sprintTypeKey, ...tenant.params) as SprintTypeOutcomeRow | undefined;
    if (!row) return res.status(404).json({ error: 'Outcome definition not found' });
    return res.json({ ...row, metadata: JSON.parse(row.metadata_json || '{}') });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post('/types/:key/outcomes', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });

    const payload = validateOutcomePayload(req.body ?? {});
    const tenant = await configTenantPredicate(db, 'sprint_type_outcomes', tenantId);
    const duplicate = await db.get(`
      SELECT id FROM sprint_type_outcomes
      WHERE sprint_type_key = ?
        AND (task_type = ? OR (task_type IS NULL AND ? IS NULL))
        AND outcome_key = ?
        ${tenant.sql}
    `, sprintTypeKey, payload.task_type, payload.task_type, payload.outcome_key, ...tenant.params) as { id: number } | undefined;
    if (duplicate) return res.status(409).json({ error: 'An outcome definition for this sprint type/task type already exists' });

    const isSystem = Number(req.body?.is_system ?? 0) ? 1 : 0;
    const insertTenant = await configTenantInsertFragment(db, 'sprint_type_outcomes', tenantId);
    const result = await db.run(`
      INSERT INTO sprint_type_outcomes (${insertTenant.columns}sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at)
      VALUES (${insertTenant.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `, ...insertTenant.params, sprintTypeKey, payload.task_type, payload.outcome_key, payload.label, payload.description, payload.enabled, payload.behavior, payload.badge_variant, payload.stage_order, isSystem, JSON.stringify(payload.metadata));

    const created = await db.get(`
      SELECT id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at
      FROM sprint_type_outcomes
      WHERE id = ?
    `, Number(result.lastInsertId)) as SprintTypeOutcomeRow;

    return res.status(201).json({ ...created, metadata: JSON.parse(created.metadata_json || '{}') });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.put('/types/:key/outcomes/:outcomeId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const outcomeId = Number(req.params.outcomeId);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });

    const tenant = await configTenantPredicate(db, 'sprint_type_outcomes', tenantId);
    const existing = await db.get(`
      SELECT id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at
      FROM sprint_type_outcomes
      WHERE id = ? AND sprint_type_key = ?
        ${tenant.sql}
    `, outcomeId, sprintTypeKey, ...tenant.params) as SprintTypeOutcomeRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Outcome definition not found' });

    const payload = validateOutcomePayload({
      task_type: req.body?.task_type ?? existing.task_type,
      outcome_key: req.body?.outcome_key ?? existing.outcome_key,
      label: req.body?.label ?? existing.label,
      description: req.body?.description ?? existing.description,
      enabled: req.body?.enabled ?? existing.enabled,
      behavior: req.body?.behavior ?? existing.behavior,
      badge_variant: req.body?.badge_variant ?? existing.badge_variant,
      stage_order: req.body?.stage_order ?? existing.stage_order,
      metadata: req.body?.metadata ?? JSON.parse(existing.metadata_json || '{}'),
    });
    const isSystem = req.body?.is_system === undefined ? Number(existing.is_system ?? 0) : (Number(req.body?.is_system) ? 1 : 0);

    const duplicate = await db.get(`
      SELECT id FROM sprint_type_outcomes
      WHERE sprint_type_key = ?
        AND (task_type = ? OR (task_type IS NULL AND ? IS NULL))
        AND outcome_key = ?
        AND id != ?
        ${tenant.sql}
    `, sprintTypeKey, payload.task_type, payload.task_type, payload.outcome_key, outcomeId, ...tenant.params) as { id: number } | undefined;
    if (duplicate) return res.status(409).json({ error: 'An outcome definition for this sprint type/task type already exists' });

    await db.run(`
      UPDATE sprint_type_outcomes
      SET task_type = ?, outcome_key = ?, label = ?, description = ?, enabled = ?, behavior = ?, badge_variant = ?, stage_order = ?, is_system = ?, metadata_json = ?, updated_at = datetime('now')
      WHERE id = ?
        ${tenant.sql}
    `, payload.task_type, payload.outcome_key, payload.label, payload.description, payload.enabled, payload.behavior, payload.badge_variant, payload.stage_order, isSystem, JSON.stringify(payload.metadata), outcomeId, ...tenant.params);

    const updated = await db.get(`
      SELECT id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at
      FROM sprint_type_outcomes
      WHERE id = ?
    `, outcomeId) as SprintTypeOutcomeRow;

    return res.json({ ...updated, metadata: JSON.parse(updated.metadata_json || '{}') });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete('/types/:key/outcomes/:outcomeId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const sprintTypeKey = resolveSprintTypeOrNull(req.params.key);
    const outcomeId = Number(req.params.outcomeId);
    if (!sprintTypeKey) return res.status(400).json({ error: 'Sprint type key is required' });
    if (!await getSprintTypeOr404(db, sprintTypeKey, tenantId)) return res.status(404).json({ error: 'Sprint type not found' });
    const tenant = await configTenantPredicate(db, 'sprint_type_outcomes', tenantId);

    const result = await db.run(`
      DELETE FROM sprint_type_outcomes
      WHERE id = ? AND sprint_type_key = ?
        ${tenant.sql}
    `, outcomeId, sprintTypeKey, ...tenant.params);

    if (result.changes === 0) return res.status(404).json({ error: 'Outcome definition not found' });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
