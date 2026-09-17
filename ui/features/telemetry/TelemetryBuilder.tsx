'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Braces, ListChecks, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buildTelemetryDefinition, newTelemetryGuide, telemetryGuideFromDefinition, type TelemetryGuide, type TelemetryRecipe } from '@/lib/telemetryBuilder';
import { populationOperations, telemetryFieldChoices, telemetryFilterOperations, telemetryFilterValues, telemetryGuideRequirements, telemetryGuideSelectionIssue, telemetryNumericFields, telemetryPopulationFields, telemetrySignalChoices } from '@/lib/telemetryBuilderOptions';
import type { MetricDefinition, TelemetryCatalog } from '@/lib/telemetryTypes';
import { telemetryErrorMessage } from '@/lib/telemetryPresentation';
import { Field, inputClass, Select } from './TelemetryControls';
import TelemetryChoicePicker from './TelemetryChoicePicker';

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
const attributions = [
  { value: 'assigned_agent_current', label: 'Current assigned agent', help: 'Credit the agent currently assigned to the task, even if its assignment has changed.' },
  { value: 'assigned_agent_at_entry', label: 'Assigned agent at journey entry', help: 'Credit the assignment recorded when the journey started. Requires entry history.' },
  { value: 'executing_agent', label: 'Executing agent', help: 'Credit the agent recorded as executing the work.' },
  { value: 'event_actor', label: 'Actor recorded on event', help: 'Credit the actor recorded on the measured event.' },
  { value: 'outcome_agent', label: 'Agent reporting the outcome', help: 'Credit the agent recorded as reporting the outcome.' },
];
const calculations = [
  { value: 'sum', label: 'Sum' }, { value: 'mean', label: 'Mean' }, { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maximum' }, { value: 'percentile', label: 'Percentile (continuous)' }, { value: 'distribution', label: 'Distribution' },
];
const timings = [
  { value: 'current', label: 'Current snapshot' }, { value: 'at_event', label: 'Selected event' },
  { value: 'at_entry', label: 'Journey entry' }, { value: 'at_resolution', label: 'Journey resolution' },
];
const countingRules = [
  { value: 'first_per_entity', label: 'One journey per task' }, { value: 'per_reset', label: 'New journey after explicit reset' },
  { value: 'per_stage_visit', label: 'Each non-overlapping stage visit' },
];
const denominators = [
  { value: 'evaluated', label: 'Evaluated successes and failures' }, { value: 'successful', label: 'Successful journeys only' },
  { value: 'all_started', label: 'All started journeys' },
];
const emptyCatalog: TelemetryCatalog = { fields: [], statuses: [], outcomes: [], projects: [], workflows: [], workflow_types: [], task_types: [], agents: [], recipes: [], core_metrics: [] };

type OptionalCondition = 'rework' | 'unsuccessful' | 'cancelled';
function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section aria-label={title} className="space-y-4 rounded-xl border border-slate-700/60 bg-slate-950/20 p-4">
    <div><h3 className="text-sm font-semibold text-white">{title}</h3>{description && <p className="mt-1 text-xs leading-relaxed text-slate-400">{description}</p>}</div>{children}
  </section>;
}

