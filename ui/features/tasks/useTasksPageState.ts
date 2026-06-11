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

const PAGE_SIZE = 50;
const BACKGROUND_PAGE_SIZE = 200;

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

export interface Sprint {
  id: number;
  project_id: number;
  name: string;
  sprint_type: string;
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
  const [sprints, setSprints] = useState<Sprint[]>([]);
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
  const [selectedSprintIds, setSelectedSprintIds] = useState<number[]>([]);
  const loadedSprintIds = useRef<Set<number>>(new Set());
  const [loadingSprintIds, setLoadingSprintIds] = useState<Set<number>>(new Set());
  const selectedSingleSprintId = selectedSprintIds.length === 1 ? selectedSprintIds[0] : null;
  const loadedCountRef = useRef(PAGE_SIZE);
  const loadRunIdRef = useRef(0);
  const backgroundLoadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadedCountRef.current = Math.max(tasks.length, PAGE_SIZE);
  }, [tasks.length]);

  useEffect(() => () => {
    if (backgroundLoadTimeoutRef.current) clearTimeout(backgroundLoadTimeoutRef.current);
  }, []);

  const selectedSprintType = useMemo(() => {
    const visibleSprints = selectedSprintIds.length > 0
      ? sprints.filter(sprint => selectedSprintIds.includes(sprint.id))
      : sprints;
    const types = [...new Set(visibleSprints.map(sprint => sprint.sprint_type).filter(Boolean))];
    return types.length === 1 ? types[0] : null;
  }, [selectedSprintIds, sprints]);
  const { statuses: taskStatusCatalog, definitions: taskStatusDefs } = useTaskStatuses(selectedSingleSprintId);
  const { options: workflowTaskTypeOptions, loading: taskTypesLoading } = useTaskTypes(
    selectedSingleSprintId,
    { sprintType: selectedSingleSprintId ? null : selectedSprintType },
  );
  const taskTypeOptions = useMemo<TaskTypeOption[]>(() => {
    if ((selectedSingleSprintId || selectedSprintType) && workflowTaskTypeOptions.length > 0) {
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
  }, [selectedSingleSprintId, selectedSprintType, tasks, workflowTaskTypeOptions]);
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

  const loadTasks = useCallback((opts: { silent?: boolean; refreshCount?: number } = {}) => {
    const { silent = false, refreshCount } = opts;
    const runId = ++loadRunIdRef.current;

    if (backgroundLoadTimeoutRef.current) {
      clearTimeout(backgroundLoadTimeoutRef.current);
      backgroundLoadTimeoutRef.current = null;
    }

    if (!silent) {
      setLoading(true);
      setIsBackgroundLoading(false);
    }

    const params = new URLSearchParams({
      limit: String(refreshCount ?? PAGE_SIZE),
      offset: '0',
    });
    if (selectedProject) params.set('project_id', String(selectedProject));

    const tasksFetch = fetch(`${base}/api/v1/tasks?${params.toString()}`).then(r => r.json());
    const sprintsFetch = !selectedProject
      ? Promise.resolve(null)
      : fetch(`${base}/api/v1/sprints?project_id=${selectedProject}`).then(r => r.json()).catch(() => []);

    Promise.all([tasksFetch, sprintsFetch])
      .then(([taskData, sprintData]) => {
        if (loadRunIdRef.current !== runId) return;

        const { tasks: newTasks, hasMore: more, total } = taskData as {
          tasks: Task[];
          hasMore: boolean;
          total: number;
        };
        setTasks(newTasks);
        setHasMore(more);
        setTotalTasks(total);
        if (sprintData !== null) {
          setSprints((sprintData as Sprint[]).filter(s => s.status === 'active' || s.status === 'planning'));
        }
      })
      .catch(console.error)
      .finally(() => {
        if (!silent && loadRunIdRef.current === runId) setLoading(false);
      });
  }, [base, selectedProject]);

  useEffect(() => {
    if (loading || !hasMore || isBackgroundLoading) return;

    const runId = loadRunIdRef.current;
    setIsBackgroundLoading(true);

    const params = new URLSearchParams({
      limit: String(BACKGROUND_PAGE_SIZE),
      offset: String(tasks.length),
    });
    if (selectedProject) params.set('project_id', String(selectedProject));

    backgroundLoadTimeoutRef.current = setTimeout(() => {
      backgroundLoadTimeoutRef.current = null;
      fetch(`${base}/api/v1/tasks?${params.toString()}`)
        .then(r => r.json())
        .then((data: { tasks: Task[]; hasMore: boolean; total: number }) => {
          if (loadRunIdRef.current !== runId) return;

          const incoming = data.tasks ?? [];
          setTasks(prev => {
            if (!incoming.length) return prev;
            const seen = new Set(prev.map(task => task.id));
            const deduped = incoming.filter(task => !seen.has(task.id));
            return deduped.length ? [...prev, ...deduped] : prev;
          });
          setHasMore(data.hasMore);
          setTotalTasks(data.total);
        })
        .catch(console.error)
        .finally(() => {
          if (loadRunIdRef.current === runId) setIsBackgroundLoading(false);
        });
    }, 0);
  }, [base, hasMore, isBackgroundLoading, loading, selectedProject, tasks.length]);

  const handleSectionVisible = useCallback((sectionKey: string) => {
    if (!sectionKey.startsWith('sprint-')) return;
    const sprintId = Number(sectionKey.replace('sprint-', ''));
    if (!sprintId || loadedSprintIds.current.has(sprintId)) return;
    loadedSprintIds.current.add(sprintId);

    setLoadingSprintIds(prev => new Set([...prev, sprintId]));

    const params = new URLSearchParams({ limit: '200', offset: '0', sprint_id: String(sprintId) });
    if (selectedProject) params.set('project_id', String(selectedProject));

    fetch(`${getApiBase()}/api/v1/tasks?${params.toString()}`)
      .then(r => r.json())
      .then((data: { tasks: Task[] }) => {
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
        setLoadingSprintIds(prev => {
          const next = new Set(prev);
          next.delete(sprintId);
          return next;
        });
      });
  }, [selectedProject]);

  useEffect(() => {
    loadedSprintIds.current = new Set();
    setLoadingSprintIds(new Set());
    setSelectedSprintIds([]);

    if (selectedProject === null) {
      setSprints([]);
    }
    loadTasks();
  }, [selectedProject, loadTasks]);

  useLiveRefresh(() => loadTasks({ silent: true, refreshCount: loadedCountRef.current }), {
    enabled: true,
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
    loadTasks();
  }, [loadTasks]);

  const handleRemoveBlocker = useCallback(async (taskId: number, blockerId: number) => {
    await fetch(`${base}/api/v1/tasks/${taskId}/blockers/${blockerId}`, { method: 'DELETE' });
    loadTasks();
  }, [base, loadTasks]);

  const handleCancel = useCallback(async (taskId: number) => {
    const reason = window.prompt('Stop reason (optional):') ?? undefined;
    if (reason === null) return;
    const result = await api.stopTask(taskId, reason || undefined);
    if (viewTask?.id === taskId) setViewTask(result.task as Task);
    loadTasks();
  }, [loadTasks, viewTask]);

  const handlePause = useCallback(async (taskId: number, reason?: string) => {
    const result = await api.pauseTask(taskId, reason);
    if (viewTask?.id === taskId) setViewTask(result.task as Task);
    loadTasks();
  }, [loadTasks, viewTask]);

  const handleUnpause = useCallback(async (taskId: number) => {
    const result = await api.unpauseTask(taskId);
    if (viewTask?.id === taskId) setViewTask(result.task as Task);
    loadTasks();
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
    if (selectedSprintIds.length > 0) {
      const idSet = new Set(selectedSprintIds);
      result = result.filter(t => t.sprint_id != null && idSet.has(t.sprint_id as number));
    }
    if (selectedTaskType) {
      result = result.filter(t => t.task_type === selectedTaskType);
    }
    return result;
  }, [tasks, searchQuery, activeInstanceOnly, selectedSprintIds, selectedTaskType]);

  const visibleTaskCount = filteredTasks.length;
  const isFiltered = searchQuery.trim().length > 0 || activeInstanceOnly || selectedSprintIds.length > 0 || Boolean(selectedTaskType);

  return {
    projects,
    tasks,
    sprints,
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
    selectedSprintIds,
    setSelectedSprintIds,
    loadingSprintIds,
    selectedSingleSprintId,
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
    loadedSprintIds,
    loadTasks,
  };
}
