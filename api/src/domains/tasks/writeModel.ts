import fs from 'fs';
import { cleanupTaskExecutionLinkageForStatus } from '../../lib/taskLifecycle';
import { assertAtlasDirectStatusGate, assertTaskStatusUpdateAllowed } from '../../lib/taskRelease';
import { notifyTaskStatusChange } from '../../lib/taskNotifications';
import { createRelationshipFromBlockedBy, createTaskRelationship, deleteTaskRelationshipByTuple } from './relationships';
import { assertTaskStatusDefinedForWorkflow } from '../../lib/taskStatusValidation';
import { isTaskTypeAllowedForSprintType, normalizeConfigKey } from '../sprint-definitions/config';
import {
  normalizeStoryPoints,
  parseCustomFields,
  resolveSprintTypeForTask,
  resolveTaskFieldSchema,
  validateTaskCustomFields,
} from './fields';
import { emitTaskEvent } from './history';
import {
  addTaskNote,
  logHistory,
  maybeTriggerDispatch,
  replaceTaskBlockers,
  resolveTaskBlockers,
  taskTableHasColumn,
  updateTaskEvidence,
  type TaskBlockerInput,
} from './mutations';
import { syncTaskActiveAgentFromInstance } from './ownership';
import { enrichTask, getTaskById, TASK_SELECT, type TaskRecord } from './readModel';
import { resolveRuntimeTenantId, tenantInsertColumns } from '../../lib/runtimeTenantScope';
import { TASK_LIFECYCLE_EVIDENCE_FIELD_KEYS } from './evidence';
import { type Db } from "../../db/adapter/types";

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  job_id?: number | null;
  agent_id?: number | null;
  project_id?: number | null;
  sprint_id?: number | null;
  recurring?: number | boolean;
  task_type?: string | null;
  story_points?: number | string | null;
  origin_task_id?: number | null;
  defect_type?: string | null;
  recurring_series_id?: number | null;
  scheduled_for?: string | null;
  schedule_run_id?: number | null;
  generated_from?: string | null;
  blockers?: number[];
  relationships?: TaskCreateRelationshipInput[];
  custom_fields?: Record<string, unknown> | string | null;
  tenant_id?: number | null;
}

export interface TaskCreateRelationshipInput {
  target_task_id?: number | string | null;
  relationship_type_key?: string | null;
  type_key?: string | null;
  metadata?: Record<string, unknown> | string | null;
  metadata_json?: Record<string, unknown> | string | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  job_id?: number | null;
  agent_id?: number | null;
  project_id?: number | null;
  sprint_id?: number | null;
  recurring?: number | boolean;
  branch_url?: string | null;
  task_type?: string | null;
  story_points?: number | string | null;
  origin_task_id?: number | null;
  defect_type?: string | null;
  blockers?: TaskBlockerInput[];
  custom_fields?: Record<string, unknown> | string | null;
}

export interface TaskUpdateActor {
  changedBy: string;
  authorityBy: string;
  isManualOverride: boolean;
}

