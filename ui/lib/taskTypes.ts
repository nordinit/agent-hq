'use client';

import { useMemo } from 'react';
import { useWorkflowMetadata } from '@/lib/useWorkflowMetadata';

export interface TaskTypeOption {
  value: string;
  label: string;
}

export function useTaskTypes(
  sprintId?: number | null,
  metadataOptions?: { sprintType?: string | null; taskType?: string | null },
) {
  const { metadata, loading, error } = useWorkflowMetadata(sprintId, metadataOptions);
  const options = useMemo<TaskTypeOption[]>(() => metadata.task_types, [metadata.task_types]);
  const taskTypes = useMemo(() => options.map(option => option.value), [options]);

  return { taskTypes, options, loading, error };
}

export function getTaskTypeLabel(taskType: string): string {
  return taskType;
}
