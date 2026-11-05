/**
 * The one outcome built into Agent HQ. Agent HQ posts it itself when a run dies before its agent
 * posts an outcome; agents cannot post it. It is always a failure and marks the run failed. It
 * routes like any other outcome: a configured runtime_failed transition from the task's status
 * moves the task, and with none the task stays where it is and is dispatched again.
 *
 * Kept free of imports so light modules (the MCP client) can use it.
 */
export const RUNTIME_FAILED_OUTCOME = 'runtime_failed';
export const BACKEND_SYSTEM_OUTCOMES: ReadonlySet<string> = new Set([RUNTIME_FAILED_OUTCOME]);

export function isBackendSystemOutcome(outcomeKey: string): boolean {
  return BACKEND_SYSTEM_OUTCOMES.has(outcomeKey);
}
