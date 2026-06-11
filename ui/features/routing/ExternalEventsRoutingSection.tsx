'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { api, type WorkflowEventMapping, type WorkflowOutcomeMeta, type TaskStatusMeta, type WorkflowTaskTypeMeta } from '@/lib/api';
import { getTaskTypeLabel } from '@/lib/taskTypes';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TableEnabledSwitch } from '@/components/TableEnabledSwitch';
import { SectionHeader, TABLE_DELETE_ACTION_CLASS, TABLE_EDIT_ACTION_CLASS } from '@/components/workflowConfig';
import { ColumnHeaderLabel } from '@/components/ui/table-column-help';
import { TableColumnFilter, matchesColumnFilter, uniqueColumnOptions } from '@/components/TableColumnFilter';

type MappingFormState = {
  project_scope: 'global' | 'project';
  source: string;
  event_name: string;
  task_type: string;
  status_includes: string;
  status_excludes: string;
  action_kind: 'ignore' | 'outcome' | 'status';
  action_target: string;
  apply_review_evidence: boolean;
  apply_failure_detail: boolean;
  enabled: boolean;
  priority: number;
};

const ACTION_KIND_OPTIONS: Array<{ value: MappingFormState['action_kind']; label: string }> = [
  { value: 'ignore', label: 'Ignore' },
  { value: 'outcome', label: 'Post outcome' },
  { value: 'status', label: 'Set status directly' },
];

const EVENT_MAPPING_COLUMN_HELP = {
  id: 'The canonical database ID for this workflow event mapping.',
  scope: 'Whether this event mapping is a workflow-type default or a workflow-specific override.',
  source: 'The system that sends the lifecycle event to Agent HQ.',
  event: 'The event name Agent HQ listens for.',
  taskType: 'The task type this event mapping can update.',
  includes: 'Task statuses where this mapping is allowed to run.',
  excludes: 'Task statuses where this mapping should not run.',
  action: 'What Agent HQ does when a matching event arrives.',
  evidence: 'Which review or failure details the event writes onto the task.',
  priority: 'Which matching event mapping wins when more than one could apply. Lower numbers run first.',
  enabled: 'Whether this event mapping is active.',
  actions: 'Edit or remove this event mapping.',
};

function emptyForm(projectId: number | null): MappingFormState {
  return {
    project_scope: projectId ? 'project' : 'global',
    source: 'dev_environment_lease_manager',
    event_name: '',
    task_type: '',
    status_includes: '',
    status_excludes: '',
    action_kind: 'status',
    action_target: 'dev_deploy_queued',
    apply_review_evidence: false,
    apply_failure_detail: false,
    enabled: true,
    priority: 100,
  };
}

function toCsv(values: string[] | null | undefined): string {
  return (values ?? []).join(', ');
}

function parseCsv(value: string): string[] {
  return [...new Set(value.split(',').map(entry => entry.trim()).filter(Boolean))];
}

function workflowScopeValue(mapping: WorkflowEventMapping): string {
  return mapping.scope_kind === 'sprint_override' ? 'sprint_override' : 'sprint_type_default';
}

function workflowScopeLabel(mapping: WorkflowEventMapping): string {
  return mapping.scope_kind === 'sprint_override' ? 'override' : 'default';
}

function sourceFilterValue(mapping: WorkflowEventMapping): string {
  return mapping.source ?? '__any_source__';
}

function taskTypeFilterValue(mapping: WorkflowEventMapping): string {
  return mapping.task_type ?? '__all__';
}

function statusFilterValues(values: string[] | null | undefined, emptyValue: string): string[] {
  return values && values.length > 0 ? values : [emptyValue];
}

