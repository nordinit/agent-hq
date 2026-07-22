import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { validateReviewEvidence } from '../lib/evidenceValidation';
import { getMcpIdentityFromRequest, type McpApiIdentity } from '../lib/mcpApiAuth';
import { notifyTaskStatusChange } from '../lib/taskNotifications';
import { writeTaskHistory, writeTaskStatusChange } from '../domains/tasks/history';
import { applyTaskOutcome, RefusedTaskOutcomeError } from '../lib/taskOutcome';
import {
  DEV_ENV_LEASE_MANAGER_SOURCE,
  STALE_LEASE_RELEASED_EVENT,
  resolveWorkflowEventMapping,
  type WorkflowEventMapping,
} from '../domains/routing/externalEventMappings';

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
  releaseReason: string | null;
  priorLeaseStatus: string | null;
  priorDeployStatus: string | null;
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

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
  } catch {
    return false;
  }
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
  const releaseReason = normalizeOptionalString(body.release_reason)
    ?? normalizeOptionalString(error?.release_reason)
    ?? normalizeOptionalString(errorResult?.release_reason);
  const priorLeaseStatus = normalizeOptionalString(body.prior_lease_status)
    ?? normalizeOptionalString(error?.prior_lease_status)
    ?? normalizeOptionalString(errorResult?.prior_lease_status);
  const priorDeployStatus = normalizeOptionalString(body.prior_deploy_status)
    ?? normalizeOptionalString(error?.prior_deploy_status)
    ?? normalizeOptionalString(errorResult?.prior_deploy_status);
  const message = normalizeRequiredString(body.message, 'message');

  if (event === STALE_LEASE_RELEASED_EVENT) {
    if (!releaseReason) throw new Error('release_reason is required for stale_lease_released');
    if (!priorLeaseStatus) throw new Error('prior_lease_status is required for stale_lease_released');
    if (!priorDeployStatus) throw new Error('prior_deploy_status is required for stale_lease_released');
  }

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
    releaseReason,
    priorLeaseStatus,
    priorDeployStatus,
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
    release_reason: event.releaseReason,
    prior_lease_status: event.priorLeaseStatus,
    prior_deploy_status: event.priorDeployStatus,
    message: event.message,
    error: event.error,
  }), 'utf8').digest('hex');
}

function isUniqueConstraintError(error: unknown, table: string, column: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed') && message.includes(`${table}.${column}`);
}

function insertReceipt(
  db: Database.Database,
  event: NormalizedExternalTaskEvent,
  fingerprint: string,
  changedBy: string,
  requestMetadata: Record<string, unknown>,
): number {
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
    ...(tableHasColumn(db, 'external_task_event_receipts', 'processing_state') ? ['processing_state'] : []),
    ...(tableHasColumn(db, 'external_task_event_receipts', 'request_metadata_json') ? ['request_metadata_json'] : []),
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
    ...(tableHasColumn(db, 'external_task_event_receipts', 'processing_state') ? ['received'] : []),
    ...(tableHasColumn(db, 'external_task_event_receipts', 'request_metadata_json') ? [JSON.stringify(requestMetadata)] : []),
  ];

  const placeholders = columns.map(() => '?').join(', ');
  const insertResult = db.prepare(`
    INSERT INTO external_task_event_receipts (${columns.join(', ')})
    VALUES (${placeholders})
  `).run(...values);
  return Number(insertResult.lastInsertRowid);
}

function loadReceiptByFingerprint(db: Database.Database, fingerprint: string): ExistingReceiptRow | null {
  const processingStateSelect = tableHasColumn(db, 'external_task_event_receipts', 'processing_state')
    ? 'processing_state'
    : 'NULL AS processing_state';
  return db.prepare(`
    SELECT id, ${processingStateSelect}
    FROM external_task_event_receipts
    WHERE fingerprint = ?
    LIMIT 1
  `).get(fingerprint) as ExistingReceiptRow | undefined ?? null;
}

