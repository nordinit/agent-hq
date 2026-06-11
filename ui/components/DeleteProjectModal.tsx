'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { AlertTriangle, Trash2, X } from 'lucide-react';

interface CascadeInfo {
  active_tasks: number;
  running_instances: number;
  dependent_sprints?: number;
  dependent_tasks?: number;
  dependent_agents?: number;
}

interface DeleteProjectModalProps {
  projectId: number;
  projectName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteProjectModal({
  projectId,
  projectName,
  onConfirm,
  onCancel,
}: DeleteProjectModalProps) {
  const [confirmText, setConfirmText] = useState('');
  const [cascade, setCascade] = useState<CascadeInfo | null>(null);
  const [cascadeLoading, setCascadeLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.checkProjectCascade(projectId)
      .then(setCascade)
      .catch(() => setCascade({ active_tasks: 0, running_instances: 0 }))
      .finally(() => setCascadeLoading(false));
  }, [projectId]);

  const hasActiveWork = cascade
    ? cascade.active_tasks > 0 || cascade.running_instances > 0
    : false;
  const hasDependents = cascade
    ? (cascade.dependent_sprints ?? 0) > 0 || (cascade.dependent_tasks ?? 0) > 0 || (cascade.dependent_agents ?? 0) > 0
    : false;

  const nameMatches = confirmText.trim() === projectName.trim();
  const canDelete = nameMatches && !cascadeLoading;

  const handleDelete = async () => {
    if (!canDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteProject(projectId, { confirm: hasDependents || hasActiveWork, force: hasDependents || hasActiveWork });
      onConfirm();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(
        message.includes('Project delete requires confirmation')
          ? 'Project deletion still requires explicit confirmation from the server. If this persists from this dialog, the API confirmation contract likely changed.'
          : message,
      );
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Modal */}
      <div className="relative bg-slate-800 border border-slate-700 rounded-xl shadow-xl w-full max-w-md p-6 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 bg-red-900/40 rounded-lg flex items-center justify-center shrink-0">
              <Trash2 className="w-4 h-4 text-red-400" />
            </div>
            <div>
              <h2 className="font-semibold text-white text-base">Delete Project</h2>
              <p className="text-slate-400 text-xs mt-0.5">This action cannot be undone</p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="text-slate-500 hover:text-slate-300 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Cascade warnings */}
        {cascadeLoading ? (
          <div className="flex items-center gap-2 text-slate-400 text-sm">
            <span className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
            Checking for active work…
          </div>
        ) : hasActiveWork ? (
          <div className="bg-amber-900/30 border border-amber-700/60 rounded-lg p-4 space-y-1.5">
            <div className="flex items-center gap-2 text-amber-300 font-medium text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Active work detected
            </div>
            {cascade!.active_tasks > 0 && (
              <p className="text-amber-200/80 text-xs">
                • {cascade!.active_tasks} active task{cascade!.active_tasks !== 1 ? 's' : ''} (in_progress / review / dev_deploying)
              </p>
            )}
            {cascade!.running_instances > 0 && (
              <p className="text-amber-200/80 text-xs">
                • {cascade!.running_instances} running agent instance{cascade!.running_instances !== 1 ? 's' : ''}
              </p>
            )}
            <p className="text-amber-200/70 text-xs pt-1">
              Deleting will cascade-remove all tasks and workflows. Jobs will be unassigned.
            </p>
            {hasDependents ? (
              <p className="text-amber-200/70 text-xs">
                This project still owns {cascade?.dependent_sprints ?? 0} workflow{(cascade?.dependent_sprints ?? 0) !== 1 ? 's' : ''}, {cascade?.dependent_tasks ?? 0} task{(cascade?.dependent_tasks ?? 0) !== 1 ? 's' : ''}, and {cascade?.dependent_agents ?? 0} agent{(cascade?.dependent_agents ?? 0) !== 1 ? 's' : ''}.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="bg-slate-700/40 border border-slate-600/50 rounded-lg px-4 py-3 text-slate-300 text-sm">
            Deleting <span className="font-semibold text-white">{projectName}</span> will permanently remove all tasks and workflows associated with it. Jobs will be unassigned from the project.
          </div>
        )}

        {/* Name confirmation */}
        <div className="space-y-2">
          <label className="text-slate-400 text-xs block">
            Type <span className="font-mono text-white font-medium">{projectName}</span> to confirm
          </label>
          <input
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-red-500 transition-colors"
            value={confirmText}
            onChange={e => setConfirmText(e.target.value)}
            placeholder={projectName}
            autoFocus
            onKeyDown={e => e.key === 'Enter' && handleDelete()}
          />
        </div>

        {error && (
          <p className="text-red-400 text-xs">{error.replace(/^Error:\s*/, '')}</p>
        )}

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={handleDelete}
            loading={deleting}
            disabled={!canDelete}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {hasDependents || hasActiveWork ? 'Delete Project and Dependents' : 'Delete Project'}
          </Button>
        </div>
      </div>
    </div>
  );
}
