/**
 * workflowScheduler.ts — Workflow-level job scheduling (DEPRECATED)
 *
 * Task #596: The workflow_job_schedules and workflow_schedule_fires tables have been
 * removed as part of the legacy jobs infrastructure cleanup. This scheduler is now
 * a no-op. Scheduling is handled by recurring task series.
 *
 * The startWorkflowScheduler export is preserved to avoid breaking index.ts imports.
 */

export function startWorkflowScheduler(): void {
  console.log('[workflowScheduler] Disabled — workflow_job_schedules table removed (task #596)');
}
