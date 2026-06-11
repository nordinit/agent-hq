'use client';
import { formatDateTime, formatDate, formatTime, timeAgo } from '@/lib/date';

import { useEffect, useState } from 'react';
import { api, Project, ProjectImportPreview } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertTriangle, FolderOpen, Plus, Trash2, Upload, X, Check, Briefcase, ChevronDown, Star } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DeleteProjectModal } from '@/components/DeleteProjectModal';

interface FormState {
  name: string;
  description: string;
  repo_path: string;
  repo_url: string;
  repo_access_mode: 'worktree' | 'clone' | '';
}

const emptyForm: FormState = { name: '', description: '', repo_path: '', repo_url: '', repo_access_mode: '' };

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);
  const [settingDefaultId, setSettingDefaultId] = useState<number | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importManifest, setImportManifest] = useState<unknown | null>(null);
  const [importPreview, setImportPreview] = useState<ProjectImportPreview | null>(null);
  const [importName, setImportName] = useState('');
  const [importFiles, setImportFiles] = useState(false);
  const [enableImportedAgents, setEnableImportedAgents] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importCountItems = importPreview ? [
    { key: 'agents', label: 'Agents', value: importPreview.counts.agents },
    { key: 'workflows', label: 'Workflows', value: importPreview.counts.workflows },
    { key: 'task_routing_rules', label: 'Assignment Rules', value: importPreview.counts.task_routing_rules ?? importPreview.counts.routing_rules },
    { key: 'workflow_transitions', label: 'Workflow Transitions', value: importPreview.counts.workflow_transitions ?? 0 },
    { key: 'transition_requirements', label: 'Transition Requirements', value: importPreview.counts.transition_requirements ?? 0 },
    { key: 'model_routing', label: 'Model Routing', value: importPreview.counts.model_routing ?? 0 },
    { key: 'workflow_event_mappings', label: 'Workflow Events', value: importPreview.counts.workflow_event_mappings ?? 0 },
    { key: 'recurring_templates', label: 'Recurring Templates', value: importPreview.counts.recurring_templates },
    { key: 'files', label: 'Files', value: importPreview.counts.files },
    { key: 'unresolved_dependencies', label: 'Unresolved Dependencies', value: importPreview.counts.unresolved_dependencies },
  ] : [];

  const load = () => {
    api.getProjects()
      .then(setProjects)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleCreate = async () => {
    if (!form.name.trim()) {
      setFormError('Name is required');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const created = await api.createProject({
        name: form.name.trim(),
        description: form.description.trim(),
        repo_path: form.repo_access_mode === 'worktree' ? (form.repo_path.trim() || null) : null,
        repo_url: form.repo_access_mode === 'clone' ? (form.repo_url.trim() || null) : null,
        repo_access_mode: form.repo_access_mode || null,
      });
      setShowForm(false);
      setForm(emptyForm);
      // Navigate to the new project
      router.push(`/projects/${created.id}`);
    } catch (e) {
      setFormError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClick = (id: number, name: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDeleteTarget({ id, name });
  };

  const handleDeleteConfirmed = () => {
    setDeleteTarget(null);
    load();
  };

  const handleSetDefault = async (projectId: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSettingDefaultId(projectId);
    try {
      await api.setDefaultProject(projectId);
      load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSettingDefaultId(null);
    }
  };

  const handleImportFile = async (file: File | null) => {
    if (!file) return;
    setImportError(null);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const preview = await api.previewProjectImport(parsed, { include_files: importFiles });
      setImportManifest(parsed);
      setImportPreview(preview);
      setImportName(preview.proposed_project_name);
    } catch (err) {
      setImportManifest(null);
      setImportPreview(null);
      setImportError(String(err));
    }
  };

  const refreshImportPreview = async (nextName = importName, nextFiles = importFiles) => {
    if (!importManifest) return;
    setImportError(null);
    try {
      const preview = await api.previewProjectImport(importManifest, { project_name: nextName, include_files: nextFiles });
      setImportPreview(preview);
      setImportName(preview.proposed_project_name);
    } catch (err) {
      setImportError(String(err));
    }
  };

  const handleConfirmImport = async () => {
    if (!importManifest || !importPreview?.valid) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await api.importProjectManifest(importManifest, {
        project_name: importName,
        include_files: importFiles,
        enable_agents: enableImportedAgents,
        activate_workflows: false,
      });
      router.push(`/projects/${result.project_id}`);
    } catch (err) {
      setImportError(String(err));
    } finally {
      setImporting(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Projects</h1>
          <p className="text-slate-400 text-sm mt-1">{projects.length} project{projects.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => { setShowImport(true); setImportError(null); }}>
            <Upload className="w-4 h-4" /> Import
          </Button>
          <Button variant="primary" onClick={() => { setShowForm(true); setForm(emptyForm); setFormError(null); }}>
            <Plus className="w-4 h-4" /> New Project
          </Button>
        </div>
      </div>

      {showImport && (
        <Card className="border-cyan-500/30">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-white">Import Project</h2>
              <p className="text-xs text-slate-500 mt-1">Preview a v1 manifest before creating a disabled-by-default project copy.</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setShowImport(false)}>
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
          <div className="mt-4 space-y-3">
            <input
              type="file"
              accept="application/json,.json"
              className="block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-700 file:px-3 file:py-2 file:text-sm file:text-slate-200 hover:file:bg-slate-600"
              onChange={(e) => handleImportFile(e.target.files?.[0] ?? null)}
            />
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={importFiles}
                onChange={(e) => {
                  setImportFiles(e.target.checked);
                  refreshImportPreview(importName, e.target.checked);
                }}
              />
              Include file payloads when present
            </label>
            {importPreview && (
              <div className="space-y-3">
                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">New Project Name</span>
                  <input
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                    value={importName}
                    onChange={e => setImportName(e.target.value)}
                    onBlur={() => refreshImportPreview(importName, importFiles)}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-5">
                  {importCountItems.map(({ key, label, value }) => (
                    <div key={key} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2">
                      <div className="text-slate-500">{label}</div>
                      <div className="text-lg font-semibold text-white">{value}</div>
                    </div>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={enableImportedAgents}
                    onChange={(e) => setEnableImportedAgents(e.target.checked)}
                  />
                  Enable imported agents immediately
                </label>
                {importPreview.warnings.length > 0 && (
                  <div className="max-h-36 overflow-auto rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
                    {importPreview.warnings.map((warning, index) => (
                      <div key={`${warning.code}-${index}`} className="flex gap-2 py-1">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>{warning.message}</span>
                      </div>
                    ))}
                  </div>
                )}
                <Button variant="primary" onClick={handleConfirmImport} loading={importing} disabled={!importPreview.valid || !importName.trim()}>
                  <Upload className="w-3.5 h-3.5" /> Create Imported Project
                </Button>
              </div>
            )}
            {importError && <p className="text-red-400 text-xs">{importError}</p>}
          </div>
        </Card>
      )}

      {/* Create Form */}
      {showForm && (
        <Card className="border-amber-500/30">
          <h2 className="font-semibold text-white mb-4">New Project</h2>
          <div className="space-y-3">
            <label className="block">
              <span className="text-slate-400 text-xs mb-1 block">Name *</span>
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="My Project"
                autoFocus
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
              />
            </label>
            <label className="block">
              <span className="text-slate-400 text-xs mb-1 block">Description</span>
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What is this project about?"
              />
            </label>
            <label className="block">
              <span className="text-slate-400 text-xs mb-1 block">Repository Access Mode</span>
              <div className="relative">
                <select
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 appearance-none pr-8"
                  value={form.repo_access_mode}
                  onChange={e => setForm(f => ({ ...f, repo_access_mode: e.target.value as FormState['repo_access_mode'] }))}
                >
                  <option value="">None</option>
                  <option value="worktree">Worktree</option>
                  <option value="clone">Clone</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              </div>
            </label>
            {form.repo_access_mode === 'worktree' && (
              <label className="block">
                <span className="text-slate-400 text-xs mb-1 block">Repo Path</span>
                <input
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 font-mono"
                  value={form.repo_path}
                  onChange={e => setForm(f => ({ ...f, repo_path: e.target.value }))}
                  placeholder="/Users/nordini/agent-hq"
                />
              </label>
            )}
            {form.repo_access_mode === 'clone' && (
              <label className="block">
                <span className="text-slate-400 text-xs mb-1 block">Repo URL</span>
                <input
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 font-mono"
                  value={form.repo_url}
                  onChange={e => setForm(f => ({ ...f, repo_url: e.target.value }))}
                  placeholder="git@github.com:owner/repo.git"
                />
              </label>
            )}
          </div>
          {formError && <p className="text-red-400 text-xs mt-2">{formError}</p>}
          <div className="flex gap-2 mt-4">
            <Button variant="primary" onClick={handleCreate} loading={saving}>
              <Check className="w-3.5 h-3.5" /> Create
            </Button>
            <Button variant="ghost" onClick={() => setShowForm(false)}>
              <X className="w-3.5 h-3.5" /> Cancel
            </Button>
          </div>
        </Card>
      )}

      {/* Delete Modal */}
      {deleteTarget && (
        <DeleteProjectModal
          projectId={deleteTarget.id}
          projectName={deleteTarget.name}
          onConfirm={handleDeleteConfirmed}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Projects Grid */}
      {projects.length === 0 && !showForm ? (
        <Card data-tour-target="projects-list">
          <div className="text-center py-16 space-y-3">
            <FolderOpen className="w-12 h-12 text-slate-600 mx-auto" />
            <p className="text-slate-400 font-medium">No projects yet</p>
            <p className="text-slate-500 text-sm">Create a project to group agents and share context across runs.</p>
            <Button variant="primary" onClick={() => setShowForm(true)} className="mt-2">
              <Plus className="w-4 h-4" /> New Project
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" data-tour-target="projects-list">
          {projects.map(project => (
            <Link key={project.id} href={`/projects/${project.id}`}>
              <Card className="hover:border-amber-500/40 transition-colors cursor-pointer h-full group">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <FolderOpen className="w-5 h-5 text-amber-400 shrink-0" />
                    <h3 className="font-semibold text-white truncate group-hover:text-amber-300 transition-colors">
                      {project.name}
                    </h3>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!project.is_default && (
                      <button
                        onClick={(e) => handleSetDefault(project.id, e)}
                        disabled={settingDefaultId === project.id}
                        className="p-1 rounded text-slate-500 hover:text-amber-300 hover:bg-slate-700 transition-colors disabled:opacity-50"
                        title="Make default project"
                      >
                        <Star className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={(e) => handleDeleteClick(project.id, project.name, e)}
                      className="p-1 rounded text-slate-600 hover:text-red-400 hover:bg-slate-700 transition-colors"
                      title="Delete project"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {project.description && (
                  <p className="text-slate-400 text-sm mt-2 line-clamp-2">{project.description}</p>
                )}

                <div className="flex items-center gap-3 mt-3">
                  <span className="flex items-center gap-1 text-xs text-slate-500">
                    <Briefcase className="w-3 h-3" />
                    {(project as Project & { job_count?: number }).job_count ?? 0} agents
                  </span>
                  <span className="text-xs text-slate-600">
                    {formatDate(project.created_at)}
                  </span>
                </div>

                {project.repo_access_mode === 'worktree' && project.repo_path && (
                  <div className="mt-2">
                    <Badge variant="workspace">🌿 {project.repo_path}</Badge>
                  </div>
                )}
                {project.repo_access_mode === 'clone' && project.repo_url && (
                  <div className="mt-2">
                    <Badge variant="workspace">🔁 {project.repo_url}</Badge>
                  </div>
                )}

                {project.context_md && (
                  <div className="mt-2">
                    <Badge variant="workspace">has context</Badge>
                  </div>
                )}
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
