'use client';

import { useMemo } from 'react';
import { TaskStatusMeta } from '@/lib/api';
import { normalizeTaskStatuses, TaskStatusDefinition, getTaskBoardColumns, getDefaultVisibleTaskColumns } from '@/lib/taskStatuses';
import { useWorkflowMetadata } from '@/lib/useWorkflowMetadata';

export interface TaskStatusesState {
  statuses: TaskStatusMeta[];
  definitions: TaskStatusDefinition[];
  allColumns: { key: string; label: string; color: string }[];
  defaultVisible: string[];
  loading: boolean;
}

export function useTaskStatuses(
  sprintId?: number | null,
  options?: { sprintType?: string | null; taskType?: string | null },
): TaskStatusesState {
  const { metadata, loading } = useWorkflowMetadata(sprintId, options);
  const statuses = metadata.statuses;
  const definitions = useMemo(() => normalizeTaskStatuses(statuses), [statuses]);
  const allColumns = useMemo(() => getTaskBoardColumns(statuses), [statuses]);
  const defaultVisible = useMemo(() => getDefaultVisibleTaskColumns(statuses), [statuses]);

  return { statuses, definitions, allColumns, defaultVisible, loading };
}
