'use client';
import { timeAgo } from '@/lib/date';

import { Agent, JobInstance } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { getRunLifecycle, getRunTimelineSummary, RunDisplayStatus, getTaskOutcomeLabel, getTaskOutcomeBadgeVariant } from '@/lib/runLifecycle';
import { useWorkflowMetadata } from '@/lib/useWorkflowMetadata';
import { TaskOutcomeMetaMap } from '@/lib/taskOutcomeMeta';

type ResolvedStatus = RunDisplayStatus | 'idle';

const STATUS_COLS: ResolvedStatus[] = ['running', 'awaiting_outcome', 'starting', 'queued', 'done', 'failed', 'idle'];

const STATUS_LABELS: Record<ResolvedStatus, string> = {
  running: 'Running',
  awaiting_outcome: 'Awaiting Outcome',
  starting: 'Starting',
  queued: 'Queued',
  done: 'Done',
  failed: 'Failed',
  idle: 'Idle',
};

const COL_COLORS: Record<ResolvedStatus, string> = {
  running: 'border-amber-600',
  awaiting_outcome: 'border-yellow-500',
  starting: 'border-orange-600',
  queued: 'border-slate-600',
  done: 'border-green-700',
  failed: 'border-red-700',
  idle: 'border-slate-700',
};

interface KanbanBoardProps {
  templates: Agent[];
  instances: JobInstance[];
  viewMode: 'status' | 'agent';
  agents?: Agent[];
}

interface ResolvedJob {
  template: Agent;
  instance: JobInstance | null;
  status: ResolvedStatus;
}

function resolveJobStatus(template: Agent, instances: JobInstance[], nonFailureOutcomes: Set<string>): ResolvedJob {
  const templateInstances = instances.filter(i => i.agent_id === template.id);

  if (templateInstances.length === 0) {
    return { template, instance: null, status: 'idle' };
  }

  const sorted = [...templateInstances].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const lifecycleOptions = { nonFailureOutcomes };
  const running = sorted.find(i => getRunLifecycle(i, lifecycleOptions).displayStatus === 'running');
  if (running) return { template, instance: running, status: 'running' };

  const awaitingOutcome = sorted.find(i => getRunLifecycle(i, lifecycleOptions).displayStatus === 'awaiting_outcome');
  if (awaitingOutcome) return { template, instance: awaitingOutcome, status: 'awaiting_outcome' };

  const starting = sorted.find(i => getRunLifecycle(i, lifecycleOptions).displayStatus === 'starting');
  if (starting) return { template, instance: starting, status: 'starting' };

  const queued = sorted.find(i => getRunLifecycle(i, lifecycleOptions).displayStatus === 'queued');
  if (queued) return { template, instance: queued, status: 'queued' };

  const terminal = sorted.find(i => {
    const displayStatus = getRunLifecycle(i, lifecycleOptions).displayStatus;
    return displayStatus === 'done' || displayStatus === 'failed';
  });
  if (terminal) {
    return { template, instance: terminal, status: getRunLifecycle(terminal, lifecycleOptions).displayStatus as ResolvedStatus };
  }

  const mostRecent = sorted[0];
  return { template, instance: mostRecent, status: getRunLifecycle(mostRecent, lifecycleOptions).displayStatus };
}

