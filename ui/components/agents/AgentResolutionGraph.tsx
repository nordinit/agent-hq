'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, type AgentMcpToolAccessPreview } from '@/lib/api';
import { getAgentResolution, type AgentResolution, type ResolutionEntry } from '@/lib/api/agentResolution';
import { AgentResolutionRuns } from './AgentResolutionRuns';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const colors = { active: '#34d399', overridden: '#94a3b8', opted_out: '#fb7185', disabled: '#fbbf24' };
const fieldClass = 'rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100';

export function AgentResolutionGraph({ agentId }: { agentId: number }) {
  const [data, setData] = useState<AgentResolution | null>(null);
  const [workflowId, setWorkflowId] = useState<number | null>(null);
  const [kind, setKind] = useState<ResolutionEntry['kind']>('tool');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<AgentMcpToolAccessPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setDraft(null); setPreview(null);
    getAgentResolution(agentId, workflowId).then(result => {
      if (!cancelled) { setData(result); setSelection(null); }
    }).catch(e => { if (!cancelled) setError(String(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [agentId, workflowId, revision]);
  const entries = useMemo(() => data?.entries.filter(e => e.kind === kind && e.label.toLowerCase().includes(search.toLowerCase())) ?? [], [data, kind, search]);
  const selected = data?.entries.find(e => e.id === selection);
  if (loading) return <Card><p role="status" className="text-slate-400">Resolving capabilities…</p></Card>;
  if (error || !data) return <Card><p role="alert" className="text-red-300">{error ?? 'Resolution unavailable.'}</p><Button onClick={() => setRevision(r => r + 1)}>Retry</Button>{workflowId && <Button onClick={() => setWorkflowId(null)}>Clear workflow</Button>}</Card>;
  const visibleSources = data.sources.filter(source => entries.some(entry => entry.sources.some(s => s.source_id === source.id)));
  const sourceY = (index: number) => 38 + index * 86;
  const entryY = (index: number) => 38 + index * 70;
  const height = Math.max(200, visibleSources.length * 86 + 30, entries.length * 70 + 30);
  const enabled = data.entries.filter(e => e.kind === 'permission' && e.effective).map(e => e.label);
  const togglePermission = (key: string) => {
    setPreview(null); setEditError(null);
    setDraft(current => { const keys = current ?? enabled; return keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]; });
  };
  const previewDraft = async () => {
    if (!draft) return;
    setBusy(true); setEditError(null);
    try { setPreview(await api.previewAgentMcpPermissions(agentId, draft)); } catch (e) { setEditError(String(e)); } finally { setBusy(false); }
  };
  const saveDraft = async () => {
    if (!draft || !preview) return;
    setBusy(true); setEditError(null);
    try {
      await api.updateAgentMcpPermissions(agentId, draft, data.policy_revision);
      setRevision(r => r + 1);
    } catch (e) { setEditError(String(e)); } finally { setBusy(false); }
  };
  return <div className="space-y-4">
    <Card>
      <div className="flex flex-wrap justify-between gap-3">
        <div><h2 className="text-xl font-semibold text-white">{data.agent.name} · capability map</h2><p className="mt-1 text-sm text-slate-400">Follow a capability back to its source. Select a node to inspect why it is available or excluded.</p></div>
        <Button variant="secondary" onClick={() => setRevision(r => r + 1)} disabled={busy || draft !== null}>Refresh</Button>
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <label className="text-xs text-slate-400">Dispatch context<select aria-label="Workflow context" className={`${fieldClass} block mt-1 max-w-xs`} value={workflowId ?? ''} disabled={busy || draft !== null} onChange={e => setWorkflowId(e.target.value ? Number(e.target.value) : null)}><option value="">No workflow selected</option>{data.workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <div className="text-xs text-slate-400 pt-1">Runtime<p className="text-sm text-slate-100 mt-3">{data.agent.runtime_type}</p></div>
        <div className="text-xs text-slate-400 pt-1">Configured model<p className="text-sm text-slate-100 mt-3">{data.agent.model || 'Runtime default'}</p></div>
        <div className="text-xs text-slate-400 pt-1">Permission policy<p className="text-sm text-slate-100 mt-3">{data.policy_mode}</p></div>
      </div>
      <p className="text-xs text-slate-500 mt-3">This view shows configured grants. Runtime availability, tool allowlists, credentials, task scope and model routing can further constrain a run. Permission defaults reflect the agent’s strongest live key role; preview below identifies its selected key role.</p>
    </Card>
    {data.findings.length > 0 && <Card><h3 className="font-medium text-slate-100 mb-2">Findings</h3><ul className="space-y-2 text-sm">{data.findings.map((f, i) => <li key={`${f.code}:${i}`} className={f.severity === 'warning' ? 'text-amber-300' : 'text-slate-400'}>{f.entry_id ? <button className="text-left underline decoration-dotted" onClick={() => { const entry = data.entries.find(e => e.id === f.entry_id); if (entry) { setKind(entry.kind); setSearch(''); setSelection(entry.id); } }}>{f.message}</button> : f.message}</li>)}</ul></Card>}
    <Card>
      <div className="flex flex-wrap items-center gap-2 mb-4" role="group" aria-label="Capability categories">{(['tool', 'mcp', 'skill', 'permission'] as const).map(k => <button key={k} aria-pressed={kind === k} onClick={() => { setKind(k); setSearch(''); setSelection(null); }} className={`rounded-lg px-3 py-2 text-sm ${kind === k ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}>{({ tool: 'Tools', mcp: 'MCP servers', skill: 'Skills', permission: 'Permissions' })[k]} · {data.entries.filter(e => e.kind === k && e.effective).length}</button>)}<input className={`${fieldClass} ml-auto`} aria-label="Search capabilities" placeholder="Find a capability…" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <div className="flex flex-wrap gap-4 text-xs mb-4">{Object.entries(colors).map(([state, color]) => <span key={state} className="flex items-center gap-1 text-slate-300"><span className="w-3 h-1 inline-block" style={{ background: color }} />{state.replace('_', ' ')}</span>)}</div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="overflow-auto rounded-xl border border-slate-800 bg-slate-950 max-h-[620px]">
          {!entries.length ? <p className="p-8 text-slate-400 text-sm">{search ? 'No matching capabilities.' : 'No assignments in this category.'}</p> : <svg role="group" aria-label="Capability provenance graph" width="100%" height={height} viewBox={`0 0 760 ${height}`} style={{ minWidth: 660 }}>
            <text x="24" y="22" fill="#94a3b8" fontSize="12">CONFIGURATION SOURCES</text><text x="420" y="22" fill="#94a3b8" fontSize="12">RESOLVED CAPABILITIES</text>
            {entries.flatMap((entry, index) => entry.sources.map(source => { const si = visibleSources.findIndex(s => s.id === source.source_id); return <path key={`${entry.id}:${source.source_id}`} d={`M 244 ${sourceY(si) + 25} C 320 ${sourceY(si) + 25}, 340 ${entryY(index) + 25}, 420 ${entryY(index) + 25}`} fill="none" stroke={colors[source.state]} strokeDasharray={source.state === 'active' ? undefined : '5 5'} strokeWidth={selection === entry.id ? 2.5 : 1.2} opacity={selection && selection !== entry.id ? .12 : .65} />; }))}
            {visibleSources.map((source, index) => <g key={source.id}><rect x="24" y={sourceY(index)} width="220" height="52" rx="8" fill="#1e293b" stroke="#475569" /><text x="36" y={sourceY(index) + 22} fill="#e2e8f0" fontSize="12">{source.label.length > 29 ? source.label.slice(0, 27) + '…' : source.label}</text><text x="36" y={sourceY(index) + 40} fill="#94a3b8" fontSize="10">{source.id === 'agent' ? 'Direct assignments and overrides' : source.id === 'defaults' ? 'Permission baseline' : source.primary ? 'Primary team' : 'Team membership'}</text><title>{source.label}</title></g>)}
            {entries.map((entry, index) => <g key={entry.id} role="button" tabIndex={0} aria-label={`${entry.label}, ${entry.effective ? 'available' : 'excluded'}`} aria-pressed={selection === entry.id} onClick={() => setSelection(entry.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelection(entry.id); } }} className="cursor-pointer outline-none focus:[&>rect]:stroke-amber-400"><rect x="420" y={entryY(index)} width="310" height="52" rx="8" fill={selection === entry.id ? '#334155' : '#0f172a'} stroke={selection === entry.id ? '#fbbf24' : entry.effective ? '#065f46' : '#475569'} /><text x="433" y={entryY(index) + 22} fill="#e2e8f0" fontSize="12">{entry.label.length > 40 ? entry.label.slice(0, 38) + '…' : entry.label}</text><text x="433" y={entryY(index) + 40} fill={entry.effective ? '#6ee7b7' : '#fda4af'} fontSize="10">{entry.effective ? 'Available in configuration' : 'Excluded'}</text><title>{entry.label}</title></g>)}
          </svg>}
        </div>
        <aside className="rounded-xl bg-slate-900 p-4 text-sm space-y-3" aria-label="Capability inspector" aria-live="polite">
          {selected ? <><h3 className="font-semibold text-white break-all">{selected.label}</h3><p className={selected.effective ? 'text-emerald-300' : 'text-rose-300'}>{selected.effective ? 'Available in configuration' : 'Excluded'}</p>{selected.description && <p className="text-slate-400">{selected.description}</p>}{selected.sources.map(source => { const origin = data.sources.find(s => s.id === source.source_id); return <div key={source.source_id} className="border-t border-slate-700 pt-3"><Link href={origin?.href ?? '#'} className="text-amber-300 hover:underline">{origin?.label}</Link><p className="text-slate-400 mt-1">{source.explanation}</p></div>; })}{selected.kind === 'permission' && <label className="flex items-start gap-2 border-t border-slate-700 pt-3 text-slate-200"><input type="checkbox" disabled={busy} checked={(draft ?? enabled).includes(selected.label)} onChange={() => togglePermission(selected.label)} />Enable in draft policy</label>}{selected.kind !== 'permission' && <Link className="block text-amber-300 underline" href={`/agents/${agentId}`}>Edit agent assignments</Link>}</> : <><h3 className="font-semibold text-white">Inspect a capability</h3><p className="text-slate-400">Select a node to see every contributing source and the precedence decision.</p><p className="text-slate-500">Solid lines are active grants. Dashed lines show excluded or superseded configuration.</p></>}
        </aside>
      </div>
      {draft && <div className="mt-4 border border-amber-600/40 rounded-xl p-4 space-y-3"><h3 className="text-amber-300 font-medium">Unsaved permission policy</h3><p className="text-sm text-slate-400">Saving creates an explicit policy for this agent and replaces its defaults. Changes apply to future authorization checks.</p><p className="text-sm text-slate-300">Enable: {draft.filter(k => !enabled.includes(k)).join(', ') || 'none'}<br />Disable: {enabled.filter(k => !draft.includes(k)).join(', ') || 'none'}</p>{preview && <div className="text-sm text-slate-300"><p>{preview.available_count} MCP tools available with this draft · key role: {preview.key_role}</p><details className="mt-2"><summary className="cursor-pointer">Inspect tool access</summary><ul className="max-h-60 overflow-auto text-xs mt-2 space-y-2">{preview.tools.map(tool => <li key={tool.name}><span className={tool.available ? 'text-emerald-300' : 'text-slate-400'}>{tool.name} · {tool.available ? 'available' : 'unavailable'}</span><p className="text-slate-500">{tool.reason}</p></li>)}</ul></details></div>}{editError && <p role="alert" className="text-red-300 text-sm">{editError}</p>}<div className="flex gap-2"><Button disabled={busy} onClick={previewDraft}>Preview tool access</Button><Button variant="primary" disabled={busy || !preview} onClick={saveDraft}>Save policy</Button><Button variant="ghost" disabled={busy} onClick={() => { setDraft(null); setPreview(null); setEditError(null); }}>Discard</Button></div></div>}
    </Card>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><h3 className="font-semibold text-white">Team context · {data.context.team_name ?? 'None selected'}</h3><p className="text-sm text-slate-400 mt-2">Workflow owner membership → sole team → unique primary team → no team context.</p>{data.context.section ? <pre className="text-xs text-slate-300 whitespace-pre-wrap max-h-80 overflow-auto mt-3">{data.context.section}</pre> : <p className="text-sm text-slate-500 mt-3">No team block will be injected for this selection.</p>}</Card>
      <Card><h3 className="font-semibold text-white">Routing assignments</h3><p className="text-sm text-slate-400 mt-2">{workflowId ? 'Rules referencing this agent in the selected workflow. Task type and priority still determine the winning assignment.' : 'Select a workflow to inspect the rules referencing this agent.'}</p>{workflowId && <><ul className="mt-3 space-y-2 text-sm text-slate-300">{data.routing.map(r => <li key={r.rule_id}>{r.status} · {r.task_type ?? 'all task types'} <span className="text-slate-500">#{r.rule_id} · {r.effective ? 'eligible rule' : 'disabled or superseded'}</span></li>)}</ul>{!data.routing.length && <p className="text-sm text-slate-500 mt-3">No assignment rules reference this agent in this workflow.</p>}<Link href={`/routing?workflow_id=${workflowId}`} className="inline-block text-sm text-amber-300 mt-3">Open workflow graph →</Link></>}</Card>
    </div>
    <AgentResolutionRuns agentId={agentId} />
  </div>;
}
