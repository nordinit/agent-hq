/**
 * teamContext, when present, leads the message: who the agent is and who it works with frames
 * how it should read its own instructions and the task, so it has to arrive before both.
 * Resolving it is a database question — see domains/teams/context.ts.
 */
export function buildTaskMessage(
  job: { job_instructions: string; title: string },
  task: {
    id: number;
    title: string;
    description: string;
    priority: string;
    status: string;
    sprint_name: string | null;
  },
  teamContext?: string | null,
): string {
  const taskBlock = [
    `## Assigned Task`,
    `Task #${task.id}: ${task.title}`,
    `Priority: ${task.priority} | Workflow: ${task.sprint_name ?? 'none'}`,
    ``,
    task.description,
  ].join('\n');

  return [teamContext?.trim() || null, job.job_instructions, taskBlock]
    .filter((section): section is string => Boolean(section))
    .join('\n\n');
}
