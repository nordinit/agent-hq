/**
 * The one outcome built into Agent HQ (mirrors api/src/lib/outcomeCatalog.ts). Agent HQ posts it when
 * a run dies before its agent posts an outcome; agents cannot post it. It is always a failure and
 * marks the run failed. Route it with transitions like any outcome; a status with no
 * runtime_failed transition keeps the task and dispatches it again.
 */
export const RUNTIME_FAILED_OUTCOME = 'runtime_failed';
export const RUNTIME_FAILED_LABEL = 'Runtime Failed';
export const RUNTIME_FAILED_DESCRIPTION =
  'Posted by Agent HQ when a run dies before its agent posts an outcome. Always a failure. '
  + 'Route it from any status with a transition; where there is none, the task stays and is dispatched again.';
