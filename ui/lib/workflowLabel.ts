export function formatWorkflowNumber(workflowId: number): string {
  return `#${workflowId}`;
}

export function formatWorkflowLabel(workflow: { id: number; name?: string | null }): string {
  const number = formatWorkflowNumber(workflow.id);
  const name = workflow.name?.trim();
  return name ? `${number} · ${name}` : number;
}
