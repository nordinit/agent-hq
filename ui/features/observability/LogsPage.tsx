'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Clock3, Loader2, RefreshCw, ScrollText } from 'lucide-react';
import { api } from '@/lib/api';
import type { LogEntry } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const LEVEL_STYLES: Record<LogEntry['level'], string> = {
  debug: 'border-slate-700 bg-slate-900 text-slate-300',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  error: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
};

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<'all' | LogEntry['level']>('all');

  const loadLogs = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    if (mode === 'initial') setLoading(true);
    if (mode === 'refresh') setRefreshing(true);
    setError(null);

    try {
      const result = await api.getLogs({
        limit: 200,
        ...(levelFilter === 'all' ? {} : { level: levelFilter }),
      });
      setLogs(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load logs');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [levelFilter]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const counts = useMemo(() => {
    return logs.reduce(
      (acc, entry) => {
        acc.total += 1;
        acc[entry.level] += 1;
        return acc;
      },
      { total: 0, debug: 0, info: 0, warn: 0, error: 0 } as Record<'total' | LogEntry['level'], number>,
    );
  }, [logs]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1 text-xs font-medium text-slate-300">
            <ScrollText className="h-3.5 w-3.5 text-amber-400" />
            Logs
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-white">Execution Logs</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Review recent runtime events across Agent HQ. This restores the desktop Logs destination with a mobile-safe route that works end to end.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={levelFilter}
            onChange={event => setLevelFilter(event.target.value as 'all' | LogEntry['level'])}
            className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none transition-colors focus:border-amber-500"
            aria-label="Filter logs by level"
          >
            <option value="all">All levels</option>
            <option value="error">Errors</option>
            <option value="warn">Warnings</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
          </select>
          <Button
            type="button"
            variant="ghost"
            size="md"
            onClick={() => void loadLogs('refresh')}
            disabled={refreshing}
            className="rounded-xl border border-slate-700 bg-slate-900/80 text-slate-200 hover:border-slate-600"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          { label: 'Total', value: counts.total },
          { label: 'Errors', value: counts.error },
          { label: 'Warnings', value: counts.warn },
          { label: 'Info', value: counts.info },
          { label: 'Debug', value: counts.debug },
        ].map(stat => (
          <Card key={stat.label} className="p-4">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">{stat.label}</p>
            <p className="mt-2 text-2xl font-semibold text-white">{stat.value}</p>
          </Card>
        ))}
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Recent events</h2>
            <p className="text-xs text-slate-500">Latest 200 entries from /api/v1/logs</p>
          </div>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
        </div>

        {error ? (
          <div className="flex items-start gap-3 px-4 py-5 text-sm text-rose-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <div>
              <p className="font-medium text-rose-100">Unable to load logs</p>
              <p className="mt-1 text-rose-200/80">{error}</p>
            </div>
          </div>
        ) : !loading && logs.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <ScrollText className="mx-auto h-8 w-8 text-slate-600" />
            <p className="mt-3 text-sm font-medium text-slate-300">No logs matched this filter</p>
            <p className="mt-1 text-sm text-slate-500">This environment may not have emitted runtime logs yet. Try another level filter or refresh after new activity.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-800">
            {logs.map(entry => (
              <div key={entry.id} className="space-y-3 px-4 py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-medium uppercase tracking-wide ${LEVEL_STYLES[entry.level]}`}>
                      {entry.level}
                    </span>
                    {entry.agent_name && (
                      <span className="rounded-full border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
                        {entry.agent_name}
                      </span>
                    )}
                    {entry.instance_id && (
                      <span className="rounded-full border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-400">
                        Instance #{entry.instance_id}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Clock3 className="h-3.5 w-3.5" />
                    {formatTimestamp(entry.created_at)}
                  </div>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm text-slate-200">{entry.message}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export default LogsPage;
