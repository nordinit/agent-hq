'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type CustomFieldDefinition, type TransitionRequirement } from '@/lib/api';
import { getTaskTypeLabel, useTaskTypes } from '@/lib/taskTypes';
import { firstOutcomeOptionValue, formatOutcomeOptionLabel, mergeOutcomeOptions, type SprintOutcomeCatalogState } from '@/lib/useSprintOutcomeCatalog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TableEnabledSwitch } from '@/components/TableEnabledSwitch';
import { OutcomeKeySelect } from '@/components/OutcomeKeySelect';
import { ScopeBadge, SectionHeader, TABLE_DELETE_ACTION_CLASS, TABLE_EDIT_ACTION_CLASS } from '@/components/workflowConfig';
import { ColumnHeaderLabel } from '@/components/ui/table-column-help';
import { TableColumnFilter, matchesColumnFilter, uniqueColumnOptions } from '@/components/TableColumnFilter';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { REQUIREMENT_COLUMN_HELP, ROUTING_TABLE_HELP } from '../workflowConfigShared';

export default function TransitionRequirementsSection({
  projectId,
  sprintId,
  sprintType,
  sprintName,
  outcomeCatalog,
}: {
  projectId: number | null;
  sprintId: number | null;
  sprintType: string | null;
  sprintName: string | null;
  outcomeCatalog: SprintOutcomeCatalogState;
}) {
  const [reqs, setReqs] = useState<TransitionRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const { options: taskTypeOptions } = useTaskTypes(sprintId, {
    sprintType: sprintId ? null : sprintType,
  });
  const [filterTypes, setFilterTypes] = useState<string[]>([]);
  const [filterScopes, setFilterScopes] = useState<string[]>([]);
  const [filterOutcomes, setFilterOutcomes] = useState<string[]>([]);
  const [filterFields, setFilterFields] = useState<string[]>([]);
  const [filterChecks, setFilterChecks] = useState<string[]>([]);
  const [filterSeverities, setFilterSeverities] = useState<string[]>([]);
  const [filterMessages, setFilterMessages] = useState<string[]>([]);
  const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
  const [filterStates, setFilterStates] = useState<string[]>([]);
  const [requirementFields, setRequirementFields] = useState<CustomFieldDefinition[]>([]);
  const [requirementFieldsLoading, setRequirementFieldsLoading] = useState(false);
  const [newForm, setNewForm] = useState({
    task_type: '' as string,
    outcome: '',
    field_name: 'review_branch',
    requirement_type: 'required' as 'required' | 'match' | 'from_status',
    match_field: '',
    severity: 'block' as 'block' | 'warn',
    message: '',
    priority: 0,
  });
  const [editingRequirementId, setEditingRequirementId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({
    task_type: '' as string,
    outcome: '',
    field_name: '',
    requirement_type: 'required' as 'required' | 'match' | 'from_status',
    match_field: '',
    severity: 'block' as 'block' | 'warn',
    message: '',
    priority: 0,
  });

  const outcomeOptions = useMemo(
    () => mergeOutcomeOptions(outcomeCatalog, newForm.task_type || null),
    [newForm.task_type, outcomeCatalog],
  );
  const editOutcomeOptions = useMemo(
    () => mergeOutcomeOptions(outcomeCatalog, editForm.task_type || null),
    [editForm.task_type, outcomeCatalog],
  );
  const filterOutcomeOptions = useMemo(
    () => mergeOutcomeOptions(outcomeCatalog, null),
    [outcomeCatalog],
  );
  const activeRequirementTaskType = editingRequirementId !== null ? editForm.task_type : newForm.task_type;
  const requirementFieldNames = useMemo(() => requirementFields.map(field => field.key), [requirementFields]);
  const formatRequirementFieldOption = (field: CustomFieldDefinition) => {
    return field.key;
  };

  const load = useCallback(() => {
    if (!sprintType) {
      setReqs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    api.getTransitionRequirements(undefined, undefined, sprintId ?? undefined, projectId ?? undefined, sprintType)
      .then(data => setReqs(data.transition_requirements))
      .catch(e => console.error(e))
      .finally(() => setLoading(false));
  }, [projectId, sprintId, sprintType]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setNewForm(current => {
      if (outcomeOptions.some(option => option.value === current.outcome)) return current;
      const nextOutcome = firstOutcomeOptionValue(outcomeOptions);
      return nextOutcome === current.outcome ? current : { ...current, outcome: nextOutcome };
    });
  }, [outcomeOptions]);

  useEffect(() => {
    if (editingRequirementId === null) return;
    setEditForm(current => {
      if (editOutcomeOptions.some(option => option.value === current.outcome)) return current;
      const nextOutcome = firstOutcomeOptionValue(editOutcomeOptions);
      return nextOutcome === current.outcome ? current : { ...current, outcome: nextOutcome };
    });
  }, [editOutcomeOptions, editingRequirementId]);

  useEffect(() => {
    let cancelled = false;
    if (!sprintId && !sprintType) {
      setRequirementFields([]);
      return;
    }
    setRequirementFieldsLoading(true);
    api.getTransitionRequirementFields(sprintId ?? undefined, activeRequirementTaskType || undefined, sprintType ?? undefined)
      .then(data => {
        if (cancelled) return;
        setRequirementFields(data.fields);
        if (data.field_names.length > 0) {
          if (editingRequirementId !== null && !data.field_names.includes(editForm.field_name)) {
            setEditForm(form => ({ ...form, field_name: data.field_names[0] }));
          } else if (editingRequirementId === null && !data.field_names.includes(newForm.field_name)) {
            setNewForm(form => ({ ...form, field_name: data.field_names[0] }));
          }
        }
      })
      .catch(e => {
        if (!cancelled) {
          console.error(e);
          setRequirementFields([]);
        }
      })
      .finally(() => {
        if (!cancelled) setRequirementFieldsLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeRequirementTaskType, editForm.field_name, editingRequirementId, newForm.field_name, sprintId, sprintType]);

  const handleAdd = async () => {
    if (!projectId || !sprintType) return;
    const outcomeKey = newForm.outcome;
    if (!outcomeKey) {
      alert('Choose an outcome from the workflow type outcome catalog.');
      return;
    }
    if (!outcomeOptions.some(option => option.value === outcomeKey)) {
      alert('Outcome must be defined in the selected workflow type outcome catalog.');
      return;
    }
    if (!requirementFieldNames.includes(newForm.field_name)) {
      alert('Choose a field defined by this workflow type before adding a gate requirement.');
      return;
    }
    if (newForm.requirement_type === 'match' && !requirementFieldNames.includes(newForm.match_field)) {
      alert('Choose a match field defined by this workflow type.');
      return;
    }
    try {
      await api.createTransitionRequirement({
        project_id: projectId,
        sprint_id: sprintId,
        sprint_type: sprintType,
        task_type: newForm.task_type || null,
        outcome: outcomeKey,
        field_name: newForm.field_name,
        requirement_type: newForm.requirement_type,
        match_field: newForm.requirement_type !== 'required' ? (newForm.match_field || null) : null,
        severity: newForm.severity,
        message: newForm.message,
        priority: newForm.priority,
      });
      setShowAdd(false);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const startEdit = (req: TransitionRequirement) => {
    setEditingRequirementId(req.id);
    setEditForm({
      task_type: req.task_type ?? '',
      outcome: req.outcome,
      field_name: req.field_name,
      requirement_type: req.requirement_type,
      match_field: req.match_field ?? '',
      severity: req.severity,
      message: req.message,
      priority: req.priority ?? 0,
    });
  };

  const cancelEdit = () => {
    setEditingRequirementId(null);
  };

  const handleSaveEdit = async (id: number) => {
    if (!projectId || !sprintType) return;
    if (!editForm.outcome || !editOutcomeOptions.some(option => option.value === editForm.outcome)) {
      alert('Outcome must be defined in the selected workflow type outcome catalog.');
      return;
    }
    if (!requirementFieldNames.includes(editForm.field_name)) {
      alert('Choose a field defined by this workflow type before saving the gate requirement.');
      return;
    }
    if (editForm.requirement_type === 'match' && !requirementFieldNames.includes(editForm.match_field)) {
      alert('Choose a match field defined by this workflow type.');
      return;
    }
    try {
      await api.updateTransitionRequirement(id, {
        project_id: projectId,
        sprint_id: reqs.find(req => req.id === id)?.sprint_id ?? undefined,
        sprint_type: sprintType,
        task_type: editForm.task_type || null,
        outcome: editForm.outcome,
        field_name: editForm.field_name,
        requirement_type: editForm.requirement_type,
        match_field: editForm.requirement_type !== 'required' ? (editForm.match_field || null) : null,
        severity: editForm.severity,
        message: editForm.message,
        priority: editForm.priority,
      });
      setEditingRequirementId(null);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleToggle = async (req: TransitionRequirement) => {
    try {
      await api.updateTransitionRequirement(req.id, { project_id: projectId ?? undefined, sprint_id: req.sprint_id ?? undefined, sprint_type: req.sprint_type ?? sprintType ?? undefined, enabled: req.enabled ? 0 : 1 });
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this transition requirement? Starter defaults become workflow-managed rows here and will not be restored automatically after deletion.')) return;
    try {
      const req = reqs.find(row => row.id === id);
      await api.deleteTransitionRequirement(id, req?.sprint_id ?? undefined, projectId ?? undefined, req?.sprint_type ?? sprintType ?? undefined);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const SEVERITY_BADGE: Record<string, string> = {
    block: 'bg-red-900/60 text-red-300',
    warn: 'bg-yellow-900/60 text-yellow-300',
  };

  const REQ_TYPE_BADGE: Record<string, string> = {
    required: 'bg-blue-900/60 text-blue-300',
    match: 'bg-purple-900/60 text-purple-300',
    from_status: 'bg-indigo-900/60 text-indigo-300',
  };

  const requirementTypeOptions = useMemo(() => uniqueColumnOptions([
    { value: '', label: 'All task types' },
    ...taskTypeOptions,
    ...reqs.map(req => ({
      value: req.task_type ?? '',
      label: req.task_type ? getTaskTypeLabel(req.task_type) : 'All task types',
    })),
  ]), [reqs, taskTypeOptions]);
  const requirementScopeOptions = useMemo(() => ([
    { value: 'sprint_type_default', label: 'default' },
    { value: 'sprint_override', label: 'override' },
  ]), []);
  const requirementOutcomeOptions = useMemo(() => uniqueColumnOptions([
    ...filterOutcomeOptions.map(option => ({ value: option.value, label: formatOutcomeOptionLabel(option) })),
    ...reqs.map(req => ({ value: req.outcome, label: req.outcome })),
  ]), [filterOutcomeOptions, reqs]);
  const requirementFieldOptions = useMemo(() => uniqueColumnOptions(
    reqs.map(req => ({ value: req.field_name, label: req.field_name }))
  ), [reqs]);
  const requirementCheckOptions = useMemo(() => uniqueColumnOptions(
    reqs.map(req => ({ value: req.requirement_type, label: req.requirement_type }))
  ), [reqs]);
  const requirementSeverityOptions = useMemo(() => uniqueColumnOptions([
    { value: 'block', label: 'block' },
    { value: 'warn', label: 'warn' },
    ...reqs.map(req => ({ value: req.severity, label: req.severity })),
  ]), [reqs]);
  const requirementMessageOptions = useMemo(() => uniqueColumnOptions(
    reqs.map(req => ({ value: req.message || '', label: req.message || 'No message' }))
  ), [reqs]);
  const requirementPriorityOptions = useMemo(() => uniqueColumnOptions(
    reqs.map(req => ({ value: String(req.priority ?? 0), label: String(req.priority ?? 0) }))
  ), [reqs]);
  const requirementStateOptions = useMemo(() => ([
    { value: 'enabled', label: 'Enabled' },
    { value: 'disabled', label: 'Disabled' },
  ]), []);
  const filteredReqs = useMemo(() => reqs.filter(req => {
    const enabledValue = req.enabled ? 'enabled' : 'disabled';
    return matchesColumnFilter(filterTypes, req.task_type ?? '')
      && matchesColumnFilter(filterScopes, req.scope_kind === 'sprint_override' ? 'sprint_override' : 'sprint_type_default')
      && matchesColumnFilter(filterOutcomes, req.outcome)
      && matchesColumnFilter(filterFields, req.field_name)
      && matchesColumnFilter(filterChecks, req.requirement_type)
      && matchesColumnFilter(filterSeverities, req.severity)
      && matchesColumnFilter(filterMessages, req.message || '')
      && matchesColumnFilter(filterPriorities, String(req.priority ?? 0))
      && matchesColumnFilter(filterStates, enabledValue);
  }), [filterChecks, filterFields, filterMessages, filterOutcomes, filterPriorities, filterScopes, filterSeverities, filterStates, filterTypes, reqs]);

  if (loading) return (
    <div className="flex items-center justify-center h-32">
      <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (!projectId || !sprintType) {
    return (
      <Card className="bg-slate-900/50 border-slate-700/50 p-6 text-sm text-slate-400">
        Select a project and workflow type to edit shared gate requirements, then optionally pick a workflow for overrides.
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        label="Gate Requirements"
        help={ROUTING_TABLE_HELP.gates}
        actions={(
          <>
            <span className="text-xs text-slate-500">{filteredReqs.length} of {reqs.length} requirement{reqs.length !== 1 ? 's' : ''}</span>
            <Button variant="secondary" size="sm" onClick={() => setShowAdd(!showAdd)} disabled={showAdd}>
              <Plus className="w-3.5 h-3.5" /> Add Requirement
            </Button>
          </>
        )}
      />
      {outcomeCatalog.error && (
        <div className="rounded-lg border border-red-700/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          Could not load outcome catalog: {outcomeCatalog.error}
        </div>
      )}
      <Card className="bg-slate-800/60 border-slate-700/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className={`w-full ${showAdd || editingRequirementId !== null ? 'min-w-[1480px]' : 'min-w-[1160px]'}`}>
            <thead>
              <tr className="border-b border-slate-700 text-left">
                <th className="w-20 px-3 py-2 text-xs font-semibold uppercase text-slate-400"><ColumnHeaderLabel label="ID" description={REQUIREMENT_COLUMN_HELP.id} /></th>
                <th className="px-3 py-2">
                  <TableColumnFilter label="Task Type" description={REQUIREMENT_COLUMN_HELP.taskType} selected={filterTypes} onChange={setFilterTypes} options={requirementTypeOptions} />
                </th>
                <th className="px-3 py-2">
                  <TableColumnFilter label="Scope" description={REQUIREMENT_COLUMN_HELP.scope} selected={filterScopes} onChange={setFilterScopes} options={requirementScopeOptions} />
                </th>
                <th className="px-3 py-2">
                  <TableColumnFilter label="Outcome" description={REQUIREMENT_COLUMN_HELP.outcome} selected={filterOutcomes} onChange={setFilterOutcomes} options={requirementOutcomeOptions} />
                </th>
                <th className="px-3 py-2">
                  <TableColumnFilter label="Field" description={REQUIREMENT_COLUMN_HELP.field} selected={filterFields} onChange={setFilterFields} options={requirementFieldOptions} />
                </th>
                <th className="px-3 py-2">
                  <TableColumnFilter label="Check" description={REQUIREMENT_COLUMN_HELP.check} selected={filterChecks} onChange={setFilterChecks} options={requirementCheckOptions} />
                </th>
                <th className="px-3 py-2">
                  <TableColumnFilter label="Severity" description={REQUIREMENT_COLUMN_HELP.severity} selected={filterSeverities} onChange={setFilterSeverities} options={requirementSeverityOptions} />
                </th>
                <th className="px-3 py-2">
                  <TableColumnFilter label="Message" description={REQUIREMENT_COLUMN_HELP.message} selected={filterMessages} onChange={setFilterMessages} options={requirementMessageOptions} />
                </th>
                <th className="px-3 py-2">
                  <TableColumnFilter label="Priority" description={REQUIREMENT_COLUMN_HELP.priority} selected={filterPriorities} onChange={setFilterPriorities} options={requirementPriorityOptions} align="center" />
                </th>
                <th className="px-3 py-2 text-center">
                  <TableColumnFilter label="Enabled" description={REQUIREMENT_COLUMN_HELP.enabled} selected={filterStates} onChange={setFilterStates} options={requirementStateOptions} align="center" />
                </th>
                <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-400"><ColumnHeaderLabel label="Actions" description={REQUIREMENT_COLUMN_HELP.actions} align="right" /></th>
              </tr>
            </thead>
            <tbody>
              {showAdd && (
                <tr className="border-b border-amber-500/20 bg-amber-500/5">
                  <td className="px-3 py-2 align-middle">
                    <span className="font-mono text-[11px] text-slate-500">New</span>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={newForm.task_type}
                      onChange={e => setNewForm({ ...newForm, task_type: e.target.value })}
                      className="w-full min-w-[120px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                    >
                      <option value="">All task types</option>
                      {taskTypeOptions.map(taskType => <option key={taskType.value} value={taskType.value}>{taskType.label}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400">{sprintId ? 'override' : 'default'}</td>
                  <td className="px-3 py-2">
                    <OutcomeKeySelect
                      id="new-requirement-outcome"
                      label=""
                      value={newForm.outcome}
                      onChange={outcome => setNewForm({ ...newForm, outcome })}
                      options={outcomeOptions}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={newForm.field_name}
                      onChange={e => setNewForm({ ...newForm, field_name: e.target.value })}
                      disabled={requirementFieldsLoading || requirementFields.length === 0}
                      className="w-full min-w-[130px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white disabled:opacity-60"
                    >
                      {requirementFields.length === 0 && (
                        <option value="">{requirementFieldsLoading ? 'Loading fields...' : 'No gate fields configured'}</option>
                      )}
                      {requirementFields.map(field => <option key={field.key} value={field.key}>{formatRequirementFieldOption(field)}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex min-w-[150px] flex-col gap-1">
                      <select
                        value={newForm.requirement_type}
                        onChange={e => setNewForm({ ...newForm, requirement_type: e.target.value as 'required' | 'match' | 'from_status' })}
                        className="rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                      >
                        <option value="required">Required</option>
                        <option value="match">Match</option>
                        <option value="from_status">From Status</option>
                      </select>
                      {newForm.requirement_type !== 'required' && (
                        newForm.requirement_type === 'match' ? (
                          <select
                            value={newForm.match_field}
                            onChange={e => setNewForm({ ...newForm, match_field: e.target.value })}
                            disabled={requirementFieldsLoading || requirementFields.length === 0}
                            className="rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white disabled:opacity-60"
                          >
                            <option value="">Select field</option>
                            {requirementFields.map(field => <option key={field.key} value={field.key}>{formatRequirementFieldOption(field)}</option>)}
                          </select>
                        ) : (
                          <input
                            value={newForm.match_field}
                            onChange={e => setNewForm({ ...newForm, match_field: e.target.value })}
                            placeholder="Required status"
                            className="rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                          />
                        )
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={newForm.severity}
                      onChange={e => setNewForm({ ...newForm, severity: e.target.value as 'block' | 'warn' })}
                      className="rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                    >
                      <option value="block">block</option>
                      <option value="warn">warn</option>
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={newForm.message}
                      onChange={e => setNewForm({ ...newForm, message: e.target.value })}
                      placeholder="Message"
                      className="w-full min-w-[180px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input
                      type="number"
                      value={newForm.priority}
                      onChange={e => setNewForm({ ...newForm, priority: Number(e.target.value) })}
                      className="w-20 rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <TableEnabledSwitch checked label="New gate requirements are enabled by default" onChange={() => undefined} disabled />
                  </td>
                  <td className="px-3 py-2 text-right">
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
              {filteredReqs.map(req => {
                const editing = editingRequirementId === req.id;
                return (
                  <tr key={req.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="px-3 py-2 align-middle">
                      <span className="inline-flex rounded border border-slate-700/70 bg-slate-900/60 px-1.5 py-0.5 font-mono text-[11px] leading-5 text-slate-400">
                        #{req.id}
                      </span>
                    </td>
                    <td className="px-3 py-2">
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
                          className="w-full min-w-[120px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                        >
                          <option value="">All task types</option>
                          {taskTypeOptions.map(taskType => <option key={taskType.value} value={taskType.value}>{taskType.label}</option>)}
                        </select>
                      ) : req.task_type ? (
                        <Badge className="bg-amber-900/40 text-amber-300 text-xs">{getTaskTypeLabel(req.task_type)}</Badge>
                      ) : (
                        <span className="text-xs text-slate-500">All task types</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <ScopeBadge kind={req.scope_kind === 'sprint_override' ? 'sprint_override' : 'default_scope'} />
                    </td>
                    <td className="px-3 py-2">
                      {editing ? (
                        <OutcomeKeySelect
                          id={`edit-requirement-outcome-${req.id}`}
                          label=""
                          value={editForm.outcome}
                          onChange={outcome => setEditForm(form => ({ ...form, outcome }))}
                          options={editOutcomeOptions}
                        />
                      ) : (
                        <span className="font-mono text-xs text-amber-300">{req.outcome}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editing ? (
                        <select
                          value={editForm.field_name}
                          onChange={e => setEditForm(form => ({ ...form, field_name: e.target.value }))}
                          disabled={requirementFieldsLoading || requirementFields.length === 0}
                          className="w-full min-w-[130px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white disabled:opacity-60"
                        >
                          {requirementFields.map(field => <option key={field.key} value={field.key}>{formatRequirementFieldOption(field)}</option>)}
                        </select>
                      ) : (
                        <span className="font-mono text-xs text-slate-300">{req.field_name}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editing ? (
                        <div className="flex min-w-[150px] flex-col gap-1">
                          <select
                            value={editForm.requirement_type}
                            onChange={e => setEditForm(form => ({ ...form, requirement_type: e.target.value as 'required' | 'match' | 'from_status' }))}
                            className="rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                          >
                            <option value="required">Required</option>
                            <option value="match">Match</option>
                            <option value="from_status">From Status</option>
                          </select>
                          {editForm.requirement_type !== 'required' && (
                            editForm.requirement_type === 'match' ? (
                              <select
                                value={editForm.match_field}
                                onChange={e => setEditForm(form => ({ ...form, match_field: e.target.value }))}
                                disabled={requirementFieldsLoading || requirementFields.length === 0}
                                className="rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white disabled:opacity-60"
                              >
                                <option value="">Select field</option>
                                {requirementFields.map(field => <option key={field.key} value={field.key}>{formatRequirementFieldOption(field)}</option>)}
                              </select>
                            ) : (
                              <input
                                value={editForm.match_field}
                                onChange={e => setEditForm(form => ({ ...form, match_field: e.target.value }))}
                                placeholder="Required status"
                                className="rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                              />
                            )
                          )}
                        </div>
                      ) : (
                        <>
                          <Badge className={`${REQ_TYPE_BADGE[req.requirement_type] || 'bg-slate-700'} text-[10px]`}>
                            {req.requirement_type}
                          </Badge>
                          {req.match_field && <span className="ml-1 text-xs text-slate-500">→ {req.match_field}</span>}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editing ? (
                        <select
                          value={editForm.severity}
                          onChange={e => setEditForm(form => ({ ...form, severity: e.target.value as 'block' | 'warn' }))}
                          className="rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                        >
                          <option value="block">block</option>
                          <option value="warn">warn</option>
                        </select>
                      ) : (
                        <Badge className={`${SEVERITY_BADGE[req.severity] || 'bg-slate-700'} text-[10px]`}>
                          {req.severity}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editing ? (
                        <input
                          value={editForm.message}
                          onChange={e => setEditForm(form => ({ ...form, message: e.target.value }))}
                          className="w-full min-w-[180px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                        />
                      ) : (
                        <span className="block max-w-48 truncate text-xs text-slate-400">{req.message}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {editing ? (
                        <input
                          type="number"
                          value={editForm.priority}
                          onChange={e => setEditForm(form => ({ ...form, priority: Number(e.target.value) }))}
                          className="w-20 rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                        />
                      ) : (
                        <span className="font-mono text-xs text-slate-300">{req.priority ?? 0}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <TableEnabledSwitch
                        checked={Boolean(req.enabled)}
                        disabled={editing}
                        label={`${req.enabled ? 'Disable' : 'Enable'} gate requirement #${req.id}`}
                        onChange={() => void handleToggle(req)}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {editing ? (
                        <div className="flex justify-end gap-1">
                          <Button variant="primary" size="sm" onClick={() => handleSaveEdit(req.id)}>
                            <Check className="h-3 w-3" /> Save
                          </Button>
                          <button type="button" onClick={cancelEdit} className={TABLE_EDIT_ACTION_CLASS} title="Cancel">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex justify-end gap-1">
                          <button type="button" onClick={() => startEdit(req)} className={TABLE_EDIT_ACTION_CLASS} title="Edit gate requirement">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button type="button" onClick={() => handleDelete(req.id)} className={TABLE_DELETE_ACTION_CLASS} title="Delete gate requirement">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filteredReqs.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-3 py-6 text-center text-sm text-slate-500">
                    {reqs.length === 0 ? 'No transition requirements configured.' : 'No requirements match the current filters.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
