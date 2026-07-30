import { notifyTelegram } from '../integrations/telegram';
import { createNotificationRecord, readNotificationPreferences } from './notifications';
import { canonicalTaskStatusEmoji, listSprintTaskStatuses, listSprintTypeTaskStatuses } from './sprintTaskPolicy';
import { getActiveTenantId } from './tenantContext';
import { type Db } from "../db/adapter/types";

// ── Deduplication ─────────────────────────────────────────────────────────────

/** TTL (ms) within which an identical transition is considered a duplicate */
const DEDUP_TTL_MS = 5_000;

type DedupKey = string;
const recentTransitions = new Map<DedupKey, number>();

function buildDedupKey(taskId: number, fromStatus: string, toStatus: string): DedupKey {
  return `${taskId}:${fromStatus}→${toStatus}`;
}

function isDuplicate(taskId: number, fromStatus: string, toStatus: string): boolean {
  const key = buildDedupKey(taskId, fromStatus, toStatus);
  const last = recentTransitions.get(key);
  if (last != null && Date.now() - last < DEDUP_TTL_MS) return true;
  recentTransitions.set(key, Date.now());
  // Prune old entries to avoid unbounded growth
  if (recentTransitions.size > 500) {
    const cutoff = Date.now() - DEDUP_TTL_MS * 2;
    for (const [k, ts] of recentTransitions) {
      if (ts < cutoff) recentTransitions.delete(k);
    }
  }
  return false;
}

// ── Context lookup ────────────────────────────────────────────────────────────

interface TaskContext {
  id: number;
  tenantId: number;
  title: string;
  projectName: string | null;
  sprintName: string | null;
  sprintId: number | null;
  sprintType: string | null;
}

async function loadTaskContext(db: Db, taskId: number): Promise<TaskContext | null> {
  // Use a resilient query: first try with project/sprint JOIN, fall back to
  // title-only if those tables don't exist (e.g. in test environments).
  try {
    const row = await db.get(`
      SELECT t.id, t.tenant_id, t.title, t.sprint_id, p.name as project_name, s.name as sprint_name, s.sprint_type
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN sprints  s ON s.id = t.sprint_id
      WHERE t.id = ?
    `, taskId) as {
      id: number;
      tenant_id: number | null;
      title: string;
      sprint_id: number | null;
      project_name: string | null;
      sprint_name: string | null;
      sprint_type: string | null;
    } | undefined;

    if (!row) return null;
    return {
      id: row.id,
      tenantId: Number.isFinite(Number(row.tenant_id)) ? Number(row.tenant_id) : await getActiveTenantId(db),
      title: row.title,
      projectName: row.project_name ?? null,
      sprintName: row.sprint_name ?? null,
      sprintId: Number.isFinite(Number(row.sprint_id)) ? Number(row.sprint_id) : null,
      sprintType: typeof row.sprint_type === 'string' && row.sprint_type.trim().length > 0 ? row.sprint_type : null,
    };
  } catch {
    // Fallback: minimal query without optional JOINs (e.g. test DBs missing projects/sprints tables)
    const row = await db.get(`SELECT id, title, sprint_id FROM tasks WHERE id = ?`, taskId) as { id: number; title: string; sprint_id?: number | null } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      tenantId: await getActiveTenantId(db),
      title: row.title,
      projectName: null,
      sprintName: null,
      sprintId: Number.isFinite(Number(row.sprint_id)) ? Number(row.sprint_id) : null,
      sprintType: null,
    };
  }
}

async function buildRecordBody(db: Db, ctx: TaskContext, fromStatus: string, toStatus: string, source: string): Promise<string> {
  const fromEmoji = await resolveStatusEmoji(db, ctx, fromStatus);
  const toEmoji = await resolveStatusEmoji(db, ctx, toStatus);
  const meta: string[] = [];
  if (ctx.projectName) meta.push(`Project: ${ctx.projectName}`);
  if (ctx.sprintName) meta.push(`Workflow: ${ctx.sprintName}`);
  meta.push(`Source: ${source}`);
  return `${fromEmoji} ${fromStatus} -> ${toEmoji} ${toStatus}${meta.length ? `\n${meta.join(' · ')}` : ''}`;
}

