'use client';
import { formatDateTime, formatDate, formatTime, timeAgo } from '@/lib/date';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLiveRefresh } from '@/lib/useLiveRefresh';
import {
  api, Sprint, SprintMetrics, SprintType, Task,
} from '@/lib/api';
import { formatSprintLabel, formatSprintNumber, formatWorkflowTerminology } from '@/lib/sprintLabel';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Rocket, Target, Calendar, CheckCircle2, ArrowLeft, Edit2, PauseCircle, PlayCircle,
  X, Check, ChevronDown, Trash2, Archive,
  BarChart3, ClipboardList, Activity, Files,
} from 'lucide-react';
import Link from 'next/link';
import { getApiBase } from '@/lib/api';
import { TaskDetailPanel } from '@/features/tasks/TaskDetailPanel';
import { useTaskStatuses } from '@/lib/useTaskStatuses';
import ProjectFiles from '@/components/ProjectFiles';
import { WorkflowTeamCard } from '@/components/WorkflowTeamCard';

type Tab = 'overview' | 'tasks' | 'files' | 'metrics';

const STATUS_BADGE: Record<Sprint['status'], string> = {
  planning: 'bg-slate-700 text-slate-300',
  active: 'bg-green-900/60 text-green-300',
  paused: 'bg-amber-900/60 text-amber-300',
  complete: 'bg-blue-900/60 text-blue-300',
  closed: 'bg-slate-800 text-slate-500',
};



function formatDuration(ms: number): string {
  if (ms <= 0) return '-';
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${Math.floor((ms % 3600000) / 60000)}m`;
  return `${Math.floor(ms / 60000)}m`;
}

function formatSprintTypeLabel(sprintType: string | null | undefined): string | null {
  if (!sprintType) return null;
  return sprintType
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ── Overview Tab ──────────────────────────────────────────────────────────────

function OverviewTab({ sprint, metrics }: { sprint: Sprint; metrics: SprintMetrics | null }) {
  if (!metrics) return <div className="text-slate-500 text-sm">Loading metrics…</div>;

  const pct = metrics.completion_rate;

  return (
    <div className="space-y-6">
      <WorkflowTeamCard workflowId={sprint.id} teamId={sprint.team_id ?? null} />

      {/* Progress */}
      <Card>
        <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3">Task Progress</h3>
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="text-white">{metrics.tasks_done} / {metrics.tasks_total} tasks done · {metrics.done_story_points} / {metrics.total_story_points} pts</span>
          <span className="text-amber-400 font-semibold">{pct}%</span>
        </div>
        <div className="h-2.5 bg-slate-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-amber-400 rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </Card>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard label="Completion Rate" value={`${metrics.completion_rate}%`} color="text-amber-400" />
        <StatCard label="Total Story Points" value={String(metrics.total_story_points)} color="text-cyan-300" />
        <StatCard label="Done Story Points" value={String(metrics.done_story_points)} color="text-green-400" />
        <StatCard label="Remaining Story Points" value={String(metrics.remaining_story_points)} color={metrics.remaining_story_points > 0 ? 'text-amber-300' : 'text-slate-300'} />
        <StatCard label="Agent Success Rate" value={`${metrics.success_rate}%`} color="text-green-400" />
        <StatCard label="Blockers" value={String(metrics.blocker_count)} color={metrics.blocker_count > 0 ? 'text-orange-400' : 'text-slate-300'} />
        <StatCard label="Total Agent Runs" value={String(metrics.job_runs_total)} color="text-slate-300" />
        <StatCard label="Failed Runs" value={String(metrics.job_runs_failed)} color={metrics.job_runs_failed > 0 ? 'text-red-400' : 'text-slate-300'} />
        <StatCard label="Avg Task Duration" value={formatDuration(metrics.avg_task_duration_ms)} color="text-slate-300" />
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <Card>
      <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
    </Card>
  );
}


// ── Tasks Tab (Kanban) ────────────────────────────────────────────────────────

import { TaskBoard } from '@/features/tasks/TaskBoard';

function TasksTab({ sprint, tasks, onRefresh }: { sprint: Sprint; tasks: Task[]; onRefresh: () => void }) {
  const base = getApiBase();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const { statuses: taskStatusCatalog } = useTaskStatuses(sprint.id);

  const handleLinkTask = async (taskId: number, targetTaskId: number, relationshipTypeKey: string) => {
    await api.createTaskRelationship(taskId, {
      target_task_id: targetTaskId,
      relationship_type_key: relationshipTypeKey,
      created_by: 'prism-frontend',
    });
    onRefresh();
  };

  const handleRemoveBlocker = async (taskId: number, blockerId: number) => {
    await fetch(`${base}/api/v1/tasks/${taskId}/blockers/${blockerId}`, { method: 'DELETE' });
    onRefresh();
  };

  const handleCancel = async (taskId: number) => {
    const reason = window.prompt('Stop reason (optional):') ?? undefined;
    if (reason === null) return;
    const result = await api.stopTask(taskId, reason || undefined);
    if (selectedTask?.id === taskId) setSelectedTask(result.task as any);
    onRefresh();
  };

  const handleTaskPause = async (taskId: number, reason?: string) => {
    const result = await api.pauseTask(taskId, reason);
    if (selectedTask?.id === taskId) setSelectedTask(result.task as any);
    onRefresh();
  };

  const handleTaskUnpause = async (taskId: number) => {
    const result = await api.unpauseTask(taskId);
    if (selectedTask?.id === taskId) setSelectedTask(result.task as any);
    onRefresh();
  };

  const handleStatusChange = async (taskId: number, newStatus: string) => {
    const res = await fetch(`${base}/api/v1/tasks/${taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus, changed_by: 'User' }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Status update failed (${res.status})`);
    }
    onRefresh();
  };

  const handlePanelSave = async (data: Partial<Task> & { recurring: number }) => {
    if (!selectedTask) return;
    await fetch(`${base}/api/v1/tasks/${selectedTask.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, changed_by: 'User' }),
    });
    setSelectedTask(null);
    onRefresh();
  };

  const handlePanelDelete = async () => {
    if (!selectedTask) return;
    await fetch(`${base}/api/v1/tasks/${selectedTask.id}`, { method: 'DELETE' });
    setSelectedTask(null);
    onRefresh();
  };

  return (
    <>
      <TaskBoard
        tasks={tasks}
        storageKey="sprint-tasks-visible-cols"
        sprintId={sprint.id}
        onTaskClick={task => setSelectedTask(task as Task)}
        onLinkTask={handleLinkTask}
        onRemoveBlocker={handleRemoveBlocker}
        onPause={handleTaskPause}
        onStatusChange={handleStatusChange}
      />

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          statuses={taskStatusCatalog}
          onClose={() => setSelectedTask(null)}
          onSave={handlePanelSave}
          onDelete={handlePanelDelete}
          onCancel={() => handleCancel(selectedTask.id)}
          onPause={(reason) => handleTaskPause(selectedTask.id, reason)}
          onUnpause={() => handleTaskUnpause(selectedTask.id)}
        />
      )}
    </>
  );
}

