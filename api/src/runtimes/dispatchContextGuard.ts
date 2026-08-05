import type { Db } from '../db/adapter/types';
import {
  assertRuntimeBoundaryV1,
  type RuntimeBoundaryV1,
} from './runtimeBoundary';

export type GuardedLocalRuntimeType = 'claude-code' | 'codex';

export interface RuntimeDispatchGuardInput {
  runtimeType: GuardedLocalRuntimeType;
  agentSlug: string;
  db?: Db | null;
  instanceId?: number | null;
  runtimeBoundary?: RuntimeBoundaryV1 | null;
  dispatchMode?: 'ad-hoc' | null;
  /** Test-only platform override; production callers must omit it. */
  platform?: NodeJS.Platform;
}

export type GuardedRuntimeDispatchContext =
  | {
      mode: 'ad-hoc';
      db: null;
      instanceId: null;
      boundary: null;
      tenantId: null;
      agentId: null;
    }
  | {
      mode: 'production';
      db: Db;
      instanceId: number;
      boundary: RuntimeBoundaryV1;
      tenantId: number;
      agentId: number;
    };

function positiveInteger(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

/**
 * Validate the complete durable dispatch identity before a local runtime may
 * write state, resolve credentials, run a CLI probe, or spawn an agent.
 * Boundaryless launches are available only through an explicit ad-hoc mode
 * with no durable identifiers or database handle.
 */
export async function guardLocalRuntimeDispatchContext(
  input: RuntimeDispatchGuardInput,
): Promise<GuardedRuntimeDispatchContext> {
  if ((input.platform ?? process.platform) === 'win32') {
    throw new Error(
      `${input.runtimeType} local-process dispatch is unsupported on win32 because Agent HQ cannot verify process-group birth identity before spawn`,
    );
  }

  const db = input.db ?? null;
  const instanceId = input.instanceId ?? null;
  const boundary = input.runtimeBoundary ?? null;
  if (input.dispatchMode === 'ad-hoc') {
    if (db !== null || instanceId !== null || boundary !== null) {
      throw new Error(
        'Boundaryless ad-hoc dispatch requires db, instanceId, and runtimeBoundary to all be absent',
      );
    }
    return {
      mode: 'ad-hoc',
      db: null,
      instanceId: null,
      boundary: null,
      tenantId: null,
      agentId: null,
    };
  }

  if (db === null || instanceId === null || boundary === null) {
    throw new Error(
      'Production runtime dispatch requires db, instanceId, and runtimeBoundary as one complete context; use explicit dispatchMode="ad-hoc" only for boundaryless local diagnostics',
    );
  }
  const trustedInstanceId = positiveInteger(instanceId);
  if (trustedInstanceId === null) {
    throw new Error('Production runtime dispatch requires a positive integer instanceId');
  }
  assertRuntimeBoundaryV1(boundary);
  if (boundary.identity.instanceId !== trustedInstanceId) {
    throw new Error(
      `Runtime boundary instance ${boundary.identity.instanceId} does not match dispatch instance ${trustedInstanceId}`,
    );
  }
  if (boundary.runtime.type !== input.runtimeType) {
    throw new Error(
      `Runtime boundary type ${boundary.runtime.type} does not match ${input.runtimeType} dispatch`,
    );
  }
  const agentSlug = input.agentSlug.trim();
  if (!agentSlug || boundary.identity.agentSlug !== agentSlug) {
    throw new Error(
      `Runtime boundary agent slug ${JSON.stringify(boundary.identity.agentSlug)} does not match dispatch agent ${JSON.stringify(agentSlug)}`,
    );
  }
  if (boundary.executionTarget.kind !== 'local-process') {
    throw new Error(
      `Local ${input.runtimeType} dispatch requires a local-process boundary target`,
    );
  }

  const row = await db.get<{ agent_id?: number; tenant_id?: number | null }>(
    'SELECT agent_id, tenant_id FROM job_instances WHERE id = ?',
    trustedInstanceId,
  );
  const authoritativeAgentId = positiveInteger(row?.agent_id);
  const authoritativeTenantId = positiveInteger(row?.tenant_id);
  if (authoritativeAgentId === null || authoritativeTenantId === null) {
    throw new Error(
      `Production runtime dispatch could not resolve authoritative tenant and agent ownership for instance ${trustedInstanceId}`,
    );
  }
  if (
    boundary.identity.agentId !== authoritativeAgentId
    || boundary.identity.tenantId !== authoritativeTenantId
  ) {
    throw new Error(
      `Runtime boundary ownership tenant=${boundary.identity.tenantId} agent=${boundary.identity.agentId} does not match authoritative instance ownership tenant=${authoritativeTenantId} agent=${authoritativeAgentId}`,
    );
  }

  return {
    mode: 'production',
    db,
    instanceId: trustedInstanceId,
    boundary,
    tenantId: authoritativeTenantId,
    agentId: authoritativeAgentId,
  };
}
