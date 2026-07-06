export interface TaskTypeOption {
  value: string;
  label: string;
}

export function shouldClearInvalidTaskType(
  taskType: string | null | undefined,
  options: TaskTypeOption[],
  loading: boolean,
) {
  if (!taskType || loading) return false;
  return !options.some(option => option.value === taskType);
}