// ── Metrics Tab ───────────────────────────────────────────────────────────────

function MetricsTab({ metrics }: { metrics: SprintMetrics | null }) {
  if (!metrics) return <div className="text-slate-500 text-sm">Loading metrics…</div>;

  const stats = [
    { label: 'Tasks Total', value: String(metrics.tasks_total) },
    { label: 'Tasks Done', value: String(metrics.tasks_done), color: 'text-green-400' },
    { label: 'Completion Rate', value: `${metrics.completion_rate}%`, color: 'text-amber-400' },
    { label: 'Agent Runs Total', value: String(metrics.job_runs_total) },
    { label: 'Successful Runs', value: String(metrics.job_runs_success), color: 'text-green-400' },
    { label: 'Failed Runs', value: String(metrics.job_runs_failed), color: metrics.job_runs_failed > 0 ? 'text-red-400' : undefined },
    { label: 'Success Rate', value: `${metrics.success_rate}%`, color: 'text-amber-400' },
    { label: 'Active Blockers', value: String(metrics.blocker_count), color: metrics.blocker_count > 0 ? 'text-orange-400' : undefined },
    { label: 'Avg Task Duration', value: formatDuration(metrics.avg_task_duration_ms) },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      {stats.map(s => (
        <Card key={s.label}>
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">{s.label}</p>
          <p className={`text-2xl font-bold ${s.color ?? 'text-slate-300'}`}>{s.value}</p>
        </Card>
      ))}
    </div>
  );
}

