// Compatibility export. New imports should prefer ../domains/workflow-definitions/outcomes.

export {
  getLegacyOutcomeMeta,
  listConfiguredWorkflowOutcomes,
  resolveWorkflowOutcomeMap,
  resolveWorkflowOutcomeVocabulary,
} from '../domains/workflow-definitions/outcomes';
export type {
  WorkflowOutcomeBehavior,
  WorkflowOutcomeDefinition,
} from '../domains/workflow-definitions/outcomes';
