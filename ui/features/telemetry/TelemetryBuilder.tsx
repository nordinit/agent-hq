'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Braces, ListChecks, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buildTelemetryDefinition, newTelemetryGuide, type TelemetryGuide, type TelemetryRecipe } from '@/lib/telemetryBuilder';
import type { TelemetryCatalog } from '@/lib/telemetryTypes';
import { telemetryErrorMessage } from '@/lib/telemetryPresentation';
import { Field, inputClass, Select } from './TelemetryControls';

const recipes: { value: TelemetryRecipe; label: string; help: string }[] = [
  { value: 'count', label: 'Count records', help: 'Count the tasks in your configured population.' },
  { value: 'numeric', label: 'Custom-field calculation', help: 'Sum, average, or inspect the distribution of a canonical numeric field.' },
  { value: 'milestone', label: 'Reached a milestone', help: 'Count distinct tasks with a recorded entry into the selected milestone.' },
  { value: 'first_pass', label: 'First pass', help: 'Choose what success and rework mean, and which journeys belong in the denominator.' },
  { value: 'duration', label: 'Time between milestones', help: 'Measure elapsed time from the first recorded start to its matching finish.' },
  { value: 'blocked', label: 'Blocked at snapshot', help: 'Choose a status or checkbox that defines blocked work right now.' },
  { value: 'ever_blocked', label: 'Ever blocked', help: 'Measure journeys that entered the configured blocked condition.' },
  { value: 'percent_blocked', label: 'Time spent blocked', help: 'Divide time in the configured blocked interval by total journey time.' },
  { value: 'funnel', label: 'Ordered workflow funnel', help: 'Track progress through an explicit sequence of milestones.' },
];

