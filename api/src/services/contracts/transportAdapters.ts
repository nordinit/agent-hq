import type { Db } from '../../db/adapter/types';
import { getAgentHqBaseUrl } from '../../lib/agentHqBaseUrl';
import {
  normalizeContractTemplateKey,
  readSprintTypeContractTemplate,
  renderLoadedContractTemplate,
  renderNamedContractTemplate,
} from './templateStore';
import {
  PIPELINE_STAGES,
  resolveEvidenceRequirements,
  resolveWorkflow,
  type EvidenceRequirements,
  type ResolvedWorkflow,
} from './workflowContract';

export type TransportMode = 'local' | 'remote-direct';

export interface TransportContext {
  instanceId: number;
  durableRunId?: string | null;
  taskId: number;
  taskStatus: string;
  taskType?: string | null;
  sprintId?: number | null;
  sprintType?: string | null;
  agentSlug: string;
  sessionKey: string;
  baseUrl?: string;
  transportMode: TransportMode;
  db?: Db | null;
}

export interface CompletionContractContext {
  instanceId: number;
  baseUrl?: string;
}

function getPromptOutcomeHelp(workflow: ResolvedWorkflow): Array<{ outcome: string; description: string }> {
  return [...workflow.outcomeHelp];
}

async function getConfiguredEvidenceRequirements(
  ctx: TransportContext,
  workflow: ResolvedWorkflow,
  promptOutcomes: string[],
): Promise<EvidenceRequirements> {
  return resolveEvidenceRequirements({
    db: ctx.db,
    taskType: ctx.taskType,
    sprintId: ctx.sprintId,
    outcomes: promptOutcomes,
    suggestedOutcome: workflow.suggestedOutcome,
  });
}

function formatEvidenceFields(fields: string[]): string {
  return fields.length > 0 ? fields.join(', ') : 'none configured';
}

function formatEvidenceFieldsBulleted(fields: string[]): string {
  return fields.length > 0 ? fields.map(field => `- ${field}`).join('\n') : '- none configured';
}

function formatOutcomeHelp(help: Array<{ outcome: string; description: string }>): string {
  return help.map(entry => `  ${entry.outcome} — ${entry.description}`).join('\n');
}

async function buildTemplateValues(
  ctx: TransportContext,
  workflow: ResolvedWorkflow,
): Promise<Record<string, string | number>> {
  const baseUrl = ctx.baseUrl ?? getAgentHqBaseUrl();
  const promptOutcomeHelp = getPromptOutcomeHelp(workflow);
  const promptOutcomes = promptOutcomeHelp.map((entry) => entry.outcome);
  const evidence = await getConfiguredEvidenceRequirements(ctx, workflow, promptOutcomes);
  const sprintType = normalizeContractTemplateKey(ctx.sprintType);
  const pipelineStages = PIPELINE_STAGES.join(' -> ');
  const evidenceOutcomes = promptOutcomes
    .filter(outcome => !['blocked', 'failed', 'qa_fail', 'dev_deploy_queued'].includes(outcome))
    .join(', ') || workflow.suggestedOutcome;

  return {
    baseUrl,
    instanceId: ctx.instanceId,
    durableRunId: ctx.durableRunId ?? '',
    taskId: ctx.taskId,
    sessionKey: ctx.sessionKey,
    agentSlug: ctx.agentSlug,
    sprintType,
    workflowTemplateKey: workflow.source,
    workflowSource: workflow.source,
    suggestedOutcome: workflow.suggestedOutcome,
    validOutcomes: promptOutcomes.join(', '),
    outcomeHelp: formatOutcomeHelp(promptOutcomeHelp),
    taskStatus: ctx.taskStatus,
    pipelineStages,
    pipelineReference: pipelineStages,
    evidenceOutcomes,
    evidenceDescription: formatEvidenceFields(evidence.fields),
    evidenceFields: formatEvidenceFields(evidence.fields),
    evidenceFieldNames: formatEvidenceFields(evidence.fieldNames),
    evidenceFieldsBulleted: formatEvidenceFieldsBulleted(evidence.fields),
    transportMode: ctx.transportMode,
  };
}

