'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, BellOff, CheckCircle2, Loader2, RefreshCw, Send, ToggleLeft, ToggleRight } from 'lucide-react';
import { parseDbDate } from '@/lib/date';

interface NotificationPreferences {
  enabled: boolean;
  liveEnabled: boolean;
  outlets: {
    telegram: boolean;
  };
}

interface NotificationRecord {
  id: number;
  type: string;
  title: string;
  body: string;
  source: string | null;
  outlet: string | null;
  created_at: string;
}

interface NotificationsResponse {
  ok: boolean;
  preferences: NotificationPreferences;
  outlets: {
    telegram: {
      supported: boolean;
      configured: boolean;
      enabled: boolean;
      chatId: string | null;
      botTokenSet: boolean;
    };
  };
  records: NotificationRecord[];
  pagination?: {
    limit: number;
    next_cursor: string | null;
  };
  unread_count?: number;
  error?: string;
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  enabled: true,
  liveEnabled: true,
  outlets: {
    telegram: true,
  },
};

function formatTime(value: string): string {
  const date = parseDbDate(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function ToggleButton({
  checked,
  disabled,
  label,
  description,
  onClick,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-between gap-4 rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3 text-left transition-colors hover:border-slate-600 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-white">{label}</span>
        <span className="mt-0.5 block text-xs leading-5 text-slate-400">{description}</span>
      </span>
      {checked ? (
        <ToggleRight className="h-7 w-7 shrink-0 text-emerald-400" />
      ) : (
        <ToggleLeft className="h-7 w-7 shrink-0 text-slate-500" />
      )}
    </button>
  );
}

export default function NotificationsSettingsPage() {
  const [preferences, setPreferences] = useState<NotificationPreferences>(DEFAULT_PREFERENCES);
  const [outletConfigured, setOutletConfigured] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const [records, setRecords] = useState<NotificationRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async (cursor?: string | null) => {
    const loadingNextPage = Boolean(cursor);
    if (loadingNextPage) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/v1/settings/notifications?${params.toString()}`);
      const data = await res.json() as NotificationsResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? `API error ${res.status}`);
      setPreferences(data.preferences);
      setOutletConfigured(data.outlets.telegram.configured);
      setChatId(data.outlets.telegram.chatId);
      setRecords(current => loadingNextPage ? [...current, ...data.records] : data.records);
      setNextCursor(data.pagination?.next_cursor ?? null);
      setUnreadCount(data.unread_count ?? data.records.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (loadingNextPage) {
        setLoadingMore(false);
      } else {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const savePreferences = async (next: NotificationPreferences) => {
    setSaving(true);
    setError(null);
    setPreferences(next);
    try {
      const res = await fetch('/api/v1/settings/notifications/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const data = await res.json() as { ok?: boolean; preferences?: NotificationPreferences; error?: string };
      if (!res.ok || data.error || !data.preferences) throw new Error(data.error ?? `API error ${res.status}`);
      setPreferences(data.preferences);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      fetchSettings();
    } finally {
      setSaving(false);
    }
  };

  const deliveryStatus = useMemo(() => {
    if (!preferences.enabled) return { label: 'Paused', className: 'text-slate-300 bg-slate-700/60 border-slate-600/60' };
    if (!outletConfigured) return { label: 'No outlet configured', className: 'text-amber-200 bg-amber-500/10 border-amber-500/20' };
    if (!preferences.outlets.telegram) return { label: 'Telegram off', className: 'text-slate-300 bg-slate-700/60 border-slate-600/60' };
    return { label: 'Sending via Telegram', className: 'text-emerald-200 bg-emerald-500/10 border-emerald-500/20' };
  }, [outletConfigured, preferences.enabled, preferences.outlets.telegram]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Notifications</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Control delivery outlets and review notification history for the active tenant.
          </p>
        </div>
        <button
          type="button"
          onClick={() => fetchSettings()}
          disabled={loading || saving}
          className="inline-flex w-fit items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 transition-colors hover:border-slate-600 hover:text-white disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="space-y-3 xl:col-span-2">
          <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {preferences.enabled ? <Bell className="h-4 w-4 text-amber-400" /> : <BellOff className="h-4 w-4 text-slate-500" />}
                <h2 className="text-sm font-semibold text-white">Delivery</h2>
              </div>
              <span className={`rounded-full border px-2 py-0.5 text-xs ${deliveryStatus.className}`}>{deliveryStatus.label}</span>
            </div>
            <div className="space-y-3">
              <ToggleButton
                checked={preferences.enabled}
                disabled={saving}
                label="Enable notifications"
                description="Allow Agent HQ to deliver notifications through configured outlets."
                onClick={() => savePreferences({ ...preferences, enabled: !preferences.enabled })}
              />
              <ToggleButton
                checked={preferences.liveEnabled}
                disabled={saving}
                label="Show in-app notifications"
                description="Show current notifications as dismissible rectangles in the bottom-left of the app."
                onClick={() => savePreferences({ ...preferences, liveEnabled: !preferences.liveEnabled })}
              />
            </div>
          </div>

          <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
            <div className="mb-3 flex items-center gap-2">
              <Send className="h-4 w-4 text-sky-300" />
              <h2 className="text-sm font-semibold text-white">Outlets</h2>
            </div>
            <ToggleButton
              checked={preferences.outlets.telegram}
              disabled={saving || !outletConfigured}
              label="Telegram"
              description={outletConfigured ? `Configured${chatId ? ` for chat ${chatId}` : ''}.` : 'Connect Telegram in Settings > Connections before delivery can send.'}
              onClick={() => savePreferences({
                ...preferences,
                outlets: { ...preferences.outlets, telegram: !preferences.outlets.telegram },
              })}
            />
          </div>
        </section>

        <aside className="rounded-lg border border-slate-700 bg-slate-900/60 p-4">
          <h2 className="text-sm font-semibold text-white">History</h2>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            Notification records stay visible here even when delivery or live in-app notifications are turned off.
          </p>
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-400">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
            {records.length} record{records.length === 1 ? '' : 's'} loaded
          </div>
          <div className="mt-2 text-xs text-slate-500">
            {unreadCount} in active-tenant history
          </div>
        </aside>
      </div>

      <section className="rounded-lg border border-slate-700 bg-slate-800/40">
        <div className="border-b border-slate-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-white">Notification Records</h2>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-8 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading notifications...
          </div>
        ) : records.length === 0 ? (
          <div className="px-4 py-8 text-sm text-slate-500">No notification records yet.</div>
        ) : (
          <div className="divide-y divide-slate-700/70">
            {records.map(record => (
              <article key={record.id} className="grid gap-3 px-4 py-3 md:grid-cols-[1fr_auto]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-white">{record.title}</h3>
                    {record.outlet && (
                      <span className="rounded-full border border-slate-600 bg-slate-900 px-2 py-0.5 text-xs text-slate-400">
                        {record.outlet}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 whitespace-pre-line text-sm leading-5 text-slate-300">{record.body}</p>
                </div>
                <div className="text-xs text-slate-500 md:text-right">
                  <div>{formatTime(record.created_at)}</div>
                  {record.source && <div className="mt-1">{record.source}</div>}
                </div>
              </article>
            ))}
            {nextCursor && (
              <div className="px-4 py-3">
                <button
                  type="button"
                  onClick={() => fetchSettings(nextCursor)}
                  disabled={loadingMore}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 transition-colors hover:border-slate-600 hover:text-white disabled:opacity-50"
                >
                  {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                  Load more
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
