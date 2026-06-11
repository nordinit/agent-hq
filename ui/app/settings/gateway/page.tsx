'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Save, ServerCog, TerminalSquare } from 'lucide-react';
import { api, type GatewayConfig, type GatewayRuntimeHint, type GatewayStatus } from '@/lib/api';

function commandBlock(): { title: string; lines: string[]; note: string } {
  return {
    title: 'First time installing OpenClaw?',
    lines: [
      'npm install -g openclaw',
      'openclaw onboard --install-daemon',
    ],
    note: 'If OpenClaw is already installed and running, you can skip this. Otherwise run these commands in another terminal, then come back here and re-check the gateway connection.',
  };
}

function remotePairingBlock(): { title: string; lines: string[]; note: string } {
  return {
    title: 'Remote gateway approval',
    lines: [
      'openclaw devices list',
      'openclaw devices approve <requestId>',
    ],
    note: 'Remote gateways require a one-time device approval. Click Re-check Gateway here to create the pending request, approve it on the remote machine, then click Re-check Gateway again.',
  };
}

function getDefaultLocalRuntimeHint(): GatewayRuntimeHint {
  if (typeof navigator !== 'undefined') {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('mac')) return 'macos';
    if (userAgent.includes('linux')) return 'linux';
  }
  return 'powershell';
}

function isRemoteGatewayRuntime(runtimeHint: GatewayRuntimeHint): boolean {
  return runtimeHint === 'external';
}

function statusTone(status: GatewayStatus | null, isRemoteGateway: boolean): { label: string; className: string } {
  if (!status) {
    return {
      label: 'Unknown',
      className: 'border-zinc-700 bg-zinc-800 text-zinc-300',
    };
  }
  switch (status.state) {
    case 'ready':
      return {
        label: 'Ready',
        className: 'border-emerald-700/50 bg-emerald-500/10 text-emerald-300',
      };
    case 'pairing_required':
      return {
        label: isRemoteGateway ? 'Pairing Required' : 'Connection Required',
        className: 'border-amber-700/50 bg-amber-500/10 text-amber-300',
      };
    case 'auth_error':
      return {
        label: 'Auth Error',
        className: 'border-rose-700/50 bg-rose-500/10 text-rose-300',
      };
    case 'timeout':
      return {
        label: 'Timeout',
        className: 'border-amber-700/50 bg-amber-500/10 text-amber-300',
      };
    default:
      return {
        label: 'Offline',
        className: 'border-zinc-700 bg-zinc-800 text-zinc-300',
      };
  }
}

function isGatewayTokenMismatch(error: string | null | undefined): boolean {
  const normalized = (error ?? '').toLowerCase();
  return normalized.includes('gateway token mismatch') || normalized.includes('provide gateway auth token');
}

function gatewayStatusDetails(status: GatewayStatus | null, isRemoteGateway: boolean): string | null {
  if (!status) return null;
  if (isGatewayTokenMismatch(status.error)) {
    return 'Agent HQ could not connect because the saved gateway auth token did not match.';
  }
  if (status.state === 'pairing_required') {
    return isRemoteGateway
      ? 'The remote gateway is waiting for device approval. Run the approval commands on the remote machine, then re-check here.'
      : 'OpenClaw rejected the connection request. Restart OpenClaw and verify the gateway auth token, then try again.';
  }
  return status.error;
}

