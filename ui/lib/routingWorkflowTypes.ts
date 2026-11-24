import type { Workflow, WorkflowType } from './api';

export type RoutingWorkflowTypeOption = {
  key: string;
  name: string;
};

export function getRoutingWorkflowTypeOptions(workflowTypes: WorkflowType[]): RoutingWorkflowTypeOption[] {
  const seen = new Set<string>();
  return workflowTypes.reduce<RoutingWorkflowTypeOption[]>((options, workflowType) => {
    const key = workflowType.key?.trim();
    if (!key || seen.has(key)) return options;

    seen.add(key);
    options.push({
      key,
      name: workflowType.name?.trim() || key,
    });
    return options;
  }, []);
}

export function getRoutingWorkflowScope(
  workflowTypes: WorkflowType[],
  workflows: Pick<Workflow, 'id' | 'project_id' | 'workflow_type' | 'name'>[],
  projectId: number | null,
  selectedType: string | null,
) {
  const projectWorkflows = workflows.filter(workflow => workflow.project_id === projectId);
  const projectTypeKeys = new Set(projectWorkflows.map(workflow => workflow.workflow_type));
  const availableTypes = getRoutingWorkflowTypeOptions(workflowTypes)
    .filter(type => projectId === null || projectTypeKeys.has(type.key));
  const workflowType = selectedType === '' ? null : (
    availableTypes.find(type => type.key === selectedType) ?? availableTypes[0]
  )?.key ?? null;

  return {
    availableTypes,
    workflowType,
    workflows: projectWorkflows.filter(workflow => workflow.workflow_type === workflowType),
  };
}
