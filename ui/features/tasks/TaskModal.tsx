'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, ChevronDown, Link2, Search, Plus, Trash2 } from 'lucide-react';
import { api, type CustomFieldDefinition, type ResolvedTaskFieldSchemaResponse, type TaskRelationshipTypeConfig } from '@/lib/api';
import { formatSprintLabel } from '@/lib/sprintLabel';
import { getTaskStatusMaps } from '@/lib/taskStatuses';
import { shouldClearInvalidTaskType, useTaskTypes } from '@/lib/taskTypes';
import { useWorkflowMetadata } from '@/lib/useWorkflowMetadata';
import type { ModalForm, Project, Sprint, Task } from '@/features/tasks/useTasksPageState';
import { AutoGrowTextarea } from '@/components/AutoGrowTextarea';

export interface RelatedTaskCreateContext {
  sourceTaskId: number;
  sourceTaskTitle: string;
  relationshipTypeLabel: string;
}

interface TaskModalProps {
  task: Partial<Task>;
  projects?: Project[];
  title?: string;
  relatedContext?: RelatedTaskCreateContext;
  onClose: () => void;
  onSave: (data: Partial<Task> & { recurring: number }) => Promise<void>;
  onDelete?: () => Promise<void>;
}

export type TaskModalSavePayload = Omit<Partial<Task>, 'relationships'> & {
  recurring: number;
  relationships?: Array<{ target_task_id: number; relationship_type_key: string }>;
};

interface PendingRelatedTask {
  target_task_id: number;
  title: string;
  status: string;
  relationship_type_key: string;
  relationship_type_label: string;
}

interface RelatedTaskSearchResult {
  id: number;
  title: string;
  status: string;
}

const STORY_POINT_OPTIONS = [
  { value: 1, label: 'Trivial' },
  { value: 2, label: 'Small' },
  { value: 3, label: 'Medium' },
  { value: 5, label: 'Large' },
  { value: 8, label: 'Epic' },
] as const;

function customFieldValue(form: ModalForm, field: CustomFieldDefinition): unknown {
  const customValue = form.custom_fields?.[field.key];
  if (customValue !== undefined && customValue !== null) return customValue;
  return (form as unknown as Record<string, unknown>)[field.key];
}