export default function TelemetryBuilder({ catalog, draftText, onChange, onGuideChange, onModeChange, onValidationChange, initialGuide, editing = false, lockedKey = false }: {
  catalog: TelemetryCatalog | null; draftText: string; onChange: (text: string, error?: string) => void;
  onGuideChange?: (guide: TelemetryGuide) => void; onModeChange?: (advanced: boolean) => void; onValidationChange?: (error: string | null) => void;
  initialGuide?: TelemetryGuide; editing?: boolean; lockedKey?: boolean;
}) {
  const [mode, setMode] = useState<'guided' | 'advanced'>(editing ? 'advanced' : 'guided');
  const [guide, setGuide] = useState<TelemetryGuide>(initialGuide ?? newTelemetryGuide());
  const [populationOpen, setPopulationOpen] = useState(Boolean(initialGuide?.filterField));
  const [optionalOpen, setOptionalOpen] = useState<OptionalCondition[]>([]);
  const [modeError, setModeError] = useState<string | null>(null);
  const [advancedInitialText, setAdvancedInitialText] = useState<string | null>(null);
  const [adjustment, setAdjustment] = useState<string | null>(null);
  const currentCatalog = catalog ?? emptyCatalog;
  const catalogSignals = useMemo(() => Object.fromEntries([...(catalog?.routing_transitions ?? []), ...(catalog?.event_mappings ?? [])].filter(entry => entry.enabled).map(entry => [entry.id, entry.predicate])), [catalog]);
  const requirements = telemetryGuideRequirements(guide);
  const numericFields = telemetryNumericFields(currentCatalog, guide);
  const populationFields = telemetryPopulationFields(currentCatalog, guide);
  const filterField = currentCatalog.fields.find(field => field.id === guide.filterField);
  const filterValues = telemetryFilterValues(filterField, currentCatalog);
  const signals = telemetrySignalChoices(currentCatalog);
  const blockedSignals = guide.recipe === 'blocked' ? telemetrySignalChoices(currentCatalog, true) : signals;
  const selectionIssue = catalog ? telemetryGuideSelectionIssue(guide, catalog) : undefined;
  let definitionIssue = selectionIssue;
  if (!definitionIssue) {
    try { buildTelemetryDefinition(guide, catalogSignals); }
    catch (error) { definitionIssue = telemetryErrorMessage(error); }
  }
  useEffect(() => { onValidationChange?.(mode === 'guided' ? definitionIssue ?? null : null); }, [definitionIssue, mode, onValidationChange]);

  function update(patch: Partial<TelemetryGuide>) {
    const next = { ...guide, ...patch };
    setAdjustment(null);
    if ((patch.recipe || patch.basis) && !telemetryGuideRequirements(next).bucket && next.bucket) {
      next.bucket = ''; setAdjustment('Time buckets were removed because this measurement uses the current snapshot.');
    }
    setGuide(next); onGuideChange?.(next);
    try { onChange(JSON.stringify(buildTelemetryDefinition(next, catalogSignals), null, 2), catalog ? telemetryGuideSelectionIssue(next, catalog) : undefined); }
    catch (error) { onChange('', telemetryErrorMessage(error)); }
  }
  function changeRecipe(value: string) {
    const recipe = recipes.find(item => item.value === value)!;
    const previous = recipes.find(item => item.value === guide.recipe)!;
    const defaultName = guide.name === previous.label || (guide.recipe === 'count' && guide.name === 'Task count');
    const defaultKey = guide.key === guide.recipe || (guide.recipe === 'count' && guide.key === 'task_count');
    update({ recipe: recipe.value, ...(!lockedKey && defaultKey ? { key: recipe.value } : {}), ...(!lockedKey && defaultName ? { name: recipe.label } : {}) });
  }
  function openGuided() {
    if (mode === 'guided') return;
    if (draftText === advancedInitialText) {
      setModeError(null); setMode('guided'); onModeChange?.(false); return;
    }
    try {
      const restored = telemetryGuideFromDefinition(JSON.parse(draftText) as MetricDefinition, catalogSignals);
      if (!restored) { setModeError('This definition includes settings the guided form cannot represent. Continue editing in JSON to preserve them.'); return; }
      setGuide(restored); onGuideChange?.(restored); setPopulationOpen(Boolean(restored.filterField)); setOptionalOpen([]);
      setModeError(null); setMode('guided'); onModeChange?.(false);
    } catch { setModeError('Fix the JSON before switching to Guided. Your definition has been kept.'); }
  }
  function selectFilter(value: string) {
    const field = populationFields.find(field => field.id === value);
    const operations = telemetryFilterOperations(field?.type);
    const values = telemetryFilterValues(field, currentCatalog);
    update({ filterField: value, filterType: field?.type ?? 'text',
      filterOp: operations.some(operation => operation.value === guide.filterOp) ? guide.filterOp : 'eq',
      filterValue: field?.type === guide.filterType && (!values.length || values.some(option => option.value === guide.filterValue)) ? guide.filterValue : '',
    });
  }
  const signalLabel = (value: string) => signals.find(signal => signal.value === value)?.label ?? (value ? `Unavailable: ${value}` : 'not selected');
  const filterDescription = guide.filterField ? `${filterField?.label ?? guide.filterField} ${(populationOperations.find(operation => operation.value === guide.filterOp)?.label ?? guide.filterOp).toLowerCase()}${['is_present', 'is_missing'].includes(guide.filterOp) ? '' : ` ${guide.filterValue || '(choose a value)'}`}` : '';
  const populationDescription = [guide.titlePattern ? `title matches “${guide.titlePattern}”${guide.titleIgnoreCase ? ' (ignoring case)' : ''}` : '', filterDescription].filter(Boolean).join(' and ');
  let measurementDescription = recipes.find(recipe => recipe.value === guide.recipe)!.label;
  if (guide.recipe === 'numeric') measurementDescription = `${calculations.find(item => item.value === guide.aggregate)?.label} of ${currentCatalog.fields.find(field => field.id === guide.field)?.label ?? 'a numeric field (not selected)'}, using ${timings.find(item => item.value === guide.basis)?.label.toLowerCase()}.`;
  if (guide.recipe === 'count') measurementDescription = 'Count the tasks that qualify.';
  if (guide.recipe === 'milestone') measurementDescription = `Count distinct tasks when: ${signalLabel(guide.success)}.`;
  if (guide.recipe === 'duration') measurementDescription = `${calculations.find(item => item.value === guide.aggregate)?.label} elapsed time from ${signalLabel(guide.start)} to ${signalLabel(guide.success)}.`;
  if (guide.recipe === 'blocked') measurementDescription = `Share of qualifying tasks where: ${blockedSignals.find(signal => signal.value === guide.blocked)?.label ?? 'blocked condition not selected'}.`;

  function optionalCondition(key: OptionalCondition, label: string, addLabel: string, hint?: string) {
    return guide[key] || optionalOpen.includes(key) ? <div key={key} className="flex items-start gap-2"><div className="min-w-0 flex-1"><TelemetryChoicePicker label={label} value={guide[key]} onChange={value => update({ [key]: value })} options={signals} hint={hint}/></div><Button type="button" size="sm" variant="ghost" className="mt-6" aria-label={`Remove ${label.toLowerCase()}`} onClick={() => { update({ [key]: '' }); setOptionalOpen(keys => keys.filter(item => item !== key)); }}><Trash2 className="h-4 w-4"/></Button></div>
      : <Button key={key} type="button" size="sm" variant="ghost" onClick={() => setOptionalOpen(keys => [...keys, key])}><Plus className="h-3 w-3"/>{addLabel}</Button>;
  }

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold text-white">Metric definition</h2><div className="flex gap-1"><Button type="button" size="sm" variant={mode === 'guided' ? 'secondary' : 'ghost'} onClick={openGuided}><ListChecks className="h-3 w-3"/>Guided</Button><Button type="button" size="sm" variant={mode === 'advanced' ? 'secondary' : 'ghost'} onClick={() => { if (mode === 'guided') setAdvancedInitialText(draftText); setModeError(null); setMode('advanced'); onModeChange?.(true); }}><Braces className="h-3 w-3"/>Advanced JSON</Button></div></div>
    {modeError && <p role="alert" className="text-sm text-amber-200">{modeError}</p>}
    {mode === 'advanced' ? <Field label="Versioned definition" hint="Uses the same server validation and evaluator as the guided builder. Preview before saving."><textarea spellCheck={false} className={`${inputClass} min-h-[440px] font-mono text-xs`} value={draftText} onChange={event => { setModeError(null); onChange(event.target.value); }}/></Field> : <>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="Metric name"><input className={inputClass} value={guide.name} onChange={event => update({ name: event.target.value })}/></Field><Field label="Stable family key" hint="The same family can have different scoped definitions."><input className={inputClass} value={guide.key} disabled={lockedKey} onChange={event => update({ key: event.target.value })}/></Field></div>
      <Select label="Measurement" value={guide.recipe} onChange={changeRecipe} options={recipes} hint={recipes.find(recipe => recipe.value === guide.recipe)?.help}/>
      {adjustment && <p role="status" className="text-xs text-amber-200">{adjustment}</p>}
      <div className="space-y-2">
        <Field label="Task title regex" hint="Optional. Match part of the title, or use ^ and $ for the whole title. Enter the pattern without / delimiters. Historical measurements use the recorded title at the event or journey entry."><input className={inputClass} value={guide.titlePattern} maxLength={512} placeholder="e.g. ^(Lead|Proposal):" spellCheck={false} onChange={event => update({ titlePattern: event.target.value })}/></Field>
        <label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={guide.titleIgnoreCase} onChange={event => update({ titleIgnoreCase: event.target.checked })}/>Ignore case in task titles</label>
        <p className="text-xs text-slate-500">Supports alternatives, groups, character classes, and repetition. Lookaround and backreferences are not supported.</p>
      </div>

      <Section title="Population" description="Choose which records qualify within the project, workflow, and task scope above. Title matching and this filter both apply.">
        <p className="break-words text-sm text-slate-300">{populationDescription ? `Records where ${populationDescription}.` : 'All records in selected scope.'}</p>
        {(populationOpen || guide.filterField) ? <div className="space-y-3">
          <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><TelemetryChoicePicker label="Population field" value={guide.filterField} onChange={selectFilter} options={telemetryFieldChoices(populationFields, currentCatalog)} placeholder="Choose a field to filter"/></div><Button type="button" size="sm" variant="ghost" className="mt-6" aria-label="Remove population filter" onClick={() => { update({ filterField: '', filterValue: '' }); setPopulationOpen(false); }}><Trash2 className="h-4 w-4"/></Button></div>
          {guide.filterField && <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Filter operation" value={guide.filterOp} onChange={value => update({ filterOp: value as TelemetryGuide['filterOp'] })} options={telemetryFilterOperations(filterField?.type)}/>
            {!['is_present', 'is_missing'].includes(guide.filterOp) && (filterField?.type === 'checkbox' ? <Select label="Filter value" value={guide.filterValue} onChange={value => update({ filterValue: value })} options={[{ value: '', label: 'Choose true or false' }, ...filterValues]}/>
              : filterValues.length ? <TelemetryChoicePicker label="Filter value" value={guide.filterValue} onChange={value => update({ filterValue: value })} placeholder="Choose a value" options={[...filterValues, ...(guide.filterValue && !filterValues.some(option => option.value === guide.filterValue) ? [{ value: guide.filterValue, label: `${guide.filterValue} (saved value)` }] : [])].map(option => ({ ...option, category: 'Values', description: filterField?.label ?? '' }))}/>
              : <Field label="Filter value" hint={filterField?.type === 'datetime' ? 'Use an ISO date and time with a timezone, for example 2026-09-17T12:00:00Z.' : undefined}><input className={inputClass} type={filterField?.type === 'number' ? 'number' : filterField?.type === 'date' ? 'date' : 'text'} step={filterField?.type === 'number' ? 'any' : undefined} value={guide.filterValue} onChange={event => update({ filterValue: event.target.value })}/></Field>)}
          </div>}
        </div> : <Button type="button" size="sm" variant="secondary" onClick={() => setPopulationOpen(true)}><Plus className="h-3 w-3"/>Add population filter</Button>}
      </Section>

      <Section title="Attribution" description="Choose which agent receives credit for the measured work.">
        <Select label="Agent attribution" value={guide.attribution} onChange={value => update({ attribution: value as TelemetryGuide['attribution'] })} options={attributions} hint={attributions.find(option => option.value === guide.attribution)?.help}/>
        <p className="text-xs text-slate-500">Missing attribution is reported in the results; another agent is not substituted.</p>
      </Section>

      {guide.recipe !== 'count' && <Section title="Measurement details" description={recipes.find(recipe => recipe.value === guide.recipe)?.help}>
        {guide.recipe === 'numeric' && <div className="grid gap-3 sm:grid-cols-2"><TelemetryChoicePicker label="Canonical numeric field" value={guide.field} onChange={value => update({ field: value, unit: numericFields.find(field => field.id === value)?.unit ?? '' })} options={telemetryFieldChoices(numericFields, currentCatalog)} placeholder="Choose a numeric field"/><Select label="Value at" value={guide.basis} onChange={value => update({ basis: value as TelemetryGuide['basis'] })} options={timings} hint="Historical values require recorded snapshots; missing values are disclosed."/></div>}
        {['numeric', 'duration'].includes(guide.recipe) && <div className="grid gap-3 sm:grid-cols-2"><Select label="Calculation" value={guide.aggregate} onChange={value => update({ aggregate: value as TelemetryGuide['aggregate'] })} options={calculations}/>{guide.aggregate === 'percentile' ? <Field label="Percentile (0–1)"><input className={inputClass} type="number" min="0" max="1" step="0.01" value={guide.percentile} onChange={event => update({ percentile: Number(event.target.value) })}/></Field> : guide.recipe === 'numeric' && <Field label="Display unit" hint="Use only units actually compatible with the selected field."><input className={inputClass} value={guide.unit} onChange={event => update({ unit: event.target.value })} placeholder="number"/></Field>}</div>}
        {requirements.success && <div className="grid gap-3 sm:grid-cols-2">{requirements.start && <TelemetryChoicePicker label="Journey / interval starts when" value={guide.start} onChange={value => update({ start: value })} options={signals}/>}<TelemetryChoicePicker label={guide.recipe === 'milestone' || (guide.recipe === 'numeric' && guide.basis === 'at_event') ? 'Measured milestone' : 'Success / interval ends when'} value={guide.success} onChange={value => update({ success: value })} options={signals}/></div>}
        {requirements.journey && <div className="space-y-3"><p className="text-xs text-slate-400">Optional conditions</p>{guide.recipe !== 'ever_blocked' && optionalCondition('rework', 'Rework disqualifies first pass when', 'Add rework condition', 'Runtime failure is rework only if you explicitly choose it.')}{optionalCondition('unsuccessful', 'Final unsuccessful result', 'Add unsuccessful condition')}{optionalCondition('cancelled', 'Cancellation', 'Add cancellation condition')}</div>}
        {['blocked', 'ever_blocked', 'percent_blocked'].includes(guide.recipe) && <div className="grid gap-3 sm:grid-cols-2"><TelemetryChoicePicker label="Blocked condition" value={guide.blocked} onChange={value => update({ blocked: value })} options={blockedSignals}/>{guide.recipe === 'percent_blocked' && <TelemetryChoicePicker label="Blocked interval ends when" value={guide.unblocked} onChange={value => update({ unblocked: value })} options={signals}/>}</div>}
        {guide.recipe === 'funnel' && <div className="space-y-2"><p className="text-xs font-medium text-slate-300">Ordered steps</p>{guide.steps.map((step, index) => <div key={index} className="flex items-end gap-2"><div className="min-w-0 flex-1"><TelemetryChoicePicker label={`Step ${index + 1}`} value={step} onChange={value => update({ steps: guide.steps.map((item, itemIndex) => itemIndex === index ? value : item) })} options={signals}/></div><Button type="button" size="sm" variant="ghost" disabled={guide.steps.length <= 2} onClick={() => update({ steps: guide.steps.filter((_, itemIndex) => itemIndex !== index) })} aria-label={`Remove step ${index + 1}`}><Trash2 className="h-4 w-4"/></Button></div>)}<Button type="button" size="sm" variant="ghost" disabled={guide.steps.length >= 10} onClick={() => update({ steps: [...guide.steps, ''] })}><Plus className="h-3 w-3"/>Add step</Button></div>}
      </Section>}

      {requirements.journey && <Section title="Journey policy" description="Define how repeated starts and unfinished work affect the measurement.">
        <Select label="Repeated starts and reopenings" value={guide.counting} onChange={value => update({ counting: value as TelemetryGuide['counting'] })} options={countingRules}/>
        {guide.counting === 'per_reset' && <TelemetryChoicePicker label="Reset condition" value={guide.reset} onChange={value => update({ reset: value })} options={signals}/>}
        <Select label="Denominator" value={guide.denominator} onChange={value => update({ denominator: value as TelemetryGuide['denominator'] })} options={denominators} hint="Open, cancelled, and unknown work appears separately in result coverage."/>
      </Section>}
      {requirements.bucket && <Select label="Time buckets" value={guide.bucket} onChange={value => update({ bucket: value as TelemetryGuide['bucket'] })} options={[{ value: '', label: 'No time buckets' }, { value: 'hour', label: 'Hourly' }, { value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }]}/>}

      <Section title="Metric summary">
        <dl className="space-y-2 break-words text-sm text-slate-300">
          <div><dt className="inline font-medium text-slate-400">Population: </dt><dd className="inline">{populationDescription ? `Records in selected scope where ${populationDescription}.` : 'All records in selected scope.'}</dd></div>
          <div><dt className="inline font-medium text-slate-400">Measurement: </dt><dd className="inline">{measurementDescription}</dd></div>
          {requirements.journey && <><div><dt className="inline font-medium text-slate-400">Journey: </dt><dd className="inline">{signalLabel(guide.start)} → {signalLabel(guide.success)}. {countingRules.find(rule => rule.value === guide.counting)?.label}.{guide.counting === 'per_reset' ? ` Reset: ${signalLabel(guide.reset)}.` : ''}</dd></div>
            {guide.recipe !== 'ever_blocked' && guide.rework && <div><dt className="inline font-medium text-slate-400">Rework: </dt><dd className="inline">{signalLabel(guide.rework)}.</dd></div>}
            {guide.unsuccessful && <div><dt className="inline font-medium text-slate-400">Unsuccessful: </dt><dd className="inline">{signalLabel(guide.unsuccessful)}.</dd></div>}
            {guide.cancelled && <div><dt className="inline font-medium text-slate-400">Cancellation: </dt><dd className="inline">{signalLabel(guide.cancelled)}.</dd></div>}
            <div><dt className="inline font-medium text-slate-400">Denominator: </dt><dd className="inline">{denominators.find(item => item.value === guide.denominator)?.label}.</dd></div></>}
          {['ever_blocked', 'percent_blocked'].includes(guide.recipe) && <div><dt className="inline font-medium text-slate-400">Blocked: </dt><dd className="inline">{signalLabel(guide.blocked)}{guide.recipe === 'percent_blocked' ? ` → ${signalLabel(guide.unblocked)}` : ''}.</dd></div>}
          {guide.recipe === 'funnel' && <div><dt className="inline font-medium text-slate-400">Steps: </dt><dd className="inline">{guide.steps.map(signalLabel).join(' → ')}.</dd></div>}
          <div><dt className="inline font-medium text-slate-400">Attribution: </dt><dd className="inline">{attributions.find(option => option.value === guide.attribution)?.label}.</dd></div>
        </dl>
        {selectionIssue && <p role="alert" className="text-xs text-amber-200">{selectionIssue}</p>}
        <p className="text-xs text-slate-500">Preview calculation runs this definition. Editing updates this summary immediately.</p>
      </Section>
      <p className="text-xs text-slate-500">Advanced JSON supports compound predicates, arithmetic, attempt limits, pause intervals, and explicit distributions.</p>
      <Link href="/workflow-definitions" className="inline-block text-xs text-amber-300 hover:underline">Manage canonical workflow fields and statuses →</Link>
    </>}
  </div>;
}
