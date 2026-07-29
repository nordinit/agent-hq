import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { validateReviewEvidence } from '../lib/evidenceValidation';
import { getMcpIdentityFromRequest, type McpApiIdentity } from '../lib/mcpApiAuth';
import { notifyTaskStatusChange } from '../lib/taskNotifications';
import { getCanonicalTaskCustomFields } from '../domains/tasks/evidence';
import { writeTaskHistory, writeTaskStatusChange } from '../domains/tasks/history';
import { applyTaskOutcome, RefusedTaskOutcomeError } from '../lib/taskOutcome';
import {
  DEV_ENV_LEASE_MANAGER_SOURCE,
  resolveWorkflowEventMapping,
  type WorkflowEventMapping,
} from '../domains/routing/externalEventMappings';
import { type Db } from "../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../db/introspection";

export { DEV_ENV_LEASE_MANAGER_SOURCE };

type NormalizedExternalTaskEvent = {
  source: string;
  event: string;
  taskId: number;
  environmentId: string;
  queueId: string;
  leaseId: string;
  branch: string | null;
  commitSha: string | null;
  reviewUrl: string | null;
  failureClass: string | null;
  phase: string | null;
  error: Record<string, unknown> | null;
  message: string;
};

type TaskRow = {
  id: number;
  tenant_id: number | null;
  status: string;
  task_type: string | null;
  project_id: number | null;
  sprint_id: number | null;
  sprint_type: string | null;
  agent_id: number | null;
  active_instance_id: number | null;
};

type ReceiptProcessingState = 'received' | 'processed' | 'rejected' | 'duplicate';

type ExistingReceiptRow = {
  id: number;
  processing_state: string | null;
};

type ExternalTaskEventReceiptRow = {
  id: number;
  fingerprint: string;
  source: string;
  event: string;
  task_id: number;
  environment_id: string;
  queue_id: string;
  lease_id: string;
  branch: string | null;
  commit_sha: string | null;
  review_url: string | null;
  message: string;
  payload_json: string;
  received_by: string;
  processing_state: string | null;
  processing_error: string | null;
  mapping_id: number | null;
  mapping_action_kind: string | null;
  mapping_action_target: string | null;
  request_metadata_json: string | null;
  created_at: string | null;
  processed_at: string | null;
  task_project_id: number | null;
  task_tenant_id: number | null;
  task_status: string | null;
  task_title: string | null;
};

async function tableHasColumn(db: Db, table: string, column: string): Promise<boolean> {
    return await sharedColumnExists(db, table, column);
}

const router = Router();

function buildRequestMetadata(req: Request): Record<string, unknown> {
  return {
    method: req.method,
    path: req.path,
    original_url: req.originalUrl,
    ip: req.ip,
    user_agent: req.get('user-agent') ?? null,
    content_type: req.get('content-type') ?? null,
  };
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeTaskId(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('task_id must be a positive integer');
  }
  return parsed;
}

function normalizeLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 200);
}

