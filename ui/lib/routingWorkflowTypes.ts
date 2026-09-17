import type { WorkflowType } from './api';

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
