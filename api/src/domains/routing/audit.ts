import { diffFields, type AuditChanges } from '../../lib/projectAudit';
import { type Db } from "../../db/adapter/types";

export type RoutingAuditAction = 'created' | 'updated' | 'deleted';
export type RoutingAuditActorKind = 'user' | 'agent' | 'system' | 'unknown';

export interface RoutingAuditEntry {
  tenantId: number;
  projectId?: number | null;
  workflowType: string;
  workflowId?: number | null;
  /** Physical table the changed row lives in, e.g. 'sprint_task_transitions'. */
  entityTable: string;
  entityId?: number | null;
  /** Natural key for rows identified by something other than an id (a status name, an outcome). */
  entityKey?: string;
  action: RoutingAuditAction;
  actor?: string;
  actorKind?: RoutingAuditActorKind;
  /** Full row snapshot before the change; null for a creation. */
  before?: Record<string, unknown> | null;
  /** Full row snapshot after the change; null for a deletion. */
  after?: Record<string, unknown> | null;
  /** Groups the rows written by one multi-row mutation so they can be undone together. */
  batchId?: string;
  affectedWorkflowCount?: number | null;
}

/**
 * Write a single routing_config_audit_log row.
 *
 * Throws on failure, deliberately unlike emitTaskEvent in domains/tasks/history.ts, which
 * swallows because a missing telemetry row costs nothing. This row is the ONLY record of what
 * the routing configuration used to be and the intended input to undoing the change, so a
 * silent failure leaves a mutation that cannot be explained or reverted — strictly worse than
 * a mutation that was refused.
 *
 * The Db handle is a parameter rather than a getDb() call so the row is written on the
 * caller's connection, and is therefore rolled back with the mutation it describes instead of
 * outliving it.
 */
export async function writeRoutingAudit(db: Db, entry: RoutingAuditEntry): Promise<void> {
  const before = entry.before ?? null;
  const after = entry.after ?? null;
  const changes: AuditChanges = diffFields(before ?? {}, after ?? {});

  await db.run(`
    INSERT INTO routing_config_audit_log (
      tenant_id, project_id, workflow_type, workflow_id,
      entity_table, entity_id, entity_key, action,
      actor, actor_kind, before_json, after_json, changes,
      batch_id, affected_workflow_count
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    entry.tenantId,
    entry.projectId ?? null,
    entry.workflowType,
    entry.workflowId ?? null,
    entry.entityTable,
    entry.entityId ?? null,
    entry.entityKey ?? '',
    entry.action,
    entry.actor ?? 'unknown',
    entry.actorKind ?? 'unknown',
    JSON.stringify(before),
    JSON.stringify(after),
    JSON.stringify(changes),
    entry.batchId ?? '',
    entry.affectedWorkflowCount ?? null,
  );
}
