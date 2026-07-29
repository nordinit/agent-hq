import { getDb } from '../../db/client';
import { createRelationshipFromBlockedBy, deleteTaskRelationshipByTuple } from './relationships';
import { triggerDispatch } from '../../services/dispatchTrigger';
import { writeTaskHistory } from './history';
import { getCanonicalTaskCustomFields } from './evidence';
import { resolveRuntimeTenantId, tenantInsertColumns } from '../../lib/runtimeTenantScope';
import { type Db } from "../../db/adapter/types";

export interface TaskBlockerInput {
  task_id?: number;
  blocker_id?: number;
  reason?: string | null;
}

export function maybeTriggerDispatch(projectId: unknown): void {
  if (typeof projectId === 'number' && Number.isFinite(projectId)) {
    triggerDispatch(projectId);
  }
}

export async function logHistory(
  taskId: number,
  changedBy: string,
  field: string,
  oldValue: unknown,
  newValue: unknown,
): Promise<void> {
  await writeTaskHistory(getDb(), taskId, changedBy, field, oldValue, newValue, false);
}

export async function taskTableHasColumn(db: Db, column: string): Promise<boolean> {
  return (await db.all('PRAGMA table_info(tasks)') as Array<{ name: string }>).some((col) => col.name === column);
}

export async function addTaskNote(taskId: number, author: string, content: string): Promise<void> {
  const db = getDb();
  const tenantId = await resolveRuntimeTenantId(db, { taskId });
  const tenant = await tenantInsertColumns(db, 'task_notes', tenantId);
  await db.run(`
    INSERT INTO task_notes (${tenant.columnSql}task_id, author, content)
    VALUES (${tenant.valueSql}?, ?, ?)
  `, ...tenant.values, taskId, author, content);
}

export async function updateTaskEvidence(
  taskId: number,
  changedBy: string,
  updates: Record<string, unknown>,
  options?: { explicitClears?: Set<string> },
): Promise<void> {
  const db = getDb();
  const existing = await db.get('SELECT * FROM tasks WHERE id = ?', taskId) as Record<string, unknown> | undefined;
  if (!existing) throw new Error('Task not found');
  const taskColumns = new Set((await db.all('PRAGMA table_info(tasks)') as Array<{ name: string }>).map((col) => col.name));
  const existingCustomFields = taskColumns.has('custom_fields_json') ? getCanonicalTaskCustomFields(existing) : {};

  const requestedKeys = Object.keys(updates).filter((key) => updates[key] !== undefined);
  if (requestedKeys.length === 0) return;

  const explicitClears = options?.explicitClears ?? new Set<string>();
  const activeKeys = requestedKeys.filter((key) => {
    const incoming = updates[key];
    const current = Object.prototype.hasOwnProperty.call(existingCustomFields, key)
      ? existingCustomFields[key]
      : existing[key];
    const incomingIsEmpty = incoming === null || incoming === undefined || incoming === '';
    const currentIsSet = current !== null && current !== undefined && current !== '';
    if (incomingIsEmpty && currentIsSet && explicitClears.has(key)) return true;
    if (incomingIsEmpty && currentIsSet) return false;
    return true;
  });

  if (activeKeys.length === 0) return;

  for (const key of activeKeys) {
    const oldValue = Object.prototype.hasOwnProperty.call(existingCustomFields, key)
      ? existingCustomFields[key]
      : existing[key];
    const newValue = updates[key];
    if (String(oldValue ?? '') !== String(newValue ?? '')) {
      await logHistory(taskId, changedBy, key, oldValue, newValue);
    }
  }

  const nextCustomFields = { ...existingCustomFields };
  for (const key of activeKeys) {
    nextCustomFields[key] = updates[key] ?? null;
  }

  const hasCustomFieldsJson = taskColumns.has('custom_fields_json');
  const shadowColumnKeys = hasCustomFieldsJson ? [] : activeKeys.filter((key) => taskColumns.has(key));
  const assignments = [
    ...(hasCustomFieldsJson ? ['custom_fields_json = ?'] : []),
    ...shadowColumnKeys.map((key) => `${key} = ?`),
  ];
  const values = [
    ...(hasCustomFieldsJson ? [JSON.stringify(nextCustomFields)] : []),
    ...shadowColumnKeys.map((key) => updates[key]),
  ];
  if (assignments.length === 0) return;
  await db.run(`
    UPDATE tasks
    SET ${assignments.join(', ')}, updated_at = datetime('now')
    WHERE id = ?
  `, ...values, taskId);
}

export async function resolveTaskBlockers(blockers: number[] | undefined): Promise<{
  validBlockerIds: number[];
  invalidBlockerIds: number[];
}> {
  const db = getDb();
  const validBlockerIds: number[] = [];
  const invalidBlockerIds: number[] = [];

  if (Array.isArray(blockers) && blockers.length > 0) {
    for (const blockerId of blockers) {
      const exists = await db.get('SELECT id FROM tasks WHERE id = ?', blockerId);
      if (exists) {
        validBlockerIds.push(blockerId);
      } else {
        invalidBlockerIds.push(blockerId);
      }
    }
  }

  return { validBlockerIds, invalidBlockerIds };
}

export async function replaceTaskBlockers(taskId: number, blockers: TaskBlockerInput[]): Promise<void> {
  const db = getDb();
  const normalizedBlockers = blockers
    .map((entry) => ({
      blocker_id: Number(entry?.task_id ?? entry?.blocker_id),
      reason: entry?.reason ?? null,
    }))
    .filter((entry) => Number.isInteger(entry.blocker_id) && entry.blocker_id > 0);

  const existing = await db.all('SELECT blocker_id FROM task_dependencies WHERE blocked_id = ?', taskId) as Array<{ blocker_id: number }>;
  for (const row of existing) {
    await deleteTaskRelationshipByTuple(db, taskId, row.blocker_id, 'blocked_by');
  }
  await db.run('DELETE FROM task_dependencies WHERE blocked_id = ?', taskId);

  for (const blocker of normalizedBlockers) {
    if (blocker.blocker_id === taskId) continue;
    await createRelationshipFromBlockedBy(db, taskId, blocker.blocker_id, 'legacy-blockers-field');
  }
}
