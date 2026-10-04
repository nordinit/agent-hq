'use client';
import { useEffect, useState } from 'react';
import { api, type JobInstance } from '@/lib/api';
import { ContextViewer } from '@/features/tasks/ContextViewer';
import { Card } from '@/components/ui/card';
import { formatDateTime } from '@/lib/date';

export function AgentResolutionRuns({ agentId }: { agentId: number }) {
  const [runs, setRuns] = useState<JobInstance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [instanceId, setInstanceId] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    api.getAgentInstances(agentId, { limit: 10 }).then(result => { if (current) setRuns(result); }).catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [agentId]);
  return <Card><h3 className="font-semibold text-white">Inspect an actual run</h3><p className="text-sm text-slate-400 mt-2">Open the captured prompt, runtime boundary, and changes from the previous run of the same task. Historical captures may differ from today’s configuration.</p>
    {error ? <p role="alert" className="mt-3 text-sm text-red-300">{error}</p> : !runs ? <p className="mt-3 text-sm text-slate-500">Loading runs…</p> : !runs.length ? <p className="mt-3 text-sm text-slate-500">No runs recorded yet.</p> : <ul className="mt-3 divide-y divide-slate-800">{runs.map(run => <li key={run.id}><button className="w-full text-left py-3 flex flex-wrap justify-between gap-2 text-sm text-amber-300 hover:text-amber-200" onClick={() => setInstanceId(run.id)}><span>Run #{run.id} · {run.job_title || run.agent_name || 'Dispatch'}</span><span className="text-slate-500">{run.status} · {formatDateTime(run.created_at)}</span></button></li>)}</ul>}
    {instanceId !== null && <ContextViewer instanceId={instanceId} onClose={() => setInstanceId(null)} />}
  </Card>;
}
