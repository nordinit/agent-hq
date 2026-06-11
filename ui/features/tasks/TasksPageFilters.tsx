'use client';

import { useEffect, useRef, useState } from 'react';
import { formatSprintLabel } from '@/lib/sprintLabel';
import { Activity, Check, ChevronDown, Plus, Search, X } from 'lucide-react';
import type { Project, Sprint, TaskTypeOption } from '@/features/tasks/useTasksPageState';

interface MultiSprintFilterProps {
  sprints: Sprint[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
}

export function MultiSprintFilter({ sprints, selectedIds, onChange }: MultiSprintFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (id: number) => {
    onChange(selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id]);
  };

  const clearAll = () => onChange([]);

  const label =
    selectedIds.length === 0
      ? 'All workflows'
      : selectedIds.length === 1
        ? sprints.find(s => s.id === selectedIds[0])?.name ?? '1 workflow'
        : `${selectedIds.length} workflows`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 w-full bg-slate-800 border border-slate-600 rounded-lg pl-3 pr-2 py-1.5 md:py-2 text-sm text-left focus:outline-none focus:border-amber-400 transition-colors hover:border-slate-500"
      >
        <span className={`flex-1 truncate ${selectedIds.length === 0 ? 'text-slate-400' : 'text-white'}`}>
          {label}
        </span>
        {selectedIds.length > 0 && (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              clearAll();
            }}
            className="flex-shrink-0 p-0.5 rounded hover:bg-slate-600 text-slate-400 hover:text-white transition-colors"
            aria-label="Clear workflow filter"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        <ChevronDown className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[220px] max-h-64 overflow-y-auto bg-slate-800 border border-slate-600 rounded-lg shadow-xl">
          {sprints.length === 0 ? (
            <div className="px-3 py-2 text-sm text-slate-500 italic">No workflows available</div>
          ) : (
            <>
              {selectedIds.length > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="w-full px-3 py-2 text-xs text-slate-400 hover:text-white hover:bg-slate-700/50 text-left border-b border-slate-700 transition-colors"
                >
                  Clear all ({selectedIds.length} selected)
                </button>
              )}
              {sprints.map(sprint => {
                const selected = selectedIds.includes(sprint.id);
                return (
                  <button
                    key={sprint.id}
                    type="button"
                    onClick={() => toggle(sprint.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                      selected
                        ? 'bg-amber-900/30 text-amber-200 hover:bg-amber-900/50'
                        : 'text-slate-300 hover:bg-slate-700/50 hover:text-white'
                    }`}
                  >
                    <span className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center ${
                      selected ? 'bg-amber-500 border-amber-500' : 'border-slate-500'
                    }`}>
                      {selected && <Check className="w-3 h-3 text-black" />}
                    </span>
                    <span className="truncate flex-1">{formatSprintLabel(sprint)}</span>
                    <span className="text-[10px] text-slate-500 flex-shrink-0">{sprint.status}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}

      {selectedIds.length > 1 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {selectedIds.map(id => {
            const sprint = sprints.find(s => s.id === id);
            if (!sprint) return null;
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-amber-900/40 text-amber-300 border border-amber-700/50 rounded-full"
              >
                <span className="truncate max-w-[120px]">{formatSprintLabel(sprint)}</span>
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  className="hover:text-white transition-colors"
                  aria-label={`Remove ${formatSprintLabel(sprint)}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface TaskTypeFilterProps {
  options: TaskTypeOption[];
  selectedValue: string;
  onChange: (value: string) => void;
}

export function TaskTypeFilter({ options, selectedValue, onChange }: TaskTypeFilterProps) {
  return (
    <div className="relative min-w-[180px]">
      <select
        className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg pl-3 pr-8 py-1.5 md:py-2 text-sm text-white focus:outline-none focus:border-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
        value={selectedValue}
        onChange={e => onChange(e.target.value)}
        disabled={options.length === 0}
        aria-label="Filter by task type"
      >
        <option value="">All task types</option>
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <ChevronDown className="absolute right-2 top-2.5 h-4 w-4 text-slate-400 pointer-events-none" />
    </div>
  );
}

interface TasksPageToolbarProps {
  loading: boolean;
  totalTasks: number;
  tasksCount: number;
  visibleTaskCount: number;
  isFiltered: boolean;
  isBackgroundLoading: boolean;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  activeInstanceOnly: boolean;
  onActiveInstanceOnlyChange: (value: boolean) => void;
  onCreateTask: () => void;
  canCreateTask: boolean;
  projects: Project[];
  selectedProject: number | null;
  onProjectChange: (projectId: number | null) => void;
}

export function TasksPageToolbar({
  loading,
  totalTasks,
  tasksCount,
  visibleTaskCount,
  isFiltered,
  isBackgroundLoading,
  searchQuery,
  onSearchQueryChange,
  activeInstanceOnly,
  onActiveInstanceOnlyChange,
  onCreateTask,
  canCreateTask,
  projects,
  selectedProject,
  onProjectChange,
}: TasksPageToolbarProps) {
  return (
    <div className="flex flex-col gap-2 mb-2 md:mb-6 flex-shrink-0 md:flex-row md:items-center md:justify-between">
      <h1 className="text-lg md:text-xl font-bold text-white shrink-0">Tasks
        {!loading && totalTasks > 0 && (
          <span className="ml-2 text-xs text-slate-500 font-normal hidden sm:inline">
            {isFiltered
              ? `(${visibleTaskCount} shown of ${tasksCount} loaded, ${totalTasks} total)`
              : `(${tasksCount} of ${totalTasks})`}
            {isBackgroundLoading ? ' • loading more…' : ''}
          </span>
        )}
      </h1>

      <div className="flex items-center gap-2 min-w-0 overflow-x-auto scrollbar-none md:flex-1 md:overflow-visible md:gap-3">
        <div className="relative w-28 shrink-0 sm:w-auto sm:min-w-[200px] md:flex-1">
          <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Search…"
            className="w-full bg-slate-800 border border-slate-600 rounded-lg pl-9 pr-8 py-1.5 md:py-2 text-white text-sm focus:outline-none focus:border-amber-400 placeholder-slate-500"
            value={searchQuery}
            onChange={e => onSearchQueryChange(e.target.value)}
          />
          {searchQuery && (
            <button
              onClick={() => onSearchQueryChange('')}
              className="absolute right-2 top-2 text-slate-400 hover:text-white transition-colors"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <button
          onClick={() => onActiveInstanceOnlyChange(!activeInstanceOnly)}
          title={activeInstanceOnly ? 'Show all tasks' : 'Show tasks with live active instances'}
          className={`flex-shrink-0 inline-flex items-center gap-1.5 px-2 py-1.5 md:px-3 md:py-2 text-xs rounded-lg border transition-colors font-medium whitespace-nowrap ${
            activeInstanceOnly
              ? 'bg-orange-900/60 border-orange-500 text-orange-200'
              : 'bg-transparent border-slate-600 text-slate-400 hover:border-slate-400 hover:text-slate-300'
          }`}
        >
          <Activity className="w-3.5 h-3.5" />
          Live instances
        </button>

        <button
          onClick={onCreateTask}
          disabled={!canCreateTask}
          className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 md:py-2 text-xs md:text-sm font-semibold bg-amber-500 hover:bg-amber-400 text-black rounded-lg transition-colors whitespace-nowrap disabled:opacity-50"
        >
          <Plus className="w-3.5 h-3.5 md:w-4 md:h-4" />
          <span className="hidden sm:inline">Create Task</span>
          <span className="sm:hidden">New</span>
        </button>

        <div className="relative min-w-[120px] sm:min-w-[200px] md:min-w-[240px]">
          <select
            className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg pl-3 pr-8 py-1.5 md:py-2 text-white text-sm focus:outline-none focus:border-amber-400"
            value={selectedProject ?? ''}
            onChange={e => onProjectChange(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">All projects</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
        </div>
      </div>
    </div>
  );
}