// ── Edit Form ─────────────────────────────────────────────────────────────────

function EditForm({ sprint, onSave, onCancel }: {
  sprint: Sprint;
  onSave: (data: Partial<Sprint>) => Promise<void>;
  onCancel: () => void;
}) {
  const [sprintTypes, setSprintTypes] = useState<SprintType[]>([]);
  const [form, setForm] = useState({
    name: sprint.name,
    goal: sprint.goal,
    sprint_type: sprint.sprint_type,
    status: sprint.status,
    length_kind: sprint.length_kind,
    length_value: sprint.length_value,
    started_at: sprint.started_at ?? '',
    repo_access_mode: sprint.repo_access_mode ?? '',
    repo_path: sprint.repo_path ?? '',
    repo_url: sprint.repo_url ?? '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    api.getSprintTypes()
      .then((types) => {
        setSprintTypes(types);
      })
      .catch(() => {
        setSprintTypes([]);
      });
  }, []);

  const selectedSprintType = sprintTypes.find(type => type.key === form.sprint_type) ?? null;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        name: form.name,
        goal: form.goal,
        sprint_type: form.sprint_type,
        status: form.status as Sprint['status'],
        length_kind: form.length_kind as Sprint['length_kind'],
        length_value: form.length_value,
        started_at: form.started_at || null,
        repo_access_mode: (form.repo_access_mode || null) as Sprint['repo_access_mode'],
        repo_path: form.repo_access_mode === 'worktree' ? (form.repo_path.trim() || null) : null,
        repo_url: form.repo_access_mode === 'clone' ? (form.repo_url.trim() || null) : null,
      });
    } finally { setSaving(false); }
  };

  return (
    <Card className="border-amber-500/30">
      <h3 className="font-semibold text-white mb-4">Edit Workflow</h3>
      <div className="space-y-4">
        <div>
          <label className="text-xs text-slate-400 block mb-1">Name</label>
          <input className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400"
            value={form.name} onChange={e => set('name', e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">Goal</label>
          <textarea className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400 resize-none h-20"
            value={form.goal} onChange={e => set('goal', e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">Workflow Type</label>
          <select className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400"
            value={form.sprint_type} onChange={e => set('sprint_type', e.target.value)}>
            {sprintTypes.map(type => (
              <option key={type.key} value={type.key}>{type.name}</option>
            ))}
          </select>
          <p className="text-xs text-slate-500 mt-1">
            Workflow type controls workflow behavior and task-field rules for this workflow, not the project type.
            {selectedSprintType ? ` ${formatWorkflowTerminology(selectedSprintType.description)}` : ''}
          </p>
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">Repository Access Mode</label>
          <select className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400"
            value={form.repo_access_mode} onChange={e => set('repo_access_mode', e.target.value)}>
            <option value="">No workflow repo configured</option>
            <option value="worktree">Worktree</option>
            <option value="clone">Clone</option>
          </select>
          <p className="text-xs text-slate-500 mt-1">Workflow repository settings decide which codebase dispatched agents use.</p>
        </div>
        {form.repo_access_mode === 'worktree' && (
          <div>
            <label className="text-xs text-slate-400 block mb-1">Repo Path</label>
            <input className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-amber-400"
              value={form.repo_path} onChange={e => set('repo_path', e.target.value)} placeholder="/Users/nordini/agent-hq-public-prep" />
          </div>
        )}
        {form.repo_access_mode === 'clone' && (
          <div>
            <label className="text-xs text-slate-400 block mb-1">Repo URL</label>
            <input className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-amber-400"
              value={form.repo_url} onChange={e => set('repo_url', e.target.value)} placeholder="git@github.com:owner/repo.git" />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400 block mb-1">Status</label>
            <select className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400"
              value={form.status} onChange={e => set('status', e.target.value)}>
              <option value="planning">Planning</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="complete">Complete</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Length</label>
            <div className="flex gap-2">
              <select className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-2 py-2 text-white text-sm focus:outline-none focus:border-amber-400"
                value={form.length_kind} onChange={e => set('length_kind', e.target.value)}>
                <option value="time">Time</option>
                <option value="runs">Runs</option>
              </select>
              <input className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-2 py-2 text-white text-sm focus:outline-none focus:border-amber-400"
                value={form.length_value} onChange={e => set('length_value', e.target.value)} placeholder="2w" />
            </div>
          </div>
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">Started At</label>
          <input type="datetime-local" className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-400"
            value={form.started_at} onChange={e => set('started_at', e.target.value)} />
        </div>
      </div>
      <div className="flex gap-2 mt-4">
        <Button variant="primary" onClick={handleSave} loading={saving}>
          <Check className="w-3.5 h-3.5" /> Save
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          <X className="w-3.5 h-3.5" /> Cancel
        </Button>
      </div>
    </Card>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SprintDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = Number(params.id);

  const [sprint, setSprint] = useState<Sprint | null>(null);
  const [metrics, setMetrics] = useState<SprintMetrics | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = getApiBase();

  const load = useCallback(async () => {
    try {
      setError(null);
      const s = await api.getSprint(id);
      const [m, t] = await Promise.all([
        api.getSprintMetrics(id),
        fetch(`${base}/api/v1/tasks?sprint_id=${id}`).then(r => r.json()),
      ]);
      setSprint(s);
      setMetrics(m);
      setTasks(t as Task[]);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [id, base]);

  useEffect(() => { load(); }, [load]);

  // Live polling - silently refresh sprint data every 10s so agent/system-driven changes appear automatically
  useLiveRefresh(load, {
    enabled: Boolean(id),
    intervalMs: 10000,
    hiddenIntervalMs: 30000,
  });

  const handleSave = async (data: Partial<Sprint>) => {
    await api.updateSprint(id, data);
    setEditing(false);
    await load();
  };

  const handleComplete = async () => {
    if (!confirm('Mark this workflow as complete? All agent runs will be paused.')) return;
    setCompleting(true);
    try {
      await api.completeSprint(id);
      await load();
    } catch (e) {
      alert(String(e));
    } finally {
      setCompleting(false);
    }
  };

  const handleClose = async () => {
    if (!confirm('Close this workflow? Closed workflows and their tasks will be hidden from the main views and will not be auto-dispatched.')) return;
    setClosing(true);
    try {
      await api.closeSprint(id);
      await load();
    } catch (e) {
      alert(String(e));
    } finally {
      setClosing(false);
    }
  };

  const handlePause = async () => {
    try {
      await api.updateSprint(id, { status: 'paused' });
      await load();
    } catch (e) { alert(String(e)); }
  };

  const handleResume = async () => {
    try {
      await api.updateSprint(id, { status: 'active' });
      await load();
    } catch (e) { alert(String(e)); }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete workflow "${sprint?.name}"?`)) return;
    await api.deleteSprint(id);
    router.push('/workflows');
  };

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error || !sprint) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error ?? 'Workflow not found'}</div>
  );

  const pct = metrics ? metrics.completion_rate : 0;
  const total = metrics?.tasks_total ?? 0;
  const done = metrics?.tasks_done ?? 0;
  const sprintTypeLabel = formatSprintTypeLabel(sprint.sprint_type);

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'overview', label: 'Overview', icon: <Activity className="w-4 h-4" /> },
    { key: 'tasks', label: `Tasks (${tasks.length})`, icon: <ClipboardList className="w-4 h-4" /> },
    { key: 'files', label: 'Files', icon: <Files className="w-4 h-4" /> },
    { key: 'metrics', label: 'Metrics', icon: <BarChart3 className="w-4 h-4" /> },
  ];

  return (
    <div className={`flex flex-col ${tab === 'tasks' ? 'md:h-full md:overflow-hidden p-4 md:p-6' : 'space-y-6'}`}>
      {/* Breadcrumb */}
      <div className={`flex items-center gap-2 text-sm text-slate-500 ${tab === 'tasks' ? 'mb-4 flex-shrink-0' : ''}`}>
        <Link href="/workflows" className="hover:text-white transition-colors flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Workflows
        </Link>
        <span>/</span>
        <span className="text-slate-300">{formatSprintLabel(sprint)}</span>
      </div>

      {/* Header */}
      <div className={tab === 'tasks' ? 'flex-shrink-0 mb-4' : ''}>
      {editing ? (
        <EditForm sprint={sprint} onSave={handleSave} onCancel={() => setEditing(false)} />
      ) : (
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3 flex-wrap">
                <Rocket className="w-6 h-6 text-amber-400 shrink-0" />
                <h1 className="text-xl font-bold text-white">{formatSprintLabel(sprint)}</h1>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[sprint.status]}`}>
                  {sprint.status}
                </span>
                {sprint.project_name && (
                  <Badge variant="workspace">{sprint.project_name}</Badge>
                )}
                {sprintTypeLabel && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-cyan-900/60 text-cyan-300">
                    {sprintTypeLabel}
                  </span>
                )}
              </div>

              {sprint.goal && (
                <p className="text-slate-400 text-sm mt-2 flex items-start gap-2">
                  <Target className="w-4 h-4 shrink-0 text-slate-500 mt-0.5" />
                  {sprint.goal}
                </p>
              )}

              <div className="flex items-center gap-4 mt-3 text-xs text-slate-500 flex-wrap">
                <span>{formatSprintNumber(sprint.id)}</span>
                {sprint.project_name && (
                  <span>Project: {sprint.project_name}</span>
                )}
                {sprintTypeLabel && (
                  <span>Workflow Type: {sprintTypeLabel}</span>
                )}
                {sprint.repo_access_mode === 'worktree' && sprint.repo_path && (
                  <span className="font-mono text-emerald-300 break-all">Repo: {sprint.repo_path}</span>
                )}
                {sprint.repo_access_mode === 'clone' && sprint.repo_url && (
                  <span className="font-mono text-cyan-300 break-all">Repo: {sprint.repo_url}</span>
                )}
                <span>Status: {sprint.status}</span>
                {sprint.length_value && (
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5" />
                    {sprint.length_kind === 'time' ? sprint.length_value : `${sprint.length_value} runs`}
                  </span>
                )}
                {sprint.started_at && (
                  <span>Started: {formatDate(sprint.started_at)}</span>
                )}
                {sprint.ended_at && (
                  <span>Ended: {formatDate(sprint.ended_at)}</span>
                )}
                <span>{done} / {total} tasks · {pct}%</span>
              </div>

              {/* Mini progress */}
              <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden mt-3">
                <div className="h-full bg-amber-400 rounded-full" style={{ width: `${pct}%` }} />
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap justify-end shrink-0">
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                <Edit2 className="w-3.5 h-3.5" />
              </Button>
              {sprint.status === 'active' && (
                <Button variant="secondary" size="sm" onClick={handlePause}>
                  <PauseCircle className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Pause</span>
                </Button>
              )}
              {sprint.status === 'paused' && (
                <Button variant="secondary" size="sm" onClick={handleResume}>
                  <PlayCircle className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Resume</span>
                </Button>
              )}
              {sprint.status !== 'complete' && sprint.status !== 'closed' && (
                <Button variant="secondary" size="sm" onClick={handleComplete} loading={completing}>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Complete</span>
                </Button>
              )}
              {sprint.status !== 'closed' && (
                <Button variant="secondary" size="sm" onClick={handleClose} loading={closing} className="text-slate-400 hover:text-slate-200">
                  <Archive className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Close Workflow</span>
                </Button>
              )}
              {sprint.status === 'closed' && (
                <span className="flex items-center gap-1.5 text-xs text-slate-500 px-2 py-1 bg-slate-800 rounded-lg border border-slate-700">
                  <Archive className="w-3.5 h-3.5" />
                  Closed
                </span>
              )}
              <Button variant="danger" size="sm" onClick={handleDelete}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </Card>
      )}
      </div>

      {/* Tabs - scrollable on mobile */}
      <div className={`border-b border-slate-800 overflow-x-auto scrollbar-none ${tab === 'tasks' ? 'flex-shrink-0 mb-4' : ''}`}>
        <nav className="flex gap-1 min-w-max">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${
                tab === t.key
                  ? 'border-amber-400 text-amber-400'
                  : 'border-transparent text-slate-400 hover:text-white'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div className={tab === 'tasks' ? 'md:flex-1 md:min-h-0 flex flex-col md:overflow-hidden' : ''}>
        {tab === 'overview' && <OverviewTab sprint={sprint} metrics={metrics} />}
        {tab === 'tasks' && <TasksTab sprint={sprint} tasks={tasks} onRefresh={load} />}
        {tab === 'files' && <ProjectFiles projectId={sprint.project_id} workflowId={sprint.id} scope="workflow" />}
        {tab === 'metrics' && <MetricsTab metrics={metrics} />}
      </div>
    </div>
  );
}
