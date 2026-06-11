'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Cpu, Download, Paperclip, Upload } from 'lucide-react';
import { api, Task, TaskAttachment, TaskHistory, TaskNote, JobInstance, CustomFieldDefinition } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/date';
import { getRunLifecycle, getTaskOutcomeLabel } from '@/lib/runLifecycle';
import { getTaskStatusMaps } from '@/lib/taskStatuses';
import { getFailureActor, getFailureRecoveryLabel, getFailureSourceLabel, getFailureSummary, getFailureTone, isFailureBlocked } from '@/lib/taskFailure';
import { formatFailureOutcomeBadgeLabel, getTaskOutcomeBadgeClass, TaskOutcomeMetaMap } from '@/lib/taskOutcomeMeta';
import { shortModelName } from './modelRouting';

const { dots: FALLBACK_STATUS_DOT } = getTaskStatusMaps();

// ── Notes Section ─────────────────────────────────────────────────────────────

export function NotesSection({ taskId }: { taskId: number }) {
  const [notes, setNotes] = useState<TaskNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [author, setAuthor] = useState('User');
  const [submitting, setSubmitting] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);

  const loadNotes = useCallback(async () => {
    try {
      const data = await api.getTaskNotes(taskId);
      setNotes(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, [taskId]);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  const handleSubmit = async () => {
    if (!content.trim()) return;
    setSubmitting(true);
    try {
      await api.createTaskNote(taskId, { author, content: content.trim() });
      setContent('');
      await loadNotes();
    } catch { /* ignore */ }
    setSubmitting(false);
  };

  const handleDelete = async (noteId: number) => {
    try {
      await api.deleteTaskNote(taskId, noteId);
      await loadNotes();
    } catch { /* ignore */ }
  };

  return (
    <div>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Notes</p>

      {loading ? (
        <p className="text-xs text-slate-500 italic">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="text-xs text-slate-600 italic mb-3">No notes yet.</p>
      ) : (
        <div className="space-y-3 mb-4">
          {notes.map(note => (
            <div
              key={note.id}
              className="bg-slate-800 border border-slate-700 rounded-lg p-3 group relative"
              onMouseEnter={() => setHovered(note.id)}
              onMouseLeave={() => setHovered(null)}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-slate-400 font-medium">
                  {note.author} <span className="text-slate-600">·</span> <span className="text-slate-500">{timeAgo(note.created_at)}</span>
                </span>
                {hovered === note.id && (
                  <button
                    onClick={() => handleDelete(note.id)}
                    className="text-slate-600 hover:text-red-400 transition-colors text-xs"
                    title="Delete note"
                  >
                    ×
                  </button>
                )}
              </div>
              <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">{note.content}</p>
            </div>
          ))}
        </div>
      )}

      {/* Add note form */}
      <div className="border border-slate-700 rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-700 bg-slate-800/50">
          <span className="text-xs text-slate-500">Author:</span>
          <input
            className="bg-transparent text-xs text-slate-300 focus:outline-none w-20"
            value={author}
            onChange={e => setAuthor(e.target.value)}
          />
        </div>
        <textarea
          className="w-full bg-slate-800 px-3 py-2 text-sm text-white focus:outline-none resize-none h-16 placeholder-slate-600"
          placeholder="Add a note…"
          value={content}
          onChange={e => setContent(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit();
          }}
        />
        <div className="flex justify-end px-3 py-1.5 bg-slate-800/50 border-t border-slate-700">
          <button
            onClick={handleSubmit}
            disabled={submitting || !content.trim()}
            className="text-xs bg-amber-500 hover:bg-amber-400 text-black font-semibold px-3 py-1 rounded transition-colors disabled:opacity-50"
          >
            {submitting ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Attachments Section ───────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentsSection({ taskId }: { taskId: number }) {
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);

  const loadAttachments = useCallback(async () => {
    try {
      const data = await api.getTaskAttachments(taskId);
      setAttachments(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, [taskId]);

  useEffect(() => { loadAttachments(); }, [loadAttachments]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await api.uploadTaskAttachment(taskId, file, 'Atlas');
      await loadAttachments();
    } catch { /* ignore */ }
    setUploading(false);
    // Reset input so the same file can be re-uploaded
    e.target.value = '';
  };

  const handleDelete = async (attachmentId: number) => {
    try {
      await api.deleteTaskAttachment(taskId, attachmentId);
      await loadAttachments();
    } catch { /* ignore */ }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
          <Paperclip className="w-3 h-3" />
          Attachments
        </p>
        <label className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors cursor-pointer">
          <Upload className="w-3 h-3" />
          {uploading ? 'Uploading…' : 'Upload'}
          <input
            type="file"
            className="hidden"
            onChange={handleUpload}
            disabled={uploading}
          />
        </label>
      </div>

      {loading ? (
        <p className="text-xs text-slate-500 italic">Loading…</p>
      ) : attachments.length === 0 ? (
        <p className="text-xs text-slate-600 italic">No attachments.</p>
      ) : (
        <div className="space-y-2">
          {attachments.map(att => (
            <div
              key={att.id}
              className="flex items-center justify-between bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 group"
              onMouseEnter={() => setHovered(att.id)}
              onMouseLeave={() => setHovered(null)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <a
                  href={api.getTaskAttachmentUrl(taskId, att.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-slate-300 hover:text-amber-300 transition-colors truncate flex items-center gap-1.5"
                  title={att.filename}
                >
                  <Download className="w-3 h-3 shrink-0 text-slate-500" />
                  <span className="truncate">{att.filename}</span>
                </a>
                <span className="text-xs text-slate-600 shrink-0">{formatFileSize(att.size)}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-2">
                <span className="text-xs text-slate-500">{att.uploaded_by}</span>
                {hovered === att.id && (
                  <button
                    onClick={() => handleDelete(att.id)}
                    className="text-slate-600 hover:text-red-400 transition-colors text-xs"
                    title="Delete attachment"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── History Section ───────────────────────────────────────────────────────────

export function HistorySection({ taskId }: { taskId: number }) {
  const [history, setHistory] = useState<TaskHistory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getTaskHistory(taskId)
      .then(setHistory)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [taskId]);

  if (loading) return <p className="text-xs text-slate-500 italic">Loading…</p>;
  if (history.length === 0) return <p className="text-xs text-slate-600 italic">No changes recorded yet.</p>;

  return (
    <div className="space-y-2">
      {history.map(entry => {
        const isStatus = entry.field === 'status';
        const dotColor = isStatus && entry.new_value ? (FALLBACK_STATUS_DOT[entry.new_value] ?? 'bg-slate-400') : 'bg-slate-500';

        return (
          <div key={entry.id} className="flex items-start gap-2.5 text-xs">
            <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
            <div className="flex-1 min-w-0">
              <span className="text-slate-300">
                <span className="text-slate-500">{entry.field}:</span>{' '}
                {entry.old_value != null ? (
                  <><span className="text-slate-400 line-through">{entry.old_value}</span> → </>
                ) : null}
                <span className="text-white">{entry.new_value ?? '—'}</span>
              </span>
              <span className="text-slate-600 ml-2">by {entry.changed_by} · {timeAgo(entry.created_at)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Related Runs Section ──────────────────────────────────────────────────────

export const RUN_STATUS_BADGE: Record<string, string> = {
  queued: 'bg-slate-700 text-slate-300',
  starting: 'bg-cyan-900/60 text-cyan-300',
  running: 'bg-green-900/60 text-green-300',
  awaiting_outcome: 'bg-amber-900/60 text-amber-200 border border-amber-500/30',
  done: 'bg-emerald-900/60 text-emerald-300',
  failed: 'bg-red-900/60 text-red-300',
};

export function formatRuntimeEndSource(source?: string | null): string {
  if (!source) return 'Unknown';
  return source.replace(/_/g, ' ');
}

function getRuntimeHandoffState(instance: Pick<JobInstance, 'runtime_ended_at' | 'lifecycle_outcome_posted_at'>) {
  if (!instance.runtime_ended_at) return null;
  return instance.lifecycle_outcome_posted_at ? 'posted' : 'missing';
}

function getRuntimeHandoffSummary(instance: Pick<JobInstance, 'runtime_ended_at' | 'runtime_end_source' | 'runtime_end_error' | 'lifecycle_outcome_posted_at'>) {
  const handoffState = getRuntimeHandoffState(instance);
  if (!handoffState) return null;
  if (handoffState === 'missing') {
    return `Runtime ended${instance.runtime_end_source ? ` via ${formatRuntimeEndSource(instance.runtime_end_source)}` : ''} without a lifecycle outcome handoff.`;
  }
  return `Runtime ended${instance.runtime_end_source ? ` via ${formatRuntimeEndSource(instance.runtime_end_source)}` : ''} and posted a lifecycle outcome.`;
}

export function RelatedRunsSection({
  taskId,
  outcomeMap,
  nonFailureOutcomes,
}: {
  taskId: number;
  outcomeMap: TaskOutcomeMetaMap;
  nonFailureOutcomes: Set<string>;
}) {
  const [instances, setInstances] = useState<JobInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    api.getTaskInstances(taskId)
      .then(setInstances)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [taskId]);

  if (loading) return <p className="text-xs text-slate-500 italic">Loading…</p>;
  if (instances.length === 0) return <p className="text-xs text-slate-600 italic">No runs yet.</p>;

  return (
    <div className="space-y-2">
      {instances.map((inst) => {
        const lifecycle = getRunLifecycle(inst, { nonFailureOutcomes });
        const taskOutcome = lifecycle.taskOutcome;
        const isExpanded = expanded === inst.id;

        return (
          <div key={inst.id}>
            <div
              className="flex items-center gap-2 py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700/80 cursor-pointer transition-colors"
              onClick={() => setExpanded(isExpanded ? null : inst.id)}
            >
              {/* Exec status */}
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${RUN_STATUS_BADGE[lifecycle.displayStatus] ?? 'bg-slate-700 text-slate-300'}`}>
                {lifecycle.displayStatus}
              </span>
              {/* Task outcome */}
              {taskOutcome && (
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${getTaskOutcomeBadgeClass(taskOutcome, outcomeMap)}`}>
                  {getTaskOutcomeLabel(taskOutcome, outcomeMap)}
                </span>
              )}
              {/* Instance ID + job */}
              <span className="text-xs text-slate-400 flex-1 truncate min-w-0">
                #{inst.id}{inst.agent_name ? ` · ${inst.agent_name}` : ''}
                {inst.agent_name ? <span className="text-slate-500"> · {inst.agent_name}</span> : null}
              </span>
              {/* Accepted timestamp */}
              <span className="text-xs text-slate-500 shrink-0 hidden sm:block">
                {formatDateTime(inst.dispatched_at ?? inst.created_at)}
              </span>
              {/* Link to chat session for this run */}
              <Link
                href={`/chat?agentId=${inst.agent_id}&instanceId=${inst.id}`}
                onClick={e => e.stopPropagation()}
                className="text-xs text-amber-400 hover:text-amber-300 underline shrink-0"
                title="Open run chat"
              >
                View
              </Link>
              <span className="text-xs text-slate-600 shrink-0">{isExpanded ? '▲' : '▼'}</span>
            </div>

            {/* Expanded detail */}
            {isExpanded && (
              <div className="mt-1 mb-1 mx-2 rounded-lg border border-slate-700 bg-slate-900/60 p-3 space-y-2 text-xs">
                {(inst.effective_model || inst.effective_fast_mode != null) && (
                  <div className="flex items-center gap-1.5 pb-1 border-b border-slate-700/50">
                    <Cpu className="w-3 h-3 text-violet-400 shrink-0" />
                    {inst.effective_model ? (
                      <>
                        <span className="text-violet-300 font-medium text-xs">{shortModelName(inst.effective_model)}</span>
                        <span className="text-slate-600 text-[10px] font-mono">{inst.effective_model}</span>
                      </>
                    ) : (
                      <span className="text-violet-300 font-medium text-xs">Runtime routing</span>
                    )}
                    {inst.effective_fast_mode != null && (
                      <span className="ml-auto rounded border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-200">
                        Fast mode {Boolean(inst.effective_fast_mode) ? 'on' : 'off'}
                      </span>
                    )}
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-slate-400">
                  {inst.dispatched_at && <span>Accepted: <span className="text-slate-200">{formatDateTime(inst.dispatched_at)}</span></span>}
                  {inst.started_at && <span>Started: <span className="text-slate-200">{formatDateTime(inst.started_at)}</span></span>}
                  {inst.completed_at && <span>Completed: <span className="text-slate-200">{formatDateTime(inst.completed_at)}</span></span>}
                  {inst.runtime_ended_at && <span>Runtime ended: <span className="text-slate-200">{formatDateTime(inst.runtime_ended_at)}</span></span>}
                  {inst.runtime_end_source && <span>Terminal source: <span className="text-slate-200">{formatRuntimeEndSource(inst.runtime_end_source)}</span></span>}
                  {typeof inst.runtime_end_success === 'number' && <span>Runtime result: <span className="text-slate-200">{inst.runtime_end_success ? 'success' : 'error'}</span></span>}
                  {inst.lifecycle_outcome_posted_at && <span>Lifecycle outcome posted: <span className="text-slate-200">{formatDateTime(inst.lifecycle_outcome_posted_at)}</span></span>}
                  {inst.current_stage && <span>Stage: <span className="text-slate-200">{inst.current_stage}</span></span>}
                  {inst.branch_name && <span>Branch: <span className="text-slate-200 font-mono">{inst.branch_name}</span></span>}
                  {inst.latest_commit_hash && <span>Commit: <span className="text-slate-200 font-mono">{inst.latest_commit_hash}</span></span>}
                  {typeof inst.changed_files_count === 'number' && <span>Files changed: <span className="text-slate-200">{inst.changed_files_count}</span></span>}
                  {inst.last_agent_heartbeat_at && <span>Heartbeat: <span className="text-slate-200">{timeAgo(inst.last_agent_heartbeat_at)}</span></span>}
                </div>
                {getRuntimeHandoffSummary(inst) && (
                  <div className={`rounded-md border px-2.5 py-2 ${getRuntimeHandoffState(inst) === 'missing' ? 'border-amber-500/30 bg-amber-950/30 text-amber-200' : 'border-emerald-600/30 bg-emerald-950/20 text-emerald-200'}`}>
                    <p className="font-medium">{getRuntimeHandoffSummary(inst)}</p>
                    {inst.runtime_end_error && (
                      <p className="mt-1 text-red-300">Runtime error: {inst.runtime_end_error}</p>
                    )}
                  </div>
                )}
                {inst.artifact_summary && (
                  <p className="text-slate-300 whitespace-pre-wrap">{inst.artifact_summary}</p>
                )}
                {inst.blocker_reason && (
                  <p className="text-orange-300">Blocker: {inst.blocker_reason}</p>
                )}
                {inst.error && (
                  <p className="text-red-400">Error: {inst.error}</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function NeedsAttentionSection({ task }: { task: Task }) {
  const hasRuntimeEnd = Boolean(task.active_instance_runtime_ended_at);
  const missingHandoff = hasRuntimeEnd && !task.active_instance_lifecycle_outcome_posted_at;
  const isNeedsAttention = task.status === 'needs_attention';
  const sectionTitle = isNeedsAttention ? 'Needs Attention' : 'Runtime-end observability';
  const badgeLabel = isNeedsAttention ? 'operator recovery state' : 'runtime-end signal';
  const summary = isNeedsAttention
    ? (missingHandoff
        ? 'This run ended at the runtime layer, no semantic lifecycle outcome was posted, and the task is currently in Needs Attention for operator recovery.'
        : 'This task is in Needs Attention. Treat it as a recovery/control-plane state, not a normal QA or implementation failure.')
    : 'This run ended at the runtime layer, and no semantic lifecycle outcome has been posted yet. The task is not currently in Needs Attention.';

  if (!isNeedsAttention && !missingHandoff) return null;

  return (
    <div>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">{sectionTitle}</p>
      <div className="border border-amber-500/30 bg-amber-950/20 rounded-lg p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs px-2 py-1 rounded-full font-semibold bg-amber-900/60 text-amber-200 border border-amber-500/30">
            {badgeLabel}
          </span>
          {task.previous_status && (
            <span className="text-xs px-2 py-1 rounded-full font-semibold bg-slate-700 text-slate-200">
              from {task.previous_status}
            </span>
          )}
        </div>
        <p className="text-sm text-amber-100">{summary}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {task.active_instance_runtime_ended_at && (
            <div>
              <p className="text-xs text-amber-300/70 uppercase tracking-wide">Runtime ended</p>
              <p className="text-amber-50 mt-0.5">{formatDateTime(task.active_instance_runtime_ended_at)}</p>
            </div>
          )}
          {task.active_instance_runtime_end_source && (
            <div>
              <p className="text-xs text-amber-300/70 uppercase tracking-wide">Terminal source</p>
              <p className="text-amber-50 mt-0.5">{formatRuntimeEndSource(task.active_instance_runtime_end_source)}</p>
            </div>
          )}
          <div>
            <p className="text-xs text-amber-300/70 uppercase tracking-wide">Lifecycle handoff</p>
            <p className="text-amber-50 mt-0.5">{missingHandoff ? 'Missing after runtime end' : (task.active_instance_lifecycle_outcome_posted_at ? 'Posted' : 'Unknown')}</p>
          </div>
          {typeof task.active_instance_runtime_end_success === 'number' && (
            <div>
              <p className="text-xs text-amber-300/70 uppercase tracking-wide">Runtime result</p>
              <p className="text-amber-50 mt-0.5">{task.active_instance_runtime_end_success ? 'success' : 'error'}</p>
            </div>
          )}
        </div>
        {task.active_instance_runtime_end_error && (
          <p className="text-sm text-red-300">Runtime error: {task.active_instance_runtime_end_error}</p>
        )}
      </div>
    </div>
  );
}

export function FailureStateSection({ task, history, outcomeMap }: { task: Task; history: TaskHistory[]; outcomeMap: TaskOutcomeMetaMap }) {
  const failureSource = getFailureSourceLabel(task, outcomeMap);
  if (!failureSource) return null;

  const tone = getFailureTone(task, outcomeMap);
  const blockedState = isFailureBlocked(task, outcomeMap);
  const actor = getFailureActor(history);
  const summary = getFailureSummary(task);
  const recoveryLabel = getFailureRecoveryLabel(task, outcomeMap);

  return (
    <div>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Failure State</p>
      <div className={`border rounded-lg p-3 space-y-3 ${tone.panel}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded-full font-semibold ${tone.pill}`}>
            {formatFailureOutcomeBadgeLabel(failureSource, blockedState)}
          </span>
          {task.previous_status && (
            <span className="text-xs px-2 py-1 rounded-full font-semibold bg-slate-700 text-slate-200">
              from {task.previous_status}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Source</p>
            <p className="text-slate-200 mt-0.5">{failureSource}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">State</p>
            <p className="text-slate-200 mt-0.5">{blockedState ? 'Blocked, not code-failed' : 'Failed'}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Actor</p>
            <p className="text-slate-200 mt-0.5">{actor ?? task.agent_name ?? 'Unknown'}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Recovery</p>
            <p className="text-slate-200 mt-0.5">{recoveryLabel}</p>
          </div>
          {task.routing_reason && (
            <div className="sm:col-span-2">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Matched routing</p>
              <p className="text-slate-200 mt-0.5">{task.routing_reason}</p>
            </div>
          )}
        </div>

        {summary && (
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Summary</p>
            <p className={`mt-0.5 text-sm ${tone.text}`}>{summary}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTaskFieldValue(field: CustomFieldDefinition, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  return String(value);
}

function getTaskFieldValue(task: Task, field: CustomFieldDefinition): unknown {
  const customValue = task.custom_fields?.[field.key];
  if (customValue !== undefined && customValue !== null && customValue !== '') return customValue;
  return (task as unknown as Record<string, unknown>)[field.key];
}

const TASK_FIELDS_ALREADY_SHOWN = new Set(['id', 'status']);

export function TaskFieldsSection({
  fields,
  task,
}: {
  fields: CustomFieldDefinition[];
  task: Task;
}) {
  const displayFields = fields.filter(field => !TASK_FIELDS_ALREADY_SHOWN.has(field.key));
  const warnings = task.integrity_warnings ?? [];

  if (displayFields.length === 0 && warnings.length === 0) return null;

  return (
    <div>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Task Fields</p>
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 space-y-3">
        {warnings.length > 0 && (
          <div className={`rounded-lg border px-3 py-2 text-xs ${task.status === 'done' ? 'border-red-500/40 bg-red-950/30 text-red-200' : 'border-amber-500/30 bg-amber-950/20 text-amber-200'}`}>
            {warnings.map((warning, index) => (
              <p key={`${warning}-${index}`}>{warning}</p>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {displayFields.map(field => {
            const value = getTaskFieldValue(task, field);
            return (
              <div key={field.key}>
                <div className="flex items-center gap-1.5">
                  <p className="text-xs text-slate-500 uppercase tracking-wide">{field.label ?? field.key}</p>
                  {field.required && <span className="text-[10px] text-amber-300">required</span>}
                  {field.system === true && <span className="text-[10px] text-slate-500">system</span>}
                </div>
                <p className="text-slate-200 break-all whitespace-pre-wrap text-xs mt-0.5">{formatTaskFieldValue(field, value)}</p>
                {field.help_text && <p className="text-[10px] text-slate-500 mt-1">{field.help_text}</p>}
              </div>
            );
          })}
          {displayFields.length === 0 && (
            <div className="sm:col-span-2">
              <p className="text-sm text-slate-500">No task fields configured for this task.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

