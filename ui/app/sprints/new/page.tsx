'use client';

import { useEffect, useState } from 'react';
import { api, Project, Sprint, SprintType } from '@/lib/api';
import { formatWorkflowTerminology } from '@/lib/sprintLabel';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Rocket, ChevronDown, ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface FormState {
  project_id: string;
  name: string;
  goal: string;
  sprint_type: string;
  source_sprint_id: string;
  length_kind: 'time' | 'runs';
  length_value: string;
  started_at: string;
  status: 'planning' | 'active';
  repo_access_mode: '' | 'worktree' | 'clone';
  repo_path: string;
  repo_url: string;
}

const emptyForm: FormState = {
  project_id: '',
  name: '',
  goal: '',
  sprint_type: 'generic',
  source_sprint_id: '',
  length_kind: 'time',
  length_value: '2w',
  started_at: '',
  status: 'planning',
  repo_access_mode: '',
  repo_path: '',
  repo_url: '',
};

export default function NewSprintPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [sprintTypes, setSprintTypes] = useState<SprintType[]>([]);
  const [existingSprints, setExistingSprints] = useState<Sprint[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.getProjects(), api.getSprintTypes(), api.getSprints(undefined, true)])
      .then(([p, types, sprints]) => {
        setProjects(p);
        setSprintTypes(types);
        setExistingSprints(sprints);
        setForm(f => ({
          ...f,
          project_id: f.project_id || (p.length > 0 ? String(p[0].id) : ''),
          sprint_type: f.sprint_type || (types[0]?.key ?? 'generic'),
        }));
      })
      .catch(e => setError(String(e)));
  }, []);

  const selectedSprintType = sprintTypes.find(type => type.key === form.sprint_type) ?? null;
  const cloneableSprints = existingSprints.filter((sprint) => String(sprint.project_id) === form.project_id);
  const selectedSourceSprint = cloneableSprints.find((sprint) => String(sprint.id) === form.source_sprint_id) ?? null;
  const effectiveSprintType = selectedSourceSprint?.sprint_type ?? form.sprint_type;

  const set = (k: keyof FormState, v: string) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!form.source_sprint_id) return;
    if (selectedSourceSprint) return;
    setForm((current) => ({ ...current, source_sprint_id: '' }));
  }, [form.source_sprint_id, selectedSourceSprint]);

  const handleCreate = async () => {
    if (!form.project_id) { setError('Select a project'); return; }
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError(null);
    try {
      const created = await api.createSprint({
        project_id: Number(form.project_id),
        name: form.name.trim(),
        goal: form.goal.trim(),
        sprint_type: effectiveSprintType,
        source_sprint_id: form.source_sprint_id ? Number(form.source_sprint_id) : undefined,
        length_kind: form.length_kind,
        length_value: form.length_value.trim(),
        started_at: form.started_at || null,
        status: form.status,
        repo_access_mode: form.repo_access_mode || null,
        repo_path: form.repo_access_mode === 'worktree' ? (form.repo_path.trim() || null) : null,
        repo_url: form.repo_access_mode === 'clone' ? (form.repo_url.trim() || null) : null,
      });
      router.push(`/workflows/${created.id}`);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/workflows" className="text-slate-400 hover:text-white transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Rocket className="w-6 h-6 text-amber-400" />
            New Workflow
          </h1>
          <p className="text-slate-400 text-sm mt-0.5">Define a workflow to group agent tasks with a shared goal</p>
        </div>
      </div>

      <Card>
        <div className="space-y-5">
          {/* Project */}
          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Project *</label>
            <div className="relative">
              <select
                className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                value={form.project_id}
                onChange={e => set('project_id', e.target.value)}
              >
                <option value="">— Select project —</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <ChevronDown className="absolute right-2 top-3 w-4 h-4 text-slate-400 pointer-events-none" />
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Workflow Name *</label>
            <input
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="e.g. Workflow 1 - Market Maker Stabilization"
              autoFocus
            />
          </div>

          {/* Goal */}
          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Workflow Goal</label>
            <textarea
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400 resize-none h-24"
              value={form.goal}
              onChange={e => set('goal', e.target.value)}
              placeholder="What should agents accomplish during this workflow? This will be prepended to every agent task payload."
            />
            <p className="text-xs text-slate-500 mt-1">This goal is automatically injected into agent task payloads.</p>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Workflow Type</label>
            <div className="relative">
              <select
                className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                value={effectiveSprintType}
                onChange={e => set('sprint_type', e.target.value)}
                disabled={Boolean(selectedSourceSprint)}
              >
                {sprintTypes.map(type => <option key={type.key} value={type.key}>{type.name}</option>)}
              </select>
              <ChevronDown className="absolute right-2 top-3 w-4 h-4 text-slate-400 pointer-events-none" />
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Workflow type controls the task behavior and field schema used inside this workflow, not the project type.
              {selectedSourceSprint
                ? ' When cloning setup, the new workflow inherits the source workflow type and its workflow-type-backed definitions.'
                : ''}
              {(sprintTypes.find(type => type.key === effectiveSprintType) ?? selectedSprintType)?.description
                ? ` ${formatWorkflowTerminology((sprintTypes.find(type => type.key === effectiveSprintType) ?? selectedSprintType)?.description)}`
                : ''}
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Clone Workflow Setup</label>
            <div className="relative">
              <select
                className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                value={form.source_sprint_id}
                onChange={e => set('source_sprint_id', e.target.value)}
                disabled={!form.project_id}
              >
                <option value="">Start from this workflow type only</option>
                {cloneableSprints.map((sprint) => (
                  <option key={sprint.id} value={sprint.id}>
                    {sprint.name} ({sprint.status})
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-3 w-4 h-4 text-slate-400 pointer-events-none" />
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Clone workflow-scoped setup, assignment rules, and model routing from an existing workflow in this project. This copies configuration only, not tasks.
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Repository Access Mode</label>
            <div className="relative">
              <select
                className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                value={form.repo_access_mode}
                onChange={e => setForm(f => ({ ...f, repo_access_mode: e.target.value as FormState['repo_access_mode'] }))}
              >
                <option value="">No workflow repo configured</option>
                <option value="worktree">Worktree</option>
                <option value="clone">Clone</option>
              </select>
              <ChevronDown className="absolute right-2 top-3 w-4 h-4 text-slate-400 pointer-events-none" />
            </div>
            <p className="text-xs text-slate-500 mt-1">Workflow repository settings decide which codebase dispatched agents use.</p>
          </div>

          {form.repo_access_mode === 'worktree' && (
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Repo Path</label>
              <input
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-amber-400"
                value={form.repo_path}
                onChange={e => set('repo_path', e.target.value)}
                placeholder="/Users/nordini/agent-hq-public-prep"
              />
            </div>
          )}

          {form.repo_access_mode === 'clone' && (
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Repo URL</label>
              <input
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-amber-400"
                value={form.repo_url}
                onChange={e => set('repo_url', e.target.value)}
                placeholder="git@github.com:owner/repo.git"
              />
            </div>
          )}

          {/* Length */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Length Type</label>
              <div className="relative">
                <select
                  className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                  value={form.length_kind}
                  onChange={e => set('length_kind', e.target.value as 'time' | 'runs')}
                >
                  <option value="time">Time-based</option>
                  <option value="runs">Run-based</option>
                </select>
                <ChevronDown className="absolute right-2 top-3 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">
                {form.length_kind === 'time' ? 'Duration (e.g. 2w, 3d, 4h)' : 'Max Runs'}
              </label>
              <input
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400"
                value={form.length_value}
                onChange={e => set('length_value', e.target.value)}
                placeholder={form.length_kind === 'time' ? '2w' : '10'}
              />
              {form.length_kind === 'time' && (
                <p className="text-xs text-slate-500 mt-1">w=weeks, d=days, h=hours, m=minutes</p>
              )}
            </div>
          </div>

          {/* Status + Start Date */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Initial Status</label>
              <div className="relative">
                <select
                  className="w-full appearance-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400 pr-8"
                  value={form.status}
                  onChange={e => set('status', e.target.value as 'planning' | 'active')}
                >
                  <option value="planning">Planning</option>
                  <option value="active">Active (start now)</option>
                </select>
                <ChevronDown className="absolute right-2 top-3 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wide block mb-1.5">Start Date (optional)</label>
              <input
                type="datetime-local"
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-400"
                value={form.started_at}
                onChange={e => set('started_at', e.target.value)}
              />
            </div>
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="flex gap-3 pt-2">
            <Button variant="primary" onClick={handleCreate} loading={saving}>
              <Rocket className="w-4 h-4" /> Create Workflow
            </Button>
            <Button variant="ghost" onClick={() => router.push('/workflows')}>
              Cancel
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
