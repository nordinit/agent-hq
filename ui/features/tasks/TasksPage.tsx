'use client';

import { useMemo, Suspense } from 'react';
import { formatSprintLabel } from '@/lib/sprintLabel';
import { TaskDetailPanel } from '@/features/tasks/TaskDetailPanel';
import { TaskBoard, TaskBoardSection } from '@/features/tasks/TaskBoard';
import { TaskBoardErrorBoundary } from '@/features/tasks/TaskBoardErrorBoundary';
import { MultiSprintFilter, TaskTypeFilter, TasksPageToolbar } from '@/features/tasks/TasksPageFilters';
import { TaskModal } from '@/features/tasks/TaskModal';
import { useTasksPageState, type Task } from '@/features/tasks/useTasksPageState';
function TasksPageInner() {
  const {
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
  } = useTasksPageState();

  const visibleWorkflowTypes = useMemo(() => {
    const visibleSprints = selectedSprintIds.length > 0
      ? sprints.filter(sprint => selectedSprintIds.includes(sprint.id))
      : sprints;
    const seen = new Set<string>();
    const types: string[] = [];
    for (const sprint of visibleSprints) {
      if (!sprint.sprint_type || seen.has(sprint.sprint_type)) continue;
      seen.add(sprint.sprint_type);
      types.push(sprint.sprint_type);
    }
    return types;
  }, [selectedSprintIds, sprints]);

  const desktopSections = useMemo<TaskBoardSection[] | undefined>(() => {
    if (sprints.length <= 1) return undefined;

    // When workflow filter is active, only show sections for selected workflows
    const visibleSprints = selectedSprintIds.length > 0
      ? sprints.filter(s => selectedSprintIds.includes(s.id))
      : sprints;

    // Always render a section for every visible workflow — even if its tasks
    // are not yet loaded. Visibility triggers lazy fetch via onSectionVisible/IntersectionObserver.
    // Exception: when a search/filter is active, hide workflow sections with zero matching tasks
    // so the user only sees signal.
    const sprintSections: TaskBoardSection[] = visibleSprints
      .map(sprint => {
        const sprintTasks = filteredTasks.filter(t => t.sprint_id === sprint.id);
        const isLoading = loadingSprintIds.has(sprint.id);
        // hasUnloadedTasks: workflow is active, has no loaded tasks, and hasn't finished lazy loading
        const hasUnloadedTasks = sprintTasks.length === 0 && !isLoading && !loadedSprintIds.current.has(sprint.id);
        return {
          key: `sprint-${sprint.id}`,
          title: `🏃 ${formatSprintLabel(sprint)}`,
          tasks: sprintTasks,
          sprintType: sprint.sprint_type,
          statusLabel: sprint.status,
          // When search is active and no tasks match, don't claim unloaded tasks exist either —
          // the visible set has already been filtered, so we suppress the section entirely below.
          hasUnloadedTasks: isFiltered ? false : hasUnloadedTasks,
          isLoading: isFiltered ? false : isLoading,
        };
      })
      // When a filter is active, suppress workflow sections that have no matching tasks.
      // When no filter: keep all workflows (including unloaded ones) so lazy loading still fires.
      .filter(s => !isFiltered || s.tasks.length > 0);

    // Only show "No Workflow" when unassigned tasks actually exist and no workflow filter is active.
    if (selectedSprintIds.length === 0) {
      const unsprinted = filteredTasks.filter(t => !t.sprint_id);
      if (unsprinted.length > 0) {
        sprintSections.push({
          key: 'no-sprint',
          title: 'No Workflow',
          tasks: unsprinted,
          tone: 'muted',
        });
      }
    }

    return sprintSections;
  }, [sprints, filteredTasks, loadingSprintIds, selectedSprintIds, isFiltered]);

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-slate-950 p-2 md:p-6 overflow-x-hidden overflow-y-auto md:overflow-hidden md:pb-6">
      <TasksPageToolbar
        loading={loading}
        totalTasks={totalTasks}
        tasksCount={tasks.length}
        visibleTaskCount={visibleTaskCount}
        isFiltered={isFiltered}
        isBackgroundLoading={isBackgroundLoading}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        activeInstanceOnly={activeInstanceOnly}
        onActiveInstanceOnlyChange={setActiveInstanceOnly}
        onCreateTask={() => openNew(defaultNewTaskStatus)}
        canCreateTask={Boolean(defaultNewTaskStatus)}
        projects={projects}
        selectedProject={selectedProject}
        onProjectChange={setSelectedProject}
      />

      {(sprints.length > 0 || taskTypeOptions.length > 0) && (
        <div className="mb-2 flex flex-shrink-0 flex-col gap-2 md:mb-3 md:flex-row md:items-start">
          {sprints.length > 0 && (
            <div className="min-w-0 md:flex-1">
              <MultiSprintFilter
                sprints={sprints}
                selectedIds={selectedSprintIds}
                onChange={ids => {
                  setSelectedSprintIds(ids);
                  // Trigger lazy load for newly-selected workflows
                  ids.forEach(id => handleSectionVisible(`sprint-${id}`));
                }}
              />
            </div>
          )}
          <TaskTypeFilter
            options={taskTypeOptions}
            selectedValue={selectedTaskType}
            onChange={setSelectedTaskType}
          />
        </div>
      )}

      <div data-tour-target="tasks-board" className="flex min-h-0 flex-1 flex-col">
        <TaskBoardErrorBoundary fallbackTitle="Task board encountered an error">
          {loading ? (
            <div className="flex items-center justify-center flex-1">
              <div className="text-slate-500 text-sm animate-pulse">Loading tasks…</div>
            </div>
          ) : (
            <>
              <TaskBoard
                tasks={filteredTasks}
                storageKey="tasks-visible-cols"
                sprintId={selectedSingleSprintId}
                workflowTypes={visibleWorkflowTypes}
                onTaskClick={task => setViewTask(task as Task)}
                onLinkTask={handleLinkTask}
                onRemoveBlocker={handleRemoveBlocker}
                onPause={handlePause}
                onStatusChange={handleStatusChange}
                showSprint
                sections={desktopSections}
                onSectionVisible={handleSectionVisible}
                isFiltered={isFiltered}
              />
              {/* Hint when workflow filter is active and tasks are still loading */}
              {selectedSprintIds.length > 0 && filteredTasks.length === 0 && selectedSprintIds.some(id => loadingSprintIds.has(id)) && (
                <div className="flex-shrink-0 flex items-center justify-center py-4 text-slate-400 text-sm italic text-center px-4 animate-pulse">
                  Loading workflow tasks…
                </div>
              )}
              {isBackgroundLoading && hasMore && (
                <div className="flex-shrink-0 flex items-center justify-center pt-4 text-sm text-slate-400 animate-pulse">
                  Loading remaining tasks…
                </div>
              )}
            </>
          )}
        </TaskBoardErrorBoundary>
      </div>

      {modal && (
        <TaskModal
          task={modal.task}
          projects={projects}
          onClose={() => setModal(null)}
          onSave={handleSave}
          onDelete={modal.task.id ? () => handleDelete(modal.task.id!) : undefined}
        />
      )}

      {viewTask && (
        <TaskBoardErrorBoundary fallbackTitle="Task detail panel encountered an error">
          <TaskDetailPanel
            task={viewTask as any}
            statuses={taskStatusCatalog}
            onClose={() => setViewTask(null)}
            onSave={handlePanelSave}
            onDelete={handlePanelDelete}
            onCancel={() => handleCancel(viewTask.id)}
            onPause={(reason) => handlePause(viewTask.id, reason)}
            onUnpause={() => handleUnpause(viewTask.id)}
          />
        </TaskBoardErrorBoundary>
      )}
    </div>
  );
}

export default function TasksPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" /></div>}>
      <TasksPageInner />
    </Suspense>
  );
}