function CreateRelatedTasksField({
  projectId,
  sprintId,
  relationshipTypes,
  selected,
  onChange,
}: {
  projectId?: number | null;
  sprintId?: number | null;
  relationshipTypes: TaskRelationshipTypeConfig[];
  selected: PendingRelatedTask[];
  onChange: (next: PendingRelatedTask[]) => void;
}) {
  const [selectedTypeKey, setSelectedTypeKey] = useState(relationshipTypes[0]?.key ?? '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RelatedTaskSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedType = relationshipTypes.find(type => type.key === selectedTypeKey) ?? relationshipTypes[0] ?? null;

  useEffect(() => {
    if (relationshipTypes.length > 0 && !relationshipTypes.some(type => type.key === selectedTypeKey)) {
      setSelectedTypeKey(relationshipTypes[0].key);
    }
  }, [relationshipTypes, selectedTypeKey]);

  useEffect(() => () => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
  }, []);

  const doSearch = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const selectedIds = new Set(selected.map(task => task.target_task_id));
      const rows = await api.searchTasks(trimmed, undefined, { project_id: projectId ?? null, sprint_id: sprintId ?? null });
      setResults(rows.filter(row => !selectedIds.has(row.id)));
    } catch (err) {
      setResults([]);
      setSearchError(err instanceof Error ? err.message : 'Failed to search tasks');
    } finally {
      setSearching(false);
    }
  };

  const handleQueryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setQuery(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => void doSearch(value), 200);
  };

  const handleAdd = (result: RelatedTaskSearchResult) => {
    if (!selectedType) return;
    onChange([
      ...selected,
      {
        target_task_id: result.id,
        title: result.title,
        status: result.status,
        relationship_type_key: selectedType.key,
        relationship_type_label: selectedType.label,
      },
    ]);
    setQuery('');
    setResults([]);
  };

  const handleRemove = (taskId: number, typeKey: string) => {
    onChange(selected.filter(task => task.target_task_id !== taskId || task.relationship_type_key !== typeKey));
  };

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-3 space-y-3">
      <div>
        <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Related Tasks</label>
        <p className="text-[10px] text-slate-500">Relationship behavior comes from the selected workflow type.</p>
      </div>

      {relationshipTypes.length > 0 ? (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[180px_1fr]">
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
                  onClick={() => handleAdd(result)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-200 transition-colors hover:bg-slate-800"
                >
                  <Plus className="h-3.5 w-3.5 text-amber-400" />
                  <span className="font-mono text-slate-400">#{result.id}</span>
                  <span className="min-w-0 flex-1 truncate">{result.title}</span>
                  <span className="text-[10px] text-slate-500">{result.status}</span>
                </button>
              ))}
            </div>
          )}

          {query.trim() && results.length === 0 && !searching && <p className="text-xs text-slate-500">No matching tasks.</p>}
          {searchError && <p className="text-xs text-red-300">{searchError}</p>}
        </>
      ) : (
        <p className="text-xs text-slate-600 italic">Choose a workflow with configured relationship types before adding related tasks.</p>
      )}

      {selected.length > 0 ? (
        <div className="space-y-1.5">
          {selected.map(task => (
            <div key={`${task.relationship_type_key}-${task.target_task_id}`} className="flex items-start justify-between gap-3 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-200"><span className="font-mono text-slate-400">#{task.target_task_id}</span> {task.title}</p>
                <p className="mt-1 text-[10px] text-slate-500">{task.relationship_type_label} · {task.status}</p>
              </div>
              <button
                type="button"
                onClick={() => handleRemove(task.target_task_id, task.relationship_type_key)}
                className="rounded-md p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-red-300"
                aria-label={`Remove related task ${task.target_task_id}`}
                title="Remove relationship"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-600 italic">No related tasks selected.</p>
      )}
    </div>
  );
}

export function TaskModal({ task, projects: providedProjects, title, relatedContext, onClose, onSave, onDelete }: TaskModalProps) {
  const [form, setForm] = useState<ModalForm>({ ...task, recurring: !!task.recurring });
  const [pendingRelatedTasks, setPendingRelatedTasks] = useState<PendingRelatedTask[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [projects, setProjects] = useState<Project[]>(providedProjects ?? []);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [loadingSprints, setLoadingSprints] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resolvedFieldSchema, setResolvedFieldSchema] = useState<ResolvedTaskFieldSchemaResponse | null>(null);

  const selectedSprint = useMemo(
    () => sprints.find(sprint => sprint.id === form.sprint_id) ?? null,
    [form.sprint_id, sprints],
  );
  const taskTypeSprintType = form.sprint_id
    ? selectedSprint?.sprint_type ?? task.resolved_sprint_type ?? null
    : task.resolved_sprint_type ?? null;
  const { options: taskTypeOptions, loading: taskTypesLoading, error: taskTypesError } = useTaskTypes(form.sprint_id ?? null, {
    sprintType: form.sprint_id ? null : taskTypeSprintType,
  });
  const { metadata: taskWorkflowMetadata } = useWorkflowMetadata(form.sprint_id ?? null, {
    sprintType: form.sprint_id ? null : taskTypeSprintType,
    taskType: form.task_type ?? null,
  });
  const { definitions: taskStatuses } = getTaskStatusMaps(taskWorkflowMetadata.statuses);
  const resolvedFields = useMemo(
    () => resolvedFieldSchema?.fields ?? form.resolved_custom_field_schema?.fields ?? [],
    [resolvedFieldSchema?.fields, form.resolved_custom_field_schema?.fields],
  );

  const set = (k: keyof ModalForm, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    setForm({ ...task, recurring: !!task.recurring });
  }, [task]);

  useEffect(() => {
    if (providedProjects) {
      setProjects(providedProjects);
      return;
    }
    api.getProjects().then(setProjects).catch(() => setProjects([]));
  }, [providedProjects]);

  useEffect(() => {
    setForm(current => {
      if (current.status && taskStatuses.some(option => option.key === current.status)) return current;
      const nextStatus = taskStatuses[0]?.key;
      return nextStatus ? { ...current, status: nextStatus } : current;
    });
  }, [taskStatuses]);

  useEffect(() => {
    setForm(current => shouldClearInvalidTaskType(current.task_type ?? null, taskTypeOptions, taskTypesLoading)
      ? { ...current, task_type: null }
      : current);
  }, [taskTypeOptions, taskTypesLoading]);

  useEffect(() => {
    let cancelled = false;
    api.resolveTaskFieldSchema({ sprint_id: form.sprint_id ?? null, task_type: form.task_type ?? null })
      .then(schema => { if (!cancelled) setResolvedFieldSchema(schema); })
      .catch(() => { if (!cancelled) setResolvedFieldSchema(null); });
    return () => { cancelled = true; };
  }, [form.sprint_id, form.task_type]);

  useEffect(() => {
    let cancelled = false;
    if (!form.project_id) {
      setSprints([]);
      return;
    }

    setLoadingSprints(true);
    api.getSprints(form.project_id, true)
      .then(projectSprints => {
        if (cancelled) return;
        setSprints(projectSprints);
        if (form.sprint_id != null && !projectSprints.some(sprint => sprint.id === form.sprint_id)) {
          setForm(current => current.sprint_id == null ? current : ({ ...current, sprint_id: null, sprint_name: null }));
        }
      })
      .catch(() => { if (!cancelled) setSprints([]); })
      .finally(() => { if (!cancelled) setLoadingSprints(false); });

    return () => { cancelled = true; };
  }, [form.project_id, form.sprint_id]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const payload: TaskModalSavePayload = {
        ...(form as Omit<Partial<Task>, 'relationships'>),
        recurring: form.recurring ? 1 : 0,
        ...(!form.id && pendingRelatedTasks.length > 0
          ? {
              relationships: pendingRelatedTasks.map(task => ({
                target_task_id: task.target_task_id,
                relationship_type_key: task.relationship_type_key,
              })),
            }
          : {}),
      };
      await onSave(payload as Partial<Task> & { recurring: number });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    setDeleting(true);
    try { await onDelete(); } finally { setDeleting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm p-3 sm:flex sm:items-center sm:justify-center sm:p-4">
      <div className="flex h-full max-h-[calc(100vh-1.5rem)] w-full flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl sm:h-auto sm:max-h-[min(90vh,54rem)] sm:max-w-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-700 bg-slate-900 px-4 py-3 sm:px-6 sm:py-4">
          <div>
            <h2 className="text-white font-semibold text-base">{title ?? (task.id ? 'Edit Task' : 'Create New Task')}</h2>
            {relatedContext && (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400">
                <Link2 className="h-3 w-3 text-amber-400" />
                Will link to #{relatedContext.sourceTaskId} as {relatedContext.relationshipTypeLabel} after creation.
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 transition-colors hover:text-white focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-2 focus:ring-offset-slate-900" aria-label="Close task modal">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4 sm:px-6 sm:py-5">
          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Title *</label>
            <input className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400" value={form.title ?? ''} onChange={e => set('title', e.target.value)} placeholder="Task title" />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Description</label>
            <AutoGrowTextarea className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400" value={form.description ?? ''} onChange={value => set('description', value)} placeholder="Optional details…" />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Status</label>
              <div className="relative">
                <select className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8" value={form.status ?? taskStatuses[0]?.key ?? ''} onChange={e => set('status', e.target.value)} disabled={taskStatuses.length === 0}>
                  {taskStatuses.map(status => <option key={status.key} value={status.key}>{status.label}</option>)}
                </select>
                <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Priority</label>
              <div className="relative">
                <select className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8" value={form.priority ?? 'medium'} onChange={e => set('priority', e.target.value as Task['priority'])}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
                <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Project</label>
            <div className="relative">
              <select className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8" value={form.project_id ?? ''} onChange={e => {
                const nextProjectId = e.target.value ? Number(e.target.value) : null;
                setForm(current => ({ ...current, project_id: nextProjectId, sprint_id: current.project_id === nextProjectId ? current.sprint_id : null, sprint_name: current.project_id === nextProjectId ? current.sprint_name : null, task_type: current.project_id === nextProjectId ? current.task_type : null }));
              }}>
                <option value="">— No project —</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Workflow</label>
            <div className="relative">
              <select className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8 disabled:opacity-60" value={form.sprint_id ?? ''} onChange={e => setForm(current => ({ ...current, sprint_id: e.target.value ? Number(e.target.value) : null, sprint_name: e.target.value ? (sprints.find(sprint => sprint.id === Number(e.target.value))?.name ?? current.sprint_name ?? null) : null, task_type: null }))} disabled={!form.project_id || loadingSprints}>
                <option value="">{form.project_id ? '— No workflow —' : 'Select a project first'}</option>
                {sprints.map(sprint => <option key={sprint.id} value={sprint.id}>{formatSprintLabel(sprint)}{sprint.status ? ` (${sprint.status})` : ''}</option>)}
              </select>
              <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
            </div>
            <p className="text-[10px] text-slate-600 mt-0.5">{loadingSprints ? 'Loading workflows...' : form.project_id ? 'Choose a workflow for this project or leave it unassigned' : 'Assign a project before choosing a workflow'}</p>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Task Type</label>
            <div className="relative">
              <select className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 pr-8 disabled:opacity-60" value={form.task_type ?? ''} onChange={e => set('task_type', e.target.value || null)} disabled={taskTypesLoading || Boolean(taskTypesError) || taskTypeOptions.length === 0}>
                <option value="">{taskTypesLoading ? 'Loading task types...' : taskTypesError ? 'Task types unavailable' : taskTypeOptions.length === 0 ? 'No task types configured' : '— Select task type —'}</option>
                {form.task_type && !taskTypeOptions.some(taskType => taskType.value === form.task_type) && taskTypesLoading && <option value={form.task_type}>{form.task_type}</option>}
                {taskTypeOptions.map(taskType => <option key={taskType.value} value={taskType.value}>{taskType.label}</option>)}
              </select>
              <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
            </div>
            <p className="text-[10px] text-slate-600 mt-0.5">Determines which agent handles this task via assignment rules</p>
          </div>

          {resolvedFields.length > 0 && (
            <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
              <div>
                <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Workflow Task Fields</p>
                <p className="text-[10px] text-slate-500 mt-1">Driven by workflow/task type field schema.</p>
              </div>
              {resolvedFields.map(field => {
                const value = customFieldValue(form, field);
                const baseClass = 'w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400';
                const updateCustomField = (nextValue: unknown) => set('custom_fields', { ...(form.custom_fields ?? {}), [field.key]: nextValue });
                return (
                  <div key={field.key}>
                    <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">{field.label ?? field.key}{field.required ? ' *' : ''}</label>
                    {field.type === 'textarea' ? (
                      <textarea className={`${baseClass} resize-none h-24`} value={typeof value === 'string' ? value : ''} onChange={e => updateCustomField(e.target.value)} />
                    ) : field.type === 'select' ? (
                      <select className={baseClass} value={typeof value === 'string' ? value : ''} onChange={e => updateCustomField(e.target.value || '')}>
                        <option value="">— Select —</option>
                        {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
                      </select>
                    ) : field.type === 'checkbox' ? (
                      <label className="inline-flex items-center gap-2 text-sm text-slate-200"><input type="checkbox" checked={Boolean(value)} onChange={e => updateCustomField(e.target.checked)} />Enabled</label>
                    ) : field.type === 'number' ? (
                      <input type="number" className={baseClass} value={typeof value === 'number' ? value : ''} onChange={e => updateCustomField(e.target.value === '' ? '' : Number(e.target.value))} />
                    ) : (
                      <input type={field.type === 'url' ? 'url' : 'text'} className={baseClass} value={typeof value === 'string' ? value : ''} onChange={e => updateCustomField(e.target.value)} />
                    )}
                    {field.help_text && <p className="text-[10px] text-slate-500 mt-1">{field.help_text}</p>}
                  </div>
                );
              })}
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Story Points <span className="text-red-400">*</span></label>
            <div className="grid grid-cols-5 gap-1.5">
              {STORY_POINT_OPTIONS.map(({ value, label }) => (
                <button key={value} type="button" onClick={() => set('story_points', value)} className={`flex flex-col items-center justify-center py-2 px-1 rounded-lg border text-xs font-semibold transition-all ${form.story_points === value ? 'border-cyan-400 bg-cyan-900/40 text-cyan-300' : 'border-slate-600 bg-slate-800 text-slate-400 hover:border-slate-500 hover:text-slate-200'}`}>
                  <span className="text-base leading-tight">{value}</span><span className="text-[9px] leading-tight mt-0.5 font-normal">{label}</span>
                </button>
              ))}
            </div>
            {!form.story_points && <p className="text-[10px] text-amber-500/80 mt-1">Required — select a size before saving</p>}
          </div>

          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1">Branch URL</label>
            <input className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 font-mono" value={form.branch_url ?? ''} onChange={e => set('branch_url', e.target.value || null)} placeholder="https://github.com/org/repo/tree/branch-name" />
          </div>

          <div className="flex items-center justify-between p-3 bg-slate-700/50 border border-slate-600 rounded-lg">
            <div><p className="text-sm text-white font-medium">Recurring</p><p className="text-xs text-slate-400">Resets to To Do on each new agent run</p></div>
            <button type="button" onClick={() => setForm(f => ({ ...f, recurring: !f.recurring }))} className={`relative w-10 h-5 rounded-full transition-colors ${form.recurring ? 'bg-amber-500' : 'bg-slate-600'}`}>
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${form.recurring ? 'left-5' : 'left-0.5'}`} />
            </button>
          </div>

          {!form.id && (
            <CreateRelatedTasksField
              projectId={form.project_id ?? null}
              sprintId={form.sprint_id ?? null}
              relationshipTypes={taskWorkflowMetadata.relationship_types ?? []}
              selected={pendingRelatedTasks}
              onChange={setPendingRelatedTasks}
            />
          )}
        </div>

        <div className="sticky bottom-0 flex flex-col gap-2 border-t border-slate-700 bg-slate-900 px-4 py-3 sm:px-6 sm:py-4">
          {saveError && <p className="text-xs text-red-400 bg-red-950/30 border border-red-500/30 rounded px-3 py-2">{saveError}</p>}
          <div className="flex items-center justify-between">
            <div>{onDelete && <button onClick={handleDelete} disabled={deleting} className="text-sm text-red-400 hover:text-red-300 transition-colors disabled:opacity-50">{deleting ? 'Deleting…' : 'Delete'}</button>}</div>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={handleSave} disabled={saving || !form.title?.trim() || !form.story_points || !form.status} className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