function markReceiptRetrying(db: Database.Database, receiptId: number): void {
  const assignments: string[] = [];
  if (tableHasColumn(db, 'external_task_event_receipts', 'processing_state')) {
    assignments.push(`processing_state = 'received'`);
  }
  if (tableHasColumn(db, 'external_task_event_receipts', 'processing_error')) {
    assignments.push(`processing_error = NULL`);
  }
  if (tableHasColumn(db, 'external_task_event_receipts', 'processed_at')) {
    assignments.push(`processed_at = NULL`);
  }
  if (assignments.length === 0) return;

  db.prepare(`
    UPDATE external_task_event_receipts
    SET ${assignments.join(', ')}
    WHERE id = ?
  `).run(receiptId);
}

function markReceiptProcessed(
  db: Database.Database,
  receiptId: number,
  state: ReceiptProcessingState,
  mapping: WorkflowEventMapping | null,
  error: unknown = null,
): void {
  const assignments = ['processed_at = datetime(\'now\')'];
  const values: unknown[] = [];
  const maybeAssign = (column: string, value: unknown): void => {
    if (!tableHasColumn(db, 'external_task_event_receipts', column)) return;
    assignments.push(`${column} = ?`);
    values.push(value);
  };

  maybeAssign('processing_state', state);
  maybeAssign('processing_error', error ? (error instanceof Error ? error.message : String(error)) : null);
  maybeAssign('mapping_id', mapping?.id ?? null);
  maybeAssign('mapping_action_kind', mapping?.action_kind ?? null);
  maybeAssign('mapping_action_target', mapping?.action_target ?? null);

  db.prepare(`
    UPDATE external_task_event_receipts
    SET ${assignments.join(', ')}
    WHERE id = ?
  `).run(...values, receiptId);
}

function addTaskNote(taskId: number, author: string, content: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO task_notes (task_id, author, content)
    VALUES (?, ?, ?)
  `).run(taskId, author, content);
}

function parseCustomFields(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function updateTaskEvidence(taskId: number, changedBy: string, updates: Record<string, unknown>): void {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown> | undefined;
  if (!existing) throw new Error('Task not found');
  const taskColumns = new Set((db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map(col => col.name));
  const existingCustomFields = taskColumns.has('custom_fields_json') ? parseCustomFields(existing.custom_fields_json) : {};

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
    writeTaskHistory(db, taskId, changedBy, key, oldValue, updates[key]);
  }

  const nextCustomFields = { ...existingCustomFields };
  for (const key of activeKeys) {
    nextCustomFields[key] = updates[key] ?? null;
  }
  const shadowColumnKeys = activeKeys.filter(key => taskColumns.has(key));
  const assignments = [
    ...(taskColumns.has('custom_fields_json') ? ['custom_fields_json = ?'] : []),
    ...shadowColumnKeys.map((key) => `${key} = ?`),
  ].join(', ');
  const values = [
    ...(taskColumns.has('custom_fields_json') ? [JSON.stringify(nextCustomFields)] : []),
    ...shadowColumnKeys.map((key) => updates[key]),
  ];
  if (!assignments) return;
  db.prepare(`
    UPDATE tasks
    SET ${assignments}, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    ...values,
    taskId,
  );
}

function loadTask(taskId: number): TaskRow {
  const db = getDb();
  const task = db.prepare(`
    SELECT tasks.id,
           ${tableHasColumn(db, 'tasks', 'tenant_id') ? 'tasks.tenant_id' : 'NULL'} AS tenant_id,
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
  `).get(taskId) as TaskRow | undefined;
  if (!task) throw new Error('Task not found');
  return task;
}

