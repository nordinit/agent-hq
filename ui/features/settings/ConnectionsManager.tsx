'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface TelegramStatus {
  connected: boolean;
  chatId: string | null;
  botTokenSet: boolean;
  botTokenMasked: string | null;
  pollingActive?: boolean;
  botName?: string | null;
  botUsername?: string | null;
}

interface ConnectionMeta {
  id: 'telegram' | 'whatsapp' | 'discord';
  name: string;
  tagline: string;
  icon: React.ReactNode;
  available: boolean;
  comingSoon?: boolean;
  docsUrl?: string;
}

// ─── Connection definitions ───────────────────────────────────────────────────

const CONNECTIONS: ConnectionMeta[] = [
  {
    id: 'telegram',
    name: 'Telegram',
    tagline: 'Bot notifications and command dispatch',
    icon: <Send className="w-5 h-5" />,
    available: true,
    docsUrl: 'https://core.telegram.org/bots',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    tagline: 'WhatsApp Business messaging integration',
    icon: <MessageCircle className="w-5 h-5" />,
    available: false,
    comingSoon: true,
    docsUrl: 'https://business.whatsapp.com/',
  },
  {
    id: 'discord',
    name: 'Discord',
    tagline: 'Discord bot for team notifications',
    icon: (
      // Discord-style icon using SVG
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
      </svg>
    ),
    available: false,
    comingSoon: true,
    docsUrl: 'https://discord.com/developers/docs/intro',
  },
];

// ─── Telegram Card ────────────────────────────────────────────────────────────

