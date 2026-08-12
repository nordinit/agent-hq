'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { GripVertical, Plus } from 'lucide-react';
import {
  DndContext,
  DragStartEvent,
  DragEndEvent,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  rectIntersection,
  CollisionDetection,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  BoardColumn,
  BoardTask,
  ColumnDef,
  TaskCard,
} from '@/features/tasks/TaskBoardComponents';
import { api, type TaskRelationshipTypeConfig } from '@/lib/api';
import { getDefaultVisibleTaskColumns, getTaskBoardColumns, unionBoardColumns } from '@/lib/taskStatuses';
import { useTaskStatuses } from '@/lib/useTaskStatuses';
import { useWorkflowMetadata } from '@/lib/useWorkflowMetadata';

export interface TaskBoardSection {
  key: string;
  title: string;
  tasks: BoardTask[];
  sprintType?: string | null;
  tone?: 'default' | 'muted';
  statusLabel?: string;
  /** True when the sprint is active but has tasks outside the currently-loaded page */
  hasUnloadedTasks?: boolean;
  /** True when this section is in the process of loading tasks (IntersectionObserver triggered) */
  isLoading?: boolean;
}

interface TaskBoardProps {
  tasks: BoardTask[];
  storageKey: string;
  sprintId?: number | null;
  workflowTypes?: string[];
  onTaskClick: (task: BoardTask) => void;
  onLinkTask: (taskId: number, targetTaskId: number, relationshipTypeKey: string) => Promise<void>;
  onRemoveBlocker: (taskId: number, blockerId: number) => Promise<void>;
  onPause: (taskId: number) => Promise<void>;
  onStatusChange?: (taskId: number, newStatus: string) => Promise<void>;
  showSprint?: boolean;
  sections?: TaskBoardSection[];
  columnsButtonAlign?: 'left' | 'right';
  /** Called when a section key enters the viewport (for lazy loading sprint tasks) */
  onSectionVisible?: (sectionKey: string) => void;
  /**
   * When true (search/filter is active), columns and sprint sections with zero matching
   * tasks are hidden. Columns/sections reappear as soon as they have at least one match.
   * Has no effect when false/undefined (all columns visible as normal).
   */
  isFiltered?: boolean;
}

interface StoredColumnPreferences {
  visibleCols?: unknown;
  visible?: unknown;
  columnOrder?: unknown;
  order?: unknown;
}

interface ColumnCatalog {
  scopeKey: string;
  label: string;
  columns: ColumnDef[];
  defaultVisible: string[];
  relationshipTypes: TaskRelationshipTypeConfig[];
}

interface ActiveColumnConfig {
  scopeKey: string;
  columnKey: string;
}

const DEFAULT_COLUMN_SCOPE = '__default__';

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function columnStorageKey(storageKey: string, scopeKey: string): string {
  if (scopeKey === DEFAULT_COLUMN_SCOPE || scopeKey === 'dev') return storageKey;
  return `${storageKey}:workflow:${scopeKey}`;
}

