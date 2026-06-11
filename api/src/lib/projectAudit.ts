/**
 * projectAudit.ts — Central audit-log helper for project-level mutations
 *
 * Records audit events for projects, sprints, and job templates so that
 * every structural change to the project hierarchy is traceable.
 *
 * Standardized actor strings:
 *   'system'     — schema migration / seed
 *   'api'        — anonymous API call (no X-Actor header)
 *   'ui'         — UI-initiated action
 *   '<agent>'    — agent name (e.g. 'forge', 'pixel')
 *   '<user>'     — human user identifier
 */

import type Database from 'better-sqlite3';

export type AuditEntityType = 'project' | 'sprint' | 'job_template';
export type AuditAction = 'created' | 'updated' | 'deleted';

export interface AuditChanges {
  [field: string]: unknown | { old: unknown; new: unknown };
}

/**
 * Write a single project_audit_log row.
 */
export function writeProjectAudit(
  db: Database.Database,
  projectId: number,
  entityType: AuditEntityType,
  entityId: number,
  action: AuditAction,
  actor: string,
  changes: AuditChanges = {},
): void {
  db.prepare(`
    INSERT INTO project_audit_log (project_id, entity_type, entity_id, action, actor, changes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, entityType, entityId, action, actor, JSON.stringify(changes));
}

/**
 * Compute field-level diffs between old and new objects.
 * Returns only changed fields in { field: { old, new } } format.
 * Skips fields in the ignore set (e.g. 'updated_at').
 */
export function diffFields(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  ignoreFields: Set<string> = new Set(['updated_at']),
): AuditChanges {
  const changes: AuditChanges = {};
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  for (const key of allKeys) {
    if (ignoreFields.has(key)) continue;
    const oldVal = oldObj[key] ?? null;
    const newVal = newObj[key] ?? null;
    if (String(oldVal) !== String(newVal)) {
      changes[key] = { old: oldVal, new: newVal };
    }
  }
  return changes;
}

/**
 * Extract the actor identity from an Express request.
 * Checks X-Actor header, then falls back to 'api'.
 */
export function extractActor(req: { headers?: Record<string, unknown>; body?: Record<string, unknown> }): string {
  const mcpIdentity = (req as { mcpIdentity?: { auditActor?: string } }).mcpIdentity;
  if (typeof mcpIdentity?.auditActor === 'string' && mcpIdentity.auditActor.trim()) {
    return mcpIdentity.auditActor.trim();
  }
  const header = req.headers?.['x-actor'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const body = req.body?.['_actor'];
  if (typeof body === 'string' && body.trim()) return body.trim();
  return 'api';
}
