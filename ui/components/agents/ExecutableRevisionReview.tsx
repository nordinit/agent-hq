'use client';
import { useState } from 'react';
import { apiFetch } from '@/lib/api/http';

type Revision = { id: string; resource_kind: string; resource_id: number; digest: string; published_at: string | null; revoked_at: string | null; snapshot?: unknown };

export function ExecutableRevisionReview({ agentId }: { agentId: number }) {
  const [kind, setKind] = useState('agent_runtime');
  const [resourceId, setResourceId] = useState(String(agentId));
  const [revision, setRevision] = useState<Revision | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function action(fn: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await fn(); } catch (e) { setMessage(e instanceof Error ? e.message : 'Request failed.'); }
    finally { setBusy(false); }
  }
  async function load(id: string) { setRevision(await apiFetch<Revision>(`/api/v1/execution/revisions/${id}`)); setConfirmed(false); }
  return <details className="rounded-xl border border-slate-700 p-4 text-sm text-slate-300">
    <summary className="cursor-pointer font-medium">Review and approve executable revisions</summary>
    <p className="mt-3">Draft changes do not replace published execution. Review the exact source, dependency pins and digest before approval. Publishing, binding and granting execution are separate actions.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <select aria-label="Executable kind" className="bg-slate-900 p-2" value={kind} onChange={e => { setKind(e.target.value); setRevision(null); }}>{['agent_runtime', 'workflow_setup', 'tool', 'mcp_server'].map(k => <option key={k}>{k}</option>)}</select>
      <input aria-label="Executable resource ID" className="bg-slate-900 p-2 w-28" type="number" min={1} value={resourceId} onChange={e => { setResourceId(e.target.value); setRevision(null); }} />
      <button disabled={busy || !Number.isSafeInteger(Number(resourceId)) || Number(resourceId) < 1} onClick={() => action(async () => { const draft = await apiFetch<Revision>('/api/v1/execution/revisions', { method: 'POST', body: JSON.stringify({ resource_kind: kind, resource_id: Number(resourceId) }) }); await load(draft.id); })}>Snapshot draft for review</button>
      <button disabled={busy} onClick={() => action(async () => { const result = await apiFetch<{ revisions: Revision[] }>(`/api/v1/execution/revisions?resource_kind=${kind}&resource_id=${resourceId}`); if (!result.revisions[0]) { setMessage('No revisions found.'); return; } await load(result.revisions[0].id); })}>Load latest revision</button>
    </div>
    {revision && <div className="mt-3 space-y-3">
      <p>Revision {revision.id} · {revision.revoked_at ? 'Revoked' : revision.published_at ? 'Published' : 'Draft'}</p>
      <p className="break-all font-mono text-xs">SHA-256: {revision.digest}</p>
      <pre className="max-h-80 overflow-auto bg-slate-950 p-3 text-xs">{JSON.stringify(revision.snapshot, null, 2)}</pre>
      {!revision.published_at && !revision.revoked_at && <label className="block"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I reviewed this exact revision and its execution policy.</label>}
      <div className="flex flex-wrap gap-4">
        <button disabled={busy || !confirmed || !!revision.published_at || !!revision.revoked_at} onClick={() => action(async () => { await apiFetch(`/api/v1/execution/revisions/${revision.id}/publish`, { method: 'POST', body: JSON.stringify({ digest: revision.digest }) }); await load(revision.id); setMessage('Published. Assignment and execution grants are still required.'); })}>Publish reviewed revision</button>
        <button disabled={busy || !revision.published_at || !!revision.revoked_at} onClick={() => action(async () => { await apiFetch('/api/v1/execution/bindings', { method: 'POST', body: JSON.stringify({ subject_kind: 'agent', subject_id: agentId, revision_id: revision.id }) }); setMessage(`Bound to agent #${agentId}. Execution authority is checked separately.`); })}>Bind to this agent</button>
        <button disabled={busy || !!revision.revoked_at} onClick={() => action(async () => { await apiFetch(`/api/v1/execution/revisions/${revision.id}/revoke`, { method: 'POST', body: '{}' }); await load(revision.id); setMessage('Revoked. Future mediated calls are denied; already-running processes require a separate stop.'); })}>Revoke revision</button>
      </div>
    </div>}
    {message && <p role="status" className="mt-3 text-amber-300">{message}</p>}
  </details>;
}
