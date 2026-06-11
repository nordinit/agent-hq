'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, X, Shield, AlertTriangle, GripVertical, PauseCircle, Search } from 'lucide-react';
import { api } from '@/lib/api';
import type { TaskRelationship, TaskRelationshipTypeConfig } from '@/lib/api';
import { getFailureSourceLabel, getFailureTone, isFailureBlocked } from '@/lib/taskFailure';
import { formatFailureOutcomeBadgeLabel, type TaskOutcomeMetaMap } from '@/lib/taskOutcomeMeta';
import { relationshipDispatchImpactLabel, relationshipTypeOptionLabel } from '@/lib/taskRelationshipDisplay';
import { formatSprintLabel } from '@/lib/sprintLabel';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BoardTask {
  id: number;
  title: string;
  description: string;
  status: string;
  priority: 'low' | 'medium' | 'high';
  agent_id?: number | null;
  assigned_agent_id?: number | null;
  assigned_agent_name?: string | null;
  active_agent_name?: string | null;
  project_id: number | null;
  sprint_id?: number | null;
  sprint_name?: string | null;
  agent_name?: string;
  recurring?: number | boolean;
  story_points?: number | null;
  task_type?: string | null;
  active_instance_id?: number | null;
  active_instance_status?: string | null;
  blockers?: BoardTask[];
  blocking?: BoardTask[];
  origin_task_id?: number | null;
  origin_task_title?: string | null;
  defect_type?: string | null;
  spawned_defects?: number | null;
  paused_at?: string | null;
  pause_reason?: string | null;
  failure_detail?: string | null;
  active_instance_task_outcome?: string | null;
  latest_task_outcome?: string | null;
}

export type ColumnDef = { key: string; label: string; color: string };

export const PRIORITY_BADGE: Record<string, string> = {
  low: 'bg-slate-700 text-slate-300',
  medium: 'bg-amber-900/60 text-amber-300',
  high: 'bg-red-900/60 text-red-300',
};

export function isBlocked(task: BoardTask): boolean {
  return (task.blockers ?? []).some(b => b.status !== 'done');
}

export function groupByJob(list: BoardTask[]): Record<string, BoardTask[]> {
  const groups: Record<string, BoardTask[]> = {};
  for (const t of list) {
    const key = t.agent_name ?? '__none__';
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }
  return groups;
}

// ── Relationship Picker ───────────────────────────────────────────────────────

interface RelationshipPickerProps {
  task: BoardTask;
  relationshipTypes: TaskRelationshipTypeConfig[];
  onLinkTask: (taskId: number, targetTaskId: number, relationshipTypeKey: string) => Promise<void>;
}

interface TaskSearchResult {
  id: number;
  title: string;
  status: string;
}

