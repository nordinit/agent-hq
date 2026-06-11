'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Check, RefreshCw, Save } from 'lucide-react';
import type { ContractPlaceholderDefinition } from '../workflowConfigShared';

export default function AgentContractSection() {
  const [sprintTypes, setSprintTypes] = useState<Array<{ key: string; name: string }>>([]);
  const [selectedSprintType, setSelectedSprintType] = useState('generic');
  const [content, setContent] = useState('');
  const [placeholderDefinitions, setPlaceholderDefinitions] = useState<ContractPlaceholderDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [inheritedFrom, setInheritedFrom] = useState<string | null>(null);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    apiFetch<{ sprint_types?: Array<{ key: string; name: string }> }>('/api/v1/sprints/config')
      .then(data => {
        const types = data.sprint_types ?? [];
        setSprintTypes(types.map(type => ({ key: type.key, name: type.name })));
        if (types.length > 0 && !types.some(type => type.key === selectedSprintType)) {
          setSelectedSprintType(types[0]?.key ?? 'generic');
        }
      })
      .catch(e => showToast('error', `Failed to load workflow types: ${e}`));
  }, []);

  useEffect(() => {
    setLoading(true);
    apiFetch<{ content: string; inherited_from?: string | null; placeholder_definitions?: ContractPlaceholderDefinition[] }>(`/api/v1/routing/agent-contract?sprint_type=${encodeURIComponent(selectedSprintType)}`)
      .then(data => {
        setContent(data.content ?? '');
        setInheritedFrom(data.inherited_from ?? null);
        setPlaceholderDefinitions(data.placeholder_definitions ?? []);
      })
      .catch(e => showToast('error', `Failed to load: ${e}`))
      .finally(() => setLoading(false));
  }, [selectedSprintType]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/v1/routing/agent-contract', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprint_type: selectedSprintType, content }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? res.statusText);
      }
      setInheritedFrom(null);
      showToast('success', `Agent contract saved for ${selectedSprintType}.`);
    } catch (e) {
      showToast('error', `Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Agent Dispatch Contract</h2>
          <p className="text-slate-400 text-sm mt-0.5">
            One plain text contract template per workflow type, injected into dispatched agent runs. Supports{' '}
            <code className="text-amber-300 text-xs bg-slate-800 px-1 py-0.5 rounded">{'{{placeholder}}'}</code> syntax.
          </p>
        </div>
        <Button onClick={handleSave} disabled={saving || loading} size="sm">
          {saving ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Save className="w-3.5 h-3.5" />
          )}
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {toast && (
        <div
          className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium ${
            toast.type === 'success'
              ? 'bg-green-900/40 border border-green-700/50 text-green-300'
              : 'bg-red-900/40 border border-red-700/50 text-red-300'
          }`}
        >
          {toast.type === 'success' ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {toast.message}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-300">
          Workflow type
          <select
            value={selectedSprintType}
            onChange={e => setSelectedSprintType(e.target.value)}
            className="ml-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
          >
            {sprintTypes.map(type => (
              <option key={type.key} value={type.key}>{type.name}</option>
            ))}
          </select>
        </label>
        {inheritedFrom && (
          <p className="text-xs text-slate-400">
            Using fallback template from <code className="text-amber-300">{inheritedFrom}</code> until this workflow type is saved explicitly.
          </p>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          className="w-full h-[520px] bg-slate-900 border border-slate-700 rounded-xl p-4 text-sm text-slate-200 font-mono resize-y focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50"
          spellCheck={false}
          placeholder="Paste or edit the agent dispatch contract here…"
        />
      )}

      <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-3 space-y-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-2">Available placeholders</p>
          <div className="flex flex-wrap gap-1.5">
            {placeholderDefinitions.map(({ key }) => {
              const placeholder = `{{${key}}}`;
              return (
                <span key={placeholder} className="inline-block bg-slate-700 text-amber-300 px-1.5 py-0.5 rounded text-xs font-mono">
                  {placeholder}
                </span>
              );
            })}
          </div>
        </div>

        <div className="border-t border-slate-700/60 pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-2">Placeholder definitions</p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {placeholderDefinitions.map(({ key, description }) => (
              <div key={key} className="rounded-lg border border-slate-700/60 bg-slate-900/50 p-3">
                <code className="text-xs text-amber-300 font-mono">{`{{${key}}}`}</code>
                <p className="mt-1 text-xs leading-5 text-slate-300">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
