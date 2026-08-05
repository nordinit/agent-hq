'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Copy, Loader2, RefreshCw, Shield, Trash2 } from 'lucide-react';
import { api, type DiscoveredProviderConnection, type ProviderConnectionRecord } from '@/lib/api';

const RUNTIMES = [
  { key: 'openclaw', label: 'OpenClaw', provider: 'anthropic', note: 'Uses OpenClaw per-agent auth profiles.' },
  { key: 'claude-code', label: 'Claude Code', provider: 'anthropic', note: 'Uses a Claude Code-owned subscription login; Agent HQ stores only the profile reference.' },
  { key: 'hermes', label: 'Hermes', provider: 'anthropic', note: 'Requires Claude Max with extra usage credits enabled.' },
  { key: 'codex', label: 'Codex', provider: 'openai-codex', note: 'Uses a Codex-owned ChatGPT login; Agent HQ stores only the CODEX_HOME profile reference.' },
] as const;

type RuntimeKey = (typeof RUNTIMES)[number]['key'];

interface RuntimeProviderConnectionsProps {
  onChanged?: () => void | Promise<void>;
  onConnectionStateChange?: (connected: boolean) => void;
}

export default function RuntimeProviderConnections({
  onChanged,
  onConnectionStateChange,
}: RuntimeProviderConnectionsProps) {
  const [connections, setConnections] = useState<ProviderConnectionRecord[]>([]);
  const [discovered, setDiscovered] = useState<Record<string, DiscoveredProviderConnection[]>>({});
  const [commands, setCommands] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [selectedRuntime, setSelectedRuntime] = useState<RuntimeKey>('openclaw');
  const [selectedProfile, setSelectedProfile] = useState('');
  const [refreshed, setRefreshed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [instructionsLoading, setInstructionsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.getProviderConnections();
      const subscriptionConnections = result.connections.filter(
        item => item.auth_mode === 'subscription'
          && RUNTIMES.some(runtime => runtime.key === item.runtime_type && runtime.provider === item.provider_slug)
      );
      setConnections(subscriptionConnections);
      // This callback feeds the Anthropic provider card. A connected Codex
      // profile must not make Anthropic appear connected.
      onConnectionStateChange?.(subscriptionConnections.some(
        item => item.provider_slug === 'anthropic' && item.status === 'connected'
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onConnectionStateChange]);

  const loadInstructions = useCallback(async (runtime: RuntimeKey) => {
    setInstructionsLoading(true);
    setError(null);
    try {
      const runtimeDefinition = RUNTIMES.find(item => item.key === runtime) ?? RUNTIMES[0];
      const result = await api.getProviderAuthInstructions({
        provider: runtimeDefinition.provider,
        runtime,
        auth_mode: 'subscription',
      });
      setCommands(current => ({
        ...current,
        [runtime]: [result.instructions.command, ...result.instructions.args].join(' '),
      }));
      setMessages(current => ({ ...current, [runtime]: result.instructions.message }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstructionsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadInstructions(selectedRuntime); }, [loadInstructions, selectedRuntime]);

  const runtimeConnections = useMemo(
    () => connections.filter(item => item.runtime_type === selectedRuntime),
    [connections, selectedRuntime]
  );
  const availableProfiles = useMemo(
    () => (discovered[selectedRuntime] ?? []).filter(
      option => !runtimeConnections.some(connection => connection.external_ref === option.externalRef)
    ),
    [discovered, runtimeConnections, selectedRuntime]
  );
  const selectedConnection = availableProfiles.find(option => option.externalRef === selectedProfile);
  const runtime = RUNTIMES.find(item => item.key === selectedRuntime) ?? RUNTIMES[0];
  const command = commands[selectedRuntime];

  async function refreshProfiles() {
    setBusy(`refresh:${selectedRuntime}`);
    setError(null);
    try {
      const request = { provider: runtime.provider, runtime: selectedRuntime, auth_mode: 'subscription' };
      const [instructions, found] = await Promise.all([
        api.getProviderAuthInstructions(request),
        api.discoverProviderConnections({
          ...request,
          runtime_config: selectedRuntime === 'hermes' ? { profile: 'default' } : {},
        }),
      ]);
      const nextCommand = [instructions.instructions.command, ...instructions.instructions.args].join(' ');
      const nextConnections = found.connections;
      setCommands(current => ({ ...current, [selectedRuntime]: nextCommand }));
      setMessages(current => ({ ...current, [selectedRuntime]: instructions.instructions.message }));
      setDiscovered(current => ({ ...current, [selectedRuntime]: nextConnections }));
      setRefreshed(current => ({ ...current, [selectedRuntime]: true }));
      const firstAvailable = nextConnections.find(
        option => !runtimeConnections.some(connection => connection.external_ref === option.externalRef)
      );
      setSelectedProfile(firstAvailable?.externalRef ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function connect(connection: DiscoveredProviderConnection) {
    setBusy(`connect:${connection.externalRef}`);
    setError(null);
    try {
      await api.createProviderConnection({
        provider_slug: runtime.provider,
        auth_mode: 'subscription',
        runtime_type: selectedRuntime,
        external_ref: connection.externalRef,
        display_name: connection.displayName,
        metadata: connection.metadata,
        runtime_config: selectedRuntime === 'hermes' ? { profile: 'default' } : {},
      });
      setSelectedProfile('');
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
    setError(null);
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
    <section className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 space-y-3" aria-label="Runtime subscription authentication">
      <div className="flex items-start gap-2">
        <Shield className="w-4 h-4 text-amber-400 mt-0.5" />
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Runtime Subscription Authentication</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Use a runtime-owned subscription login instead of copying credentials into Agent HQ. Only the selected profile reference is stored.
          </p>
        </div>
      </div>

      <div>
        <label htmlFor="runtime-subscription-runtime" className="block text-xs text-slate-300 mb-1.5">Runtime</label>
        <select
          id="runtime-subscription-runtime"
          value={selectedRuntime}
          onChange={event => {
            setSelectedRuntime(event.target.value as RuntimeKey);
            setSelectedProfile('');
            setError(null);
          }}
          disabled={busy !== null}
          className="w-full bg-slate-900 border border-slate-600 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-400"
        >
          {RUNTIMES.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
        </select>
        <p className="text-xs text-slate-500 mt-1">{runtime.note}</p>
      </div>

      <div className="space-y-2 text-xs text-slate-300">
        <p><span className="font-semibold text-slate-100">1. Run this command in a terminal.</span></p>
        <div className="flex items-center gap-2 bg-slate-950 border border-slate-700 rounded-md p-2">
          {instructionsLoading && !command ? (
            <span className="flex-1 text-slate-500">Loading authentication command...</span>
          ) : (
            <code className="text-xs text-slate-300 flex-1 overflow-x-auto">{command}</code>
          )}
          <button
            type="button"
            title="Copy authentication command"
            aria-label="Copy authentication command"
            onClick={() => command && void navigator.clipboard.writeText(command)}
            disabled={!command}
            className="p-1.5 text-slate-400 hover:text-white disabled:opacity-40"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
        </div>
        {messages[selectedRuntime] && <p className="text-slate-500">{messages[selectedRuntime]}</p>}
        <p><span className="font-semibold text-slate-100">2. Complete the provider sign-in prompts in that terminal.</span> Enter the authorization code there if prompted.</p>
        <p><span className="font-semibold text-slate-100">3. Return here and refresh profiles.</span> Select the authenticated profile, then connect it.</p>
      </div>

      <button
        type="button"
        onClick={() => void refreshProfiles()}
        disabled={busy !== null || instructionsLoading}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-slate-600 text-slate-200 hover:border-slate-500 text-xs font-medium disabled:opacity-50"
      >
        {busy === `refresh:${selectedRuntime}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        Refresh profiles
      </button>

      {runtimeConnections.map(connection => (
        <div key={connection.id} className="flex items-center gap-2 text-xs border-l-2 border-emerald-500 bg-emerald-500/5 px-3 py-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <div className="flex-1 min-w-0">
            <p className="text-slate-200 truncate">{connection.display_name}</p>
            <p className="text-slate-500">Connected through {runtime.label}</p>
          </div>
          <button
            type="button"
            title="Disconnect subscription profile"
            aria-label={`Disconnect ${connection.display_name}`}
            onClick={() => void remove(connection.id)}
            disabled={busy !== null}
            className="p-1.5 text-red-300 hover:text-red-200 disabled:opacity-50"
          >
            {busy === `delete:${connection.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      ))}

      {availableProfiles.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-2 items-end">
          <div>
            <label htmlFor="runtime-subscription-profile" className="block text-xs text-slate-300 mb-1.5">Authenticated profile</label>
            <select
              id="runtime-subscription-profile"
              value={selectedProfile}
              onChange={event => setSelectedProfile(event.target.value)}
              disabled={busy !== null}
              className="w-full bg-slate-900 border border-slate-600 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-400"
            >
              {availableProfiles.map(option => <option key={option.externalRef} value={option.externalRef}>{option.displayName}</option>)}
            </select>
          </div>
          <button
            type="button"
            onClick={() => selectedConnection && void connect(selectedConnection)}
            disabled={!selectedConnection || busy !== null}
            className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-amber-400 hover:bg-amber-300 text-slate-900 text-sm font-medium disabled:opacity-50"
          >
            {busy?.startsWith('connect:') ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
            Connect profile
          </button>
        </div>
      )}

      {refreshed[selectedRuntime] && availableProfiles.length === 0 && runtimeConnections.length === 0 && (
        <p className="text-xs text-slate-500">No authenticated profiles found. Finish the terminal sign-in, then select Refresh profiles again.</p>
      )}

      {error && (
        <div className="text-xs text-red-300 border border-red-500/30 bg-red-500/10 rounded-md p-2.5">{error}</div>
      )}
    </section>
  );
}
