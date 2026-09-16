'use client';

import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { telemetryBindingAttention } from '@/lib/telemetryBindings';
import type { TelemetryBinding } from '@/lib/telemetryTypes';

export const inputClass = 'w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500 disabled:opacity-50';
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="block space-y-1.5"><span className="text-xs font-medium text-slate-300">{label}</span>{children}{hint && <span className="block text-xs text-slate-500">{hint}</span>}</label>;
}
export function Select({ label, value, onChange, options, hint, disabled }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; hint?: string; disabled?: boolean }) {
  return <Field label={label} hint={hint}><select className={inputClass} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>;
}
export function ErrorNotice({ message }: { message: string | null }) {
  return message ? <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-950/30 p-3 text-sm text-red-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0"/><span className="whitespace-pre-wrap">{message}</span></div> : null;
}
export function JsonDetails({ value, label = 'Details' }: { value: unknown; label?: string }) {
  return <details className="text-xs"><summary className="cursor-pointer text-slate-400 hover:text-white">{label}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950/80 p-3 text-slate-300">{JSON.stringify(value, null, 2)}</pre></details>;
}
export function BindingHealthNotice({ binding }: { binding: TelemetryBinding }) {
  const issues = telemetryBindingAttention(binding);
  return issues.length ? <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-950/20 p-2"><Badge variant="warn">Needs attention</Badge><ul className="mt-2 space-y-1 text-xs text-amber-200">{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div> : null;
}
