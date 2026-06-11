'use client';
import { formatDateTime, formatDate, formatTime, timeAgo } from '@/lib/date';

import { useEffect, useMemo, useState } from 'react';
import { api, DashboardStats, CompletedRecentTask, JobInstance, Project } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bot, Briefcase, CheckCircle2, XCircle, Clock, Activity, Coins, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { getTaskOutcomeBadgeClass, getTaskOutcomeMeta, TaskOutcomeMetaMap } from '@/lib/taskOutcomeMeta';
import { useWorkflowMetadata } from '@/lib/useWorkflowMetadata';
import { useProjectFilterPreference } from '@/lib/projectFilterPreference';

function StatCard({
  label,
  value,
  icon: Icon,
  color = 'text-slate-300',
  subtext,
}: {
  label: string;
  value: number | string;
  icon: React.ElementType;
  color?: string;
  subtext?: string;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-slate-400 text-sm mb-1">{label}</p>
          <p className={`text-3xl font-bold ${color}`}>{value}</p>
          {subtext && <p className="text-slate-500 text-xs mt-1">{subtext}</p>}
        </div>
        <div className="p-2 bg-slate-700/50 rounded-lg">
          <Icon className={`w-5 h-5 ${color}`} />
        </div>
      </div>
    </Card>
  );
}

function CompletedTaskRow({ task, outcomeMap }: { task: CompletedRecentTask; outcomeMap: TaskOutcomeMetaMap }) {
  const completionTime = task.live_verified_at ?? task.completed_at ?? task.updated_at;
  const outcome = task.outcome ?? null;
  const agentDisplay = task.agent_name ?? task.live_verified_by ?? '—';
  const outcomeMeta = outcome ? getTaskOutcomeMeta(outcome, outcomeMap) : null;

  return (
    <div className="flex items-center justify-between py-3 border-b border-slate-700/50 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white truncate">{task.title}</p>
        <p className="text-xs text-slate-500">
          {agentDisplay}
          {task.project_name ? ` · ${task.project_name}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-3 ml-4">
        {outcome && outcomeMeta && (
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${getTaskOutcomeBadgeClass(outcome, outcomeMap)}`}>
            {outcomeMeta.label}
          </span>
        )}
        <span className="text-xs text-slate-500 whitespace-nowrap">
          {timeAgo(completionTime)}
        </span>
        <Link href={`/tasks?id=${task.id}`} className="text-xs text-amber-400 hover:underline whitespace-nowrap">
          View
        </Link>
      </div>
    </div>
  );
}

