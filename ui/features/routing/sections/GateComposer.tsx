'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type RoutingPreview, type WorkflowGraph } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { getTaskTypeLabel } from '@/lib/taskTypes';
import { deleteConsequences, guardCreate, guardMutate, type GuardContext } from '@/lib/workflowGraphGuards';
import { type GateDraft, gateReplacementNotice } from '@/lib/workflowGraphGates';
import { AlertTriangle, Check, ShieldAlert, X } from 'lucide-react';

/**
 * Add, edit, override or remove a gate requirement on a transition.
 *
 * Same preview-then-commit contract as the transition and assignment composers, but gates
 * carry a consequence the others do not: gate resolution REPLACES rather than accumulates, at
 * two levels. Declaring the first workflow gate for an outcome drops the whole global set;
 * removing the last one brings it back. Both are stated before the operator commits, and both
 * also surface through the preview as introduced or resolved lint.
 *
 * Note there is no `scope_kind` input for requirements the way there is for rules — scope is
 * derived from sprint_id/project_id/sprint_type alone. project_id and sprint_type must always
 * be sent: without them the API writes to the GLOBAL table instead, which would silently
 * change every project.
 */

const CONTROL = 'w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-sm text-slate-200 focus:border-amber-500 focus:outline-none';
const FIELD_LABEL = 'mb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500';