function TelegramCard() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string; error?: string; botUsername?: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const apiBase = typeof window !== 'undefined'
    ? (window.location.port === '3510' ? `${window.location.protocol}//${window.location.hostname}:3511` : '')
    : '';

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/v1/settings/telegram`);
      const data = await res.json() as TelegramStatus;
      setStatus(data);
      if (data.chatId) setChatId(data.chatId);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setTestResult(null);
    try {
      const res = await fetch(`${apiBase}/api/v1/settings/telegram`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: botToken || undefined, chatId: chatId || undefined }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || data.error) {
        setSaveError(data.error || 'Failed to save');
      } else {
        setBotToken('');
        await fetchStatus();
        setExpanded(false);
      }
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const body: Record<string, string> = {};
      if (botToken.trim()) body.botToken = botToken.trim();
      if (chatId.trim()) body.chatId = chatId.trim();
      const res = await fetch(`${apiBase}/api/v1/settings/telegram/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok: boolean; message?: string; error?: string; botUsername?: string };
      setTestResult(data);
    } catch (err) {
      setTestResult({ ok: false, error: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect Telegram? This removes the bot token and chat ID from Agent HQ.')) return;
    setDisconnecting(true);
    try {
      await fetch(`${apiBase}/api/v1/settings/telegram`, { method: 'DELETE' });
      setTestResult(null);
      setBotToken('');
      setChatId('');
      setExpanded(false);
      await fetchStatus();
    } catch {
      // ignore
    } finally {
      setDisconnecting(false);
    }
  };

  const isConnected = status?.connected ?? false;
  const isFailed = false; // Telegram doesn't have a "failed" state, just connected/not
  const busy = saving || testing || disconnecting || loading;
  const isExpanded = expanded;

  return (
    <div className={`rounded-xl border overflow-hidden ${
      isConnected ? 'border-emerald-500/40 bg-emerald-500/5' :
      isFailed ? 'border-red-500/40 bg-red-500/5' :
      isExpanded ? 'border-slate-500 bg-slate-800/60' : 'border-slate-700 bg-slate-800/40'
    }`}>
      {/* Header row */}
      <button
        type="button"
        className="w-full p-4 flex items-center gap-3 text-left"
        onClick={() => setExpanded(e => !e)}
      >
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
          isConnected ? 'bg-emerald-500/15 text-emerald-400' :
          isFailed ? 'bg-red-500/15 text-red-400' :
          'bg-slate-700 text-slate-300'
        }`}>
          <Send className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white font-semibold text-sm">Telegram</span>
            {loading ? (
              <span className="inline-flex items-center gap-1 text-xs text-slate-400 bg-slate-700/50 border border-slate-600/50 rounded-full px-2 py-0.5">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
              </span>
            ) : isConnected ? (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-2 py-0.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> Connected
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-slate-400 bg-slate-700/50 border border-slate-600/50 rounded-full px-2 py-0.5">
                <WifiOff className="w-3.5 h-3.5" /> Not connected
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Bot notifications and command dispatch
            {status?.pollingActive === false && isConnected && (
              <span className="ml-2 text-amber-400">· Polling inactive</span>
            )}
          </p>
          {isConnected && (status?.botName || status?.botUsername) && (
            <p className="text-xs text-slate-400 mt-0.5">
              {status.botName ? `@${status.botName}` : status.botUsername ? `@${status.botUsername}` : ''}
              {status.botTokenMasked && (
                <span className="ml-2 text-slate-500">· Token: {status.botTokenMasked}</span>
              )}
              {status.chatId && (
                <span className="ml-2 text-slate-500">· Chat: {status.chatId}</span>
              )}
            </p>
          )}
          {isConnected && !status?.botName && !status?.botUsername && status?.botTokenMasked && (
            <p className="text-xs text-slate-500 mt-0.5">
              Token: {status.botTokenMasked}
              {status.chatId && <span className="ml-2">· Chat: {status.chatId}</span>}
            </p>
          )}
        </div>
        {busy && !isExpanded ? (
          <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
        ) : isExpanded ? (
          <ChevronUp className="w-4 h-4 text-slate-500" />
        ) : (
          <ChevronDown className="w-4 h-4 text-slate-500" />
        )}
      </button>

      {/* Expanded form */}
      {isExpanded && (
        <div className="px-4 pb-4 pt-3 border-t border-slate-700/60 space-y-4">
          {/* Polling status indicator */}
          {isConnected && (
            <div className="flex items-center gap-3 text-xs">
              <Clock className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-slate-400">
                Polling:{' '}
                <span className={status?.pollingActive === false ? 'text-amber-400' : 'text-emerald-400'}>
                  {status?.pollingActive === false ? 'Inactive' : 'Active'}
                </span>
              </span>
            </div>
          )}

          {/* Bot token field */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Bot Token</label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={botToken}
                onChange={e => setBotToken(e.target.value)}
                placeholder={status?.botTokenSet ? '••••• (saved — enter new to replace)' : '123456:ABC-DEF...'}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2.5 pr-9 text-white text-sm font-mono focus:outline-none focus:border-amber-400"
                disabled={busy}
              />
              <button
                type="button"
                onClick={() => setShowToken(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Chat ID field */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Chat ID</label>
            <input
              type="text"
              value={chatId}
              onChange={e => setChatId(e.target.value)}
              placeholder="Your numeric Telegram user/chat ID"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-amber-400"
              disabled={busy}
            />
          </div>

          {/* Helper link */}
          <a
            href="https://core.telegram.org/bots#how-do-i-create-a-bot"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-amber-400"
          >
            <ExternalLink className="w-3 h-3" />
            How to create a Telegram bot via @BotFather
          </a>

          {/* Save error */}
          {saveError && (
            <div className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{saveError}</span>
            </div>
          )}

          {/* Test result */}
          {testResult && (
            <div className={`flex items-start gap-2 text-xs rounded-lg p-2.5 ${
              testResult.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border border-red-500/20 text-red-300'
            }`}>
              {testResult.ok ? <Wifi className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <WifiOff className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
              <span>
                {testResult.ok
                  ? (testResult.message ?? (testResult.botUsername ? `Connected as @${testResult.botUsername}` : 'Connection successful'))
                  : (testResult.error ?? 'Connection failed')}
              </span>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={busy || (!botToken.trim() && !chatId.trim())}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-900 text-sm font-medium disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {isConnected ? 'Update' : 'Connect'}
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={busy}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-600 text-slate-200 hover:border-slate-500 text-sm disabled:opacity-50"
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
              Test
            </button>
            {isConnected && (
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={busy}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 text-sm disabled:opacity-50"
              >
                {disconnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Disconnect
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Placeholder Card ─────────────────────────────────────────────────────────

function PlaceholderCard({ conn }: { conn: ConnectionMeta }) {
  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 overflow-hidden opacity-70">
      <div className="p-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-slate-700/60 text-slate-400">
          {conn.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white font-semibold text-sm">{conn.name}</span>
            {conn.comingSoon && (
              <span className="inline-flex items-center text-xs text-slate-400 bg-slate-700/60 border border-slate-600/50 rounded-full px-2 py-0.5">
                Coming soon
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">{conn.tagline}</p>
        </div>
        {conn.docsUrl && (
          <a
            href={conn.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-slate-600 hover:text-slate-400 transition-colors"
            title={`Learn about ${conn.name} integration`}
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ConnectionsManager() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);

  const handleRefresh = () => {
    setLoading(true);
    setRefreshKey(k => k + 1);
    setTimeout(() => setLoading(false), 800);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Connections</h1>
          <p className="text-slate-400 text-sm mt-1 max-w-3xl">
            Manage messaging channel integrations. Connect Telegram to receive Agent HQ notifications and dispatch commands from mobile.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 space-y-3">
          {CONNECTIONS.map(conn => {
            if (conn.id === 'telegram') {
              return <TelegramCard key={`${conn.id}-${refreshKey}`} />;
            }
            return <PlaceholderCard key={conn.id} conn={conn} />;
          })}
        </div>

        {/* Sidebar info panel */}
        <div className="space-y-4">
          <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-white mb-2">About Connections</h2>
            <p className="text-xs text-slate-400 leading-relaxed">
              Connections let Agent HQ send notifications and receive commands through messaging platforms.
              Telegram is fully supported — WhatsApp and Discord integrations are on the roadmap.
            </p>
          </div>
          <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4 space-y-2">
            <h2 className="text-sm font-semibold text-white">Quick Links</h2>
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 text-xs text-slate-400 hover:text-amber-400 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              Create a Telegram bot with @BotFather
            </a>
            <a
              href="https://core.telegram.org/bots/faq#how-do-i-find-my-chat-id"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 text-xs text-slate-400 hover:text-amber-400 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              Find your Telegram Chat ID
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
