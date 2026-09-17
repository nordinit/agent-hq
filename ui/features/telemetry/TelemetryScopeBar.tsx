'use client';

import type { TelemetryCatalog, TelemetryScope } from '@/lib/telemetryTypes';
import { Field, inputClass, Select } from './TelemetryControls';

export interface TelemetryFilters { scope: TelemetryScope; from: string; to: string; timezone: string; grouping: string }
export default function TelemetryScopeBar({ catalog, filters, onChange, hideGrouping = false }: { catalog: TelemetryCatalog | null; filters: TelemetryFilters; onChange: (next: TelemetryFilters) => void; hideGrouping?: boolean }) {
  const { scope } = filters;
  const setScope = (patch: Partial<TelemetryScope>) => onChange({ ...filters, scope: { ...scope, ...patch } });
  const workflows = (catalog?.workflows ?? []).filter(workflow => (!scope.project_id || workflow.project_id === scope.project_id) && (!scope.workflow_type || workflow.workflow_type === scope.workflow_type));
  return <div className="space-y-3 rounded-xl border border-slate-700/50 bg-slate-900/60 p-4">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Select label="Project" value={String(scope.project_id ?? '')} onChange={value => setScope({ project_id: value ? Number(value) : undefined, workflow_id: undefined, workflow_type: undefined, task_type: undefined })} options={[{ value: '', label: 'All authorized projects' }, ...(catalog?.projects ?? []).map(project => ({ value: String(project.id), label: project.name }))]}/>
      <Select label="Workflow type" value={scope.workflow_type ?? ''} onChange={value => setScope({ workflow_type: value || undefined, workflow_id: undefined, task_type: undefined })} options={[{ value: '', label: 'All workflow types' }, ...(catalog?.workflow_types ?? []).map(type => ({ value: type.key, label: type.name }))]}/>
      <Select label="Workflow" value={String(scope.workflow_id ?? '')} onChange={value => { const workflow = workflows.find(item => String(item.id) === value); setScope({ workflow_id: value ? Number(value) : undefined, ...(workflow ? { workflow_type: workflow.workflow_type } : {}) }); }} options={[{ value: '', label: 'All workflows' }, ...workflows.map(workflow => ({ value: String(workflow.id), label: workflow.name }))]}/>
      <Select label="Task type" value={scope.task_type ?? ''} onChange={value => setScope({ task_type: value || undefined })} options={[{ value: '', label: 'All task types' }, ...(catalog?.task_types ?? []).filter(type => !scope.workflow_type || !type.workflow_type || type.workflow_type === scope.workflow_type).filter((type, index, all) => all.findIndex(item => item.key === type.key) === index).map(type => ({ value: type.key, label: type.label ?? type.key }))]}/>
    </div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Field label="From (inclusive)" hint="Local date/time in the selected timezone"><input type="datetime-local" className={inputClass} value={filters.from} onChange={event => onChange({ ...filters, from: event.target.value })}/></Field>
      <Field label="To (exclusive)"><input type="datetime-local" className={inputClass} value={filters.to} onChange={event => onChange({ ...filters, to: event.target.value })}/></Field>
      <Field label="Timezone"><input className={inputClass} value={filters.timezone} placeholder="UTC" onChange={event => onChange({ ...filters, timezone: event.target.value })}/></Field>
      {!hideGrouping && <Select label="Group results" value={filters.grouping} onChange={value => onChange({ ...filters, grouping: value })} options={[...(filters.grouping === '__saved__' ? [{ value: '__saved__', label: 'Saved report grouping' }] : []), { value: '', label: 'One result' }, { value: 'project_id', label: 'Project' }, { value: 'workflow_id', label: 'Workflow' }, { value: 'task_type', label: 'Task type' }, { value: 'agent_id', label: 'Agent (selected attribution)' }, { value: 'status', label: 'Current status' }, ...(catalog?.fields ?? []).filter(field => !field.retired && !['textarea', 'url'].includes(field.type ?? '') && !['project_id', 'workflow_id', 'task_type', 'agent_id', 'status'].includes(field.id)).map(field => ({ value: field.id, label: field.label }))]}/>}
    </div>
    <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={scope.include_archived !== false} onChange={event => setScope({ include_archived: event.target.checked })}/> Include closed and archived workflows</label>
    <p className="text-xs text-slate-500">These filters apply to every measurement and its contributing records. Saved reports retain their pinned definitions; filters only narrow their population.</p>
  </div>;
}
