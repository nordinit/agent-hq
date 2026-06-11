'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type TaskRoutingRule, type TaskStatusMeta } from '@/lib/api';
import { useTaskTypes } from '@/lib/taskTypes';
import { useWorkflowMetadata } from '@/lib/useWorkflowMetadata';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TableEnabledSwitch } from '@/components/TableEnabledSwitch';
import { COLOR_BADGE_CLASSES, RoutingWarningBanner, ScopeBadge, SectionHeader, TABLE_DELETE_ACTION_CLASS, TABLE_EDIT_ACTION_CLASS } from '@/components/workflowConfig';
import { ColumnHeaderLabel } from '@/components/ui/table-column-help';
import { TableColumnFilter, matchesColumnFilter, uniqueColumnOptions } from '@/components/TableColumnFilter';
import { Check, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { getRoutingTaskTypeBadgeClass, getRoutingTaskTypeLabel, parseRoutingRulePriority, ROUTING_RULE_COLUMN_HELP, ROUTING_TABLE_HELP } from '../workflowConfigShared';

export default function RoutingRulesSection({
  projectId,
  sprintId,
  sprintName,
  sprintType,
}: {
  projectId: number | null;
  sprintId: number | null;
  sprintName: string | null;
  sprintType: string | null;
}) {
  const [rules, setRules] = useState<TaskRoutingRule[]>([]);
  const [agentsList, setAgentsList] = useState<{ id: number; name: string }[]>([]);
  const [statusCatalog, setStatusCatalog] = useState<TaskStatusMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterTaskTypes, setFilterTaskTypes] = useState<string[]>([]);
  const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
  const [filterAgentIds, setFilterAgentIds] = useState<string[]>([]);
  const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
  const [filterStates, setFilterStates] = useState<string[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newForm, setNewForm] = useState({
    task_type: '__all__',
    status: '',
    agent_id: '' as number | '',
    priority: '0',
  });
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({
    task_type: '__all__',
    status: '',
    agent_id: '' as number | '',
    priority: '0',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { metadata: workflowMetadata } = useWorkflowMetadata(sprintId ?? undefined);

  const { options: sprintTaskTypeOptions } = useTaskTypes(sprintId);
  const { options: globalTaskTypeOptions } = useTaskTypes();
  const taskTypeOptions = useMemo(() => [{ value: '__all__', label: 'All task types' }, ...(sprintTaskTypeOptions.length > 0 ? sprintTaskTypeOptions : globalTaskTypeOptions)], [globalTaskTypeOptions, sprintTaskTypeOptions]);

  const TYPE_BADGE: Record<string, string> = {
    frontend: 'bg-blue-900/60 text-blue-300',
    backend: 'bg-green-900/60 text-green-300',
    fullstack: 'bg-indigo-900/60 text-indigo-300',
    qa: 'bg-purple-900/60 text-purple-300',
    design: 'bg-pink-900/60 text-pink-300',
    marketing: 'bg-amber-900/60 text-amber-300',
    pm: 'bg-slate-600 text-slate-200',
    ops: 'bg-orange-900/60 text-orange-300',
    data: 'bg-cyan-900/60 text-cyan-300',
    other: 'bg-slate-700 text-slate-300',
  };

  const taskTypeFilterOptions = useMemo(() => {
    const options = new Map(taskTypeOptions.map(option => [option.value, option.label]));
    for (const rule of rules) {
      const key = rule.task_type ?? '__all__';
      if (!options.has(key)) options.set(key, getRoutingTaskTypeLabel(rule.task_type));
    }
    return Array.from(options, ([value, label]) => ({ value, label }));
  }, [rules, taskTypeOptions]);

  const statusFilterOptions = useMemo(() => {
    const options = new Map(statusCatalog.map(status => [status.name, status.label || status.name]));
    for (const rule of rules) {
      if (!options.has(rule.status)) options.set(rule.status, rule.status);
    }
    return Array.from(options, ([value, label]) => ({ value, label }));
  }, [rules, statusCatalog]);

  const addStatusOptions = useMemo(() => (
    statusCatalog.map(status => ({ value: status.name, label: status.label || status.name }))
  ), [statusCatalog]);

  const statusBadgeClasses = useMemo(() => {
    const badges: Record<string, string> = {};
    for (const status of statusCatalog) {
      badges[status.name] = COLOR_BADGE_CLASSES[status.color] ?? 'bg-slate-700 text-slate-300';
    }
    return badges;
  }, [statusCatalog]);
  const routingWarnings = workflowMetadata.routing_warnings ?? [];

  const priorityFilterOptions = useMemo(() => (
    uniqueColumnOptions(rules.map(rule => ({
      value: String(rule.priority ?? 0),
      label: String(rule.priority ?? 0),
    })))
  ), [rules]);
  const stateFilterOptions = useMemo(() => ([
    { value: 'enabled', label: 'Enabled' },
    { value: 'disabled', label: 'Disabled' },
  ]), []);

  const filteredRules = useMemo(() => rules.filter(rule => (
    matchesColumnFilter(filterTaskTypes, rule.task_type ?? '__all__')
    && matchesColumnFilter(filterStatuses, rule.status)
    && matchesColumnFilter(filterAgentIds, String(rule.agent_id))
    && matchesColumnFilter(filterPriorities, String(rule.priority ?? 0))
    && matchesColumnFilter(filterStates, rule.enabled ? 'enabled' : 'disabled')
  )), [rules, filterTaskTypes, filterStatuses, filterAgentIds, filterPriorities, filterStates]);

  const load = useCallback(() => {
    if (!sprintType) {
      setRules([]);
      setAgentsList([]);
      setStatusCatalog([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      api.getRoutingRules(projectId ?? undefined, sprintId ?? undefined, sprintType),
      api.getAgents(projectId ?? undefined),
      api.getWorkflowMetadata(sprintId ? { sprint_id: sprintId } : { sprint_type: sprintType }),
    ])
      .then(([r, a, statuses]) => {
        setRules(r.rules);
        setAgentsList(a.map(ag => ({ id: ag.id, name: ag.name })));
        setStatusCatalog(statuses.statuses);
      })
      .catch(e => console.error(e))
      .finally(() => setLoading(false));
  }, [projectId, sprintId, sprintType]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setNewForm(current => {
      const nextTaskType = taskTypeOptions.some(option => option.value === current.task_type)
        ? current.task_type
        : taskTypeOptions[0]?.value ?? current.task_type;
      const nextStatus = addStatusOptions.some(option => option.value === current.status)
        ? current.status
        : addStatusOptions[0]?.value ?? current.status;
      const nextAgentId = agentsList.some(agent => agent.id === current.agent_id) ? current.agent_id : '';
      if (nextTaskType === current.task_type && nextStatus === current.status && nextAgentId === current.agent_id) return current;
      return {
        ...current,
        task_type: nextTaskType,
        status: nextStatus,
        agent_id: nextAgentId,
      };
    });
  }, [addStatusOptions, agentsList, taskTypeOptions]);

  const handleAdd = async () => {
    if (!newForm.agent_id) {
      setError('Agent is required');
      return;
    }
    if (taskTypeOptions.length > 0 && !taskTypeOptions.some(option => option.value === newForm.task_type)) {
      setError('Select a task type allowed for this workflow');
      return;
    }
    if (addStatusOptions.length > 0 && !addStatusOptions.some(option => option.value === newForm.status)) {
      setError('Select a status configured for this workflow');
      return;
    }
    const priority = parseRoutingRulePriority(newForm.priority);
    if (priority === null) {
      setError('priority must be a number');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.createRoutingRule({
        project_id: projectId ?? undefined,
        sprint_id: sprintId ?? undefined,
        sprint_type: sprintType ?? undefined,
        task_type: newForm.task_type === '__all__' ? null : newForm.task_type,
        status: newForm.status,
        agent_id: Number(newForm.agent_id),
        priority,
      });
      setShowAdd(false);
      setNewForm({
        task_type: taskTypeOptions[0]?.value ?? '__all__',
        status: addStatusOptions[0]?.value ?? '',
        agent_id: '',
        priority: '0',
      });
      load();
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (rule: TaskRoutingRule) => {
    setEditingRuleId(rule.id);
    setError(null);
    setEditForm({
      task_type: rule.task_type ?? '__all__',
      status: rule.status,
      agent_id: rule.agent_id,
      priority: String(rule.priority ?? 0),
    });
  };

  const cancelEdit = () => {
    setEditingRuleId(null);
    setError(null);
  };

  const handleSaveEdit = async (id: number) => {
    if (!editForm.agent_id) {
      setError('Agent is required');
      return;
    }
    if (!taskTypeOptions.some(option => option.value === editForm.task_type)) {
      setError('Select a task type allowed for this workflow');
      return;
    }
    if (!addStatusOptions.some(option => option.value === editForm.status)) {
      setError('Select a status configured for this workflow');
      return;
    }
    const priority = parseRoutingRulePriority(editForm.priority);
    if (priority === null) {
      setError('priority must be a number');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.updateRoutingRule(id, {
        project_id: projectId ?? undefined,
        sprint_id: sprintId ?? undefined,
        sprint_type: sprintType ?? undefined,
        task_type: editForm.task_type === '__all__' ? null : editForm.task_type,
        status: editForm.status,
        agent_id: Number(editForm.agent_id),
        priority,
      });
      setEditingRuleId(null);
      load();
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this assignment rule?')) return;
    try {
      await api.deleteRoutingRule(id, sprintId ?? undefined, projectId ?? undefined);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleToggle = async (rule: TaskRoutingRule) => {
    try {
      await api.updateRoutingRule(rule.id, {
        project_id: projectId ?? undefined,
        sprint_id: rule.sprint_id ?? sprintId ?? undefined,
        sprint_type: rule.sprint_type ?? sprintType ?? undefined,
        enabled: rule.enabled ? 0 : 1,
      });
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-32">
      <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (!sprintType) {
    return (
      <Card className="bg-slate-900/50 border-slate-700/50 p-6 text-sm text-slate-400">
        Select a workflow type to view all-project defaults, or choose a project to edit project-scoped defaults and workflow overrides.
      </Card>
    );
  }

  return (
    <div className="space-y-4" data-tour-target="routing-rules">
      <RoutingWarningBanner warnings={routingWarnings} scopeLabel={sprintName ?? 'This workflow'} />
      <SectionHeader
        label="Assignment Rules"
        help={`${ROUTING_TABLE_HELP.rules} Choose All task types when the rule should apply regardless of backend, frontend, QA, or other task-type-specific scopes.`}
        actions={(
          <>
            <span className="text-xs text-slate-500">{filteredRules.length} of {rules.length} rule{rules.length !== 1 ? 's' : ''}</span>
          <Button variant="secondary" size="sm" onClick={() => setShowAdd(!showAdd)}>
            <Plus className="w-3.5 h-3.5" /> Add Rule
          </Button>
          <Button variant="ghost" size="sm" onClick={() => load()}>
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </Button>
          </>
        )}
      />

      {/* Rules Table */}
      <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left">
                <th className="w-20 px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  <ColumnHeaderLabel label="ID" description={ROUTING_RULE_COLUMN_HELP.id} />
                </th>
                <th className="px-3 py-2.5">
                  <TableColumnFilter label="Task Type" description={ROUTING_RULE_COLUMN_HELP.taskType} selected={filterTaskTypes} onChange={setFilterTaskTypes} options={taskTypeFilterOptions} />
                </th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider"><ColumnHeaderLabel label="Scope" description={ROUTING_RULE_COLUMN_HELP.scope} /></th>
                <th className="px-3 py-2.5">
                  <TableColumnFilter label="When Status" description={ROUTING_RULE_COLUMN_HELP.status} selected={filterStatuses} onChange={setFilterStatuses} options={statusFilterOptions} />
                </th>
                <th className="px-3 py-2.5">
                  <TableColumnFilter label="Priority" description={ROUTING_RULE_COLUMN_HELP.priority} selected={filterPriorities} onChange={setFilterPriorities} options={priorityFilterOptions} />
                </th>
                <th className="px-3 py-2.5">
                  <TableColumnFilter
                    label="Assigned Agent"
                    description={ROUTING_RULE_COLUMN_HELP.agent}
                    selected={filterAgentIds}
                    onChange={setFilterAgentIds}
                    options={agentsList.map(agent => ({ value: String(agent.id), label: agent.name }))}
                  />
                </th>
                <th className="px-3 py-2.5 text-center">
                  <TableColumnFilter label="Enabled" description="Whether this routing rule can assign matching work." selected={filterStates} onChange={setFilterStates} options={stateFilterOptions} align="center" />
                </th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider text-right"><ColumnHeaderLabel label="Actions" description={ROUTING_RULE_COLUMN_HELP.actions} align="right" /></th>
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
                      disabled={taskTypeOptions.length === 0}
                    >
                      {taskTypeOptions.map(taskType => (
                        <option key={taskType.value} value={taskType.value}>{taskType.label}</option>
                      ))}
                      {taskTypeOptions.length === 0 && <option value="">No workflow task types</option>}
                    </select>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-400">{`${sprintId ? 'Workflow override' : 'Workflow-type default'}${newForm.task_type === '__all__' ? ' • All task types' : ''}`}</td>
                  <td className="px-3 py-2.5">
                    <select
                      value={newForm.status}
                      onChange={e => setNewForm({ ...newForm, status: e.target.value })}
                      className="w-full min-w-[150px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                      disabled={addStatusOptions.length === 0}
                    >
                      {addStatusOptions.map(status => <option key={status.value} value={status.value}>{status.label}</option>)}
                      {addStatusOptions.length === 0 && <option value="">No task statuses</option>}
                    </select>
                  </td>
                  <td className="px-3 py-2.5">
                    <input
                      type="text"
                      autoComplete="off"
                      value={newForm.priority}
                      onChange={e => {
                        setError(null);
                        setNewForm({ ...newForm, priority: e.target.value });
                      }}
                      className="w-24 rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <select
                      value={newForm.agent_id}
                      onChange={e => setNewForm({ ...newForm, agent_id: e.target.value === '' ? '' : Number(e.target.value) })}
                      className="w-full min-w-[180px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                      disabled={agentsList.length === 0}
                    >
                      <option value="">{agentsList.length === 0 ? 'No project agents' : 'Select agent…'}</option>
                      {agentsList.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <TableEnabledSwitch checked label="New routing rules are enabled by default" onChange={() => undefined} disabled />
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex flex-col items-end gap-1">
                      <div className="flex justify-end gap-1">
                        <Button onClick={handleAdd} size="sm" variant="primary" loading={saving}>
                          <Check className="h-3 w-3" /> Add
                        </Button>
                        <button type="button" onClick={() => { setShowAdd(false); setError(null); }} className={TABLE_EDIT_ACTION_CLASS} title="Cancel">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {error && <span className="text-right text-[10px] text-red-400">{error}</span>}
                    </div>
                  </td>
                </tr>
              )}
              {filteredRules.map(rule => {
                const editing = editingRuleId === rule.id;
                return (
                  <tr key={rule.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="px-3 py-2.5 align-middle">
                      <span className="inline-flex rounded border border-slate-700/70 bg-slate-900/60 px-1.5 py-0.5 font-mono text-[11px] leading-5 text-slate-400">
                        #{rule.id}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {editing ? (
                        <select
                          value={editForm.task_type}
                          onChange={e => setEditForm(form => ({ ...form, task_type: e.target.value }))}
                          className="w-full min-w-[150px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                        >
                          {taskTypeOptions.map(taskType => (
                            <option key={taskType.value} value={taskType.value}>{taskType.label}</option>
                          ))}
                        </select>
                      ) : (
                        <Badge className={`${getRoutingTaskTypeBadgeClass(rule.task_type, TYPE_BADGE)} text-xs`}>
                          {getRoutingTaskTypeLabel(rule.task_type)}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <ScopeBadge kind={rule.scope_kind === 'sprint_type_default' ? 'default_scope' : rule.scope_kind} />
                    </td>
                    <td className="px-3 py-2.5">
                      {editing ? (
                        <select
                          value={editForm.status}
                          onChange={e => setEditForm(form => ({ ...form, status: e.target.value }))}
                          className="w-full min-w-[150px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                        >
                          {addStatusOptions.map(status => <option key={status.value} value={status.value}>{status.label}</option>)}
                        </select>
                      ) : (
                        <Badge className={`${statusBadgeClasses[rule.status] || 'bg-slate-700 text-slate-300'} text-xs`}>
                          {statusFilterOptions.find(status => status.value === rule.status)?.label ?? rule.status}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {editing ? (
                        <input
                          type="text"
                          autoComplete="off"
                          value={editForm.priority}
                          onChange={e => {
                            setError(null);
                            setEditForm(form => ({ ...form, priority: e.target.value }));
                          }}
                          className="w-24 rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                          aria-invalid={Boolean(error)}
                        />
                      ) : (
                        <span className="font-mono text-xs text-slate-300">{rule.priority ?? 0}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-slate-200 text-xs">
                      {editing ? (
                        <select
                          value={editForm.agent_id}
                          onChange={e => setEditForm(form => ({ ...form, agent_id: e.target.value === '' ? '' : Number(e.target.value) }))}
                          className="w-full min-w-[180px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
                        >
                          <option value="">Select agent…</option>
                          {agentsList.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                        </select>
                      ) : (
                        rule.agent_name ?? `Agent #${rule.agent_id}`
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <TableEnabledSwitch
                        checked={Boolean(rule.enabled)}
                        disabled={editing}
                        label={`${rule.enabled ? 'Disable' : 'Enable'} routing rule #${rule.id}`}
                        onChange={() => void handleToggle(rule)}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {editing ? (
                        <div className="flex flex-col items-end gap-1">
                          <div className="flex justify-end gap-1">
                            <Button variant="primary" size="sm" onClick={() => handleSaveEdit(rule.id)} loading={saving}>
                              <Check className="h-3 w-3" /> Save
                            </Button>
                            <button type="button" onClick={cancelEdit} className={TABLE_EDIT_ACTION_CLASS} title="Cancel">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          {error && <span className="text-right text-[10px] text-red-400">{error}</span>}
                        </div>
                      ) : (
                        <div className="flex justify-end gap-1">
                          <button type="button" onClick={() => startEdit(rule)} className={TABLE_EDIT_ACTION_CLASS} title="Edit assignment rule">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button type="button" onClick={() => handleDelete(rule.id)} className={TABLE_DELETE_ACTION_CLASS} title="Delete assignment rule">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filteredRules.length === 0 && !showAdd && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-slate-500 text-sm">
                    {rules.length === 0 ? 'No assignment rules configured yet.' : 'No rules match the current filters.'}
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