function evidenceFilterValues(mapping: WorkflowEventMapping): string[] {
  const values = [
    mapping.apply_review_evidence ? 'review evidence' : null,
    mapping.apply_failure_detail ? 'failure detail' : null,
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values : ['none'];
}

function formFromMapping(mapping: WorkflowEventMapping, projectId: number | null): MappingFormState {
  return {
    project_scope: mapping.project_id != null && projectId != null && mapping.project_id === projectId ? 'project' : 'global',
    source: mapping.source ?? '',
    event_name: mapping.event_name,
    task_type: mapping.task_type ?? '',
    status_includes: toCsv(mapping.status_includes),
    status_excludes: toCsv(mapping.status_excludes),
    action_kind: mapping.action_kind,
    action_target: mapping.action_target ?? '',
    apply_review_evidence: Boolean(mapping.apply_review_evidence),
    apply_failure_detail: Boolean(mapping.apply_failure_detail),
    enabled: Boolean(mapping.enabled),
    priority: mapping.priority ?? 0,
  };
}

function buildPayload(form: MappingFormState, projectId: number | null, sprintId: number | null, sprintType: string | null): Partial<WorkflowEventMapping> {
  return {
    project_id: form.project_scope === 'project' && projectId ? projectId : null,
    sprint_id: sprintId,
    sprint_type: sprintId ? null : sprintType,
    source: form.source.trim() || null,
    event_name: form.event_name.trim(),
    task_type: form.task_type || null,
    status_includes: parseCsv(form.status_includes),
    status_excludes: parseCsv(form.status_excludes),
    action_kind: form.action_kind,
    action_target: form.action_kind === 'ignore' ? null : (form.action_target.trim() || null),
    apply_review_evidence: form.apply_review_evidence ? 1 : 0,
    apply_failure_detail: form.apply_failure_detail ? 1 : 0,
    enabled: form.enabled ? 1 : 0,
    priority: Number.isFinite(form.priority) ? form.priority : 0,
  };
}

function ActionTargetInput({
  actionKind,
  value,
  onChange,
  statusOptions,
  outcomeOptions,
}: {
  actionKind: MappingFormState['action_kind'];
  value: string;
  onChange: (value: string) => void;
  statusOptions: string[];
  outcomeOptions: string[];
}) {
  if (actionKind === 'ignore') {
    return <span className="text-xs text-slate-500">No workflow action</span>;
  }

  const options = actionKind === 'status' ? statusOptions : outcomeOptions;
  const placeholder = actionKind === 'status' ? 'Select status…' : 'Select outcome…';

  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={options.length === 0}
      className="w-full min-w-[150px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
    >
      <option value="">{options.length > 0 ? placeholder : 'No options for selected context'}</option>
      {value && !options.includes(value) ? (
        <option value={value} disabled>{value} (not in selected context)</option>
      ) : null}
      {options.map(option => (
        <option key={option} value={option}>{option}</option>
      ))}
    </select>
  );
}

function ScopeBadge({ mapping }: { mapping: WorkflowEventMapping }) {
  if (mapping.scope_kind === 'sprint_override') {
    return <Badge className="bg-amber-900/40 text-amber-300 text-xs">override</Badge>;
  }
  return <Badge className="bg-slate-700 text-slate-200 text-xs">default</Badge>;
}

