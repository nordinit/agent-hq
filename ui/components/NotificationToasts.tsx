'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, X } from 'lucide-react';
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
  title: string;
  body: string;
  source: string | null;
  outlet: string | null;
  created_at: string;
}

interface NotificationsResponse {
  ok: boolean;
  preferences: NotificationPreferences;
  records: NotificationRecord[];
  error?: string;
}

function formatTime(value: string): string {
  const date = parseDbDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export default function NotificationToasts() {
  const [records, setRecords] = useState<NotificationRecord[]>([]);
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(() => new Set());
  const [hovered, setHovered] = useState(false);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/settings/notifications?limit=10');
      const data = await res.json() as NotificationsResponse;
      if (!res.ok || data.error) return;
      setLiveEnabled(data.preferences.liveEnabled);
      setRecords(data.records);
    } catch {
      // Non-blocking UI affordance.
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
    const interval = window.setInterval(fetchNotifications, 15000);
    return () => window.clearInterval(interval);
  }, [fetchNotifications]);

  const visibleRecords = useMemo(
    () => records.filter(record => !hiddenIds.has(record.id)).slice(0, 3),
    [hiddenIds, records],
  );

  useEffect(() => {
    if (records.length === 0 || hiddenIds.size === 0) return;
    const knownIds = new Set(records.map(record => record.id));
    setHiddenIds(current => {
      const next = new Set([...current].filter(id => knownIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [hiddenIds.size, records]);

  if (!liveEnabled || visibleRecords.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 left-4 right-4 z-50 flex max-w-sm flex-col items-start gap-2 md:right-auto"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {hovered && (
        <button
          type="button"
          onClick={() => setHiddenIds(current => new Set([...current, ...visibleRecords.map(record => record.id)]))}
          className="ml-1 rounded-md border border-slate-600 bg-slate-950/95 px-2.5 py-1 text-xs font-medium text-slate-200 shadow-lg shadow-slate-950/30 transition-colors hover:border-slate-500 hover:text-white"
        >
          Hide all
        </button>
      )}
      {visibleRecords.map(record => (
        <article
          key={record.id}
          className="group relative w-full rounded-lg border border-slate-600 bg-slate-950/95 p-3 pr-9 shadow-lg shadow-slate-950/35 backdrop-blur"
        >
          <button
            type="button"
            onClick={() => setHiddenIds(current => new Set([...current, record.id]))}
            className="absolute right-2 top-2 hidden rounded-md p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-white group-hover:block"
            aria-label="Close notification"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="flex items-start gap-2">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-400/10 text-amber-300">
              <Bell className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-white">{record.title}</h2>
                <span className="text-xs text-slate-500">{formatTime(record.created_at)}</span>
              </div>
              <p className="mt-1 line-clamp-3 whitespace-pre-line text-xs leading-5 text-slate-300">{record.body}</p>
              {(record.outlet || record.source) && (
                <p className="mt-1 truncate text-xs text-slate-500">
                  {[record.outlet, record.source].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
