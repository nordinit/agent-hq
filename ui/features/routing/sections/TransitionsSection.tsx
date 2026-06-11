'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type RoutingTransition, type TaskStatusMeta } from '@/lib/api';
import { getTaskTypeLabel, useTaskTypes } from '@/lib/taskTypes';
import { useWorkflowMetadata } from '@/lib/useWorkflowMetadata';
import { firstOutcomeOptionValue, formatOutcomeOptionLabel, mergeOutcomeOptions, type SprintOutcomeCatalogState } from '@/lib/useSprintOutcomeCatalog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TableEnabledSwitch } from '@/components/TableEnabledSwitch';
import { OutcomeKeySelect } from '@/components/OutcomeKeySelect';
import { COLOR_BADGE_CLASSES, RoutingWarningBanner, ScopeBadge, SectionHeader, TABLE_DELETE_ACTION_CLASS, TABLE_EDIT_ACTION_CLASS } from '@/components/workflowConfig';
import { ColumnHeaderLabel } from '@/components/ui/table-column-help';
import { TableColumnFilter, matchesColumnFilter, uniqueColumnOptions } from '@/components/TableColumnFilter';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { ROUTING_TABLE_HELP, TRANSITION_COLUMN_HELP } from '../workflowConfigShared';

export default function TransitionsSection({
  projectId,
  sprintId,
  sprintName,
  sprintType,
  outcomeCatalog,
}: {
  projectId: number | null;
  sprintId: number | null;
  sprintName: string | null;
  sprintType: string | null;
  outcomeCatalog: SprintOutcomeCatalogState;
}) {
  const [transitions, setTransitions] = useState<RoutingTransition[]>([]);
  const [statusCatalog, setStatusCatalog] = useState<TaskStatusMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const { taskTypes } = useTaskTypes();
  const [filterTaskTypes, setFilterTaskTypes] = useState<string[]>([]);
  const [filterFromStatuses, setFilterFromStatuses] = useState<string[]>([]);
  const [filterOutcomes, setFilterOutcomes] = useState<string[]>([]);
  const [filterToStatuses, setFilterToStatuses] = useState<string[]>([]);
  const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
  const [filterStates, setFilterStates] = useState<string[]>(['enabled']);
  const [newForm, setNewForm] = useState({
    task_type: '' as string,
    from_status: '',
    outcome: '',
    to_status: '',
    priority: 0,
  });
  const [editingTransitionId, setEditingTransitionId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({
    task_type: '' as string,
    from_status: '',
    outcome: '',
    to_status: '',
    priority: 0,
  });
  const { metadata: workflowMetadata } = useWorkflowMetadata(sprintId ?? undefined);

  const statusOptions = useMemo(() => Array.from(new Set([
    ...statusCatalog.map(status => status.name),
    ...transitions.flatMap(transition => [transition.from_status, transition.to_status]),
    newForm.from_status,
    newForm.to_status,
  ].filter(Boolean))), [newForm.from_status, newForm.to_status, statusCatalog, transitions]);
  const outcomeOptions = useMemo(
    () => mergeOutcomeOptions(outcomeCatalog, newForm.task_type || null),
    [newForm.task_type, outcomeCatalog],
  );
  const filterOutcomeOptions = useMemo(
    () => mergeOutcomeOptions(outcomeCatalog, null),
    [outcomeCatalog],
  );
  const outcomeCatalogLabel = sprintType
    ? `workflow outcomes for ${sprintType}`
    : 'the selected workflow type outcome catalog';

  const statusBadgeClass: Record<string, string> = {
    ...Object.fromEntries(statusCatalog.map(status => [status.name, COLOR_BADGE_CLASSES[status.color] ?? 'bg-slate-700 text-slate-300'])),
  };
  const routingWarnings = workflowMetadata.routing_warnings ?? [];
  const transitionTaskTypeOptions = useMemo(() => uniqueColumnOptions([
    { value: '', label: 'All types' },
    ...taskTypes.map(taskType => ({ value: taskType, label: getTaskTypeLabel(taskType) })),
    ...transitions.map(transition => ({
      value: transition.task_type ?? '',
      label: transition.task_type ? getTaskTypeLabel(transition.task_type) : 'All types',
    })),
  ]), [taskTypes, transitions]);
  const transitionStatusOptions = useMemo(() => uniqueColumnOptions([
    ...statusOptions.map(status => ({ value: status, label: status })),
  ]), [statusOptions]);
  const transitionOutcomeFilterOptions = useMemo(() => uniqueColumnOptions([
    ...filterOutcomeOptions.map(option => ({ value: option.value, label: formatOutcomeOptionLabel(option) })),
    ...transitions.map(transition => ({ value: transition.outcome, label: transition.outcome })),
  ]), [filterOutcomeOptions, transitions]);
  const transitionPriorityOptions = useMemo(() => uniqueColumnOptions(
    transitions.map(transition => ({ value: String(transition.priority ?? 0), label: String(transition.priority ?? 0) }))
  ), [transitions]);
  const transitionStateOptions = useMemo(() => ([
    { value: 'enabled', label: 'Enabled' },
    { value: 'disabled', label: 'Disabled' },
  ]), []);
  const load = useCallback(async () => {
    if (!sprintType) {
      setTransitions([]);
      setStatusCatalog([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [transitionResponse, workflowMetadataResponse] = await Promise.all([
        api.getRoutingTransitions(projectId ?? undefined, sprintId ?? undefined, sprintType),
        api.getWorkflowMetadata(sprintId ? { sprint_id: sprintId } : { sprint_type: sprintType }),
      ]);
      setTransitions(transitionResponse.transitions);
      setStatusCatalog(workflowMetadataResponse.statuses);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [projectId, sprintId, sprintType]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setNewForm(current => {
      const nextFromStatus = statusOptions.includes(current.from_status)
        ? current.from_status
        : statusOptions[0] ?? '';
      const nextToStatus = statusOptions.includes(current.to_status)
        ? current.to_status
        : statusOptions.find(status => status !== nextFromStatus) ?? statusOptions[0] ?? '';
      const nextOutcome = outcomeOptions.some(option => option.value === current.outcome)
        ? current.outcome
        : firstOutcomeOptionValue(outcomeOptions);
      if (nextFromStatus === current.from_status && nextToStatus === current.to_status && nextOutcome === current.outcome) {
        return current;
      }
      return { ...current, from_status: nextFromStatus, to_status: nextToStatus, outcome: nextOutcome };
    });
  }, [outcomeOptions, statusOptions]);

  const handleAdd = async () => {
    if (!sprintType) return;
    const outcomeKey = newForm.outcome;
    if (!outcomeKey) {
      alert('Choose an outcome from the workflow type outcome catalog.');
      return;
    }
    if (!outcomeOptions.some(option => option.value === outcomeKey)) {
      alert('Outcome must be defined in the selected workflow type outcome catalog.');
      return;
    }
    try {
      await api.createRoutingTransition({
        project_id: projectId,
        sprint_id: sprintId,
        sprint_type: sprintType,
        task_type: newForm.task_type || null,
        from_status: newForm.from_status,
        outcome: outcomeKey,
        to_status: newForm.to_status,
        priority: newForm.priority,
      });
      setShowAdd(false);
      await load();
    } catch (e) {
      alert(String(e));
    }
  };

  const startEdit = (transition: RoutingTransition) => {
    setEditingTransitionId(transition.id);
    setEditForm({
      task_type: transition.task_type ?? '',
      from_status: transition.from_status,
      outcome: transition.outcome,
      to_status: transition.to_status,
      priority: transition.priority ?? 0,
    });
  };

  const cancelEdit = () => {
    setEditingTransitionId(null);
  };

  const handleSaveEdit = async (id: number) => {
    if (!projectId || !sprintType) return;
    const editOutcomeOptions = mergeOutcomeOptions(outcomeCatalog, editForm.task_type || null);
    if (!editForm.outcome || !editOutcomeOptions.some(option => option.value === editForm.outcome)) {
      alert('Outcome must be defined in the selected workflow type outcome catalog.');
      return;
    }
    try {
      const transition = transitions.find(row => row.id === id);
      await api.updateRoutingTransition(id, {
        project_id: projectId,
        sprint_id: transition?.sprint_id ?? undefined,
        sprint_type: transition?.sprint_type ?? sprintType,
        task_type: editForm.task_type || null,
        from_status: editForm.from_status,
        outcome: editForm.outcome,
        to_status: editForm.to_status,
        priority: editForm.priority,
      });
      setEditingTransitionId(null);
      await load();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleToggle = async (t: RoutingTransition) => {
    try {
      await api.updateRoutingTransition(t.id, { project_id: projectId ?? undefined, sprint_id: t.sprint_id ?? sprintId ?? undefined, sprint_type: t.sprint_type ?? sprintType ?? undefined, enabled: t.enabled ? 0 : 1 });
      await load();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this transition rule? Workflow-scoped transitions are user-managed and will not be restored automatically.')) return;
    try {
      const transition = transitions.find(row => row.id === id);
      await api.deleteRoutingTransition(id, transition?.sprint_id ?? sprintId ?? undefined, projectId ?? undefined, transition?.sprint_type ?? sprintType ?? undefined);
      await load();
    } catch (e) {
      alert(String(e));
    }
  };

  if (!projectId || !sprintType) {
    return (
      <Card className="bg-slate-900/50 border-slate-700/50 p-6 text-sm text-slate-400">
        Select a project and workflow type to edit shared outcome transitions, then optionally pick a workflow for overrides.
      </Card>
    );
  }

  if (loading) return (
    <div className="flex items-center justify-center h-32">
      <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  const filteredTransitions = transitions.filter(t => {
    const enabledValue = t.enabled ? 'enabled' : 'disabled';
    return matchesColumnFilter(filterTaskTypes, t.task_type ?? '')
      && matchesColumnFilter(filterFromStatuses, t.from_status)
      && matchesColumnFilter(filterOutcomes, t.outcome)
      && matchesColumnFilter(filterToStatuses, t.to_status)
      && matchesColumnFilter(filterPriorities, String(t.priority ?? 0))
      && matchesColumnFilter(filterStates, enabledValue);
  });

  return (
    <div className="space-y-4">
      <RoutingWarningBanner warnings={routingWarnings} scopeLabel={sprintName ?? 'This workflow'} />
      <SectionHeader
        label="Automatic Transitions"
        help={`${ROUTING_TABLE_HELP.transitions} Outcome options come from ${outcomeCatalogLabel}.`}
        actions={(
          <>
            <span className="text-xs text-slate-500">{filteredTransitions.length} of {transitions.length} transition{transitions.length !== 1 ? 's' : ''}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowAdd(!showAdd)}
              disabled={showAdd}
            >
              <Plus className="w-3.5 h-3.5" /> Add Transition
            </Button>
          </>
        )}
      />
      {outcomeCatalog.error && (
        <div className="rounded-lg border border-red-700/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          Could not load outcome catalog: {outcomeCatalog.error}
        </div>
      )}
      {/* Rules Table */}
      <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left">
                <th className="w-20 px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-400"><ColumnHeaderLabel label="ID" description={TRANSITION_COLUMN_HELP.id} /></th>
                <th className="px-3 py-2.5">
                  <TableColumnFilter label="Task Type" description={TRANSITION_COLUMN_HELP.taskType} selected={filterTaskTypes} onChange={setFilterTaskTypes} options={transitionTaskTypeOptions} />
                </th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider"><ColumnHeaderLabel label="Scope" description={TRANSITION_COLUMN_HELP.scope} /></th>
                <th className="px-3 py-2.5">
                  <TableColumnFilter label="From" description={TRANSITION_COLUMN_HELP.from} selected={filterFromStatuses} onChange={setFilterFromStatuses} options={transitionStatusOptions} />
                </th>
                <th className="px-3 py-2.5">
                  <TableColumnFilter label="Outcome" description={TRANSITION_COLUMN_HELP.outcome} selected={filterOutcomes} onChange={setFilterOutcomes} options={transitionOutcomeFilterOptions} />
                </th>
                <th className="px-3 py-2.5">
                  <TableColumnFilter label="To" description={TRANSITION_COLUMN_HELP.to} selected={filterToStatuses} onChange={setFilterToStatuses} options={transitionStatusOptions} />
                </th>
                <th className="px-3 py-2.5">
                  <TableColumnFilter label="Priority" description={TRANSITION_COLUMN_HELP.priority} selected={filterPriorities} onChange={setFilterPriorities} options={transitionPriorityOptions} align="center" />
                </th>
                <th className="px-3 py-2.5 text-center">
                  <TableColumnFilter label="Enabled" description={TRANSITION_COLUMN_HELP.enabled} selected={filterStates} onChange={setFilterStates} options={transitionStateOptions} align="center" />
                </th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider text-right"><ColumnHeaderLabel label="Actions" description={TRANSITION_COLUMN_HELP.actions} align="right" /></th>
              </tr>
            </thead>
            <tbody>
              {showAdd && (
                <tr className="border-b border-amber-500/20 bg-amber-500/5">
                  <td className="px-3 py-2.5 align-middle">
                    <span className="font-mono text-[11px] text-slate-500">New</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <select
                      value={newForm.task_type}
                      onChange={e => setNewForm({ ...newForm, task_type: e.target.value })}
                      className="w-full min-w-[150px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                    >
                      <option value="">All types</option>
                      {taskTypes.map(taskType => <option key={taskType} value={taskType}>{getTaskTypeLabel(taskType)}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-400">{sprintId ? 'New workflow override' : 'New workflow-type default'}</td>
                  <td className="px-3 py-2.5">
                    <select
                      value={newForm.from_status}
                      onChange={e => setNewForm({ ...newForm, from_status: e.target.value })}
                      className="w-full min-w-[140px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                    >
                      {statusOptions.map(status => <option key={status} value={status}>{status}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2.5">
                    <OutcomeKeySelect
                      id="new-transition-outcome"
                      label=""
                      value={newForm.outcome}
                      onChange={outcome => setNewForm({ ...newForm, outcome })}
                      options={outcomeOptions}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <select
                      value={newForm.to_status}
                      onChange={e => setNewForm({ ...newForm, to_status: e.target.value })}
                      className="w-full min-w-[140px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                    >
                      {statusOptions.map(status => <option key={status} value={status}>{status}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <input
                      type="number"
                      value={newForm.priority}
                      onChange={e => setNewForm({ ...newForm, priority: Number(e.target.value) })}
                      className="w-20 rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                    />
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <TableEnabledSwitch checked label="New automatic transitions are enabled by default" onChange={() => undefined} disabled />
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="primary" size="sm" onClick={handleAdd} disabled={!newForm.outcome}>
                        <Check className="h-3 w-3" /> Add
                      </Button>
                      <button type="button" onClick={() => setShowAdd(false)} className={TABLE_EDIT_ACTION_CLASS} title="Cancel">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              )}
              {filteredTransitions.map(t => {
                const editing = editingTransitionId === t.id;
                const editOutcomeOptions = mergeOutcomeOptions(outcomeCatalog, editForm.task_type || null);
                return (
                  <tr key={t.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="px-3 py-2.5 align-middle">
                      <span className="inline-flex rounded border border-slate-700/70 bg-slate-900/60 px-1.5 py-0.5 font-mono text-[11px] leading-5 text-slate-400">
                        #{t.id}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {editing ? (
                        <select
                          value={editForm.task_type}
                          onChange={e => {
                            const nextTaskType = e.target.value;
                            const nextOutcomeOptions = mergeOutcomeOptions(outcomeCatalog, nextTaskType || null);
                            setEditForm(form => ({
                              ...form,
                              task_type: nextTaskType,
                              outcome: nextOutcomeOptions.some(option => option.value === form.outcome)
                                ? form.outcome
                                : firstOutcomeOptionValue(nextOutcomeOptions),
                            }));
                          }}
                          className="w-full min-w-[150px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                        >
                          <option value="">All types</option>
                          {taskTypes.map(taskType => <option key={taskType} value={taskType}>{getTaskTypeLabel(taskType)}</option>)}
                        </select>
                      ) : t.task_type ? (
                        <span className="rounded bg-indigo-900/30 px-1.5 py-0.5 font-mono text-xs text-indigo-300">{t.task_type}</span>
                      ) : (
                        <span className="text-xs text-slate-600">all types</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <ScopeBadge kind={t.scope_kind} />
                    </td>
                    <td className="px-3 py-2.5">
                      {editing ? (
                        <select
                          value={editForm.from_status}
                          onChange={e => setEditForm(form => ({ ...form, from_status: e.target.value }))}
                          className="w-full min-w-[140px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                        >
                          {statusOptions.map(status => <option key={status} value={status}>{status}</option>)}
                        </select>
                      ) : (
                        <Badge className={`${statusBadgeClass[t.from_status] || 'bg-slate-700'} text-xs`}>{t.from_status}</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {editing ? (
                        <OutcomeKeySelect
                          id={`edit-transition-outcome-${t.id}`}
                          label=""
                          value={editForm.outcome}
                          onChange={outcome => setEditForm(form => ({ ...form, outcome }))}
                          options={editOutcomeOptions}
                        />
                      ) : (
                        <span className="font-mono text-xs text-slate-300">{t.outcome}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {editing ? (
                        <select
                          value={editForm.to_status}
                          onChange={e => setEditForm(form => ({ ...form, to_status: e.target.value }))}
                          className="w-full min-w-[140px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                        >
                          {statusOptions.map(status => <option key={status} value={status}>{status}</option>)}
                        </select>
                      ) : (
                        <Badge className={`${statusBadgeClass[t.to_status] || 'bg-slate-700'} text-xs`}>{t.to_status}</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {editing ? (
                        <input
                          type="number"
                          value={editForm.priority}
                          onChange={e => setEditForm(form => ({ ...form, priority: Number(e.target.value) }))}
                          className="w-20 rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                        />
                      ) : (
                        <span className="font-mono text-xs text-slate-300">{t.priority ?? 0}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <TableEnabledSwitch
                        checked={Boolean(t.enabled)}
                        disabled={editing}
                        label={`${t.enabled ? 'Disable' : 'Enable'} automatic transition #${t.id}`}
                        onChange={() => void handleToggle(t)}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {editing ? (
                        <div className="flex justify-end gap-1">
                          <Button variant="primary" size="sm" onClick={() => handleSaveEdit(t.id)}>
                            <Check className="h-3 w-3" /> Save
                          </Button>
                          <button type="button" onClick={cancelEdit} className={TABLE_EDIT_ACTION_CLASS} title="Cancel">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex justify-end gap-1">
                          <button type="button" onClick={() => startEdit(t)} className={TABLE_EDIT_ACTION_CLASS} title="Edit outcome transition">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button type="button" onClick={() => handleDelete(t.id)} className={TABLE_DELETE_ACTION_CLASS} title="Delete outcome transition">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filteredTransitions.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-slate-500">
                    {transitions.length === 0
                      ? 'No transition rules. Add one to define outcome-driven state changes.'
                      : 'No transitions match the current filters.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
