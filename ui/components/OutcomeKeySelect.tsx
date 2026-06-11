'use client';

import type { OutcomeOption } from '@/lib/useSprintOutcomeCatalog';
import { formatOutcomeOptionLabel } from '@/lib/useSprintOutcomeCatalog';

export function OutcomeKeySelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: OutcomeOption[];
}) {
  return (
    <label className="block">
      {label ? <span className="sr-only">{label}</span> : null}
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full min-w-[190px] rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white"
      >
        <option value="">Select outcome&hellip;</option>
        {options.map(option => (
          <option key={`${option.taskType ?? 'global'}:${option.value}`} value={option.value}>
            {formatOutcomeOptionLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}
