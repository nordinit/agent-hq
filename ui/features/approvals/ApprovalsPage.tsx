'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, type AgentApprovals, type ApprovalHold } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ColumnHeaderLabel } from '@/components/ui/table-column-help';
import {
  matchesProject,
  permissionExplanation,
  permissionStatus,
  routesSentence,
  routingRulesHref,
  setupExplanation,
  setupStatus,
  sortApprovals,
  tasksStatus,
  workflowExplanation,
  workflowsStatus,
  workflowStatus,
  type CellStatus,
} from '@/lib/approvalStatus';
import { ApprovalDrawer, type ApprovalTarget } from './ApprovalDrawer';
import { HowApprovalsWork, StatusChip } from './HowApprovalsWork';

type View = 'attention' | 'all';

const COLUMN_HELP = {
  agent: 'The agent, its project and the runtime it uses. Click a row to see each check and what to do about it.',
  run: 'Whether Agent HQ may start this agent on this machine at all. This is the host.execute permission.',
  setup: 'Its instructions, skills, model, runtime settings and credentials, compared with what you approved.',
  workflows: 'For each workflow that sends work to this agent: its repository and setup commands, approved for this agent.',
  tasks: 'Tasks that can’t start right now because one of these checks failed.',
};

// A passing check shows only its chip, so the checks that need you stand out.
function Cell({ status }: { status: CellStatus }) {
  return <div className="space-y-1">
    <StatusChip tone={status.tone} label={status.label} title={status.detail} />
    {status.tone !== 'ok' && <p className="text-xs leading-snug text-slate-500">{status.detail}</p>}
  </div>;
}

function HoldList({ holds }: { holds: ApprovalHold[] }) {
  if (holds.length === 0) return null;
  return <ul className="mt-1 space-y-0.5">
    {holds.map(hold => <li key={hold.task_id} className="text-xs">
      <Link href={`/tasks/${hold.task_id}`} className="text-red-200 hover:underline">#{hold.task_id} {hold.task_title}</Link>
      <span className="text-slate-500"> can’t start</span>
    </li>)}
  </ul>;
}

function CheckRow({ name, sub, status, explanation, holds, children }: {
  name: string;
  sub?: string | null;
  status: CellStatus;
  explanation: string;
  holds: ApprovalHold[];
  children?: ReactNode;
}) {
  return <tr className="border-t border-slate-700/60 align-top">
    <td className="py-3 pl-3 pr-4">
      <p className="font-medium text-slate-100">{name}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </td>
    <td className="py-3 pr-4"><StatusChip tone={status.tone} label={status.label} /></td>
    <td className="py-3 pr-4 text-slate-300">
      <p>{explanation}</p>
      <HoldList holds={holds} />
    </td>
    <td className="py-3 pr-3">
      <div className="flex flex-col items-start gap-2">{children}</div>
    </td>
  </tr>;
}

/** The expanded row: every check for one agent, with a plain reason and the action that fits. */
function AgentChecks({ entry, onReview }: { entry: AgentApprovals; onReview: (target: ApprovalTarget) => void }) {
  const name = entry.agent.name;
  return <div className="rounded-lg border border-slate-700 bg-slate-900/70">
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
          <th className="py-2 pl-3 pr-4 font-semibold">Check</th>
          <th className="py-2 pr-4 font-semibold">Status</th>
          <th className="py-2 pr-4 font-semibold">What it means</th>
          <th className="w-48 py-2 pr-3 font-semibold">What you can do</th>
        </tr>
      </thead>
      <tbody>
        <CheckRow name="Allowed to run on this machine" sub="Permission: host.execute" status={permissionStatus(entry)}
          explanation={permissionExplanation(entry)} holds={entry.host_execute_holds}>
          {entry.host_execute
            ? <Link href={`/agents/${entry.agent.id}/resolution`} className="text-xs text-amber-300 hover:underline">Capability map</Link>
            : <Button size="sm" variant="primary" onClick={() => onReview({ kind: 'permission' })}>Review</Button>}
        </CheckRow>
        <CheckRow name="Agent setup" sub="Instructions, skills, model, credentials" status={setupStatus(entry)}
          explanation={setupExplanation(entry)} holds={entry.setup.holds}>
          {entry.setup.state !== 'approved'
            ? <Button size="sm" variant="primary" onClick={() => onReview({ kind: 'setup', check: entry.setup })}>Review</Button>
            : <span className="text-xs text-slate-500">Nothing to do</span>}
        </CheckRow>
        {entry.workflows.map(check => <CheckRow key={check.workflow.id} name={`Workflow: ${check.workflow.name}`}
          sub={check.workflow.project_name ? `Project ${check.workflow.project_name}` : null} status={workflowStatus(check)}
          explanation={`${routesSentence(name, check)} ${workflowExplanation(entry, check)}`} holds={check.holds}>
          {check.state !== 'approved'
            ? <>
              <Button size="sm" variant="primary" onClick={() => onReview({ kind: 'setup', check })}>Review</Button>
              {check.routes.count > 0 && <Link href={routingRulesHref(check.workflow.id, entry.agent.id)}
                title={`Opens the routing rules that send ${name} work in ${check.workflow.name}. Turn them off there if ${name} shouldn’t work here.`}
                className="text-xs text-slate-300 hover:text-amber-200">
                Stop routing {name} here <ExternalLink className="inline h-3 w-3 align-[-2px]" />
              </Link>}
            </>
            : <span className="text-xs text-slate-500">Nothing to do</span>}
        </CheckRow>)}
        {entry.workflows.length === 0 && <tr className="border-t border-slate-700/60">
          <td colSpan={4} className="px-3 py-3 text-xs text-slate-500">No routing rule sends {name} work, so no workflow setup is checked for it yet.</td>
        </tr>}
      </tbody>
    </table>
  </div>;
}