function getAssignedProjectId(db: Database.Database, identity: McpApiIdentity): number | null {
  if (!tableHasColumn(db, 'agents', 'project_id')) return null;
  const hasTenantId = tableHasColumn(db, 'agents', 'tenant_id');
  const row = db.prepare(`
    SELECT project_id
    FROM agents
    WHERE id = ?
      ${hasTenantId ? 'AND tenant_id = ?' : ''}
    LIMIT 1
  `).get(identity.agentId, ...(hasTenantId ? [identity.tenantId] : [])) as { project_id: number | null } | undefined;
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

function buildReceiptSelect(db: Database.Database): string {
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
      ${tableHasColumn(db, 'external_task_event_receipts', 'processing_state') ? 'r.processing_state' : 'NULL'} AS processing_state,
      ${tableHasColumn(db, 'external_task_event_receipts', 'processing_error') ? 'r.processing_error' : 'NULL'} AS processing_error,
      ${tableHasColumn(db, 'external_task_event_receipts', 'mapping_id') ? 'r.mapping_id' : 'NULL'} AS mapping_id,
      ${tableHasColumn(db, 'external_task_event_receipts', 'mapping_action_kind') ? 'r.mapping_action_kind' : 'NULL'} AS mapping_action_kind,
      ${tableHasColumn(db, 'external_task_event_receipts', 'mapping_action_target') ? 'r.mapping_action_target' : 'NULL'} AS mapping_action_target,
      ${tableHasColumn(db, 'external_task_event_receipts', 'request_metadata_json') ? 'r.request_metadata_json' : 'NULL'} AS request_metadata_json,
      r.created_at,
      ${tableHasColumn(db, 'external_task_event_receipts', 'processed_at') ? 'r.processed_at' : 'NULL'} AS processed_at,
      t.project_id AS task_project_id,
      ${tableHasColumn(db, 'tasks', 'tenant_id') ? 't.tenant_id' : 'NULL'} AS task_tenant_id,
      t.status AS task_status,
      t.title AS task_title
    FROM external_task_event_receipts r
    JOIN tasks t ON t.id = r.task_id
  `;
}

function scopedReceiptWhere(db: Database.Database, identity: McpApiIdentity, assignedProjectId: number): { clauses: string[]; params: unknown[] } {
  const clauses = ['t.project_id = ?'];
  const params: unknown[] = [assignedProjectId];
  if (tableHasColumn(db, 'tasks', 'tenant_id')) {
    clauses.push('t.tenant_id = ?');
    params.push(identity.tenantId);
  }
  return { clauses, params };
}

function writeWorkflowEventHistory(taskId: number, changedBy: string, event: NormalizedExternalTaskEvent, mapping: WorkflowEventMapping | null): void {
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
    ['external_release_reason', event.releaseReason],
    ['external_prior_lease_status', event.priorLeaseStatus],
    ['external_prior_deploy_status', event.priorDeployStatus],
    ['external_message', event.message],
    ['external_mapping_id', mapping?.id ?? null],
    ['external_mapping_action_kind', mapping?.action_kind ?? null],
    ['external_mapping_action_target', mapping?.action_target ?? null],
  ];

  for (const [field, value] of historyEntries) {
    writeTaskHistory(db, taskId, changedBy, field, null, value, false);
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
  if (event.releaseReason) lines.push(`Release Reason: ${event.releaseReason}`);
  if (event.priorLeaseStatus) lines.push(`Prior Lease Status: ${event.priorLeaseStatus}`);
  if (event.priorDeployStatus) lines.push(`Prior Deploy Status: ${event.priorDeployStatus}`);
  lines.push(`Message: ${event.message}`);
  if (mapping) {
    lines.push(`Resolved mapping: #${mapping.id}`);
    lines.push(`Action: ${mapping.action_kind}${mapping.action_target ? ` → ${mapping.action_target}` : ''}`);
  } else {
    lines.push('Resolved mapping: none');
  }

  return lines.join('\n');
}

