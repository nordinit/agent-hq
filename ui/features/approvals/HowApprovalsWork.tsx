'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileCheck2, GitBranch, Server } from 'lucide-react';
import { TONE_CLASSES, type ApprovalTone } from '@/lib/approvalStatus';

const STORAGE_KEY = 'agent-hq:approvals:explainer-closed';

const CHECKS = [
  {
    icon: Server,
    title: 'Allowed to run here',
    body: 'The agent has permission to run commands on this machine. Without it, Agent HQ never starts the agent.',
    technical: 'Permission: host.execute',
  },
  {
    icon: FileCheck2,
    title: 'Agent setup approved',
    body: 'Its instructions, skills, model, runtime settings and credentials are exactly what you approved.',
    technical: 'Approved revision: agent runtime',
  },
  {
    icon: GitBranch,
    title: 'Workflow setup approved',
    body: 'The repository and setup commands of the task’s workflow are approved for this agent.',
    technical: 'Approved revision: workflow setup',
  },
];

export const LEGEND: Array<{ tone: ApprovalTone; label: string; meaning: string }> = [
  { tone: 'blocked', label: 'Can’t start', meaning: 'A task is waiting on this right now.' },
  { tone: 'attention', label: 'Changed or not approved', meaning: 'Work routed to the agent will wait for you. Nothing is waiting yet.' },
  { tone: 'ok', label: 'Approved or allowed', meaning: 'This check passes.' },
  { tone: 'muted', label: 'Not in use', meaning: 'Not approved, but nothing is routed there, so nothing waits on it.' },
];

export function StatusChip({ tone, label, title }: { tone: ApprovalTone; label: string; title?: string }) {
  return <span title={title} className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}>{label}</span>;
}

/** What approvals are and how they decide whether a task starts. Open until the operator closes it. */
export function HowApprovalsWork() {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try { if (window.localStorage.getItem(STORAGE_KEY) === '1') setOpen(false); } catch { /* storage unavailable */ }
  }, []);
  function toggle() {
    const next = !open;
    setOpen(next);
    try { window.localStorage.setItem(STORAGE_KEY, next ? '0' : '1'); } catch { /* storage unavailable */ }
  }

  return <section className="rounded-xl border border-slate-700 bg-slate-800/50">
    <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-slate-100">
      {open ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
      How approvals work
    </button>
    {open && <div className="space-y-4 border-t border-slate-700 px-4 py-4 text-sm text-slate-300">
      <p>
        Agent HQ runs agents on your machine, so it starts one only after you’ve signed off on what it will do.
        Before each task starts, it checks three things:
      </p>
      <ol className="grid gap-3 md:grid-cols-3">
        {CHECKS.map(({ icon: Icon, title, body, technical }, index) => <li key={title} className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
          <p className="flex items-center gap-2 font-medium text-white"><Icon className="h-4 w-4 text-amber-300" />{index + 1}. {title}</p>
          <p className="mt-1 text-slate-300">{body}</p>
          <p className="mt-2 text-[11px] text-slate-500">{technical}</p>
        </li>)}
      </ol>
      <ul className="list-disc space-y-1 pl-5 text-slate-300">
        <li>If a check fails, the task waits and shows <span className="font-medium text-red-200">Can’t start</span>. Agent HQ tries again about every 12 seconds, so it starts within a minute of your approval.</li>
        <li>Changes you save yourself are approved as you save them. Changes made with an agent’s key, or outside Agent HQ, wait here for you.</li>
        <li>Approval is per agent and per workflow. Approving an agent for one workflow doesn’t cover another workflow it is routed to.</li>
        <li>An agent can be listed here while it works normally: its approved work keeps running, and only work routed to an unapproved setup would wait.</li>
      </ul>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">What the colours mean</p>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {LEGEND.map(item => <li key={item.tone} className="flex items-start gap-2">
            <StatusChip tone={item.tone} label={item.label} />
            <span className="text-xs text-slate-400">{item.meaning}</span>
          </li>)}
        </ul>
      </div>
    </div>}
  </section>;
}
