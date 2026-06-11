// Runs domain entrypoint.
// Dispatch, runtime lifecycle, and run-context code can converge here while
// existing modules remain as compatibility surfaces during the migration.

export * from './callbacks';
export * from './instanceClose';
export * from './instanceStop';
export * from './lifecycleHandoff';
export * from './observability';
export * from './runtimeEnd';
export * from './sessionKey';
export * from './stopInstanceExecution';
export * from './tokenBackfill';
export * from './tokenUsage';
export * from './transcriptProvider';

export {
  DISPATCH_FAILURE_BACKOFF_SECONDS,
  DISPATCHABLE_ROUTED_STATUSES,
  getNonDispatchableTaskStatusPredicate,
  buildTaskMessage,
  getDispatchTaskNotesContext,
  buildDispatchTaskNotesSection,
  buildInstanceCallbackContract,
  writeRunContext,
  cleanupRunContext,
  generateClaudeMd,
  OPENCLAW_SKILLS_PATH,
  syncSkillDirs,
  dispatchTaskToJob,
  runDispatcher,
  buildDispatchMessage,
  dispatchInstance,
} from '../../services/dispatcher';
export type {
  DispatchResult,
  DispatchInstanceParams,
} from '../../services/dispatcher';