export function getAvailableContractPlaceholders(): string[] {
  return CONTRACT_PLACEHOLDER_DEFINITIONS.map(placeholder => placeholder.key);
}

export interface ContractPlaceholderDefinition {
  key: string;
  description: string;
}

export const CONTRACT_PLACEHOLDER_DEFINITIONS: ContractPlaceholderDefinition[] = [
  { key: 'baseUrl', description: 'Agent HQ base URL retained for transport metadata; lifecycle writes should use Agent HQ MCP tools.' },
  { key: 'instanceId', description: 'Current dispatched run instance ID for MCP lifecycle writes and run-specific tracing.' },
  { key: 'durableRunId', description: 'Immutable run identifier that remains unique across SQLite backup restores and should be used for chat/log correlation.' },
  { key: 'taskId', description: 'Current task ID, used when posting outcomes or attaching review, QA, or deploy evidence.' },
  { key: 'sessionKey', description: 'OpenClaw session key for this run, useful when a contract needs to reference or resume the active session.' },
  { key: 'agentSlug', description: 'Canonical slug of the assigned agent, typically used in changed_by fields and machine-authored records.' },
  { key: 'sprintType', description: 'Normalized sprint type for the task, such as generic, dev, or ops.' },
  { key: 'workflowTemplateKey', description: 'Workflow resolution source for this dispatch, useful when templates need to explain config-backed versus compatibility routing.' },
  { key: 'workflowSource', description: 'Alias for workflowTemplateKey.' },
  { key: 'suggestedOutcome', description: 'Recommended semantic outcome for the current workflow state when the happy path succeeds.' },
  { key: 'validOutcomes', description: 'Comma-separated list of outcomes valid from the current workflow state.' },
  { key: 'outcomeHelp', description: 'Multi-line outcome dictionary explaining what each valid outcome means in this workflow state.' },
  { key: 'taskStatus', description: 'Current task status at dispatch time, useful when the contract needs to reference the exact pipeline state.' },
  { key: 'pipelineStages', description: 'Status keys in the canonical task pipeline, formatted as a compact sequence.' },
  { key: 'pipelineReference', description: 'Deprecated alias for pipelineStages.' },
  { key: 'evidenceOutcomes', description: 'Comma-separated advancement outcomes considered when resolving configured evidence gate fields.' },
  { key: 'evidenceDescription', description: 'Deprecated alias for evidenceFields.' },
  { key: 'evidenceFields', description: 'Comma-separated configured gate evidence fields, useful inside compact instructions or examples.' },
  { key: 'evidenceFieldNames', description: 'Comma-separated raw configured gate field names after field-expression expansion.' },
  { key: 'evidenceFieldsBulleted', description: 'Configured gate evidence fields formatted as a bulleted list for readable contract sections.' },
  { key: 'transportMode', description: 'Dispatch transport mode, such as local or remote-direct, which affects how the agent reaches Agent HQ.' },
];

export async function buildContractInstructions(ctx: TransportContext): Promise<string> {
  const workflow = await resolveWorkflow({
      taskStatus: ctx.taskStatus,
      taskType: ctx.taskType,
      sprintId: ctx.sprintId,
      sprintType: ctx.sprintType,
      db: ctx.db,
    });
  const template = readSprintTypeContractTemplate(ctx.sprintType);
  return renderLoadedContractTemplate(template, await buildTemplateValues(ctx, workflow));
}

export function buildCompletionContractInstructions(ctx: CompletionContractContext): string {
  return renderNamedContractTemplate('completion', {
    baseUrl: ctx.baseUrl ?? getAgentHqBaseUrl(),
    instanceId: ctx.instanceId,
  });
}
export function resolveTransportMode(params: {
  runtimeType?: string | null;
  runtimeConfig?: unknown;
  hooksUrl?: string | null;
}): TransportMode {
  const type = params.runtimeType ?? 'openclaw';

  if (params.hooksUrl) return 'remote-direct';

  return 'local';
}
