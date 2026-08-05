import type { Db } from '../db/adapter/types';
import { tableExists } from '../db/introspection';
import { nowTimestamp } from '../lib/timestamps';
import {
  RUNTIME_CHECKPOINT_VERSION,
  assertRuntimeBoundaryV1,
  canonicalRuntimeJson,
  fingerprintRuntimeBoundaryV1,
  type RuntimeBoundaryV1,
  type RuntimeCheckpointKind,
  type RuntimeExecutionHandleV1,
  type RuntimeExecutionState,
  type SanitizedRuntimeLaunchSpecV1,
} from './runtimeBoundary';

export type RuntimeExecutionStoreStatus = 'persisted' | 'unavailable' | 'not_found' | 'conflict';

export interface RuntimeExecutionStoreResult {
  status: RuntimeExecutionStoreStatus;
  executionId: number | null;
}

export interface ClaimedRuntimeExecution extends RuntimeExecutionStoreResult {
  checkpointId: number | null;
  sequence: number | null;
  /** True only when the exact same boundary, launch, process and checkpoint already exist. */
  idempotent: boolean;
}

export interface StartRuntimeExecutionInput {
  boundary: RuntimeBoundaryV1;
  driver: string;
  backend: string;
  state?: 'starting' | 'running';
  launchSpec?: SanitizedRuntimeLaunchSpecV1 | null;
  handle?: RuntimeExecutionHandleV1 | null;
  sessionId?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  startedAt?: string;
  /** Non-secret evidence persisted in the atomic `launched` checkpoint. */
  checkpointData?: Record<string, unknown>;
}

export interface HeartbeatRuntimeExecutionInput {
  instanceId: number;
  heartbeatAt?: string;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  /** Native Claude/Codex session id discovered after process launch. */
  sessionId?: string | null;
}

export interface InterruptRuntimeExecutionInput {
  instanceId: number;
  tenantId: number;
  reason?: string | null;
  requestedAt?: string;
}

export interface TerminalRuntimeExecutionInput {
  instanceId: number;
  state: Extract<RuntimeExecutionState, 'succeeded' | 'failed' | 'cancelled' | 'lost'>;
  reason?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
  endedAt?: string;
}

export interface AppendRuntimeCheckpointInput {
  executionId: number;
  kind: RuntimeCheckpointKind;
  state: RuntimeExecutionState;
  sessionId?: string | null;
  boundaryFingerprint?: string;
  transcriptCursor?: Record<string, unknown> | null;
  data?: Record<string, unknown>;
  createdAt?: string;
}

export interface AppendedRuntimeCheckpoint extends RuntimeExecutionStoreResult {
  checkpointId: number | null;
  sequence: number | null;
}

const availability = new WeakMap<Db, Promise<boolean>>();

/** Runtime paths remain safe while rolling past a pre-migration/test database. */
export function runtimeExecutionStoreAvailable(db: Db): Promise<boolean> {
  let pending = availability.get(db);
  if (!pending) {
    pending = Promise.all([
      tableExists(db, 'runtime_executions'),
      tableExists(db, 'runtime_checkpoints'),
    ]).then(([executions, checkpoints]) => executions && checkpoints);
    availability.set(db, pending);
  }
  return pending;
}

