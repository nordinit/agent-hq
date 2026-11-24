'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, CheckCircle, XCircle, Unplug, MessageSquare } from 'lucide-react';

interface TelegramStatus {
  connected: boolean;
  chatId: string | null;
  botTokenSet: boolean;
  botTokenMasked: string | null;
}

interface TestResult {
  ok: boolean;
  error?: string;
  botUsername?: string;
  message?: string;
}

/**
 * Telegram bot connection, shown as a section of Settings → Notifications.
 * `onChange` fires after a save or disconnect so the page can refresh its outlet state.
 */
export default function TelegramSettings({ onChange }: { onChange?: () => void }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Same-origin through the UI proxy, which carries the operator credential the API requires.
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/settings/telegram');
      const data = await res.json() as TelegramStatus;
      setStatus(data);
      if (data.chatId) setChatId(data.chatId);
    } catch (err) {
      console.error('[telegram-settings] fetch error:', err);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setTestResult(null);
    try {
      const res = await fetch('/api/v1/settings/telegram', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken, chatId }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || data.error) {
        setSaveError(data.error || 'Failed to save');
      } else {
        setBotToken('');
        await fetchStatus();
        onChange?.();
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
      // If user has entered new creds, test those; otherwise test saved
      if (botToken.trim()) body.botToken = botToken.trim();
      if (chatId.trim()) body.chatId = chatId.trim();

      const res = await fetch('/api/v1/settings/telegram/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as TestResult;
      setTestResult(data);
    } catch (err) {
      setTestResult({ ok: false, error: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await fetch('/api/v1/settings/telegram', { method: 'DELETE' });
      setTestResult(null);
      setBotToken('');
      setChatId('');
      await fetchStatus();
      onChange?.();
    } catch (err) {
      console.error('[telegram-settings] disconnect error:', err);
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4" id="telegram">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-sky-300" />
          <h2 className="text-sm font-semibold text-white">Telegram</h2>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs ${status?.connected
            ? 'text-emerald-200 bg-emerald-500/10 border-emerald-500/20'
            : 'text-slate-300 bg-slate-700/60 border-slate-600/60'}`}
        >
          {status?.connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      <div className="space-y-3">
        {status?.connected && (
          <p className="text-xs text-slate-400">
            Token {status.botTokenMasked} · Chat ID {status.chatId}
          </p>
        )}

        <p className="text-xs leading-5 text-slate-400">
          Connect a Telegram bot to receive Agent HQ notifications on mobile.
          You&apos;ll need a <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-amber-400 hover:underline">@BotFather</a> bot token and your Telegram user/chat ID.
        </p>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-slate-400">Bot token</label>
            <input
              type="password"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-white placeholder-slate-500 transition-colors focus:border-amber-500/50 focus:outline-none"
              placeholder={status?.botTokenSet ? '••••• (saved — enter new to replace)' : '123456:ABC-DEF...'}
              value={botToken}
              onChange={e => setBotToken(e.target.value)}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-slate-400">Chat ID</label>
            <input
              type="text"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-white placeholder-slate-500 transition-colors focus:border-amber-500/50 focus:outline-none"
              placeholder="Your numeric Telegram user/chat ID"
              value={chatId}
              onChange={e => setChatId(e.target.value)}
            />
          </div>
        </div>

        {saveError && (
          <p className="text-xs text-red-400">{saveError}</p>
        )}

        {testResult && (
          <div className={`flex items-start gap-2 rounded-lg px-3 py-2 ${testResult.ok ? 'border border-emerald-700/40 bg-emerald-900/20' : 'border border-red-800/40 bg-red-900/20'}`}>
            {testResult.ok ? (
              <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            ) : (
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
            )}
            <p className="text-xs text-slate-300">
              {testResult.ok ? testResult.message : testResult.error}
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || (!botToken.trim() && !chatId.trim())}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/20 px-3 py-2 text-sm font-medium text-amber-300 transition-colors hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600/50 bg-slate-700/60 px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700/80 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Send test
          </button>
          {status?.connected && (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-800/40 bg-red-900/20 px-3 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-900/30 disabled:opacity-40"
            >
              {disconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />}
              Disconnect
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
