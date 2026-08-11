/**
 * contracts/index.ts — Public API for the template-backed workflow contract system.
 *
 * Shared workflow contract rendering and transport metadata.
 */

export {
  resolveWorkflow,
  getAllowedTaskTypesForSprintType,
  isTaskTypeAllowedForSprintType,
  getEvidenceRequirements,
  resolveEvidenceRequirements,
  PIPELINE_STAGES,
  type WorkflowPhase,
  type ResolvedWorkflow,
  type OutcomeHelpEntry,
  type EvidenceRequirements,
} from './workflowContract';

export {
  buildContractInstructions,
  buildContractInstructionsDetailed,
  type RenderedContractInstructions,
  buildCompletionContractInstructions,
  CONTRACT_PLACEHOLDER_DEFINITIONS,
  getAvailableContractPlaceholders,
  type ContractPlaceholderDefinition,
  resolveTransportMode,
  type TransportMode,
  type TransportContext,
} from './transportAdapters';

export {
  getAgentContractRoot,
  getSprintTypeContractPath,
  normalizeContractTemplateKey,
  readSprintTypeContractTemplate,
  writeSprintTypeContractTemplate,
} from './templateStore';
