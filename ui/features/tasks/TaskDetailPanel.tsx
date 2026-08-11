'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { api, Task, TaskHistory, TaskStatusMeta, ResolvedTaskFieldSchemaResponse, TaskRelationship, TaskRelationshipTaskRef, TaskRelationshipTypeConfig } from '@/lib/api';
import { timeAgo, formatDateTime } from '@/lib/date';
import { X, Pencil, AlertTriangle, ChevronDown, ExternalLink, StopCircle, Trash2, Activity, Cpu, Layers, PauseCircle, PlayCircle, Plus, Search, GitBranch } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getTaskStatusMaps } from '@/lib/taskStatuses';
import { getRunLifecycle } from '@/lib/runLifecycle';
import { shouldClearInvalidTaskType, useTaskTypes } from '@/lib/taskTypes';
import { formatSprintLabel } from '@/lib/sprintLabel';
import { useWorkflowMetadata } from '@/lib/useWorkflowMetadata';
import { TaskModal } from '@/features/tasks/TaskModal';
import { resolveEffectiveModel, shortModelName, useModelRoutingRules } from './modelRouting';
import {
  AttachmentsSection,
  FailureStateSection,
  formatRuntimeEndSource,
  HistorySection,
  NeedsAttentionSection,
  NotesSection,
  RelatedRunsSection,
  RUN_STATUS_BADGE,
  TaskFieldsSection,
} from './TaskDetailSections';
import { ContextViewer } from './ContextViewer';

const PRIORITY_BADGE: Record<string, string> = {
  low: 'bg-slate-700 text-slate-300',
  medium: 'bg-amber-900/60 text-amber-300',
  high: 'bg-red-900/60 text-red-300',
};

const {
  labels: FALLBACK_STATUS_LABELS,
  badges: FALLBACK_STATUS_BADGE,
} = getTaskStatusMaps();

interface ProjOpt { id: number; name: string; }
interface SprintOpt { id: number; name: string; status?: string; sprint_type?: string; }

interface Props {
  task: Task;
  statuses?: TaskStatusMeta[];
  onClose: () => void;
  onSave?: (data: Partial<Task> & { recurring: number }) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCancel?: () => Promise<void>;
  onPause?: (reason?: string) => Promise<void>;
  onUnpause?: () => Promise<void>;
}

type FormState = Task & { recurring: boolean };

// ── Time helper ──────────────────────────────────────────────────────────────



// ── Related Tasks Section ───────────────────────────────────────────────────

interface RelatedTaskSearchResult {
  id: number;
  title: string;
  status: string;
}

function relationshipLabelForTask(relationship: TaskRelationship, taskId: number): string {
  const type = relationship.type;
  if (!type) return relationship.relationship_type_key.replace(/[_-]+/g, ' ');
  return relationship.source_task_id === taskId
    ? type.label
    : (type.inverse_label || type.label);
}

function relatedTaskFor(relationship: TaskRelationship, taskId: number): TaskRelationshipTaskRef | null {
  return relationship.source_task_id === taskId
    ? relationship.target_task ?? null
    : relationship.source_task ?? null;
}

function dispatchImpactFor(relationship: TaskRelationship, taskId: number): { label: string; className: string } {
  const type = relationship.type;
  const relatedTask = relatedTaskFor(relationship, taskId);
  if (!type || type.affects_dispatch_eligibility !== 1) {
    return { label: 'Informational', className: 'bg-slate-700 text-slate-300' };
  }

  const status = relatedTask?.status;
  if (status && type.resolved_statuses.includes(status)) {
    return { label: 'Resolved', className: 'bg-emerald-900/60 text-emerald-300 border border-emerald-500/20' };
  }
  if (status && type.active_statuses.length > 0 && !type.active_statuses.includes(status)) {
    return { label: 'Informational', className: 'bg-slate-700 text-slate-300' };
  }
  return { label: 'Blocking dispatch', className: 'bg-orange-950/70 text-orange-300 border border-orange-500/30' };
}