export default function TelemetryBuilder({ catalog, draftText, onChange, initialGuide, editing = false, lockedKey = false }: { catalog: TelemetryCatalog | null; draftText: string; onChange: (text: string, error?: string) => void; initialGuide?: TelemetryGuide; editing?: boolean; lockedKey?: boolean }) {
  const [mode, setMode] = useState<'guided' | 'advanced'>(editing ? 'advanced' : 'guided');
  const [guide, setGuide] = useState<TelemetryGuide>(initialGuide ?? newTelemetryGuide());
  function update(patch: Partial<TelemetryGuide>) {
    const next = { ...guide, ...patch }; setGuide(next);
    try { onChange(JSON.stringify(buildTelemetryDefinition(next, catalogSignals), null, 2)); }
    catch (error) { onChange('', telemetryErrorMessage(error)); }
  }
  const catalogEntries = [...(catalog?.routing_transitions ?? []), ...(catalog?.event_mappings ?? [])].filter(entry => entry.enabled);
  const catalogSignals = Object.fromEntries(catalogEntries.map(entry => [entry.id, entry.predicate]));
  const fields = (catalog?.fields ?? []).filter(field => !field.retired);
  const numericFields = fields.filter(field => field.type === 'number' && (!field.supported_grains || field.supported_grains.includes('task')));
  const signals = [
    { value: '', label: 'Choose a condition' },
    { value: 'event:task.created', label: 'Task was created' },
    ...(catalog?.statuses ?? []).map(status => ({ value: `status:${status.key}`, label: `Entered ${status.label || status.key}` })),
    ...(catalog?.outcomes ?? []).map(outcome => ({ value: `outcome:${outcome.key}`, label: `Outcome: ${outcome.label || outcome.key}` })),
    { value: 'event:runtime.failed', label: 'Runtime execution failed' },
    { value: 'event:run.failed', label: 'Run failed' },
    ...catalogEntries.map(entry => ({ value: `catalog:${entry.id}`, label: entry.label })),
    ...fields.filter(field => field.type === 'checkbox').map(field => ({ value: `field:${field.id}`, label: `${field.label} is true` })),
  ].filter((option, index, array) => array.findIndex(item => item.value === option.value) === index);
  const optionalSignals = [{ value: '', label: 'No condition selected' }, ...signals.filter(signal => signal.value)];
  const needsJourney = ['first_pass', 'ever_blocked', 'percent_blocked', 'funnel'].includes(guide.recipe) || (guide.recipe === 'numeric' && ['at_entry', 'at_resolution'].includes(guide.basis));
  const needsStart = needsJourney || guide.recipe === 'duration';
  const needsSuccess = needsStart || guide.recipe === 'milestone' || (guide.recipe === 'numeric' && guide.basis === 'at_event');
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold text-white">Metric definition</h2><div className="flex gap-1"><Button size="sm" variant={mode === 'guided' ? 'secondary' : 'ghost'} onClick={() => { setMode('guided'); update({}); }}><ListChecks className="h-3 w-3"/>Guided</Button><Button size="sm" variant={mode === 'advanced' ? 'secondary' : 'ghost'} onClick={() => setMode('advanced')}><Braces className="h-3 w-3"/>Advanced JSON</Button></div></div>
    {mode === 'advanced' ? <Field label="Versioned definition" hint="Uses the same server validation and evaluator as the guided builder. Preview before saving."><textarea spellCheck={false} className={`${inputClass} min-h-[440px] font-mono text-xs`} value={draftText} onChange={event => onChange(event.target.value)}/></Field> : <>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="Metric name"><input className={inputClass} value={guide.name} onChange={event => update({ name: event.target.value })}/></Field><Field label="Stable family key" hint="The same family can have different scoped definitions."><input className={inputClass} value={guide.key} disabled={lockedKey} onChange={event => update({ key: event.target.value })}/></Field></div>
      <Select label="Measurement" value={guide.recipe} onChange={value => { const recipe = recipes.find(item => item.value === value)!; update({ recipe: recipe.value, key: lockedKey ? guide.key : recipe.value, name: lockedKey ? guide.name : recipe.label }); }} options={recipes} hint={recipes.find(recipe => recipe.value === guide.recipe)?.help}/>
      <div className="space-y-2">
        <Field label="Task title regex" hint="Optional. Match part of the title, or use ^ and $ for the whole title. Enter the pattern without / delimiters. Historical measurements use the recorded title at the event or journey entry.">
          <input className={inputClass} value={guide.titlePattern} maxLength={512} placeholder="e.g. ^(Lead|Proposal):" spellCheck={false} onChange={event => update({ titlePattern: event.target.value })}/>
        </Field>
        <label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={guide.titleIgnoreCase} onChange={event => update({ titleIgnoreCase: event.target.checked })}/>Ignore case in task titles</label>
        <p className="text-xs text-slate-500">Supports alternatives, groups, character classes, and repetition. Lookaround and backreferences are not supported.</p>
      </div>
      {guide.recipe === 'numeric' && <div className="grid gap-3 sm:grid-cols-2"><Select label="Canonical numeric field" value={guide.field} onChange={value => update({ field: value, unit: numericFields.find(field => field.id === value)?.unit ?? '' })} options={[{ value: '', label: numericFields.length ? 'Choose a field' : 'No numeric fields in this scope' }, ...numericFields.map(field => ({ value: field.id, label: `${field.label}${field.scope?.task_type ? ` · ${field.scope.task_type}` : ''}` }))]}/><Select label="Value at" value={guide.basis} onChange={value => update({ basis: value as TelemetryGuide['basis'] })} options={[{ value: 'current', label: 'Current snapshot' }, { value: 'at_event', label: 'Selected event' }, { value: 'at_entry', label: 'Journey entry' }, { value: 'at_resolution', label: 'Journey resolution' }]} hint="Historical values require recorded snapshots; missing values are disclosed."/></div>}
      {['numeric', 'duration'].includes(guide.recipe) && <div className="grid gap-3 sm:grid-cols-2"><Select label="Calculation" value={guide.aggregate} onChange={value => update({ aggregate: value as TelemetryGuide['aggregate'] })} options={[{ value: 'sum', label: 'Sum' }, { value: 'mean', label: 'Mean' }, { value: 'min', label: 'Minimum' }, { value: 'max', label: 'Maximum' }, { value: 'percentile', label: 'Percentile (continuous)' }, { value: 'distribution', label: 'Distribution' }]}/>{guide.aggregate === 'percentile' ? <Field label="Percentile (0–1)"><input className={inputClass} type="number" min="0" max="1" step="0.01" value={guide.percentile} onChange={event => update({ percentile: Number(event.target.value) })}/></Field> : guide.recipe === 'numeric' && <Field label="Display unit" hint="Use only units actually compatible with the selected field."><input className={inputClass} value={guide.unit} onChange={event => update({ unit: event.target.value })} placeholder="number"/></Field>}</div>}
      {(needsStart || needsSuccess) && <div className="grid gap-3 sm:grid-cols-2">{needsStart && <Select label="Journey / interval starts when" value={guide.start} onChange={value => update({ start: value })} options={signals}/>}<Select label={guide.recipe === 'milestone' || guide.basis === 'at_event' ? 'Measured milestone' : 'Success / interval ends when'} value={guide.success} onChange={value => update({ success: value })} options={signals}/></div>}
      {guide.recipe === 'first_pass' && <div className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><Select label="Rework disqualifies first pass when" value={guide.rework} onChange={value => update({ rework: value })} options={optionalSignals} hint="Runtime failure is rework only if you explicitly choose it."/><Select label="Final unsuccessful result" value={guide.unsuccessful} onChange={value => update({ unsuccessful: value })} options={optionalSignals}/><Select label="Cancellation" value={guide.cancelled} onChange={value => update({ cancelled: value })} options={optionalSignals}/><Select label="Denominator" value={guide.denominator} onChange={value => update({ denominator: value as TelemetryGuide['denominator'] })} options={[{ value: 'evaluated', label: 'Evaluated successes and failures' }, { value: 'successful', label: 'Successful journeys only' }, { value: 'all_started', label: 'All started journeys' }]} hint="Open, cancelled, and unknown work appears separately in result coverage."/></div></div>}
      {['blocked', 'ever_blocked', 'percent_blocked'].includes(guide.recipe) && <div className="grid gap-3 sm:grid-cols-2"><Select label="Blocked condition" value={guide.blocked} onChange={value => update({ blocked: value })} options={guide.recipe === 'blocked' ? signals.filter(signal => !signal.value || signal.value.startsWith('status:') || signal.value.startsWith('field:')) : signals}/>{guide.recipe !== 'blocked' && <Select label="Blocked interval ends when" value={guide.unblocked} onChange={value => update({ unblocked: value })} options={signals}/>}</div>}
      {guide.recipe === 'funnel' && <div className="space-y-2"><p className="text-xs font-medium text-slate-300">Ordered steps</p>{guide.steps.map((step, index) => <div key={index} className="flex items-end gap-2"><div className="flex-1"><Select label={`Step ${index + 1}`} value={step} onChange={value => update({ steps: guide.steps.map((item, itemIndex) => itemIndex === index ? value : item) })} options={signals}/></div><Button size="sm" variant="ghost" disabled={guide.steps.length <= 2} onClick={() => update({ steps: guide.steps.filter((_, itemIndex) => itemIndex !== index) })} aria-label={`Remove step ${index + 1}`}><Trash2 className="h-4 w-4"/></Button></div>)}<Button size="sm" variant="ghost" disabled={guide.steps.length >= 10} onClick={() => update({ steps: [...guide.steps, ''] })}><Plus className="h-3 w-3"/>Add step</Button></div>}
      <details className="rounded-lg border border-slate-700/60 p-3"><summary className="cursor-pointer text-sm text-slate-300">Population, attribution, and journey policy</summary><div className="mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2"><Select label="Population filter" value={guide.filterField} onChange={value => update({ filterField: value, filterType: fields.find(field => field.id === value)?.type ?? 'text' })} options={[{ value: '', label: 'All records in selected scope' }, ...fields.map(field => ({ value: field.id, label: field.label }))]}/>{guide.filterField && <Select label="Filter operation" value={guide.filterOp} onChange={value => update({ filterOp: value as TelemetryGuide['filterOp'] })} options={[{ value: 'eq', label: 'Equals' }, { value: 'ne', label: 'Does not equal' }, { value: 'gt', label: 'Greater than' }, { value: 'gte', label: 'At least' }, { value: 'lt', label: 'Less than' }, { value: 'lte', label: 'At most' }, { value: 'is_present', label: 'Has a value' }, { value: 'is_missing', label: 'Has no value' }]}/>}</div>
        {guide.filterField && !['is_present', 'is_missing'].includes(guide.filterOp) && <Field label="Filter value"><input className={inputClass} value={guide.filterValue} placeholder={guide.filterType === 'checkbox' ? 'true or false' : ''} onChange={event => update({ filterValue: event.target.value })}/></Field>}
        <Select label="Agent attribution" value={guide.attribution} onChange={value => update({ attribution: value as TelemetryGuide['attribution'] })} options={[{ value: 'assigned_agent_current', label: 'Current assigned agent' }, { value: 'assigned_agent_at_entry', label: 'Assigned agent at journey entry' }, { value: 'executing_agent', label: 'Executing agent' }, { value: 'event_actor', label: 'Actor recorded on event' }, { value: 'outcome_agent', label: 'Agent reporting the outcome' }]}/>
        {needsJourney && <><Select label="Repeated starts and reopenings" value={guide.counting} onChange={value => update({ counting: value as TelemetryGuide['counting'] })} options={[{ value: 'first_per_entity', label: 'One journey per task' }, { value: 'per_reset', label: 'New journey after explicit reset' }, { value: 'per_stage_visit', label: 'Each non-overlapping stage visit' }]}/>{guide.counting === 'per_reset' && <Select label="Reset condition" value={guide.reset} onChange={value => update({ reset: value })} options={signals}/>}</>}
        {guide.recipe !== 'count' && guide.recipe !== 'blocked' && !(guide.recipe === 'numeric' && guide.basis === 'current') && <Select label="Time buckets" value={guide.bucket} onChange={value => update({ bucket: value as TelemetryGuide['bucket'] })} options={[{ value: '', label: 'No time buckets' }, { value: 'hour', label: 'Hourly' }, { value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }]}/>}
        <p className="text-xs text-slate-500">Advanced JSON supports compound predicates, arithmetic, attempt limits, pause intervals, and explicit distributions.</p>
      </div></details>
      <Link href="/workflow-definitions" className="inline-block text-xs text-amber-300 hover:underline">Manage canonical workflow fields and statuses →</Link>
    </>}
  </div>;
}
