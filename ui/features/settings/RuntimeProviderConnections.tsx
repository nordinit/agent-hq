'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Copy, Loader2, RefreshCw, Shield, Trash2 } from 'lucide-react';
import { api, type DiscoveredProviderConnection, type ProviderConnectionRecord } from '@/lib/api';

const RUNTIMES = [
  { key: 'openclaw', label: 'OpenClaw', note: 'Uses OpenClaw per-agent auth profiles.' },
  { key: 'hermes', label: 'Hermes', note: 'Requires Claude Max with extra usage credits.' },
] as const;

export default function RuntimeProviderConnections({ onChanged }: { onChanged?: () => void | Promise<void> }) {
  const [connections, setConnections] = useState<ProviderConnectionRecord[]>([]);
  const [discovered, setDiscovered] = useState<Record<string, DiscoveredProviderConnection[]>>({});
  const [commands, setCommands] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.getProviderConnections();
      setConnections(result.connections.filter(item => item.provider_slug === 'anthropic' && item.auth_mode === 'subscription'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function inspect(runtime: string) {
    setBusy(runtime);
    setError(null);
    try {
      const request = { provider: 'anthropic', runtime, auth_mode: 'subscription' };
      const [instructions, found] = await Promise.all([
        api.getProviderAuthInstructions(request),
        api.discoverProviderConnections({ ...request, runtime_config: runtime === 'hermes' ? { profile: 'default' } : {} }),
      ]);
      setCommands(current => ({ ...current, [runtime]: [instructions.instructions.command, ...instructions.instructions.args].join(' ') }));
      setDiscovered(current => ({ ...current, [runtime]: found.connections }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function connect(runtime: string, connection: DiscoveredProviderConnection) {
    setBusy(`${runtime}:${connection.externalRef}`);
    setError(null);
    try {
      await api.createProviderConnection({
        provider_slug: 'anthropic',
        auth_mode: 'subscription',
        runtime_type: runtime,
        external_ref: connection.externalRef,
        display_name: connection.displayName,
        metadata: connection.metadata,
        runtime_config: runtime === 'hermes' ? { profile: 'default' } : {},
      });
      await load();
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: number) {
    setBusy(`delete:${id}`);
    try {
      await api.deleteProviderConnection(id);
      await load();
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-white">Claude Subscription</h2>
        <p className="text-sm text-slate-400 mt-1">Credentials remain in the selected runtime. Agent HQ stores only the profile reference used for routing.</p>
      </div>
      {error && <div className="text-sm text-red-300 border border-red-500/30 bg-red-500/10 rounded-lg p-3">{error}</div>}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {RUNTIMES.map(runtime => {
          const runtimeConnections = connections.filter(item => item.runtime_type === runtime.key);
          const options = discovered[runtime.key] ?? [];
          const command = commands[runtime.key];
          return (
            <div key={runtime.key} className="border border-slate-700 bg-slate-800/40 rounded-lg p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-amber-400" />
                  <div>
                    <h3 className="text-sm font-semibold text-white">{runtime.label}</h3>
                    <p className="text-xs text-slate-500">{runtime.note}</p>
                  </div>
                </div>
                <button type="button" title="Refresh runtime profiles" onClick={() => void inspect(runtime.key)} disabled={busy !== null} className="p-2 text-slate-300 hover:text-white disabled:opacity-50">
                  {busy === runtime.key ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                </button>
              </div>

              {command && (
                <div className="flex items-center gap-2 bg-slate-950 border border-slate-700 rounded-md p-2">
                  <code className="text-xs text-slate-300 flex-1 overflow-x-auto">{command}</code>
                  <button type="button" title="Copy authentication command" onClick={() => void navigator.clipboard.writeText(command)} className="p-1.5 text-slate-400 hover:text-white"><Copy className="w-3.5 h-3.5" /></button>
                </div>
              )}

              {runtimeConnections.map(connection => (
                <div key={connection.id} className="flex items-center gap-2 text-xs border border-emerald-500/20 bg-emerald-500/5 rounded-md p-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span className="text-slate-200 flex-1 truncate">{connection.display_name}</span>
                  <button type="button" title="Disconnect profile" onClick={() => void remove(connection.id)} disabled={busy !== null} className="p-1 text-red-300 hover:text-red-200"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}

              {options.filter(option => !runtimeConnections.some(connection => connection.external_ref === option.externalRef)).map(option => (
                <button key={option.externalRef} type="button" onClick={() => void connect(runtime.key, option)} disabled={busy !== null} className="w-full text-left border border-slate-600 hover:border-amber-400 rounded-md p-2.5 text-xs text-slate-200 disabled:opacity-50">
                  Connect {option.displayName}
                </button>
              ))}
              {command && options.length === 0 && <p className="text-xs text-slate-500">Run the command in a terminal, then refresh profiles.</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
