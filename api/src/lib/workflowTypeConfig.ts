// Compatibility export. New imports should prefer ../domains/workflow-definitions/config.

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
} from '../domains/workflow-definitions/config';
export type {
  TaskFieldDefinition,
  ResolvedTaskFieldSchema,
} from '../domains/workflow-definitions/config';
