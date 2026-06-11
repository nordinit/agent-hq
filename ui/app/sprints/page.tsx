'use client';
import { formatDateTime, formatDate, formatTime, timeAgo } from '@/lib/date';

import { useEffect, useMemo, useState } from 'react';
import { api, Sprint, Project } from '@/lib/api';
import { useProjectFilterPreference } from '@/lib/projectFilterPreference';
import { formatSprintLabel, formatSprintNumber } from '@/lib/sprintLabel';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Rocket, Plus, Trash2, Target, Calendar, ChevronDown, ChevronRight, Archive } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const STATUS_BADGE: Record<Sprint['status'], string> = {
  planning: 'bg-slate-700 text-slate-300',
  active: 'bg-green-900/60 text-green-300',
  paused: 'bg-amber-900/60 text-amber-300',
  complete: 'bg-blue-900/60 text-blue-300',
  closed: 'bg-slate-800 text-slate-500',
};

export default function SprintsPage() {
  const router = useRouter();
  const [activeSprints, setActiveSprints] = useState<Sprint[]>([]);
  const [closedSprints, setClosedSprints] = useState<Sprint[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const validProjectIds = useMemo(() => projects.map(project => project.id), [projects]);
  const [filterProject, setFilterProject] = useProjectFilterPreference({ validProjectIds });
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closedExpanded, setClosedExpanded] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      api.getSprints(filterProject ?? undefined, false),
      api.getSprints(filterProject ?? undefined, true),
      api.getProjects(),
    ])
      .then(([active, all, p]) => {
        setActiveSprints(active);
        setClosedSprints(all.filter(s => s.status === 'closed'));
        setProjects(p);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [filterProject]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDelete = async (id: number, name: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete workflow "${name}"?`)) return;
    try {
      await api.deleteSprint(id);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const sprintStatusOptions = useMemo(() => {
    const statuses = new Set<Sprint['status']>([...activeSprints, ...closedSprints].map(sprint => sprint.status));
    const ordered: Sprint['status'][] = ['active', 'planning', 'paused', 'complete', 'closed'];
    return ordered.filter(status => statuses.has(status));
  }, [activeSprints, closedSprints]);

  const visibleActiveSprints = useMemo(() => {
    if (filterStatus === 'all') return activeSprints;
    return activeSprints.filter(sprint => sprint.status === filterStatus);
  }, [activeSprints, filterStatus]);

  const visibleClosedSprints = useMemo(() => {
    if (filterStatus === 'all') return closedSprints;
    return closedSprints.filter(sprint => sprint.status === filterStatus);
  }, [closedSprints, filterStatus]);

  // Group by project (visible active/planning/paused/etc workflows)
  const grouped = visibleActiveSprints.reduce<Record<string, Sprint[]>>((acc, s) => {
    const key = s.project_name ?? 'No Project';
    if (!acc[key]) acc[key] = [];
    acc[key].push(s);
    return acc;
  }, {});

  // Group visible closed/completed/etc workflows by project
  const groupedClosed = visibleClosedSprints.reduce<Record<string, Sprint[]>>((acc, s) => {
    const key = s.project_name ?? 'No Project';
    if (!acc[key]) acc[key] = [];
    acc[key].push(s);
    return acc;
  }, {});

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );

  const SprintCard = ({ sprint, dimmed = false }: { sprint: Sprint; dimmed?: boolean }) => {
    const total = sprint.task_count ?? 0;
    const done = sprint.tasks_done ?? 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    return (
      <Link href={`/workflows/${sprint.id}`}>
        <Card className={`hover:border-amber-500/40 transition-colors cursor-pointer h-full group ${dimmed ? 'opacity-60' : ''}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Rocket className={`w-4 h-4 shrink-0 ${dimmed ? 'text-slate-500' : 'text-amber-400'}`} />
              <h3 className="font-semibold text-white truncate group-hover:text-amber-300 transition-colors">
                {formatSprintLabel(sprint)}
              </h3>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[sprint.status]}`}>
                {sprint.status}
              </span>
              <button
                onClick={(e) => handleDelete(sprint.id, sprint.name, e)}
                className="p-1 rounded text-slate-600 hover:text-red-400 hover:bg-slate-700 transition-colors opacity-0 group-hover:opacity-100"
                title="Delete workflow"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {sprint.goal && (
            <p className="text-slate-400 text-sm mt-2 line-clamp-2 flex items-start gap-1.5">
              <Target className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
              {sprint.goal}
            </p>
          )}

          {/* Progress bar */}
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
              <span>{done} / {total} tasks · {sprint.done_story_points ?? 0} / {sprint.total_story_points ?? 0} pts</span>
              <span>{pct}%</span>
            </div>
            <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-amber-400 rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="px-2 py-1 rounded-full bg-cyan-900/50 text-cyan-300">{sprint.total_story_points ?? 0} total pts</span>
            <span className="px-2 py-1 rounded-full bg-green-900/50 text-green-300">{sprint.done_story_points ?? 0} done pts</span>
            <span className="px-2 py-1 rounded-full bg-amber-900/50 text-amber-300">{sprint.remaining_story_points ?? 0} remaining pts</span>
          </div>

          <div className="flex items-center gap-3 mt-3 text-xs text-slate-500">
            <span>{formatSprintNumber(sprint.id)}</span>
            {sprint.length_value && (
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                {sprint.length_kind === 'time' ? sprint.length_value : `${sprint.length_value} runs`}
              </span>
            )}
            {sprint.started_at && (
              <span>{formatDate(sprint.started_at)}</span>
            )}
            {sprint.ended_at && dimmed && (
              <span className="text-slate-600">Closed {formatDate(sprint.ended_at)}</span>
            )}
          </div>
        </Card>
      </Link>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Workflows</h1>
          <p className="text-slate-400 text-sm mt-1">{activeSprints.length} active workflow{activeSprints.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Project filter */}
          <div className="relative">
            <select
              className="appearance-none bg-slate-800 border border-slate-600 rounded-lg pl-3 pr-8 py-2 text-white text-sm focus:outline-none focus:border-amber-400"
              value={filterProject ?? ''}
              onChange={e => setFilterProject(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">All Projects</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
          </div>

          {/* Workflow status filter */}
          <div className="relative">
            <select
              className="appearance-none bg-slate-800 border border-slate-600 rounded-lg pl-3 pr-8 py-2 text-white text-sm focus:outline-none focus:border-amber-400"
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
            >
              <option value="all">All Statuses</option>
              {sprintStatusOptions.map(status => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
          </div>
          <Button variant="primary" onClick={() => router.push('/workflows/new')}>
            <Plus className="w-4 h-4" /> New Workflow
          </Button>
        </div>
      </div>

      <div data-tour-target="sprints-list">
      {visibleActiveSprints.length === 0 && visibleClosedSprints.length === 0 ? (
        <Card>
          <div className="text-center py-16 space-y-3">
            <Rocket className="w-12 h-12 text-slate-600 mx-auto" />
            <p className="text-slate-400 font-medium">No workflows yet</p>
            <p className="text-slate-500 text-sm">Create a workflow to group agents and tasks with a shared goal.</p>
            <Button variant="primary" onClick={() => router.push('/workflows/new')} className="mt-2">
              <Plus className="w-4 h-4" /> New Workflow
            </Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-8">
          {/* Active / paused / planning workflows */}
          {visibleActiveSprints.length === 0 ? (
            <Card>
              <div className="text-center py-10 space-y-2">
                <Rocket className="w-8 h-8 text-slate-600 mx-auto" />
                <p className="text-slate-400 font-medium">No active workflows</p>
                <Button variant="primary" onClick={() => router.push('/workflows/new')} className="mt-2">
                  <Plus className="w-4 h-4" /> New Workflow
                </Button>
              </div>
            </Card>
          ) : (
            Object.entries(grouped).map(([projectName, projectSprints]) => (
              <div key={projectName}>
                <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3 flex items-center gap-2">
                  <span>{projectName}</span>
                  <span className="text-slate-600">({projectSprints.length})</span>
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {projectSprints.map(sprint => (
                    <SprintCard key={sprint.id} sprint={sprint} />
                  ))}
                </div>
              </div>
            ))
          )}

          {/* Closed Workflows section (collapsible) */}
          {visibleClosedSprints.length > 0 && (
            <div>
              <button
                onClick={() => setClosedExpanded(v => !v)}
                className="flex items-center gap-2 text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3 hover:text-slate-300 transition-colors"
              >
                {closedExpanded ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
                <Archive className="w-4 h-4" />
                <span>Closed Workflows</span>
                <span className="text-slate-600">({closedSprints.length})</span>
              </button>

              {closedExpanded && (
                <div className="space-y-6">
                  {Object.entries(groupedClosed).map(([projectName, projectSprints]) => (
                    <div key={projectName}>
                      <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-3">{projectName}</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {projectSprints.map(sprint => (
                          <SprintCard key={sprint.id} sprint={sprint} dimmed />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
