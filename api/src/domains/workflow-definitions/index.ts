// Workflow definitions domain entrypoint.
// This owns workflow-definition config, vocabulary, and HTTP endpoints while
// keeping older lib import paths available during the refactor.

export { default as workflowDefinitionsRouter } from './router';
export {
  resolveWorkflowTypeForWorkflowId,
  getAllowedTaskTypesForWorkflowType,
  isTaskTypeAllowedForWorkflowType,
  resolveTaskFieldSchemaForWorkflow,
  getCustomFieldDefinitions,
  getGateRequirementFieldDefinitions,
  parseRequirementFieldExpression,
  validateRequirementFieldExpression,
  resolveTaskWorkflowContext,
  normalizeBooleanInt,
  normalizeConfigKey,
  normalizeOptionalText,
  parseFieldSchema,
  parseMetadataObject,
  parseStringArray,
} from './config';
export type {
  TaskFieldDefinition,
  ResolvedTaskFieldSchema,
} from './config';
export {
  getLegacyOutcomeMeta,
  listConfiguredWorkflowOutcomes,
  resolveWorkflowOutcomeMap,
  resolveWorkflowOutcomeVocabulary,
} from './outcomes';
export type {
  WorkflowOutcomeBehavior,
  WorkflowOutcomeDefinition,
} from './outcomes';
export { resolveWorkflowMetadata } from './workflowMetadata';
export type {
  ResolvedWorkflowMetadata,
  WorkflowStatusMeta,
  WorkflowTaskTypeMeta,
  WorkflowTransitionMeta,
} from './workflowMetadata';
export { listRelationshipTypesForWorkflowType } from '../tasks/relationships';
export type { TaskRelationshipTypeConfig } from '../tasks/relationships';
