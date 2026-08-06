import type { Request } from 'express';
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

// ── Wiring mutations to the audit log ─────────────────────────────────────────

/**
 * Where the actor came from. Recorded separately from the actor string because Agent HQ has
 * no user table: an MCP call carries an agent slug, but a browser request carries nothing at
 * all. Flattening both to a single 'api' — as projectAudit's extractActor does — produces a
 * column that says the same thing for every human action, which is worse than admitting the
 * gap. `anonymous_ui` is a truthful answer; 'api' is not.
 */
export interface RoutingAuditActor {
  actor: string;
  actorKind: RoutingAuditActorKind;
}

/** Keys carried on a mutation payload so the domain layer can attribute the change. */
const ACTOR_KEY = '_audit_actor';
const ACTOR_KIND_KEY = '_audit_actor_kind';

export function attachAuditActor<T extends Record<string, unknown>>(input: T, actor: RoutingAuditActor): T {
  return { ...input, [ACTOR_KEY]: actor.actor, [ACTOR_KIND_KEY]: actor.actorKind };
}

/**
 * Who is making this change, as honestly as the system can say.
 *
 * There is no user table and no session: an MCP key carries an agent slug, and a browser
 * request carries nothing. projectAudit's extractActor falls back to the literal 'api', which
 * would make every human canvas edit indistinguishable from every other. Recording
 * `anonymous_ui` instead is less satisfying and more true — and it is the signal that would
 * justify adding real identity later.
 *
 * Lives here rather than in a route module because more than one router audits routing
 * configuration now, and two copies of an identity policy is one copy too many.
 */
export function requestAuditActor(req: Request): RoutingAuditActor {
  const mcpActor = (req as Request & { mcpIdentity?: { auditActor?: string } }).mcpIdentity?.auditActor;
  if (typeof mcpActor === 'string' && mcpActor.trim()) {
    return { actor: mcpActor.trim(), actorKind: 'agent' };
  }
  const header = req.header('x-actor');
  if (typeof header === 'string' && header.trim()) {
    return { actor: header.trim(), actorKind: 'user' };
  }
  return { actor: 'anonymous_ui', actorKind: 'unknown' };
}

export function readAuditActor(input: Record<string, unknown>): RoutingAuditActor {
  const actor = typeof input[ACTOR_KEY] === 'string' && (input[ACTOR_KEY] as string).trim()
    ? (input[ACTOR_KEY] as string).trim()
    : 'unknown';
  const kind = input[ACTOR_KIND_KEY];
  const actorKind: RoutingAuditActorKind = kind === 'user' || kind === 'agent' || kind === 'system'
    ? kind
    : 'unknown';
  return { actor, actorKind };
}

/** Columns every audited routing table carries, used to derive scope from the row itself. */
interface ScopedRow {
  id?: unknown;
  project_id?: unknown;
  sprint_type?: unknown;
  sprint_id?: unknown;
}

function asNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readRowById(db: Db, table: string, id: number): Promise<Record<string, unknown> | null> {
  const row = await db.get(`SELECT * FROM ${table} WHERE id = ?`, id) as Record<string, unknown> | undefined;
  return row ?? null;
}

/**
 * Run a routing mutation and record it, atomically.
 *
 * The before-image has to be read here rather than inside the mutation: deleteRoutingTransition
 * SELECTs only `stt.id`, so by the time it returns there is nothing left to snapshot.
 *
 * The whole thing runs in a transaction so the audit row and the change it describes commit or
 * roll back together. Under a dry run this nests as a savepoint inside the caller's
 * transaction, which is what stops a previewed change from leaving a permanent audit row
 * claiming it happened.
 */
export async function auditedRoutingWrite<T>(
  db: Db,
  spec: {
    table: string;
    action: RoutingAuditAction;
    input: Record<string, unknown>;
    /** Row id for update/delete; omitted for create, where it is taken from the result. */
    id?: unknown;
  },
  run: (tx: Db) => Promise<T>,
): Promise<T> {
  return await db.withTransaction(async (tx) => {
    const knownId = asNumberOrNull(spec.id);
    const before = knownId != null ? await readRowById(tx, spec.table, knownId) : null;

    const result = await run(tx);

    const resultId = asNumberOrNull((result as ScopedRow | null)?.id);
    const rowId = spec.action === 'deleted' ? knownId : (resultId ?? knownId);
    const after = spec.action === 'deleted' || rowId == null ? null : await readRowById(tx, spec.table, rowId);

    // Prefer the surviving row for scope; on a delete only the before-image is left.
    const scopeRow = (after ?? before ?? {}) as ScopedRow;
    const workflowType = typeof scopeRow.sprint_type === 'string' && scopeRow.sprint_type
      ? scopeRow.sprint_type
      : String(spec.input.sprint_type ?? '');

    const tenantId = asNumberOrNull(spec.input.tenant_id);
    if (tenantId == null) {
      throw new Error(`routing audit for ${spec.table} has no tenant_id; the route must resolve one before writing`);
    }

    const { actor, actorKind } = readAuditActor(spec.input);
    await writeRoutingAudit(tx, {
      tenantId,
      projectId: asNumberOrNull(scopeRow.project_id) ?? asNumberOrNull(spec.input.project_id),
      workflowType,
      workflowId: asNumberOrNull(scopeRow.sprint_id) ?? asNumberOrNull(spec.input.sprint_id),
      entityTable: spec.table,
      entityId: rowId,
      action: spec.action,
      actor,
      actorKind,
      before,
      after,
    });

    return result;
  });
}

/**
 * Read the routing config audit trail for one scope.
 *
 * Ordered newest first, because the question this answers is almost always "what changed
 * recently and who did it" rather than "what is the full history". The `changes` column is
 * already a per-field diff, so a caller can answer that without pulling both JSON blobs.
 */
export async function listRoutingAudit(
  db: Db,
  input: {
    project_id?: unknown;
    sprint_id?: unknown;
    sprint_type?: unknown;
    entity_table?: unknown;
    limit?: unknown;
    tenant_id?: unknown;
  },
): Promise<{ entries: Array<Record<string, unknown>> }> {
  const where: string[] = [];
  const params: unknown[] = [];

  const projectId = asNumberOrNull(input.project_id);
  if (projectId != null) { where.push('project_id = ?'); params.push(projectId); }

  const sprintId = asNumberOrNull(input.sprint_id);
  if (sprintId != null) { where.push('workflow_id = ?'); params.push(sprintId); }

  if (typeof input.sprint_type === 'string' && input.sprint_type.trim()) {
    where.push('workflow_type = ?');
    params.push(input.sprint_type.trim());
  }
  if (typeof input.entity_table === 'string' && input.entity_table.trim()) {
    where.push('entity_table = ?');
    params.push(input.entity_table.trim());
  }

  const tenantId = asNumberOrNull(input.tenant_id);
  if (tenantId != null) { where.push('tenant_id = ?'); params.push(tenantId); }

  // Bounded so a caller cannot ask for the whole table by omission; 500 is well above any
  // reasonable review window and well below anything that would hurt.
  const requested = asNumberOrNull(input.limit);
  const limit = requested != null && requested > 0 ? Math.min(requested, 500) : 100;

  const entries = await db.all(`
    SELECT id, tenant_id, project_id, workflow_type, workflow_id, entity_table, entity_id,
           entity_key, action, actor, actor_kind, changes, batch_id, affected_workflow_count,
           created_at
    FROM routing_config_audit_log
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC
    LIMIT ${limit}
  `, ...params) as Array<Record<string, unknown>>;

  return { entries };
}
