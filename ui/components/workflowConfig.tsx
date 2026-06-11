'use client';

import type { ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { WorkflowRoutingWarning } from '@/lib/api';
import { getTaskTypeLabel } from '@/lib/taskTypes';

export const COLOR_BADGE_CLASSES: Record<string, string> = {
  slate: 'bg-slate-700 text-slate-300',
  red: 'bg-red-900/60 text-red-300',
  orange: 'bg-orange-900/60 text-orange-300',
  amber: 'bg-amber-900/60 text-amber-300',
  yellow: 'bg-yellow-900/60 text-yellow-300',
  green: 'bg-green-900/60 text-green-300',
  blue: 'bg-blue-900/60 text-blue-300',
  indigo: 'bg-indigo-900/60 text-indigo-300',
  purple: 'bg-purple-900/60 text-purple-300',
  pink: 'bg-pink-900/60 text-pink-300',
  rose: 'bg-rose-900/60 text-rose-300',
  cyan: 'bg-cyan-900/60 text-cyan-300',
  emerald: 'bg-emerald-900/60 text-emerald-300',
};

export const TABLE_EDIT_ACTION_CLASS = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-700/60 hover:text-slate-100';
export const TABLE_DELETE_ACTION_CLASS = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-red-400 transition-colors hover:bg-red-900/20 hover:text-red-300';
export const SCOPE_CARD_CLASS = 'border-amber-500/20 bg-slate-900/80 p-5 shadow-sm shadow-amber-950/20';

export function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={text}
        className="inline-flex h-6 w-6 items-center justify-center text-slate-500 transition-colors hover:text-amber-300 focus:text-amber-300 focus:outline-none"
      >
        <Info className="h-4 w-4" />
      </button>
      <span className="pointer-events-none absolute left-1/2 top-7 z-20 hidden w-72 -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-left text-xs font-normal normal-case tracking-normal text-slate-300 shadow-xl group-hover:block group-focus-within:block">
        {text}
      </span>
    </span>
  );
}

export function SectionHeader({
  label,
  help,
  actions,
  actionsClassName = 'flex flex-wrap items-center gap-2',
}: {
  label: string;
  help: string;
  actions?: ReactNode;
  actionsClassName?: string;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">{label}</p>
        <InfoTooltip text={help} />
      </div>
      {actions && <div className={actionsClassName}>{actions}</div>}
    </div>
  );
}

export function RoutingWarningBanner({
  warnings,
  scopeLabel,
}: {
  warnings: WorkflowRoutingWarning[];
  scopeLabel: string;
}) {
  if (warnings.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <div className="space-y-2">
          <p className="font-medium text-amber-200">
            {scopeLabel} has dispatchable statuses with no explicit exit path.
          </p>
          <ul className="space-y-1 text-xs text-amber-100/90">
            {warnings.map((warning) => (
              <li key={`${warning.status}-${warning.routing_rule_ids.join('-')}`}>
                <span className="font-semibold">{warning.status_label}</span>
                <span className="text-amber-200/80"> ({warning.status})</span>
                {warning.task_types.length > 0
                  ? ` routes ${warning.task_types.map(getTaskTypeLabel).join(', ')} work to an agent, but there are no configured workflow-event or outcome transitions from that status.`
                  : ' routes work to an agent, but there are no configured workflow-event or outcome transitions from that status.'}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function ScopeBadge({
  kind,
}: {
  kind?: 'default_scope' | 'sprint_type_default' | 'sprint_override';
}) {
  if (kind === 'sprint_override') {
    return <Badge className="bg-purple-900/60 text-purple-200 text-[10px]">override</Badge>;
  }
  return <Badge className="bg-cyan-900/50 text-cyan-200 text-[10px]">default</Badge>;
}
