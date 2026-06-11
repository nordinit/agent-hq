type WorkflowAliasable = {
  sprint_id?: number | null;
  sprint_type?: string | null;
  workflow_id?: number | null;
  workflow_type?: string | null;
};

/**
 * Compatibility shim for the sprint -> workflow migration.
 * Keep all alias expansion here so it can be removed cleanly when legacy
 * sprint_id/sprint_type callers are retired.
 */
export function withWorkflowAliases<T extends WorkflowAliasable>(data: T): T {
  return {
    ...data,
    ...(data.sprint_id !== undefined && data.workflow_id === undefined ? { workflow_id: data.sprint_id } : {}),
    ...(data.sprint_type !== undefined && data.workflow_type === undefined ? { workflow_type: data.sprint_type } : {}),
  };
}
