import type Database from 'better-sqlite3';
import { getDb } from '../../db/client';
import { createRelationshipFromBlockedBy, deleteTaskRelationshipByTuple } from './relationships';
import { triggerDispatch } from '../../services/dispatchTrigger';
import { writeTaskHistory } from './history';
import { parseCustomFields } from './fields';
import { resolveRuntimeTenantId, tenantInsertColumns } from '../../lib/runtimeTenantScope';

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

export function logHistory(
  taskId: number,
  changedBy: string,
  field: string,
  oldValue: unknown,
  newValue: unknown,
  dbOverride?: Database.Database,
): void {
  writeTaskHistory(dbOverride ?? getDb(), taskId, changedBy, field, oldValue, newValue, false);
}

export function taskTableHasColumn(db: Database.Database, column: string): boolean {
  return (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).some((col) => col.name === column);
}

export function addTaskNote(taskId: number, author: string, content: string, dbOverride?: Database.Database): void {
  const db = dbOverride ?? getDb();
  const tenantId = resolveRuntimeTenantId(db, { taskId });
  const tenant = tenantInsertColumns(db, 'task_notes', tenantId);
  db.prepare(`
    INSERT INTO task_notes (${tenant.columnSql}task_id, author, content)
    VALUES (${tenant.valueSql}?, ?, ?)
  `).run(...tenant.values, taskId, author, content);
}

export function updateTaskEvidence(
  taskId: number,
  changedBy: string,
  updates: Record<string, unknown>,
  options?: { explicitClears?: Set<string>; db?: Database.Database },
): void {
  const db = options?.db ?? getDb();
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!existing) throw new Error('Task not found');
  const taskColumns = new Set((db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((col) => col.name));
  const existingCustomFields = (() => {
    try {
      return taskColumns.has('custom_fields_json') ? parseCustomFields(existing.custom_fields_json) : {};
    } catch {
      return {};
    }
  })();

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
      logHistory(taskId, changedBy, key, oldValue, newValue, db);
    }
  }

  const nextCustomFields = { ...existingCustomFields };
  for (const key of activeKeys) {
    nextCustomFields[key] = updates[key] ?? null;
  }

  const shadowColumnKeys = activeKeys.filter((key) => taskColumns.has(key));
  const assignments = [
    ...(taskColumns.has('custom_fields_json') ? ['custom_fields_json = ?'] : []),
    ...shadowColumnKeys.map((key) => `${key} = ?`),
  ];
  const values = [
    ...(taskColumns.has('custom_fields_json') ? [JSON.stringify(nextCustomFields)] : []),
    ...shadowColumnKeys.map((key) => updates[key]),
  ];
  if (assignments.length === 0) return;
  db.prepare(`
    UPDATE tasks
    SET ${assignments.join(', ')}, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    ...values,
    taskId,
  );
}

export function resolveTaskBlockers(blockers: number[] | undefined): {
  validBlockerIds: number[];
  invalidBlockerIds: number[];
} {
  const db = getDb();
  const validBlockerIds: number[] = [];
  const invalidBlockerIds: number[] = [];

  if (Array.isArray(blockers) && blockers.length > 0) {
    for (const blockerId of blockers) {
      const exists = db.prepare('SELECT id FROM tasks WHERE id = ?').get(blockerId);
      if (exists) {
        validBlockerIds.push(blockerId);
      } else {
        invalidBlockerIds.push(blockerId);
      }
    }
  }

  return { validBlockerIds, invalidBlockerIds };
}

export function replaceTaskBlockers(taskId: number, blockers: TaskBlockerInput[]): void {
  const db = getDb();
  const normalizedBlockers = blockers
    .map((entry) => ({
      blocker_id: Number(entry?.task_id ?? entry?.blocker_id),
      reason: entry?.reason ?? null,
    }))
    .filter((entry) => Number.isInteger(entry.blocker_id) && entry.blocker_id > 0);

  const existing = db.prepare('SELECT blocker_id FROM task_dependencies WHERE blocked_id = ?').all(taskId) as Array<{ blocker_id: number }>;
  for (const row of existing) {
    deleteTaskRelationshipByTuple(db, taskId, row.blocker_id, 'blocked_by');
  }
  db.prepare('DELETE FROM task_dependencies WHERE blocked_id = ?').run(taskId);

  for (const blocker of normalizedBlockers) {
    if (blocker.blocker_id === taskId) continue;
    createRelationshipFromBlockedBy(db, taskId, blocker.blocker_id, 'legacy-blockers-field');
  }
}
