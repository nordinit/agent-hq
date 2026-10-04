'use client';
import { useEffect, useState } from 'react';
import { api, type Team } from '@/lib/api';
import { getTeamResolution, previewTeamSkills, type TeamResolution } from '@/lib/api/teamResolution';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AgentResolutionGraph } from './AgentResolutionGraph';

export function TeamCapabilityMap({ teamId, onSaved }: { teamId: number; onSaved: (team: Team) => void }) {
  const [data, setData] = useState<TeamResolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ before: TeamResolution; after: TeamResolution } | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let current = true;
    setData(null); setError(null);
    getTeamResolution(teamId).then(result => { if (current) setData(result); }).catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [teamId, revision]);
  const skills = () => [...new Set((draft ?? '').split('\n').map(s => s.trim()).filter(Boolean))];
  const previewChanges = async () => {
    setBusy(true); setError(null);
    try { setPreview(await previewTeamSkills(teamId, skills())); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const team = await api.updateTeam(teamId, { skill_names: JSON.stringify(preview.after.skill_names), expected_context_version: preview.before.context_version });
      onSaved(team); setDraft(null); setPreview(null); setRevision(r => r + 1);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const visible = preview?.after ?? data;
  const capabilities = [...new Map(visible?.members.flatMap(m => m.capabilities.map(c => [c.id, c] as const)) ?? []).values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label)).filter(c => `${c.kind} ${c.label}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="space-y-4">
    <Card>
      <div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-xl font-semibold text-white">Team capability coverage</h2><p className="mt-1 text-sm text-slate-400">Compare effective grants across enabled memberships, then select an agent to trace its sources.</p></div><div className="flex gap-2"><Button disabled={!data || busy || draft !== null} onClick={() => { setDraft(data?.skill_names.join('\n') ?? ''); setPreview(null); }}>Edit shared skills</Button><Button disabled={busy || draft !== null} onClick={() => setRevision(r => r + 1)}>Refresh</Button></div></div>
      {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
      {!visible ? <p className="mt-4 text-slate-400">{error ? 'Unable to load the team map.' : 'Loading team capabilities…'}</p> : <>
        <input aria-label="Find a team capability" placeholder="Filter capabilities…" value={query} onChange={e => setQuery(e.target.value)} className="mt-4 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100" />
        {preview && <p className="mt-3 text-sm text-amber-300">Previewing unsaved shared skills. The comparison below shows the proposed effective grants.</p>}
        <div className="overflow-auto mt-4 max-h-96 border border-slate-800 rounded-lg"><table className="min-w-full text-sm"><thead className="sticky top-0 bg-slate-900"><tr><th className="text-left p-3 text-slate-400">Capability</th>{visible.members.map(m => <th key={m.id} className="p-3 text-left"><button className="text-amber-300 hover:underline" onClick={() => setSelectedId(m.id)}>{m.name}{!m.enabled ? ' (disabled)' : ''}</button></th>)}</tr></thead><tbody>{capabilities.map(c => <tr key={c.id} className="border-t border-slate-800"><th className="p-3 text-left font-normal text-slate-200">{c.label}<span className="block text-xs text-slate-500">{c.kind}</span></th>{visible.members.map(m => { const grant = m.capabilities.find(g => g.id === c.id); return <td key={m.id} className="p-3"><button onClick={() => setSelectedId(m.id)} title={grant ? `Source: ${grant.source}` : 'Not in the effective configuration'} aria-label={`${m.name}: ${c.label} ${grant ? 'available' : 'unavailable'}`} className={grant ? 'text-emerald-300' : 'text-slate-600'}>{grant ? 'Available' : '—'}</button></td>; })}</tr>)}</tbody></table>{!visible.members.length && <p className="p-4 text-sm text-slate-400">Add an enabled team membership to compare capabilities.</p>}{visible.members.length > 0 && !capabilities.length && <p className="p-4 text-sm text-slate-400">No capabilities match this view.</p>}</div>
      </>}
      {draft !== null && <div className="mt-4 border-t border-slate-700 pt-4 space-y-3"><h3 className="font-medium text-white">Shared skills</h3><p className="text-sm text-slate-400">One registered skill name per line. Skills are combined across teams and direct assignments; removing a team skill may leave another grant active.</p><textarea aria-label="Shared skill names" disabled={busy} value={draft} onChange={e => { setDraft(e.target.value); setPreview(null); }} className="w-full min-h-28 rounded border border-slate-700 bg-slate-900 p-3 text-sm text-slate-100" />
        {preview && <ul className="text-sm text-slate-300 space-y-2">{preview.after.members.map(member => { const previous = preview.before.members.find(m => m.id === member.id)?.capabilities.filter(c => c.kind === 'skill').map(c => c.label) ?? []; const next = member.capabilities.filter(c => c.kind === 'skill').map(c => c.label); const added = next.filter(s => !previous.includes(s)); const removed = previous.filter(s => !next.includes(s)); return <li key={member.id}>{member.name}: {added.length ? `gains ${added.join(', ')}` : 'no added skills'}; {removed.length ? `loses ${removed.join(', ')}` : 'no lost skills'}.</li>; })}</ul>}
        <div className="flex gap-2"><Button disabled={busy} onClick={previewChanges}>Preview member impact</Button><Button variant="primary" disabled={busy || !preview} onClick={save}>Save shared skills</Button><Button variant="ghost" disabled={busy} onClick={() => { setDraft(null); setPreview(null); setError(null); }}>Discard</Button></div>
      </div>}
    </Card>
    {selectedId !== null && data?.members.some(m => m.id === selectedId) && <AgentResolutionGraph key={`${selectedId}:${revision}`} agentId={selectedId} />}
  </div>;
}