function RelatedTasksSection({
  task,
  relationshipTypes,
  onTaskUpdate,
  onClose,
}: {
  task: Task;
  relationshipTypes: TaskRelationshipTypeConfig[];
  onTaskUpdate: (task: Task) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [relationships, setRelationships] = useState<TaskRelationship[]>(task.relationships ?? []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTypeKey, setSelectedTypeKey] = useState(relationshipTypes[0]?.key ?? '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RelatedTaskSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [addingId, setAddingId] = useState<number | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedType = relationshipTypes.find(type => type.key === selectedTypeKey) ?? relationshipTypes[0] ?? null;

  useEffect(() => {
    if (relationshipTypes.length > 0 && !relationshipTypes.some(type => type.key === selectedTypeKey)) {
      setSelectedTypeKey(relationshipTypes[0].key);
    }
  }, [relationshipTypes, selectedTypeKey]);

  const loadRelationships = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getTaskRelationships(task.id);
      setRelationships(response.relationships);
      const refreshedTask = await api.getTask(task.id);
      onTaskUpdate(refreshedTask);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load related tasks');
      setRelationships(task.relationships ?? []);
    } finally {
      setLoading(false);
    }
  }, [onTaskUpdate, task.id]);

  useEffect(() => {
    void loadRelationships();
  }, [loadRelationships]);

  const doSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    setSearching(true);
    setActionError(null);
    try {
      const existingIds = new Set(relationships.map(relationship => relatedTaskFor(relationship, task.id)?.id).filter(Boolean));
      const rows = await api.searchTasks(trimmed, task.id);
      setResults(rows.filter(row => row.id !== task.id && !existingIds.has(row.id)));
    } catch (err) {
      setResults([]);
      setActionError(err instanceof Error ? err.message : 'Failed to search tasks');
    } finally {
      setSearching(false);
    }
  }, [relationships, task.id]);

  const handleQueryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setQuery(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => void doSearch(value), 200);
  };

  const handleAddExisting = async (result: RelatedTaskSearchResult) => {
    if (!selectedType) return;
    setAddingId(result.id);
    setActionError(null);
    try {
      const relationship = await api.createTaskRelationship(task.id, {
        target_task_id: result.id,
        relationship_type_key: selectedType.key,
        created_by: 'prism-frontend',
      });
      setRelationships(prev => [relationship, ...prev.filter(item => item.id !== relationship.id)]);
      setQuery('');
      setResults([]);
      const refreshedTask = await api.getTask(task.id);
      onTaskUpdate(refreshedTask);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add related task');
    } finally {
      setAddingId(null);
    }
  };

  const handleCreateRelated = async (data: Partial<Task> & { recurring: number }) => {
    if (!selectedType) return;
    setActionError(null);
    try {
      const created = await api.createTask(data);
      const relationship = await api.createTaskRelationship(task.id, {
        target_task_id: created.id,
        relationship_type_key: selectedType.key,
        created_by: 'prism-frontend',
      });
      setRelationships(prev => [relationship, ...prev.filter(item => item.id !== relationship.id)]);
      setCreateOpen(false);
      const refreshedTask = await api.getTask(task.id);
      onTaskUpdate(refreshedTask);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create related task';
      setActionError(message);
      throw err;
    }
  };

  const handleRemove = async (relationshipId: number) => {
    setRemovingId(relationshipId);
    setActionError(null);
    try {
      await api.deleteTaskRelationship(task.id, relationshipId);
      setRelationships(prev => prev.filter(item => item.id !== relationshipId));
      const refreshedTask = await api.getTask(task.id);
      onTaskUpdate(refreshedTask);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to remove related task');
    } finally {
      setRemovingId(null);
    }
  };

  const groupedRelationships = relationships.reduce<Record<string, TaskRelationship[]>>((groups, relationship) => {
    const label = relationshipLabelForTask(relationship, task.id);
    groups[label] = groups[label] ?? [];
    groups[label].push(relationship);
    return groups;
  }, {});

  const openRelatedTask = useCallback((relatedTaskId: number) => {
    onClose();
    router.push(`/tasks?id=${relatedTaskId}`);
  }, [onClose, router]);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Related Tasks</p>
          <p className="text-[10px] text-slate-600 mt-0.5">Relationship labels and allowed actions come from this task&apos;s workflow.</p>
        </div>
      </div>

      {relationshipTypes.length > 0 ? (
        <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-3 mb-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-2">
            <div className="relative">
              <select
                value={selectedTypeKey}
                onChange={event => setSelectedTypeKey(event.target.value)}
                className="w-full appearance-none bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-400 pr-7"
                aria-label="Relationship type"
              >
                {relationshipTypes.map(type => (
                  <option key={type.key} value={type.key}>{type.label}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-2.5 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
            </div>
            <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 focus-within:border-amber-400">
              <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <input
                type="text"
                value={query}
                onChange={handleQueryChange}
                placeholder="Search existing task by #id or title…"
                className="flex-1 min-w-0 bg-transparent text-xs text-white placeholder-slate-500 focus:outline-none"
              />
              {searching && <span className="text-[10px] text-slate-500">…</span>}
            </div>
          </div>

          {query.trim() && results.length > 0 && (
            <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 divide-y divide-slate-800">
              {results.map(result => (
                <button
                  key={result.id}
                  type="button"
                  onClick={() => void handleAddExisting(result)}
                  disabled={addingId === result.id}
                  className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 transition-colors disabled:opacity-50"
                >
                  {addingId === result.id ? 'Adding…' : <><span className="text-slate-400 font-mono">#{result.id}</span> <span>{result.title}</span> <span className="text-[10px] text-slate-500">({result.status})</span></>}
                </button>
              ))}
            </div>
          )}

          {query.trim() && results.length === 0 && !searching && (
            <p className="text-xs text-slate-500">No matching tasks.</p>
          )}

          {selectedType?.allow_create_related_task === 1 && (
            <div className="pt-2 border-t border-slate-700/70">
              <button type="button" onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors">
                <Plus className="w-3 h-3" /> Create related task
              </button>
              <p className="mt-1 text-[10px] text-slate-500">Opens the full task form; relationship defaults no longer choose the new task status or type.</p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-600 italic mb-3">No relationship types are configured for this task&apos;s workflow.</p>
      )}

      {createOpen && selectedType && (
        <TaskModal
          task={{ priority: 'medium' }}
          title="Create New Task"
          relatedContext={{
            sourceTaskId: task.id,
            sourceTaskTitle: task.title,
            relationshipTypeLabel: selectedType.label,
          }}
          onClose={() => setCreateOpen(false)}
          onSave={handleCreateRelated}
        />
      )}

      {actionError && <p className="text-xs text-red-300 bg-red-950/30 border border-red-500/30 rounded px-3 py-2 mb-3">{actionError}</p>}

      {loading ? (
        <p className="text-xs text-slate-500">Loading related tasks…</p>
      ) : error ? (
        <div className="text-xs text-red-300 border border-red-500/20 bg-red-950/20 rounded-lg px-3 py-2">
          {error}
          <button onClick={() => void loadRelationships()} className="ml-2 text-red-200 underline">Retry</button>
        </div>
      ) : relationships.length === 0 ? (
        <p className="text-xs text-slate-600 italic">No related tasks.</p>
      ) : (
        <div className="space-y-3">
          {Object.entries(groupedRelationships).map(([label, rows]) => (
            <div key={label}>
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">{label}</p>
              <div className="space-y-1.5">
                {rows.map(relationship => {
                  const relatedTask = relatedTaskFor(relationship, task.id);
                  const impact = dispatchImpactFor(relationship, task.id);
                  if (!relatedTask) return null;
                  return (
                    <div
                      key={relationship.id}
                      role="link"
                      tabIndex={0}
                      onClick={() => openRelatedTask(relatedTask.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          openRelatedTask(relatedTask.id);
                        }
                      }}
                      className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 cursor-pointer transition-colors hover:border-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500/60 focus:ring-offset-2 focus:ring-offset-slate-900"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/tasks?id=${relatedTask.id}`}
                            onClick={(event) => { event.stopPropagation(); onClose(); }}
                            className="text-sm text-amber-300 hover:text-amber-200 transition-colors"
                          >
                            <span className="font-mono text-slate-400">#{relatedTask.id}</span>
                            <span className="ml-2">{relatedTask.title}</span>
                          </Link>
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${FALLBACK_STATUS_BADGE[relatedTask.status] ?? 'bg-slate-700 text-slate-300'}`}>
                              {FALLBACK_STATUS_LABELS[relatedTask.status] ?? relatedTask.status}
                            </span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${impact.className}`}>{impact.label}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); void handleRemove(relationship.id); }}
                          disabled={removingId === relationship.id}
                          className="text-xs text-slate-500 hover:text-red-300 transition-colors disabled:opacity-50 shrink-0"
                          title="Remove relationship"
                        >
                          {removingId === relationship.id ? 'Removing…' : 'Remove'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export function TaskDetailPanel({ task, statuses, onClose, onSave, onDelete, onCancel, onPause, onUnpause }: Props) {
  const [localTask, setLocalTask] = useState<Task>(task);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  // Newest run with a stored context bundle, or null when this task has none captured yet.
  const [latestContextInstanceId, setLatestContextInstanceId] = useState<number | null>(null);
  const [contextInstanceId, setContextInstanceId] = useState<number | null>(null);
  const [projects, setProjects] = useState<ProjOpt[]>([]);
  const [sprints, setSprints] = useState<SprintOpt[]>([]);
  const [loadingSprints, setLoadingSprints] = useState(false);
  const [form, setForm] = useState<FormState>({ ...task, recurring: !!task.recurring });
  const modelRoutingRules = useModelRoutingRules(
    form.project_id ?? localTask.project_id ?? null,
    form.sprint_id ?? localTask.sprint_id ?? null,
  );
  const effectiveModel = resolveEffectiveModel(
    form.story_points ?? localTask.story_points,
    modelRoutingRules,
    form.project_id ?? localTask.project_id ?? null,
    form.sprint_id ?? localTask.sprint_id ?? null,
  );
  const selectedSprint = useMemo(
    () => sprints.find(sprint => sprint.id === (form.sprint_id ?? localTask.sprint_id ?? null)) ?? null,
    [form.sprint_id, localTask.sprint_id, sprints],
  );
  const taskTypeSprintId = form.sprint_id ?? localTask.sprint_id ?? null;
  const taskTypeSprintType = taskTypeSprintId
    ? selectedSprint?.sprint_type ?? localTask.resolved_sprint_type ?? null
    : localTask.resolved_sprint_type ?? null;
  const { options: taskTypeOptions, loading: taskTypesLoading, error: taskTypesError } = useTaskTypes(taskTypeSprintId, {
    sprintType: taskTypeSprintId ? null : taskTypeSprintType,
  });
  const { metadata: taskWorkflowMetadata, outcomeMap, nonFailureOutcomes } = useWorkflowMetadata(form.sprint_id ?? localTask.sprint_id ?? null, {
    sprintType: (form.sprint_id ?? localTask.sprint_id ?? null) ? null : taskTypeSprintType,
    taskType: form.task_type ?? localTask.task_type ?? null,
  });
  const statusDefinitions = statuses && statuses.length > 0 ? statuses : taskWorkflowMetadata.statuses;
  const { definitions: taskStatuses, labels: STATUS_LABELS, badges: STATUS_BADGE, dots: STATUS_DOT } = getTaskStatusMaps(statusDefinitions);

  // Keep form in sync when the parent pushes a fresh task (e.g. after a successful save)
  useEffect(() => {
    setLocalTask(task);
    setForm({ ...task, recurring: !!task.recurring });
  }, [task]);

  useEffect(() => {
    let cancelled = false;
    api.getTaskDispatchContext(task.id)
      .then(index => { if (!cancelled) setLatestContextInstanceId(index.latestInstanceId); })
      .catch(() => { if (!cancelled) setLatestContextInstanceId(null); });
    return () => { cancelled = true; };
  }, [task.id]);

  useEffect(() => {
    let cancelled = false;

    const loadProjectSprints = async () => {
      if (!form.project_id) {
        if (!cancelled) setSprints([]);
        return;
      }

      setLoadingSprints(true);
      try {
        const projectSprints = await api.getSprints(form.project_id, true);
        if (cancelled) return;
        setSprints(projectSprints);
        if (form.sprint_id != null && !projectSprints.some(sprint => sprint.id === form.sprint_id)) {
          setForm(current => current.sprint_id == null ? current : ({ ...current, sprint_id: null, sprint_name: null, task_type: null }));
        }
      } catch {
        if (!cancelled) setSprints([]);
      } finally {
        if (!cancelled) setLoadingSprints(false);
      }
    };

    loadProjectSprints();
    return () => { cancelled = true; };
  }, [form.project_id, form.sprint_id]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<TaskHistory[]>([]);
  const [resolvedFieldSchema, setResolvedFieldSchema] = useState<ResolvedTaskFieldSchemaResponse | null>(task.resolved_custom_field_schema
    ? {
        sprint_type: task.resolved_sprint_type ?? 'generic',
        allowed_task_types: [],
        fields: task.resolved_custom_field_schema.fields ?? [],
      }
    : null);

  const isBlocked = (localTask.blockers ?? []).some(b => b.status !== 'done');

  useEffect(() => {
    api.getTaskHistory(localTask.id).then(setHistoryEntries).catch(() => {});
  }, [localTask.id]);

  useEffect(() => {
    let cancelled = false;

    api.resolveTaskFieldSchema({ sprint_id: form.sprint_id ?? null, task_type: form.task_type ?? null })
      .then(schema => {
        if (!cancelled) setResolvedFieldSchema(schema);
      })
      .catch(() => {
        if (!cancelled) setResolvedFieldSchema(null);
      });

    return () => {
      cancelled = true;
    };
  }, [form.sprint_id, form.task_type]);

  useEffect(() => {
    setForm(current => shouldClearInvalidTaskType(current.task_type ?? null, taskTypeOptions, taskTypesLoading)
      ? { ...current, task_type: null }
      : current);
  }, [taskTypeOptions, taskTypesLoading]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const switchToEdit = async () => {
    setForm({ ...localTask, recurring: !!localTask.recurring });
    setSaveError(null);
    if (projects.length === 0) {
      setLoadingEdit(true);
      try {
        const p = await api.getProjects();
        setProjects(p);
      } catch { /* ignore */ }
      setLoadingEdit(false);
    }
    setMode('edit');
  };

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ ...form, recurring: form.recurring ? 1 : 0 });
      // On success, switch back to view mode. The parent has already updated viewTask.
      setMode('view');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRequest = () => {
    setDeleteConfirm(true);
  };

  const handleDeleteConfirm = async () => {
    if (!onDelete) return;
    setDeleting(true);
    setDeleteConfirm(false);
    try { await onDelete(); } finally { setDeleting(false); }
  };

  const handleDeleteCancel = () => {
    setDeleteConfirm(false);
  };

  const handleCancel = async () => {
    if (!onCancel) return;
    if (!window.confirm('Stop the current active instance? The task will remain in its current status.')) return;
    setCancelling(true);
    try { await onCancel(); } finally { setCancelling(false); }
  };

  const handlePause = async () => {
    if (!onPause) return;
    const reason = window.prompt('Pause reason (optional):') ?? undefined;
    if (reason === null) return; // user cancelled the prompt
    setPausing(true);
    try { await onPause(reason || undefined); } finally { setPausing(false); }
  };

  const handleUnpause = async () => {
    if (!onUnpause) return;
    setPausing(true);
    try { await onUnpause(); } finally { setPausing(false); }
  };

  const set = (k: keyof FormState, v: unknown) =>
    setForm(f => ({ ...f, [k]: v }));

  // Extract branch name from URL for display
  const branchName = localTask.branch_url
    ? localTask.branch_url.replace(/.*\/tree\//, '')
    : null;
  const observedBranch = localTask.branch_name ?? branchName;
  const activeRunLifecycle = localTask.active_instance_id ? getRunLifecycle({
    status: localTask.active_instance_status ?? 'queued',
    created_at: localTask.active_instance_created_at,
    dispatched_at: localTask.active_instance_dispatched_at,
    started_at: localTask.active_instance_started_at,
    completed_at: localTask.active_instance_completed_at,
    runtime_ended_at: localTask.active_instance_runtime_ended_at,
    lifecycle_outcome_posted_at: localTask.active_instance_lifecycle_outcome_posted_at,
    task_outcome: localTask.active_instance_task_outcome,
    artifact_outcome: localTask.latest_run_outcome,
  }, { nonFailureOutcomes }) : null;
  const activeRunStatus = activeRunLifecycle?.displayStatus ?? null;

  return (
    <>
      {/* Everything Agent HQ delivered to a run, section by section. Rendered at panel root so
          the overlay is not clipped by the panel's own scroll container. */}
      {contextInstanceId !== null && (
        <ContextViewer instanceId={contextInstanceId} onClose={() => setContextInstanceId(null)} />
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Cancel delete"
            className="absolute inset-0 bg-black/70"
            onClick={handleDeleteCancel}
          />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-900/40 border border-red-500/30 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold text-base">Delete task?</h3>
                <p className="text-slate-400 text-xs mt-0.5">This cannot be undone.</p>
              </div>
            </div>
            <p className="text-sm text-slate-300 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 mb-5 font-medium truncate">
              #{localTask.id} · {localTask.title}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={handleDeleteCancel}
                className="px-4 py-2 text-sm text-slate-400 transition-colors hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-500"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Slide-over panel — full screen on mobile, side panel on desktop */}
      <div className="fixed inset-0 md:inset-auto md:right-0 md:top-0 md:bottom-0 z-50 w-full md:max-w-[520px] bg-slate-900 md:border-l border-slate-700 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-slate-500 text-sm font-mono shrink-0">#{localTask.id}</span>
            <h2 className="text-white font-semibold text-base truncate">
              {mode === 'view' ? localTask.title : 'Edit Task'}
            </h2>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 ml-2">
            {mode === 'view' && localTask.active_instance_id && onCancel && !['done', 'cancelled', 'failed'].includes(localTask.status) && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors border border-red-500/30 hover:border-red-400/50 rounded px-2 sm:px-2.5 py-1.5 disabled:opacity-50"
                title="Stop the current active instance"
              >
                <StopCircle className="w-3 h-3 shrink-0" />
                <span className="hidden sm:inline">{cancelling ? 'Stopping…' : 'Stop'}</span>
              </button>
            )}
            {mode === 'view' && !localTask.paused_at && onPause && !['done', 'cancelled', 'failed'].includes(localTask.status) && (
              <button
                onClick={handlePause}
                disabled={pausing}
                className="flex items-center gap-1.5 text-xs text-yellow-400 hover:text-yellow-300 transition-colors border border-yellow-500/30 hover:border-yellow-400/50 rounded px-2 sm:px-2.5 py-1.5 disabled:opacity-50"
                title="Pause this task — excludes it from routing and dispatch"
              >
                <PauseCircle className="w-3 h-3 shrink-0" />
                <span className="hidden sm:inline">{pausing ? 'Pausing…' : 'Pause'}</span>
              </button>
            )}
            {mode === 'view' && localTask.paused_at && onUnpause && (
              <button
                onClick={handleUnpause}
                disabled={pausing}
                className="flex items-center gap-1.5 text-xs text-green-400 hover:text-green-300 transition-colors border border-green-500/30 hover:border-green-400/50 rounded px-2 sm:px-2.5 py-1.5 disabled:opacity-50"
                title="Unpause — restore routing and dispatch eligibility"
              >
                <PlayCircle className="w-3 h-3 shrink-0" />
                <span className="hidden sm:inline">{pausing ? 'Unpausing…' : 'Unpause'}</span>
              </button>
            )}
            {mode === 'view' && onSave && (
              <button
                onClick={switchToEdit}
                disabled={loadingEdit}
                className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 transition-colors border border-amber-500/30 hover:border-amber-400/50 rounded px-2 sm:px-2.5 py-1.5 disabled:opacity-50"
                title="Edit task"
              >
                <Pencil className="w-3 h-3 shrink-0" />
                <span className="hidden sm:inline">{loadingEdit ? 'Loading…' : 'Edit'}</span>
              </button>
            )}
            {mode === 'view' && onDelete && (
              <button
                onClick={handleDeleteRequest}
                disabled={deleting}
                className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-red-400 transition-colors border border-slate-700 hover:border-red-500/40 rounded px-2 sm:px-2.5 py-1.5 disabled:opacity-50"
                title="Delete this task"
              >
                <Trash2 className="w-3 h-3 shrink-0" />
                <span className="hidden sm:inline">{deleting ? 'Deleting…' : 'Delete'}</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white transition-colors p-1"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 pb-20 md:pb-5">
          {mode === 'view' ? (
            <div className="space-y-5">
              {/* Title */}
              <div className="flex items-start gap-2">
                {isBlocked && (
                  <AlertTriangle className="w-4 h-4 text-orange-400 shrink-0 mt-1" />
                )}
                <h3 className="text-lg font-bold text-white leading-snug">
                  {localTask.title}
                  {localTask.recurring ? (
                    <span className="ml-2 text-sm text-slate-400" title="Recurring">🔁</span>
                  ) : null}
                </h3>
              </div>

              {/* Status + Priority badges */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_BADGE[localTask.status] ?? 'bg-slate-700 text-slate-300'}`}>
                  {STATUS_LABELS[localTask.status] ?? localTask.status}
                </span>
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${PRIORITY_BADGE[localTask.priority]}`}>
                  {localTask.priority} priority
                </span>
                {typeof localTask.story_points === 'number' && (
                  <span className="text-xs px-2.5 py-1 rounded-full font-medium bg-cyan-900/60 text-cyan-300">
                    {localTask.story_points} pts
                  </span>
                )}
                {effectiveModel && (
                  <span
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium bg-violet-900/50 text-violet-300 border border-violet-700/40"
                    title={`Effective model: ${effectiveModel}`}
                  >
                    <Cpu className="w-3 h-3 shrink-0" />
                    {shortModelName(effectiveModel)}
                  </span>
                )}
                {isBlocked && (
                  <span className="text-xs px-2.5 py-1 rounded-full font-medium bg-orange-900/60 text-orange-300">
                    blocked
                  </span>
                )}
                {localTask.paused_at && (
                  <span
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium bg-yellow-900/60 text-yellow-300 border border-yellow-600/40"
                    title={localTask.pause_reason ? `Paused: ${localTask.pause_reason}` : 'Task is paused — excluded from routing and dispatch'}
                  >
                    <PauseCircle className="w-3 h-3 shrink-0" />
                    paused
                  </span>
                )}
              </div>

              {/* Workflow */}
              {localTask.sprint_name && localTask.sprint_id && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Workflow</span>
                  <Link
                    href={`/workflows/${localTask.sprint_id}`}
                    onClick={onClose}
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-violet-900/50 text-violet-300 hover:bg-violet-800/60 hover:text-violet-200 transition-colors"
                  >
                    🏃 {formatSprintLabel({ id: localTask.sprint_id, name: localTask.sprint_name })}
                  </Link>
                </div>
              )}

              {typeof localTask.story_points === 'number' && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Points</span>
                  <span className="text-sm text-cyan-300 font-semibold">{localTask.story_points} story points</span>
                </div>
              )}

              {/* Paused banner */}
              {localTask.paused_at && (
                <div className="flex items-start gap-2 bg-yellow-900/20 border border-yellow-600/30 rounded-lg px-3 py-2.5">
                  <PauseCircle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-yellow-300">Task paused</p>
                    {localTask.pause_reason && (
                      <p className="text-xs text-yellow-400/80 mt-0.5">{localTask.pause_reason}</p>
                    )}
                    <p className="text-xs text-yellow-500/70 mt-0.5">Excluded from routing and agent dispatch until unpaused.</p>
                  </div>
                </div>
              )}

              {/* Assigned agent */}
              {(localTask.assigned_agent_name || localTask.agent_name) && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Assigned</span>
                  {localTask.assigned_agent_id ? (
                    <Link
                      href={`/agents/${localTask.assigned_agent_id}`}
                      onClick={onClose}
                      className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-emerald-900/50 text-emerald-300 hover:bg-emerald-800/60 hover:text-emerald-200 transition-colors"
                    >
                      {localTask.assigned_agent_name ?? localTask.agent_name}
                    </Link>
                  ) : (
                    <span className="text-sm text-slate-300">{localTask.assigned_agent_name ?? localTask.agent_name}</span>
                  )}
                </div>
              )}

              {/* Task Type */}
              {localTask.task_type && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Type</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300 font-mono">
                    {localTask.task_type}
                  </span>
                </div>
              )}


              {/* Active agent */}
              {localTask.agent_id && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Active</span>
                  <Link
                    href={`/agents/${localTask.agent_id}`}
                    onClick={onClose}
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-amber-900/50 text-amber-300 hover:bg-amber-800/60 hover:text-amber-200 transition-colors"
                  >
                    {localTask.active_agent_name ?? `Agent #${localTask.agent_id}`}
                  </Link>
                </div>
              )}

              {/* Branch URL */}
              {localTask.branch_url && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide w-20 shrink-0">Branch</span>
                  <a
                    href={localTask.branch_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                  >
                    <span className="font-mono">{branchName}</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}

              {/* Run Observability */}
              {(localTask.active_instance_id || localTask.latest_artifact_summary || localTask.last_agent_heartbeat_at || localTask.run_is_stale) && (
                <div>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                    Run Observability
                  </p>
                  <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 space-y-2 text-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      {localTask.active_instance_id && (
                        <span className="text-xs text-slate-400 font-mono">instance #{localTask.active_instance_id}</span>
                      )}
                      {activeRunStatus && (
                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${RUN_STATUS_BADGE[activeRunStatus] ?? 'bg-slate-700 text-slate-300'}`}>
                          {activeRunStatus === 'awaiting_outcome' ? 'Awaiting Outcome' : activeRunStatus}
                        </span>
                      )}
                      {localTask.run_is_stale ? (
                        <span className="text-xs px-2 py-1 rounded-full font-medium bg-red-900/60 text-orange-300">
                          stale run
                        </span>
                      ) : null}
                      {localTask.active_instance_runtime_ended_at && (
                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${localTask.active_instance_lifecycle_outcome_posted_at ? 'bg-emerald-900/60 text-emerald-300' : 'bg-amber-900/60 text-amber-200 border border-amber-500/30'}`}>
                          {localTask.active_instance_lifecycle_outcome_posted_at ? 'runtime ended' : 'ended without handoff'}
                        </span>
                      )}
                      {localTask.latest_run_stage ? (
                        <span className="text-xs px-2 py-1 rounded-full font-medium bg-slate-700 text-slate-300">
                          {localTask.latest_run_stage}
                        </span>
                      ) : null}
                    </div>
                    {localTask.latest_artifact_summary && (
                      <p className="text-slate-200 whitespace-pre-wrap">{localTask.latest_artifact_summary}</p>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-400">
                      {localTask.last_agent_heartbeat_at && <div>Last heartbeat: <span className="text-slate-200">{timeAgo(localTask.last_agent_heartbeat_at)}</span></div>}
                      {localTask.last_meaningful_output_at && <div>Last output: <span className="text-slate-200">{timeAgo(localTask.last_meaningful_output_at)}</span></div>}
                      {localTask.active_instance_runtime_ended_at && <div>Runtime ended: <span className="text-slate-200">{formatDateTime(localTask.active_instance_runtime_ended_at)}</span></div>}
                      {localTask.active_instance_runtime_end_source && <div>Terminal source: <span className="text-slate-200">{formatRuntimeEndSource(localTask.active_instance_runtime_end_source)}</span></div>}
                      {localTask.active_instance_lifecycle_outcome_posted_at && <div>Lifecycle outcome posted: <span className="text-slate-200">{formatDateTime(localTask.active_instance_lifecycle_outcome_posted_at)}</span></div>}
                      {observedBranch && <div>Branch: <span className="text-slate-200 font-mono">{observedBranch}</span></div>}
                      {localTask.latest_commit_hash && <div>Commit: <span className="text-slate-200 font-mono">{localTask.latest_commit_hash}</span></div>}
                      {typeof localTask.changed_files_count === 'number' && <div>Changed files: <span className="text-slate-200">{localTask.changed_files_count}</span></div>}
                      {localTask.latest_run_outcome && <div>Outcome: <span className="text-slate-200">{localTask.latest_run_outcome}</span></div>}
                    </div>
                    {!localTask.active_instance_lifecycle_outcome_posted_at && localTask.active_instance_runtime_ended_at && (
                      <div className="text-xs text-amber-200 border border-amber-500/30 bg-amber-950/20 rounded-md px-2.5 py-2">
                        Runtime ended{localTask.active_instance_runtime_end_source ? ` via ${formatRuntimeEndSource(localTask.active_instance_runtime_end_source)}` : ''} without a lifecycle outcome handoff. This is recovery/observability state, not a normal QA or release failure.
                      </div>
                    )}
                    {localTask.blocker_reason && (
                      <div className="text-xs text-orange-300">Blocker: {localTask.blocker_reason}</div>
                    )}
                    {(localTask.changed_files?.length ?? 0) > 0 && (
                      <div>
                        <p className="text-xs text-slate-500 mb-1">Files</p>
                        <p className="text-xs text-slate-300 font-mono break-all">{localTask.changed_files?.join(', ')}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <NeedsAttentionSection task={localTask} />

              <FailureStateSection task={localTask} history={historyEntries} outcomeMap={outcomeMap} />

              <TaskFieldsSection
                fields={resolvedFieldSchema?.fields ?? localTask.resolved_custom_field_schema?.fields ?? []}
                task={localTask}
              />

              {/* Related Runs */}
              <div>
                <div className="flex items-center gap-1.5 mb-3">
                  <Activity className="w-3.5 h-3.5 text-slate-400" />
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Agent Runs</p>
                  {/* Opens the newest captured dispatch. Hidden until something is captured, so
                      the control never promises context this task does not have. */}
                  {latestContextInstanceId !== null && (
                    <button
                      type="button"
                      onClick={() => setContextInstanceId(latestContextInstanceId)}
                      className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-400 transition-colors hover:border-amber-500/40 hover:text-amber-300"
                      title="See every piece of context Agent HQ delivered to the latest run"
                    >
                      <Layers className="w-3 h-3" />
                      View delivered context
                    </button>
                  )}
                  {/* Replays this task's status history on the routing graph. Deep-links
                      rather than embedding a canvas, so the modal stays light. */}
                  <a
                    href={`/routing?trace_task=${localTask.id}`}
                    className={`${latestContextInstanceId === null ? 'ml-auto ' : ''}inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-400 transition-colors hover:border-amber-500/40 hover:text-amber-300`}
                    title="Replay this task's path on the routing graph"
                  >
                    <GitBranch className="w-3 h-3" />
                    View path on graph
                  </a>
                </div>
                <RelatedRunsSection taskId={localTask.id} outcomeMap={outcomeMap} nonFailureOutcomes={nonFailureOutcomes} />
              </div>

              {/* Description */}
              {localTask.description ? (
                <div>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                    Description
                  </p>
                  <p className="text-sm text-slate-300 whitespace-pre-wrap bg-slate-800 border border-slate-700 rounded-lg p-3 leading-relaxed">
                    {localTask.description}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-slate-600 italic">No description</p>
              )}

              <RelatedTasksSection
                task={localTask}
                relationshipTypes={taskWorkflowMetadata.relationship_types}
                onTaskUpdate={setLocalTask}
                onClose={onClose}
              />

              {/* Divider */}
              <div className="border-t border-slate-800" />

              {/* Attachments Section */}
              <AttachmentsSection taskId={localTask.id} />

              {/* Divider */}
              <div className="border-t border-slate-800" />

              {/* Notes Section */}
              <NotesSection taskId={localTask.id} />

              {/* Divider */}
              <div className="border-t border-slate-800" />

              {/* History Section */}
              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">History</p>
                <HistorySection taskId={localTask.id} />
              </div>
            </div>
          ) : (
            /* Edit mode */
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                  Title *
                </label>
                <input
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400"
                  value={form.title ?? ''}
                  onChange={e => set('title', e.target.value)}
                  placeholder="Task title"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                  Description
                </label>
                <textarea
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 resize-none h-24"
                  value={form.description ?? ''}
                  onChange={e => set('description', e.target.value)}
                  placeholder="Optional details…"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Task Type</label>
                <div className="relative">
                  <select
                    className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                    value={form.task_type ?? ''}
                    onChange={e => set('task_type', e.target.value || null)}
                    disabled={taskTypesLoading || Boolean(taskTypesError) || taskTypeOptions.length === 0}
                  >
                    <option value="">{taskTypesLoading ? 'Loading task types...' : taskTypesError ? 'Task types unavailable' : taskTypeOptions.length === 0 ? 'No task types configured' : '— Select task type —'}</option>
                    {form.task_type && !taskTypeOptions.some(taskType => taskType.value === form.task_type) && taskTypesLoading && <option value={form.task_type}>{form.task_type}</option>}
                    {taskTypeOptions.map(taskType => (
                      <option key={taskType.value} value={taskType.value}>{taskType.label}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
                </div>
              </div>

              {((resolvedFieldSchema?.fields ?? []).length) > 0 && (
                <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
                  <div>
                    <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Workflow Task Fields</p>
                    <p className="text-[10px] text-slate-500 mt-1">Driven by workflow type {resolvedFieldSchema?.sprint_type ?? task.resolved_sprint_type ?? 'generic'}.</p>
                  </div>
                  {(resolvedFieldSchema?.fields ?? []).map(field => {
                    const value = (form.custom_fields ?? {})[field.key];
                    const baseClass = 'w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400';
                    return (
                      <div key={field.key}>
                        <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                          {field.label ?? field.key}{field.required ? ' *' : ''}
                        </label>
                        {field.type === 'textarea' ? (
                          <textarea
                            className={`${baseClass} resize-none h-24`}
                            value={typeof value === 'string' ? value : ''}
                            onChange={e => set('custom_fields', { ...(form.custom_fields ?? {}), [field.key]: e.target.value })}
                          />
                        ) : field.type === 'select' ? (
                          <select
                            className={baseClass}
                            value={typeof value === 'string' ? value : ''}
                            onChange={e => set('custom_fields', { ...(form.custom_fields ?? {}), [field.key]: e.target.value || '' })}
                          >
                            <option value="">— Select —</option>
                            {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
                          </select>
                        ) : field.type === 'checkbox' ? (
                          <label className="inline-flex items-center gap-2 text-sm text-slate-200">
                            <input
                              type="checkbox"
                              checked={Boolean(value)}
                              onChange={e => set('custom_fields', { ...(form.custom_fields ?? {}), [field.key]: e.target.checked })}
                            />
                            Enabled
                          </label>
                        ) : field.type === 'number' ? (
                          <input
                            type="number"
                            className={baseClass}
                            value={typeof value === 'number' ? value : ''}
                            onChange={e => set('custom_fields', { ...(form.custom_fields ?? {}), [field.key]: e.target.value === '' ? '' : Number(e.target.value) })}
                          />
                        ) : (
                          <input
                            type={field.type === 'url' ? 'url' : 'text'}
                            className={baseClass}
                            value={typeof value === 'string' ? value : ''}
                            onChange={e => set('custom_fields', { ...(form.custom_fields ?? {}), [field.key]: e.target.value })}
                          />
                        )}
                        {field.help_text && <p className="text-[10px] text-slate-500 mt-1">{field.help_text}</p>}
                      </div>
                    );
                  })}
                </div>
              )}

              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Story Points</label>
                <div className="grid grid-cols-5 gap-1.5">
                  {([
                    { value: 1, label: 'Trivial' },
                    { value: 2, label: 'Small' },
                    { value: 3, label: 'Medium' },
                    { value: 5, label: 'Large' },
                    { value: 8, label: 'Epic' },
                  ] as const).map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => set('story_points', value)}
                      className={`flex flex-col items-center justify-center py-2 px-1 rounded-lg border text-xs font-semibold transition-all
                        ${form.story_points === value
                          ? 'border-cyan-400 bg-cyan-900/40 text-cyan-300'
                          : 'border-slate-600 bg-slate-800 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                        }`}
                    >
                      <span className="text-base leading-tight">{value}</span>
                      <span className="text-[9px] leading-tight mt-0.5 font-normal">{label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">                <div>
                  <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                    Status
                  </label>
                  <div className="relative">
                    <select
                      className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                      value={form.status ?? taskStatuses[0]?.key ?? ''}
                      onChange={e => set('status', e.target.value)}
                      disabled={taskStatuses.length === 0}
                    >
                      {taskStatuses.map(status => (
                        <option key={status.key} value={status.key}>{status.label}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                    Priority
                  </label>
                  <div className="relative">
                    <select
                      className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                      value={form.priority ?? 'medium'}
                      onChange={e => set('priority', e.target.value)}
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                    <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                  Project
                </label>
                <div className="relative">
                  <select
                    className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                    value={form.project_id ?? ''}
                    onChange={e => {
                      const nextProjectId = e.target.value ? Number(e.target.value) : null;
                      setForm(current => ({
                        ...current,
                        project_id: nextProjectId,
                        sprint_id: current.project_id === nextProjectId ? current.sprint_id : null,
                        sprint_name: current.project_id === nextProjectId ? current.sprint_name : null,
                        task_type: current.project_id === nextProjectId ? current.task_type : null,
                      }));
                    }}
                  >
                    <option value="">— No project —</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                  Workflow
                </label>
                <div className="relative">
                  <select
                    className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8 disabled:opacity-60"
                    value={form.sprint_id ?? ''}
                    onChange={e => setForm(current => ({
                      ...current,
                      sprint_id: e.target.value ? Number(e.target.value) : null,
                      sprint_name: e.target.value ? (sprints.find(sprint => sprint.id === Number(e.target.value))?.name ?? current.sprint_name ?? null) : null,
                      task_type: null,
                    }))}
                    disabled={!form.project_id || loadingSprints}
                  >
                    <option value="">{form.project_id ? '— No workflow —' : 'Select a project first'}</option>
                    {sprints.map(sprint => (
                      <option key={sprint.id} value={sprint.id}>
                        {formatSprintLabel(sprint)}{sprint.status ? ` (${sprint.status})` : ''}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
                </div>
                <p className="text-[10px] text-slate-600 mt-0.5">
                  {loadingSprints ? 'Loading workflows...' : form.project_id ? 'Choose a workflow for this project or leave it unassigned' : 'Assign a project before choosing a workflow'}
                </p>
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                  Agent Assignment
                </label>
                <p className="text-sm text-slate-500 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
                  {form.agent_name ?? 'Auto - resolved by assignment rules at dispatch time'}
                </p>
                <p className="text-[10px] text-slate-600 mt-0.5">Set task_type instead — the dispatcher resolves the correct agent</p>
              </div>

              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">
                  Branch URL
                </label>
                <input
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 font-mono"
                  value={form.branch_url ?? ''}
                  onChange={e => set('branch_url', e.target.value || null)}
                  placeholder="https://github.com/org/repo/tree/branch-name"
                />
              </div>

              <div className="flex items-center justify-between p-3 bg-slate-700/50 border border-slate-600 rounded-lg">
                <div>
                  <p className="text-sm text-white font-medium">Recurring</p>
                  <p className="text-xs text-slate-400">Resets to To Do on each new agent run</p>
                </div>
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, recurring: !f.recurring }))}
                  className={`relative w-10 h-5 rounded-full transition-colors ${form.recurring ? 'bg-amber-500' : 'bg-slate-600'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${form.recurring ? 'left-5' : 'left-0.5'}`} />
                </button>
              </div>

              <RelatedTasksSection
                task={localTask}
                relationshipTypes={taskWorkflowMetadata.relationship_types}
                onTaskUpdate={setLocalTask}
                onClose={onClose}
              />
            </div>
          )}
        </div>

        {/* Footer — only in edit mode */}
        {mode === 'edit' && (
          <div className="flex flex-col gap-2 px-6 py-4 border-t border-slate-700 shrink-0">
            {saveError && (
              <p className="text-xs text-red-400 bg-red-950/30 border border-red-500/30 rounded px-3 py-2">
                {saveError}
              </p>
            )}
            <div className="flex items-center justify-between">
              <div>
                {onDelete && (
                  <button
                    onClick={handleDeleteRequest}
                    disabled={deleting}
                    className="text-sm text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
                  >
                    {deleting ? 'Deleting…' : 'Delete'}
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { setMode('view'); setSaveError(null); setForm({ ...localTask, recurring: !!localTask.recurring }); }}
                  className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !form.title?.trim()}
                  className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