async function requireExistingTaskRow(db: Db, taskId: number): Promise<TaskRecord> {
  const existing = await db.get('SELECT * FROM tasks WHERE id = ?', taskId) as TaskRecord | undefined;
  if (!existing) {
    const error = new Error('Task not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  return existing;
}

async function requireEnrichedTask(db: Db, taskId: number): Promise<TaskRecord> {
  const task = await getTaskById(db, taskId);
  if (!task) {
    const error = new Error('Task not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  return task;
}

function requireSameTenant(
  actualTenantId: number | null | undefined,
  expectedTenantId: number | null | undefined,
  message: string,
): void {
  if (actualTenantId == null || expectedTenantId == null) return;
  if (actualTenantId !== expectedTenantId) throw new Error(message);
}

async function taskTenantId(db: Db, taskId: number): Promise<number | null | undefined> {
  return (await db.get('SELECT tenant_id FROM tasks WHERE id = ?', taskId) as { tenant_id: number | null } | undefined)?.tenant_id;
}

function normalizeOptionalTaskType(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  return normalizeConfigKey(raw, 'task_type');
}

async function syncSpawnedDefectMetric(db: Db, originTaskId: number | null | undefined): Promise<void> {
  if (originTaskId == null) return;
  const row = await db.get('SELECT COUNT(*) as count FROM tasks WHERE origin_task_id = ?', originTaskId) as { count: number };
  await db.run(`
    INSERT INTO task_outcome_metrics (task_id, spawned_defects, updated_at)
    VALUES (?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
    ON CONFLICT(task_id) DO UPDATE SET
      spawned_defects = excluded.spawned_defects,
      updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
  `, originTaskId, row.count);
}

async function syncDefectRelationship(
  db: Db,
  taskId: number,
  previousOriginTaskId: number | null | undefined,
  nextOriginTaskId: number | null | undefined,
  defectType: string | null | undefined,
): Promise<void> {
  try {
    if (previousOriginTaskId != null && previousOriginTaskId !== nextOriginTaskId) {
      await deleteTaskRelationshipByTuple(db, taskId, previousOriginTaskId, 'defect_of');
    }
    if (nextOriginTaskId != null) {
      await createTaskRelationship(db, {
                source_task_id: taskId,
                target_task_id: nextOriginTaskId,
                relationship_type_key: 'defect_of',
                metadata_json: defectType ? { legacy_defect_type: defectType } : {},
                created_by: 'legacy-origin_task_id-field',
              });
    }
  } catch {
    // Preserve legacy origin_task_id / defect_type writes on minimal DBs without relationship config.
  }
}

export async function createTaskRecord(
  db: Db,
  input: CreateTaskInput,
  createdBy: string,
): Promise<TaskRecord> {
  const {
    title,
    description = '',
    status = 'todo',
    priority = 'medium',
    job_id,
    agent_id,
    project_id,
    sprint_id,
    recurring = 0,
    task_type,
    story_points,
    origin_task_id,
    defect_type,
    recurring_series_id,
    scheduled_for,
    schedule_run_id,
    generated_from,
    blockers,
    relationships,
    custom_fields,
  } = input;

  const normalizedStoryPoints = normalizeStoryPoints(story_points);
  const normalizedTaskType = normalizeOptionalTaskType(task_type);
  const normalizedCustomFields = parseCustomFields(custom_fields);
  let resolvedProjectId = project_id ?? null;
  let resolvedSprintId = sprint_id ?? null;
  const resolvedAgentId = agent_id ?? job_id ?? null;
  let resolvedTenantId = input.tenant_id ?? null;

  if (!title) throw new Error('title is required');
  if (resolvedSprintId == null) {
    throw Object.assign(new Error('sprint_id is required'), { status: 400 });
  }
  if (origin_task_id != null) {
    const originExists = await db.get('SELECT id, tenant_id FROM tasks WHERE id = ?', origin_task_id) as { id: number; tenant_id: number | null } | undefined;
    if (!originExists) throw new Error(`origin_task_id ${origin_task_id} does not exist`);
    requireSameTenant(originExists.tenant_id, resolvedTenantId, `origin_task_id ${origin_task_id} is not in the same workspace`);
  }
  if (resolvedProjectId != null) {
    const projectExists = await db.get('SELECT id, tenant_id FROM projects WHERE id = ?', resolvedProjectId) as { id: number; tenant_id: number | null } | undefined;
    if (!projectExists) throw new Error(`project_id ${resolvedProjectId} does not exist`);
    resolvedTenantId = resolvedTenantId ?? projectExists.tenant_id ?? null;
    requireSameTenant(projectExists.tenant_id, resolvedTenantId, `project_id ${resolvedProjectId} is not in the same workspace`);
  }
  const sprintExists = await db.get('SELECT id, project_id, tenant_id FROM sprints WHERE id = ?', resolvedSprintId) as { id: number; project_id: number | null; tenant_id: number | null } | undefined;
  if (!sprintExists) throw new Error(`sprint_id ${resolvedSprintId} does not exist`);
  resolvedTenantId = resolvedTenantId ?? sprintExists.tenant_id ?? null;
  requireSameTenant(sprintExists.tenant_id, resolvedTenantId, `sprint_id ${resolvedSprintId} is not in the same workspace`);
  resolvedProjectId = resolvedProjectId ?? sprintExists.project_id;
  if (resolvedProjectId != null && sprintExists.project_id !== resolvedProjectId) {
    throw new Error(`sprint_id ${resolvedSprintId} does not belong to project_id ${resolvedProjectId}`);
  }
  if (resolvedAgentId != null) {
    const agentExists = await db.get('SELECT id, tenant_id FROM agents WHERE id = ?', resolvedAgentId) as { id: number; tenant_id: number | null } | undefined;
    if (!agentExists) throw new Error(`agent_id ${resolvedAgentId} does not exist`);
    requireSameTenant(agentExists.tenant_id, resolvedTenantId, `agent_id ${resolvedAgentId} is not in the same workspace`);
  }
  if (recurring_series_id != null) {
    const seriesExists = await db.get('SELECT id, tenant_id FROM recurring_task_series WHERE id = ?', recurring_series_id) as { id: number; tenant_id: number | null } | undefined;
    if (!seriesExists) throw new Error(`recurring_series_id ${recurring_series_id} does not exist`);
    requireSameTenant(seriesExists.tenant_id, resolvedTenantId, `recurring_series_id ${recurring_series_id} is not in the same workspace`);
  }
  if (schedule_run_id != null) {
    const runExists = await db.get(`
      SELECT r.id, s.tenant_id
      FROM recurring_task_runs r
      LEFT JOIN recurring_task_series s ON s.id = r.series_id
      WHERE r.id = ?
    `, schedule_run_id) as { id: number; tenant_id: number | null } | undefined;
    if (!runExists) throw new Error(`schedule_run_id ${schedule_run_id} does not exist`);
    requireSameTenant(runExists.tenant_id, resolvedTenantId, `schedule_run_id ${schedule_run_id} is not in the same workspace`);
  }

  const resolvedFieldSchema = await resolveTaskFieldSchema(resolvedSprintId, normalizedTaskType ?? null);
  if (typeof normalizedTaskType === 'string' && !await isTaskTypeAllowedForSprintType(db, resolvedFieldSchema.sprint_type, normalizedTaskType)) {
    throw new Error(`task_type "${normalizedTaskType}" is not allowed for sprint type "${resolvedFieldSchema.sprint_type}"`);
  }
  if (status !== undefined && status !== null) {
    await assertTaskStatusDefinedForWorkflow(db, status, { sprintId: resolvedSprintId, sprintType: resolvedFieldSchema.sprint_type });
  }
  validateTaskCustomFields(normalizedCustomFields, resolvedFieldSchema.schema);

  const { validBlockerIds, invalidBlockerIds } = await resolveTaskBlockers(blockers);
  const normalizedRelationships = Array.isArray(relationships)
    ? relationships
      .map((relationship) => ({
        target_task_id: Number(relationship?.target_task_id),
        relationship_type_key: relationship?.relationship_type_key ?? relationship?.type_key,
        metadata_json: relationship?.metadata_json ?? relationship?.metadata ?? {},
      }))
      .filter((relationship) => Number.isInteger(relationship.target_task_id) && relationship.target_task_id > 0)
    : [];

  if (normalizedRelationships.length > 0 && resolvedTenantId != null) {
    for (const relationship of normalizedRelationships) {
      const targetTenantId = await db.value<number | null>('SELECT tenant_id FROM tasks WHERE id = ?', relationship.target_task_id);
      if (targetTenantId === undefined) throw new Error(`target_task_id ${relationship.target_task_id} does not exist`);
      requireSameTenant(targetTenantId, resolvedTenantId, `target_task_id ${relationship.target_task_id} is not in the same workspace`);
    }
  }
  if (validBlockerIds.length > 0 && resolvedTenantId != null) {
    for (const blockerId of validBlockerIds) {
      requireSameTenant(await taskTenantId(db, blockerId), resolvedTenantId, `blocker_id ${blockerId} is not in the same workspace`);
    }
  }

  const { taskId, legacyBlockerWarnings } = await db.withTransaction(async (db) => {
    const result = await db.run(`
      INSERT INTO tasks (
        tenant_id, title, description, status, priority, project_id, assigned_agent_id, sprint_id, recurring,
        task_type, story_points, origin_task_id, defect_type,
        recurring_series_id, scheduled_for, schedule_run_id, generated_from,
        custom_fields_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, resolvedTenantId, title, description, status, priority, resolvedProjectId, resolvedAgentId, resolvedSprintId, recurring ? 1 : 0, normalizedTaskType ?? null, normalizedStoryPoints ?? null, origin_task_id ?? null, defect_type ?? null, recurring_series_id ?? null, scheduled_for ?? null, schedule_run_id ?? null, generated_from ?? null, JSON.stringify(normalizedCustomFields));

    const taskId = Number(result.lastInsertId);

    const legacyBlockerWarnings: string[] = [];
    if (validBlockerIds.length > 0) {
      for (const blockerId of validBlockerIds) {
        const legacyResult = await createRelationshipFromBlockedBy(db, taskId, blockerId, 'legacy-blockers-field');
        if (legacyResult.warning) legacyBlockerWarnings.push(legacyResult.warning);
      }
    }

    if (origin_task_id) {
      await syncDefectRelationship(db, taskId, null, origin_task_id, defect_type ?? null);
    }

    for (const relationship of normalizedRelationships) {
      await createTaskRelationship(db, {
                source_task_id: taskId,
                target_task_id: relationship.target_task_id,
                relationship_type_key: relationship.relationship_type_key,
                metadata_json: relationship.metadata_json,
                created_by: createdBy,
              });
    }

    return { taskId, legacyBlockerWarnings };
  });

  if (origin_task_id != null) {
    const existingMetrics = await db.get('SELECT id FROM task_outcome_metrics WHERE task_id = ?', origin_task_id) as { id: number } | undefined;
    if (existingMetrics) {
      await db.run('UPDATE task_outcome_metrics SET spawned_defects = spawned_defects + 1, updated_at = to_char(now() AT TIME ZONE \'utc\', \'YYYY-MM-DD HH24:MI:SS\') WHERE task_id = ?', origin_task_id);
    } else {
      await db.run('INSERT INTO task_outcome_metrics (task_id, spawned_defects) VALUES (?, 1)', origin_task_id);
    }
  }

  await db.run(`
    INSERT INTO task_history (task_id, field, old_value, new_value, changed_by)
    VALUES (?, 'created', NULL, ?, ?)
  `, taskId, title, createdBy);

  const task = await db.get(`${TASK_SELECT} WHERE t.id = ?`, taskId) as TaskRecord;
  if (status === 'ready' || status === 'todo') {
    maybeTriggerDispatch(project_id ?? task.project_id);
  }

  const enriched = await enrichTask(task);
  if (invalidBlockerIds.length > 0) {
    (enriched as Record<string, unknown>).skipped_blocker_ids = invalidBlockerIds;
  }
  if (legacyBlockerWarnings.length > 0) {
    (enriched as Record<string, unknown>).legacy_blocker_warning = [...new Set(legacyBlockerWarnings)].join(' ');
  }
  return enriched;
}

export async function updateTaskRecord(
  db: Db,
  taskId: number,
  input: UpdateTaskInput,
  actor: TaskUpdateActor,
): Promise<TaskRecord> {
  const existing = await requireExistingTaskRow(db, taskId);
  const {
    title,
    description,
    status,
    priority,
    job_id,
    agent_id,
    project_id,
    sprint_id,
    recurring,
    branch_url,
    task_type,
    story_points,
    origin_task_id,
    defect_type,
    blockers,
    custom_fields,
  } = input;

  const topLevelEvidenceFields = TASK_LIFECYCLE_EVIDENCE_FIELD_KEYS.filter((field) =>
    Object.prototype.hasOwnProperty.call(input as Record<string, unknown>, field),
  );
  if (topLevelEvidenceFields.length > 0) {
    throw Object.assign(
      new Error('Top-level lifecycle evidence fields are no longer accepted on task update requests. Put workflow evidence under custom_fields or use the typed lifecycle evidence endpoints.'),
      {
        status: 400,
        body: {
          error: 'Top-level lifecycle evidence fields are no longer accepted on task update requests. Put workflow evidence under custom_fields or use the typed lifecycle evidence endpoints.',
          code: 'top_level_lifecycle_evidence_not_supported',
          fields: topLevelEvidenceFields,
        },
      },
    );
  }

  const normalizedStoryPoints = normalizeStoryPoints(story_points);
  const normalizedTaskType = normalizeOptionalTaskType(task_type);
  const customFieldsProvided = custom_fields !== undefined;
  const existingCustomFields = parseCustomFields(existing.custom_fields_json);
  const normalizedCustomFields = customFieldsProvided
    ? { ...existingCustomFields, ...parseCustomFields(custom_fields) }
    : existingCustomFields;

  if (origin_task_id !== undefined && origin_task_id !== null) {
    if (origin_task_id === taskId) throw new Error('origin_task_id cannot reference the task being updated');
    const originExists = await db.get('SELECT id, tenant_id FROM tasks WHERE id = ?', origin_task_id) as { id: number; tenant_id: number | null } | undefined;
    if (!originExists) throw new Error(`origin_task_id ${origin_task_id} does not exist`);
    requireSameTenant(originExists.tenant_id, existing.tenant_id as number | null | undefined, `origin_task_id ${origin_task_id} is not in the same workspace`);
  }

  const updated = {
    title: title ?? existing.title,
    description: description ?? existing.description,
    status: status ?? existing.status,
    priority: priority ?? existing.priority,
    assigned_agent_id: agent_id !== undefined
      ? (agent_id ?? job_id ?? null)
      : (job_id !== undefined ? (job_id ?? null) : existing.assigned_agent_id),
    project_id: project_id !== undefined ? (project_id ?? null) : existing.project_id,
    sprint_id: sprint_id !== undefined ? (sprint_id ?? null) : existing.sprint_id,
    recurring: recurring !== undefined ? (recurring ? 1 : 0) : existing.recurring,
    branch_url: branch_url !== undefined ? (branch_url ?? null) : existing.branch_url,
    task_type: normalizedTaskType !== undefined ? normalizedTaskType : existing.task_type,
    story_points: normalizedStoryPoints !== undefined ? normalizedStoryPoints : existing.story_points,
    origin_task_id: origin_task_id !== undefined ? (origin_task_id ?? null) : existing.origin_task_id,
    defect_type: defect_type !== undefined ? (defect_type ?? null) : existing.defect_type,
    custom_fields_json: JSON.stringify(normalizedCustomFields),
  };

  if (updated.sprint_id == null) {
    throw Object.assign(new Error('sprint_id is required and cannot be cleared'), { status: 400 });
  }
  if (updated.project_id != null) {
    const projectExists = await db.get('SELECT id, tenant_id FROM projects WHERE id = ?', updated.project_id) as { id: number; tenant_id: number | null } | undefined;
    if (!projectExists) throw new Error(`project_id ${updated.project_id} does not exist`);
    requireSameTenant(projectExists.tenant_id, existing.tenant_id as number | null | undefined, `project_id ${updated.project_id} is not in the same workspace`);
  }
  if (updated.sprint_id != null) {
    const sprintExists = await db.get('SELECT id, project_id, tenant_id FROM sprints WHERE id = ?', updated.sprint_id) as { id: number; project_id: number | null; tenant_id: number | null } | undefined;
    if (!sprintExists) throw new Error(`sprint_id ${updated.sprint_id} does not exist`);
    requireSameTenant(sprintExists.tenant_id, existing.tenant_id as number | null | undefined, `sprint_id ${updated.sprint_id} is not in the same workspace`);
    if (updated.project_id != null && sprintExists.project_id !== updated.project_id) {
      throw new Error(`sprint_id ${updated.sprint_id} does not belong to project_id ${updated.project_id}`);
    }
  }
  if (updated.assigned_agent_id != null) {
    const agentExists = await db.get('SELECT id, tenant_id FROM agents WHERE id = ?', updated.assigned_agent_id) as { id: number; tenant_id: number | null } | undefined;
    if (!agentExists) throw new Error(`agent_id ${updated.assigned_agent_id} does not exist`);
    requireSameTenant(agentExists.tenant_id, existing.tenant_id as number | null | undefined, `agent_id ${updated.assigned_agent_id} is not in the same workspace`);
  }

  const resolvedFieldSchema = await resolveTaskFieldSchema(updated.sprint_id, updated.task_type);
  const resolvedSprintType = await resolveSprintTypeForTask(updated.sprint_id);
  if (typeof updated.task_type === 'string' && !await isTaskTypeAllowedForSprintType(db, resolvedSprintType, updated.task_type)) {
    throw new Error(`task_type "${updated.task_type}" is not allowed for sprint type "${resolvedFieldSchema.sprint_type}"`);
  }
  if (status !== undefined && status !== null) {
    await assertTaskStatusDefinedForWorkflow(db, status, {
            sprintId: (updated.sprint_id as number | null | undefined) ?? null,
            sprintType: resolvedSprintType,
          });
  }
  const shouldValidateCustomFields = customFieldsProvided || sprint_id !== undefined || task_type !== undefined;
  if (shouldValidateCustomFields) {
    validateTaskCustomFields(normalizedCustomFields, resolvedFieldSchema.schema, {
      existingCustomFields,
      allowUnchangedUnknownFields: true,
    });
  }

  assertTaskStatusUpdateAllowed(
    { status: String(existing.status) },
    status,
    actor.authorityBy,
  );

  if (status !== undefined && status !== existing.status && actor.authorityBy === 'Atlas' && !actor.isManualOverride) {
    const existingFieldValues = {
      ...existing,
      ...parseCustomFields(existing.custom_fields_json),
      ...normalizedCustomFields,
    } as Record<string, unknown>;
    await assertAtlasDirectStatusGate(db, {
            id: taskId,
            status: String(existing.status),
            sprint_id: (updated.sprint_id as number | null | undefined) ?? null,
            task_type: (updated.task_type as string | null | undefined) ?? null,
            review_branch: (existingFieldValues.review_branch as string | null | undefined) ?? null,
            review_commit: (existingFieldValues.review_commit as string | null | undefined) ?? null,
            review_url: (existingFieldValues.review_url as string | null | undefined) ?? null,
            qa_verified_commit: (existingFieldValues.qa_verified_commit as string | null | undefined) ?? null,
            qa_tested_url: (existingFieldValues.qa_tested_url as string | null | undefined) ?? null,
            merged_commit: (existingFieldValues.merged_commit as string | null | undefined) ?? null,
            deployed_commit: (existingFieldValues.deployed_commit as string | null | undefined) ?? null,
            deployed_at: (existingFieldValues.deployed_at as string | null | undefined) ?? null,
            live_verified_at: (existingFieldValues.live_verified_at as string | null | undefined) ?? null,
            live_verified_by: (existingFieldValues.live_verified_by as string | null | undefined) ?? null,
            deploy_target: (existingFieldValues.deploy_target as string | null | undefined) ?? null,
            evidence_json: (existingFieldValues.evidence_json as string | null | undefined) ?? null,
          }, status);
  }

  const trackedFields: Array<keyof typeof updated> = ['status', 'priority', 'title', 'sprint_id', 'assigned_agent_id', 'branch_url', 'task_type', 'story_points', 'origin_task_id', 'defect_type', 'custom_fields_json'];
  for (const field of trackedFields) {
    const oldValue = existing[field];
    const newValue = updated[field];
    if (String(oldValue ?? '') !== String(newValue ?? '')) {
      const resolvedOld: string | null = oldValue == null ? null : String(oldValue);
      const resolvedNew: string | null = newValue == null ? null : String(newValue);
      await logHistory(taskId, actor.changedBy, field, resolvedOld, resolvedNew);
    }
  }

  await db.run(`
    UPDATE tasks SET
      title = ?, description = ?, status = ?, priority = ?,
      project_id = ?, assigned_agent_id = ?, sprint_id = ?, recurring = ?,
      branch_url = ?, task_type = ?, story_points = ?,
      origin_task_id = ?, defect_type = ?, custom_fields_json = ?,
      updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
  `, updated.title, updated.description, updated.status, updated.priority, updated.project_id, updated.assigned_agent_id, updated.sprint_id, updated.recurring, updated.branch_url, updated.task_type, updated.story_points, updated.origin_task_id, updated.defect_type, updated.custom_fields_json, taskId);

  const originRelationshipChanged = origin_task_id !== undefined && String(existing.origin_task_id ?? '') !== String(updated.origin_task_id ?? '');
  const defectMetadataChanged = defect_type !== undefined && String(existing.defect_type ?? '') !== String(updated.defect_type ?? '');
  if (originRelationshipChanged) {
    await syncSpawnedDefectMetric(db, existing.origin_task_id as number | null | undefined);
    await syncSpawnedDefectMetric(db, updated.origin_task_id as number | null | undefined);
  }
  if (originRelationshipChanged || defectMetadataChanged) {
    await syncDefectRelationship(
            db,
            taskId,
            existing.origin_task_id as number | null | undefined,
            updated.origin_task_id as number | null | undefined,
            updated.defect_type as string | null | undefined,
          );
  }

  if (Array.isArray(blockers)) {
    for (const blocker of blockers) {
      const blockerId = Number(blocker?.task_id ?? blocker?.blocker_id);
      if (!Number.isInteger(blockerId) || blockerId <= 0 || blockerId === taskId) continue;
      const blockerTenantId = await taskTenantId(db, blockerId);
      if (blockerTenantId === undefined) continue;
      requireSameTenant(blockerTenantId, existing.tenant_id as number | null | undefined, `blocker_id ${blockerId} is not in the same workspace`);
    }
    await replaceTaskBlockers(taskId, blockers);
  }

  await cleanupTaskExecutionLinkageForStatus(db, taskId, String(updated.status));

  const isManualStatusChange = status !== undefined
    && String(status) !== String(existing.status)
    && !['eligibility', 'reconciler', 'watchdog', 'task_lifecycle', 'scheduler', 'system', 'dispatcher', 'task_outcome'].includes(String(actor.changedBy));

  if (isManualStatusChange && await taskTableHasColumn(db, 'manual_intervention_count')) {
    await db.run('UPDATE tasks SET manual_intervention_count = manual_intervention_count + 1 WHERE id = ?', taskId);
  }

  if (status !== undefined && String(status) !== String(existing.status)) {
    await notifyTaskStatusChange(db, {
            taskId,
            fromStatus: String(existing.status),
            toStatus: String(status),
            source: String(actor.changedBy),
          });

    await emitTaskEvent(db, {
            taskId,
            fromStatus: String(existing.status),
            toStatus: String(status),
            movedBy: String(actor.changedBy),
            moveType: isManualStatusChange ? 'manual' : 'automatic',
            projectId: (existing.project_id as number | null) ?? null,
            agentId: (existing.assigned_agent_id as number | null) ?? null,
          });
  }

  await syncTaskActiveAgentFromInstance(db, taskId);

  return await requireEnrichedTask(db, taskId);
}

export async function cancelTaskRecord(db: Db, taskId: number, changedBy: string) {
  const existing = await requireExistingTaskRow(db, taskId);
  const oldStatus = String(existing.status);

  await db.run('UPDATE tasks SET status = \'cancelled\', updated_at = to_char(now() AT TIME ZONE \'utc\', \'YYYY-MM-DD HH24:MI:SS\') WHERE id = ?', taskId);
  await cleanupTaskExecutionLinkageForStatus(db, taskId, 'cancelled');
  await logHistory(taskId, changedBy, 'status', oldStatus, 'cancelled');
  await addTaskNote(taskId, changedBy, 'Task cancelled by user.');

  await notifyTaskStatusChange(db, {
        taskId,
        fromStatus: oldStatus,
        toStatus: 'cancelled',
        source: changedBy,
      });

  return { ok: true, task: await requireEnrichedTask(db, taskId) };
}

export async function reopenTaskRecord(db: Db, taskId: number, changedBy: string) {
  const existing = await requireExistingTaskRow(db, taskId);
  if (existing.status !== 'failed') {
    throw Object.assign(new Error(`Cannot reopen a task in '${existing.status}' status. Only 'failed' tasks can be reopened.`), { status: 400 });
  }

  const restoreStatus = (existing.previous_status as string | null) ?? 'ready';
  await db.run(`
    UPDATE tasks
    SET status = ?,
        previous_status = NULL,
        failure_detail = NULL,
        updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
  `, restoreStatus, taskId);

  await cleanupTaskExecutionLinkageForStatus(db, taskId, restoreStatus);
  await logHistory(taskId, changedBy, 'status', String(existing.status), restoreStatus);
  await addTaskNote(taskId, changedBy, `Task reopened — restored to '${restoreStatus}'${existing.previous_status ? ' (previous position)' : ' (default fallback)'}.`);

  await notifyTaskStatusChange(db, {
        taskId,
        fromStatus: String(existing.status),
        toStatus: restoreStatus,
        source: changedBy,
      });

  if (restoreStatus === 'ready') {
    maybeTriggerDispatch((existing.project_id as number | null) ?? undefined);
  }

  return { ok: true, restored_to: restoreStatus, task: await requireEnrichedTask(db, taskId) };
}

export async function pauseTaskRecord(db: Db, taskId: number, changedBy: string, pauseReason: string | null) {
  const existing = await requireExistingTaskRow(db, taskId);
  const terminalStatuses = ['done', 'cancelled', 'failed'];
  if (terminalStatuses.includes(String(existing.status))) {
    throw Object.assign(new Error(`Cannot pause a task in terminal status '${existing.status}'`), { status: 400 });
  }
  if (existing.paused_at) {
    throw Object.assign(new Error('Task is already paused'), { status: 400 });
  }

  await db.run(`
    UPDATE tasks SET paused_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), pause_reason = ?, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?
  `, pauseReason, taskId);

  await logHistory(taskId, changedBy, 'paused_at', null, new Date().toISOString());
  await addTaskNote(taskId, changedBy, pauseReason ? `Task paused: ${pauseReason}` : 'Task paused by user.');

  return { ok: true, task: await requireEnrichedTask(db, taskId) };
}

export async function unpauseTaskRecord(db: Db, taskId: number, changedBy: string) {
  const existing = await requireExistingTaskRow(db, taskId);
  if (!existing.paused_at) {
    throw Object.assign(new Error('Task is not paused'), { status: 400 });
  }

  await db.run(`
    UPDATE tasks SET paused_at = NULL, pause_reason = NULL, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?
  `, taskId);

  await logHistory(taskId, changedBy, 'paused_at', existing.paused_at as string, null);
  await addTaskNote(taskId, changedBy, 'Task unpaused — routing and dispatch eligibility restored.');

  return { ok: true, task: await requireEnrichedTask(db, taskId) };
}

export async function createTaskNoteRecord(db: Db, taskId: number, author: string, content: string) {
  const task = await db.get('SELECT id FROM tasks WHERE id = ?', taskId);
  if (!task) {
    const error = new Error('Task not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  if (!content) {
    const error = new Error('content is required') as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  const tenantId = await resolveRuntimeTenantId(db, { taskId });
  const tenant = await tenantInsertColumns(db, 'task_notes', tenantId);
  const result = await db.run(`
    INSERT INTO task_notes (${tenant.columnSql}task_id, author, content) VALUES (${tenant.valueSql}?, ?, ?)
  `, ...tenant.values, taskId, author, content);

  return await db.get('SELECT * FROM task_notes WHERE id = ?', result.lastInsertId);
}

export async function addTaskBlockerRecord(db: Db, taskId: number, blockerId: number): Promise<TaskRecord> {
  if (!blockerId) {
    const error = new Error('blocker_id is required') as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  if (blockerId === taskId) {
    const error = new Error('A task cannot block itself') as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  const blockedTask = await db.get('SELECT id FROM tasks WHERE id = ?', taskId);
  if (!blockedTask) {
    const error = new Error('Task not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }

  const blockerTask = await db.get('SELECT id FROM tasks WHERE id = ?', blockerId);
  if (!blockerTask) {
    const error = new Error('Blocker task not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }

  const legacyResult = await createRelationshipFromBlockedBy(db, taskId, blockerId);

  const task = await requireEnrichedTask(db, taskId);
  if (legacyResult.warning) task.legacy_blocker_warning = legacyResult.warning;
  return task;
}

export async function removeTaskBlockerRecord(db: Db, taskId: number, blockerId: number): Promise<TaskRecord> {
  await deleteTaskRelationshipByTuple(db, taskId, blockerId, 'blocked_by');
  await db.run('DELETE FROM task_dependencies WHERE blocker_id = ? AND blocked_id = ?', blockerId, taskId);
  return await requireEnrichedTask(db, taskId);
}

export async function deleteTaskRecord(db: Db, taskId: number, deletedBy: string) {
  const existing = await requireExistingTaskRow(db, taskId);

  const attachments = await db.all('SELECT filepath FROM task_attachments WHERE task_id = ?', taskId) as Array<{ filepath: string }>;
  for (const attachment of attachments) {
    try {
      fs.unlinkSync(attachment.filepath);
    } catch {
      // file may already be gone
    }
  }

  await db.run(`
    INSERT INTO task_history (task_id, changed_by, field, old_value, new_value)
    VALUES (?, ?, 'deleted', ?, NULL)
  `, taskId, deletedBy, String(existing.title ?? ''));

  await db.run('DELETE FROM tasks WHERE id = ?', taskId);

  return { ok: true, deleted_id: taskId, deleted_title: existing.title ?? null };
}
