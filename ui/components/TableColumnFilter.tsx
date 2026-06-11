'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { ColumnHeaderTooltip } from '@/components/ui/table-column-help';

export type ColumnFilterOption = { value: string; label: string };

export function matchesColumnFilter(selected: string[], value: string): boolean {
  return selected.length === 0 || selected.includes(value);
}

export function uniqueColumnOptions(options: ColumnFilterOption[]): ColumnFilterOption[] {
  const seen = new Map<string, string>();
  for (const option of options) {
    if (!seen.has(option.value)) seen.set(option.value, option.label);
  }
  return Array.from(seen, ([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function TableColumnFilter({
  label,
  description,
  selected,
  options,
  onChange,
  align = 'left',
}: {
  label: string;
  description?: string;
  selected: string[];
  options: ColumnFilterOption[];
  onChange: (values: string[]) => void;
  align?: 'left' | 'right' | 'center';
}) {
  const [open, setOpen] = useState(false);
  const normalizedOptions = uniqueColumnOptions(options);
  const selectedSet = new Set(selected);
  const toggle = (value: string) => {
    onChange(selectedSet.has(value)
      ? selected.filter(item => item !== value)
      : [...selected, value]);
  };
  const menuAlignment = align === 'right'
    ? 'right-0'
    : align === 'center'
      ? 'left-1/2 -translate-x-1/2'
      : 'left-0';

  return (
    <div className={`relative inline-flex ${align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : ''}`}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-label={description ? `${label}: ${description}` : label}
        className={`group relative inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-semibold uppercase tracking-wider transition-colors ${selected.length > 0 ? 'text-amber-300' : 'text-slate-400 hover:text-slate-200'}`}
      >
        <span className="truncate">{label}</span>
        {selected.length > 0 && (
          <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] leading-none text-amber-300">{selected.length}</span>
        )}
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        {description && !open && <ColumnHeaderTooltip description={description} align={align} />}
      </button>
      {open && (
        <div className={`absolute top-6 z-30 min-w-[190px] rounded-lg border border-slate-700 bg-slate-950 p-2 shadow-xl ${menuAlignment}`}>
          <div className="mb-2 flex items-center justify-between gap-3 border-b border-slate-800 pb-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Filter</span>
            {selected.length > 0 && (
              <button type="button" onClick={() => onChange([])} className="text-xs text-amber-300 hover:text-amber-200">Clear</button>
            )}
          </div>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {normalizedOptions.length === 0 ? (
              <p className="px-1 py-2 text-xs text-slate-500">No values</p>
            ) : normalizedOptions.map(option => (
              <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
                <input
                  type="checkbox"
                  checked={selectedSet.has(option.value)}
                  onChange={() => toggle(option.value)}
                  className="h-3 w-3 rounded border-slate-600 bg-slate-900 text-amber-500"
                />
                <span className="truncate">{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
