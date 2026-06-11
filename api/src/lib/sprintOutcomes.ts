// Compatibility export. New imports should prefer ../domains/sprint-definitions/outcomes.

export {
  getLegacyOutcomeMeta,
  listConfiguredSprintOutcomes,
  resolveSprintOutcomeMap,
  resolveSprintOutcomeVocabulary,
} from '../domains/sprint-definitions/outcomes';
export type {
  SprintOutcomeBehavior,
  SprintOutcomeDefinition,
} from '../domains/sprint-definitions/outcomes';
