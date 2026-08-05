'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type RoutingPreview, type RoutingPreviewOperation, type WorkflowGraph, type WorkflowGraphEdge } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { getTaskTypeLabel } from '@/lib/taskTypes';
import { deleteConsequences, guardCreate, guardMutate, type GuardContext } from '@/lib/workflowGraphGuards';
import { AlertTriangle, Check, Lock, ShieldAlert, X } from 'lucide-react';

/**
 * Create, edit or delete a transition from the canvas.
 *
 * Nothing here writes directly. Every gesture is costed by POST /routing/preview first — which
 * applies the real mutation in a transaction that never commits — so the operator sees the rows
 * it touches and the lint it introduces before deciding. Starter policy is installation data;
 * routing writes never seed or reconcile it, so the preview describes only the requested change.
 */

export interface TransitionDraft {
  id: number | null;
  from: string;
  to: string;
  outcome: string;
  task_type: string | null;
  priority: number;
  enabled: boolean;
  /** Scope of the row being edited; null means it is a workflow-type default. */
  is_override: boolean;
}

export function draftFromEdge(edge: WorkflowGraphEdge): TransitionDraft {
  return {
    id: edge.transition_id,
    from: edge.from,
    to: edge.to,
    outcome: edge.outcome,
    task_type: edge.task_type,
    priority: edge.priority,
    enabled: edge.enabled,
    is_override: Boolean(edge.is_override),
  };
}

export function emptyDraft(from: string, to: string): TransitionDraft {
  return { id: null, from, to, outcome: '', task_type: null, priority: 0, enabled: true, is_override: false };
}

const CONTROL = 'w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-sm text-slate-200 focus:border-amber-500 focus:outline-none';
const FIELD_LABEL = 'mb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500';