export function ExternalEventsRoutingSection({
  projectId,
  projectName,
  sprintId,
  sprintType,
}: {
  projectId: number | null;
  projectName: string | null;
  sprintId: number | null;
  sprintType: string | null;
}) {
  const [mappings, setMappings] = useState<WorkflowEventMapping[]>([]);
  const [statusOptions, setStatusOptions] = useState<TaskStatusMeta[]>([]);
  const [outcomeOptions, setOutcomeOptions] = useState<WorkflowOutcomeMeta[]>([]);
  const [taskTypeOptions, setTaskTypeOptions] = useState<WorkflowTaskTypeMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newForm, setNewForm] = useState<MappingFormState>(() => emptyForm(projectId));
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<MappingFormState>(() => emptyForm(projectId));
  const [filterScopes, setFilterScopes] = useState<string[]>([]);
  const [filterSources, setFilterSources] = useState<string[]>([]);
  const [filterEvents, setFilterEvents] = useState<string[]>([]);
  const [filterTaskTypes, setFilterTaskTypes] = useState<string[]>([]);
  const [filterIncludes, setFilterIncludes] = useState<string[]>([]);
  const [filterExcludes, setFilterExcludes] = useState<string[]>([]);
  const [filterActionKinds, setFilterActionKinds] = useState<string[]>([]);
  const [filterEvidence, setFilterEvidence] = useState<string[]>([]);
  const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
  const [filterEnabled, setFilterEnabled] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mappingResponse, workflowMetadata] = await Promise.all([
        api.getWorkflowEventMappings(projectId ?? undefined, sprintId ?? undefined, sprintType ?? undefined),
        sprintId || sprintType ? api.getWorkflowMetadata(sprintId ? { sprint_id: sprintId } : { sprint_type: sprintType }) : Promise.resolve({ statuses: [], outcomes: [], task_types: [] }),
      ]);
      setMappings(mappingResponse.mappings ?? []);
      setStatusOptions(workflowMetadata.statuses ?? []);
      setOutcomeOptions(workflowMetadata.outcomes ?? []);
      setTaskTypeOptions(workflowMetadata.task_types ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMappings([]);
      setStatusOptions([]);
      setOutcomeOptions([]);
      setTaskTypeOptions([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, sprintId, sprintType]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setNewForm(emptyForm(projectId));
    setEditingId(null);
  }, [projectId, sprintId, sprintType]);

  const statusKeys = useMemo(
    () => Array.from(new Set(statusOptions.map(status => status.name).filter(Boolean))),
    [statusOptions],
  );
  const outcomeKeys = useMemo(
    () => Array.from(new Set(outcomeOptions.filter(outcome => outcome.enabled !== 0 && outcome.behavior !== 'disable').map(outcome => outcome.outcome_key))),
    [outcomeOptions],
  );
  const scopeOptions = useMemo(() => uniqueColumnOptions(
    mappings.map(mapping => ({
      value: workflowScopeValue(mapping),
      label: workflowScopeLabel(mapping),
    })),
  ), [mappings]);
  const sourceOptions = useMemo(() => uniqueColumnOptions(
    mappings.map(mapping => ({
      value: sourceFilterValue(mapping),
      label: mapping.source ?? 'Any source',
    })),
  ), [mappings]);
  const eventOptions = useMemo(() => uniqueColumnOptions(
    mappings.map(mapping => ({ value: mapping.event_name, label: mapping.event_name })),
  ), [mappings]);
  const taskTypeFilterOptions = useMemo(() => uniqueColumnOptions(
    mappings.map(mapping => ({
      value: taskTypeFilterValue(mapping),
      label: mapping.task_type ? getTaskTypeLabel(mapping.task_type) : 'All types',
    })),
  ), [mappings]);
  const includesOptions = useMemo(() => uniqueColumnOptions(
    mappings.flatMap(mapping => statusFilterValues(mapping.status_includes, '__any_status__').map(value => ({
      value,
      label: value === '__any_status__' ? 'Any' : value,
    }))),
  ), [mappings]);
  const excludesOptions = useMemo(() => uniqueColumnOptions(
    mappings.flatMap(mapping => statusFilterValues(mapping.status_excludes, '__none__').map(value => ({
      value,
      label: value === '__none__' ? 'None' : value,
    }))),
  ), [mappings]);
  const actionKindOptions = useMemo(() => uniqueColumnOptions(
    mappings.map(mapping => ({ value: mapping.action_kind, label: mapping.action_kind })),
  ), [mappings]);
  const evidenceOptions = useMemo(() => ([
    { value: 'review evidence', label: 'review evidence' },
    { value: 'failure detail', label: 'failure detail' },
    { value: 'none', label: 'none' },
  ]), []);
  const priorityOptions = useMemo(() => uniqueColumnOptions(
    mappings.map(mapping => ({ value: String(mapping.priority ?? 0), label: String(mapping.priority ?? 0) })),
  ), [mappings]);
  const enabledOptions = useMemo(() => ([
    { value: 'yes', label: 'yes' },
    { value: 'no', label: 'no' },
  ]), []);
  const filteredMappings = useMemo(() => mappings.filter(mapping => (
    matchesColumnFilter(filterScopes, workflowScopeValue(mapping))
    && matchesColumnFilter(filterSources, sourceFilterValue(mapping))
    && matchesColumnFilter(filterEvents, mapping.event_name)
    && matchesColumnFilter(filterTaskTypes, taskTypeFilterValue(mapping))
    && statusFilterValues(mapping.status_includes, '__any_status__').some(value => matchesColumnFilter(filterIncludes, value))
    && statusFilterValues(mapping.status_excludes, '__none__').some(value => matchesColumnFilter(filterExcludes, value))
    && matchesColumnFilter(filterActionKinds, mapping.action_kind)
    && evidenceFilterValues(mapping).some(value => matchesColumnFilter(filterEvidence, value))
    && matchesColumnFilter(filterPriorities, String(mapping.priority ?? 0))
    && matchesColumnFilter(filterEnabled, mapping.enabled ? 'yes' : 'no')
  )), [
    filterActionKinds,
    filterEnabled,
    filterEvents,
    filterEvidence,
    filterExcludes,
    filterIncludes,
    filterPriorities,
    filterScopes,
    filterSources,
    filterTaskTypes,
    mappings,
  ]);

  const getDefaultActionTarget = useCallback((actionKind: MappingFormState['action_kind']) => {
    if (actionKind === 'status') return statusKeys[0] ?? '';
    if (actionKind === 'outcome') return outcomeKeys[0] ?? '';
    return '';
  }, [outcomeKeys, statusKeys]);

  const isActionTargetValid = useCallback((form: MappingFormState) => {
    if (form.action_kind === 'ignore') return true;
    const options = form.action_kind === 'status' ? statusKeys : outcomeKeys;
    return options.includes(form.action_target);
  }, [outcomeKeys, statusKeys]);

  useEffect(() => {
    setNewForm(current => {
      if (current.action_kind === 'ignore' || isActionTargetValid(current)) return current;
      return { ...current, action_target: getDefaultActionTarget(current.action_kind) };
    });
  }, [getDefaultActionTarget, isActionTargetValid]);

  const startEdit = (mapping: WorkflowEventMapping) => {
    setEditingId(mapping.id);
    setEditForm(formFromMapping(mapping, projectId));
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setError(null);
  };

  const handleAdd = async () => {
    setSaving(true);
    try {
      await api.createWorkflowEventMapping(buildPayload(newForm, projectId, sprintId, sprintType));
      setShowAdd(false);
      setNewForm(emptyForm(projectId));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEdit = async (id: number) => {
    setSaving(true);
    try {
      await api.updateWorkflowEventMapping(id, buildPayload(editForm, projectId, sprintId, sprintType));
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this workflow event mapping?')) return;
    try {
      await api.deleteWorkflowEventMapping(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggle = async (mapping: WorkflowEventMapping) => {
    setSaving(true);
    try {
      await api.updateWorkflowEventMapping(mapping.id, { enabled: mapping.enabled ? 0 : 1 });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const renderFormRow = (form: MappingFormState, setForm: (value: MappingFormState) => void, mode: 'add' | 'edit', id?: number) => (
    <tr className="border-b border-amber-500/20 bg-amber-500/5">
      <td className="px-3 py-2.5 align-middle">
        <span className="font-mono text-[11px] text-slate-500">{mode === 'add' ? 'New' : id != null ? `#${id}` : '-'}</span>
      </td>
      <td className="px-3 py-2.5">
        <select
          value={form.task_type}
          onChange={e => setForm({ ...form, task_type: e.target.value })}
          className="w-full min-w-[130px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
        >
          <option value="">All types</option>
          {taskTypeOptions.map(taskType => (
            <option key={taskType.value} value={taskType.value}>{taskType.label || getTaskTypeLabel(taskType.value)}</option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2.5">
        <div className="mb-1 text-[11px] text-slate-500">{sprintId ? 'Workflow override' : 'Workflow default'}</div>
        <select
          value={form.project_scope}
          onChange={e => setForm({ ...form, project_scope: e.target.value as 'global' | 'project' })}
          className="w-full min-w-[120px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
          disabled={!projectId}
        >
          <option value="global">Global</option>
          <option value="project" disabled={!projectId}>{projectName ? `${projectName} only` : 'Selected project only'}</option>
        </select>
      </td>
      <td className="px-3 py-2.5">
        <input
          value={form.source}
          onChange={e => setForm({ ...form, source: e.target.value })}
          placeholder="Any source"
          className="w-full min-w-[170px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
        />
      </td>
      <td className="px-3 py-2.5">
        <input
          value={form.event_name}
          onChange={e => setForm({ ...form, event_name: e.target.value })}
          placeholder="deploy_failed"
          className="w-full min-w-[180px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
        />
      </td>
      <td className="px-3 py-2.5">
        <input
          value={form.status_includes}
          onChange={e => setForm({ ...form, status_includes: e.target.value })}
          placeholder="in_progress, dev_deploying"
          className="w-full min-w-[170px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
        />
      </td>
      <td className="px-3 py-2.5">
        <input
          value={form.status_excludes}
          onChange={e => setForm({ ...form, status_excludes: e.target.value })}
          placeholder="done, cancelled"
          className="w-full min-w-[170px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
        />
      </td>
      <td className="px-3 py-2.5">
        <div className="flex min-w-[220px] flex-col gap-2">
          <select
            value={form.action_kind}
            onChange={e => {
              const action_kind = e.target.value as MappingFormState['action_kind'];
              const options = action_kind === 'status' ? statusKeys : action_kind === 'outcome' ? outcomeKeys : [];
              setForm({
                ...form,
                action_kind,
                action_target: action_kind === 'ignore'
                  ? ''
                  : options.includes(form.action_target)
                    ? form.action_target
                    : getDefaultActionTarget(action_kind),
              });
            }}
            className="rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
          >
            {ACTION_KIND_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <ActionTargetInput
            actionKind={form.action_kind}
            value={form.action_target}
            onChange={action_target => setForm({ ...form, action_target })}
            statusOptions={statusKeys}
            outcomeOptions={outcomeKeys}
          />
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex min-w-[160px] flex-col gap-1 text-xs text-slate-300">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.apply_review_evidence}
              onChange={e => setForm({ ...form, apply_review_evidence: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 text-amber-500"
            />
            Review evidence
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.apply_failure_detail}
              onChange={e => setForm({ ...form, apply_failure_detail: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 text-amber-500"
            />
            Failure detail
          </label>
        </div>
      </td>
      <td className="px-3 py-2.5 text-center">
        <input
          type="number"
          value={form.priority}
          onChange={e => setForm({ ...form, priority: Number(e.target.value) })}
          className="w-20 rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
        />
      </td>
      <td className="px-3 py-2.5 text-center">
        <TableEnabledSwitch
          checked={form.enabled}
          label={`${form.enabled ? 'Disable' : 'Enable'} workflow event mapping`}
          onChange={() => setForm({ ...form, enabled: !form.enabled })}
        />
      </td>
      <td className="px-3 py-2.5 text-right">
        <div className="flex justify-end gap-1">
          <Button
            variant="primary"
            size="sm"
            onClick={() => mode === 'add' ? void handleAdd() : id != null ? void handleSaveEdit(id) : undefined}
            loading={saving}
            disabled={!form.event_name.trim() || !isActionTargetValid(form)}
          >
            <Check className="h-3 w-3" /> {mode === 'add' ? 'Add' : 'Save'}
          </Button>
          <button
            type="button"
            onClick={() => mode === 'add' ? setShowAdd(false) : cancelEdit()}
            className={TABLE_EDIT_ACTION_CLASS}
            title="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        label="Workflow Events"
        help="Workflow events from Agent HQ runtime or trusted external systems map lifecycle signals to Agent HQ workflow actions such as posting outcomes, setting statuses, or ignoring events."
        actions={(
          <>
            <span className="text-xs text-slate-500">{mappings.length} mapping{mappings.length !== 1 ? 's' : ''}</span>
            <Button variant="secondary" size="sm" onClick={() => setShowAdd(value => !value)} disabled={showAdd}>
              <Plus className="h-3.5 w-3.5" /> Add Mapping
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </>
        )}
      />

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-700/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <Card className="border-slate-700/50 bg-slate-800/60 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px] text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left">
                <th className="w-20 px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-400"><ColumnHeaderLabel label="ID" description={EVENT_MAPPING_COLUMN_HELP.id} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Task Type" description={EVENT_MAPPING_COLUMN_HELP.taskType} selected={filterTaskTypes} onChange={setFilterTaskTypes} options={taskTypeFilterOptions} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Scope" description={EVENT_MAPPING_COLUMN_HELP.scope} selected={filterScopes} onChange={setFilterScopes} options={scopeOptions} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Source" description={EVENT_MAPPING_COLUMN_HELP.source} selected={filterSources} onChange={setFilterSources} options={sourceOptions} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Event" description={EVENT_MAPPING_COLUMN_HELP.event} selected={filterEvents} onChange={setFilterEvents} options={eventOptions} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Includes" description={EVENT_MAPPING_COLUMN_HELP.includes} selected={filterIncludes} onChange={setFilterIncludes} options={includesOptions} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Excludes" description={EVENT_MAPPING_COLUMN_HELP.excludes} selected={filterExcludes} onChange={setFilterExcludes} options={excludesOptions} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Action" description={EVENT_MAPPING_COLUMN_HELP.action} selected={filterActionKinds} onChange={setFilterActionKinds} options={actionKindOptions} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Evidence" description={EVENT_MAPPING_COLUMN_HELP.evidence} selected={filterEvidence} onChange={setFilterEvidence} options={evidenceOptions} /></th>
                <th className="px-3 py-2.5 text-center"><TableColumnFilter label="Priority" description={EVENT_MAPPING_COLUMN_HELP.priority} selected={filterPriorities} onChange={setFilterPriorities} options={priorityOptions} align="center" /></th>
                <th className="px-3 py-2.5 text-center"><TableColumnFilter label="Enabled" description={EVENT_MAPPING_COLUMN_HELP.enabled} selected={filterEnabled} onChange={setFilterEnabled} options={enabledOptions} align="center" /></th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-slate-400"><ColumnHeaderLabel label="Actions" description={EVENT_MAPPING_COLUMN_HELP.actions} align="right" /></th>
              </tr>
            </thead>
            <tbody>
              {showAdd && renderFormRow(newForm, setNewForm, 'add')}
              {filteredMappings.map(mapping => {
                const editing = editingId === mapping.id;
                if (editing) return renderFormRow(editForm, setEditForm, 'edit', mapping.id);
                return (
                  <tr key={mapping.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="px-3 py-2.5 align-middle">
                      <span className="inline-flex rounded border border-slate-700/70 bg-slate-900/60 px-1.5 py-0.5 font-mono text-[11px] leading-5 text-slate-400">
                        #{mapping.id}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {mapping.task_type ? <Badge className="bg-indigo-900/40 text-indigo-300 text-xs">{getTaskTypeLabel(mapping.task_type)}</Badge> : <span className="text-xs text-slate-500">All types</span>}
                    </td>
                    <td className="px-3 py-2.5"><ScopeBadge mapping={mapping} /></td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col gap-1">
                        {mapping.source ? <span className="font-mono text-xs text-slate-300">{mapping.source}</span> : <span className="text-xs text-slate-500">Any source</span>}
                        {mapping.source_label ? <span className="text-[10px] uppercase tracking-wide text-slate-500">{mapping.source_label}</span> : null}
                      </div>
                    </td>
                    <td className="px-3 py-2.5"><span className="font-mono text-xs text-amber-300">{mapping.event_name}</span></td>
                    <td className="px-3 py-2.5"><span className="text-xs text-slate-300">{mapping.status_includes.length > 0 ? mapping.status_includes.join(', ') : 'Any'}</span></td>
                    <td className="px-3 py-2.5"><span className="text-xs text-slate-400">{mapping.status_excludes.length > 0 ? mapping.status_excludes.join(', ') : 'None'}</span></td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col gap-1">
                        <Badge className="w-fit bg-slate-700 text-slate-200 text-[10px] uppercase">{mapping.action_kind}</Badge>
                        <span className="font-mono text-xs text-slate-300">{mapping.action_target ?? '—'}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {mapping.apply_review_evidence ? <Badge className="bg-blue-900/40 text-blue-300 text-[10px]">review evidence</Badge> : null}
                        {mapping.apply_failure_detail ? <Badge className="bg-red-900/40 text-red-300 text-[10px]">failure detail</Badge> : null}
                        {!mapping.apply_review_evidence && !mapping.apply_failure_detail ? <span className="text-xs text-slate-500">No evidence updates</span> : null}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-center"><span className="font-mono text-xs text-slate-300">{mapping.priority ?? 0}</span></td>
                    <td className="px-3 py-2.5 text-center">
                      <TableEnabledSwitch
                        checked={Boolean(mapping.enabled)}
                        disabled={saving}
                        label={`${mapping.enabled ? 'Disable' : 'Enable'} workflow event mapping #${mapping.id}`}
                        onChange={() => void handleToggle(mapping)}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex justify-end gap-1">
                        <button type="button" onClick={() => startEdit(mapping)} className={TABLE_EDIT_ACTION_CLASS} title="Edit mapping">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={() => void handleDelete(mapping.id)} className={TABLE_DELETE_ACTION_CLASS} title="Delete mapping">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {mappings.length === 0 && !showAdd && (
                <tr>
                  <td colSpan={12} className="px-3 py-8 text-center text-sm text-slate-500">
                    No workflow event mappings found for the current scope.
                  </td>
                </tr>
              )}
              {filteredMappings.length === 0 && mappings.length > 0 && !showAdd && (
                <tr>
                  <td colSpan={12} className="px-3 py-8 text-center text-sm text-slate-500">
                    No workflow event mappings match the current filters.
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

export default ExternalEventsRoutingSection;
