'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, ShieldCheck, X } from 'lucide-react';
import { api, type AgentApprovals, type ProfileChange, type SetupCheck, type WorkflowCheck } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/date';
import {
  permissionExplanation,
  permissionStatus,
  routesSentence,
  setupExplanation,
  setupStatus,
  stillNeeded,
  workflowExplanation,
  workflowStatus,
  type CellStatus,
} from '@/lib/approvalStatus';
import { describeValue, fieldGuide, type FieldContext } from '@/lib/approvalFields';
import { StatusChip } from './HowApprovalsWork';

export type ApprovalTarget = { kind: 'permission' } | { kind: 'setup'; check: SetupCheck | WorkflowCheck };

const CHANGE_LABELS: Record<ProfileChange['change'], string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
};

function isWorkflow(check: SetupCheck | WorkflowCheck): check is WorkflowCheck {
  return check.resource_kind === 'workflow_setup';
}

/** A setting's value: in plain words when its saved form is code or JSON, with the exact value a click away. */
function ValueBlock({ path, value, tone }: { path: string; value: string | null; tone: 'before' | 'after' | 'only' }) {
  const plain = describeValue(path, value);
  const color = tone === 'before' ? 'text-slate-400' : tone === 'after' ? 'text-amber-100' : 'text-slate-200';
  const raw = <pre className={`mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-2 text-xs [font-variant-ligatures:none] ${color}`}>{value ?? '(empty)'}</pre>;
  if (!plain) return raw;
  return <div>
    <p className={`whitespace-pre-line rounded bg-slate-950 p-2 text-sm ${color}`}>{plain}</p>
    {value !== null && <details className="mt-1 text-xs text-slate-500">
      <summary className="cursor-pointer select-none hover:text-slate-300">Exact value</summary>
      {raw}
    </details>}
  </div>;
}

function ChangeRow({ change, firstApproval, context }: { change: ProfileChange; firstApproval: boolean; context: FieldContext }) {
  const guide = fieldGuide(change, context);
  return <li className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
    <p className="text-sm text-slate-100">
      <span className="font-medium">{change.label}</span>
      {!firstApproval && <span className="ml-2 text-xs text-slate-400">{CHANGE_LABELS[change.change]}</span>}
    </p>
    <p className="mt-1 text-xs text-slate-300">{guide.what}</p>
    <p className="mt-1 text-xs text-slate-400"><span className="font-medium text-slate-300">Why it needs your approval:</span> {guide.why}</p>
    {change.note && <p className="mt-2 text-xs text-slate-400">{change.note}</p>}
    {!change.note && (firstApproval ? (
      <div className="mt-2">
        <p className="text-[11px] uppercase tracking-wide text-slate-500">You would approve</p>
        <ValueBlock path={change.path} value={change.after} tone="only" />
      </div>
    ) : (
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Approved</p>
          <ValueBlock path={change.path} value={change.before} tone="before" />
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Now</p>
          <ValueBlock path={change.path} value={change.after} tone="after" />
        </div>
      </div>
    ))}
    {guide.where && <p className="mt-2 text-xs">
      <Link href={guide.where.href} className="text-amber-300 hover:underline">Change it: {guide.where.label}</Link>
    </p>}
  </li>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-2">
    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
    {children}
  </section>;
}

