'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, CheckCircle, XCircle, ArrowLeft, Unplug } from 'lucide-react';

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

export default function TelegramSettings({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const apiBase = typeof window !== 'undefined'
    ? (window.location.port === '3510' ? `${window.location.protocol}//${window.location.hostname}:3511` : '')
    : '';

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/v1/settings/telegram`);
      const data = await res.json() as TelegramStatus;
      setStatus(data);
      if (data.chatId) setChatId(data.chatId);
    } catch (err) {
      console.error('[telegram-settings] fetch error:', err);
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
        body: JSON.stringify({ botToken, chatId }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || data.error) {
        setSaveError(data.error || 'Failed to save');
      } else {
        setBotToken('');
        await fetchStatus();
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

      const res = await fetch(`${apiBase}/api/v1/settings/telegram/test`, {
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
      await fetch(`${apiBase}/api/v1/settings/telegram`, { method: 'DELETE' });
      setTestResult(null);
      setBotToken('');
      setChatId('');
      await fetchStatus();
    } catch (err) {
      console.error('[telegram-settings] disconnect error:', err);
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-700/50 shrink-0">
        <button
          onClick={onBack}
          className="w-7 h-7 rounded-lg hover:bg-slate-700/60 flex items-center justify-center transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-slate-400" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white">Telegram Notifications</p>
          <p className="text-[10px] text-slate-500">
            {status?.connected ? '🟢 Connected' : '⚪ Not connected'}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Status card */}
        {status?.connected && (
          <div className="bg-emerald-900/20 border border-emerald-700/40 rounded-lg px-3 py-2">
            <p className="text-xs text-emerald-300 font-medium">Connected</p>
            <p className="text-[10px] text-emerald-400/70 mt-0.5">
              Token: {status.botTokenMasked} · Chat ID: {status.chatId}
            </p>
          </div>
        )}

        {/* Info */}
        <p className="text-[11px] text-slate-400 leading-relaxed">
          Connect your Telegram bot to receive Agent HQ notifications on mobile. 
          You&apos;ll need a <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-amber-400 hover:underline">@BotFather</a> bot token and your Telegram user/chat ID.
        </p>

        {/* Form */}
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1">Bot Token</label>
            <input
              type="password"
              className="w-full bg-slate-800/60 border border-slate-700/60 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500/50 transition-colors"
              placeholder={status?.botTokenSet ? '••••• (saved — enter new to replace)' : '123456:ABC-DEF...'}
              value={botToken}
              onChange={e => setBotToken(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1">Chat ID</label>
            <input
              type="text"
              className="w-full bg-slate-800/60 border border-slate-700/60 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500/50 transition-colors"
              placeholder="Your numeric Telegram user/chat ID"
              value={chatId}
              onChange={e => setChatId(e.target.value)}
            />
          </div>
        </div>

        {/* Error */}
        {saveError && (
          <p className="text-[10px] text-red-400">{saveError}</p>
        )}

        {/* Test result */}
        {testResult && (
          <div className={`flex items-start gap-2 rounded-lg px-3 py-2 ${testResult.ok ? 'bg-emerald-900/20 border border-emerald-700/40' : 'bg-red-900/20 border border-red-800/40'}`}>
            {testResult.ok ? (
              <CheckCircle className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
            )}
            <p className="text-[10px] text-slate-300">
              {testResult.ok ? testResult.message : testResult.error}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving || (!botToken.trim() && !chatId.trim())}
            className="flex-1 px-3 py-2 rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-medium hover:bg-amber-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            Save
          </button>
          <button
            onClick={handleTest}
            disabled={testing}
            className="flex-1 px-3 py-2 rounded-lg bg-slate-700/60 border border-slate-600/50 text-slate-300 text-xs font-medium hover:bg-slate-700/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
          >
            {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            Test
          </button>
        </div>

        {/* Disconnect */}
        {status?.connected && (
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="w-full px-3 py-2 rounded-lg bg-red-900/20 border border-red-800/40 text-red-400 text-xs font-medium hover:bg-red-900/30 transition-colors disabled:opacity-40 flex items-center justify-center gap-1.5"
          >
            {disconnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Unplug className="w-3 h-3" />}
            Disconnect Telegram
          </button>
        )}
      </div>
    </div>
  );
}
