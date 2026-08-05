import type { Db } from '../../db/adapter/types';
import {
  fingerprintRuntimeBoundaryV1,
  type RuntimeBoundaryV1,
} from '../runtimeBoundary';

/**
 * Codex resume is a recovery operation, never an arbitrary runtime-config
 * shortcut. The checkpoint and current boundary must describe the same exact
 * instance, workspace, prompt/tool/auth policy, and native thread.
 */
export async function assertCodexResumeAllowed(params: {
  db: Db | null;
  boundary: RuntimeBoundaryV1 | null | undefined;
  instanceId: number | null;
  sessionId: string;
}): Promise<void> {
  const { boundary, db, instanceId, sessionId } = params;
  const prior = boundary?.priorCheckpoint;
  if (!db || instanceId == null || !boundary || !prior) {
    throw new Error(
      'Codex resume requires an Agent HQ-validated prior runtime checkpoint; runtime_config.resumeSessionId cannot be used directly.',
    );
  }

  const currentFingerprint = fingerprintRuntimeBoundaryV1(boundary);
  if (prior.boundaryFingerprint !== currentFingerprint) {
    throw new Error('Codex resume boundary fingerprint does not match the prior checkpoint.');
  }

  let row: { id: number } | undefined;
  try {
    row = await db.get<{ id: number }>(`
      SELECT rc.id
      FROM runtime_checkpoints rc
      JOIN runtime_executions re
        ON re.id = rc.execution_id AND re.tenant_id = rc.tenant_id
      WHERE rc.id = ?
        AND rc.execution_id = ?
        AND rc.sequence = ?
        AND rc.boundary_fingerprint = ?
        AND rc.session_id = ?
        AND re.instance_id = ?
        AND re.tenant_id = ?
      LIMIT 1
    `,
      prior.checkpointId,
      prior.executionId,
      prior.sequence,
      prior.boundaryFingerprint,
      sessionId,
      instanceId,
      boundary.identity.tenantId,
    );
  } catch (error) {
    throw new Error(
      `Codex resume checkpoint could not be verified: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!row) {
    throw new Error('Codex resume checkpoint/session identity was not found for this tenant and instance.');
  }
}