function FailedJobRow({ instance }: { instance: JobInstance }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-slate-700/50 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white truncate">{instance.job_title ?? `Agent run #${instance.template_id}`}</p>
        <p className="text-xs text-slate-500">{instance.agent_name ?? `Agent #${instance.agent_id}`}</p>
      </div>
      <div className="flex items-center gap-3 ml-4">
        <Badge variant="failed">failed</Badge>
        <span className="text-xs text-slate-500">
          {formatTime(instance.created_at)}
        </span>
        <Link href={`/chat?agentId=${instance.agent_id}&instanceId=${instance.id}`} className="text-xs text-amber-400 hover:underline">
          View
        </Link>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [completedRecent, setCompletedRecent] = useState<CompletedRecentTask[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const validProjectIds = useMemo(() => projects.map(project => project.id), [projects]);
  const [selectedProjectId, setSelectedProjectId] = useProjectFilterPreference({ validProjectIds });
  const selectedProject = useMemo(
    () => projects.find(project => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState<string | null>(null);
  const { outcomeMap } = useWorkflowMetadata();

  useEffect(() => {
    try {
      const name = localStorage.getItem('agent-hq-user-name');
      if (name && name.trim()) setUserName(name.trim());
    } catch {}
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.getProjects(),
      api.getStats(selectedProjectId),
      api.getCompletedRecent(24, selectedProjectId),
    ])
      .then(([projectList, s, cr]) => {
        setProjects(projectList);
        setStats(s);
        setCompletedRecent(cr.tasks);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [selectedProjectId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">
        <p className="font-semibold mb-1">Could not load dashboard</p>
        <p className="text-sm">{error}</p>
        <p className="text-xs mt-2 text-red-400">Make sure the API is reachable and the UI is pointed at the correct API base.</p>
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">
            {userName ? `Welcome back, ${userName}` : 'Dashboard'}
          </h1>
          <p className="text-slate-400 text-sm mt-1">Agent HQ — Agent Control Center</p>
          <p className="mt-2 text-xs text-slate-500">
            {selectedProject ? `Showing dashboard metrics for ${selectedProject.name}.` : 'Showing cross-project dashboard metrics.'}
          </p>
        </div>
        <label className="w-full space-y-1.5 lg:w-72">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Project scope</span>
          <div className="relative">
            <select
              value={selectedProjectId ?? ''}
              onChange={event => setSelectedProjectId(event.target.value ? Number(event.target.value) : null)}
              className="w-full appearance-none rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2.5 pr-9 text-sm text-slate-200 outline-none transition-colors focus:border-amber-500"
            >
              <option value="">All Projects</option>
              {projects.map(project => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-slate-500" />
          </div>
        </label>
      </div>

      {/* Empty board tip */}
      {stats.activeJobs === 0 && stats.recentRuns === 0 && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-5 flex items-center gap-3">
          <div className="p-2 bg-amber-400/10 rounded-lg">
            <Activity className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <p className="text-sm text-white font-medium">No active tasks</p>
            <p className="text-xs text-slate-400 mt-0.5">
              Head to the{' '}
              <Link href="/tasks" className="text-amber-400 hover:underline">Tasks Board</Link>
              {' '}to create one and get started.
            </p>
          </div>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4" data-tour-target="dashboard-overview">
        <StatCard
          label="Total Agents"
          value={stats.totalAgents}
          icon={Bot}
          color="text-blue-400"
        />
        <StatCard
          label="Active Runs"
          value={stats.activeJobs}
          icon={Activity}
          color="text-amber-400"
          subtext="queued + running"
        />
        <StatCard
          label="Enabled Templates"
          value={stats.enabledTemplates}
          icon={Briefcase}
          color="text-violet-400"
        />
        <StatCard
          label="Runs Today"
          value={stats.recentRuns}
          icon={Clock}
          color="text-slate-300"
          subtext="last 24 hours"
        />
        <StatCard
          label="Completed Today"
          value={stats.doneRecent}
          icon={CheckCircle2}
          color="text-green-400"
          subtext="last 24 hours"
        />
        <StatCard
          label="Tokens Last 24h"
          value={stats.tokensLast24h.toLocaleString()}
          icon={Coins}
          color="text-cyan-400"
          subtext="sum of tracked agent-run tokens"
        />
        <StatCard
          label="Failed Today"
          value={stats.failedRecent}
          icon={XCircle}
          color={stats.failedRecent > 0 ? 'text-red-400' : 'text-slate-500'}
          subtext="last 24 hours"
        />
      </div>

      {/* Failed runs */}
      {stats.failedRecent > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <XCircle className="w-4 h-4 text-red-400" />
            <h2 className="text-sm font-semibold text-white">Recent Failures (24h)</h2>
          </div>
          <div>
            {stats.recentFailed.map(instance => (
              <FailedJobRow key={instance.id} instance={instance} />
            ))}
          </div>
        </Card>
      )}

      {/* Completed tasks in last 24h */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          <h2 className="text-sm font-semibold text-white">Completed in the Last 24 Hours</h2>
          {completedRecent.length > 0 && (
            <span className="ml-auto text-xs text-slate-500">{completedRecent.length} task{completedRecent.length !== 1 ? 's' : ''}</span>
          )}
        </div>
        {completedRecent.length === 0 ? (
          <p className="text-sm text-slate-500">No tasks completed in the last 24 hours.</p>
        ) : (
          <div>
            {completedRecent.map(task => (
              <CompletedTaskRow key={task.id} task={task} outcomeMap={outcomeMap} />
            ))}
          </div>
        )}
      </Card>

      {/* Quick links */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { href: '/agents', label: 'Manage Agents', desc: 'Register + edit agents' },
          { href: '/tasks', label: 'Tasks Board', desc: 'Plan + track work' },
          { href: '/capabilities', label: 'Capabilities', desc: 'Skills + tools' },
          { href: '/settings/logs', label: 'Execution Logs', desc: 'Debug + audit' },
        ].map(({ href, label, desc }) => (
          <Link key={href} href={href}>
            <Card className="hover:border-slate-600 hover:bg-slate-800 transition-colors cursor-pointer h-full">
              <p className="font-medium text-white text-sm">{label}</p>
              <p className="text-slate-500 text-xs mt-1">{desc}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
