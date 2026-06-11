'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Key,
  Loader2,
  LogIn,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Shield,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { api, ProviderRecord, ProviderSlug } from '@/lib/api';

interface ProviderMeta {
  slug: ProviderSlug;
  name: string;
  tagline: string;
  icon: React.ReactNode;
  connectionMethod: 'api-key' | 'base-url' | 'oauth';
  inputLabel: string;
  inputPlaceholder: string;
  helperText: string;
  helperUrl: string;
  extraFields?: { key: string; label: string; placeholder: string }[];
  defaultValue?: string;
  /** When true, this provider's card is rendered as a sub-section inside another provider's card. */
  hidden?: boolean;
  /** When set, the named provider's OAuth section is embedded inside this card. */
  supportsCodexOAuth?: ProviderSlug;
}

const PROVIDERS: ProviderMeta[] = [
  {
    slug: 'anthropic',
    name: 'Anthropic',
    tagline: 'Claude models',
    icon: <Key className="w-5 h-5" />,
    connectionMethod: 'api-key',
    inputLabel: 'API Key',
    inputPlaceholder: 'sk-ant-...',
    helperText: 'Get your API key at platform.claude.com/settings/keys',
    helperUrl: 'https://platform.claude.com/settings/keys',
  },
  {
    slug: 'openai',
    name: 'OpenAI',
    tagline: 'GPT models',
    icon: <Key className="w-5 h-5" />,
    connectionMethod: 'api-key',
    inputLabel: 'API Key',
    inputPlaceholder: 'sk-...',
    helperText: 'Get your API key at platform.openai.com',
    helperUrl: 'https://platform.openai.com/settings/organization/api-keys',
    extraFields: [
      { key: 'organization_id', label: 'Organization ID (optional)', placeholder: 'org-...' },
      { key: 'project_id', label: 'Project ID (optional)', placeholder: 'proj-...' },
    ],
    supportsCodexOAuth: 'openai-codex',
  },
  {
    slug: 'google',
    name: 'Google',
    tagline: 'Gemini models',
    icon: <Key className="w-5 h-5" />,
    connectionMethod: 'api-key',
    inputLabel: 'API Key',
    inputPlaceholder: 'AIza...',
    helperText: 'Get your API key at aistudio.google.com/app/apikey',
    helperUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    slug: 'ollama',
    name: 'Ollama',
    tagline: 'Local models',
    icon: <Server className="w-5 h-5" />,
    connectionMethod: 'base-url',
    inputLabel: 'Ollama URL',
    inputPlaceholder: 'http://localhost:11434',
    helperText: 'Ollama runs locally — make sure it\'s started before connecting',
    helperUrl: 'https://ollama.com/',
    defaultValue: 'http://localhost:11434',
  },
  {
    slug: 'mlx-studio',
    name: 'MLX Studio',
    tagline: 'Local Apple Silicon models',
    icon: <Server className="w-5 h-5" />,
    connectionMethod: 'base-url',
    inputLabel: 'MLX Studio URL',
    inputPlaceholder: 'http://localhost:10240/v1',
    helperText: 'MLX Studio runs locally on macOS — open it and load a model first',
    helperUrl: 'https://mlxstudio.app/',
    defaultValue: 'http://localhost:10240/v1',
  },
  {
    slug: 'openai-codex',
    name: 'OpenAI Codex (OAuth)',
    tagline: 'GPT models via browser OAuth — requires OpenClaw runtime',
    icon: <Shield className="w-5 h-5" />,
    connectionMethod: 'oauth',
    inputLabel: '',
    inputPlaceholder: '',
    helperText: 'Authenticates via browser OAuth through OpenClaw',
    helperUrl: 'https://platform.openai.com/',
    hidden: true,
  },
  {
    slug: 'minimax',
    name: 'MiniMax',
    tagline: 'MiniMax models — OpenClaw runtime only',
    icon: <Key className="w-5 h-5" />,
    connectionMethod: 'api-key',
    inputLabel: 'API Key',
    inputPlaceholder: 'sk-cp-...',
    helperText: 'Get your API key at platform.minimax.io',
    helperUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
];

type CardStatus = 'idle' | 'connecting' | 'connected' | 'failed';

interface CardState {
  expanded: boolean;
  value: string;
  extraValues: Record<string, string>;
  status: CardStatus;
  error: string | null;
  warning: string | null;
  providerId: number | null;
  loading: boolean;
  oauthPending?: boolean;
  oauthCallbackUrl?: string;
}

function initialCardState(meta: ProviderMeta): CardState {
  return {
    expanded: false,
    value: meta.defaultValue ?? '',
    extraValues: {},
    status: 'idle',
    error: null,
    warning: null,
    providerId: null,
    loading: false,
  };
}

function extractCardState(meta: ProviderMeta, provider?: ProviderRecord): CardState {
  const config = (provider?.config ?? {}) as Record<string, unknown>;
  const value = meta.connectionMethod === 'oauth'
    ? ''
    : meta.connectionMethod === 'api-key'
      ? typeof config.api_key === 'string' ? config.api_key : ''
      : typeof config.base_url === 'string' ? config.base_url : (meta.defaultValue ?? '');
  const extraValues: Record<string, string> = {};
  for (const field of meta.extraFields ?? []) {
    const raw = config[field.key];
    extraValues[field.key] = typeof raw === 'string' ? raw : '';
  }
  return {
    expanded: false,
    value,
    extraValues,
    status: provider?.status === 'connected' ? 'connected' : provider?.status === 'failed' ? 'failed' : 'idle',
    error: provider?.status === 'failed' ? provider.validation_error : null,
    warning: provider?.status === 'connected' && provider.validation_error ? provider.validation_error : null,
    providerId: provider?.id ?? null,
    loading: false,
  };
}

export default function ProviderConnectionsManager({
  mode = 'settings',
  onGatePassed,
  onBack,
}: {
  mode?: 'onboarding' | 'settings';
  onGatePassed?: () => void;
  onBack?: () => void;
}) {
  const [cards, setCards] = useState<Record<ProviderSlug, CardState>>(() => {
    const init = {} as Record<ProviderSlug, CardState>;
    for (const meta of PROVIDERS) init[meta.slug] = initialCardState(meta);
    return init;
  });
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [gatePassed, setGatePassed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setPageError(null);
    try {
      const response = await api.getProviders();
      setProviders(response.providers);
      setGatePassed(response.onboarding_provider_gate_passed);
      setCards(prev => {
        const next = {} as Record<ProviderSlug, CardState>;
        for (const meta of PROVIDERS) {
          const provider = response.providers.find(item => item.slug === meta.slug);
          const base = extractCardState(meta, provider);
          const prevCard = prev[meta.slug];
          next[meta.slug] = {
            ...base,
            expanded: prevCard?.expanded ?? false,
            oauthPending: provider?.status === 'connected' || provider?.status === 'failed' ? false : prevCard?.oauthPending,
            oauthCallbackUrl: provider?.status === 'connected' || provider?.status === 'failed' ? '' : (prevCard?.oauthCallbackUrl ?? ''),
          };
          if (next[meta.slug].oauthPending && provider?.status !== 'connected' && !next[meta.slug].warning) {
            next[meta.slug].warning = 'Agent HQ is waiting for the localhost callback. If the OAuth tab does not close automatically, copy the full final URL and paste it below.';
          }
        }
        return next;
      });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; slug?: string; ok?: boolean } | null;
      if (!data || data.type !== 'agent-hq-oauth-complete' || !data.ok) return;
      void load(false);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [load]);

  const hasPendingOAuth = useMemo(
    () => Object.values(cards).some(card => card.oauthPending),
    [cards]
  );

  useEffect(() => {
    if (!hasPendingOAuth) return;
    const timer = window.setInterval(() => {
      void load(false);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [hasPendingOAuth, load]);

  const connectedCount = useMemo(
    () => providers.filter(provider => provider.status === 'connected').length,
    [providers]
  );

  function setCard(slug: ProviderSlug, patch: Partial<CardState>) {
    setCards(prev => ({ ...prev, [slug]: { ...prev[slug], ...patch } }));
  }

  async function handleOAuthLogin(meta: ProviderMeta) {
    setCard(meta.slug, { status: 'connecting', error: null, warning: null, loading: true, oauthPending: false, oauthCallbackUrl: '' });
    try {
      const result = await api.initiateOAuth(meta.slug);
      if (result.oauthUrl) {
        window.open(result.oauthUrl, '_blank');
      }
      await load(false);
      setCard(meta.slug, {
        status: 'idle', error: null, loading: false, oauthPending: true, oauthCallbackUrl: '',
        warning: 'Agent HQ will finish automatically if the localhost callback succeeds. If the OAuth tab stays open or lands on a localhost URL, copy the full final URL and paste it below.',
      });
    } catch (error) {
      setCard(meta.slug, { status: 'failed', error: error instanceof Error ? error.message : String(error), loading: false });
    }
  }

  async function handleOAuthExchange(meta: ProviderMeta) {
    const card = cards[meta.slug];
    const callbackUrl = card?.oauthCallbackUrl?.trim();
    if (!callbackUrl) {
      setCard(meta.slug, { error: 'Paste the redirect URL from your browser.' });
      return;
    }
    setCard(meta.slug, { loading: true, error: null });
    try {
      await api.exchangeOAuth(meta.slug, callbackUrl);
      await load();
      setCard(meta.slug, { status: 'connected', error: null, warning: null, loading: false, oauthPending: false, oauthCallbackUrl: '' });
    } catch (error) {
      setCard(meta.slug, { status: 'failed', error: error instanceof Error ? error.message : String(error), loading: false });
    }
  }

  async function handleSave(meta: ProviderMeta) {
    if (meta.connectionMethod === 'oauth') return handleOAuthLogin(meta);

    const card = cards[meta.slug];
    const value = card.value.trim();
    if (!value) {
      setCard(meta.slug, { error: `Please enter your ${meta.inputLabel}.` });
      return;
    }

    setCard(meta.slug, { status: 'connecting', error: null, warning: null, loading: true });
    const config: Record<string, unknown> = meta.connectionMethod === 'api-key' ? { api_key: value } : { base_url: value };
    for (const [key, fieldValue] of Object.entries(card.extraValues)) {
      if (key.startsWith('_')) continue;
      if (fieldValue.trim()) config[key] = fieldValue.trim();
    }

    try {
      const result = card.providerId !== null
        ? await api.updateProvider(card.providerId, { display_name: meta.name, config })
        : await api.createProvider({ slug: meta.slug, display_name: meta.name, config });
      await load();
      setCard(meta.slug, {
        expanded: false,
        status: result.validation.ok ? 'connected' : 'failed',
        error: result.validation.ok ? null : result.validation.error,
        warning: result.validation.ok ? result.validation.error : null,
        loading: false,
      });
    } catch (error) {
      setCard(meta.slug, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      });
    }
  }

  async function handleRevalidate(slug: ProviderSlug) {
    const provider = providers.find(item => item.slug === slug);
    if (!provider) return;
    setCard(slug, { loading: true, error: null, warning: null });
    try {
      await api.revalidateProvider(provider.id);
      await load();
    } catch (error) {
      setCard(slug, { loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function handleDisconnect(slug: ProviderSlug) {
    const provider = providers.find(item => item.slug === slug);
    if (!provider) return;
    const providerMeta = PROVIDERS.find(m => m.slug === slug);
    const confirmMsg = providerMeta?.connectionMethod === 'oauth'
      ? `Disconnect ${provider.display_name}? This removes the OAuth connection from Agent HQ.`
      : `Disconnect ${provider.display_name}? This removes the saved connection and API key from Agent HQ.`;
    if (!confirm(confirmMsg)) return;
    setCard(slug, { loading: true });
    try {
      await api.deleteProvider(provider.id);
      await load();
      setCard(slug, { expanded: false });
    } catch (error) {
      setCard(slug, { loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const heading = mode === 'onboarding'
    ? 'Connect your first AI provider'
    : 'Provider Connections';
  const intro = mode === 'onboarding'
    ? gatePassed
      ? 'You\u2019re ready to go. You can connect more providers later from Settings \u2192 Providers.'
      : 'Agent HQ needs at least one AI provider to work. Connect one now, then add or rotate others later from Settings.'
    : 'Manage provider connections, rotate API keys, revalidate credentials, and disconnect providers without going back through onboarding.';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{heading}</h1>
          <p className="text-slate-400 text-sm mt-1 max-w-3xl">{intro}</p>
        </div>
        {mode === 'settings' && (
          <button
            type="button"
            onClick={() => { void load(); }}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        )}
      </div>

      {pageError && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300 text-sm">
          {pageError}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 text-amber-400 animate-spin" />
            </div>
          ) : PROVIDERS.filter(m => !m.hidden).map(meta => {
            const card = cards[meta.slug];
            const provider = providers.find(item => item.slug === meta.slug);

            // If this provider embeds a sub-provider's OAuth, get that state too
            const subOAuthSlug = meta.supportsCodexOAuth;
            const subOAuthMeta = subOAuthSlug ? PROVIDERS.find(m => m.slug === subOAuthSlug) : undefined;
            const subOAuthCard = subOAuthSlug ? cards[subOAuthSlug] : undefined;
            const subOAuthProvider = subOAuthSlug ? providers.find(item => item.slug === subOAuthSlug) : undefined;
            // Sub-OAuth (Codex) derived state
            const subOAuthConnected = subOAuthCard?.status === 'connected';
            const isExpanded = card.expanded || card.status === 'failed' || subOAuthCard?.status === 'failed';
            const isConnected = card.status === 'connected' || (!!subOAuthSlug && subOAuthConnected);
            const isFailed = card.status === 'failed';
            const busy = card.loading || card.status === 'connecting';
            const subOAuthFailed = subOAuthCard?.status === 'failed';
            const subOAuthBusy = !!(subOAuthCard?.loading || subOAuthCard?.status === 'connecting');

            return (
              <div
                key={meta.slug}
                className={`rounded-xl border overflow-hidden ${
                  isConnected ? 'border-emerald-500/40 bg-emerald-500/5' :
                  isFailed ? 'border-red-500/40 bg-red-500/5' :
                  isExpanded ? 'border-slate-500 bg-slate-800/60' : 'border-slate-700 bg-slate-800/40'
                }`}
              >
                <button
                  type="button"
                  className="w-full p-4 flex items-center gap-3 text-left"
                  onClick={() => setCard(meta.slug, { expanded: !card.expanded })}
                >
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${isConnected ? 'bg-emerald-500/15 text-emerald-400' : isFailed ? 'bg-red-500/15 text-red-400' : 'bg-slate-700 text-slate-300'}`}>
                    {meta.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-white font-semibold text-sm">{provider?.display_name || meta.name}</span>
                      {isConnected ? (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-2 py-0.5">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Connected
                        </span>
                      ) : isFailed ? (
                        <span className="inline-flex items-center gap-1 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-full px-2 py-0.5">
                          <AlertCircle className="w-3.5 h-3.5" /> Failed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-slate-400 bg-slate-700/50 border border-slate-600/50 rounded-full px-2 py-0.5">
                          Not connected
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">{meta.tagline}{subOAuthConnected ? ' · Codex OAuth connected' : ''}</p>
                    {provider?.last_validated_at && (
                      <p className="text-xs text-slate-500 mt-1">Last validated: {provider.last_validated_at}</p>
                    )}
                  </div>
                  {busy ? <Loader2 className="w-4 h-4 text-amber-400 animate-spin" /> : isExpanded ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
                </button>

                {card.warning && (
                  <div className="px-4 pb-3">
                    <div className="flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{card.warning}</span>
                    </div>
                  </div>
                )}

                {isExpanded && (
                  <div className="px-4 pb-4 pt-3 border-t border-slate-700/60 space-y-3">
                    {meta.connectionMethod === 'oauth' ? (
                      <>
                        <p className="text-xs text-slate-400">
                          Authenticates via browser OAuth through OpenClaw. No API key needed &mdash; tokens are managed by OpenClaw automatically.
                        </p>
                        <p className="text-xs text-slate-500">Agent HQ will mark this connected automatically if the localhost callback succeeds. If not, paste the full redirect URL below.</p>
                      </>
                    ) : (
                      <>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1.5">{meta.inputLabel}</label>
                          <input
                            type={meta.connectionMethod === 'api-key' ? 'password' : 'text'}
                            value={card.value}
                            onChange={e => setCard(meta.slug, { value: e.target.value, error: null, warning: null, status: isConnected ? 'connected' : 'idle' })}
                            placeholder={meta.inputPlaceholder}
                            className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-amber-400"
                            disabled={busy}
                          />
                        </div>

                        {(meta.extraFields ?? []).map(field => (
                          <div key={field.key}>
                            <label className="block text-xs text-slate-400 mb-1.5">{field.label}</label>
                            <input
                              type="text"
                              value={card.extraValues[field.key] ?? ''}
                              onChange={e => setCard(meta.slug, { extraValues: { ...card.extraValues, [field.key]: e.target.value } })}
                              placeholder={field.placeholder}
                              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-amber-400"
                              disabled={busy}
                            />
                          </div>
                        ))}


                      </>
                    )}

                    <a href={meta.helperUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-amber-400">
                      <ExternalLink className="w-3 h-3" />
                      {meta.helperText}
                    </a>

                    {card.error && (
                      <div className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
                        <WifiOff className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{card.error}</span>
                      </div>
                    )}

                    {/* Embedded Codex OAuth sub-section */}
                    {subOAuthMeta && subOAuthCard && (
                      <div className={`mt-2 rounded-lg border p-3 space-y-2 ${subOAuthConnected ? 'border-emerald-500/30 bg-emerald-500/5' : subOAuthFailed ? 'border-red-500/30 bg-red-500/5' : 'border-slate-700/60 bg-slate-900/40'}`}>
                        <div className="flex items-center gap-2">
                          <Shield className={`w-4 h-4 ${subOAuthConnected ? 'text-emerald-400' : subOAuthFailed ? 'text-red-400' : 'text-slate-400'}`} />
                          <span className="text-xs font-semibold text-slate-200">Codex OAuth</span>
                          {subOAuthConnected ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-2 py-0.5">
                              <CheckCircle2 className="w-3 h-3" /> Connected
                            </span>
                          ) : subOAuthFailed ? (
                            <span className="inline-flex items-center gap-1 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-full px-2 py-0.5">
                              <AlertCircle className="w-3 h-3" /> Failed
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-slate-400 bg-slate-700/50 border border-slate-600/50 rounded-full px-2 py-0.5">
                              Not connected
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-400">
                          Authenticates via browser OAuth through OpenClaw. No API key needed — tokens are managed automatically.
                        </p>
                        <p className="text-xs text-slate-500">Agent HQ will mark this connected automatically if the localhost callback succeeds. If not, paste the full redirect URL below.</p>
                        {subOAuthCard.warning && (
                          <div className="flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2">
                            <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                            <span>{subOAuthCard.warning}</span>
                          </div>
                        )}
                        {subOAuthCard.error && (
                          <div className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-2">
                            <WifiOff className="w-3 h-3 shrink-0 mt-0.5" />
                            <span>{subOAuthCard.error}</span>
                          </div>
                        )}
                        {subOAuthProvider?.last_validated_at && (
                          <p className="text-xs text-slate-500">Last validated: {subOAuthProvider.last_validated_at}</p>
                        )}
                        {subOAuthCard.oauthPending && (
                          <div className="space-y-2">
                            <label className="text-xs text-slate-300">Paste the redirect URL from your browser:</label>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={subOAuthCard.oauthCallbackUrl ?? ''}
                                onChange={e => setCard(subOAuthMeta.slug, { oauthCallbackUrl: e.target.value })}
                                placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                                className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-amber-400"
                              />
                              <button
                                type="button"
                                onClick={() => handleOAuthExchange(subOAuthMeta)}
                                disabled={subOAuthBusy || !subOAuthCard.oauthCallbackUrl?.trim()}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-xs font-medium disabled:opacity-50"
                              >
                                {subOAuthBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                                Connect
                              </button>
                            </div>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => handleSave(subOAuthMeta)}
                            disabled={subOAuthBusy}
                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-900 text-xs font-medium disabled:opacity-50"
                          >
                            {subOAuthBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />}
                            {subOAuthProvider ? 'Re-authenticate' : 'Sign in with OpenAI'}
                          </button>
                          {subOAuthProvider && (
                            <button
                              type="button"
                              onClick={() => handleRevalidate(subOAuthMeta.slug)}
                              disabled={subOAuthBusy}
                              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 hover:border-slate-500 text-xs disabled:opacity-50"
                            >
                              <Wifi className="w-3.5 h-3.5" /> Check Connection
                            </button>
                          )}
                          {subOAuthProvider && (
                            <button
                              type="button"
                              onClick={() => handleDisconnect(subOAuthMeta.slug)}
                              disabled={subOAuthBusy}
                              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 text-xs disabled:opacity-50"
                            >
                              <Trash2 className="w-3.5 h-3.5" /> Disconnect
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      {meta.connectionMethod === 'oauth' ? (
                        <button
                          type="button"
                          onClick={() => handleSave(meta)}
                          disabled={busy}
                          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-900 text-sm font-medium disabled:opacity-50"
                        >
                          <LogIn className="w-4 h-4" />
                          {provider ? 'Re-authenticate' : `Sign in with ${meta.name}`}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleSave(meta)}
                          disabled={busy}
                          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-900 text-sm font-medium disabled:opacity-50"
                        >
                          {provider ? <Pencil className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                          {provider ? 'Save changes' : 'Connect'}
                        </button>
                      )}
                      {provider && (
                        <button
                          type="button"
                          onClick={() => handleRevalidate(meta.slug)}
                          disabled={busy}
                          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-600 text-slate-200 hover:border-slate-500 text-sm disabled:opacity-50"
                        >
                          <Wifi className="w-4 h-4" /> Check Connection
                        </button>
                      )}
                      {provider && (
                        <button
                          type="button"
                          onClick={() => handleDisconnect(meta.slug)}
                          disabled={busy}
                          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 text-sm disabled:opacity-50"
                        >
                          <Trash2 className="w-4 h-4" /> Disconnect
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="space-y-4">
          <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-white mb-2">Status</h2>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between text-slate-300">
                <span>Connected providers</span>
                <span className="font-semibold text-white">{connectedCount}</span>
              </div>
              <div className="flex items-center justify-between text-slate-300">
                <span>Onboarding gate</span>
                <span className={gatePassed ? 'text-emerald-400' : 'text-slate-500'}>
                  {gatePassed ? 'Passed' : 'Needs one connection'}
                </span>
              </div>
            </div>
          </div>

        </div>
      </div>

      {mode === 'onboarding' && (
        <>
          {!gatePassed && !loading && (
            <p className="text-xs text-slate-500 text-center">Connect at least one provider to continue</p>
          )}
          {gatePassed && (
            <p className="text-xs text-emerald-400 text-center">{'\u2713'} {connectedCount} provider{connectedCount !== 1 ? 's' : ''} connected</p>
          )}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onBack} className="px-4 py-3 rounded-xl border border-slate-600 text-slate-300 hover:text-white hover:border-slate-500 text-sm font-medium">{'\u2190'} Back</button>
            <button
              type="button"
              disabled={!gatePassed}
              onClick={onGatePassed}
              className={`flex-1 font-semibold py-3 rounded-xl ${gatePassed ? 'bg-amber-400 hover:bg-amber-300 text-slate-900' : 'bg-slate-700 text-slate-500 cursor-not-allowed opacity-60'}`}
            >
              Continue {'\u2192'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
