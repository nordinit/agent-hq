import type Database from 'better-sqlite3';
import { listSprintTaskStatuses } from './policy/statuses';
import { seedSprintTaskPolicy } from './policy/seed';
import { parseObjectJson, parseSprintId, requireSprint, withStatus, StatusError } from './scope';

function requireSprintStatusScope(db: Database.Database, sprintIdRaw: unknown, tenantIdRaw?: unknown): number {
  const sprintId = parseSprintId(sprintIdRaw);
  if (!sprintId) throw withStatus('sprint_id is required for sprint task status policy operations', 400);
  const tenantId = Number.isFinite(Number(tenantIdRaw)) ? Number(tenantIdRaw) : null;
  requireSprint(db, sprintId, tenantId);
  return sprintId;
}

export function listRoutingStatuses(db: Database.Database, input: { sprint_id?: unknown; tenant_id?: unknown }) {
  const sprintId = requireSprintStatusScope(db, input.sprint_id, input.tenant_id);
  return { statuses: listSprintTaskStatuses(db, sprintId) };
}

export function updateRoutingStatus(
  db: Database.Database,
  input: Record<string, unknown> & { name: string },
) {
  const { name } = input;
  const sprintId = requireSprintStatusScope(db, input.sprint_id, input.tenant_id);
  const { label, color, allowed_transitions, emoji } = input;

  seedSprintTaskPolicy(db, sprintId);
  const existing = db.prepare(`
    SELECT *
    FROM sprint_task_statuses
    WHERE sprint_id = ? AND status_key = ?
  `).get(sprintId, name) as Record<string, unknown> | undefined;
  if (!existing) {
    throw withStatus(`Status '${name}' not found for sprint ${sprintId}`, 404);
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (label !== undefined) { sets.push('label = ?'); vals.push(label); }
  if (color !== undefined) { sets.push('color = ?'); vals.push(color); }
  if (allowed_transitions !== undefined) {
    sets.push('allowed_transitions_json = ?');
    vals.push(JSON.stringify(allowed_transitions));
  }
  if (emoji !== undefined) {
    const metadata = parseObjectJson(existing.metadata_json);
    if (emoji === null || emoji === '') {
      delete metadata.emoji;
    } else {
      metadata.emoji = String(emoji);
    }
    sets.push('metadata_json = ?');
    vals.push(JSON.stringify(metadata));
  }
  if (sets.length === 0) throw withStatus('No fields to update', 400);
  vals.push(sprintId, name);
  db.prepare(`
    UPDATE sprint_task_statuses
    SET ${sets.join(', ')}, updated_at = datetime('now')
    WHERE sprint_id = ? AND status_key = ?
  `).run(...vals);

  const updated = listSprintTaskStatuses(db, sprintId).find(status => status.name === name);
  if (!updated) throw withStatus(`Status '${name}' not found for sprint ${sprintId}`, 404);
  return updated;
}

export function createRoutingStatus(db: Database.Database, input: Record<string, unknown>) {
  const sprintId = requireSprintStatusScope(db, input.sprint_id, input.tenant_id);
  const name = input.name;
  const label = input.label;
  const color = input.color;
  const allowedTransitions = input.allowed_transitions;

  if (!name || !label) {
    throw withStatus('name and label are required', 400);
  }

  seedSprintTaskPolicy(db, sprintId);
  const existing = db.prepare(`
    SELECT status_key
    FROM sprint_task_statuses
    WHERE sprint_id = ? AND status_key = ?
  `).get(sprintId, name);
  if (existing) {
    throw withStatus(`Status '${name}' already exists for sprint ${sprintId}`, 409);
  }
  db.prepare(`
    INSERT INTO sprint_task_statuses (
      sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, 0, ?, COALESCE((SELECT MAX(stage_order) + 1 FROM sprint_task_statuses WHERE sprint_id = ?), 0), 0, '{}', datetime('now'), datetime('now'))
  `).run(sprintId, name, label, color || 'slate', JSON.stringify(allowedTransitions ?? []), sprintId);

  const created = listSprintTaskStatuses(db, sprintId).find(status => status.name === name);
  if (!created) throw withStatus(`Status '${String(name)}' not found for sprint ${sprintId}`, 404);
  return created;
}

export function deleteRoutingStatus(
  db: Database.Database,
  input: Record<string, unknown> & { name: string },
) {
  const { name } = input;
  const sprintId = requireSprintStatusScope(db, input.sprint_id, input.tenant_id);

  seedSprintTaskPolicy(db, sprintId);
  const existing = db.prepare(`
    SELECT *
    FROM sprint_task_statuses
    WHERE sprint_id = ? AND status_key = ?
  `).get(sprintId, name) as Record<string, unknown> | undefined;
  if (!existing) {
    throw withStatus(`Status '${name}' not found for sprint ${sprintId}`, 404);
  }

  const taskCount = (db.prepare(
    'SELECT COUNT(*) as n FROM tasks WHERE sprint_id = ? AND status = ?'
  ).get(sprintId, name) as { n: number }).n;
  if (taskCount > 0) {
    const error = withStatus(`Cannot delete status '${name}': ${taskCount} task${taskCount !== 1 ? 's' : ''} currently use this status in sprint ${sprintId}`, 409) as StatusError & Record<string, unknown>;
    error.reason = 'tasks_in_use';
    error.task_count = taskCount;
    throw error;
  }
  const transitionRefs = db.prepare(`
    SELECT id, from_status, outcome, to_status
    FROM sprint_task_transitions
    WHERE sprint_id = ? AND (from_status = ? OR to_status = ?)
  `).all(sprintId, name, name) as { id: number; from_status: string; outcome: string; to_status: string }[];
  if (transitionRefs.length > 0) {
    const error = withStatus(`Cannot delete status '${name}': referenced by ${transitionRefs.length} sprint transition${transitionRefs.length !== 1 ? 's' : ''}`, 409) as StatusError & Record<string, unknown>;
    error.reason = 'transitions_in_use';
    error.transitions = transitionRefs;
    throw error;
  }
  const allStatuses = db.prepare(`
    SELECT status_key, allowed_transitions_json
    FROM sprint_task_statuses
    WHERE sprint_id = ? AND status_key != ?
  `).all(sprintId, name) as Array<{ status_key: string; allowed_transitions_json: string }>;
  const referencingStatuses = allStatuses.filter((row) => {
    try {
      return (JSON.parse(row.allowed_transitions_json || '[]') as string[]).includes(name);
    } catch {
      return false;
    }
  }).map(row => row.status_key);
  if (referencingStatuses.length > 0) {
    const error = withStatus(`Cannot delete status '${name}': referenced in allowed_transitions of: ${referencingStatuses.join(', ')}`, 409) as StatusError & Record<string, unknown>;
    error.reason = 'referenced_by_statuses';
    error.referencing_statuses = referencingStatuses;
    throw error;
  }
  db.prepare('DELETE FROM sprint_task_statuses WHERE sprint_id = ? AND status_key = ?').run(sprintId, name);
  return { ok: true, deleted: name, sprint_id: sprintId };
}
