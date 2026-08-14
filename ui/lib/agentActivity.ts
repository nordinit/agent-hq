import type { RunActivity } from './api';

/**
 * Presentation rules for the chat typing indicator.
 *
 * Kept out of the component so the visibility decision is testable on its own:
 * getting it wrong either strands a "Thinking…" on a finished run or hides the
 * indicator during the gap it exists to cover.
 */

/** States during which a turn is genuinely open and the indicator should show. */
export function isActivityVisible(activity: RunActivity | null | undefined): boolean {
  const state = activity?.state;
  return state === 'starting' || state === 'working' || state === 'stalled';
}

/** A stalled run is still shown, but muted — it is waiting, not working. */
export function isActivityStalled(activity: RunActivity | null | undefined): boolean {
  return activity?.state === 'stalled';
}

/**
 * The status line. The ellipsis marks ongoing work, so a stalled run — which is
 * conspicuously not progressing — does not get one.
 */
export function activityLabel(activity: RunActivity | null | undefined): string {
  if (!activity) return '';
  return isActivityStalled(activity) ? activity.label : `${activity.label}…`;
}
