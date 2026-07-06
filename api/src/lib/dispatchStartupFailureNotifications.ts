import type Database from 'better-sqlite3';
import { createNotificationRecord, ensureNotificationTables } from './notifications';

const NOTIFICATION_TYPE = 'task_dispatch_startup_failed';
const NOTIFICATION_SOURCE = 'agent_hq_dispatcher';
const DEDUP_WINDOW_MINUTES = 15;

interface DispatchStartupFailureNotificationInput {
  taskId: number;
  tenantId?: number | null;
  matchedAgentId?: number | null;
  matchedAgentLabel: string;
  routingReason: string;
  failureCategory: string;
  failureMessage: string;
  mappingId?: number | null;
  mappingActionKind?: string | null;
  mappingActionTarget?: string | null;
  nextAction: string;
  nextOwner: string;
  priorStatus: string;
  resolvedStatus: string;
}

interface DispatchStartupFailureTaskContext {
  id: number;
  tenantId: number;
  title: string;
  projectName: string | null;
  workflowName: string | null;
  workflowType: string | null;
}

function tableHasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return cols.some(col => col.name === columnName);
  } catch {
    return false;
  }
}

function tableExists(db: Database.Database, tableName: string): boolean {
  try {
    return Boolean((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`).get(tableName) as { name?: string } | undefined)?.name);
  } catch {
    return false;
  }
}

function tenantExists(db: Database.Database, tenantId: number): boolean {
  if (!tableExists(db, 'tenants')) return true;
  const row = db.prepare(`SELECT id FROM tenants WHERE id = ? LIMIT 1`).get(tenantId) as { id?: number } | undefined;
  return Number.isInteger(row?.id);
}

function resolveNotificationTenantId(db: Database.Database, candidates: Array<number | null | undefined>): number {
  for (const candidate of candidates) {
    const tenantId = Number(candidate);
    if (Number.isInteger(tenantId) && tenantId > 0 && tenantExists(db, tenantId)) return tenantId;
  }

  if (tableExists(db, 'tenants')) {
    const defaultTenant = db.prepare(`SELECT id FROM tenants WHERE id = 1 LIMIT 1`).get() as { id?: number } | undefined;
    if (defaultTenant?.id != null && Number.isInteger(defaultTenant.id)) return Number(defaultTenant.id);
    const firstTenant = db.prepare(`SELECT id FROM tenants ORDER BY id LIMIT 1`).get() as { id?: number } | undefined;
    if (firstTenant?.id != null && Number.isInteger(firstTenant.id)) return Number(firstTenant.id);
  }

  return 1;
}

function loadTaskContext(
  db: Database.Database,
  taskId: number,
  fallbackTenantId?: number | null,
): DispatchStartupFailureTaskContext | null {
  const taskTenantExpr = tableHasColumn(db, 'tasks', 'tenant_id') ? 't.tenant_id' : 'NULL';
  const hasProjects = tableExists(db, 'projects');
  const hasSprints = tableExists(db, 'sprints');
  const projectNameExpr = hasProjects ? 'p.name' : 'NULL';
  const workflowNameExpr = hasSprints ? 's.name' : 'NULL';
  const workflowTypeExpr = hasSprints && tableHasColumn(db, 'sprints', 'sprint_type') ? 's.sprint_type' : 'NULL';
  const projectJoin = hasProjects ? 'LEFT JOIN projects p ON p.id = t.project_id' : '';
  const sprintJoin = hasSprints ? 'LEFT JOIN sprints s ON s.id = t.sprint_id' : '';

  try {
    const row = db.prepare(`
      SELECT
        t.id,
        ${taskTenantExpr} AS tenant_id,
        t.title,
        ${projectNameExpr} AS project_name,
        ${workflowNameExpr} AS workflow_name,
        ${workflowTypeExpr} AS workflow_type
      FROM tasks t
      ${projectJoin}
      ${sprintJoin}
      WHERE t.id = ?
      LIMIT 1
    `).get(taskId) as {
      id: number;
      tenant_id: number | null;
      title: string;
      project_name: string | null;
      workflow_name: string | null;
      workflow_type: string | null;
    } | undefined;

    if (!row) return null;
    return {
      id: row.id,
      tenantId: resolveNotificationTenantId(db, [row.tenant_id, fallbackTenantId]),
      title: row.title,
      projectName: row.project_name ?? null,
      workflowName: row.workflow_name ?? null,
      workflowType: row.workflow_type ?? null,
    };
  } catch {
    const row = db.prepare(`SELECT id, title FROM tasks WHERE id = ? LIMIT 1`).get(taskId) as {
      id: number;
      title: string;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      tenantId: resolveNotificationTenantId(db, [fallbackTenantId]),
      title: row.title,
      projectName: null,
      workflowName: null,
      workflowType: null,
    };
  }
}

function normalizeMappingAction(input: DispatchStartupFailureNotificationInput): string {
  const actionKind = input.mappingActionKind ?? 'legacy_safe_default';
  return input.mappingActionTarget ? `${actionKind} -> ${input.mappingActionTarget}` : actionKind;
}

function alreadyRecordedRecentFailure(
  db: Database.Database,
  tenantId: number,
  taskId: number,
  failureCategory: string,
): boolean {
  ensureNotificationTables(db);
  const rows = db.prepare(`
    SELECT metadata_json
    FROM notification_records
    WHERE tenant_id = ?
      AND type = ?
      AND source = ?
      AND datetime(created_at) >= datetime('now', ?)
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 50
  `).all(tenantId, NOTIFICATION_TYPE, NOTIFICATION_SOURCE, `-${DEDUP_WINDOW_MINUTES} minutes`) as Array<{ metadata_json: string }>;

  return rows.some((row) => {
    try {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      return metadata.taskId === taskId && metadata.failureCategory === failureCategory;
    } catch {
      return false;
    }
  });
}

function buildBody(ctx: DispatchStartupFailureTaskContext, input: DispatchStartupFailureNotificationInput): string {
  const lines = [
    `Task: #${ctx.id} ${ctx.title}`,
    `Project: ${ctx.projectName ?? 'unknown'}`,
    `Workflow: ${ctx.workflowName ?? ctx.workflowType ?? 'unknown'}`,
    `Matched agent: ${input.matchedAgentLabel}${input.matchedAgentId != null ? ` (#${input.matchedAgentId})` : ''}`,
    `Routing reason: ${input.routingReason}`,
    `Failure category: ${input.failureCategory}`,
    `Failure message: ${input.failureMessage}`,
    `Workflow event: dispatch_startup_failed`,
    `Mapping: ${input.mappingId != null ? `#${input.mappingId}` : 'none'}; action=${normalizeMappingAction(input)}`,
    `Status: ${input.priorStatus}${input.resolvedStatus === input.priorStatus ? ' (unchanged)' : ` -> ${input.resolvedStatus}`}`,
    `Next action: ${input.nextAction}`,
    `Next owner: ${input.nextOwner}`,
  ];
  return lines.join('\n');
}

export function recordDispatchStartupFailureNotification(
  db: Database.Database,
  input: DispatchStartupFailureNotificationInput,
): boolean {
  try {
    const ctx = loadTaskContext(db, input.taskId, input.tenantId);
    if (!ctx) return false;
    if (alreadyRecordedRecentFailure(db, ctx.tenantId, input.taskId, input.failureCategory)) return false;

    createNotificationRecord(db, {
      tenantId: ctx.tenantId,
      type: NOTIFICATION_TYPE,
      title: `Task #${ctx.id} dispatch startup failed`,
      body: buildBody(ctx, input),
      source: NOTIFICATION_SOURCE,
      outlet: 'agent_hq',
      metadata: {
        taskId: ctx.id,
        projectName: ctx.projectName,
        workflowName: ctx.workflowName,
        workflowType: ctx.workflowType,
        matchedAgentId: input.matchedAgentId ?? null,
        matchedAgentLabel: input.matchedAgentLabel,
        routingReason: input.routingReason,
        failureCategory: input.failureCategory,
        workflowEvent: 'dispatch_startup_failed',
        mappingId: input.mappingId ?? null,
        mappingActionKind: input.mappingActionKind ?? null,
        mappingActionTarget: input.mappingActionTarget ?? null,
        priorStatus: input.priorStatus,
        resolvedStatus: input.resolvedStatus,
        nextAction: input.nextAction,
        nextOwner: input.nextOwner,
      },
    });
    return true;
  } catch (err) {
    console.error('[dispatcher] Failed to record dispatch startup failure notification:', err);
    return false;
  }
}
