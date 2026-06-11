// Sprint definitions domain entrypoint.
// This owns sprint-definition config, vocabulary, and HTTP endpoints while
// keeping older lib import paths available during the refactor.

export { default as sprintDefinitionsRouter } from './router';
export {
  resolveSprintTypeForSprintId,
  getAllowedTaskTypesForSprintType,
  isTaskTypeAllowedForSprintType,
  resolveTaskFieldSchemaForSprint,
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
  listConfiguredSprintOutcomes,
  resolveSprintOutcomeMap,
  resolveSprintOutcomeVocabulary,
} from './outcomes';
export type {
  SprintOutcomeBehavior,
  SprintOutcomeDefinition,
} from './outcomes';
export { resolveWorkflowMetadata } from './workflowMetadata';
export type {
  ResolvedWorkflowMetadata,
  WorkflowStatusMeta,
  WorkflowTaskTypeMeta,
  WorkflowTransitionMeta,
} from './workflowMetadata';
export { listRelationshipTypesForSprintType } from '../tasks/relationships';
export type { TaskRelationshipTypeConfig } from '../tasks/relationships';
