'use client';
import { formatDateTime } from '@/lib/date';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, Project } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Archive, ArchiveRestore, ArrowLeft, FolderOpen, Trash2, X } from 'lucide-react';
import { DeleteProjectModal } from '@/components/DeleteProjectModal';
import { projectDeletionNotice } from '@/lib/projectArchive';

/**
 * Archived projects: hidden from the rest of Agent HQ and skipped by automation. From here they
 * can be opened read-only, unarchived, or permanently deleted.
 */
export default function ArchivedProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => {
    api.getArchivedProjects()
      .then(setProjects)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleUnarchive = async (project: Project) => {
    setRestoringId(project.id);
    try {
      await api.unarchiveProject(project.id);
      setNotice(`${project.name} is active again.`);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoringId(null);
    }
  };

  if (loading) return (
    <div className="flex items-center gap-2 text-slate-400 text-sm">
      <span className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
      Loading archived projects…
    </div>
  );

  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/projects" className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors" title="Back to projects">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-white">Archived projects</h1>
          <p className="text-slate-400 text-sm mt-1">
            Agents don&apos;t pick up their tasks and they are hidden from the rest of Agent HQ.
          </p>
        </div>
      </div>

      {notice && (
        <div className="flex items-center justify-between gap-3 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm text-slate-300">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-slate-500 hover:text-slate-300" title="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {projects.length === 0 ? (
        <Card className="text-center py-10">
          <Archive className="w-8 h-8 text-slate-600 mx-auto" />
          <p className="text-slate-400 text-sm mt-3">No archived projects.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {projects.map(project => (
            <Card key={project.id} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Link href={`/projects/${project.id}`} className="flex items-start gap-2 min-w-0 group">
                <FolderOpen className="w-5 h-5 text-slate-500 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <h3 className="font-semibold text-slate-200 truncate group-hover:text-amber-300 transition-colors">{project.name}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Archived {project.archived_at ? formatDateTime(project.archived_at) : ''}
                    {' · '}{(project as Project & { agent_count?: number }).agent_count ?? 0} agents
                  </p>
                </div>
              </Link>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="ghost" size="sm" onClick={() => handleUnarchive(project)} loading={restoringId === project.id}>
                  <ArchiveRestore className="w-3.5 h-3.5" /> Unarchive
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteTarget(project)}
                  className="text-red-400 hover:text-red-300 hover:bg-red-900/20"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {deleteTarget && (
        <DeleteProjectModal
          projectId={deleteTarget.id}
          projectName={deleteTarget.name}
          onConfirm={(summary) => {
            setNotice(projectDeletionNotice(deleteTarget.name, summary));
            setDeleteTarget(null);
            load();
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
