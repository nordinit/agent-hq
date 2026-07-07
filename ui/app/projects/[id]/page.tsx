'use client';
import { formatDateTime, formatDate, formatTime, timeAgo } from '@/lib/date';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, Project, Agent, Sprint } from '@/lib/api';
import { formatSprintLabel, formatSprintNumber } from '@/lib/sprintLabel';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft, Save, Pencil, Trash2, Check, X,
  ToggleLeft, ToggleRight, Plus, FolderOpen, PanelRightOpen, Paperclip, Rocket, Target, History, Bot, Download
} from 'lucide-react';
import Link from 'next/link';
// JobDetailPanel removed — agent details now live at /agents/:id (T#459)
import ProjectFiles from '@/components/ProjectFiles';
import { DeleteProjectModal } from '@/components/DeleteProjectModal';
import ProjectAuditLog from '@/features/observability/ProjectAuditLog';
import { AgentDeleteNotice, buildAgentDeleteNotice, type AgentDeleteNoticeData } from '@/components/AgentDeleteNotice';

type TabMode = 'preview' | 'edit';
type PageTab = 'agents' | 'files' | 'sprints' | 'audit';

const SPRINT_STATUS_BADGE: Record<string, 'done' | 'running' | 'queued' | 'info'> = {
  planning: 'queued',
  active: 'running',
  paused: 'info',
  complete: 'done',
};

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = Number(params.id);

  const [project, setProject] = useState<Project | null>(null);
  const [projectAgents, setProjectAgents] = useState<Agent[]>([]);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit state for project info
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editContext, setEditContext] = useState('');
  const [contextTab, setContextTab] = useState<TabMode>('edit');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Page tab
  const [pageTab, setPageTab] = useState<PageTab>('agents');

  // Delete modal
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  // Agent actions
  const [addAgentId, setAddAgentId] = useState<string>('');
  const [addingAgent, setAddingAgent] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<AgentDeleteNoticeData | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      api.getProject(projectId),
      api.getAgents(projectId),
      api.getAgents(),
      api.getSprints(projectId),
    ])
      .then(([p, pAgents, allAg, sp]) => {
        setProject(p);
        setEditName(p.name);
        setEditDesc(p.description);
        setEditContext(p.context_md);
        setProjectAgents(pAgents);
        setAllAgents(allAg);
        setSprints(sp);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.updateProject(projectId, {
        name: editName.trim() || project!.name,
        description: editDesc,
        context_md: editContext,
      });
      setProject(updated);
      setEditing(false);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    if (project) {
      setEditName(project.name);
      setEditDesc(project.description);
      setEditContext(project.context_md);
    }
    setEditing(false);
    setSaveError(null);
  };

  const handleDeleteAgent = async (id: number, name: string) => {
    if (!confirm(`Delete agent "${name}"? Historical tasks and runs will be preserved.`)) return;
    try {
      const result = await api.deleteAgent(id);
      setDeleteNotice(buildAgentDeleteNotice(name, result));
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleToggleAgent = async (agent: Agent) => {
    try {
      await api.updateAgent(agent.id, { enabled: agent.enabled === 1 ? 0 : 1 } as any);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleAssignAgent = async () => {
    if (!addAgentId) return;
    setAddingAgent(true);
    try {
      await api.updateAgent(Number(addAgentId), { project_id: projectId } as any);
      setAddAgentId('');
      load();
    } catch (e) {
      alert(String(e));
    } finally {
      setAddingAgent(false);
    }
  };

  const handleExport = async (includeFiles: boolean) => {
    if (!project) return;
    setExporting(true);
    try {
      const blob = await api.exportProjectManifest(project.id, includeFiles);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'project'}-manifest-v1.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(String(e));
    } finally {
      setExporting(false);
    }
  };

  const handleRemoveFromProject = async (id: number) => {
    try {
      await api.updateAgent(id, { project_id: null } as any);
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  // Agents not assigned to this project
  const unassignedAgents = allAgents.filter(a => a.project_id !== projectId);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );

  if (!project) return null;

  const hasUnsavedChanges = editing && (
    editName !== project.name ||
    editDesc !== project.description ||
    editContext !== project.context_md
  );

  return (
    <div className="space-y-6">
      {/* Back + Title */}
      <div className="flex flex-wrap items-start gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push('/projects')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-white text-xl font-bold focus:outline-none focus:border-amber-500"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              placeholder="Project name"
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <FolderOpen className="w-5 h-5 text-amber-400 shrink-0" />
              <h1 className="text-xl font-bold text-white truncate">{project.name}</h1>
              <Badge variant="workspace">{projectAgents.length} agents</Badge>
            </div>
          )}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 shrink-0 sm:w-auto sm:justify-end">
          {editing ? (
            <>
              <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
                <Save className="w-3.5 h-3.5" /> Save
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancelEdit}>
                <X className="w-3.5 h-3.5" /> Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => handleExport(false)} loading={exporting}>
                <Download className="w-3.5 h-3.5" /> Export
              </Button>
              <Button variant="ghost" size="sm" onClick={() => handleExport(true)} loading={exporting}>
                <Paperclip className="w-3.5 h-3.5" /> Export Files
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="w-3.5 h-3.5" /> Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteModal(true)}
                className="text-red-400 hover:text-red-300 hover:bg-red-900/20"
                title="Delete project"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </Button>
            </>
          )}
        </div>
      </div>

      {deleteNotice && (
        <AgentDeleteNotice
          notice={deleteNotice}
          onDismiss={() => setDeleteNotice(null)}
        />
      )}

      {/* Project Info Card */}
      <Card>
        <div className="space-y-4">
          {/* Description */}
          <div>
            <label className="text-slate-400 text-xs mb-1 block">Description</label>
            {editing ? (
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={editDesc}
                onChange={e => setEditDesc(e.target.value)}
                placeholder="What is this project about?"
              />
            ) : (
              <p className="text-slate-300 text-sm">
                {project.description || <span className="text-slate-500 italic">No description</span>}
              </p>
            )}
          </div>

          <div>
            <label className="text-slate-400 text-xs mb-1 block">Legacy Repository Fallback</label>
            <div className="space-y-1 text-sm">
              {!project.repo_access_mode && <span className="text-slate-500 italic">No legacy fallback configured</span>}
              {project.repo_access_mode === 'worktree' && (
                <span className="text-emerald-400 font-mono break-all">Legacy worktree: {project.repo_path}</span>
              )}
              {project.repo_access_mode === 'clone' && (
                <span className="text-cyan-300 font-mono break-all">Legacy clone: {project.repo_url}</span>
              )}
              <p className="text-xs text-slate-500">Repository settings are edited on workflows.</p>
            </div>
          </div>

          {/* Context Markdown */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-slate-400 text-xs">Project Context (prepended to all agent dispatches)</label>
              <div className="flex gap-1">
                <button
                  onClick={() => setContextTab('edit')}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                    contextTab === 'edit'
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  Edit
                </button>
                <button
                  onClick={() => setContextTab('preview')}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                    contextTab === 'preview'
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  Preview
                </button>
              </div>
            </div>

            {contextTab === 'edit' ? (
              <textarea
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 font-mono resize-y"
                rows={12}
                value={editing ? editContext : project.context_md}
                onChange={e => editing && setEditContext(e.target.value)}
                readOnly={!editing}
                placeholder={editing ? "# Project Context\n\nDescribe the project background, goals, and any relevant information for the agent..." : "No context set. Click Edit to add context."}
              />
            ) : (
              <div className="bg-slate-700/50 border border-slate-600 rounded-lg p-4 min-h-32 prose prose-invert prose-sm max-w-none
                prose-headings:text-white prose-p:text-slate-300 prose-code:text-amber-300 prose-pre:bg-slate-800
                prose-a:text-amber-400 prose-strong:text-white prose-li:text-slate-300
              ">
                {(editing ? editContext : project.context_md) ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {editing ? editContext : project.context_md}
                  </ReactMarkdown>
                ) : (
                  <p className="text-slate-500 italic text-sm">No context set.</p>
                )}
              </div>
            )}
          </div>

          {saveError && <p className="text-red-400 text-xs">{saveError}</p>}

          {hasUnsavedChanges && (
            <div className="flex items-center gap-2 pt-1">
              <span className="w-2 h-2 bg-amber-400 rounded-full" />
              <span className="text-amber-300 text-xs">Unsaved changes</span>
              <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
                <Save className="w-3 h-3" /> Save Now
              </Button>
            </div>
          )}

          <div className="text-xs text-slate-600">
            Created {formatDateTime(project.created_at)}
          </div>
        </div>
      </Card>

      {/* Tab Nav */}
      <div className="-mx-1 flex items-center gap-1 overflow-x-auto border-b border-slate-700 pb-0 scrollbar-none">
        <button
          onClick={() => setPageTab('agents')}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 ${
            pageTab === 'agents'
              ? 'text-amber-300 border-amber-400 bg-amber-500/10'
              : 'text-slate-400 border-transparent hover:text-slate-300'
          }`}
        >
          <Bot className="w-3.5 h-3.5" /> Agents
          {projectAgents.length > 0 && (
            <span className="ml-1 text-xs bg-slate-700 rounded-full px-1.5 py-0.5">{projectAgents.length}</span>
          )}
        </button>
        <button
          onClick={() => setPageTab('sprints')}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 ${
            pageTab === 'sprints'
              ? 'text-amber-300 border-amber-400 bg-amber-500/10'
              : 'text-slate-400 border-transparent hover:text-slate-300'
          }`}
        >
          <Rocket className="w-3.5 h-3.5" /> Workflows
          {sprints.length > 0 && (
            <span className="ml-1 text-xs bg-slate-700 rounded-full px-1.5 py-0.5">{sprints.length}</span>
          )}
        </button>
        <button
          onClick={() => setPageTab('files')}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 ${
            pageTab === 'files'
              ? 'text-amber-300 border-amber-400 bg-amber-500/10'
              : 'text-slate-400 border-transparent hover:text-slate-300'
          }`}
        >
          <Paperclip className="w-3.5 h-3.5" /> Files
        </button>
        <button
          onClick={() => setPageTab('audit')}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 ${
            pageTab === 'audit'
              ? 'text-amber-300 border-amber-400 bg-amber-500/10'
              : 'text-slate-400 border-transparent hover:text-slate-300'
          }`}
        >
          <History className="w-3.5 h-3.5" /> Audit
        </button>
      </div>

      {/* Workflows Tab */}
      {pageTab === 'sprints' && (
        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="font-semibold text-white">Project Workflows</h2>
            <Link href="/workflows/new">
              <Button variant="primary" size="sm">
                <Plus className="w-3.5 h-3.5" /> New Workflow
              </Button>
            </Link>
          </div>

          {sprints.length === 0 ? (
            <Card>
              <div className="text-center py-8 text-slate-500 text-sm">
                No workflows for this project yet.
              </div>
            </Card>
          ) : (
            <div className="space-y-2">
              {sprints.map(sprint => {
                const progress = sprint.task_count
                  ? Math.round(((sprint.tasks_done ?? 0) / sprint.task_count) * 100)
                  : 0;
                return (
                  <Link key={sprint.id} href={`/workflows/${sprint.id}`}>
                    <Card className="hover:border-slate-600 transition-colors cursor-pointer">
                      <div className="flex items-start gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <Rocket className="w-4 h-4 text-amber-400 shrink-0" />
                            <span className="font-semibold text-white hover:text-amber-300 transition-colors">
                              {formatSprintLabel(sprint)}
                            </span>
                            <Badge variant={SPRINT_STATUS_BADGE[sprint.status] ?? 'default'}>
                              {sprint.status}
                            </Badge>
                            {sprint.length_value && (
                              <span className="text-xs text-slate-500">
                                {sprint.length_value} {sprint.length_kind === 'runs' ? 'runs' : ''}
                              </span>
                            )}
                          </div>
                          {sprint.goal && (
                            <p className="text-slate-400 text-sm mt-1 line-clamp-2">{sprint.goal}</p>
                          )}
                          <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                            <span>{formatSprintNumber(sprint.id)}</span>
                            <span className="flex items-center gap-1">
                              <Target className="w-3 h-3" />
                              {sprint.tasks_done ?? 0}/{sprint.task_count ?? 0} tasks done
                            </span>
                            <span>Created {timeAgo(sprint.created_at)}</span>
                          </div>
                          {sprint.task_count != null && sprint.task_count > 0 && (
                            <div className="mt-2 w-full bg-slate-700 rounded-full h-1.5">
                              <div
                                className="bg-amber-400 h-1.5 rounded-full transition-all"
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Files Tab */}
      {pageTab === 'files' && (
        <ProjectFiles projectId={projectId} />
      )}

      {/* Audit Tab */}
      {pageTab === 'audit' && (
        <ProjectAuditLog projectId={projectId} />
      )}

      {/* Agents Tab */}
      {pageTab === 'agents' && <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="font-semibold text-white">Assigned Agents</h2>
          {unassignedAgents.length > 0 && (
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <select
                className="min-w-0 flex-1 bg-slate-700 border border-slate-600 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:border-amber-500 sm:min-w-[220px] sm:flex-none"
                value={addAgentId}
                onChange={e => setAddAgentId(e.target.value)}
              >
                <option value="">Assign existing agent…</option>
                {unassignedAgents.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <Button
                variant="primary"
                size="sm"
                onClick={handleAssignAgent}
                loading={addingAgent}
                disabled={!addAgentId}
              >
                <Plus className="w-3.5 h-3.5" /> Assign
              </Button>
            </div>
          )}
        </div>

        {projectAgents.length === 0 ? (
          <Card>
            <div className="text-center py-8 text-slate-500 text-sm">
              No agents assigned to this project.
              {unassignedAgents.length > 0 ? ' Use the dropdown above to assign one.' : ' Create an agent and assign it to this project.'}
            </div>
          </Card>
        ) : (
          <div className="space-y-2">
            {projectAgents.map(agent => (
              <Card key={agent.id} className="hover:border-slate-600 transition-colors">
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <button
                        className="font-semibold text-white hover:text-amber-300 transition-colors text-left"
                        onClick={() => router.push(`/agents/${agent.id}`)}
                      >
                        {agent.name}
                      </button>
                      {agent.enabled ? (
                        <Badge variant="done">enabled</Badge>
                      ) : (
                        <Badge variant="queued">disabled</Badge>
                      )}
                      {agent.skill_names && agent.skill_names.length > 0 && (
                        <Badge variant="workspace">skills: {agent.skill_names.join(', ')}</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-500 flex-wrap">
                      <span>Agent: <span className="text-slate-300">{agent.name}</span></span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-wrap shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => router.push(`/agents/${agent.id}`)}
                      title="View details"
                    >
                      <PanelRightOpen className="w-3.5 h-3.5" /> Details
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleAgent(agent)}
                      title="Toggle enabled"
                    >
                      {agent.enabled ? (
                        <ToggleRight className="w-4 h-4 text-green-400" />
                      ) : (
                        <ToggleLeft className="w-4 h-4 text-slate-500" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveFromProject(agent.id)}
                      title="Remove from project"
                    >
                      <X className="w-3.5 h-3.5 text-slate-400" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteAgent(agent.id, agent.name)}
                      title="Delete agent"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-400" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>}

      {/* Delete Project Modal */}
      {showDeleteModal && project && (
        <DeleteProjectModal
          projectId={projectId}
          projectName={project.name}
          onConfirm={() => router.push('/projects')}
          onCancel={() => setShowDeleteModal(false)}
        />
      )}
    </div>
  );
}
