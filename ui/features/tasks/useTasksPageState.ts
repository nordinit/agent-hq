'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getApiBase, api, type Task as ApiTask, type TaskBoardBucket } from '@/lib/api';
import type { BoardTask } from '@/features/tasks/TaskBoardComponents';
import { useLiveRefresh } from '@/lib/useLiveRefresh';
import { useTaskStatuses } from '@/lib/useTaskStatuses';
import { useTaskTypes } from '@/lib/taskTypes';
import { hasLiveTaskInstance } from '@/lib/liveTaskInstances';
import { useProjectFilterPreference } from '@/lib/projectFilterPreference';
import {
  BOARD_PER_STATUS_LIMIT,
  expandBoardColumn,
  reuseUnchangedTasks,
} from '@/lib/boardTasks';

/** Board refresh cadence. Each refresh is one bounded request, so this is cheap. */
const BOARD_REFRESH_MS = 30_000;
const BOARD_HIDDEN_REFRESH_MS = 300_000;
const BOARD_SEARCH_DEBOUNCE_MS = 300;

export interface Project {
  id: number;
  name: string;
  is_default?: number | boolean;
}

export type Task = BoardTask & ApiTask & {
  routing_reason?: string | null;
};

export type Status = string;

export interface ModalForm extends Partial<Task> {
  recurring: boolean;
  story_points?: number | null;
}

export interface Workflow {
  id: number;
  project_id: number;
  name: string;
  workflow_type: string;
  status: string;
}

export interface StatusOption {
  key: string;
  label: string;
}

export interface TaskTypeOption {
  value: string;
  label: string;
}

export interface TasksPageModalState {
  task: Partial<Task>;
}

