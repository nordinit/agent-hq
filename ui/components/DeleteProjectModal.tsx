'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import type { ProjectDeletionSummary } from '@/lib/projectArchive';

interface CascadeInfo {
  active_tasks: number;
  running_instances: number;
  dependent_workflows?: number;
  dependent_tasks?: number;
  dependent_agents?: number;
}

interface DeleteProjectModalProps {
  projectId: number;
  projectName: string;
  /** Receives what happened to the project's agents. */
  onConfirm: (summary: ProjectDeletionSummary) => void;
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

  // Only archived projects reach this dialog. The server refuses while runs are in flight.
  const runsInFlight = cascade?.running_instances ?? 0;

  const nameMatches = confirmText.trim() === projectName.trim();
  const canDelete = nameMatches && !cascadeLoading && runsInFlight === 0;

  const handleDelete = async () => {
    if (!canDelete) return;
    setDeleting(true);
    setError(null);
    try {
      const result = await api.deleteProject(projectId);
      onConfirm(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
              <h2 className="font-semibold text-white text-base">Delete archived project</h2>
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

        {/* What goes with it */}
        {cascadeLoading ? (
          <div className="flex items-center gap-2 text-slate-400 text-sm">
            <span className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
            Checking what this project owns…
          </div>
        ) : (
          <div className="bg-slate-700/40 border border-slate-600/50 rounded-lg px-4 py-3 text-slate-300 text-sm space-y-2">
            <p>
              Permanently deletes <span className="font-semibold text-white">{projectName}</span> with its{' '}
              {cascade?.dependent_workflows ?? 0} workflow{(cascade?.dependent_workflows ?? 0) !== 1 ? 's' : ''},{' '}
              {cascade?.dependent_tasks ?? 0} task{(cascade?.dependent_tasks ?? 0) !== 1 ? 's' : ''} and their history,
              recurring tasks and files, and its {cascade?.dependent_agents ?? 0} agent{(cascade?.dependent_agents ?? 0) !== 1 ? 's' : ''}.
            </p>
            <p className="text-slate-400 text-xs">
              Agents with run or chat history are kept as deleted records so that history stays readable. Atlas is never
              deleted: it is moved out of the project.
            </p>
          </div>
        )}

        {runsInFlight > 0 && (
          <div className="bg-amber-900/30 border border-amber-700/60 rounded-lg p-3 flex items-start gap-2 text-amber-200 text-xs">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-300" />
            {runsInFlight} run{runsInFlight !== 1 ? 's are' : ' is'} still finishing. Wait for {runsInFlight !== 1 ? 'them' : 'it'} to end, then delete the project.
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
            Delete permanently
          </Button>
        </div>
      </div>
    </div>
  );
}