function workflowLabel(scopeKey: string): string {
  if (scopeKey === DEFAULT_COLUMN_SCOPE) return 'Workflow';
  return scopeKey
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function uniqueValidKeys(keys: unknown, allKeys: string[]): string[] {
  if (!Array.isArray(keys)) return [];
  const seen = new Set<string>();
  const valid = new Set(allKeys);
  const result: string[] = [];
  for (const key of keys) {
    if (typeof key !== 'string' || !valid.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function mergeColumnOrder(storedOrder: string[], allKeys: string[]): string[] {
  return [
    ...storedOrder.filter(key => allKeys.includes(key)),
    ...allKeys.filter(key => !storedOrder.includes(key)),
  ];
}

function resolveInitialColumnPreferences(
  stored: string | null,
  allKeys: string[],
  defaultVisible: string[],
): { visibleCols: string[]; columnOrder: string[] } {
  const fallbackVisible = defaultVisible.filter(key => allKeys.includes(key));
  if (!stored) {
    return { visibleCols: fallbackVisible, columnOrder: allKeys };
  }

  try {
    const parsed = JSON.parse(stored) as unknown;
    if (Array.isArray(parsed)) {
      const storedVisible = uniqueValidKeys(parsed, allKeys);
      const newVisible = allKeys.filter(key => !storedVisible.includes(key) && fallbackVisible.includes(key));
      const visibleCols = [...storedVisible, ...newVisible];
      return {
        visibleCols: visibleCols.length > 0 ? visibleCols : fallbackVisible,
        columnOrder: mergeColumnOrder(storedVisible, allKeys),
      };
    }

    if (parsed && typeof parsed === 'object') {
      const prefs = parsed as StoredColumnPreferences;
      const storedOrder = uniqueValidKeys(prefs.columnOrder ?? prefs.order, allKeys);
      const storedVisible = uniqueValidKeys(prefs.visibleCols ?? prefs.visible, allKeys);
      const knownKeys = new Set([...storedOrder, ...storedVisible]);
      const newVisible = allKeys.filter(key => !knownKeys.has(key) && fallbackVisible.includes(key));
      const visibleCols = [...storedVisible, ...newVisible];
      return {
        visibleCols: visibleCols.length > 0 ? visibleCols : fallbackVisible,
        columnOrder: mergeColumnOrder(storedOrder, allKeys),
      };
    }
  } catch {
    // Ignore malformed local preferences and use catalog defaults.
  }

  return { visibleCols: fallbackVisible, columnOrder: allKeys };
}

function orderColumns(columns: ColumnDef[], columnOrder: string[]): ColumnDef[] {
  const byKey = new Map(columns.map(column => [column.key, column]));
  const orderedKeys = mergeColumnOrder(columnOrder, columns.map(column => column.key));
  return orderedKeys
    .map(key => byKey.get(key))
    .filter((column): column is ColumnDef => Boolean(column));
}

interface SortableColumnToggleProps {
  scopeKey: string;
  column: ColumnDef;
  checked: boolean;
  onToggle: () => void;
}

function SortableColumnToggle({ scopeKey, column, checked, onToggle }: SortableColumnToggleProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `column-config-${scopeKey}-${column.key}`,
    data: { type: 'column-config', scopeKey, columnKey: column.key },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors ${
        isDragging ? 'bg-slate-700/80 opacity-70' : 'hover:bg-slate-700/40'
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-700 hover:text-slate-300 cursor-grab active:cursor-grabbing"
        aria-label={`Reorder ${column.label}`}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="accent-amber-400"
        />
        <span className={`truncate ${checked ? 'text-white' : 'text-slate-400'}`}>{column.label}</span>
      </label>
    </div>
  );
}

export function TaskBoard({
  tasks,
  storageKey,
  sprintId = null,
  workflowTypes = [],
  onTaskClick,
  onLinkTask,
  onRemoveBlocker,
  onPause,
  onStatusChange,
  showSprint = false,
  sections,
  columnsButtonAlign = 'right',
  onSectionVisible,
  isFiltered = false,
}: TaskBoardProps) {
  const normalizedWorkflowTypes = useMemo(() => uniqueStrings(workflowTypes), [workflowTypes]);
  const singleWorkflowType = normalizedWorkflowTypes.length === 1 ? normalizedWorkflowTypes[0] : null;
  const {
    allColumns: ALL_COLUMNS,
    defaultVisible: DEFAULT_VISIBLE,
    loading: statusesLoading,
  } = useTaskStatuses(sprintId, { sprintType: sprintId ? null : singleWorkflowType });
  const { metadata: boardWorkflowMetadata, outcomeMap } = useWorkflowMetadata(sprintId ?? null, {
    sprintType: sprintId ? null : singleWorkflowType,
  });

  const [mobileCol, setMobileCol] = useState<string>('');
  const [visibleColsByScope, setVisibleColsByScope] = useState<Record<string, string[]>>({});
  const [columnOrderByScope, setColumnOrderByScope] = useState<Record<string, string[]>>({});
  const [initializedCatalogSignature, setInitializedCatalogSignature] = useState('');
  const [showColConfig, setShowColConfig] = useState(false);
  const [workflowCatalogs, setWorkflowCatalogs] = useState<Record<string, ColumnCatalog>>({});
  const [workflowCatalogsLoading, setWorkflowCatalogsLoading] = useState(false);

  useEffect(() => {
    if (sprintId || normalizedWorkflowTypes.length <= 1) {
      setWorkflowCatalogs({});
      setWorkflowCatalogsLoading(false);
      return;
    }

    let cancelled = false;
    setWorkflowCatalogsLoading(true);
    Promise.all(
      normalizedWorkflowTypes.map(async workflowType => {
        const metadata = await api.getWorkflowMetadata({ sprint_type: workflowType });
        return [
          workflowType,
          {
            scopeKey: workflowType,
            label: workflowLabel(workflowType),
            columns: getTaskBoardColumns(metadata.statuses),
            defaultVisible: getDefaultVisibleTaskColumns(metadata.statuses),
            relationshipTypes: metadata.relationship_types,
          } satisfies ColumnCatalog,
        ] as const;
      }),
    )
      .then(entries => {
        if (!cancelled) setWorkflowCatalogs(Object.fromEntries(entries));
      })
      .catch(err => {
        console.warn('[tasks] Failed to load workflow column catalogs:', err);
        if (!cancelled) setWorkflowCatalogs({});
      })
      .finally(() => {
        if (!cancelled) setWorkflowCatalogsLoading(false);
      });

    return () => { cancelled = true; };
  }, [sprintId, normalizedWorkflowTypes]);

  const columnCatalogs = useMemo<ColumnCatalog[]>(() => {
    if (!sprintId && normalizedWorkflowTypes.length > 1) {
      return normalizedWorkflowTypes
        .map(workflowType => workflowCatalogs[workflowType])
        .filter((catalog): catalog is ColumnCatalog => Boolean(catalog && catalog.columns.length > 0));
    }

    const scopeKey = singleWorkflowType ?? DEFAULT_COLUMN_SCOPE;
    return [{
      scopeKey,
      label: workflowLabel(scopeKey),
      columns: ALL_COLUMNS,
      defaultVisible: DEFAULT_VISIBLE,
      relationshipTypes: boardWorkflowMetadata.relationship_types,
    }];
  }, [ALL_COLUMNS, DEFAULT_VISIBLE, boardWorkflowMetadata.relationship_types, normalizedWorkflowTypes, singleWorkflowType, sprintId, workflowCatalogs]);

  const catalogByScope = useMemo(
    () => new Map(columnCatalogs.map(catalog => [catalog.scopeKey, catalog])),
    [columnCatalogs],
  );

  const fallbackScopeKey = columnCatalogs[0]?.scopeKey ?? DEFAULT_COLUMN_SCOPE;
  const columnsReady = !statusesLoading && !workflowCatalogsLoading && columnCatalogs.length > 0 && columnCatalogs.every(catalog => catalog.columns.length > 0);
  const catalogSignature = useMemo(
    () => columnCatalogs.map(catalog => `${catalog.scopeKey}:${catalog.columns.map(column => column.key).join(',')}`).join('|'),
    [columnCatalogs],
  );

  // Once status catalog loads from API, merge stored prefs with the full catalog.
  // New statuses (not yet in localStorage) are added as visible by default.
  useEffect(() => {
    if (!columnsReady) return;

    const nextVisible: Record<string, string[]> = {};
    const nextOrder: Record<string, string[]> = {};

    for (const catalog of columnCatalogs) {
      const allKeys = catalog.columns.map(c => c.key);
      let initialPrefs: { visibleCols: string[]; columnOrder: string[] } = {
        visibleCols: catalog.defaultVisible.filter(key => allKeys.includes(key)),
        columnOrder: allKeys,
      };

      if (typeof window !== 'undefined') {
        const stored = localStorage.getItem(columnStorageKey(storageKey, catalog.scopeKey));
        initialPrefs = resolveInitialColumnPreferences(stored, allKeys, catalog.defaultVisible);
      }

      nextVisible[catalog.scopeKey] = initialPrefs.visibleCols;
      nextOrder[catalog.scopeKey] = initialPrefs.columnOrder;
    }

    setVisibleColsByScope(nextVisible);
    setColumnOrderByScope(nextOrder);
    setInitializedCatalogSignature(catalogSignature);
  }, [catalogSignature, columnCatalogs, columnsReady, storageKey]);

  useEffect(() => {
    if (initializedCatalogSignature === catalogSignature && catalogSignature && typeof window !== 'undefined') {
      for (const catalog of columnCatalogs) {
        localStorage.setItem(
          columnStorageKey(storageKey, catalog.scopeKey),
          JSON.stringify({
            visibleCols: visibleColsByScope[catalog.scopeKey] ?? [],
            columnOrder: columnOrderByScope[catalog.scopeKey] ?? [],
          }),
        );
      }
    }
  }, [storageKey, visibleColsByScope, columnOrderByScope, initializedCatalogSignature, catalogSignature, columnCatalogs]);

  const orderedColumnsByScope = useMemo(() => {
    return Object.fromEntries(columnCatalogs.map(catalog => [
      catalog.scopeKey,
      orderColumns(catalog.columns, columnOrderByScope[catalog.scopeKey] ?? []),
    ])) as Record<string, ColumnDef[]>;
  }, [columnCatalogs, columnOrderByScope]);

  const activeColumnsByScope = useMemo(() => {
    return Object.fromEntries(columnCatalogs.map(catalog => {
      const ordered = orderedColumnsByScope[catalog.scopeKey] ?? [];
      const visible = visibleColsByScope[catalog.scopeKey] ?? [];
      return [catalog.scopeKey, ordered.filter(c => visible.includes(c.key))];
    })) as Record<string, ColumnDef[]>;
  }, [columnCatalogs, orderedColumnsByScope, visibleColsByScope]);

  const orderedColumns = orderedColumnsByScope[fallbackScopeKey] ?? [];
  const activeColumns = activeColumnsByScope[fallbackScopeKey] ?? [];

  const scopeForSection = useCallback((section?: TaskBoardSection) => {
    const sectionType = section?.sprintType ?? null;
    if (sectionType && catalogByScope.has(sectionType)) return sectionType;
    return fallbackScopeKey;
  }, [catalogByScope, fallbackScopeKey]);

  const activeColumnsForSection = useCallback((section?: TaskBoardSection) => {
    return activeColumnsByScope[scopeForSection(section)] ?? activeColumns;
  }, [activeColumns, activeColumnsByScope, scopeForSection]);

  useEffect(() => {
    if (activeColumns.length === 0) return;
    if (!activeColumns.some(c => c.key === mobileCol)) {
      setMobileCol(activeColumns[0].key);
    }
  }, [activeColumns, mobileCol]);

  // ── IntersectionObserver: fire onSectionVisible when sprint section enters viewport ──
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  const firedSections = useRef<Set<string>>(new Set());

  const registerSectionRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) {
      sectionRefs.current.set(key, el);
    } else {
      sectionRefs.current.delete(key);
    }
  }, []);

  useEffect(() => {
    if (!onSectionVisible || !sections) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const key = (entry.target as HTMLElement).dataset.sectionKey;
          if (!key || firedSections.current.has(key)) continue;
          firedSections.current.add(key);
          onSectionVisible(key);
        }
      },
      { rootMargin: '200px 0px', threshold: 0 }
    );

    for (const [, el] of sectionRefs.current) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [onSectionVisible, sections]);

  // ── Drag-and-drop state ──────────────────────────────────────────────────
  const [activeTask, setActiveTask] = useState<BoardTask | null>(null);
  const [activeColumnConfig, setActiveColumnConfig] = useState<ActiveColumnConfig | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);
  // Optimistic status overrides: taskId → newStatus. Applied immediately on drop,
  // cleared when the parent re-renders with updated task data from the API.
  const [optimisticMoves, setOptimisticMoves] = useState<Map<number, string>>(new Map());


  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const columnKey = event.active.data.current?.columnKey as string | undefined;
    const scopeKey = event.active.data.current?.scopeKey as string | undefined;
    if (event.active.data.current?.type === 'column-config' && columnKey) {
      setActiveColumnConfig({ scopeKey: scopeKey ?? fallbackScopeKey, columnKey });
      setActiveTask(null);
      setDragError(null);
      return;
    }
    const task = event.active.data.current?.task as BoardTask | undefined;
    if (task) setActiveTask(task);
    setDragError(null);
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const columnConfig = activeColumnConfig;
      if (columnConfig) {
        setActiveColumnConfig(null);
        const overColumnKey = event.over?.data.current?.columnKey as string | undefined;
        const overScopeKey = event.over?.data.current?.scopeKey as string | undefined;
        if (!overColumnKey || overColumnKey === columnConfig.columnKey || overScopeKey !== columnConfig.scopeKey) return;
        const catalog = catalogByScope.get(columnConfig.scopeKey);
        if (!catalog) return;
        setColumnOrderByScope(prev => {
          const previousOrder = prev[columnConfig.scopeKey] ?? [];
          const nextOrder = mergeColumnOrder(previousOrder, catalog.columns.map(column => column.key));
          const oldIndex = nextOrder.indexOf(columnConfig.columnKey);
          const newIndex = nextOrder.indexOf(overColumnKey);
          if (oldIndex < 0 || newIndex < 0) return prev;
          return { ...prev, [columnConfig.scopeKey]: arrayMove(nextOrder, oldIndex, newIndex) };
        });
        return;
      }

      const task = activeTask;
      setActiveTask(null);

      if (!task || !event.over || !onStatusChange) return;

      const targetStatus = event.over.data.current?.status as string | undefined;
      if (!targetStatus || targetStatus === task.status) return;

      // Apply optimistic UI immediately
      setOptimisticMoves(prev => new Map(prev).set(task.id, targetStatus));

      try {
        await onStatusChange(task.id, targetStatus);
      } catch (err) {
        // Revert optimistic move on failure
        setOptimisticMoves(prev => {
          const next = new Map(prev);
          next.delete(task.id);
          return next;
        });
        setDragError(err instanceof Error ? err.message : 'Status update failed');
        setTimeout(() => setDragError(null), 3000);
      }
    },
    [activeColumnConfig, activeTask, catalogByScope, onStatusChange],
  );

  const handleDragCancel = useCallback(() => {
    setActiveTask(null);
    setActiveColumnConfig(null);
  }, []);

  // Clear optimistic overrides when the upstream task list catches up
  useEffect(() => {
    if (optimisticMoves.size === 0) return;
    setOptimisticMoves(prev => {
      const next = new Map(prev);
      let changed = false;
      for (const [taskId, expectedStatus] of prev) {
        const t = tasks.find(t => t.id === taskId);
        // Clear if task now has the expected status, or the task is gone
        if (!t || t.status === expectedStatus) {
          next.delete(taskId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tasks, optimisticMoves]);

  // Build optimistically-patched task list
  const effectiveTasks = useMemo(() => {
    if (optimisticMoves.size === 0) return tasks;
    return tasks.map(t => {
      const override = optimisticMoves.get(t.id);
      return override ? { ...t, status: override } : t;
    });
  }, [tasks, optimisticMoves]);

  const dragEnabled = !!onStatusChange;

  // Custom collision detection: prefer pointerWithin, fall back to rectIntersection
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      const result = pointerWithin(args);
      return result.length > 0 ? result : rectIntersection(args);
    },
    [],
  );

  const toggleCol = (scopeKey: string, key: string) => {
    const catalog = catalogByScope.get(scopeKey);
    if (!catalog) return;
    setVisibleColsByScope(prev => {
      const current = prev[scopeKey] ?? [];
      const next = current.includes(key) ? current.filter(k => k !== key) : [...current, key];
      return next.length > 0 ? { ...prev, [scopeKey]: next } : prev;
    });
    setColumnOrderByScope(prev => {
      const current = prev[scopeKey] ?? [];
      return { ...prev, [scopeKey]: mergeColumnOrder(current, catalog.columns.map(column => column.key)) };
    });
  };

  // Counted straight off the tasks rather than off one scope's column list: a status defined by
  // only one workflow type still needs its chip badge on mobile.
  const columnCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of effectiveTasks) {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
    }
    return counts;
  }, [effectiveTasks]);

  // Apply optimistic moves to section task lists.
  // Sections with zero loaded tasks are kept — they may have tasks outside the current page.
  const effectiveSections = useMemo(() => {
    if (!sections || sections.length === 0) return null;
    if (optimisticMoves.size === 0) return sections;
    return sections.map(s => ({
      ...s,
      tasks: s.tasks.map(t => {
        const override = optimisticMoves.get(t.id);
        return override ? { ...t, status: override } : t;
      }),
    }));
  }, [sections, optimisticMoves]);

  // When a filter is active, derive a subset of activeColumns that actually contain tasks.
  // This drives both desktop and mobile views: empty columns disappear instantly while the
  // filter is set and reappear the moment they have at least one matching task.
  const filterVisibleColumns = useCallback((columns: ColumnDef[], section?: TaskBoardSection) => {
    if (!isFiltered) return columns;
    return columns.filter(c => {
      if (section) return section.tasks.some(t => t.status === c.key);
      if (effectiveSections && effectiveSections.length > 0) {
        return effectiveSections.some(s => s.tasks.some(t => t.status === c.key));
      }
      return effectiveTasks.some(t => t.status === c.key);
    });
  }, [isFiltered, effectiveSections, effectiveTasks]);

  const visibleColumns = useMemo(
    () => filterVisibleColumns(activeColumns),
    [activeColumns, filterVisibleColumns],
  );

  /**
   * Mobile shows one column at a time and no section headers, so its chip row has to span every
   * workflow type on the board rather than one of them.
   *
   * Desktop renders each section against its own catalogue, so a status defined by only one
   * workflow type still appears under that workflow. Mobile flattens the board and used to read
   * columns from `activeColumns` — the *first* catalogue alone. Any status the first type did not
   * define was unreachable: no chip to tap, and the sync effect below actively reset the
   * selection away from it. A project mixing workflow types would silently lose whichever
   * statuses the winning type happened not to share, and which type won was arbitrary.
   *
   * Ordering is first-seen across catalogues: the shared pipeline keeps the order the leading
   * type defines, and statuses unique to later types follow. There is no cross-type ordering
   * authority to appeal to, so stable and predictable beats clever.
   */
  const mobileColumns = useMemo(() => {
    const union = unionBoardColumns(
      columnCatalogs.map(catalog => activeColumnsByScope[catalog.scopeKey] ?? []),
    );
    return union.length > 0 ? union : activeColumns;
  }, [activeColumns, activeColumnsByScope, columnCatalogs]);

  const visibleMobileColumns = useMemo(
    () => filterVisibleColumns(mobileColumns),
    [filterVisibleColumns, mobileColumns],
  );

  // Keep mobile selected column in sync when it becomes empty during filtering.
  useEffect(() => {
    if (visibleMobileColumns.length === 0) return;
    if (!visibleMobileColumns.some(c => c.key === mobileCol)) {
      setMobileCol(visibleMobileColumns[0].key);
    }
  }, [visibleMobileColumns, mobileCol]);

  const desktopSections = effectiveSections;

  const isDragging = !!activeTask;

  const relationshipTypesForSection = useCallback((section?: TaskBoardSection): TaskRelationshipTypeConfig[] => {
    if (section?.sprintType) return workflowCatalogs[section.sprintType]?.relationshipTypes ?? boardWorkflowMetadata.relationship_types;
    return catalogByScope.get(fallbackScopeKey)?.relationshipTypes ?? boardWorkflowMetadata.relationship_types;
  }, [boardWorkflowMetadata.relationship_types, catalogByScope, fallbackScopeKey, workflowCatalogs]);

  const renderColumn = (col: ColumnDef, colTasks: BoardTask[], showHeader = true, section?: TaskBoardSection) => (
    <BoardColumn
      col={col}
      tasks={colTasks}
      allTasks={effectiveTasks}
      onClickTask={onTaskClick}
      relationshipTypes={relationshipTypesForSection(section)}
      onLinkTask={onLinkTask}
      onRemoveBlocker={onRemoveBlocker}
      onPause={onPause}
      showSprint={showSprint}
      showHeader={showHeader}
      dragEnabled={dragEnabled}
      isDropTarget={isDragging && col.key !== activeTask?.status}
      isInvalidTarget={false}
      droppableId={section ? `column-${section.key}-${col.key}` : `column-${col.key}`}
      outcomeMap={outcomeMap}
    />
  );

  const boardContent = (
    <div className="flex flex-col md:flex-1 md:min-h-0 md:overflow-hidden">
      {/* Drag error toast */}
      {dragError && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-red-900/90 border border-red-700 text-red-200 text-sm px-4 py-2 rounded-lg shadow-xl animate-in fade-in slide-in-from-top-2">
          {dragError}
        </div>
      )}

      <div className={`flex items-center mb-3 flex-shrink-0 ${columnsButtonAlign === 'left' ? 'justify-start' : 'justify-end'}`}>
        <div className="relative">
          <button
            onClick={() => setShowColConfig(o => !o)}
            className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-slate-400 text-sm hover:text-white hover:border-amber-400/50 transition-colors"
            title="Configure visible columns"
          >
            Columns
          </button>
          {showColConfig && (
            <div className="absolute right-0 top-full mt-1 z-50 max-h-[70vh] w-64 overflow-y-auto rounded-lg border border-slate-600 bg-slate-800 p-3 shadow-xl">
              <p className="text-xs text-slate-400 font-semibold uppercase mb-2">Visible Columns</p>
              <div className="space-y-3">
                {columnCatalogs.map(catalog => (
                  <div key={catalog.scopeKey}>
                    {columnCatalogs.length > 1 && (
                      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{catalog.label}</p>
                    )}
                    <SortableContext items={(orderedColumnsByScope[catalog.scopeKey] ?? []).map(c => `column-config-${catalog.scopeKey}-${c.key}`)} strategy={verticalListSortingStrategy}>
                      <div className="space-y-1">
                        {(orderedColumnsByScope[catalog.scopeKey] ?? []).map(c => (
                          <SortableColumnToggle
                            key={`${catalog.scopeKey}:${c.key}`}
                            scopeKey={catalog.scopeKey}
                            column={c}
                            checked={(visibleColsByScope[catalog.scopeKey] ?? []).includes(c.key)}
                            onToggle={() => toggleCol(catalog.scopeKey, c.key)}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </div>
                ))}
                </div>
            </div>
          )}
        </div>
      </div>

      <div className="md:hidden mb-4 flex flex-col">
        <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none flex-shrink-0 min-h-[44px] items-center">
          {visibleMobileColumns.map(col => (
            <button
              key={col.key}
              onClick={() => setMobileCol(col.key)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors shrink-0 min-h-[36px] ${
                mobileCol === col.key
                  ? 'bg-amber-500 text-black'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              {col.label}
              {(columnCounts[col.key] ?? 0) > 0 && (
                <span className={`text-xs rounded-full px-1.5 py-0.5 font-semibold ${
                  mobileCol === col.key ? 'bg-black/20 text-black' : 'bg-slate-700 text-slate-300'
                }`}>
                  {columnCounts[col.key]}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="mt-3 mb-2">
          <h2 className="text-base font-semibold text-white">
            {visibleMobileColumns.find(c => c.key === mobileCol)?.label ?? mobileCol}
          </h2>
        </div>

        {visibleMobileColumns.find(c => c.key === mobileCol) && renderColumn(
          visibleMobileColumns.find(c => c.key === mobileCol)!,
          effectiveTasks.filter(t => t.status === mobileCol),
          false,
        )}
      </div>

      {desktopSections ? (
        <div className="hidden md:block overflow-auto pb-4 flex-1 min-h-0">
          <div className="flex min-w-max flex-col gap-8 pr-6">
            {desktopSections.map(section => (
              <div
                key={section.key}
                className="min-w-full"
                data-section-key={section.key}
                ref={el => registerSectionRef(section.key, el)}
              >
                <div className="flex items-center gap-2 mb-3 sticky top-0 z-10 bg-slate-950/95 backdrop-blur supports-[backdrop-filter]:bg-slate-950/80 py-1">
                  <h2 className={`text-base font-semibold ${section.tone === 'muted' ? 'text-slate-400' : 'text-white'}`}>
                    {section.title}
                  </h2>
                  <span className="text-xs text-slate-500 bg-slate-800 rounded-full px-2 py-0.5">{section.tasks.length} tasks</span>
                  {section.statusLabel && (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                      section.statusLabel === 'active' ? 'bg-green-900/60 text-green-300' : 'bg-slate-700 text-slate-400'
                    }`}>
                      {section.statusLabel}
                    </span>
                  )}
                  {section.isLoading && (
                    <span className="text-xs text-slate-400 italic animate-pulse">Loading tasks…</span>
                  )}
                </div>
                {section.tasks.length === 0 && section.isLoading ? (
                  <div className="flex items-center justify-center h-16 border border-dashed border-slate-700 rounded-lg text-slate-500 text-sm animate-pulse">
                    Loading workflow tasks…
                  </div>
                ) : section.tasks.length === 0 && section.hasUnloadedTasks ? (
                  <div className="flex items-center justify-center h-16 border border-dashed border-slate-700 rounded-lg text-slate-500 text-sm italic">
                    Tasks loading…
                  </div>
                ) : (
                  <div className="flex gap-4 w-max min-w-full h-[600px]" style={{ scrollSnapType: 'x mandatory' }}>
                    {filterVisibleColumns(activeColumnsForSection(section), section).map(col => (
                      <div key={col.key} className="min-w-[280px] w-[280px] flex-shrink-0 h-full" style={{ scrollSnapAlign: 'start' }}>
                        {renderColumn(col, section.tasks.filter(t => t.status === col.key), true, section)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="hidden md:flex gap-4 overflow-x-auto pb-4 h-[600px]" style={{ scrollSnapType: 'x mandatory' }}>
          {visibleColumns.map(col => (
            <div key={col.key} className="min-w-[280px] w-[280px] flex-shrink-0 flex flex-col h-full" style={{ scrollSnapAlign: 'start' }}>
              {renderColumn(col, effectiveTasks.filter(t => t.status === col.key))}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {boardContent}

      {/* Drag overlay — renders the card being dragged */}
      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <div className="w-[280px] opacity-90 rotate-2 shadow-2xl">
            <TaskCard
              task={activeTask}
              allTasks={tasks}
              onClick={() => {}}
              relationshipTypes={boardWorkflowMetadata.relationship_types}
              onLinkTask={async () => {}}
              onRemoveBlocker={async () => {}}
              onPause={async () => {}}
              showSprint={showSprint}
              outcomeMap={outcomeMap}
            />
          </div>
        ) : activeColumnConfig ? (
          <div className="flex w-52 items-center gap-2 rounded-md border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white shadow-xl">
            <GripVertical className="h-3.5 w-3.5 text-slate-500" />
            <span className="truncate">{(orderedColumnsByScope[activeColumnConfig.scopeKey] ?? []).find(column => column.key === activeColumnConfig.columnKey)?.label ?? activeColumnConfig.columnKey}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
