'use client';

import Link from 'next/link';
import { useState } from 'react';
import { getApiBase, type RuntimeRecovery } from '@/lib/api';
import { formatDateTime } from '@/lib/date';

export function RuntimeRecoveryBanner({ recovery }: { recovery?: RuntimeRecovery | null }) {
  const [retrying, setRetrying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!recovery) return null;
  const attention = recovery.state === 'attention';
  const retry = async () => {
    setRetrying(true); setMessage(null);
    try {
      const res = await fetch(`${getApiBase()}/api/v1/agents/${recovery.agent_id}/mcp/sync`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force_reconcile: true }),
      });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error ?? 'Recovery failed');
      setMessage('Configuration verified. Eligible tasks can resume.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Recovery failed'); }
    finally { setRetrying(false); }
  };
  return <section role="status" className={`rounded-lg border p-4 text-sm ${attention ? 'border-red-500/40 bg-red-950/20' : 'border-amber-500/40 bg-amber-950/20'}`}>
    <p className="font-semibold text-white">{attention ? 'Recovery failed — needs attention' : 'Recovering tool configuration'}</p>
    <p className="mt-1 text-slate-300">Task dispatch is waiting for <Link className="underline" href={`/agents/${recovery.agent_id}`}>agent #{recovery.agent_id}</Link>.</p>
    <p className="mt-1 text-xs text-slate-400">Started {formatDateTime(recovery.started_at)} · Escalation {formatDateTime(recovery.deadline_at)} · {recovery.attempts} recovery attempts</p>
    <p className="mt-2 break-words text-slate-300">{recovery.last_error}</p>
    {attention && <button disabled={retrying} onClick={() => void retry()} className="mt-3 rounded border border-slate-500 px-3 py-1 text-white disabled:opacity-50">{retrying ? 'Recovering…' : 'Retry recovery'}</button>}
    {message && <p className="mt-2 text-slate-200">{message}</p>}
  </section>;
}