export default function SettingsGatewayPage() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [wsUrl, setWsUrl] = useState('wss://127.0.0.1:18789');
  const [runtimeHint, setRuntimeHint] = useState<GatewayRuntimeHint>(getDefaultLocalRuntimeHint);
  const [lastLocalRuntimeHint, setLastLocalRuntimeHint] = useState<GatewayRuntimeHint>(getDefaultLocalRuntimeHint);
  const [authToken, setAuthToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);

  const guide = useMemo(() => commandBlock(), []);
  const remoteGuide = useMemo(() => remotePairingBlock(), []);
  const isRemoteGateway = isRemoteGatewayRuntime(runtimeHint);
  const tone = statusTone(status, isRemoteGateway);
  const gatewayNeedsToken = isGatewayTokenMismatch(status?.error);

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const [cfg, nextStatus] = await Promise.all([
        api.getGatewayConfig(),
        api.getGatewayStatus(),
      ]);
      setConfig(cfg);
      setStatus(nextStatus);
      setWsUrl(cfg.ws_url);
      setRuntimeHint(cfg.runtime_hint);
      if (!isRemoteGatewayRuntime(cfg.runtime_hint)) {
        setLastLocalRuntimeHint(cfg.runtime_hint);
      }
      setAuthToken(cfg.auth_token ?? '');
      setDetails(gatewayStatusDetails(nextStatus, isRemoteGatewayRuntime(cfg.runtime_hint)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const persistConfig = async () => {
    const next = await api.updateGatewayConfig({ ws_url: wsUrl, runtime_hint: runtimeHint, auth_token: authToken });
    setConfig(next);
    setWsUrl(next.ws_url);
    setRuntimeHint(next.runtime_hint);
    if (!isRemoteGatewayRuntime(next.runtime_hint)) {
      setLastLocalRuntimeHint(next.runtime_hint);
    }
    setAuthToken(next.auth_token ?? '');
    return next;
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const next = await persistConfig();
      setSuccess('Gateway settings saved.');
      const nextStatus = await api.getGatewayStatus();
      setStatus(nextStatus);
      setDetails(gatewayStatusDetails(nextStatus, isRemoteGateway));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCheck = async () => {
    setChecking(true);
    setError(null);
    setSuccess(null);
    try {
      await persistConfig();
      const nextStatus = await api.getGatewayStatus();
      setStatus(nextStatus);
      setDetails(gatewayStatusDetails(nextStatus, isRemoteGateway));
      setSuccess(nextStatus.state === 'ready' ? 'Gateway is reachable.' : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await api.restartGateway();
      setSuccess(response.message ?? 'Gateway restart attempted.');
      setDetails(response.output ?? response.message ?? null);
      const nextStatus = await api.getGatewayStatus();
      setStatus(nextStatus);
      setDetails(gatewayStatusDetails(nextStatus, isRemoteGateway) ?? response.output ?? response.message ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
    }
  };

  const setGatewayLocation = (mode: 'local' | 'remote') => {
    if (mode === 'remote') {
      setRuntimeHint('external');
      return;
    }
    setRuntimeHint(lastLocalRuntimeHint);
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-2">
          <ServerCog className="h-5 w-5 text-zinc-300" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">OpenClaw Gateway Setup</h2>
          <p className="text-sm text-zinc-400">
            {isRemoteGateway
              ? 'Agent HQ is pointed at a remote OpenClaw gateway. Re-check here to create the pending device request, approve it on the remote machine, then re-check again.'
              : 'Agent HQ automatically checks the saved local gateway URL and token. Start OpenClaw, then verify the gateway here.'}
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-700/40 bg-rose-900/20 p-3 text-sm text-rose-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-700/40 bg-emerald-900/20 p-3 text-sm text-emerald-300">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
        <div className="space-y-6 rounded-xl border border-zinc-700/60 bg-zinc-800/50 p-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Connection</h3>
                <p className="text-xs leading-5 text-zinc-400">
                  Agent HQ uses this WebSocket URL for Atlas and agent chat once the gateway is reachable.
                </p>
              </div>
              <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${tone.className}`}>
                {tone.label}
              </span>
            </div>

            <label className="block space-y-2">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">Gateway location</span>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setGatewayLocation('local')}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    !isRemoteGateway
                      ? 'border-amber-400 bg-amber-500/10 text-amber-300'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'
                  }`}
                >
                  Local machine
                </button>
                <button
                  type="button"
                  onClick={() => setGatewayLocation('remote')}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    isRemoteGateway
                      ? 'border-amber-400 bg-amber-500/10 text-amber-300'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'
                  }`}
                >
                  Remote machine
                </button>
              </div>
            </label>

            <label className="block space-y-2">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">Gateway URL</span>
              <input
                value={wsUrl}
                onChange={(event) => setWsUrl(event.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-amber-400"
                placeholder="wss://127.0.0.1:18789"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">Gateway Auth Token</span>
              <input
                type="password"
                value={authToken}
                onChange={(event) => setAuthToken(event.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-amber-400"
                placeholder="Paste the token from the dashboard URL if needed"
              />
              <p className="text-xs leading-5 text-zinc-400">
                {isRemoteGateway
                  ? 'Paste the remote gateway token here. If the check says the token does not match, run `openclaw dashboard --no-open` on the remote machine and copy the token from the URL.'
                  : 'Leave this alone unless the automatic check says the gateway token does not match.'}
              </p>
            </label>

            {gatewayNeedsToken && (
              <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                  <div>
                    <p className="text-sm font-semibold text-amber-200">Gateway token needed</p>
                    <p className="text-xs leading-5 text-amber-100/90">
                      The saved token did not match this OpenClaw gateway.
                    </p>
                  </div>
                </div>
                <pre className="overflow-x-auto rounded-lg border border-amber-400/30 bg-zinc-950 p-3 text-xs leading-6 text-amber-100">
                  openclaw dashboard --no-open
                </pre>
                <p className="text-xs leading-5 text-amber-100/90">
                  Copy the token from the dashboard URL, paste it into the field above, then click Re-check Gateway.
                </p>
              </div>
            )}

            {isRemoteGateway && (
              <div className="rounded-xl border border-amber-400/30 bg-zinc-900/80 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-amber-400" />
                  <h3 className="text-sm font-semibold text-white">{remoteGuide.title}</h3>
                </div>
                <pre className="overflow-x-auto rounded-lg border border-zinc-700 bg-zinc-950 p-4 text-xs leading-6 text-zinc-200">
                  {remoteGuide.lines.join('\n')}
                </pre>
                <p className="text-xs leading-5 text-zinc-400">{remoteGuide.note}</p>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || loading}
                className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save Settings
              </button>
              <button
                type="button"
                onClick={handleCheck}
                disabled={checking || loading}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Re-check Gateway
              </button>
              {!isRemoteGateway && (
                <button
                  type="button"
                  onClick={handleRestart}
                  disabled={restarting || loading}
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {restarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ServerCog className="h-4 w-4" />}
                  Try Local Restart
                </button>
              )}
            </div>

            {details && (
              <div className="rounded-lg border border-zinc-700 bg-zinc-900/80 p-3 text-xs leading-5 text-zinc-400">
                <div className="font-medium text-zinc-300">Last check</div>
                <div>{details}</div>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4 rounded-xl border border-zinc-700/60 bg-zinc-800/50 p-6">
          <div className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-white">{guide.title}</h3>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-zinc-700 bg-zinc-950 p-4 text-xs leading-6 text-zinc-200">
            {guide.lines.join('\n')}
          </pre>
          <p className="text-xs leading-5 text-zinc-400">{guide.note}</p>
          {config?.source === 'default' && (
            <p className="text-xs leading-5 text-zinc-500">
              Using the default gateway URL because no saved gateway configuration exists yet.
            </p>
          )}
          {loading && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading gateway settings…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