// ── Status emoji map ──────────────────────────────────────────────────────────

function statusEmoji(status: string): string {
  return canonicalTaskStatusEmoji(status) ?? '⚙️';
}

async function resolveConfiguredStatusEmoji(db: Db, ctx: TaskContext, status: string): Promise<string | null> {
  if (ctx.sprintId != null) {
    const sprintStatus = (await listSprintTaskStatuses(db, ctx.sprintId)).find((candidate) => candidate.name === status);
    if (sprintStatus?.emoji) return sprintStatus.emoji;
  }

  if (ctx.sprintType) {
    const sprintTypeStatus = (await listSprintTypeTaskStatuses(db, ctx.sprintType)).find((candidate) => candidate.name === status);
    if (sprintTypeStatus?.emoji) return sprintTypeStatus.emoji;
  }

  return null;
}

async function resolveStatusEmoji(db: Db, ctx: TaskContext, status: string): Promise<string> {
  return (await resolveConfiguredStatusEmoji(db, ctx, status)) ?? statusEmoji(status);
}

// ── Message builder ───────────────────────────────────────────────────────────

async function buildMessage(
  db: Db,
  ctx: TaskContext,
  fromStatus: string,
  toStatus: string,
  source: string,
): Promise<string> {
  const lines: string[] = [];
  const fromEmoji = await resolveStatusEmoji(db, ctx, fromStatus);
  const toEmoji = await resolveStatusEmoji(db, ctx, toStatus);

  lines.push(`${toEmoji} <b>Task #${ctx.id} — Status Changed</b>`);
  lines.push(`<b>${escapeHtml(ctx.title)}</b>`);
  lines.push('');
  lines.push(`${fromEmoji} <i>${fromStatus}</i>  →  ${toEmoji} <b>${toStatus}</b>`);
  lines.push('');

  const meta: string[] = [];
  if (ctx.projectName) meta.push(`Project: ${escapeHtml(ctx.projectName)}`);
  if (ctx.sprintName) meta.push(`Sprint: ${escapeHtml(ctx.sprintName)}`);
  meta.push(`Source: ${escapeHtml(source)}`);

  lines.push(meta.join(' · '));

  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface TaskStatusChangeEvent {
  taskId: number;
  fromStatus: string;
  toStatus: string;
  /** Human-readable source label: 'Atlas', 'agency-frontend', agent slug, 'reconciler', etc. */
  source?: string;
}

/**
 * Notify Telegram of a task status change.
 * No-ops silently on duplicates, missing task, or missing env vars.
 * Never throws — caller must not depend on outcome.
 */
export async function notifyTaskStatusChange(
  db: Db,
  event: TaskStatusChangeEvent,
): Promise<void> {
  const { taskId, fromStatus, toStatus, source = 'system' } = event;

  // No-op if the status didn't actually change
  if (fromStatus === toStatus) return;

  // Deduplication check
  if (isDuplicate(taskId, fromStatus, toStatus)) return;

  // Fire-and-forget: load context + send
  try {
    const ctx = await loadTaskContext(db, taskId);
    if (!ctx) return;

    const message = await buildMessage(db, ctx, fromStatus, toStatus, source);
    const toEmoji = await resolveStatusEmoji(db, ctx, toStatus);
    await createNotificationRecord(db, {
            tenantId: ctx.tenantId,
            type: 'task_status_change',
            title: `${toEmoji} Task #${ctx.id} status changed`,
            body: await buildRecordBody(db, ctx, fromStatus, toStatus, source),
            source,
            outlet: 'telegram',
            metadata: {
              taskId: ctx.id,
              fromStatus,
              toStatus,
              projectName: ctx.projectName,
              sprintName: ctx.sprintName,
            },
          });
    const preferences = await readNotificationPreferences(db, ctx.tenantId);
    if (preferences.enabled && preferences.outlets.telegram) {
      notifyTelegram(message).catch((err) => {
        console.error('[taskNotifications] notifyTelegram error:', err);
      });
    }
  } catch (err) {
    console.error('[taskNotifications] Unexpected error building notification:', err);
  }
}
