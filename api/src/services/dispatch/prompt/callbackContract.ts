import { getDb } from '../../../db/client';
import {
  buildContractInstructions,
  buildContractInstructionsDetailed,
  type RenderedContractInstructions,
  type TransportContext,
} from '../../contracts';
import { type ContextSegmentDraft } from './contextBundle';

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
export async function buildInstanceCallbackContract({
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
}: InstanceCallbackContractInput): Promise<string> {
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

  return await buildContractInstructions(ctx);
}

/** The same contract build, kept as a bundle segment so the viewer can name the template used. */
export async function buildInstanceCallbackContractSegmentDraft(
  input: InstanceCallbackContractInput,
): Promise<ContextSegmentDraft> {
  const ctx: TransportContext = {
    instanceId: input.instanceId,
    durableRunId: input.durableRunId,
    taskId: input.taskId,
    taskStatus: input.taskStatus,
    taskType: input.taskType,
    sprintId: input.sprintId,
    sprintType: input.sprintType,
    agentSlug: input.agentSlug,
    sessionKey: input.sessionKey,
    baseUrl: input.baseUrl,
    transportMode: input.transportMode ?? 'local',
    db: getDb(),
  };
  const contract: RenderedContractInstructions = await buildContractInstructionsDetailed(ctx);

  return {
    kind: 'callback_contract',
    label: 'Callback Contract',
    text: contract.text,
    source: {
      type: 'contract_template',
      label: contract.inheritedFrom
        ? `${contract.templateKey} (inherited from ${contract.inheritedFrom})`
        : contract.templateKey,
      href: '/settings?tab=contracts',
      detail: {
        template_key: contract.templateKey,
        template_path: contract.templatePath,
        inherited_from: contract.inheritedFrom,
        workflow_source: contract.workflowSource,
        suggested_outcome: contract.suggestedOutcome,
        valid_outcomes: contract.validOutcomes.join(', '),
        transport_mode: ctx.transportMode,
        task_status: input.taskStatus,
      },
    },
    omission: contract.inheritedFrom
      ? {
        reason: `No contract template for workflow type "${contract.templateKey}"; fell back to "${contract.inheritedFrom}"`,
      }
      : null,
  };
}

export async function appendInstanceInstructions(
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
): Promise<string> {
  return `${message}\n\n${await buildInstanceCallbackContract({ instanceId, durableRunId, taskId, taskStatus, taskType, sprintId, sprintType, agentSlug, sessionKey, baseUrl, transportMode })}`;
}
