export function formatSprintNumber(sprintId: number): string {
  return `#${sprintId}`;
}

export function formatSprintLabel(sprint: { id: number; name?: string | null }): string {
  const number = formatSprintNumber(sprint.id);
  const name = sprint.name?.trim();
  return name ? `${number} · ${name}` : number;
}

export function formatWorkflowTerminology(text: string | null | undefined): string {
  if (!text) return '';

  return text
    .replace(/\bSprints\b/g, 'Workflows')
    .replace(/\bsprints\b/g, 'workflows')
    .replace(/\bSprint\b/g, 'Workflow')
    .replace(/\bsprint\b/g, 'workflow');
}