export default function ApprovalsPage() {
  const params = useSearchParams();
  const agentParam = Number(params.get('agent'));
  const linkedAgentId = Number.isSafeInteger(agentParam) && agentParam > 0 ? agentParam : null;
  const [entries, setEntries] = useState<AgentApprovals[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [view, setView] = useState<View>('attention');
  const [projectId, setProjectId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(linkedAgentId ? [linkedAgentId] : []));
  const [review, setReview] = useState<{ agentId: number; target: ApprovalTarget } | null>(null);
  const [linkApplied, setLinkApplied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries((await api.getApprovals()).agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // A "Review and approve" link from a task opens that agent's row, even when it needs nothing.
  useEffect(() => {
    if (!entries || linkApplied || linkedAgentId === null) return;
    const linked = entries.find(entry => entry.agent.id === linkedAgentId);
    if (linked && !linked.needs_attention) setView('all');
    setLinkApplied(true);
    window.setTimeout(() => document.getElementById(`agent-${linkedAgentId}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
  }, [entries, linkApplied, linkedAgentId]);

  const projects = useMemo(() => {
    const byId = new Map<number, string>();
    for (const entry of entries ?? []) {
      if (entry.agent.project_id !== null) byId.set(entry.agent.project_id, entry.agent.project_name ?? `Project #${entry.agent.project_id}`);
      for (const check of entry.workflows) {
        if (check.workflow.project_id !== null) byId.set(check.workflow.project_id, check.workflow.project_name ?? `Project #${check.workflow.project_id}`);
      }
    }
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]));
  }, [entries]);

  const inProject = useMemo(() => sortApprovals((entries ?? []).filter(entry => matchesProject(entry, projectId))), [entries, projectId]);
  const attention = inProject.filter(entry => entry.needs_attention);
  const shown = view === 'attention' ? attention : inProject;
  const stuckTasks = new Set(inProject.flatMap(entry => entry.holds.map(hold => hold.task_id))).size;
  const reviewed = review ? (entries ?? []).find(entry => entry.agent.id === review.agentId) ?? null : null;

  function toggle(agentId: number) {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId); else next.add(agentId);
      return next;
    });
  }

  return <div className="mx-auto max-w-7xl space-y-5 p-4 md:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-100"><ShieldCheck className="h-6 w-6 text-amber-300" /> Approvals</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          Before Agent HQ starts an agent on a task, it checks three things. This page shows where every agent stands, and lets you approve what’s missing.
        </p>
      </div>
      <Button onClick={() => void load()} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh</Button>
    </div>

    <HowApprovalsWork />

    {entries && <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-700 bg-slate-800/40 px-4 py-3 text-sm">
      <span className={stuckTasks > 0 ? 'font-medium text-red-200' : 'text-slate-400'}>
        {stuckTasks === 0 ? 'No task is waiting on an approval' : `${stuckTasks} ${stuckTasks === 1 ? 'task can’t' : 'tasks can’t'} start`}
      </span>
      <span className={attention.length > 0 ? 'text-amber-200' : 'text-slate-400'}>
        {attention.length} {attention.length === 1 ? 'agent needs' : 'agents need'} your attention
      </span>
      <span className="text-slate-400">{inProject.length - attention.length} of {inProject.length} agents fully approved</span>
    </div>}

    <div className="flex flex-wrap items-center gap-3">
      <div role="radiogroup" aria-label="Which agents to show" className="inline-flex rounded-lg border border-slate-700 bg-slate-800/60 p-0.5 text-sm">
        {([['attention', `Needs attention (${attention.length})`], ['all', `All agents (${inProject.length})`]] as const).map(([key, label]) => (
          <button key={key} type="button" role="radio" aria-checked={view === key} onClick={() => setView(key)}
            className={`rounded-md px-3 py-1.5 ${view === key ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>{label}</button>
        ))}
      </div>
      {projects.length > 1 && <label className="flex items-center gap-2 text-sm text-slate-400">
        Project
        <select value={projectId ?? ''} onChange={event => setProjectId(event.target.value ? Number(event.target.value) : null)}
          className="rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-slate-100">
          <option value="">All projects</option>
          {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>}
    </div>

    {message && <p role="status" className="flex items-start gap-2 rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{message}</p>}
    {error && <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}
    {entries === null && loading && <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Checking every agent’s setup…</div>}

    {entries && shown.length === 0 && <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-5 text-sm text-slate-300">
      <p className="font-medium text-slate-100">{view === 'attention' ? 'Nothing needs your attention.' : 'No enabled agents in this project.'}</p>
      {view === 'attention' && <>
        <p className="mt-1 text-slate-400">
          Every agent with work routed to it is allowed to run and approved. An agent shows up here when a task can’t start,
          when a setup changes after you approved it, or when work is routed to a setup you haven’t approved yet.
        </p>
        {inProject.length > 0 && <Button size="sm" className="mt-3" onClick={() => setView('all')}>Show all agents</Button>}
      </>}
    </div>}

    {shown.length > 0 && <div className="overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800/60">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-sm">
          <thead>
            <tr className="border-b border-slate-700 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
              <th className="w-[22%] px-3 py-2.5"><ColumnHeaderLabel label="Agent" description={COLUMN_HELP.agent} /></th>
              <th className="px-3 py-2.5"><ColumnHeaderLabel label="Allowed to run" description={COLUMN_HELP.run} /></th>
              <th className="px-3 py-2.5"><ColumnHeaderLabel label="Agent setup" description={COLUMN_HELP.setup} /></th>
              <th className="px-3 py-2.5"><ColumnHeaderLabel label="Workflow setups" description={COLUMN_HELP.workflows} /></th>
              <th className="px-3 py-2.5"><ColumnHeaderLabel label="Tasks" description={COLUMN_HELP.tasks} align="right" /></th>
            </tr>
          </thead>
          <tbody>
            {shown.map(entry => {
              const open = expanded.has(entry.agent.id);
              return <Fragment key={entry.agent.id}>
                <tr id={`agent-${entry.agent.id}`} onClick={() => toggle(entry.agent.id)}
                  className={`cursor-pointer border-b border-slate-700/60 align-top hover:bg-slate-700/30 ${entry.holds.length > 0 ? 'bg-red-500/5' : ''}`}>
                  <td className="px-3 py-3">
                    <div className="flex items-start gap-2">
                      <button type="button" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} checks for ${entry.agent.name}`}
                        onClick={event => { event.stopPropagation(); toggle(entry.agent.id); }} className="mt-0.5 text-slate-400 hover:text-white">
                        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                      <div className="min-w-0">
                        <Link href={`/agents/${entry.agent.id}`} onClick={event => event.stopPropagation()} className="font-semibold text-white hover:text-amber-200">{entry.agent.name}</Link>
                        <p className="text-xs text-slate-500">{[entry.agent.project_name, entry.agent.runtime_type ?? 'openclaw'].filter(Boolean).join(' · ')}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3"><Cell status={permissionStatus(entry)} /></td>
                  <td className="px-3 py-3"><Cell status={setupStatus(entry)} /></td>
                  <td className="px-3 py-3"><Cell status={workflowsStatus(entry)} /></td>
                  <td className="px-3 py-3 text-right"><div className="inline-block text-left"><Cell status={tasksStatus(entry)} /></div></td>
                </tr>
                {open && <tr className="border-b border-slate-700/60 bg-slate-900/40">
                  <td colSpan={5} className="px-3 py-3">
                    <AgentChecks entry={entry} onReview={target => setReview({ agentId: entry.agent.id, target })} />
                  </td>
                </tr>}
              </Fragment>;
            })}
          </tbody>
        </table>
      </div>
    </div>}

    {review && reviewed && <ApprovalDrawer entry={reviewed} target={review.target} onClose={() => setReview(null)}
      onApproved={text => { setReview(null); setMessage(text); void load(); }} />}
  </div>;
}