function normalizeOffset(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeExternalTaskEvent(body: Record<string, unknown>): NormalizedExternalTaskEvent {
  const source = normalizeRequiredString(body.source, 'source');
  const event = normalizeRequiredString(body.event, 'event');
  const taskId = normalizeTaskId(body.task_id);
  const environmentId = normalizeRequiredString(body.environment_id, 'environment_id');
  const queueId = normalizeRequiredString(body.queue_id, 'queue_id');
  const leaseId = normalizeRequiredString(body.lease_id, 'lease_id');
  const branch = normalizeOptionalString(body.branch);
  const commitSha = normalizeOptionalString(body.commit_sha);
  const reviewUrl = normalizeOptionalString(body.review_url);
  const error = normalizeOptionalRecord(body.error);
  const errorResult = normalizeOptionalRecord(error?.result);
  const errorDeployResult = normalizeOptionalRecord(errorResult?.deploy);
  const failureClass = normalizeOptionalString(body.failure_class)
    ?? normalizeOptionalString(error?.failure_class)
    ?? normalizeOptionalString(errorResult?.failure_class)
    ?? normalizeOptionalString(errorDeployResult?.failure_class)
    ?? normalizeOptionalString(errorDeployResult?.error)
    ?? normalizeOptionalString(errorResult?.error);
  const phase = normalizeOptionalString(body.phase)
    ?? normalizeOptionalString(error?.phase)
    ?? normalizeOptionalString(errorResult?.phase)
    ?? normalizeOptionalString(errorDeployResult?.phase);
  const message = normalizeRequiredString(body.message, 'message');

  if (reviewUrl) {
    try {
      new URL(reviewUrl);
    } catch {
      throw new Error('review_url must be a valid URL');
    }
  }

  return {
    source,
    event,
    taskId,
    environmentId,
    queueId,
    leaseId,
    branch,
    commitSha,
    reviewUrl,
    failureClass,
    phase,
    error,
    message,
  };
}

function assertTrustedExternalSource(identity: McpApiIdentity | null, source: string): asserts identity is McpApiIdentity {
  if (!identity) {
    const error = new Error('MCP API key is required');
    (error as Error & { statusCode?: number; code?: string }).statusCode = 401;
    (error as Error & { statusCode?: number; code?: string }).code = 'mcp_api_key_missing';
    throw error;
  }

  const allowed = source === DEV_ENV_LEASE_MANAGER_SOURCE
    || identity.agentSlug === source
    || identity.agentSlug === 'atlas'
    || identity.systemRole === 'atlas';
  if (!allowed) {
    const error = new Error(`Authenticated agent "${identity.agentSlug}" is not allowed to publish source "${source}"`);
    (error as Error & { statusCode?: number; code?: string }).statusCode = 403;
    (error as Error & { statusCode?: number; code?: string }).code = 'external_task_event_source_forbidden';
    throw error;
  }
}

function buildFingerprint(event: NormalizedExternalTaskEvent): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    source: event.source,
    event: event.event,
    task_id: event.taskId,
    environment_id: event.environmentId,
    queue_id: event.queueId,
    lease_id: event.leaseId,
    branch: event.branch,
    commit_sha: event.commitSha,
    review_url: event.reviewUrl,
    failure_class: event.failureClass,
    phase: event.phase,
    message: event.message,
    error: event.error,
  }), 'utf8').digest('hex');
}

function isUniqueConstraintError(error: unknown, table: string, column: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed') && message.includes(`${table}.${column}`);
}

async function insertReceipt(
  db: Db,
  event: NormalizedExternalTaskEvent,
  fingerprint: string,
  changedBy: string,
  requestMetadata: Record<string, unknown>,
): Promise<number> {
  const columns = [
    'fingerprint',
    'source',
    'event',
    'task_id',
    'environment_id',
    'queue_id',
    'lease_id',
    'branch',
    'commit_sha',
    'review_url',
    'message',
    'payload_json',
    'received_by',
    ...(await tableHasColumn(db, 'external_task_event_receipts', 'processing_state') ? ['processing_state'] : []),
    ...(await tableHasColumn(db, 'external_task_event_receipts', 'request_metadata_json') ? ['request_metadata_json'] : []),
  ];
  const values = [
    fingerprint,
    event.source,
    event.event,
    event.taskId,
    event.environmentId,
    event.queueId,
    event.leaseId,
    event.branch,
    event.commitSha,
    event.reviewUrl,
    event.message,
    JSON.stringify(event),
    changedBy,
    ...(await tableHasColumn(db, 'external_task_event_receipts', 'processing_state') ? ['received'] : []),
    ...(await tableHasColumn(db, 'external_task_event_receipts', 'request_metadata_json') ? [JSON.stringify(requestMetadata)] : []),
  ];

  const placeholders = columns.map(() => '?').join(', ');
  const insertResult = await db.run(`
    INSERT INTO external_task_event_receipts (${columns.join(', ')})
    VALUES (${placeholders})
  `, ...values);
  return Number(insertResult.lastInsertId);
}

async function loadReceiptByFingerprint(db: Db, fingerprint: string): Promise<ExistingReceiptRow | null> {
  const processingStateSelect = await tableHasColumn(db, 'external_task_event_receipts', 'processing_state')
    ? 'processing_state'
    : 'NULL AS processing_state';
  return await db.get(`
    SELECT id, ${processingStateSelect}
    FROM external_task_event_receipts
    WHERE fingerprint = ?
    LIMIT 1
  `, fingerprint) as ExistingReceiptRow | undefined ?? null;
}

