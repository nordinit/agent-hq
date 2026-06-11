'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, ProjectAuditEntry } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { timeAgo, formatDateTime } from '@/lib/date';
import { History, Filter, ChevronDown, ChevronUp, FolderOpen, Rocket, Zap, User, Bot } from 'lucide-react';

interface Props {
  projectId: number;
}

const ENTITY_ICONS: Record<string, typeof FolderOpen> = {
  project: FolderOpen,
  sprint: Rocket,
  job_template: Zap,
};

const ENTITY_LABELS: Record<string, string> = {
  project: 'Project',
  sprint: 'Sprint',
  job_template: 'Job Template',
};

const ACTION_BADGE_VARIANT: Record<string, 'done' | 'running' | 'queued' | 'info' | 'failed'> = {
  created: 'done',
  updated: 'info',
  deleted: 'failed',
};

function ActorBadge({ actor }: { actor: string }) {
  const isSystem = ['system', 'api', 'scheduler', 'reconciler', 'watchdog'].includes(actor);
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-400">
      {isSystem ? <Bot className="w-3 h-3" /> : <User className="w-3 h-3" />}
      <span className={isSystem ? 'text-slate-500' : 'text-amber-300'}>{actor}</span>
    </span>
  );
}

function ChangesDiff({ changes }: { changes: Record<string, unknown> }) {
  const entries = Object.entries(changes);
  if (entries.length === 0) return null;

  return (
    <div className="mt-2 space-y-1">
      {entries.map(([field, value]) => {
        // Diff format: { old: ..., new: ... }
        const isDiff = value && typeof value === 'object' && 'old' in (value as Record<string, unknown>) && 'new' in (value as Record<string, unknown>);
        if (isDiff) {
          const diff = value as { old: unknown; new: unknown };
          return (
            <div key={field} className="flex items-start gap-2 text-xs">
              <code className="text-slate-400 font-mono shrink-0">{field}:</code>
              <span className="text-red-400 line-through truncate max-w-[200px]" title={String(diff.old ?? 'null')}>
                {String(diff.old ?? 'null')}
              </span>
              <span className="text-slate-600">→</span>
              <span className="text-green-400 truncate max-w-[200px]" title={String(diff.new ?? 'null')}>
                {String(diff.new ?? 'null')}
              </span>
            </div>
          );
        }
        // Simple value (for created/deleted — just show the value)
        return (
          <div key={field} className="flex items-start gap-2 text-xs">
            <code className="text-slate-400 font-mono shrink-0">{field}:</code>
            <span className="text-slate-300 truncate max-w-[400px]" title={String(value ?? 'null')}>
              {String(value ?? 'null')}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ProjectAuditLog({ projectId }: Props) {
  const [entries, setEntries] = useState<ProjectAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [limit] = useState(50);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getProjectAudit(projectId, {
        entity_type: filter ?? undefined,
        limit: limit + 1,
      });
      setHasMore(data.length > limit);
      setEntries(data.slice(0, limit));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, filter, limit]);

  useEffect(() => { load(); }, [load]);

  const toggleExpand = (id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const loadMore = async () => {
    try {
      const data = await api.getProjectAudit(projectId, {
        entity_type: filter ?? undefined,
        limit: limit + 1,
        offset: entries.length,
      });
      setHasMore(data.length > limit);
      setEntries(prev => [...prev, ...data.slice(0, limit)]);
    } catch (e) {
      setError(String(e));
    }
  };

  if (loading && entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300 text-sm">{error}</div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold text-white">Audit History</h2>
          <span className="text-xs text-slate-500">{entries.length} entries</span>
        </div>

        {/* Entity type filter */}
        <div className="flex items-center gap-1">
          <Filter className="w-3.5 h-3.5 text-slate-500" />
          {[null, 'project', 'sprint', 'job_template'].map(type => (
            <button
              key={type ?? 'all'}
              onClick={() => setFilter(type)}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                filter === type
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {type ? ENTITY_LABELS[type] : 'All'}
            </button>
          ))}
        </div>
      </div>

      {entries.length === 0 ? (
        <Card>
          <div className="text-center py-8 text-slate-500 text-sm">
            No audit history yet for this project. Changes to projects, sprints, and jobs will appear here once this environment has audit activity.
          </div>
        </Card>
      ) : (
        <div className="space-y-1">
          {entries.map(entry => {
            const Icon = ENTITY_ICONS[entry.entity_type] ?? FolderOpen;
            const isExpanded = expandedIds.has(entry.id);
            const changeCount = Object.keys(entry.changes).length;

            return (
              <div
                key={entry.id}
                className="bg-slate-800/50 border border-slate-700/50 rounded-lg px-3 py-2 hover:border-slate-600/50 transition-colors"
              >
                <div
                  className="flex items-center gap-2 cursor-pointer"
                  onClick={() => changeCount > 0 && toggleExpand(entry.id)}
                >
                  <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <Badge variant={ACTION_BADGE_VARIANT[entry.action] ?? 'default'}>
                    {entry.action}
                  </Badge>
                  <span className="text-xs text-slate-300">
                    {ENTITY_LABELS[entry.entity_type]} #{entry.entity_id}
                  </span>
                  <ActorBadge actor={entry.actor} />
                  <span className="flex-1" />
                  <span className="text-xs text-slate-600" title={formatDateTime(entry.created_at)}>
                    {timeAgo(entry.created_at)}
                  </span>
                  {changeCount > 0 && (
                    isExpanded
                      ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
                      : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                  )}
                </div>
                {isExpanded && <ChangesDiff changes={entry.changes} />}
              </div>
            );
          })}
        </div>
      )}

      {hasMore && (
        <div className="text-center">
          <Button variant="ghost" size="sm" onClick={loadMore}>
            Load more…
          </Button>
        </div>
      )}
    </div>
  );
}

export default ProjectAuditLog;