function JobCard({
  resolved,
  outcomeMap,
  nonFailureOutcomes,
}: {
  resolved: ResolvedJob;
  outcomeMap: TaskOutcomeMetaMap;
  nonFailureOutcomes: Set<string>;
}) {
  const { template, instance, status } = resolved;
  const agentName = instance?.agent_name ?? template.name ?? `Agent #${template.id}`;
  const summary = instance?.response;
  const lifecycleOptions = { nonFailureOutcomes };
  const lifecycle = instance ? getRunLifecycle(instance, lifecycleOptions) : null;
  const timelineSummary = instance ? getRunTimelineSummary(instance, lifecycleOptions) : null;
  const noteTone = lifecycle?.staleMissingStart ? 'text-red-300' : 'text-orange-300';

  return (
    <Link href={`/agents/${template.id}`}>
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 hover:border-slate-500 transition-colors cursor-pointer">
        <p className="text-sm font-semibold text-white truncate mb-0.5">{template.name}</p>
        <p className="text-xs text-slate-500 mb-2">{agentName}</p>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          {/* Execution status */}
          <Badge variant={status === 'idle' ? 'idle' : status}>{STATUS_LABELS[status]}</Badge>
          {/* Task outcome — shown when present so operators see the workflow result at a glance */}
          {lifecycle?.taskOutcome && (
            <Badge variant={getTaskOutcomeBadgeVariant(lifecycle.taskOutcome, outcomeMap) as any}>
              {getTaskOutcomeLabel(lifecycle.taskOutcome, outcomeMap)}
            </Badge>
          )}
          <span className="text-xs text-slate-600 text-right">
            {timelineSummary ?? 'Never run'}
          </span>
        </div>

        {lifecycle && (
          <div className="mt-2 space-y-1">
            <div className="grid grid-cols-3 gap-x-2 gap-y-1 text-[11px] text-slate-500">
              <span className="truncate">Accepted: {lifecycle.dispatchedAt ? timeAgo(lifecycle.dispatchedAt) : '—'}</span>
              <span className="truncate">S: {lifecycle.startedAt ? timeAgo(lifecycle.startedAt) : '?'}</span>
              <span className="truncate">✓: {lifecycle.completedAt ? timeAgo(lifecycle.completedAt) : '—'}</span>
            </div>
            {lifecycle.note && (
              <p className={`text-xs ${noteTone}`}>{lifecycle.note}</p>
            )}
          </div>
        )}

        {summary && status !== 'failed' && !lifecycle?.note && (
          <p className="text-xs text-slate-400 mt-2 truncate">{summary}</p>
        )}
        {instance?.error && status === 'failed' && !lifecycle?.taskOutcome && (
          <p className="text-xs text-red-400 mt-2 truncate">{instance.error}</p>
        )}
      </div>
    </Link>
  );
}

export default function KanbanBoard({ templates, instances, viewMode, agents = [] }: KanbanBoardProps) {
  const { outcomeMap, nonFailureOutcomes } = useWorkflowMetadata();
  const resolvedJobs = templates.map(t => resolveJobStatus(t, instances, nonFailureOutcomes));

  if (viewMode === 'status') {
    return (
      <div className="overflow-x-auto pb-4">
        <div className="flex gap-4" style={{ minWidth: 'max-content' }}>
          {STATUS_COLS.map(status => {
            const cols = resolvedJobs.filter(j => j.status === status);
            if (status === 'idle' && cols.length === 0) return null;
            return (
              <div key={status} className={`min-w-[240px] flex-shrink-0 border-t-2 ${COL_COLORS[status]} pt-3`}>
                <div className="flex items-center gap-2 mb-3 px-1">
                  <Badge variant={status === 'idle' ? 'idle' : status}>{STATUS_LABELS[status]}</Badge>
                  <span className="text-slate-500 text-xs ml-auto">{cols.length}</span>
                </div>
                <div className="space-y-2">
                  {cols.map(resolved => (
                    <JobCard key={resolved.template.id} resolved={resolved} outcomeMap={outcomeMap} nonFailureOutcomes={nonFailureOutcomes} />
                  ))}
                  {cols.length === 0 && (
                    <p className="text-slate-700 text-xs px-1 py-4 text-center">Empty</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (agents.length === 0) return <p className="text-slate-500">No agents found</p>;

  return (
    <div className="overflow-x-auto pb-4">
      <div className="flex gap-4" style={{ minWidth: 'max-content' }}>
        {agents.map(agent => {
          const agentJobs = resolvedJobs.filter(j => j.template.id === agent.id);
          return (
            <div key={agent.id} className="min-w-[240px] flex-shrink-0 border-t-2 border-amber-600 pt-3">
              <div className="flex items-center gap-2 mb-3 px-1">
                <span className="text-sm font-medium text-white truncate">{agent.name}</span>
                <span className="text-slate-500 text-xs ml-auto">{agentJobs.length}</span>
              </div>
              <div className="space-y-2">
                {agentJobs.map(resolved => (
                  <JobCard key={resolved.template.id} resolved={resolved} outcomeMap={outcomeMap} nonFailureOutcomes={nonFailureOutcomes} />
                ))}
                {agentJobs.length === 0 && (
                  <p className="text-slate-700 text-xs px-1 py-4 text-center">No jobs</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
