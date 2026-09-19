'use client';

import { useEffect, useState } from 'react';
import { api, type AgentMcpToolAccessPreview } from '@/lib/api';

export function McpToolAccessPreview({ agentId, enabledCapabilities, unsaved, revision }: {
  agentId: number; enabledCapabilities: string[]; unsaved: boolean; revision: string;
}) {
  const [preview, setPreview] = useState<AgentMcpToolAccessPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [keyRole, setKeyRole] = useState<string | undefined>();
  const draft = JSON.stringify(enabledCapabilities);
  useEffect(() => {
    let current = true;
    setPreview(null);
    setError(null);
    const timer = setTimeout(() => {
      api.previewAgentMcpPermissions(agentId, unsaved ? JSON.parse(draft) : undefined, keyRole)
        .then(result => { if (current) setPreview(result); })
        .catch(reason => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); });
    }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [agentId, draft, unsaved, keyRole, revision]);

  return <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-medium text-slate-100">Tools available with {unsaved ? 'unsaved permissions' : 'saved permissions'}</h4>
      {preview && <span className="text-xs text-slate-400">{preview.available_count} of {preview.tools.length} tools</span>}
    </div>
    <p className="text-xs text-slate-400">Permissions belong to this identity and apply to every connection. Project, tenant and active task restrictions are checked on each call. Clients may need to refresh their tool list after saving.</p>
    {preview && preview.key_roles.length > 1 && <label className="text-xs text-slate-400">Preview key authority <select
      className="ml-2 rounded bg-slate-900 border border-slate-700 p-1" value={preview.key_role}
      onChange={event => setKeyRole(event.target.value)}>
      {preview.key_roles.map(role => <option key={role} value={role}>{role}</option>)}
    </select></label>}
    {error ? <p role="alert" className="text-xs text-red-300">{error}</p> : !preview ? <p className="text-xs text-slate-500">Loading tool access…</p> : <>
      <input aria-label="Filter MCP tools" placeholder="Find a tool or permission…" value={query} onChange={event => setQuery(event.target.value)}
        className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200" />
      <div className="max-h-72 overflow-y-auto divide-y divide-slate-800">
        {preview.tools.filter(tool => `${tool.name} ${tool.reason}`.toLowerCase().includes(query.toLowerCase()))
          .sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name))
          .map(tool => <div key={tool.name} className="py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2"><span className={tool.available ? 'text-emerald-300' : 'text-slate-500'}>{tool.available ? 'Available' : 'Unavailable'}</span>
              <span className="font-mono text-slate-300 break-all">{tool.name}</span></div>
            <p className="mt-1 text-slate-500">{tool.reason}</p>
          </div>)}
      </div>
    </>}
  </div>;
}
