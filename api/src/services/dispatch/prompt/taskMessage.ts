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
): string {
  const taskBlock = [
    `## Assigned Task`,
    `Task #${task.id}: ${task.title}`,
    `Priority: ${task.priority} | Workflow: ${task.sprint_name ?? 'none'}`,
    ``,
    task.description,
  ].join('\n');

  return `${job.job_instructions}\n\n${taskBlock}`;
}