async function markReceiptRetrying(db: Db, receiptId: number): Promise<void> {
  const assignments: string[] = [];
  if (await tableHasColumn(db, 'external_task_event_receipts', 'processing_state')) {
    assignments.push(`processing_state = 'received'`);
  }
  if (await tableHasColumn(db, 'external_task_event_receipts', 'processing_error')) {
    assignments.push(`processing_error = NULL`);
  }
  if (await tableHasColumn(db, 'external_task_event_receipts', 'processed_at')) {
    assignments.push(`processed_at = NULL`);
  }
  if (assignments.length === 0) return;

  await db.run(`
    UPDATE external_task_event_receipts
    SET ${assignments.join(', ')}
    WHERE id = ?
  `, receiptId);
}

async function markReceiptProcessed(
  db: Db,
  receiptId: number,
  state: ReceiptProcessingState,
  mapping: WorkflowEventMapping | null,
  error: unknown = null,
): Promise<void> {
  const assignments = ['processed_at = datetime(\'now\')'];
  const values: unknown[] = [];
  const maybeAssign = async (column: string, value: unknown): Promise<void> => {
    if (!await tableHasColumn(db, 'external_task_event_receipts', column)) return;
    assignments.push(`${column} = ?`);
    values.push(value);
  };

  await maybeAssign('processing_state', state);
  await maybeAssign('processing_error', error ? (error instanceof Error ? error.message : String(error)) : null);
  await maybeAssign('mapping_id', mapping?.id ?? null);
  await maybeAssign('mapping_action_kind', mapping?.action_kind ?? null);
  await maybeAssign('mapping_action_target', mapping?.action_target ?? null);

  await db.run(`
    UPDATE external_task_event_receipts
    SET ${assignments.join(', ')}
    WHERE id = ?
  `, ...values, receiptId);
}

async function addTaskNote(taskId: number, author: string, content: string): Promise<void> {
  const db = getDb();
  await db.run(`
    INSERT INTO task_notes (task_id, author, content)
    VALUES (?, ?, ?)
  `, taskId, author, content);
}

async function updateTaskEvidence(taskId: number, changedBy: string, updates: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const existing = await db.get(`SELECT * FROM tasks WHERE id = ?`, taskId) as Record<string, unknown> | undefined;
  if (!existing) throw new Error('Task not found');
  const taskColumns = new Set(await sharedTableColumns(db, 'tasks'));
  const existingCustomFields = taskColumns.has('custom_fields_json') ? getCanonicalTaskCustomFields(existing) : {};

  const requestedKeys = Object.keys(updates).filter((key) => updates[key] !== undefined);
  if (requestedKeys.length === 0) return;

  const activeKeys = requestedKeys.filter((key) => {
    const incoming = updates[key];
    const current = Object.prototype.hasOwnProperty.call(existingCustomFields, key)
      ? existingCustomFields[key]
      : existing[key];
    const incomingIsEmpty = incoming === null || incoming === undefined || incoming === '';
    const currentIsSet = current !== null && current !== undefined && current !== '';
    return !(incomingIsEmpty && currentIsSet);
  });

  if (activeKeys.length === 0) return;

  for (const key of activeKeys) {
    const oldValue = Object.prototype.hasOwnProperty.call(existingCustomFields, key)
      ? existingCustomFields[key]
      : existing[key];
    await writeTaskHistory(db, taskId, changedBy, key, oldValue, updates[key]);
  }

  const nextCustomFields = { ...existingCustomFields };
  for (const key of activeKeys) {
    nextCustomFields[key] = updates[key] ?? null;
  }
  const hasCustomFieldsJson = taskColumns.has('custom_fields_json');
  const shadowColumnKeys = hasCustomFieldsJson ? [] : activeKeys.filter((key) => taskColumns.has(key));
  const assignmentParts = [
    ...(hasCustomFieldsJson ? ['custom_fields_json = ?'] : []),
    ...shadowColumnKeys.map((key) => `${key} = ?`),
  ];
  const assignments = assignmentParts.join(', ');
  const values = [
    ...(hasCustomFieldsJson ? [JSON.stringify(nextCustomFields)] : []),
    ...shadowColumnKeys.map((key) => updates[key]),
  ];
  if (!assignments) return;
  await db.run(`
    UPDATE tasks
    SET ${assignments}, updated_at = datetime('now')
    WHERE id = ?
  `, ...values, taskId);
}

