import { getDb } from '../../../db/client';
import {
  buildContractInstructions,
  type TransportContext,
} from '../../contracts';

export interface InstanceCallbackContractInput {
  instanceId: number;
  durableRunId?: string | null;
  taskId: number;
  taskStatus: string;
  /** Task type (e.g. 'pm', 'pm_analysis', 'pm_operational', 'backend', 'qa'). Used to select the correct terminal outcome. */
  taskType?: string | null;
  /** Machine-readable legacy workflow id field. Kept as sprintId until the compatibility window ends. */
  sprintId?: number | null;
  /** Machine-readable legacy workflow type field. Kept as sprintType until the compatibility window ends. */
  sprintType?: string | null;
  agentSlug: string;
  sessionKey: string;
  /** Base URL for legacy lifecycle transport metadata. Defaults to Agent HQ base URL env vars (localhost). */
  baseUrl?: string;
  /** Transport mode override — determined by resolveTransportMode() when not specified. */
  transportMode?: 'local' | 'remote-direct';
}

/**
 * buildInstanceCallbackContract — build the full dispatch contract for an instance.
 *
 * Delegates to the contracts/ module which resolves the workflow state and then
 * loads the workflow-type-specific plain text contract template when available.
 * Template placeholders are substituted at dispatch time.
 *
 * Falls back to 'local' transport when transportMode is not specified, preserving
 * backward compatibility with existing local agent dispatches.
 */
export function buildInstanceCallbackContract({
  instanceId,
  durableRunId,
  taskId,
  taskStatus,
  taskType,
  sprintId,
  sprintType,
  agentSlug,
  sessionKey,
  baseUrl: baseUrlOverride,
  transportMode,
}: InstanceCallbackContractInput): string {
  const ctx: TransportContext = {
    instanceId,
    durableRunId,
    taskId,
    taskStatus,
    taskType,
    sprintId,
    sprintType,
    agentSlug,
    sessionKey,
    baseUrl: baseUrlOverride,
    transportMode: transportMode ?? 'local',
    db: getDb(),
  };

  return buildContractInstructions(ctx);
}

export function appendInstanceInstructions(
  message: string,
  instanceId: number,
  durableRunId: string | null,
  taskId: number,
  taskStatus: string,
  agentSlug: string,
  sessionKey: string,
  baseUrl?: string,
  taskType?: string | null,
  sprintId?: number | null,
  sprintType?: string | null,
  transportMode?: 'local' | 'remote-direct',
): string {
  return `${message}\n\n${buildInstanceCallbackContract({ instanceId, durableRunId, taskId, taskStatus, taskType, sprintId, sprintType, agentSlug, sessionKey, baseUrl, transportMode })}`;
}
