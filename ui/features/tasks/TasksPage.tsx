'use client';

import { useMemo, Suspense } from 'react';
import { formatWorkflowLabel } from '@/lib/workflowLabel';
import { boardWorkflowTotal } from '@/lib/boardTasks';
import { TaskDetailPanel } from '@/features/tasks/TaskDetailPanel';
import { TaskBoard, TaskBoardSection } from '@/features/tasks/TaskBoard';
import { TaskBoardErrorBoundary } from '@/features/tasks/TaskBoardErrorBoundary';
import { MultiWorkflowFilter, TaskTypeFilter, TasksPageToolbar } from '@/features/tasks/TasksPageFilters';
import { TaskModal } from '@/features/tasks/TaskModal';
import { useTasksPageState, type Task } from '@/features/tasks/useTasksPageState';
function TasksPageInner() {
  const {
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
  } = useTasksPageState();

  const visibleWorkflowTypes = useMemo(() => {
    const visibleWorkflows = selectedWorkflowIds.length > 0
      ? workflows.filter(workflow => selectedWorkflowIds.includes(workflow.id))
      : workflows;
    const seen = new Set<string>();
    const types: string[] = [];
    for (const workflow of visibleWorkflows) {
      if (!workflow.workflow_type || seen.has(workflow.workflow_type)) continue;
      seen.add(workflow.workflow_type);
      types.push(workflow.workflow_type);
    }
    return types;
  }, [selectedWorkflowIds, workflows]);

  const desktopSections = useMemo<TaskBoardSection[] | undefined>(() => {
    if (workflows.length <= 1) return undefined;

    // When workflow filter is active, only show sections for selected workflows
    const visibleWorkflows = selectedWorkflowIds.length > 0
      ? workflows.filter(s => selectedWorkflowIds.includes(s.id))
      : workflows;

    // A section for every visible workflow. The board read returns the newest tasks of every
    // workflow's columns at once, with each column's total, so nothing loads lazily per section.
    // When a search/filter is active, workflow sections with no matching tasks are hidden.
    const workflowSections: TaskBoardSection[] = visibleWorkflows
      .map(workflow => ({
        key: `workflow-${workflow.id}`,
        title: `🏃 ${formatWorkflowLabel(workflow)}`,
        tasks: filteredTasks.filter(t => t.workflow_id === workflow.id),
        workflowId: workflow.id,
        total: boardWorkflowTotal(buckets, workflow.id),
        workflowType: workflow.workflow_type,
        statusLabel: workflow.status,
      }))
      .filter(s => !isFiltered || s.tasks.length > 0);

    // Only show "No Workflow" when unassigned tasks actually exist and no workflow filter is active.
    if (selectedWorkflowIds.length === 0) {
      const unworkflowed = filteredTasks.filter(t => !t.workflow_id);
      if (unworkflowed.length > 0) {
        workflowSections.push({
          key: 'no-workflow',
          title: 'No Workflow',
          tasks: unworkflowed,
          workflowId: null,
          total: boardWorkflowTotal(buckets, null),
          tone: 'muted',
        });
      }
    }

    return workflowSections;
  }, [workflows, filteredTasks, buckets, selectedWorkflowIds, isFiltered]);

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

      {(workflows.length > 0 || taskTypeOptions.length > 0) && (
        <div className="mb-2 flex flex-shrink-0 flex-col gap-2 md:mb-3 md:flex-row md:items-start">
          {workflows.length > 0 && (
            <div className="min-w-0 md:flex-1">
              <MultiWorkflowFilter
                workflows={workflows}
                selectedIds={selectedWorkflowIds}
                onChange={setSelectedWorkflowIds}
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
                workflowId={selectedSingleWorkflowId}
                workflowTypes={visibleWorkflowTypes}
                onTaskClick={openTask}
                onLinkTask={handleLinkTask}
                onRemoveBlocker={handleRemoveBlocker}
                onPause={handlePause}
                onStatusChange={handleStatusChange}
                showWorkflow
                sections={desktopSections}
                isFiltered={isFiltered}
                buckets={buckets}
                onLoadMore={loadMoreInColumn}
                workflowFilterIds={selectedWorkflowIds}
              />
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
