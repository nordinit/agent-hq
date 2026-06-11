/**
 * dispatchTrigger.ts — Fire-and-forget dispatch trigger
 *
 * Call triggerDispatch(projectId) from any mutation route after a DB write
 * to immediately run an eligibility + dispatch pass for the affected project.
 *
 * This is intentionally async and never throws — it must not delay API responses.
 */

import { getDb } from '../db/client';
import { runEligibilityPass } from './eligibility';
import { runDispatcher } from './dispatcher';
import { reconcileReviewQaRouting } from '../scheduler/reconciler';

/**
 * Trigger an eligibility + dispatch pass for the given project.
 * Fire-and-forget — safe to call without awaiting.
 */
export function triggerDispatch(projectId: number | null | undefined): void {
  if (projectId == null) return;

  // Defer to next tick so the calling request path completes first
  setImmediate(() => {
    const start = Date.now();
    try {
      const db = getDb();
      const eligResult = runEligibilityPass(db, projectId);
      const dispResult = runDispatcher(db, projectId);

      // Also trigger QA/review dispatch so tasks entering 'review' get a QA
      // instance immediately rather than waiting for the next reconciler tick.
      reconcileReviewQaRouting(undefined, db).catch((err) => {
        console.error('[dispatchTrigger] reconcileReviewQaRouting error:', err);
      });

      const elapsed = Date.now() - start;

      console.log(
        `[dispatchTrigger] project=${projectId} ` +
        `promoted=${eligResult.promoted} stalled=${eligResult.stalled} ` +
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