/** Review one check for one agent, and approve exactly what is shown. */
export function ApprovalDrawer({ entry, target, approvedFor = [], onClose, onApproved }: {
  entry: AgentApprovals;
  target: ApprovalTarget;
  /** Other agents the reviewed workflow's current setup is approved for. */
  approvedFor?: string[];
  onClose: () => void;
  onApproved: (message: string) => void;
}) {
  const [alsoAllow, setAlsoAllow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = entry.agent.name;
  const check = target.kind === 'setup' ? target.check : null;
  const workflow = check && isWorkflow(check) ? check : null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = target.kind === 'permission' ? 'Allowed to run on this machine'
    : workflow ? `Workflow setup: ${workflow.workflow.name}` : 'Agent setup';
  const status: CellStatus = target.kind === 'permission' ? permissionStatus(entry)
    : workflow ? workflowStatus(workflow) : setupStatus(entry);
  const what = target.kind === 'permission'
    ? `Whether Agent HQ may start ${name} on this machine at all. With it, ${name} can start its runtime and run commands here, as your user account.`
    : workflow
      ? `How tasks in ${workflow.workflow.name} prepare their workspace for ${name}: which repository it gets, how it gets it, and the commands that run before it starts. These are set on the workflow, so every agent in it gets the same setup, but each agent needs its own approval.`
      : `Everything that decides how ${name} behaves: its instructions, skills, model, runtime settings and the credentials it uses. These are set on ${name}'s agent page.`;
  const context: FieldContext = { agentId: entry.agent.id, agentName: name, workflowId: workflow?.workflow.id, workflowName: workflow?.workflow.name };
  const why = target.kind === 'permission' ? permissionExplanation(entry)
    : workflow ? `${routesSentence(name, workflow)} ${workflowExplanation(entry, workflow, approvedFor)}` : setupExplanation(entry);
  const holds = target.kind === 'permission' ? entry.host_execute_holds : check!.holds;
  const firstApproval = check?.state === 'not_approved';
  const approvable = target.kind === 'permission' ? !entry.host_execute : Boolean(check?.digest && !check.error && check.state !== 'approved');
  const granting = target.kind === 'permission' || (!entry.host_execute && alsoAllow);
  const needed = stillNeeded(entry, target.kind === 'permission' ? 'permission' : check!, granting);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await api.approvePending({
        agent_id: entry.agent.id,
        grant_host_execute: granting,
        profiles: check ? [{ resource_kind: check.resource_kind, resource_id: check.resource_id, digest: check.digest! }] : [],
      });
      const done = target.kind === 'permission' ? `${name} may now run on this machine.` : `Approved ${title.toLowerCase()} for ${name}.`;
      const next = needed.length > 0
        ? ` Its tasks still wait for ${needed.join(' and ')}.`
        : entry.holds.length > 0 ? ' Its waiting tasks start within about a minute.' : '';
      onApproved(done + next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return <div className="fixed inset-0 z-50 bg-black/50 sm:flex sm:justify-end" onClick={onClose}>
    <aside role="dialog" aria-modal="true" aria-label={`${name}: ${title}`}
      className="ml-auto flex h-full w-full max-w-2xl flex-col border-l border-slate-700 bg-slate-900 shadow-2xl"
      onClick={event => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-3 border-b border-slate-700 px-5 py-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{name}</p>
          <h2 className="text-base font-semibold text-white">{title}</h2>
          {workflow?.workflow.project_name && <p className="text-xs text-slate-400">Project {workflow.workflow.project_name}</p>}
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:text-white" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm text-slate-300">
        <Section title="What this is"><p>{what}</p></Section>

        <Section title="Why it’s here">
          <p className="flex flex-wrap items-center gap-2"><StatusChip tone={status.tone} label={status.label} /><span>{why}</span></p>
          {holds.length > 0 && <ul className="space-y-1 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
            {holds.map(hold => <li key={hold.task_id}>
              <Link href={`/tasks/${hold.task_id}`} className="text-red-100 hover:underline">#{hold.task_id} {hold.task_title}</Link>
              <span className="text-xs text-slate-400"> · can’t start · last tried {formatDateTime(hold.last_refused_at)}</span>
            </li>)}
          </ul>}
        </Section>

        {check && check.state !== 'approved' && <Section title={firstApproval ? 'What you would approve' : 'What changed since you approved it'}>
          {check.error && <p className="flex items-start gap-2 text-red-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />This setup can’t be approved until this is fixed: {check.error}</p>}
          <p className="text-xs text-slate-400">
            {firstApproval
              ? 'Each setting below is what Agent HQ would run with once you approve it, with what it is and why it needs your approval.'
              : 'Each setting that differs from what you approved, with what it is and why it needs your approval.'}
          </p>
          {check.changes.length > 0
            ? <ul className="space-y-2">{check.changes.map(change => <ChangeRow key={change.path} change={change} firstApproval={firstApproval} context={context} />)}</ul>
            : !check.error && <p className="text-xs text-slate-500">No setting has a value yet.</p>}
        </Section>}

        {approvable && <Section title="What approving does">
          <p>
            {target.kind === 'permission'
              ? `Adds the host.execute permission to ${name}'s current permissions; nothing else changes. You can remove it later on its Capability map.`
              : 'Agent HQ will run exactly what is shown above. If it changes again, it comes back here for you to review.'}
          </p>
          {check && !entry.host_execute && <label className="flex items-start gap-3 rounded-lg border border-slate-600 bg-slate-800/60 p-3">
            <input type="checkbox" className="mt-1" checked={alsoAllow} onChange={event => setAlsoAllow(event.target.checked)} />
            <span>
              <span className="font-medium text-slate-100">Also allow {name} to run on this machine</span>
              <span className="block text-xs text-slate-400">{name} isn’t allowed to run here yet, so its tasks wait even after you approve this. Ticking this adds the host.execute permission.</span>
            </span>
          </label>}
          {needed.length > 0 && <p className="text-xs text-amber-200">Approving this alone won’t start its tasks. Still needed: {needed.join('; ')}.</p>}
        </Section>}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-700 px-5 py-3">
        {error && <p role="alert" className="mr-auto flex items-start gap-2 text-sm text-red-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}
        <Button variant="ghost" onClick={onClose}>{approvable ? 'Cancel' : 'Close'}</Button>
        {approvable && <Button variant="primary" onClick={() => void approve()} loading={busy}>
          {!busy && <ShieldCheck className="h-4 w-4" />}
          {target.kind === 'permission' ? `Allow ${name} to run` : granting ? 'Approve and allow to run' : 'Approve'}
        </Button>}
      </div>
    </aside>
  </div>;
}
