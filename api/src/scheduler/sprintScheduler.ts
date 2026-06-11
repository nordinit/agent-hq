/**
 * sprintScheduler.ts — Sprint-level job scheduling (DEPRECATED)
 *
 * Task #596: The sprint_job_schedules and sprint_schedule_fires tables have been
 * removed as part of the legacy jobs infrastructure cleanup. This scheduler is now
 * a no-op. Scheduling is handled by recurring task series.
 *
 * The startSprintScheduler export is preserved to avoid breaking index.ts imports.
 */

export function startSprintScheduler(): void {
  console.log('[sprintScheduler] Disabled — sprint_job_schedules table removed (task #596)');
}
