/**
 * Legacy per-agent cron scheduling is deprecated.
 *
 * Recurring task series are the supported scheduling mechanism. Keep this
 * module as a no-op because the API process still imports startScheduler(),
 * but do not dispatch generic scheduled agent runs from agents.schedule.
 */
export function startScheduler(): void {
  console.log('[scheduler] Legacy per-agent schedules disabled; recurring task series scheduler is authoritative.');
}
