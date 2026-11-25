'use client';

import Link from 'next/link';
import type { LaunchHold } from '@/lib/api';
import { formatDateTime } from '@/lib/date';

/** A launch Agent HQ refused: no run exists, so this is the only place the task says why. */
export function LaunchHoldBanner({ hold }: { hold?: LaunchHold | null }) {
  if (!hold) return null;
  return <section role="status" className="rounded-lg border border-amber-500/40 bg-amber-950/20 p-4 text-sm">
    <p className="font-semibold text-white">Can&apos;t start</p>
    <p className="mt-1 text-slate-200">{hold.reason}</p>
    <p className="mt-1 text-xs text-slate-400">
      Agent HQ has tried {hold.attempts} {hold.attempts === 1 ? 'time' : 'times'} since {formatDateTime(hold.first_refused_at)} and keeps trying. Nothing has run yet.
    </p>
    <Link href={`/approvals?agent=${hold.agent_id}`} className="mt-3 inline-block rounded border border-amber-400/60 px-3 py-1 font-medium text-amber-200 hover:bg-amber-400/10">
      Review and approve
    </Link>
  </section>;
}
