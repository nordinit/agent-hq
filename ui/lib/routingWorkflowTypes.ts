import type { SprintType } from './api';

export type RoutingWorkflowTypeOption = {
  key: string;
  name: string;
};

export function getRoutingWorkflowTypeOptions(sprintTypes: SprintType[]): RoutingWorkflowTypeOption[] {
  const seen = new Set<string>();
  return sprintTypes.reduce<RoutingWorkflowTypeOption[]>((options, sprintType) => {
    const key = sprintType.key?.trim();
    if (!key || seen.has(key)) return options;

    seen.add(key);
    options.push({
      key,
      name: sprintType.name?.trim() || key,
    });
    return options;
  }, []);
}
