'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, type PendingApprovalAgent, type PendingProfile, type ProfileChange } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatDateTime } from '@/lib/date';

const CHANGE_LABELS: Record<ProfileChange['change'], string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
};

function ChangeRow({ change, firstApproval }: { change: ProfileChange; firstApproval: boolean }) {
  return <li className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
    <p className="text-sm text-slate-200">
      <span className="font-medium">{change.label}</span>
      {!firstApproval && <span className="ml-2 text-xs text-slate-400">{CHANGE_LABELS[change.change]}</span>}
    </p>
    {change.note && <p className="mt-1 text-xs text-slate-400">{change.note}</p>}
    {!change.note && (firstApproval ? (
      change.after && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-2 text-xs text-slate-200">{change.after}</pre>
    ) : (
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Approved</p>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-2 text-xs text-slate-400">{change.before ?? '(empty)'}</pre>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Now</p>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-2 text-xs text-amber-100">{change.after ?? '(empty)'}</pre>
        </div>
      </div>
    ))}
  </li>;
}

function ProfileSection({ profile }: { profile: PendingProfile }) {
  const firstApproval = profile.state === 'not_approved';
  return <div className="space-y-2">
    <p className="text-sm font-semibold text-white">
      {profile.resource_name}
      <span className="ml-2 text-xs font-normal text-slate-400">
        {firstApproval ? 'Never approved: this is what you would approve' : 'Changed since you approved it'}
      </span>
    </p>
    {profile.error && <p className="flex items-start gap-2 text-sm text-red-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />This setup can&apos;t be approved until this is fixed: {profile.error}</p>}
    {profile.changes.length > 0
      ? <ul className="space-y-2">{profile.changes.map(change => <ChangeRow key={change.path} change={change} firstApproval={firstApproval} />)}</ul>
      : !profile.error && <p className="text-xs text-slate-500">No setting has a value yet.</p>}
  </div>;
}

function AgentApproval({ entry, onApproved }: { entry: PendingApprovalAgent; onApproved: (message: string) => void }) {
  const [allowRun, setAllowRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approvable = entry.profiles.filter(profile => profile.digest && !profile.error);
  const canApprove = approvable.length > 0 || (!entry.host_execute && allowRun);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await api.approvePending({
        agent_id: entry.agent.id,
        grant_host_execute: !entry.host_execute && allowRun,
        profiles: approvable.map(profile => ({ resource_kind: profile.resource_kind, resource_id: profile.resource_id, digest: profile.digest! })),
      });
      onApproved(`Approved ${entry.agent.name}. Agent HQ starts its waiting tasks on its next check, within about a minute.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return <Card className="space-y-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <Link href={`/agents/${entry.agent.id}`} className="text-lg font-semibold text-white hover:text-amber-200">{entry.agent.name}</Link>
      <span className="text-xs text-slate-400">{entry.agent.runtime_type ?? 'openclaw'}</span>
    </div>

    {entry.holds.length > 0 && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
      <p className="text-sm font-medium text-amber-100">Can&apos;t start {entry.holds.length} {entry.holds.length === 1 ? 'task' : 'tasks'}</p>
      <ul className="mt-2 space-y-1 text-sm">
        {entry.holds.map(hold => <li key={hold.task_id} className="text-slate-300">
          <Link href={`/tasks/${hold.task_id}`} className="text-amber-200 hover:underline">#{hold.task_id} {hold.task_title}</Link>
          <span className="text-slate-400"> · {hold.reason} · last tried {formatDateTime(hold.last_refused_at)}</span>
        </li>)}
      </ul>
    </div>}

    {!entry.host_execute && <label className="flex items-start gap-3 rounded-lg border border-slate-600 bg-slate-900/60 p-3 text-sm text-slate-200">
      <input type="checkbox" className="mt-1" checked={allowRun} onChange={event => setAllowRun(event.target.checked)} />
      <span>
        <span className="font-medium">Allow {entry.agent.name} to run on this machine</span>
        <span className="block text-xs text-slate-400">Adds the host.execute permission to its current permissions. It can then start its runtime and run commands here. You can remove it on the agent&apos;s Capability map.</span>
      </span>
    </label>}

    {entry.profiles.map(profile => <ProfileSection key={`${profile.resource_kind}:${profile.resource_id}`} profile={profile} />)}

    {error && <p role="alert" className="flex items-start gap-2 text-sm text-red-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" onClick={() => void approve()} disabled={!canApprove} loading={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
        {approvable.length > 0 ? (allowRun && !entry.host_execute ? 'Approve and allow to run' : 'Approve') : 'Allow to run'}
      </Button>
      {!canApprove && !entry.host_execute && <span className="text-xs text-slate-400">Tick the box above to let it run.</span>}
    </div>
  </Card>;
}

export default function ApprovalsPage() {
  const params = useSearchParams();
  const agentParam = Number(params.get('agent'));
  const agentId = Number.isSafeInteger(agentParam) && agentParam > 0 ? agentParam : undefined;
  const [agents, setAgents] = useState<PendingApprovalAgent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAgents((await api.getPendingApprovals(agentId)).agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  return <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-100"><ShieldCheck className="h-6 w-6 text-amber-300" /> Approvals</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          Agents that can&apos;t start, or whose setup changed since you approved it. Changes you save yourself are approved as you save them; changes made with an agent&apos;s key, or outside Agent HQ, wait here for you.
        </p>
      </div>
      <Button onClick={() => void load()} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh</Button>
    </div>

    {agentId && <p className="text-sm text-slate-400">Showing one agent. <Link href="/approvals" className="text-amber-300 hover:underline">Show all</Link></p>}
    {message && <p role="status" className="flex items-start gap-2 rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{message}</p>}
    {error && <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}
    {agents === null && loading && <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Checking every agent&apos;s setup…</div>}
    {agents?.length === 0 && <Card><p className="text-sm text-slate-300">Nothing is waiting for approval.</p></Card>}
    {agents?.map(entry => <AgentApproval key={entry.agent.id} entry={entry} onApproved={text => { setMessage(text); void load(); }} />)}
  </div>;
}
