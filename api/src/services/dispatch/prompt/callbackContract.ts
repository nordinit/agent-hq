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

export interface CallbackContractSegments {
  /** Stable procedure. Placed high in the prompt, above everything that changes per run. */
  procedure: ContextSegmentDraft;
  /** Instance ids, session key and paste-ready lifecycle calls. Placed last. */
  runIdentifiers: ContextSegmentDraft;
}

/**
 * The contract as two bundle segments.
 *
 * A contract is ~3.5KB of which only a handful of lines — the ids and the examples embedding them
 * — differ between dispatches. Emitting one block forced the whole thing below every volatile
 * section; emitting two lets the procedure sit with the other stable context and leaves only the
 * ids trailing. Templates without the split marker put everything in runIdentifiers, so their
 * bytes and position are unchanged.
 */
export async function buildInstanceCallbackContractSegmentDrafts(
  input: InstanceCallbackContractInput,
): Promise<CallbackContractSegments> {
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

  const source = {
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
  } as const;

  return {
    procedure: {
      kind: 'callback_contract',
      label: 'Callback Contract',
      text: contract.procedure,
      source: { ...source },
      omission: contract.inheritedFrom
        ? {
          reason: `No contract template for workflow type "${contract.templateKey}"; fell back to "${contract.inheritedFrom}"`,
        }
        : null,
      notInjectedReason: 'This contract template is entirely run identifiers',
    },
    runIdentifiers: {
      kind: 'run_identifiers',
      label: 'Run Identifiers',
      text: contract.runIdentifiers,
      source: {
        ...source,
        detail: {
          instance_id: input.instanceId,
          durable_run_id: input.durableRunId ?? 'none',
          session_key: input.sessionKey,
          task_id: input.taskId,
        },
      },
      notInjectedReason: 'This contract template declares no run-identifier split',
    },
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