export function useTasksPageState() {
  const searchParams = useSearchParams();
  const deepLinkTaskId = searchParams.get('id') ? Number(searchParams.get('id')) : null;
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const defaultProjectId = useMemo(() => projects.find(project => Boolean(project.is_default))?.id ?? projects[0]?.id ?? null, [projects]);
  const validProjectIds = useMemo(() => projects.map(project => project.id), [projects]);
  const [selectedProject, setSelectedProject] = useProjectFilterPreference({
    fallbackProjectId: defaultProjectId,
    validProjectIds,
  });
  const [loading, setLoading] = useState(true);
  const [isBackgroundLoading, setIsBackgroundLoading] = useState(false);
  const [totalTasks, setTotalTasks] = useState(0);
  // Every (workflow, status) column's total and how many of its tasks are loaded.
  const [buckets, setBuckets] = useState<TaskBoardBucket[]>([]);
  // Columns the operator expanded with "Show more": column key → rows to load.
  const [expandedBuckets, setExpandedBuckets] = useState<Record<string, number>>({});
  const [modal, setModal] = useState<TasksPageModalState | null>(null);
  const [viewTask, setViewTask] = useState<Task | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeInstanceOnly, setActiveInstanceOnly] = useState(false);
  const [selectedTaskType, setSelectedTaskType] = useState('');
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<number[]>([]);
  // Search runs on the server across every task, not only the loaded columns, once typing pauses.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const selectedSingleWorkflowId = selectedWorkflowIds.length === 1 ? selectedWorkflowIds[0] : null;
  const loadRunIdRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    loadControllerRef.current?.abort();
  }, []);

  const selectedWorkflowType = useMemo(() => {
    const visibleWorkflows = selectedWorkflowIds.length > 0
      ? workflows.filter(workflow => selectedWorkflowIds.includes(workflow.id))
      : workflows;
    const types = [...new Set(visibleWorkflows.map(workflow => workflow.workflow_type).filter(Boolean))];
    return types.length === 1 ? types[0] : null;
  }, [selectedWorkflowIds, workflows]);
  const { statuses: taskStatusCatalog, definitions: taskStatusDefs } = useTaskStatuses(selectedSingleWorkflowId);
  const { options: workflowTaskTypeOptions, loading: taskTypesLoading } = useTaskTypes(
    selectedSingleWorkflowId,
    { workflowType: selectedSingleWorkflowId ? null : selectedWorkflowType },
  );
  const taskTypeOptions = useMemo<TaskTypeOption[]>(() => {
    if ((selectedSingleWorkflowId || selectedWorkflowType) && workflowTaskTypeOptions.length > 0) {
      return workflowTaskTypeOptions;
    }

    const seen = new Set<string>();
    return tasks
      .map(task => task.task_type)
      .filter((taskType): taskType is string => Boolean(taskType))
      .filter(taskType => {
        if (seen.has(taskType)) return false;
        seen.add(taskType);
        return true;
      })
      .sort((a, b) => a.localeCompare(b))
      .map(taskType => ({ value: taskType, label: taskType }));
  }, [selectedSingleWorkflowId, selectedWorkflowType, tasks, workflowTaskTypeOptions]);
  const statusOptions = useMemo<StatusOption[]>(
    () => taskStatusDefs.map(d => ({ key: d.key, label: d.label })),
    [taskStatusDefs],
  );
  const defaultNewTaskStatus = statusOptions[0]?.key ?? '';

  useEffect(() => {
    if (!selectedTaskType || taskTypesLoading) return;
    if (!taskTypeOptions.some(option => option.value === selectedTaskType)) {
      setSelectedTaskType('');
    }
  }, [selectedTaskType, taskTypeOptions, taskTypesLoading]);

  const base = getApiBase();

  useEffect(() => {
    if (!deepLinkTaskId) return;
    fetch(`${base}/api/v1/tasks/${deepLinkTaskId}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then((t: Task) => setViewTask(t))
      .catch(err => console.warn('[tasks] Deep-link task fetch failed:', err));
  }, [base, deepLinkTaskId]);

  useEffect(() => {
    fetch(`${base}/api/v1/projects`)
      .then(r => r.json())
      .then((p: Project[]) => {
        setProjects(p);
      })
      .catch(console.error);
  }, [base]);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedSearch(searchQuery.trim()), BOARD_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchQuery]);

  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;

  /**
   * One bounded request: the newest tasks of every (workflow, status) column, each column's total,
   * and the columns the operator expanded. Search, task type and live-run filters apply on the
   * server so they reach every task, not only the loaded ones.
   */
  const loadTasks = useCallback(async (opts: { silent?: boolean } = {}) => {
    const { silent = false } = opts;
    const runId = ++loadRunIdRef.current;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const isCurrent = () => loadRunIdRef.current === runId && !controller.signal.aborted;

    if (!silent) setLoading(true);

    const workflowsFetch: Promise<Workflow[] | null> = selectedProject
      ? fetch(`${base}/api/v1/workflows?project_id=${selectedProject}`, { signal: controller.signal })
        .then(r => { if (!r.ok) throw new Error('Workflow refresh failed'); return r.json(); })
        .catch(() => null)
      : Promise.resolve([]);

    try {
      const board = await api.getTaskBoard({
        projectId: selectedProject,
        q: debouncedSearch,
        taskType: selectedTaskType || undefined,
        liveInstancesOnly: activeInstanceOnly,
        perStatusLimit: BOARD_PER_STATUS_LIMIT,
        expanded: expandedBuckets,
      }, { signal: controller.signal });
      const workflowData = await workflowsFetch;
      if (!isCurrent()) return;
      setTasks(reuseUnchangedTasks(tasksRef.current, board.tasks as Task[]));
      setBuckets(board.buckets);
      setTotalTasks(board.total);
      if (workflowData) setWorkflows(workflowData.filter(s => s.status === 'active' || s.status === 'planning'));
    } catch (error) {
      if (isCurrent()) console.error(error);
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setIsBackgroundLoading(false);
      }
    }
  }, [activeInstanceOnly, base, debouncedSearch, expandedBuckets, selectedProject, selectedTaskType]);

  // A project switch starts over: a fresh board, no expanded columns, no workflow filter.
  useEffect(() => {
    // Keep the same object when nothing was expanded, so the switch does not reload twice.
    setExpandedBuckets(current => (Object.keys(current).length > 0 ? {} : current));
    setSelectedWorkflowIds([]);
    if (selectedProject === null) {
      setWorkflows([]);
    }
  }, [selectedProject]);

  // Initial load, and a reload whenever a server-side filter or an expanded column changes.
  const firstLoadForProject = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const projectChanged = firstLoadForProject.current !== selectedProject;
    firstLoadForProject.current = selectedProject;
    if (!projectChanged) setIsBackgroundLoading(true);
    void loadTasks({ silent: !projectChanged });
  }, [loadTasks, selectedProject]);

  useLiveRefresh(() => loadTasks({ silent: true }), {
    enabled: !loading,
    intervalMs: BOARD_REFRESH_MS,
    hiddenIntervalMs: BOARD_HIDDEN_REFRESH_MS,
  });

  /** "Show more" on a status column: load one more page of it for the given workflows. */
  const loadMoreInColumn = useCallback((status: string, workflowIds: Array<number | null> | null) => {
    setExpandedBuckets(current => expandBoardColumn(current, buckets, status, workflowIds));
  }, [buckets]);

  /** Opens the slide-over at once with the card, then swaps in the full task the card lacks. */
  const openTask = useCallback((task: BoardTask) => {
    setViewTask(task as Task);
    api.getTask(task.id)
      .then(full => setViewTask(current => (current?.id === full.id ? full as Task : current)))
      .catch(err => console.warn('[tasks] Task fetch failed:', err));
  }, []);

  const openNew = useCallback((status: Status) => {
    setModal({ task: { status, priority: 'medium', project_id: selectedProject } });
  }, [selectedProject]);

  const shouldShowTask = useCallback((task: Task) => {
    if (selectedProject && task.project_id !== selectedProject) return false;
    return true;
  }, [selectedProject]);

  const upsertTask = useCallback((task: Task) => {
    setTasks(prev => {
      const visible = shouldShowTask(task);
      const existingIndex = prev.findIndex(t => t.id === task.id);

      if (!visible) {
        if (existingIndex === -1) return prev;
        return prev.filter(t => t.id !== task.id);
      }

      if (existingIndex === -1) {
        return [task, ...prev];
      }

      return prev.map(t => (t.id === task.id ? task : t));
    });
  }, [shouldShowTask]);

  const removeTaskFromBoard = useCallback((taskId: number) => {
    setTasks(prev => prev.filter(t => t.id !== taskId));
  }, []);

  const handleSave = useCallback(async (data: Partial<Task> & { recurring: number }) => {
    if (data.id) {
      const res = await fetch(`${base}/api/v1/tasks/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, changed_by: 'User' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      const updated = await res.json() as Task;
      upsertTask(updated);
      void loadTasks({ silent: true });
    } else {
      const res = await fetch(`${base}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Create failed (${res.status})`);
      }
      const created = await res.json() as Task;
      upsertTask(created);
      void loadTasks({ silent: true });
    }
    setModal(null);
  }, [base, loadTasks, upsertTask]);

  const handleDelete = useCallback(async (id: number) => {
    const res = await fetch(`${base}/api/v1/tasks/${id}?deleted_by=User`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Delete failed (${res.status})`);
    }
    removeTaskFromBoard(id);
    setModal(null);
    void loadTasks({ silent: true });
  }, [base, loadTasks, removeTaskFromBoard]);

  const handlePanelSave = useCallback(async (data: Partial<Task> & { recurring: number }) => {
    if (!viewTask) return;
    const res = await fetch(`${base}/api/v1/tasks/${viewTask.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, changed_by: 'User' }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Save failed (${res.status})`);
    }
    const updated = await res.json() as Task;
    setViewTask(updated);
    upsertTask(updated);
  }, [base, upsertTask, viewTask]);

  const handlePanelDelete = useCallback(async () => {
    if (!viewTask) return;
    const res = await fetch(`${base}/api/v1/tasks/${viewTask.id}?deleted_by=User`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Delete failed (${res.status})`);
    }
    removeTaskFromBoard(viewTask.id);
    setViewTask(null);
  }, [base, removeTaskFromBoard, viewTask]);

  const handleLinkTask = useCallback(async (taskId: number, targetTaskId: number, relationshipTypeKey: string) => {
    await api.createTaskRelationship(taskId, {
      target_task_id: targetTaskId,
      relationship_type_key: relationshipTypeKey,
      created_by: 'prism-frontend',
    });
    void loadTasks({ silent: true });
  }, [loadTasks]);

  const handleRemoveBlocker = useCallback(async (taskId: number, blockerId: number) => {
    await fetch(`${base}/api/v1/tasks/${taskId}/blockers/${blockerId}`, { method: 'DELETE' });
    void loadTasks({ silent: true });
  }, [base, loadTasks]);

  const handleCancel = useCallback(async (taskId: number) => {
    const reason = window.prompt('Stop reason (optional):') ?? undefined;
    if (reason === null) return;
    const result = await api.stopTask(taskId, reason || undefined);
    if (viewTask?.id === taskId) setViewTask(result.task as Task);
    void loadTasks({ silent: true });
  }, [loadTasks, viewTask]);

  const handlePause = useCallback(async (taskId: number, reason?: string) => {
    const result = await api.pauseTask(taskId, reason);
    if (viewTask?.id === taskId) setViewTask(result.task as Task);
    void loadTasks({ silent: true });
  }, [loadTasks, viewTask]);

  const handleUnpause = useCallback(async (taskId: number) => {
    const result = await api.unpauseTask(taskId);
    if (viewTask?.id === taskId) setViewTask(result.task as Task);
    void loadTasks({ silent: true });
  }, [loadTasks, viewTask]);

  const handleStatusChange = useCallback(async (taskId: number, newStatus: string) => {
    const res = await fetch(`${base}/api/v1/tasks/${taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus, changed_by: 'User' }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Status update failed (${res.status})`);
    }
    const updated = await res.json() as Task;
    upsertTask(updated);
    setViewTask(prev => (prev?.id === updated.id ? updated : prev));
    // The task moved columns, so column totals changed.
    void loadTasks({ silent: true });
  }, [base, loadTasks, upsertTask]);

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim();
    let result = tasks;
    if (q) {
      const lower = q.toLowerCase();
      const asNum = Number(q);
      const isExactId = Number.isInteger(asNum) && asNum > 0 && String(asNum) === q;
      result = result.filter(t =>
        (isExactId && t.id === asNum) || t.title.toLowerCase().includes(lower)
      );
    }
    if (activeInstanceOnly) {
      result = result.filter(hasLiveTaskInstance);
    }
    if (selectedWorkflowIds.length > 0) {
      const idSet = new Set(selectedWorkflowIds);
      result = result.filter(t => t.workflow_id != null && idSet.has(t.workflow_id as number));
    }
    if (selectedTaskType) {
      result = result.filter(t => t.task_type === selectedTaskType);
    }
    return result;
  }, [tasks, searchQuery, activeInstanceOnly, selectedWorkflowIds, selectedTaskType]);

  const visibleTaskCount = filteredTasks.length;
  const isFiltered = searchQuery.trim().length > 0 || activeInstanceOnly || selectedWorkflowIds.length > 0 || Boolean(selectedTaskType);

  return {
    projects,
    tasks,
    workflows,
    selectedProject,
    setSelectedProject,
    loading,
    isBackgroundLoading,
    totalTasks,
    buckets,
    loadMoreInColumn,
    openTask,
    modal,
    setModal,
    viewTask,
    setViewTask,
    searchQuery,
    setSearchQuery,
    activeInstanceOnly,
    setActiveInstanceOnly,
    selectedTaskType,
    setSelectedTaskType,
    selectedWorkflowIds,
    setSelectedWorkflowIds,
    selectedSingleWorkflowId,
    taskStatusCatalog,
    taskTypeOptions,
    statusOptions,
    defaultNewTaskStatus,
    openNew,
    handleSave,
    handleDelete,
    handlePanelSave,
    handlePanelDelete,
    handleLinkTask,
    handleRemoveBlocker,
    handleCancel,
    handlePause,
    handleUnpause,
    handleStatusChange,
    filteredTasks,
    visibleTaskCount,
    isFiltered,
    loadTasks,
  };
}
