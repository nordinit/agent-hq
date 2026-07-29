import { createNotificationRecord, ensureNotificationTables } from './notifications';
import { type Db } from "../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../db/introspection";

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

async function tableHasColumn(db: Db, tableName: string, columnName: string): Promise<boolean> {
    return await sharedColumnExists(db, tableName, columnName);
}

async function tableExists(db: Db, tableName: string): Promise<boolean> {
    return await sharedTableExists(db, tableName);
}

async function tenantExists(db: Db, tenantId: number): Promise<boolean> {
  if (!await tableExists(db, 'tenants')) return true;
  const row = await db.get(`SELECT id FROM tenants WHERE id = ? LIMIT 1`, tenantId) as { id?: number } | undefined;
  return Number.isInteger(row?.id);
}

async function resolveNotificationTenantId(db: Db, candidates: Array<number | null | undefined>): Promise<number> {
  for (const candidate of candidates) {
    const tenantId = Number(candidate);
    if (Number.isInteger(tenantId) && tenantId > 0 && await tenantExists(db, tenantId)) return tenantId;
  }

  if (await tableExists(db, 'tenants')) {
    const defaultTenant = await db.get(`SELECT id FROM tenants WHERE id = 1 LIMIT 1`) as { id?: number } | undefined;
    if (defaultTenant?.id != null && Number.isInteger(defaultTenant.id)) return Number(defaultTenant.id);
    const firstTenant = await db.get(`SELECT id FROM tenants ORDER BY id LIMIT 1`) as { id?: number } | undefined;
    if (firstTenant?.id != null && Number.isInteger(firstTenant.id)) return Number(firstTenant.id);
  }

  return 1;
}

async function loadTaskContext(
  db: Db,
  taskId: number,
  fallbackTenantId?: number | null,
): Promise<DispatchStartupFailureTaskContext | null> {
  const taskTenantExpr = await tableHasColumn(db, 'tasks', 'tenant_id') ? 't.tenant_id' : 'NULL';
  const hasProjects = await tableExists(db, 'projects');
  const hasSprints = await tableExists(db, 'sprints');
  const projectNameExpr = hasProjects ? 'p.name' : 'NULL';
  const workflowNameExpr = hasSprints ? 's.name' : 'NULL';
  const workflowTypeExpr = hasSprints && await tableHasColumn(db, 'sprints', 'sprint_type') ? 's.sprint_type' : 'NULL';
  const projectJoin = hasProjects ? 'LEFT JOIN projects p ON p.id = t.project_id' : '';
  const sprintJoin = hasSprints ? 'LEFT JOIN sprints s ON s.id = t.sprint_id' : '';

  try {
    const row = await db.get(`
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
    `, taskId) as {
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
      tenantId: await resolveNotificationTenantId(db, [row.tenant_id, fallbackTenantId]),
      title: row.title,
      projectName: row.project_name ?? null,
      workflowName: row.workflow_name ?? null,
      workflowType: row.workflow_type ?? null,
    };
  } catch {
    const row = await db.get(`SELECT id, title FROM tasks WHERE id = ? LIMIT 1`, taskId) as {
      id: number;
      title: string;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      tenantId: await resolveNotificationTenantId(db, [fallbackTenantId]),
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

async function alreadyRecordedRecentFailure(
  db: Db,
  tenantId: number,
  taskId: number,
  failureCategory: string,
): Promise<boolean> {
  await ensureNotificationTables(db);
  const rows = await db.all(`
    SELECT metadata_json
    FROM notification_records
    WHERE tenant_id = ?
      AND type = ?
      AND source = ?
      AND datetime(created_at) >= datetime('now', ?)
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 50
  `, tenantId, NOTIFICATION_TYPE, NOTIFICATION_SOURCE, `-${DEDUP_WINDOW_MINUTES} minutes`) as Array<{ metadata_json: string }>;

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

export async function recordDispatchStartupFailureNotification(
  db: Db,
  input: DispatchStartupFailureNotificationInput,
): Promise<boolean> {
  try {
    const ctx = await loadTaskContext(db, input.taskId, input.tenantId);
    if (!ctx) return false;
    if (await alreadyRecordedRecentFailure(db, ctx.tenantId, input.taskId, input.failureCategory)) return false;

    await createNotificationRecord(db, {
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