async function loadTask(taskId: number): Promise<TaskRow> {
  const db = getDb();
  const task = await db.get(`
    SELECT tasks.id,
           ${await tableHasColumn(db, 'tasks', 'tenant_id') ? 'tasks.tenant_id' : 'NULL'} AS tenant_id,
           tasks.status,
           tasks.task_type,
           tasks.project_id,
           tasks.sprint_id,
           s.sprint_type,
           tasks.agent_id,
           tasks.active_instance_id
    FROM tasks
    LEFT JOIN sprints s ON s.id = tasks.sprint_id
    WHERE tasks.id = ?
  `, taskId) as TaskRow | undefined;
  if (!task) throw new Error('Task not found');
  return task;
}

async function getAssignedProjectId(db: Db, identity: McpApiIdentity): Promise<number | null> {
  if (!await tableHasColumn(db, 'agents', 'project_id')) return null;
  const hasTenantId = await tableHasColumn(db, 'agents', 'tenant_id');
  const row = await db.get(`
    SELECT project_id
    FROM agents
    WHERE id = ?
      ${hasTenantId ? 'AND tenant_id = ?' : ''}
    LIMIT 1
  `, identity.agentId, ...(hasTenantId ? [identity.tenantId] : [])) as { project_id: number | null } | undefined;
  const parsed = typeof row?.project_id === 'number' ? row.project_id : Number(row?.project_id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function serializeReceipt(row: ExternalTaskEventReceiptRow): Record<string, unknown> {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    source: row.source,
    event: row.event,
    task_id: row.task_id,
    task: {
      id: row.task_id,
      title: row.task_title,
      status: row.task_status,
      project_id: row.task_project_id,
      tenant_id: row.task_tenant_id,
    },
    environment_id: row.environment_id,
    queue_id: row.queue_id,
    lease_id: row.lease_id,
    branch: row.branch,
    commit_sha: row.commit_sha,
    review_url: row.review_url,
    message: row.message,
    payload: parseJsonObject(row.payload_json),
    received_by: row.received_by,
    processing_state: row.processing_state,
    processing_error: row.processing_error,
    mapping_id: row.mapping_id,
    mapping_action_kind: row.mapping_action_kind,
    mapping_action_target: row.mapping_action_target,
    request_metadata: parseJsonObject(row.request_metadata_json),
    created_at: row.created_at,
    processed_at: row.processed_at,
  };
}

async function buildReceiptSelect(db: Db): Promise<string> {
  return `
    SELECT
      r.id,
      r.fingerprint,
      r.source,
      r.event,
      r.task_id,
      r.environment_id,
      r.queue_id,
      r.lease_id,
      r.branch,
      r.commit_sha,
      r.review_url,
      r.message,
      r.payload_json,
      r.received_by,
      ${await tableHasColumn(db, 'external_task_event_receipts', 'processing_state') ? 'r.processing_state' : 'NULL'} AS processing_state,
      ${await tableHasColumn(db, 'external_task_event_receipts', 'processing_error') ? 'r.processing_error' : 'NULL'} AS processing_error,
      ${await tableHasColumn(db, 'external_task_event_receipts', 'mapping_id') ? 'r.mapping_id' : 'NULL'} AS mapping_id,
      ${await tableHasColumn(db, 'external_task_event_receipts', 'mapping_action_kind') ? 'r.mapping_action_kind' : 'NULL'} AS mapping_action_kind,
      ${await tableHasColumn(db, 'external_task_event_receipts', 'mapping_action_target') ? 'r.mapping_action_target' : 'NULL'} AS mapping_action_target,
      ${await tableHasColumn(db, 'external_task_event_receipts', 'request_metadata_json') ? 'r.request_metadata_json' : 'NULL'} AS request_metadata_json,
      r.created_at,
      ${await tableHasColumn(db, 'external_task_event_receipts', 'processed_at') ? 'r.processed_at' : 'NULL'} AS processed_at,
      t.project_id AS task_project_id,
      ${await tableHasColumn(db, 'tasks', 'tenant_id') ? 't.tenant_id' : 'NULL'} AS task_tenant_id,
      t.status AS task_status,
      t.title AS task_title
    FROM external_task_event_receipts r
    JOIN tasks t ON t.id = r.task_id
  `;
}

async function scopedReceiptWhere(db: Db, identity: McpApiIdentity, assignedProjectId: number): Promise<{ clauses: string[]; params: unknown[] }> {
  const clauses = ['t.project_id = ?'];
  const params: unknown[] = [assignedProjectId];
  if (await tableHasColumn(db, 'tasks', 'tenant_id')) {
    clauses.push('t.tenant_id = ?');
    params.push(identity.tenantId);
  }
  return { clauses, params };
}

async function writeWorkflowEventHistory(taskId: number, changedBy: string, event: NormalizedExternalTaskEvent, mapping: WorkflowEventMapping | null): Promise<void> {
  const db = getDb();
  const historyEntries: Array<[string, string | number | null]> = [
    ['external_event_source', event.source],
    ['external_event_name', event.event],
    ['external_environment_id', event.environmentId],
    ['external_queue_id', event.queueId],
    ['external_lease_id', event.leaseId],
    ['external_branch', event.branch],
    ['external_commit_sha', event.commitSha],
    ['external_review_url', event.reviewUrl],
    ['external_failure_class', event.failureClass],
    ['external_phase', event.phase],
    ['external_message', event.message],
    ['external_mapping_id', mapping?.id ?? null],
    ['external_mapping_action_kind', mapping?.action_kind ?? null],
    ['external_mapping_action_target', mapping?.action_target ?? null],
  ];

  for (const [field, value] of historyEntries) {
    await writeTaskHistory(db, taskId, changedBy, field, null, value, false);
  }
}

function buildEventNote(event: NormalizedExternalTaskEvent, mapping: WorkflowEventMapping | null): string {
  const lines = [
    'Workflow event received',
    `Source: ${event.source}`,
    `Event: ${event.event}`,
    `Environment ID: ${event.environmentId}`,
    `Queue ID: ${event.queueId}`,
    `Lease ID: ${event.leaseId}`,
  ];

  if (event.branch) lines.push(`Branch: ${event.branch}`);
  if (event.commitSha) lines.push(`Commit: ${event.commitSha}`);
  if (event.reviewUrl) lines.push(`Review URL: ${event.reviewUrl}`);
  if (event.failureClass) lines.push(`Failure Class: ${event.failureClass}`);
  if (event.phase) lines.push(`Phase: ${event.phase}`);
  lines.push(`Message: ${event.message}`);
  if (mapping) {
    lines.push(`Resolved mapping: #${mapping.id}`);
    lines.push(`Action: ${mapping.action_kind}${mapping.action_target ? ` → ${mapping.action_target}` : ''}`);
  } else {
    lines.push('Resolved mapping: none');
  }

  return lines.join('\n');
}

async function applyExternalTaskStatus(
  task: TaskRow,
  nextStatus: string,
  changedBy: string,
  reason: string,
): Promise<boolean> {
  if (task.status === nextStatus) return false;

  const db = getDb();
  await db.run(`
    UPDATE tasks
    SET status = ?,
        failure_detail = NULL,
        previous_status = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `, nextStatus, task.id);

  await writeTaskStatusChange(db, task.id, changedBy, task.status, nextStatus, {
        instanceId: task.active_instance_id,
        reason,
        projectId: task.project_id,
        agentId: task.agent_id,
      });
  await notifyTaskStatusChange(db, {
        taskId: task.id,
        fromStatus: task.status,
        toStatus: nextStatus,
        source: changedBy,
      });

  return true;
}

function buildFailureDetail(event: NormalizedExternalTaskEvent): string {
  return [
    'Workflow event failure detail',
    `Source: ${event.source}`,
    `Event: ${event.event}`,
    `Environment ID: ${event.environmentId}`,
    `Queue ID: ${event.queueId}`,
    `Lease ID: ${event.leaseId}`,
    ...(event.failureClass ? [`Failure Class: ${event.failureClass}`] : []),
    ...(event.phase ? [`Phase: ${event.phase}`] : []),
    `Message: ${event.message}`,
    ...(event.error ? [`Error: ${JSON.stringify(event.error).slice(0, 2000)}`] : []),
  ].join('\n');
}

function validateReviewEvidenceForMapping(event: NormalizedExternalTaskEvent): void {
  const validation = validateReviewEvidence({
    review_branch: event.branch,
    review_commit: event.commitSha,
    review_url: event.reviewUrl,
  });
  if (!validation.valid) {
    throw new Error(validation.errors[0] ?? 'Review evidence validation failed');
  }
}

router.get('/task-events/receipts', async (req: Request, res: Response) => {
  try {
    const identity = getMcpIdentityFromRequest(req);
    if (!identity) return res.status(401).json({ error: 'MCP API key is required', code: 'mcp_api_key_missing' });

    const db = getDb();
    const assignedProjectId = await getAssignedProjectId(db, identity);
    if (!assignedProjectId) {
      return res.status(403).json({
        error: `${identity.agentSlug} does not have an assigned project for external task-event management.`,
        code: 'mcp_scope_denied',
        details: {
          agent_id: identity.agentId,
          agent_slug: identity.agentSlug,
          required_capability: 'external.manage_project_task_events',
        },
      });
    }

    const { clauses, params } = await scopedReceiptWhere(db, identity, assignedProjectId);
    const taskId = req.query.task_id !== undefined ? normalizeTaskId(req.query.task_id) : null;
    if (taskId) {
      clauses.push('r.task_id = ?');
      params.push(taskId);
    }
    const source = normalizeOptionalString(req.query.source);
    if (source) {
      clauses.push('r.source = ?');
      params.push(source);
    }
    const event = normalizeOptionalString(req.query.event);
    if (event) {
      clauses.push('r.event = ?');
      params.push(event);
    }
    const processingState = normalizeOptionalString(req.query.processing_state);
    if (processingState && await tableHasColumn(db, 'external_task_event_receipts', 'processing_state')) {
      clauses.push('r.processing_state = ?');
      params.push(processingState);
    }

    const limit = normalizeLimit(req.query.limit);
    const offset = normalizeOffset(req.query.offset);
    const where = `WHERE ${clauses.join(' AND ')}`;
    const receipts = await db.all(`
      ${await buildReceiptSelect(db)}
      ${where}
      ORDER BY r.id DESC
      LIMIT ? OFFSET ?
    `, ...params, limit, offset) as ExternalTaskEventReceiptRow[];
    const total = await db.get(`
      SELECT COUNT(*) AS count
      FROM external_task_event_receipts r
      JOIN tasks t ON t.id = r.task_id
      ${where}
    `, ...params) as { count: number };

    return res.json({
      ok: true,
      project_id: assignedProjectId,
      operations: ['list_project_receipts', 'get_project_receipt'],
      receipts: receipts.map(serializeReceipt),
      total: total.count,
      limit,
      offset,
      hasMore: offset + receipts.length < total.count,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(400).json({ error: message, code: 'external_task_event_management_failed' });
  }
});

router.get('/task-events/receipts/:receiptId', async (req: Request, res: Response) => {
  try {
    const identity = getMcpIdentityFromRequest(req);
    if (!identity) return res.status(401).json({ error: 'MCP API key is required', code: 'mcp_api_key_missing' });

    const db = getDb();
    const assignedProjectId = await getAssignedProjectId(db, identity);
    if (!assignedProjectId) {
      return res.status(403).json({
        error: `${identity.agentSlug} does not have an assigned project for external task-event management.`,
        code: 'mcp_scope_denied',
        details: {
          agent_id: identity.agentId,
          agent_slug: identity.agentSlug,
          required_capability: 'external.manage_project_task_events',
        },
      });
    }

    const receiptId = normalizeTaskId(req.params.receiptId);
    const { clauses, params } = await scopedReceiptWhere(db, identity, assignedProjectId);
    clauses.push('r.id = ?');
    params.push(receiptId);
    const receipt = await db.get(`
      ${await buildReceiptSelect(db)}
      WHERE ${clauses.join(' AND ')}
      LIMIT 1
    `, ...params) as ExternalTaskEventReceiptRow | undefined;

    if (!receipt) {
      const existing = await db.get(`
        ${await buildReceiptSelect(db)}
        WHERE r.id = ?
        LIMIT 1
      `, receiptId) as ExternalTaskEventReceiptRow | undefined;
      if (existing) {
        return res.status(403).json({
          error: `External task-event receipt #${receiptId} is outside the assigned project for ${identity.agentSlug}.`,
          code: 'mcp_scope_denied',
          details: {
            agent_id: identity.agentId,
            agent_slug: identity.agentSlug,
            receipt_id: receiptId,
            required_capability: 'external.manage_project_task_events',
          },
        });
      }
      return res.status(404).json({
        error: 'External task-event receipt not found in assigned project scope',
        code: 'external_task_event_receipt_not_found',
      });
    }

    return res.json({
      ok: true,
      project_id: assignedProjectId,
      operations: ['get_project_receipt'],
      receipt: serializeReceipt(receipt),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(400).json({ error: message, code: 'external_task_event_management_failed' });
  }
});

router.post('/task-events', async (req: Request, res: Response) => {
  try {
    const identity = getMcpIdentityFromRequest(req);
    const normalized = normalizeExternalTaskEvent((req.body ?? {}) as Record<string, unknown>);
    assertTrustedExternalSource(identity, normalized.source);

    const changedBy = identity.auditActor;
    const fingerprint = buildFingerprint(normalized);
    const db = getDb();
    const task = await loadTask(normalized.taskId);
    let receiptId = 0;
    let reprocessingRejectedReceipt = false;
    try {
      receiptId = await insertReceipt(db, normalized, fingerprint, changedBy, buildRequestMetadata(req));
    } catch (error) {
      if (isUniqueConstraintError(error, 'external_task_event_receipts', 'fingerprint')) {
        const existing = await loadReceiptByFingerprint(db, fingerprint);
        if (existing?.processing_state === 'rejected') {
          receiptId = existing.id;
          reprocessingRejectedReceipt = true;
          await markReceiptRetrying(db, receiptId);
        } else {
          return res.json({
            ok: true,
            duplicate: true,
            receipt_id: existing?.id ?? null,
            fingerprint,
            task_id: normalized.taskId,
            source: normalized.source,
            event: normalized.event,
            receipt_accepted: true,
            processing_state: 'duplicate',
          });
        }
      }
      if (!reprocessingRejectedReceipt) throw error;
    }

    let mapping: WorkflowEventMapping | null = null;

    try {
      mapping = await resolveWorkflowEventMapping(db, {
              source: normalized.source,
              eventName: normalized.event,
              tenantId: task.tenant_id,
              projectId: task.project_id,
              sprintId: task.sprint_id,
              sprintType: task.sprint_type,
              taskType: task.task_type,
              currentStatus: task.status,
            });

      if (mapping?.apply_review_evidence) {
        validateReviewEvidenceForMapping(normalized);
      }

      let actionApplied = false;
      let nextStatus = task.status;
      let outcome: string | null = null;

      await db.exec('BEGIN');
      try {
        await writeWorkflowEventHistory(normalized.taskId, changedBy, normalized, mapping);
        await addTaskNote(normalized.taskId, changedBy, buildEventNote(normalized, mapping));

        if (mapping?.apply_review_evidence) {
          await updateTaskEvidence(normalized.taskId, changedBy, {
                        review_branch: normalized.branch,
                        review_commit: normalized.commitSha,
                        review_url: normalized.reviewUrl,
                      });
        }

        if (mapping?.action_kind === 'status' && mapping.action_target) {
          actionApplied = await applyExternalTaskStatus(
                      task,
                      mapping.action_target,
                      changedBy,
                      `Workflow event ${normalized.event} via ${normalized.source}. ${normalized.message}`,
                    );
          nextStatus = actionApplied ? mapping.action_target : task.status;
        } else if (mapping?.action_kind === 'outcome' && mapping.action_target) {
          outcome = mapping.action_target;
          const result = await applyTaskOutcome(db, {
            taskId: normalized.taskId,
            outcome,
            changedBy,
            summary: `Workflow event ${normalized.event} via ${normalized.source}. ${normalized.message}`,
            instanceId: task.active_instance_id,
            failureDetail: mapping.apply_failure_detail ? buildFailureDetail(normalized) : undefined,
          });
          if (!result.applied && result.ignored) {
            throw new Error(`External task event outcome was ignored (${result.reason ?? 'unknown'})`);
          }
          actionApplied = result.applied;
          nextStatus = result.nextStatus;
        }

        if (mapping?.apply_failure_detail && mapping.action_kind !== 'outcome') {
          await updateTaskEvidence(normalized.taskId, changedBy, {
                        failure_detail: buildFailureDetail(normalized),
                      });
        }

        await db.exec('COMMIT');
      } catch (error) {
        try {
          await db.exec('ROLLBACK');
        } catch {
          // Preserve the original error below.
        }
        throw error;
      }

      await markReceiptProcessed(db, receiptId, 'processed', mapping);
      return res.json({
        ok: true,
        duplicate: false,
        reprocessed: reprocessingRejectedReceipt,
        receipt_id: receiptId,
        fingerprint,
        task_id: normalized.taskId,
        receipt_accepted: true,
        processing_state: 'processed',
        event_model: 'workflow_event',
        source: normalized.source,
        event: normalized.event,
        mapping_id: mapping?.id ?? null,
        mapping_source_kind: mapping?.source_kind ?? null,
        mapping_source_label: mapping?.source_label ?? null,
        action_kind: mapping?.action_kind ?? null,
        action_target: mapping?.action_target ?? null,
        outcome,
        outcome_applied: actionApplied,
        next_status: nextStatus,
      });
    } catch (error) {
      await markReceiptProcessed(db, receiptId, 'rejected', mapping, error);

      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes(' is required')
        || message.includes('must be a positive integer')
        || message.includes('Review evidence validation failed')
        || message.includes('review_url must be a valid URL')
        || message.includes('review_branch')
        || message.includes('review_commit')
        || message.includes('review_url')
      ) {
        return res.status(400).json({
          ok: false,
          error: message,
          code: 'external_task_event_validation_failed',
          receipt_accepted: true,
          receipt_id: receiptId,
          fingerprint,
          task_id: normalized.taskId,
          source: normalized.source,
          event: normalized.event,
          processing_state: 'rejected',
          mapping_id: mapping?.id ?? null,
          action_kind: mapping?.action_kind ?? null,
          action_target: mapping?.action_target ?? null,
        });
      }
      if (error instanceof RefusedTaskOutcomeError || message.startsWith('External task event outcome was ignored')) {
        return res.status(409).json({
          ok: false,
          error: message,
          code: 'external_task_event_transition_refused',
          receipt_accepted: true,
          receipt_id: receiptId,
          fingerprint,
          task_id: normalized.taskId,
          source: normalized.source,
          event: normalized.event,
          processing_state: 'rejected',
          mapping_id: mapping?.id ?? null,
          action_kind: mapping?.action_kind ?? null,
          action_target: mapping?.action_target ?? null,
        });
      }

      return res.status(500).json({
        ok: false,
        error: message,
        code: 'external_task_event_processing_failed',
        receipt_accepted: true,
        receipt_id: receiptId,
        fingerprint,
        task_id: normalized.taskId,
        source: normalized.source,
        event: normalized.event,
        processing_state: 'rejected',
        mapping_id: mapping?.id ?? null,
        action_kind: mapping?.action_kind ?? null,
        action_target: mapping?.action_target ?? null,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = Number((error as { statusCode?: number } | null)?.statusCode ?? (error as { status?: number } | null)?.status ?? 0);
    const code = (error as { code?: string } | null)?.code;

    if (statusCode >= 400 && statusCode < 500) {
      return res.status(statusCode).json({ error: message, code: code ?? 'external_task_event_rejected' });
    }
    if (message === 'Task not found') {
      return res.status(404).json({ error: message, code: 'task_not_found' });
    }
    if (message.startsWith('Authenticated agent')) {
      return res.status(403).json({ error: message, code: 'external_task_event_source_forbidden' });
    }
    if (
      message.includes(' is required')
      || message.includes('must be a positive integer')
      || message.includes('Review evidence validation failed')
      || message.includes('review_url must be a valid URL')
      || message.includes('review_branch')
      || message.includes('review_commit')
      || message.includes('review_url')
    ) {
      return res.status(400).json({ error: message, code: 'external_task_event_validation_failed' });
    }
    if (error instanceof RefusedTaskOutcomeError || message.startsWith('External task event outcome was ignored')) {
      return res.status(409).json({ error: message, code: 'external_task_event_transition_refused' });
    }
    return res.status(500).json({ error: message, code: code ?? 'external_task_event_failed' });
  }
});

export default router;