export function RelationshipPicker({ task, relationshipTypes, onLinkTask }: RelationshipPickerProps) {
  const [open, setOpen] = useState(false);
  const [selectedTypeKey, setSelectedTypeKey] = useState(relationshipTypes[0]?.key ?? '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TaskSearchResult[]>([]);
  const [relationships, setRelationships] = useState<TaskRelationship[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingRelationships, setLoadingRelationships] = useState(false);
  const [adding, setAdding] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedType = relationshipTypes.find(type => type.key === selectedTypeKey) ?? relationshipTypes[0] ?? null;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
        setResults([]);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  useEffect(() => {
    if (relationshipTypes.length > 0 && !relationshipTypes.some(type => type.key === selectedTypeKey)) {
      setSelectedTypeKey(relationshipTypes[0].key);
    }
  }, [relationshipTypes, selectedTypeKey]);

  useEffect(() => {
    if (!open) return;
    setLoadingRelationships(true);
    setError(null);
    api.getTaskRelationships(task.id)
      .then(response => setRelationships(response.relationships))
      .catch(err => {
        setRelationships([]);
        setError(err instanceof Error ? err.message : 'Failed to load existing relationships');
      })
      .finally(() => setLoadingRelationships(false));
  }, [open, task.id]);

  const doSearch = useCallback((q: string, typeKey = selectedTypeKey) => {
    if (!q.trim()) { setResults([]); return; }
    setSearching(true);
    setError(null);
    api.searchTasks(q, task.id)
      .then(rows => {
        const existingTypeLinks = new Set(
          relationships
            .filter(relationship => relationship.relationship_type_key === typeKey)
            .map(relationship => relationship.source_task_id === task.id ? relationship.target_task_id : relationship.source_task_id),
        );
        setResults(rows.filter(r => !existingTypeLinks.has(r.id)));
      })
      .catch(err => {
        setResults([]);
        setError(err instanceof Error ? err.message : 'Failed to search tasks');
      })
      .finally(() => setSearching(false));
  }, [relationships, selectedTypeKey, task.id]);

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => doSearch(val), 200);
  };

  const handleAdd = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    if (!selectedType) return;
    setAdding(id);
    setError(null);
    try {
      await onLinkTask(task.id, id, selectedType.key);
      setOpen(false);
      setQuery('');
      setResults([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link task');
    } finally {
      setAdding(null);
    }
  };

  if (relationshipTypes.length === 0) {
    return (
      <span className="text-[11px] text-slate-600 italic">
        No link types configured
      </span>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        className="flex items-center gap-1 text-xs text-slate-400 hover:text-amber-400 transition-colors px-1.5 py-0.5 rounded border border-slate-600 hover:border-amber-400/50"
        title="Link task"
      >
        <Plus className="w-3 h-3" />
        Link Task
      </button>
      {open && (
        <div
          className="absolute left-0 top-full mt-1 z-40 bg-slate-800 border border-slate-600 rounded-lg shadow-xl w-72"
          onClick={e => e.stopPropagation()}
        >
          <div className="border-b border-slate-700 p-2">
            <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
              Relationship
            </label>
            <select
              value={selectedTypeKey}
              onChange={e => {
                const nextTypeKey = e.target.value;
                setSelectedTypeKey(nextTypeKey);
                setResults([]);
                if (query.trim()) {
                  if (searchTimeout.current) clearTimeout(searchTimeout.current);
                  searchTimeout.current = setTimeout(() => doSearch(query, nextTypeKey), 0);
                }
              }}
              className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
              aria-label="Relationship type"
            >
              {relationshipTypes.map(type => (
                <option key={type.key} value={type.key}>{relationshipTypeOptionLabel(type)}</option>
              ))}
            </select>
            {selectedType && (
              <p className={`mt-1 text-[10px] ${selectedType.affects_dispatch_eligibility === 1 ? 'text-orange-300' : 'text-slate-500'}`}>
                {relationshipDispatchImpactLabel(selectedType)}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-slate-700">
            <Search className="w-3 h-3 text-slate-500 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={handleQueryChange}
              placeholder="Search by #id or title…"
              className="flex-1 bg-transparent text-xs text-white placeholder-slate-500 focus:outline-none"
            />
            {(searching || loadingRelationships) && <span className="text-[10px] text-slate-500">…</span>}
          </div>
          {error && <p className="px-3 py-2 text-xs text-red-300 border-b border-red-500/20">{error}</p>}
          <div className="max-h-48 overflow-y-auto">
            {query.trim() === '' ? (
              <p className="text-xs text-slate-500 p-3">Type a task number or title to search</p>
            ) : results.length === 0 && !searching ? (
              <p className="text-xs text-slate-500 p-3">No matching tasks</p>
            ) : (
              results.map(t => (
                <button
                  key={t.id}
                  onClick={e => handleAdd(e, t.id)}
                  disabled={adding === t.id}
                  className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-700 transition-colors disabled:opacity-50"
                >
                  {adding === t.id ? (
                    <span className="text-amber-400">Adding…</span>
                  ) : (
                    <div className="flex items-start gap-2">
                      <Shield className="w-3 h-3 text-slate-500 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <span className="text-slate-400 font-mono">#{t.id}</span>
                        {' '}
                        <span className="truncate">{t.title}</span>
                        <span className="ml-1.5 text-[10px] text-slate-500">({t.status})</span>
                      </div>
                    </div>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Task Card ─────────────────────────────────────────────────────────────────

interface TaskCardProps {
  task: BoardTask;
  allTasks: BoardTask[];
  onClick: () => void;
  relationshipTypes: TaskRelationshipTypeConfig[];
  onLinkTask: (taskId: number, targetTaskId: number, relationshipTypeKey: string) => Promise<void>;
  onRemoveBlocker: (taskId: number, blockerId: number) => Promise<void>;
  onPause: (taskId: number) => Promise<void>;
  /** When true, shows sprint link badge on the card */
  showSprint?: boolean;
  outcomeMap: TaskOutcomeMetaMap;
}

export function TaskCard({ task, allTasks, onClick, relationshipTypes, onLinkTask, onRemoveBlocker, onPause, showSprint = false, outcomeMap }: TaskCardProps) {
  const [pausing, setPausing] = useState(false);
  const blocked = isBlocked(task);
  const blockers = task.blockers ?? [];
  const blocking = task.blocking ?? [];
  const failureSource = getFailureSourceLabel(task, outcomeMap);
  const failureTone = getFailureTone(task, outcomeMap);
  const pipelineBlocked = isFailureBlocked(task, outcomeMap);

  return (
    <div
      onClick={onClick}
      className={`bg-slate-800 border rounded-lg p-3 cursor-pointer transition-all group min-h-[44px] min-w-0 max-w-full overflow-hidden
        ${blocked
          ? 'border-orange-500/50 hover:border-orange-400/70 active:border-orange-400/70'
          : 'border-slate-700 hover:border-amber-400/40 hover:bg-slate-750 active:bg-slate-700'
        }`}
    >
      {/* Task number + title row */}
      <div className="flex items-start gap-1.5 mb-2">
        {blocked && (
          <span title="Blocked by unfinished tasks"><AlertTriangle className="w-3.5 h-3.5 text-orange-400 shrink-0 mt-0.5" /></span>
        )}
        <div className="flex-1 min-w-0">
          <span className="text-xs text-slate-600 font-mono mr-1.5">#{task.id}</span>
          <span className={`text-sm md:text-sm font-semibold leading-snug ${blocked ? 'text-orange-100' : 'text-white group-hover:text-amber-50'}`}>
            {task.title}
            {task.recurring ? <span className="ml-1.5 text-xs text-slate-400" title="Recurring">🔁</span> : null}
          </span>
        </div>
      </div>

      {/* Priority + story points + agent + stop button */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className={`text-xs px-2 py-1 rounded-full font-semibold ${PRIORITY_BADGE[task.priority]}`}>
          {task.priority}
        </span>
        {task.story_points != null && (
          <span className="text-xs px-2 py-0.5 rounded-full font-bold bg-cyan-900/50 text-cyan-300 border border-cyan-700/40" title="Story points">
            {task.story_points}pt
          </span>
        )}
        {task.task_type && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 font-mono">
            {task.task_type}
          </span>
        )}
        {task.defect_type && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-300 font-semibold" title={`Defect: ${task.defect_type.replace(/_/g, ' ')}`}>
            {task.defect_type.replace(/_/g, ' ')}
          </span>
        )}
        {(task.spawned_defects ?? 0) > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-red-900/40 text-red-400 font-semibold" title={`${task.spawned_defects} defect(s) spawned from this task`}>
            {task.spawned_defects} defect{task.spawned_defects === 1 ? '' : 's'}
          </span>
        )}
        {failureSource && (
          <span className={`text-xs px-2 py-1 rounded-full font-semibold ${failureTone.pill}`} title={task.failure_detail ?? undefined}>
            {formatFailureOutcomeBadgeLabel(failureSource, pipelineBlocked)}
          </span>
        )}
        {blocked && !failureSource && (
          <span className="text-xs px-2 py-1 rounded-full font-semibold bg-orange-900/60 text-orange-300">
            blocked
          </span>
        )}
        {task.paused_at && (
          <span
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full font-semibold bg-yellow-900/60 text-yellow-300 border border-yellow-600/30"
            title={task.pause_reason ? `Paused: ${task.pause_reason}` : 'Paused — excluded from routing and dispatch'}
          >
            <PauseCircle className="w-3 h-3 shrink-0" />
            paused
          </span>
        )}
        {task.agent_name && (
          <span className="text-xs text-slate-400 truncate max-w-[120px]">{task.agent_name}</span>
        )}
        {task.active_instance_id && (
          <span className="text-xs px-2 py-1 rounded-full font-semibold bg-orange-900/60 text-orange-300" title={`Active instance #${task.active_instance_id}; open the task to confirm dispatch/start timestamps`}>
            instance active
          </span>
        )}
        {task.active_instance_id && (
          <span className="flex items-center gap-1 ml-auto min-h-[32px]">
            {/* Pause button — stops dispatch without cancelling */}
            <button
              onClick={async e => {
                e.stopPropagation();
                if (!window.confirm('Pause this task? It will stop receiving new dispatches until resumed.')) return;
                setPausing(true);
                try { await onPause(task.id); } finally { setPausing(false); }
              }}
              disabled={pausing}
              className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors border border-amber-500/30 hover:border-amber-400/50 rounded px-1.5 py-1 disabled:opacity-50"
              title="Pause this task"
            >
              <PauseCircle className="w-3 h-3" />
              {pausing ? '…' : 'Pause'}
            </button>
          </span>
        )}
      </div>

      {/* Workflow badge — hidden on mobile by default to save space */}
      {showSprint && task.sprint_name && task.sprint_id && (
        <div className="mb-2 hidden sm:block" onClick={e => e.stopPropagation()}>
          <a
            href={`/workflows/${task.sprint_id}`}
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-violet-900/50 text-violet-300 hover:bg-violet-800/60 hover:text-violet-200 transition-colors"
            title={formatSprintLabel({ id: task.sprint_id, name: task.sprint_name })}
          >
            🏃 {formatSprintLabel({ id: task.sprint_id, name: task.sprint_name })}
          </a>
        </div>
      )}

      {task.failure_detail && failureSource && (
        <div className={`mt-2 max-w-full min-w-0 overflow-hidden rounded-md px-2.5 py-2 text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${failureTone.panel} ${failureTone.text}`}>
          <span className="font-semibold">{pipelineBlocked ? 'Blocked' : 'Failure'}:</span> {task.failure_detail}
        </div>
      )}

      {/* Blockers section */}
      {blockers.length > 0 && (
        <div className="mt-2 min-w-0 max-w-full pt-2 border-t border-slate-700/60" onClick={e => e.stopPropagation()}>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Blocked by</p>
          <div className="min-w-0 max-w-full space-y-1">
            {blockers.map(b => (
              <div key={b.id} className="flex min-w-0 max-w-full items-center justify-between gap-1 group/blocker">
                <span className={`text-xs truncate ${b.status === 'done' ? 'text-slate-500 line-through' : 'text-slate-300'}`}>
                  {b.title}
                </span>
                <button
                  onClick={e => { e.stopPropagation(); onRemoveBlocker(task.id, b.id); }}
                  className="text-slate-600 hover:text-red-400 transition-colors shrink-0 opacity-0 group-hover/blocker:opacity-100"
                  title="Remove blocker"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Blocking section */}
      {blocking.length > 0 && (
        <div className="mt-2 min-w-0 max-w-full pt-2 border-t border-slate-700/60">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Blocking</p>
          <div className="min-w-0 max-w-full space-y-1">
            {blocking.map(b => (
              <span key={b.id} className="block text-xs text-slate-400 truncate">
                {b.title}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Link Task */}
      <div className="mt-2 pt-2 border-t border-slate-700/60" onClick={e => e.stopPropagation()}>
        <RelationshipPicker
          task={task}
          relationshipTypes={relationshipTypes}
          onLinkTask={onLinkTask}
        />
      </div>
    </div>
  );
}

// ── Draggable Task Card ───────────────────────────────────────────────────────

interface DraggableTaskCardProps extends TaskCardProps {
  /** When true, drag handle is shown and card is draggable */
  dragEnabled?: boolean;
}

export function DraggableTaskCard({ dragEnabled = true, ...props }: DraggableTaskCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `task-${props.task.id}`,
    data: { task: props.task },
    disabled: !dragEnabled,
  });

  const style = transform
    ? {
        transform: CSS.Translate.toString(transform),
        zIndex: isDragging ? 50 : undefined,
        opacity: isDragging ? 0 : undefined,
      }
    : isDragging
      ? {
          opacity: 0,
        }
      : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative min-w-0 max-w-full group/drag ${isDragging ? 'pointer-events-none' : ''}`}
      aria-hidden={isDragging ? true : undefined}
    >
      {dragEnabled && (
        <div
          {...listeners}
          {...attributes}
          className="absolute left-0 top-0 bottom-0 w-6 flex items-center justify-center cursor-grab active:cursor-grabbing opacity-0 group-hover/drag:opacity-100 transition-opacity z-10"
          title="Drag to move"
        >
          <GripVertical className="w-3.5 h-3.5 text-slate-500" />
        </div>
      )}
      <TaskCard {...props} />
    </div>
  );
}

// ── Board Column ──────────────────────────────────────────────────────────────

interface BoardColumnProps {
  col: ColumnDef;
  tasks: BoardTask[];
  allTasks: BoardTask[];
  onClickTask: (task: BoardTask) => void;
  relationshipTypes: TaskRelationshipTypeConfig[];
  onLinkTask: (taskId: number, targetTaskId: number, relationshipTypeKey: string) => Promise<void>;
  onRemoveBlocker: (taskId: number, blockerId: number) => Promise<void>;
  onPause: (taskId: number) => Promise<void>;
  showSprint?: boolean;
  /** Whether to show column header (hidden on mobile when tab bar is present) */
  showHeader?: boolean;
  /** Enable drag-and-drop on task cards */
  dragEnabled?: boolean;
  /** Whether this column is a valid drop target for the currently-dragged card */
  isDropTarget?: boolean;
  /** Whether this column is an invalid (disabled) drop target */
  isInvalidTarget?: boolean;
  /** Override the droppable ID (default: column-{col.key}). Must be unique within a DndContext. */
  droppableId?: string;
  outcomeMap: TaskOutcomeMetaMap;
}

export function BoardColumn({
  col, tasks: colTasks, allTasks, onClickTask,
  relationshipTypes, onLinkTask, onRemoveBlocker, onPause,
  showSprint = false, showHeader = true,
  dragEnabled = false, isDropTarget = false, isInvalidTarget = false,
  droppableId,
  outcomeMap,
}: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: droppableId ?? `column-${col.key}`,
    data: { status: col.key },
    disabled: isInvalidTarget,
  });

  const groups = groupByJob(colTasks);
  const groupKeys = Object.keys(groups).sort((a, b) =>
    a === '__none__' ? 1 : b === '__none__' ? -1 : a.localeCompare(b)
  );

  // Visual feedback classes
  const dropHighlight = isOver && isDropTarget
    ? 'ring-2 ring-amber-400/60 bg-amber-950/20'
    : isDropTarget
      ? 'ring-1 ring-amber-400/30'
      : isInvalidTarget
        ? 'opacity-40'
        : '';

  const CardComponent = dragEnabled ? DraggableTaskCard : TaskCard;

  return (
    <div ref={setNodeRef} className={`min-w-0 max-w-full bg-slate-900 border border-slate-800 rounded-xl flex flex-col md:h-full transition-all duration-150 ${dropHighlight}`}>
      {/* Column header */}
      {showHeader && (
        <div className="flex min-w-0 items-center justify-between px-4 py-3 border-b border-slate-800">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-white font-semibold text-sm">{col.label}</span>
            <span className="text-xs text-slate-500 bg-slate-800 rounded-full px-2 py-0.5">{colTasks.length}</span>
          </div>
        </div>
      )}

      {/* Cards */}
      <div className="min-w-0 max-w-full md:flex-1 p-3 space-y-4 md:overflow-y-auto">
        {colTasks.length === 0 && (
          <p className={`text-xs text-center mt-4 ${isOver && isDropTarget ? 'text-amber-400' : 'text-slate-600'}`}>
            {isOver && isDropTarget ? 'Drop here' : 'No tasks'}
          </p>
        )}
        {groupKeys.map(jobKey => (
          <div key={jobKey} className="min-w-0 max-w-full">
            {jobKey !== '__none__' && (
              <p className="text-xs font-semibold text-amber-400/70 uppercase tracking-wide mb-1.5 px-0.5">
                {jobKey}
              </p>
            )}
            <div className="min-w-0 max-w-full space-y-2">
              {groups[jobKey].map(task => (
                <CardComponent
                  key={task.id}
                  task={task}
                  allTasks={allTasks}
                  onClick={() => onClickTask(task)}
                  relationshipTypes={relationshipTypes}
                  onLinkTask={onLinkTask}
                  onRemoveBlocker={onRemoveBlocker}
                  onPause={onPause}
                  showSprint={showSprint}
                  outcomeMap={outcomeMap}
                  dragEnabled={dragEnabled}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}