/** Test/migration hook; normal processes verify migrations before accepting work. */
export function clearRuntimeExecutionStoreAvailabilityCache(db: Db): void {
  availability.delete(db);
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function storedJsonEquals(left: unknown, right: unknown): boolean {
  return canonicalRuntimeJson(parseStoredJson(left)) === canonicalRuntimeJson(right);
}

/**
 * Claim one process launch and persist its `launched` checkpoint atomically.
 *
 * A job instance owns at most one local execution. A conflicting caller must
 * tear down the process it just spawned; it may never replace the authoritative
 * handle for an already-running or terminal execution. Retrying the same claim
 * is idempotent only when every immutable launch/process/checkpoint field is
 * byte-for-byte equivalent after canonical JSON normalization.
 */
export async function upsertRuntimeExecutionStart(
  db: Db,
  input: StartRuntimeExecutionInput,
): Promise<ClaimedRuntimeExecution> {
  if (!(await runtimeExecutionStoreAvailable(db))) {
    return {
      status: 'unavailable',
      executionId: null,
      checkpointId: null,
      sequence: null,
      idempotent: false,
    };
  }

  assertRuntimeBoundaryV1(input.boundary);
  const fingerprint = fingerprintRuntimeBoundaryV1(input.boundary);
  const startedAt = input.startedAt ?? nowTimestamp();
  const state = input.state ?? 'running';
  const checkpointData = input.checkpointData ?? {};

  return await db.withTransaction(async (tx) => {
    const inserted = await tx.get<{ id: number }>(`
      INSERT INTO runtime_executions (
        tenant_id, instance_id, boundary_version, boundary_json, boundary_fingerprint,
        runtime_type, driver, backend, execution_target_id, sanitized_launch_spec,
        opaque_handle, state, session_id, capability_snapshot, lease_owner,
        lease_expires_at, heartbeat_at, started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, instance_id) DO NOTHING
      RETURNING id
    `,
      input.boundary.identity.tenantId,
      input.boundary.identity.instanceId,
      input.boundary.version,
      JSON.stringify(input.boundary),
      fingerprint,
      input.boundary.runtime.type,
      input.driver,
      input.backend,
      input.boundary.executionTarget.id,
      input.launchSpec ? JSON.stringify(input.launchSpec) : null,
      input.handle ? JSON.stringify(input.handle) : null,
      state,
      input.sessionId ?? null,
      JSON.stringify(input.boundary.executionTarget.capabilities),
      input.leaseOwner ?? null,
      input.leaseExpiresAt ?? null,
      startedAt,
      startedAt,
      startedAt,
      startedAt,
    );

    if (inserted) {
      const checkpoint = await appendRuntimeCheckpointInTransaction(tx, {
        executionId: Number(inserted.id),
        kind: 'launched',
        state,
        sessionId: input.sessionId ?? null,
        boundaryFingerprint: fingerprint,
        data: checkpointData,
        createdAt: startedAt,
      });
      if (checkpoint.status !== 'persisted' || checkpoint.checkpointId == null) {
        throw new Error('Atomic runtime launch checkpoint was not persisted.');
      }
      return {
        status: 'persisted' as const,
        executionId: Number(inserted.id),
        checkpointId: checkpoint.checkpointId,
        sequence: checkpoint.sequence,
        idempotent: false,
      };
    }

    const lock = tx.dialect === 'postgres' ? ' FOR UPDATE' : '';
    const existing = await tx.get<{
      id: number;
      boundary_version: number;
      boundary_json: unknown;
      boundary_fingerprint: string;
      runtime_type: string;
      driver: string;
      backend: string;
      execution_target_id: string;
      sanitized_launch_spec: unknown;
      opaque_handle: unknown;
      state: string;
      session_id: string | null;
      capability_snapshot: unknown;
      lease_owner: string | null;
      lease_expires_at: string | null;
      started_at: string | null;
      ended_at: string | null;
    }>(`
      SELECT id, boundary_version, boundary_json, boundary_fingerprint,
             runtime_type, driver, backend, execution_target_id,
             sanitized_launch_spec, opaque_handle, state, session_id,
             capability_snapshot, lease_owner, lease_expires_at,
             started_at, ended_at
      FROM runtime_executions
      WHERE tenant_id = ? AND instance_id = ?${lock}
    `, input.boundary.identity.tenantId, input.boundary.identity.instanceId);

    const exactlySame = Boolean(
      existing
      && existing.ended_at == null
      && Number(existing.boundary_version) === input.boundary.version
      && existing.boundary_fingerprint === fingerprint
      && existing.runtime_type === input.boundary.runtime.type
      && existing.driver === input.driver
      && existing.backend === input.backend
      && existing.execution_target_id === input.boundary.executionTarget.id
      && existing.state === state
      && existing.session_id === (input.sessionId ?? null)
      && existing.lease_owner === (input.leaseOwner ?? null)
      && existing.lease_expires_at === (input.leaseExpiresAt ?? null)
      && existing.started_at === startedAt
      && storedJsonEquals(existing.boundary_json, input.boundary)
      && storedJsonEquals(existing.sanitized_launch_spec, input.launchSpec ?? null)
      && storedJsonEquals(existing.opaque_handle, input.handle ?? null)
      && storedJsonEquals(existing.capability_snapshot, input.boundary.executionTarget.capabilities)
    );
    if (!existing || !exactlySame) {
      return {
        status: 'conflict' as const,
        executionId: existing ? Number(existing.id) : null,
        checkpointId: null,
        sequence: null,
        idempotent: false,
      };
    }

    const launched = await tx.get<{
      id: number;
      sequence: number;
      state: string;
      session_id: string | null;
      boundary_fingerprint: string;
      checkpoint_data: unknown;
      created_at: string;
    }>(`
      SELECT id, sequence, state, session_id, boundary_fingerprint,
             checkpoint_data, created_at
      FROM runtime_checkpoints
      WHERE execution_id = ? AND kind = 'launched'
      ORDER BY sequence ASC
      LIMIT 1${lock}
    `, Number(existing.id));
    const sameCheckpoint = Boolean(
      launched
      && launched.state === state
      && launched.session_id === (input.sessionId ?? null)
      && launched.boundary_fingerprint === fingerprint
      && launched.created_at === startedAt
      && storedJsonEquals(launched.checkpoint_data, checkpointData)
    );
    return sameCheckpoint && launched
      ? {
          status: 'persisted' as const,
          executionId: Number(existing.id),
          checkpointId: Number(launched.id),
          sequence: Number(launched.sequence),
          idempotent: true,
        }
      : {
          status: 'conflict' as const,
          executionId: Number(existing.id),
          checkpointId: null,
          sequence: null,
          idempotent: false,
        };
  });
}

export async function heartbeatRuntimeExecution(
  db: Db,
  input: HeartbeatRuntimeExecutionInput,
): Promise<RuntimeExecutionStoreResult> {
  if (!(await runtimeExecutionStoreAvailable(db))) return { status: 'unavailable', executionId: null };
  const heartbeatAt = input.heartbeatAt ?? nowTimestamp();
  const row = await db.get<{ id: number }>(`
    UPDATE runtime_executions
    SET heartbeat_at = ?,
        lease_owner = COALESCE(?, lease_owner),
        lease_expires_at = COALESCE(?, lease_expires_at),
        session_id = COALESCE(?, session_id),
        updated_at = ?
    WHERE instance_id = ?
      AND state IN ('preparing', 'starting', 'running', 'interrupting')
    RETURNING id
  `,
    heartbeatAt,
    input.leaseOwner ?? null,
    input.leaseExpiresAt ?? null,
    input.sessionId ?? null,
    heartbeatAt,
    input.instanceId,
  );
  return row
    ? { status: 'persisted', executionId: Number(row.id) }
    : { status: 'not_found', executionId: null };
}

export async function interruptRuntimeExecution(
  db: Db,
  input: InterruptRuntimeExecutionInput,
): Promise<RuntimeExecutionStoreResult> {
  if (!(await runtimeExecutionStoreAvailable(db))) return { status: 'unavailable', executionId: null };
  const requestedAt = input.requestedAt ?? nowTimestamp();
  return await db.withTransaction(async (tx) => {
    const row = await tx.get<{ id: number; boundary_fingerprint: string; session_id: string | null }>(`
      UPDATE runtime_executions
      SET state = 'interrupting',
          terminal_reason = COALESCE(?, terminal_reason),
          updated_at = ?
      WHERE instance_id = ?
        AND tenant_id = ?
        AND state IN ('preparing', 'starting', 'running', 'interrupting')
      RETURNING id, boundary_fingerprint, session_id
    `, input.reason ?? null, requestedAt, input.instanceId, input.tenantId);
    if (!row) return { status: 'not_found' as const, executionId: null };

    const checkpoint = await appendRuntimeCheckpointInTransaction(tx, {
      executionId: Number(row.id),
      kind: 'interrupt_requested',
      state: 'interrupting',
      sessionId: row.session_id,
      boundaryFingerprint: row.boundary_fingerprint,
      data: { reason: input.reason ?? null },
      createdAt: requestedAt,
    });
    if (checkpoint.status !== 'persisted') {
      throw new Error('Atomic runtime interrupt checkpoint was not persisted.');
    }
    return { status: 'persisted' as const, executionId: Number(row.id) };
  });
}

export async function terminalRuntimeExecution(
  db: Db,
  input: TerminalRuntimeExecutionInput,
): Promise<RuntimeExecutionStoreResult> {
  if (!(await runtimeExecutionStoreAvailable(db))) return { status: 'unavailable', executionId: null };
  const endedAt = input.endedAt ?? nowTimestamp();
  const metadata = input.metadata ?? {};
  return await db.withTransaction(async (tx) => {
    const row = await tx.get<{ id: number; boundary_fingerprint: string; session_id: string | null }>(`
      UPDATE runtime_executions
      SET state = ?,
          terminal_reason = ?,
          terminal_error = ?,
          terminal_metadata = ?,
          ended_at = ?,
          heartbeat_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?
      WHERE instance_id = ?
        AND state NOT IN ('succeeded', 'failed', 'cancelled', 'lost')
      RETURNING id, boundary_fingerprint, session_id
    `,
      input.state,
      input.reason ?? null,
      input.error ?? null,
      JSON.stringify(metadata),
      endedAt,
      endedAt,
      endedAt,
      input.instanceId,
    );
    if (!row) return { status: 'not_found' as const, executionId: null };

    const checkpoint = await appendRuntimeCheckpointInTransaction(tx, {
      executionId: Number(row.id),
      kind: 'terminal',
      state: input.state,
      sessionId: row.session_id,
      boundaryFingerprint: row.boundary_fingerprint,
      data: {
        reason: input.reason ?? null,
        error: input.error ?? null,
        metadata,
      },
      createdAt: endedAt,
    });
    if (checkpoint.status !== 'persisted') {
      throw new Error('Atomic runtime terminal checkpoint was not persisted.');
    }
    return { status: 'persisted' as const, executionId: Number(row.id) };
  });
}

async function appendRuntimeCheckpointInTransaction(
  tx: Db,
  input: AppendRuntimeCheckpointInput,
): Promise<AppendedRuntimeCheckpoint> {
  const lock = tx.dialect === 'postgres' ? ' FOR UPDATE' : '';
  const execution = await tx.get<{
    id: number;
    tenant_id: number;
    boundary_fingerprint: string;
    session_id: string | null;
  }>(`
    SELECT id, tenant_id, boundary_fingerprint, session_id
    FROM runtime_executions
    WHERE id = ?${lock}
  `, input.executionId);
  if (!execution) {
    return { status: 'not_found', executionId: null, checkpointId: null, sequence: null };
  }

  const sequence = Number(await tx.value<number>(`
    SELECT COALESCE(MAX(sequence), -1) + 1
    FROM runtime_checkpoints
    WHERE execution_id = ?
  `, input.executionId) ?? 0);
  const createdAt = input.createdAt ?? nowTimestamp();
  const row = await tx.get<{ id: number }>(`
    INSERT INTO runtime_checkpoints (
      tenant_id, execution_id, version, sequence, kind, state, session_id,
      boundary_fingerprint, transcript_cursor, checkpoint_data, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `,
    execution.tenant_id,
    input.executionId,
    RUNTIME_CHECKPOINT_VERSION,
    sequence,
    input.kind,
    input.state,
    input.sessionId ?? execution.session_id,
    input.boundaryFingerprint ?? execution.boundary_fingerprint,
    input.transcriptCursor ? JSON.stringify(input.transcriptCursor) : null,
    JSON.stringify(input.data ?? {}),
    createdAt,
  );
  return row
    ? {
        status: 'persisted',
        executionId: input.executionId,
        checkpointId: Number(row.id),
        sequence,
      }
    : {
        status: 'not_found',
        executionId: input.executionId,
        checkpointId: null,
        sequence: null,
      };
}

export async function appendRuntimeCheckpoint(
  db: Db,
  input: AppendRuntimeCheckpointInput,
): Promise<AppendedRuntimeCheckpoint> {
  if (!(await runtimeExecutionStoreAvailable(db))) {
    return { status: 'unavailable', executionId: null, checkpointId: null, sequence: null };
  }

  return await db.withTransaction(async (tx) => await appendRuntimeCheckpointInTransaction(tx, input));
}
