'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getApiBase, api, type Task as ApiTask } from '@/lib/api';
import type { BoardTask } from '@/features/tasks/TaskBoardComponents';
import { useLiveRefresh } from '@/lib/useLiveRefresh';
import { useTaskStatuses } from '@/lib/useTaskStatuses';
import { useTaskTypes } from '@/lib/taskTypes';
import { hasLiveTaskInstance } from '@/lib/liveTaskInstances';
import { useProjectFilterPreference } from '@/lib/projectFilterPreference';
import { fetchTaskPages, type TaskPage } from '@/lib/taskPages';

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
  const [hasMore, setHasMore] = useState(false);
  const [totalTasks, setTotalTasks] = useState(0);
  const [modal, setModal] = useState<TasksPageModalState | null>(null);
  const [viewTask, setViewTask] = useState<Task | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeInstanceOnly, setActiveInstanceOnly] = useState(false);
  const [selectedTaskType, setSelectedTaskType] = useState('');
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<number[]>([]);
  const loadedWorkflowIds = useRef<Set<number>>(new Set());
  const [loadingWorkflowIds, setLoadingWorkflowIds] = useState<Set<number>>(new Set());
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

  const loadTasks = useCallback(async (opts: { silent?: boolean } = {}) => {
    const { silent = false } = opts;
    const runId = ++loadRunIdRef.current;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const isCurrent = () => loadRunIdRef.current === runId && !controller.signal.aborted;

    if (!silent) {
      setLoading(true);
      setIsBackgroundLoading(false);
    }

    const workflowsFetch: Promise<Workflow[] | null> = selectedProject
      ? fetch(`${base}/api/v1/workflows?project_id=${selectedProject}`, { signal: controller.signal })
        .then(r => { if (!r.ok) throw new Error('Workflow refresh failed'); return r.json(); })
        .catch(() => null)
      : Promise.resolve([]);

    try {
      let firstPage = true;
      const snapshot = await fetchTaskPages<Task>(async (offset, limit) => {
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        if (selectedProject) params.set('project_id', String(selectedProject));
        const response = await fetch(`${base}/api/v1/tasks?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Task refresh failed (${response.status})`);
        return response.json() as Promise<TaskPage<Task>>;
      }, silent ? undefined : async page => {
        const workflowData = await workflowsFetch;
        if (!isCurrent()) return;
        if (firstPage) {
          setTasks(page.tasks);
          if (workflowData) setWorkflows(workflowData.filter(s => s.status === 'active' || s.status === 'planning'));
          firstPage = false;
        } else {
          // Preserve tasks already fetched by a visible workflow section during initial loading.
          setTasks(prev => [...new Map([...prev, ...page.tasks].map(task => [task.id, task])).values()]);
        }
        setTotalTasks(page.total);
        setHasMore(page.hasMore);
        setIsBackgroundLoading(page.hasMore);
        setLoading(false);
      });
      const workflowData = await workflowsFetch;
      if (!isCurrent()) return;
      // A refresh publishes only a complete snapshot, never a temporary first page.
      setTasks(snapshot.tasks);
      setTotalTasks(snapshot.total);
      setHasMore(false);
      setLoadingWorkflowIds(new Set());
      if (workflowData) {
        setWorkflows(workflowData.filter(s => s.status === 'active' || s.status === 'planning'));
        loadedWorkflowIds.current = new Set(workflowData.map(workflow => workflow.id));
      }
    } catch (error) {
      if (isCurrent()) console.error(error);
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setIsBackgroundLoading(false);
      }
    }
  }, [base, selectedProject]);

  const handleSectionVisible = useCallback((sectionKey: string) => {
    if (!sectionKey.startsWith('workflow-')) return;
    const workflowId = Number(sectionKey.replace('workflow-', ''));
    if (!workflowId || loadedWorkflowIds.current.has(workflowId)) return;
    loadedWorkflowIds.current.add(workflowId);
    const runId = loadRunIdRef.current;

    setLoadingWorkflowIds(prev => new Set([...prev, workflowId]));

    const params = new URLSearchParams({ limit: '200', offset: '0', workflow_id: String(workflowId) });
    if (selectedProject) params.set('project_id', String(selectedProject));

    fetch(`${getApiBase()}/api/v1/tasks?${params.toString()}`)
      .then(r => r.json())
      .then((data: { tasks: Task[] }) => {
        if (loadRunIdRef.current !== runId) return;
        if (data.tasks?.length) {
          setTasks(prev => {
            const existingIds = new Set(prev.map(t => t.id));
            const newTasks = data.tasks.filter(t => !existingIds.has(t.id));
            return newTasks.length > 0 ? [...prev, ...newTasks] : prev;
          });
        }
      })
      .catch(console.error)
      .finally(() => {
        if (loadRunIdRef.current !== runId) return;
        setLoadingWorkflowIds(prev => {
          const next = new Set(prev);
          next.delete(workflowId);
          return next;
        });
      });
  }, [selectedProject]);

  useEffect(() => {
    loadedWorkflowIds.current = new Set();
    setLoadingWorkflowIds(new Set());
    setSelectedWorkflowIds([]);

    if (selectedProject === null) {
      setWorkflows([]);
    }
    loadTasks();
  }, [selectedProject, loadTasks]);

  useLiveRefresh(() => loadTasks({ silent: true }), {
    enabled: !loading && !isBackgroundLoading,
    intervalMs: 10000,
    hiddenIntervalMs: 30000,
  });

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
    }
    setModal(null);
  }, [base, upsertTask]);

  const handleDelete = useCallback(async (id: number) => {
    const res = await fetch(`${base}/api/v1/tasks/${id}?deleted_by=User`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Delete failed (${res.status})`);
    }
    removeTaskFromBoard(id);
    setModal(null);
  }, [base, removeTaskFromBoard]);

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
  }, [base, upsertTask]);

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
    hasMore,
    totalTasks,
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
    loadingWorkflowIds,
    selectedSingleWorkflowId,
    taskStatusCatalog,
    taskTypeOptions,
    statusOptions,
    defaultNewTaskStatus,
    openNew,
    handleSectionVisible,
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
    loadedWorkflowIds,
    loadTasks,
  };
}