export default function GateComposer({
  draft,
  graph,
  taskTypes,
  fieldSuggestions,
  context,
  onCancel,
  onCommitted,
}: {
  draft: GateDraft;
  graph: WorkflowGraph;
  taskTypes: string[];
  fieldSuggestions: string[];
  context: GuardContext;
  onCancel: () => void;
  onCommitted: () => void;
}) {
  const [form, setForm] = useState<GateDraft>(draft);
  const [preview, setPreview] = useState<RoutingPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState<'save' | 'delete'>('save');

  useEffect(() => {
    setForm(draft);
    setPreview(null);
    setError(null);
    setIntent('save');
  }, [draft]);

  const isCreate = form.requirement_id == null;
  const guard = isCreate
    ? guardCreate(context)
    : guardMutate(intent === 'delete' ? 'delete' : 'update', { is_override: form.is_override }, context);

  const replacement = gateReplacementNotice(form, graph);

  const update = <K extends keyof GateDraft>(key: K, value: GateDraft[K]) => {
    setForm(current => ({ ...current, [key]: value }));
    setPreview(null);
  };

  const payload = useCallback((): Record<string, unknown> => ({
    ...(form.requirement_id != null ? { id: form.requirement_id } : {}),
    // Always sent. Omitting either one drops the write into the global table.
    project_id: context.projectId,
    sprint_type: graph.scope.workflow_type,
    // Scope follows the ROW on edit and the selection on create, as elsewhere on this canvas.
    ...(isCreate
      ? (context.workflowId != null ? { sprint_id: context.workflowId } : {})
      : (form.is_override ? { sprint_id: context.workflowId } : {})),
    outcome: form.outcome,
    task_type: form.task_type,
    field_name: form.field_name.trim(),
    requirement_type: form.requirement_type,
    match_field: form.requirement_type === 'match' ? (form.match_field ?? '').trim() || null : null,
    severity: form.severity,
    message: form.message,
    enabled: form.enabled ? 1 : 0,
    priority: form.priority,
  }), [form, context, graph.scope.workflow_type, isCreate]);

  const runPreview = async (action: 'create' | 'update' | 'delete') => {
    setBusy(true);
    setError(null);
    setIntent(action === 'delete' ? 'delete' : 'save');
    try {
      setPreview(await api.previewRoutingChange({
        projectId: context.projectId,
        workflowType: graph.scope.workflow_type,
        workflowId: context.workflowId,
        operations: [{ entity: 'requirement', action, payload: payload() }],
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
      if (intent === 'delete' && form.requirement_id != null) {
        await api.deleteTransitionRequirement(
          form.requirement_id,
          form.is_override ? context.workflowId ?? undefined : undefined,
          context.projectId ?? undefined,
          graph.scope.workflow_type ?? undefined,
        );
      } else if (form.requirement_id != null) {
        await api.updateTransitionRequirement(form.requirement_id, payload());
      } else {
        await api.createTransitionRequirement(payload());
      }
      onCommitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canPreview = guard.allow && form.field_name.trim().length > 0
    && (form.requirement_type !== 'match' || (form.match_field ?? '').trim().length > 0);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">{form.title}</p>
          <p className="mt-1 text-sm font-semibold text-white">
            <span className="text-slate-500">on</span> {form.outcome}
          </p>
        </div>
        <button onClick={onCancel} className="text-slate-500 hover:text-slate-300" aria-label="Cancel">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* The replacement notice is the whole point of this composer. It is not a guard — the
          action is legitimate — it is the consequence nothing else in the app states. */}
      {replacement && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-950/25 p-2.5 text-xs text-amber-200">
          <p className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{replacement}
          </p>
        </div>
      )}

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
        <p className={FIELD_LABEL}>Field</p>
        <input
          className={CONTROL}
          list="gate-field-suggestions"
          value={form.field_name}
          placeholder="review_commit"
          onChange={e => update('field_name', e.target.value)}
        />
        <datalist id="gate-field-suggestions">
          {fieldSuggestions.map(name => <option key={name} value={name} />)}
        </datalist>
        <p className="mt-1 text-[11px] text-slate-500">
          Separate alternatives with <code className="text-slate-400">|</code> to accept any one of them.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className={FIELD_LABEL}>Check</p>
          <select
            className={CONTROL}
            value={form.requirement_type}
            onChange={e => update('requirement_type', e.target.value as GateDraft['requirement_type'])}
          >
            <option value="required">required</option>
            <option value="match">match</option>
            <option value="from_status">from_status</option>
          </select>
        </div>
        <div>
          <p className={FIELD_LABEL}>Severity</p>
          <select
            className={CONTROL}
            value={form.severity}
            onChange={e => update('severity', e.target.value as GateDraft['severity'])}
          >
            <option value="block">block</option>
            <option value="warn">warn</option>
          </select>
        </div>
      </div>

      {form.requirement_type === 'match' && (
        <div>
          <p className={FIELD_LABEL}>Must match</p>
          <input
            className={CONTROL}
            list="gate-field-suggestions"
            value={form.match_field ?? ''}
            onChange={e => update('match_field', e.target.value)}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className={FIELD_LABEL}>Task type</p>
          <select
            className={CONTROL}
            value={form.task_type ?? ''}
            onChange={e => update('task_type', e.target.value || null)}
          >
            <option value="">all task types</option>
            {taskTypes.map(type => <option key={type} value={type}>{getTaskTypeLabel(type)}</option>)}
          </select>
        </div>
        <div>
          <p className={FIELD_LABEL}>Priority</p>
          <input
            type="number"
            className={CONTROL}
            value={form.priority}
            onChange={e => update('priority', Number(e.target.value) || 0)}
          />
        </div>
      </div>

      <div>
        <p className={FIELD_LABEL}>Message</p>
        <input
          className={CONTROL}
          value={form.message}
          placeholder="Shown to the agent when the gate blocks"
          onChange={e => update('message', e.target.value)}
        />
      </div>

      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={e => update('enabled', e.target.checked)}
          className="rounded border-slate-600 bg-slate-800"
        />
        Enabled
      </label>

      {error && <p className="rounded-lg border border-red-500/40 bg-red-950/30 p-2 text-xs text-red-300">{error}</p>}

      {preview && (
        <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-900/70 p-2.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
            {intent === 'delete' ? 'Removing would' : 'Saving would'}
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
          {intent === 'delete' && deleteConsequences('requirement').map(note => (
            <p key={note} className="text-[11px] text-slate-400">{note}</p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {preview ? (
          <>
            <Button size="sm" variant="primary" onClick={commit} disabled={busy}>
              {busy ? 'Applying…' : intent === 'delete' ? 'Confirm remove' : 'Confirm'}
            </Button>
            <button onClick={() => setPreview(null)} className="text-xs text-slate-400 hover:text-slate-200">Back</button>
          </>
        ) : (
          <>
            <Button size="sm" variant="primary" onClick={() => runPreview(isCreate ? 'create' : 'update')} disabled={!canPreview || busy}>
              {busy ? 'Checking…' : 'Preview change'}
            </Button>
            {!isCreate && (
              <button
                onClick={() => runPreview('delete')}
                disabled={busy || !guardMutate('delete', { is_override: form.is_override }, context).allow}
                className="rounded-lg border border-red-500/40 px-2.5 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-950/30 disabled:opacity-40"
              >
                Remove…
              </button>
            )}
            <button onClick={onCancel} className="text-xs text-slate-400 hover:text-slate-200">Cancel</button>
          </>
        )}
      </div>
    </div>
  );
}
