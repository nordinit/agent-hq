import { listSprintTaskStatuses } from './policy/statuses';
import { parseObjectJson, parseSprintId, requireSprint, withStatus, StatusError } from './scope';
import { type Db } from "../../db/adapter/types";

async function requireSprintStatusScope(db: Db, sprintIdRaw: unknown, tenantIdRaw?: unknown): Promise<number> {
  const sprintId = parseSprintId(sprintIdRaw);
  if (!sprintId) throw withStatus('sprint_id is required for sprint task status policy operations', 400);
  const tenantId = Number.isFinite(Number(tenantIdRaw)) ? Number(tenantIdRaw) : null;
  await requireSprint(db, sprintId, tenantId);
  return sprintId;
}

export async function listRoutingStatuses(db: Db, input: { sprint_id?: unknown; tenant_id?: unknown }) {
  const sprintId = await requireSprintStatusScope(db, input.sprint_id, input.tenant_id);
  return { statuses: await listSprintTaskStatuses(db, sprintId) };
}

export async function updateRoutingStatus(
  db: Db,
  input: Record<string, unknown> & { name: string },
) {
  const { name } = input;
  const sprintId = await requireSprintStatusScope(db, input.sprint_id, input.tenant_id);
  const { label, color, allowed_transitions, emoji } = input;

  const existing = await db.get(`
    SELECT *
    FROM sprint_task_statuses
    WHERE sprint_id = ? AND status_key = ?
  `, sprintId, name) as Record<string, unknown> | undefined;
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
  await db.run(`
    UPDATE sprint_task_statuses
    SET ${sets.join(', ')}, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE sprint_id = ? AND status_key = ?
  `, ...vals);

  const updated = (await listSprintTaskStatuses(db, sprintId)).find(status => status.name === name);
  if (!updated) throw withStatus(`Status '${name}' not found for sprint ${sprintId}`, 404);
  return updated;
}

export async function createRoutingStatus(db: Db, input: Record<string, unknown>) {
  const sprintId = await requireSprintStatusScope(db, input.sprint_id, input.tenant_id);
  const name = input.name;
  const label = input.label;
  const color = input.color;
  const allowedTransitions = input.allowed_transitions;

  if (!name || !label) {
    throw withStatus('name and label are required', 400);
  }

  const existing = await db.get(`
    SELECT status_key
    FROM sprint_task_statuses
    WHERE sprint_id = ? AND status_key = ?
  `, sprintId, name);
  if (existing) {
    throw withStatus(`Status '${name}' already exists for sprint ${sprintId}`, 409);
  }
  await db.run(`
    INSERT INTO sprint_task_statuses (
      sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, 0, ?, COALESCE((SELECT MAX(stage_order) + 1 FROM sprint_task_statuses WHERE sprint_id = ?), 0), 0, '{}', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
  `, sprintId, name, label, color || 'slate', JSON.stringify(allowedTransitions ?? []), sprintId);

  const created = (await listSprintTaskStatuses(db, sprintId)).find(status => status.name === name);
  if (!created) throw withStatus(`Status '${String(name)}' not found for sprint ${sprintId}`, 404);
  return created;
}

export async function deleteRoutingStatus(
  db: Db,
  input: Record<string, unknown> & { name: string },
) {
  const { name } = input;
  const sprintId = await requireSprintStatusScope(db, input.sprint_id, input.tenant_id);

  const existing = await db.get(`
    SELECT *
    FROM sprint_task_statuses
    WHERE sprint_id = ? AND status_key = ?
  `, sprintId, name) as Record<string, unknown> | undefined;
  if (!existing) {
    throw withStatus(`Status '${name}' not found for sprint ${sprintId}`, 404);
  }

  const taskCount = (await db.get('SELECT COUNT(*) as n FROM tasks WHERE sprint_id = ? AND status = ?', sprintId, name) as { n: number }).n;
  if (taskCount > 0) {
    const error = withStatus(`Cannot delete status '${name}': ${taskCount} task${taskCount !== 1 ? 's' : ''} currently use this status in sprint ${sprintId}`, 409) as StatusError & Record<string, unknown>;
    error.reason = 'tasks_in_use';
    error.task_count = taskCount;
    throw error;
  }
  const transitionRefs = await db.all(`
    SELECT id, from_status, outcome, to_status
    FROM sprint_task_transitions
    WHERE sprint_id = ? AND (from_status = ? OR to_status = ?)
  `, sprintId, name, name) as { id: number; from_status: string; outcome: string; to_status: string }[];
  if (transitionRefs.length > 0) {
    const error = withStatus(`Cannot delete status '${name}': referenced by ${transitionRefs.length} sprint transition${transitionRefs.length !== 1 ? 's' : ''}`, 409) as StatusError & Record<string, unknown>;
    error.reason = 'transitions_in_use';
    error.transitions = transitionRefs;
    throw error;
  }
  const allStatuses = await db.all(`
    SELECT status_key, allowed_transitions_json
    FROM sprint_task_statuses
    WHERE sprint_id = ? AND status_key != ?
  `, sprintId, name) as Array<{ status_key: string; allowed_transitions_json: string }>;
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
  await db.run('DELETE FROM sprint_task_statuses WHERE sprint_id = ? AND status_key = ?', sprintId, name);
  return { ok: true, deleted: name, sprint_id: sprintId };
}
