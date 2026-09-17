'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { filterTelemetryChoices, telemetryChoiceScopeOptions, type TelemetryChoice, type TelemetryChoiceScopeCatalog } from '@/lib/telemetryBuilderOptions';
import { inputClass, Select } from './TelemetryControls';

export default function TelemetryChoicePicker({ label, value, onChange, options, scopeCatalog, placeholder = 'Choose a condition', hint }: {
  label: string; value: string; onChange: (value: string) => void; options: TelemetryChoice[]; placeholder?: string; hint?: string;
  scopeCatalog?: TelemetryChoiceScopeCatalog;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [workflowType, setWorkflowType] = useState('');
  const [taskType, setTaskType] = useState('');
  const [active, setActive] = useState(0);
  const selected = options.find(option => option.value === value);
  const categories = [...new Set(options.map(option => option.category))];
  const { workflowTypes, taskTypes, showTaskTypes } = telemetryChoiceScopeOptions(options, scopeCatalog, workflowType);
  const browsing = Boolean(category || query.trim());
  const choices = browsing ? filterTelemetryChoices(options, category, query, workflowType, taskType) : [];

  useEffect(() => {
    if (open) { dialog.current?.showModal(); search.current?.focus(); }
    else if (dialog.current?.open) { dialog.current.close(); trigger.current?.focus(); }
  }, [open]);

  function show() {
    setCategory(selected?.category ?? (categories.length === 1 ? categories[0] : '')); setQuery(''); setWorkflowType(''); setTaskType(''); setActive(0); setOpen(true);
  }
  function choose(next: string) { onChange(next); setOpen(false); }
  function focusChoice(index: number) {
    const next = Math.max(0, Math.min(choices.length - 1, index));
    setActive(next);
    results.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus();
  }
  function resultKeys(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') { event.preventDefault(); focusChoice(active + 1); }
    if (event.key === 'ArrowUp') { event.preventDefault(); if (active === 0) search.current?.focus(); else focusChoice(active - 1); }
    if (event.key === 'Home') { event.preventDefault(); focusChoice(0); }
    if (event.key === 'End') { event.preventDefault(); focusChoice(choices.length - 1); }
  }

  return <div className="min-w-0 space-y-1.5">
    <label id={`${id}-label`} htmlFor={`${id}-trigger`} className="block text-xs font-medium text-slate-300">{label}</label>
    <button ref={trigger} id={`${id}-trigger`} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-dialog`}
      aria-describedby={hint ? `${id}-hint` : undefined} onClick={show}
      className={`${inputClass} flex min-h-10 items-center justify-between gap-2 text-left ${value && !selected ? 'border-amber-500/60' : ''}`}>
      <span className="min-w-0 break-words">{selected ? <><span className="mr-1 text-xs text-slate-400">{selected.category} →</span> {selected.label}</>
        : value ? `Unavailable selection: ${value}` : <span className="text-slate-400">{placeholder}</span>}</span>
      <ChevronDown className="h-4 w-4 shrink-0 text-slate-400"/>
    </button>
    {hint && <p id={`${id}-hint`} className="text-xs leading-relaxed text-slate-500">{hint}</p>}
    <dialog ref={dialog} id={`${id}-dialog`} aria-labelledby={`${id}-title`}
      onCancel={() => setOpen(false)} onClose={() => setOpen(false)} onClick={event => { if (event.target === dialog.current) setOpen(false); }}
      className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto rounded-xl border border-slate-600 bg-slate-900 p-0 text-slate-100 shadow-2xl backdrop:bg-black/70">
      <div className="p-4 sm:p-5">
        <div className="mb-4 flex items-start justify-between gap-3"><div><h3 id={`${id}-title`} className="font-semibold">{label}</h3><p className="mt-1 text-xs text-slate-400">Choose a category to browse, or search across choices.</p></div><Button type="button" size="sm" variant="ghost" aria-label="Close choices" onClick={() => setOpen(false)}><X className="h-4 w-4"/></Button></div>
        <div className="relative"><Search aria-hidden className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400"/><input ref={search} type="search" aria-label={`Search ${label}`} className={`${inputClass} pl-9`} placeholder="Search names, keys, or workflow context…" value={query}
          onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => { if (event.key === 'ArrowDown' && choices.length) { event.preventDefault(); focusChoice(0); } }}/></div>
        {(workflowTypes.length > 0 || showTaskTypes) && <div className="mt-3 space-y-2"><div className="grid gap-2 sm:grid-cols-2">
          {workflowTypes.length > 0 && <Select label="Narrow by workflow type" value={workflowType} onChange={next => {
            setWorkflowType(next);
            if (!telemetryChoiceScopeOptions(options, scopeCatalog, next).taskTypes.some(type => type.value === taskType)) setTaskType('');
            setActive(0);
          }} options={[{ value: '', label: 'All workflow types' }, ...workflowTypes]}/>}
          {showTaskTypes && <Select label="Narrow by task type" value={taskType} disabled={!taskTypes.length} onChange={next => { setTaskType(next); setActive(0); }} options={[{ value: '', label: taskTypes.length ? 'All task types' : 'No task types in this workflow' }, ...taskTypes]}/>}
        </div><p className="text-xs text-slate-500">These filters narrow the choices shown; they do not change the metric population.</p></div>}
        <div className="mt-4 grid gap-3 sm:grid-cols-[170px_minmax(0,1fr)]">
          <div aria-label="Choice categories" className="flex flex-wrap content-start gap-1 sm:flex-col">
            {[...categories, '*'].map(item => <button key={item} type="button" aria-pressed={category === item} onClick={() => { setCategory(item); setActive(0); }}
              className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs focus-visible:outline focus-visible:outline-amber-400 ${category === item ? 'bg-amber-500/15 text-amber-200' : 'text-slate-300 hover:bg-slate-800'}`}>
              {item === '*' ? 'All choices' : item}<span className="text-slate-500">{filterTelemetryChoices(options, item, query, workflowType, taskType).length}</span>
            </button>)}
          </div>
          <div className="min-w-0 rounded-lg border border-slate-700 bg-slate-950/50">
            <p role="status" className="border-b border-slate-700 px-3 py-2 text-xs text-slate-400">{browsing ? `${choices.length} ${choices.length === 1 ? 'choice' : 'choices'}${category && category !== '*' ? ` in ${category.toLowerCase()}` : ''}` : 'Start with a category or a search'}</p>
            {choices.length ? <div ref={results} role="listbox" aria-label={`${label} choices`} onKeyDown={resultKeys} className="max-h-64 overflow-y-auto p-1 sm:max-h-80">
              {choices.map((option, index) => <button type="button" role="option" aria-selected={option.value === value} tabIndex={index === Math.min(active, choices.length - 1) ? 0 : -1} key={option.value}
                onFocus={() => setActive(index)} onClick={() => choose(option.value)}
                className="flex w-full items-start gap-2 rounded-md px-3 py-2.5 text-left hover:bg-slate-800 focus:bg-slate-800 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-amber-400">
                <div className="min-w-0 flex-1"><p className="break-words text-sm">{option.label}</p><p className="mt-1 break-words text-xs text-slate-400">{option.category}{option.description ? ` · ${option.description}` : ''}</p></div>
                {option.value === value && <Check className="mt-0.5 h-4 w-4 shrink-0 text-amber-300"/>}
              </button>)}
            </div> : <div className="px-4 py-8 text-sm text-slate-400">{!options.length ? 'No compatible choices are available in the selected scope.' : browsing ? 'No matches. Try another category or a broader search.' : 'Browse related choices together instead of scrolling through the entire catalog.'}</div>}
          </div>
        </div>
      </div>
    </dialog>
  </div>;
}