function applyExternalTaskStatus(
  task: TaskRow,
  nextStatus: string,
  changedBy: string,
  reason: string,
): boolean {
  if (task.status === nextStatus) return false;

  const db = getDb();
  db.prepare(`
    UPDATE tasks
    SET status = ?,
        failure_detail = NULL,
        previous_status = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(nextStatus, task.id);

  writeTaskStatusChange(db, task.id, changedBy, task.status, nextStatus, {
    instanceId: task.active_instance_id,
    reason,
    projectId: task.project_id,
    agentId: task.agent_id,
  });
  notifyTaskStatusChange(db, {
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
    ...(event.releaseReason ? [`Release Reason: ${event.releaseReason}`] : []),
    ...(event.priorLeaseStatus ? [`Prior Lease Status: ${event.priorLeaseStatus}`] : []),
    ...(event.priorDeployStatus ? [`Prior Deploy Status: ${event.priorDeployStatus}`] : []),
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

router.get('/task-events/receipts', (req: Request, res: Response) => {
  try {
    const identity = getMcpIdentityFromRequest(req);
    if (!identity) return res.status(401).json({ error: 'MCP API key is required', code: 'mcp_api_key_missing' });

    const db = getDb();
    const assignedProjectId = getAssignedProjectId(db, identity);
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

    const { clauses, params } = scopedReceiptWhere(db, identity, assignedProjectId);
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
    if (processingState && tableHasColumn(db, 'external_task_event_receipts', 'processing_state')) {
      clauses.push('r.processing_state = ?');
      params.push(processingState);
    }

    const limit = normalizeLimit(req.query.limit);
    const offset = normalizeOffset(req.query.offset);
    const where = `WHERE ${clauses.join(' AND ')}`;
    const receipts = db.prepare(`
      ${buildReceiptSelect(db)}
      ${where}
      ORDER BY r.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as ExternalTaskEventReceiptRow[];
    const total = db.prepare(`
      SELECT COUNT(*) AS count
      FROM external_task_event_receipts r
      JOIN tasks t ON t.id = r.task_id
      ${where}
    `).get(...params) as { count: number };

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

router.get('/task-events/receipts/:receiptId', (req: Request, res: Response) => {
  try {
    const identity = getMcpIdentityFromRequest(req);
    if (!identity) return res.status(401).json({ error: 'MCP API key is required', code: 'mcp_api_key_missing' });

    const db = getDb();
    const assignedProjectId = getAssignedProjectId(db, identity);
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
    const { clauses, params } = scopedReceiptWhere(db, identity, assignedProjectId);
    clauses.push('r.id = ?');
    params.push(receiptId);
    const receipt = db.prepare(`
      ${buildReceiptSelect(db)}
      WHERE ${clauses.join(' AND ')}
      LIMIT 1
    `).get(...params) as ExternalTaskEventReceiptRow | undefined;

    if (!receipt) {
      const existing = db.prepare(`
        ${buildReceiptSelect(db)}
        WHERE r.id = ?
        LIMIT 1
      `).get(receiptId) as ExternalTaskEventReceiptRow | undefined;
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
    const task = loadTask(normalized.taskId);
    let receiptId = 0;
    let reprocessingRejectedReceipt = false;
    try {
      receiptId = insertReceipt(db, normalized, fingerprint, changedBy, buildRequestMetadata(req));
    } catch (error) {
      if (isUniqueConstraintError(error, 'external_task_event_receipts', 'fingerprint')) {
        const existing = loadReceiptByFingerprint(db, fingerprint);
        if (existing?.processing_state === 'rejected') {
          receiptId = existing.id;
          reprocessingRejectedReceipt = true;
          markReceiptRetrying(db, receiptId);
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
      mapping = resolveWorkflowEventMapping(db, {
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
        writeWorkflowEventHistory(normalized.taskId, changedBy, normalized, mapping);
        addTaskNote(normalized.taskId, changedBy, buildEventNote(normalized, mapping));

        if (mapping?.apply_review_evidence) {
          updateTaskEvidence(normalized.taskId, changedBy, {
            review_branch: normalized.branch,
            review_commit: normalized.commitSha,
            review_url: normalized.reviewUrl,
          });
        }

        if (mapping?.action_kind === 'status' && mapping.action_target) {
          actionApplied = applyExternalTaskStatus(
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
          updateTaskEvidence(normalized.taskId, changedBy, {
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

      markReceiptProcessed(db, receiptId, 'processed', mapping);
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
      markReceiptProcessed(db, receiptId, 'rejected', mapping, error);

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
