'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { api, getApiBase, type Task } from '@/lib/api';
import { useLiveRefresh } from '@/lib/useLiveRefresh';
import { TaskDetailPanel } from '@/features/tasks/TaskDetailPanel';
import { TaskBoardErrorBoundary } from '@/features/tasks/TaskBoardErrorBoundary';

/**
 * Full-page task detail at /tasks/[id]: the same sections as the board's slide-over, laid out
 * so everything is visible at once. Opened from the slide-over's expand button or a board card.
 */
export default function TaskDetailPage({ taskId }: { taskId: number }) {
  const router = useRouter();
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const fresh = await api.getTask(taskId);
      setTask(fresh);
      setError(null);
    } catch (err) {
      // Keep showing the last good copy if a background refresh fails.
      setError(err instanceof Error ? err.message : 'Failed to load task');
    }
  }, [taskId]);

  useEffect(() => {
    setTask(null);
    setError(null);
    void load();
  }, [load]);

  useLiveRefresh(load, { enabled: task !== null });

  const handleSave = useCallback(async (data: Partial<Task> & { recurring: number }) => {
    setTask(await api.updateTask(taskId, { ...data, changed_by: 'User' } as Partial<Task>));
  }, [taskId]);

  const handleDelete = useCallback(async () => {
    // Same request as the board, so the audit log attributes the delete to the operator.
    const res = await fetch(`${getApiBase()}/api/v1/tasks/${taskId}?deleted_by=User`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Delete failed (${res.status})`);
    }
    router.push('/tasks');
  }, [router, taskId]);

  const handleCancel = useCallback(async () => {
    const reason = window.prompt('Stop reason (optional):');
    if (reason === null) return;
    setTask((await api.stopTask(taskId, reason || undefined)).task);
  }, [taskId]);

  const handlePause = useCallback(async (reason?: string) => {
    setTask((await api.pauseTask(taskId, reason)).task);
  }, [taskId]);

  const handleUnpause = useCallback(async () => {
    setTask((await api.unpauseTask(taskId)).task);
  }, [taskId]);

  if (!task) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-slate-950 p-6 text-center">
        {error ? (
          <>
            <p className="text-sm text-red-300">Could not load task #{taskId}: {error}</p>
            <div className="flex items-center gap-3 text-xs">
              <button onClick={() => void load()} className="text-amber-400 hover:text-amber-300">Retry</button>
              <Link href="/tasks" className="inline-flex items-center gap-1 text-slate-400 hover:text-white">
                <ArrowLeft className="h-3 w-3" /> Back to tasks
              </Link>
            </div>
          </>
        ) : (
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
        )}
      </div>
    );
  }

  return (
    <TaskBoardErrorBoundary fallbackTitle="Task detail page encountered an error">
      <TaskDetailPanel
        variant="page"
        task={task}
        onClose={() => router.push('/tasks')}
        onSave={handleSave}
        onDelete={handleDelete}
        onCancel={handleCancel}
        onPause={handlePause}
        onUnpause={handleUnpause}
      />
    </TaskBoardErrorBoundary>
  );
}