export default function TransitionComposer({
  draft,
  graph,
  outcomes,
  context,
  onCancel,
  onCommitted,
}: {
  draft: TransitionDraft;
  graph: WorkflowGraph;
  /** Full outcome catalog for the workflow type, not just the outcomes already in use. */
  outcomes: string[];
  context: GuardContext;
  onCancel: () => void;
  onCommitted: () => void;
}) {
  const [form, setForm] = useState<TransitionDraft>(draft);
  const [preview, setPreview] = useState<RoutingPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState<'save' | 'delete'>('save');

  // A new draft means a different element; a stale preview from the previous one would be
  // describing a change the operator is no longer making.
  useEffect(() => {
    setForm(draft);
    setPreview(null);
    setError(null);
    setIntent('save');
  }, [draft]);

  const isCreate = form.id == null;
  const guard = isCreate
    ? guardCreate(context)
    : guardMutate(intent === 'delete' ? 'delete' : 'update', { is_override: form.is_override }, context);

  const payload = useCallback((): Record<string, unknown> => ({
    ...(form.id != null ? { id: form.id } : {}),
    project_id: context.projectId,
    sprint_type: graph.scope.workflow_type,
    // Scope follows the row itself on edit, and the selected workflow on create. Sending the
    // page selection for an existing row is how a shared default gets silently narrowed.
    ...(isCreate
      ? (context.workflowId != null ? { sprint_id: context.workflowId } : { scope_kind: 'sprint_type_default' })
      : (form.is_override ? { sprint_id: context.workflowId } : {})),
    from_status: form.from,
    outcome: form.outcome,
    to_status: form.to,
    task_type: form.task_type,
    priority: form.priority,
    enabled: form.enabled ? 1 : 0,
  }), [form, context, graph.scope.workflow_type, isCreate]);

  const operation = useCallback((action: 'create' | 'update' | 'delete'): RoutingPreviewOperation => ({
    entity: 'transition',
    action,
    payload: payload(),
  }), [payload]);

  const runPreview = async (action: 'create' | 'update' | 'delete') => {
    setBusy(true);
    setError(null);
    setIntent(action === 'delete' ? 'delete' : 'save');
    try {
      setPreview(await api.previewRoutingChange({
        projectId: context.projectId,
        workflowType: graph.scope.workflow_type,
        workflowId: context.workflowId,
        operations: [operation(action)],
      }));
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = payload();
      if (intent === 'delete' && form.id != null) {
        await api.deleteRoutingTransition(form.id, form.is_override ? context.workflowId ?? undefined : undefined,
          context.projectId ?? undefined, graph.scope.workflow_type ?? undefined);
      } else if (form.id != null) {
        await api.updateRoutingTransition(form.id, body);
      } else {
        await api.createRoutingTransition(body);
      }
      onCommitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (key: string) => graph.nodes.find(n => n.id === key)?.label ?? key;
  const canSubmit = form.from && form.to && form.outcome && guard.allow;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
            {isCreate ? 'New transition' : 'Edit transition'}
          </p>
          <p className="mt-1 text-sm font-semibold text-white">
            {statusLabel(form.from)} <span className="text-slate-500">→</span> {statusLabel(form.to)}
          </p>
        </div>
        <button onClick={onCancel} className="text-slate-500 hover:text-slate-300" aria-label="Cancel">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* A refused gesture explains itself and offers the thing the operator meant. */}
      {!guard.allow && (
        <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2.5 text-xs text-red-200">
          <p className="flex items-start gap-1.5"><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{guard.warning}</p>
          {guard.alternative && <p className="mt-1.5 pl-5 text-red-300/80">{guard.alternative}</p>}
        </div>
      )}
      {guard.allow && guard.warning && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-950/25 p-2.5 text-xs text-amber-200">
          <p className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{guard.warning}</p>
        </div>
      )}

      <div>
        <p className={FIELD_LABEL}>Outcome</p>
        <select className={CONTROL} value={form.outcome} onChange={e => { setForm(f => ({ ...f, outcome: e.target.value })); setPreview(null); }}>
          <option value="">select outcome…</option>
          {outcomes.map(outcome => <option key={outcome} value={outcome}>{outcome}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className={FIELD_LABEL}>Task type</p>
          <select
            className={CONTROL}
            value={form.task_type ?? ''}
            onChange={e => { setForm(f => ({ ...f, task_type: e.target.value || null })); setPreview(null); }}
          >
            <option value="">all task types</option>
            {[...new Set(graph.edges.map(e => e.task_type).filter((t): t is string => Boolean(t)))].sort()
              .map(type => <option key={type} value={type}>{getTaskTypeLabel(type)}</option>)}
          </select>
        </div>
        <div>
          <p className={FIELD_LABEL}>Priority</p>
          <input
            type="number"
            className={CONTROL}
            value={form.priority}
            onChange={e => { setForm(f => ({ ...f, priority: Number(e.target.value) || 0 })); setPreview(null); }}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={e => { setForm(f => ({ ...f, enabled: e.target.checked })); setPreview(null); }}
          className="rounded border-slate-600 bg-slate-800"
        />
        Enabled
      </label>

      {error && <p className="rounded-lg border border-red-500/40 bg-red-950/30 p-2 text-xs text-red-300">{error}</p>}

      {/* The preview is the whole point: nothing commits until it has been shown. */}
      {preview && (
        <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-900/70 p-2.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
            {intent === 'delete' ? 'Deleting would' : 'Saving would'}
          </p>
          <ul className="space-y-0.5 text-[11px] text-slate-300">
            {preview.rows_written.map(row => (
              <li key={row.table}>
                {row.delta > 0 ? `write ${row.delta}` : `remove ${Math.abs(row.delta)}`} row
                {Math.abs(row.delta) === 1 ? '' : 's'} in <code className="text-slate-400">{row.table}</code>
              </li>
            ))}
            {preview.rows_written.length === 0 && <li className="text-slate-500">change no rows</li>}
            <li className="text-slate-500">
              affect {preview.affects_workflows.total} workflow{preview.affects_workflows.total === 1 ? '' : 's'}
            </li>
          </ul>

          {preview.introduced.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1 text-[11px] text-amber-300">
                <AlertTriangle className="h-3 w-3" /> introduce {preview.introduced.length} new problem
                {preview.introduced.length === 1 ? '' : 's'}
              </p>
              <ul className="space-y-0.5">
                {preview.introduced.slice(0, 4).map((finding, index) => (
                  <li key={index} className="text-[11px] text-amber-200/80">{finding.message}</li>
                ))}
              </ul>
            </div>
          )}
          {preview.resolved.length > 0 && (
            <p className="flex items-center gap-1 text-[11px] text-emerald-300">
              <Check className="h-3 w-3" /> clear {preview.resolved.length} existing problem
              {preview.resolved.length === 1 ? '' : 's'}
            </p>
          )}
          {intent === 'delete' && deleteConsequences('transition').map(note => (
            <p key={note} className="flex items-start gap-1.5 text-[11px] text-slate-400">
              <Lock className="mt-0.5 h-3 w-3 shrink-0 text-slate-500" />{note}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {preview ? (
          <>
            <Button size="sm" variant="primary" onClick={commit} disabled={busy}>
              {busy ? 'Applying…' : intent === 'delete' ? 'Confirm delete' : 'Confirm save'}
            </Button>
            <button onClick={() => setPreview(null)} className="text-xs text-slate-400 hover:text-slate-200">Back</button>
          </>
        ) : (
          <>
            <Button size="sm" variant="primary" onClick={() => runPreview(isCreate ? 'create' : 'update')} disabled={!canSubmit || busy}>
              {busy ? 'Checking…' : 'Preview change'}
            </Button>
            {!isCreate && (
              <button
                onClick={() => runPreview('delete')}
                disabled={busy || !guardMutate('delete', { is_override: form.is_override }, context).allow}
                className="rounded-lg border border-red-500/40 px-2.5 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-950/30 disabled:opacity-40"
              >
                Delete…
              </button>
            )}
            <button onClick={onCancel} className="text-xs text-slate-400 hover:text-slate-200">Cancel</button>
          </>
        )}
      </div>
    </div>
  );
}
