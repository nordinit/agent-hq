/**
 * dispatchTrigger.ts — Fire-and-forget dispatch trigger
 *
 * Call triggerDispatch(projectId) from any mutation route after a DB write
 * to immediately run a dispatch pass for the affected project.
 *
 * This is intentionally async and never throws — it must not delay API responses.
 */

import { getDb } from '../db/client';
import { runDispatcher } from './dispatcher';
import { reconcileAssignedAgents } from '../scheduler/reconciler';

/**
 * Trigger a dispatch pass for the given project, then bring assigned agents up to date.
 * Fire-and-forget — safe to call without awaiting.
 */
export function triggerDispatch(projectId: number | null | undefined): void {
  if (projectId == null) return;

  // Defer to next tick so the calling request path completes first
  setImmediate(async () => {
    const start = Date.now();
    try {
      const db = getDb();
      const dispResult = await runDispatcher(db, projectId);

      reconcileAssignedAgents(db).catch((err: unknown) => {
        console.error('[dispatchTrigger] reconcileAssignedAgents error:', err);
      });

      const elapsed = Date.now() - start;

      console.log(
        `[dispatchTrigger] project=${projectId} ` +
        `dispatched=${dispResult.dispatched} skipped=${dispResult.skipped} ` +
        `errors=${dispResult.errors.length} elapsed=${elapsed}ms`
      );

      if (dispResult.errors.length > 0) {
        console.error('[dispatchTrigger] Errors:', dispResult.errors);
      }
    } catch (err) {
      const elapsed = Date.now() - start;
      console.error(`[dispatchTrigger] project=${projectId} failed after ${elapsed}ms:`, err);
    }
  });
}
