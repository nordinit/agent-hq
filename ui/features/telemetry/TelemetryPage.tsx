'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { api, apiFetch } from '@/lib/api';
import type { Project, Task, TaskNote } from '@/lib/api';
import { useProjectFilterPreference } from '@/lib/projectFilterPreference';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertTriangle,
  ArrowUpDown,
  BarChart3,
  BookOpen,
  BrainCircuit,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Database,
  Eye,
  EyeOff,
  Filter,
  GitBranch,
  GripVertical,
  Info,
  LayoutPanelTop,
  Loader2,
  Lock,
  MessageSquare,
  Pencil,
  Plus,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  SplitSquareVertical,
  Sparkles,
  Tag,
  Target,
  TrendingUp,
  Trash2,
  ToggleLeft,
  ToggleRight,
  TrendingDown,
  User,
  Workflow,
  X,
  XCircle,
} from 'lucide-react';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cycleTime(created: string, updated: string): string {
  const ms = new Date(updated).getTime() - new Date(created).getTime();
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h === 0) return `${m}m`;
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function cycleMs(created: string, updated: string): number {
  return new Date(updated).getTime() - new Date(created).getTime();
}

function deriveQA(task: Task): 'Pass' | 'Needs review' | 'Rerouted' | 'Failed' | 'Cancelled' | 'In progress' | 'Pending' {
  const status = task.status as string;
  const activeInstanceId = (task as any).active_instance_id;
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'done') return 'Pass';
  if (status === 'review' && activeInstanceId) return 'In progress';
  if (status === 'review') return 'Needs review';
  if ((task as any).retry_count > 0) return 'Rerouted';
  if (status === 'in_progress') return 'In progress';
  return 'Pending';
}

function deriveConfidence(task: Task): number {
  let score = 0.85;
  if (task.priority === 'high') score += 0.05;
  if (task.priority === 'low') score -= 0.1;
  if ((task as any).retry_count > 0) score -= 0.12 * (task as any).retry_count;
  if (task.blockers && task.blockers.length > 0) score -= 0.05;
  if (!task.agent_name) score -= 0.15;
  return Math.min(0.99, Math.max(0.1, parseFloat(score.toFixed(2))));
}

function qaVariant(qa: string): 'done' | 'warn' | 'error' | 'info' | 'default' {
  if (qa === 'Pass') return 'done';
  if (qa === 'Needs review' || qa === 'In progress') return 'warn';
  if (qa === 'Failed' || qa === 'Cancelled') return 'error';
  if (qa === 'Rerouted') return 'error';
  return 'default';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

type SortKey = 'title' | 'routing' | 'qa' | 'cycle' | 'confidence' | 'priority' | 'created';
type SortDir = 'asc' | 'desc';

type FieldType = 'text' | 'textarea' | 'select' | 'boolean' | 'number' | 'date';

interface FieldVisibility {
  task_list: boolean;
  filters: boolean;
  task_form: boolean;
}

interface FieldConfig {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  enabled: boolean;
  options?: string[];
  default_value?: string;
  visibility?: FieldVisibility;
  editable_after_create?: boolean;
  analytics_enabled?: boolean;
  required_for_types?: string[];
}

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Textarea' },
  { value: 'select', label: 'Select (dropdown)' },
  { value: 'boolean', label: 'Boolean (toggle)' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
];

const DEFAULT_VISIBILITY: FieldVisibility = {
  task_list: false,
  filters: false,
  task_form: true,
};

function normalizeField(f: Partial<FieldConfig>): FieldConfig {
  return {
    key: f.key ?? '',
    label: f.label ?? '',
    type: f.type ?? 'text',
    required: f.required ?? false,
    enabled: f.enabled ?? true,
    options: f.options ?? [],
    default_value: f.default_value ?? '',
    visibility: f.visibility ?? { ...DEFAULT_VISIBILITY },
    editable_after_create: f.editable_after_create ?? true,
    analytics_enabled: f.analytics_enabled ?? true,
    required_for_types: f.required_for_types ?? [],
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FilterSelect({ label, options, value, onChange }: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="space-y-1.5">
      <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-200 outline-none transition-colors focus:border-amber-500"
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function SectionHeader({ icon: Icon, title, description, badge }: {
  icon: React.ElementType;
  title: string;
  description: string;
  badge?: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-3">
        <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-2.5">
          <Icon className="h-4 w-4 text-amber-400" />
        </div>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-semibold text-white">{title}</h2>
            {badge && <Badge variant="workspace">{badge}</Badge>}
          </div>
          <p className="mt-1 text-sm text-slate-400">{description}</p>
        </div>
      </div>
    </div>
  );
}

function SortButton({ col, current, dir, onClick }: {
  col: SortKey; current: SortKey; dir: SortDir; onClick: (k: SortKey) => void;
}) {
  const active = col === current;
  return (
    <button onClick={() => onClick(col)} className="flex items-center gap-1 hover:text-white transition-colors">
      <span>{col}</span>
      {active ? (dir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-30" />}
    </button>
  );
}

// ─── Toggle component ─────────────────────────────────────────────────────────

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${checked ? 'bg-amber-500' : 'bg-slate-600'}`}
      title={label}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
    </button>
  );
}

// ─── Options Editor ───────────────────────────────────────────────────────────

function OptionsEditor({ options, onChange }: { options: string[]; onChange: (opts: string[]) => void }) {
  const [newOpt, setNewOpt] = useState('');

  const add = () => {
    const v = newOpt.trim();
    if (!v || options.includes(v)) return;
    onChange([...options, v]);
    setNewOpt('');
  };

  const remove = (opt: string) => onChange(options.filter(o => o !== opt));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {options.map(opt => (
          <span key={opt} className="inline-flex items-center gap-1 rounded-full border border-slate-600 bg-slate-700/60 px-2.5 py-0.5 text-xs text-slate-200">
            {opt}
            <button type="button" onClick={() => remove(opt)} className="text-slate-400 hover:text-white">
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {options.length === 0 && <span className="text-xs text-slate-600">No options yet</span>}
      </div>
      <div className="flex gap-2">
        <input
          value={newOpt}
          onChange={e => setNewOpt(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="Add option…"
          className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-500/70"
        />
        <button
          type="button"
          onClick={add}
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-300 hover:border-amber-500/50 hover:text-white transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ─── Field Card ───────────────────────────────────────────────────────────────

function FieldCard({
  field,
  index,
  onUpdate,
  onDelete,
  saving,
  onSave,
}: {
  field: FieldConfig;
  index: number;
  onUpdate: (idx: number, updated: FieldConfig) => void;
  onDelete: (idx: number) => void;
  saving: boolean;
  onSave: (idx: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState<FieldConfig>({ ...field });

  // Sync if field prop changes externally (e.g. reload)
  useEffect(() => { setLocal({ ...field }); }, [field]);

  const patch = (partial: Partial<FieldConfig>) => setLocal(prev => ({ ...prev, ...partial }));
  const patchVisibility = (partial: Partial<FieldVisibility>) =>
    setLocal(prev => ({ ...prev, visibility: { ...(prev.visibility ?? DEFAULT_VISIBILITY), ...partial } }));

  const handleSave = () => {
    onUpdate(index, local);
    onSave(index);
    setEditing(false);
  };

  const handleDiscard = () => {
    setLocal({ ...field });
    setEditing(false);
  };

  const isSystem = ['source', 'routing', 'confidence', 'scope_size', 'assumptions', 'open_questions', 'needs_split', 'expected_artifact', 'success_mode', 'raw_input'].includes(field.key);

  return (
    <div className={`rounded-2xl border transition-colors ${field.enabled ? 'border-slate-700/70 bg-slate-800/40' : 'border-slate-700/40 bg-slate-900/30 opacity-60'}`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="flex items-start gap-3 min-w-0">
          <GripVertical className="h-4 w-4 text-slate-600 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm font-medium text-amber-300">{field.key}</span>
              {isSystem && (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-600/50 bg-slate-700/40 px-2 py-0.5 text-[10px] text-slate-400">
                  <Lock className="h-2.5 w-2.5" /> system
                </span>
              )}
              {!field.enabled && (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-600/50 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500">
                  inactive
                </span>
              )}
            </div>
            <p className="text-sm text-slate-300 mt-0.5">{field.label}</p>
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              <span className="rounded-md border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-400">{field.type}</span>
              {field.required && <span className="text-[10px] text-rose-400 font-medium">required</span>}
              {field.analytics_enabled && <span className="text-[10px] text-violet-400">analytics</span>}
              {field.visibility?.task_list && <span className="text-[10px] text-blue-400">task list</span>}
              {field.visibility?.filters && <span className="text-[10px] text-cyan-400">filters</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setEditing(e => !e)}
            className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-400 hover:border-amber-500/50 hover:text-amber-400 transition-colors"
            title="Edit field"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => { patch({ enabled: !field.enabled }); onUpdate(index, { ...field, enabled: !field.enabled }); onSave(index); }}
            className={`rounded-lg border p-1.5 transition-colors ${field.enabled ? 'border-slate-700 bg-slate-800 text-slate-400 hover:text-amber-400 hover:border-amber-500/50' : 'border-green-800/50 bg-green-900/20 text-green-400 hover:border-green-600'}`}
            title={field.enabled ? 'Deactivate field' : 'Activate field'}
          >
            {field.enabled ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
          {!isSystem && (
            <button
              type="button"
              onClick={() => onDelete(index)}
              className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-500 hover:border-red-800/50 hover:text-red-400 transition-colors"
              title="Delete field"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Edit panel */}
      {editing && (
        <div className="border-t border-slate-700/60 px-4 py-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {/* Key */}
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Field key</span>
              <input
                value={local.key}
                onChange={e => patch({ key: e.target.value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') })}
                disabled={isSystem}
                placeholder="field_key"
                className="w-full rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2.5 font-mono text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-500/70 disabled:opacity-50"
              />
            </label>
            {/* Label */}
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Display label</span>
              <input
                value={local.label}
                onChange={e => patch({ label: e.target.value })}
                placeholder="Human-readable label"
                className="w-full rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-500/70"
              />
            </label>
            {/* Type */}
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Field type</span>
              <select
                value={local.type}
                onChange={e => patch({ type: e.target.value as FieldType })}
                className="w-full rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-amber-500/70"
              >
                {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            {/* Default value */}
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Default value</span>
              <input
                value={local.default_value ?? ''}
                onChange={e => patch({ default_value: e.target.value })}
                placeholder="Leave blank for none"
                className="w-full rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-500/70"
              />
            </label>
          </div>

          {/* Options (select type only) */}
          {local.type === 'select' && (
            <div className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Allowed values</span>
              <OptionsEditor options={local.options ?? []} onChange={opts => patch({ options: opts })} />
            </div>
          )}

          {/* Flags grid */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {/* Required */}
            <div className="flex items-center justify-between rounded-xl border border-slate-700/60 bg-slate-900/50 px-3 py-2.5">
              <div>
                <p className="text-sm text-slate-300">Required</p>
                <p className="text-[11px] text-slate-500">Must be filled on creation</p>
              </div>
              <Toggle checked={local.required} onChange={v => patch({ required: v })} />
            </div>
            {/* Enabled */}
            <div className="flex items-center justify-between rounded-xl border border-slate-700/60 bg-slate-900/50 px-3 py-2.5">
              <div>
                <p className="text-sm text-slate-300">Active</p>
                <p className="text-[11px] text-slate-500">Show field in UI</p>
              </div>
              <Toggle checked={local.enabled} onChange={v => patch({ enabled: v })} />
            </div>
            {/* Editable after create */}
            <div className="flex items-center justify-between rounded-xl border border-slate-700/60 bg-slate-900/50 px-3 py-2.5">
              <div>
                <p className="text-sm text-slate-300">Editable after create</p>
                <p className="text-[11px] text-slate-500">Can be changed post-creation</p>
              </div>
              <Toggle checked={local.editable_after_create ?? true} onChange={v => patch({ editable_after_create: v })} />
            </div>
            {/* Analytics */}
            <div className="flex items-center justify-between rounded-xl border border-slate-700/60 bg-slate-900/50 px-3 py-2.5">
              <div>
                <p className="text-sm text-slate-300">Analytics enabled</p>
                <p className="text-[11px] text-slate-500">Include in telemetry reports</p>
              </div>
              <Toggle checked={local.analytics_enabled ?? true} onChange={v => patch({ analytics_enabled: v })} />
            </div>
            {/* Show in task list */}
            <div className="flex items-center justify-between rounded-xl border border-slate-700/60 bg-slate-900/50 px-3 py-2.5">
              <div>
                <p className="text-sm text-slate-300">Show in task list</p>
                <p className="text-[11px] text-slate-500">Visible as a column in task tables</p>
              </div>
              <Toggle checked={local.visibility?.task_list ?? false} onChange={v => patchVisibility({ task_list: v })} />
            </div>
            {/* Show in filters */}
            <div className="flex items-center justify-between rounded-xl border border-slate-700/60 bg-slate-900/50 px-3 py-2.5">
              <div>
                <p className="text-sm text-slate-300">Show in filters</p>
                <p className="text-[11px] text-slate-500">Available as a filter control</p>
              </div>
              <Toggle checked={local.visibility?.filters ?? false} onChange={v => patchVisibility({ filters: v })} />
            </div>
          </div>

          {/* Required for task types */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Required for task types</span>
            <div className="text-xs text-slate-500 mb-2">Override required rule for specific task types (e.g. "bug", "feature", "chore")</div>
            <OptionsEditor
              options={local.required_for_types ?? []}
              onChange={types => patch({ required_for_types: types })}
            />
          </div>

          {/* Save / discard */}
          <div className="flex gap-2 pt-1">
            <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
              <Save className="h-3.5 w-3.5" />
              Save field
            </Button>
            <Button variant="ghost" size="sm" onClick={handleDiscard}>
              Discard
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Add Field Form ───────────────────────────────────────────────────────────

function AddFieldForm({ existingKeys, onAdd, onCancel }: {
  existingKeys: string[];
  onAdd: (field: FieldConfig) => void;
  onCancel: () => void;
}) {
  const [field, setField] = useState<FieldConfig>(normalizeField({ enabled: true }));
  const [error, setError] = useState('');

  const patch = (partial: Partial<FieldConfig>) => setField(prev => ({ ...prev, ...partial }));
  const patchVisibility = (partial: Partial<FieldVisibility>) =>
    setField(prev => ({ ...prev, visibility: { ...(prev.visibility ?? DEFAULT_VISIBILITY), ...partial } }));

  const submit = () => {
    if (!field.key) { setError('Field key is required'); return; }
    if (existingKeys.includes(field.key)) { setError(`Key "${field.key}" already exists`); return; }
    if (!/^[a-z][a-z0-9_]*$/.test(field.key)) { setError('Key must start with a letter, use only lowercase letters, numbers, underscores'); return; }
    onAdd(field);
  };

  return (
    <div className="rounded-2xl border border-amber-700/30 bg-amber-900/10 px-4 py-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Plus className="h-4 w-4 text-amber-400" />
          <h3 className="text-sm font-semibold text-white">New metadata field</h3>
        </div>
        <button type="button" onClick={onCancel} className="text-slate-500 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-900/20 px-3 py-2 text-sm text-red-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Field key *</span>
          <input
            value={field.key}
            onChange={e => { setError(''); patch({ key: e.target.value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') }); }}
            placeholder="e.g. priority_reason"
            className="w-full rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2.5 font-mono text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-500/70"
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Display label *</span>
          <input
            value={field.label}
            onChange={e => patch({ label: e.target.value })}
            placeholder="e.g. Priority Reason"
            className="w-full rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-500/70"
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Field type</span>
          <select
            value={field.type}
            onChange={e => patch({ type: e.target.value as FieldType })}
            className="w-full rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-amber-500/70"
          >
            {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Default value</span>
          <input
            value={field.default_value ?? ''}
            onChange={e => patch({ default_value: e.target.value })}
            placeholder="Optional"
            className="w-full rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-500/70"
          />
        </label>
      </div>

      {field.type === 'select' && (
        <div className="space-y-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Allowed values</span>
          <OptionsEditor options={field.options ?? []} onChange={opts => patch({ options: opts })} />
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex items-center justify-between rounded-xl border border-slate-700/60 bg-slate-900/50 px-3 py-2.5">
          <p className="text-sm text-slate-300">Required</p>
          <Toggle checked={field.required} onChange={v => patch({ required: v })} />
        </div>
        <div className="flex items-center justify-between rounded-xl border border-slate-700/60 bg-slate-900/50 px-3 py-2.5">
          <p className="text-sm text-slate-300">Analytics</p>
          <Toggle checked={field.analytics_enabled ?? true} onChange={v => patch({ analytics_enabled: v })} />
        </div>
        <div className="flex items-center justify-between rounded-xl border border-slate-700/60 bg-slate-900/50 px-3 py-2.5">
          <p className="text-sm text-slate-300">Show in filters</p>
          <Toggle checked={field.visibility?.filters ?? false} onChange={v => patchVisibility({ filters: v })} />
        </div>
      </div>

      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={submit}>
          <Plus className="h-3.5 w-3.5" />
          Add field
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ─── Schema Config Tab ────────────────────────────────────────────────────────

function SchemaConfigTab() {
  const [fields, setFields] = useState<FieldConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedIdx, setSavedIdx] = useState<number | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    apiFetch<{ fields: FieldConfig[]; updated_at?: string }>('/api/v1/telemetry/schema-config')
      .then(data => {
        setFields((data.fields ?? []).map(normalizeField));
        setLastUpdated(data.updated_at ?? null);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveAll = useCallback(async (updatedFields: FieldConfig[]) => {
    setSaving(true);
    setError('');
    try {
      const result = await apiFetch<{ fields: FieldConfig[]; updated_at?: string }>(
        '/api/v1/telemetry/schema-config',
        { method: 'PUT', body: JSON.stringify({ fields: updatedFields, description: 'Updated config' }) }
      );
      setFields((result.fields ?? updatedFields).map(normalizeField));
      setLastUpdated(result.updated_at ?? null);
      setSuccessMsg('Saved');
      setTimeout(() => setSuccessMsg(''), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
      setSavedIdx(null);
    }
  }, []);

  const handleUpdate = (idx: number, updated: FieldConfig) => {
    setFields(prev => prev.map((f, i) => i === idx ? updated : f));
  };

  const handleSave = (idx: number) => {
    setSavedIdx(idx);
    const updated = fields.map((f, i) => i === idx ? f : f);
    saveAll(updated);
  };

  const handleDelete = (idx: number) => {
    if (!confirm(`Delete field "${fields[idx].key}"? This cannot be undone.`)) return;
    const updated = fields.filter((_, i) => i !== idx);
    setFields(updated);
    saveAll(updated);
  };

  const handleAdd = (field: FieldConfig) => {
    const updated = [...fields, field];
    setFields(updated);
    setShowAddForm(false);
    saveAll(updated);
  };

  const activeCount = fields.filter(f => f.enabled).length;
  const analyticsCount = fields.filter(f => f.analytics_enabled).length;

  return (
    <div className="space-y-6">
      {/* Section header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <SectionHeader
          icon={Settings2}
          title="Metadata Schema"
          description="Configure task metadata fields — what gets captured, how it's displayed, and what drives telemetry analytics."
          badge="Admin"
        />
        <div className="flex items-center gap-2 shrink-0">
          {successMsg && (
            <span className="flex items-center gap-1.5 text-sm text-green-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {successMsg}
            </span>
          )}
          <Button variant="primary" size="sm" onClick={() => setShowAddForm(true)} disabled={showAddForm}>
            <Plus className="h-3.5 w-3.5" />
            Add field
          </Button>
        </div>
      </div>

      {/* Stats row */}
      {!loading && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Total fields', value: String(fields.length), icon: Database, tone: 'text-blue-300' },
            { label: 'Active', value: String(activeCount), icon: Eye, tone: 'text-green-300' },
            { label: 'Inactive', value: String(fields.length - activeCount), icon: EyeOff, tone: 'text-slate-400' },
            { label: 'Analytics', value: String(analyticsCount), icon: BarChart3, tone: 'text-violet-300' },
          ].map(({ label, value, icon: Icon, tone }) => (
            <div key={label} className="rounded-xl border border-slate-700/70 bg-slate-800/40 px-4 py-3 flex items-center justify-between gap-2">
              <div>
                <p className="text-[11px] uppercase tracking-[0.15em] text-slate-500">{label}</p>
                <p className={`mt-1.5 text-xl font-bold ${tone}`}>{value}</p>
              </div>
              <Icon className={`h-5 w-5 ${tone} opacity-70`} />
            </div>
          ))}
        </div>
      )}

      {/* Last updated */}
      {lastUpdated && (
        <p className="text-xs text-slate-600">
          Last saved: {formatDate(lastUpdated)}
        </p>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center gap-3 py-12 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading schema config…</span>
        </div>
      )}

      {/* Add form */}
      {showAddForm && (
        <AddFieldForm
          existingKeys={fields.map(f => f.key)}
          onAdd={handleAdd}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* Field cards */}
      {!loading && (
        <div className="space-y-3">
          {/* Active fields */}
          {fields.filter(f => f.enabled).map((field, i) => {
            const realIdx = fields.findIndex(f => f.key === field.key);
            return (
              <FieldCard
                key={field.key}
                field={field}
                index={realIdx}
                onUpdate={handleUpdate}
                onDelete={handleDelete}
                saving={saving && savedIdx === realIdx}
                onSave={handleSave}
              />
            );
          })}

          {/* Inactive fields section */}
          {fields.some(f => !f.enabled) && (
            <div className="pt-2">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-600 mb-2 pl-1">Inactive fields</p>
              {fields.filter(f => !f.enabled).map(field => {
                const realIdx = fields.findIndex(f => f.key === field.key);
                return (
                  <FieldCard
                    key={field.key}
                    field={field}
                    index={realIdx}
                    onUpdate={handleUpdate}
                    onDelete={handleDelete}
                    saving={saving && savedIdx === realIdx}
                    onSave={handleSave}
                  />
                );
              })}
            </div>
          )}

          {fields.length === 0 && !showAddForm && (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/20 py-12 text-center">
              <Settings2 className="h-8 w-8 text-slate-600 mx-auto mb-3" />
              <p className="text-sm text-slate-500">No schema fields configured yet.</p>
              <button
                type="button"
                onClick={() => setShowAddForm(true)}
                className="mt-3 text-sm text-amber-400 hover:text-amber-300 transition-colors"
              >
                Add your first field →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Detail Drawer ────────────────────────────────────────────────────────────

function DetailDrawer({ task, onClose }: { task: Task; onClose: () => void }) {
  const [notes, setNotes] = useState<TaskNote[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [loadingNotes, setLoadingNotes] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getTaskNotes(task.id),
      api.getTaskHistory(task.id).catch(() => []),
    ]).then(([n, h]) => {
      setNotes(n);
      setHistory(h);
    }).finally(() => setLoadingNotes(false));
  }, [task.id]);

  const qa = deriveQA(task);
  const conf = deriveConfidence(task);
  const retry = (task as any).retry_count ?? 0;
  const isRerouted = retry > 0;
  const isSplit = task.blocking && task.blocking.length > 0;
  const isBlocked = task.blockers && task.blockers.length > 0;
  const routingReason = (task as any).routing_reason;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative h-full w-full max-w-2xl overflow-y-auto bg-slate-900 shadow-2xl border-l border-slate-700/60"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-700/60 bg-slate-900/95 px-6 py-4 backdrop-blur">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-xs font-mono text-slate-500">#{task.id}</span>
              <Badge variant={qaVariant(qa)}>{qa}</Badge>
              <Badge variant={task.priority === 'high' ? 'running' : task.priority === 'medium' ? 'info' : 'default'}>
                {task.priority}
              </Badge>
            </div>
            <h2 className="text-base font-semibold text-white leading-snug">{task.title}</h2>
          </div>
          <button onClick={onClose} className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-slate-400 hover:text-white transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6 p-6">
          {/* Outcome summary */}
          <section>
            <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500 mb-3">Outcome summary</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'QA Result', value: qa, tone: qaVariant(qa) === 'done' ? 'text-green-300' : qaVariant(qa) === 'warn' ? 'text-amber-300' : 'text-red-300' },
                { label: 'Confidence', value: conf.toFixed(2), tone: conf >= 0.8 ? 'text-green-300' : conf >= 0.6 ? 'text-amber-300' : 'text-red-300' },
                { label: 'Reroutes', value: String(retry), tone: retry === 0 ? 'text-slate-300' : 'text-red-300' },
                { label: 'Cycle time', value: cycleTime(task.created_at, task.updated_at), tone: 'text-slate-300' },
              ].map(({ label, value, tone }) => (
                <div key={label} className="rounded-xl border border-slate-700 bg-slate-800/50 p-3">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</p>
                  <p className={`mt-2 text-base font-semibold ${tone}`}>{value}</p>
                </div>
              ))}
            </div>
            {/* Flags */}
            <div className="mt-3 flex flex-wrap gap-2">
              {isRerouted && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-red-800/50 bg-red-900/20 px-3 py-1 text-xs text-red-300">
                  <GitBranch className="h-3 w-3" /> Rerouted ×{retry}
                </span>
              )}
              {isSplit && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-800/50 bg-violet-900/20 px-3 py-1 text-xs text-violet-300">
                  <SplitSquareVertical className="h-3 w-3" /> Blocking {task.blocking!.length} task(s)
                </span>
              )}
              {isBlocked && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-800/50 bg-amber-900/20 px-3 py-1 text-xs text-amber-300">
                  <AlertTriangle className="h-3 w-3" /> {task.blockers!.length} blocker(s)
                </span>
              )}
              {!isRerouted && !isSplit && !isBlocked && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/50 px-3 py-1 text-xs text-slate-400">
                  <CheckCircle2 className="h-3 w-3 text-green-400" /> Clean — no flags
                </span>
              )}
            </div>
          </section>

          {/* Original metadata */}
          <section>
            <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500 mb-3">Original metadata</h3>
            <div className="rounded-2xl border border-slate-700/60 bg-slate-800/40 divide-y divide-slate-700/40">
              {[
                { icon: User, label: 'Assigned agent', value: task.agent_name ?? '—' },
                { icon: Tag, label: 'Agent', value: (task as any).agent_name ?? '—' },
                { icon: Target, label: 'Workflow', value: (task as any).sprint_name ?? 'No workflow' },
                { icon: Clock3, label: 'Created', value: formatDate(task.created_at) },
                { icon: Clock3, label: 'Last updated', value: formatDate(task.updated_at) },
                ...(routingReason ? [{ icon: GitBranch, label: 'Routing reason', value: routingReason }] : []),
                ...((task as any).dispatched_at ? [{ icon: Info, label: 'Accepted at', value: formatDate((task as any).dispatched_at) }] : []),
                ...((task as any).claimed_at ? [{ icon: Info, label: 'Claimed at', value: formatDate((task as any).claimed_at) }] : []),
              ].map(({ icon: Icon, label, value }) => (
                <div key={label} className="flex items-start gap-3 px-4 py-2.5">
                  <Icon className="h-4 w-4 text-slate-500 mt-0.5 shrink-0" />
                  <span className="text-sm text-slate-400 w-32 shrink-0">{label}</span>
                  <span className="text-sm text-slate-200">{value}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Request summary */}
          <section>
            <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500 mb-3">Request summary</h3>
            <div className="rounded-2xl border border-slate-700/60 bg-slate-800/40 px-4 py-3">
              <pre className="whitespace-pre-wrap text-sm text-slate-300 font-sans leading-6 max-h-48 overflow-y-auto">
                {task.description || 'No description provided.'}
              </pre>
            </div>
          </section>

          {/* Blockers / blocking */}
          {(isBlocked || isSplit) && (
            <section>
              <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500 mb-3">Routing dependencies</h3>
              <div className="space-y-2">
                {isBlocked && task.blockers!.map(b => (
                  <div key={b.id} className="rounded-xl border border-amber-800/30 bg-amber-900/10 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                      <span className="text-xs text-amber-300 font-medium">Blocked by #{b.id}</span>
                      <Badge variant={b.status === 'done' ? 'done' : 'warn'}>{b.status}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-slate-300 ml-5">{b.title}</p>
                  </div>
                ))}
                {isSplit && task.blocking!.map(b => (
                  <div key={b.id} className="rounded-xl border border-violet-800/30 bg-violet-900/10 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <SplitSquareVertical className="h-3.5 w-3.5 text-violet-400 shrink-0" />
                      <span className="text-xs text-violet-300 font-medium">Blocking #{b.id}</span>
                      <Badge variant={b.status === 'done' ? 'done' : 'warn'}>{b.status}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-slate-300 ml-5">{b.title}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Notes timeline */}
          <section>
            <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500 mb-3 flex items-center gap-2">
              <MessageSquare className="h-3.5 w-3.5" />
              Notes timeline
              {!loadingNotes && <span className="text-slate-600">({notes.length})</span>}
            </h3>
            {loadingNotes ? (
              <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading notes…
              </div>
            ) : notes.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-700 bg-slate-800/30 px-4 py-6 text-center text-sm text-slate-500">
                No notes on this task yet
              </div>
            ) : (
              <div className="space-y-3">
                {notes.map(note => (
                  <div key={note.id} className="rounded-xl border border-slate-700/60 bg-slate-800/40 px-4 py-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-xs font-medium text-slate-400">{note.author}</span>
                      <span className="text-xs text-slate-600">{formatDate(note.created_at)}</span>
                    </div>
                    <p className="text-sm text-slate-200 leading-6 whitespace-pre-wrap">{note.content}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* History */}
          {history.length > 0 && (
            <section>
              <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500 mb-3">Status history</h3>
              <div className="space-y-2">
                {history.map((h: any, i: number) => (
                  <div key={i} className="flex items-center gap-3 text-sm">
                    <span className="text-xs text-slate-600 w-28 shrink-0">{formatDate(h.changed_at ?? h.created_at)}</span>
                    <Badge variant="default">{h.from_status ?? '—'}</Badge>
                    <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
                    <Badge variant="info">{h.to_status ?? h.status}</Badge>
                    {h.changed_by && <span className="text-slate-500 text-xs">by {h.changed_by}</span>}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Task Review Tab ──────────────────────────────────────────────────────────

function TaskReviewTab({ selectedProjectId, selectedProjectName }: { selectedProjectId: number | null; selectedProjectName: string | null }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterPriority, setFilterPriority] = useState('all');
  const [filterJob, setFilterJob] = useState('all');
  const [sortKey, setSortKey] = useState<SortKey>('created');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selected, setSelected] = useState<Task | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.getTasks(selectedProjectId ?? undefined)
      .then(setTasks)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedProjectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setSelected(null); }, [selectedProjectId]);

  const kpis = useMemo(() => {
    const t = tasks;
    const total = t.length;
    if (total === 0) return [];
    const done = t.filter(x => x.status === 'done').length;
    const rerouted = t.filter(x => (x as any).retry_count > 0).length;
    const blocked = t.filter(x => x.blockers && x.blockers.length > 0).length;
    const withJob = t.filter(x => x.agent_name).length;
    const cycleTimes = t.map(x => cycleMs(x.created_at, x.updated_at));
    const avgMs = cycleTimes.reduce((a, b) => a + b, 0) / total;
    const avgH = (avgMs / 3_600_000).toFixed(1);
    return [
      { label: 'Total Tasks', value: String(total), change: selectedProjectName ?? 'All projects', tone: 'text-blue-300', icon: LayoutPanelTop },
      { label: 'First-Pass Rate', value: `${((done / total) * 100).toFixed(1)}%`, change: `${done} done`, tone: 'text-green-300', icon: CheckCircle2 },
      { label: 'Reroute Rate', value: `${((rerouted / total) * 100).toFixed(1)}%`, change: `${rerouted} rerouted`, tone: 'text-amber-300', icon: GitBranch },
      { label: 'Blocked Rate', value: `${((blocked / total) * 100).toFixed(1)}%`, change: `${blocked} blocked`, tone: 'text-rose-300', icon: ShieldCheck },
      { label: 'Agent Coverage', value: `${((withJob / total) * 100).toFixed(1)}%`, change: `${withJob} assigned`, tone: 'text-violet-300', icon: SplitSquareVertical },
      { label: 'Avg Cycle Time', value: `${avgH}h`, change: 'Across all tasks', tone: 'text-cyan-300', icon: Clock3 },
    ];
  }, [tasks, selectedProjectName]);

  const jobOptions = useMemo(() => {
    const jobs = [...new Set(tasks.map(t => t.agent_name).filter(Boolean))];
    return [{ value: 'all', label: 'All agents' }, ...jobs.map(j => ({ value: j!, label: j! }))];
  }, [tasks]);

  const rows = useMemo(() => {
    let filtered = tasks.filter(t => {
      if (filterStatus !== 'all' && t.status !== filterStatus) return false;
      if (filterPriority !== 'all' && t.priority !== filterPriority) return false;
      if (filterJob !== 'all' && t.agent_name !== filterJob) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!t.title.toLowerCase().includes(q) &&
            !(t.description || '').toLowerCase().includes(q) &&
            !(t.agent_name || '').toLowerCase().includes(q) &&
            !String(t.id).includes(q)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'title':   cmp = a.title.localeCompare(b.title); break;
        case 'routing': cmp = (a.agent_name ?? '').localeCompare(b.agent_name ?? ''); break;
        case 'qa':      cmp = deriveQA(a).localeCompare(deriveQA(b)); break;
        case 'cycle':   cmp = cycleMs(a.created_at, a.updated_at) - cycleMs(b.created_at, b.updated_at); break;
        case 'confidence': cmp = deriveConfidence(a) - deriveConfidence(b); break;
        case 'priority': {
          const p = { high: 2, medium: 1, low: 0 };
          cmp = (p[a.priority] ?? 0) - (p[b.priority] ?? 0);
          break;
        }
        case 'created': cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime(); break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return filtered;
  }, [tasks, filterStatus, filterPriority, filterJob, search, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  return (
    <div className="space-y-6 md:space-y-8" data-tour-target="telemetry-main">
      {/* KPI cards */}
      {!loading && kpis.length > 0 && (
        <section>
          <SectionHeader
            icon={BarChart3}
            title="Overview"
            description={selectedProjectName ? `Live KPIs derived from task data for ${selectedProjectName}.` : 'Live KPIs derived from task data across all projects.'}
            badge="Live"
          />
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {kpis.map(({ label, value, change, tone, icon: Icon }) => (
              <Card key={label} className="border-slate-700/70 bg-slate-800/55">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm text-slate-400">{label}</p>
                    <p className={`mt-2 text-3xl font-bold ${tone}`}>{value}</p>
                    <p className="mt-1 text-xs text-slate-500">{change}</p>
                  </div>
                  <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-2.5">
                    <Icon className={`h-5 w-5 ${tone}`} />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Filter bar */}
      <Card className="border-slate-700/70 bg-slate-800/50">
        <SectionHeader
          icon={Filter}
          title="Filters"
          description="Narrow by project, status, priority, job, or search by title/description."
          badge="Controls"
        />
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <FilterSelect
            label="Status"
            value={filterStatus}
            onChange={setFilterStatus}
            options={[
              { value: 'all', label: 'All statuses' },
              { value: 'todo', label: 'Todo' },
              { value: 'in_progress', label: 'In progress' },
              { value: 'review', label: 'Review' },
              { value: 'done', label: 'Done' },
              { value: 'cancelled', label: 'Cancelled' },
            ]}
          />
          <FilterSelect
            label="Priority"
            value={filterPriority}
            onChange={setFilterPriority}
            options={[
              { value: 'all', label: 'All priorities' },
              { value: 'high', label: 'High' },
              { value: 'medium', label: 'Medium' },
              { value: 'low', label: 'Low' },
            ]}
          />
          <FilterSelect
            label="Agent"
            value={filterJob}
            onChange={setFilterJob}
            options={jobOptions}
          />
          <div className="xl:col-span-2 space-y-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Search</span>
            <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2.5">
              <Search className="h-4 w-4 text-slate-500 shrink-0" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Task title, ID, description…"
                className="w-full bg-transparent text-sm text-slate-200 outline-none placeholder:text-slate-500"
              />
              {search && (
                <button onClick={() => setSearch('')} className="text-slate-500 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <div className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1">
            <CalendarRange className="h-3.5 w-3.5" />
            All time
          </div>
          <div className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1">
            <Target className="h-3.5 w-3.5" />
            {selectedProjectName ?? 'All Projects'}
          </div>
          <div className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1">
            <Workflow className="h-3.5 w-3.5" />
            {rows.length} matching rows
          </div>
        </div>
      </Card>

      {/* Review table */}
      <section className="space-y-4">
        <SectionHeader
          icon={Search}
          title="Task quality review"
          description="Searchable, sortable table of all tasks. Click any row to open the full drilldown drawer."
          badge="Live data"
        />

        <Card className="overflow-hidden border-slate-700/70 bg-slate-800/55 p-0">
          {/* Table header */}
          <div className="hidden md:grid grid-cols-[2.5fr_1.2fr_0.9fr_0.8fr_0.6fr_0.6fr_0.6fr] gap-3 border-b border-slate-700/60 bg-slate-900/70 px-5 py-3 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
            <SortButton col="title" current={sortKey} dir={sortDir} onClick={handleSort} />
            <SortButton col="routing" current={sortKey} dir={sortDir} onClick={handleSort} />
            <SortButton col="qa" current={sortKey} dir={sortDir} onClick={handleSort} />
            <span>Flags</span>
            <SortButton col="cycle" current={sortKey} dir={sortDir} onClick={handleSort} />
            <SortButton col="confidence" current={sortKey} dir={sortDir} onClick={handleSort} />
            <SortButton col="priority" current={sortKey} dir={sortDir} onClick={handleSort} />
          </div>

          {loading && (
            <div className="flex items-center justify-center gap-3 py-16 text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading tasks…</span>
            </div>
          )}

          {!loading && rows.length === 0 && (
            <div className="py-16 text-center text-sm text-slate-500">
              No tasks match the current filters. This can also mean the current dev dataset is empty, not just that your filters excluded results.
            </div>
          )}

          {!loading && rows.length > 0 && (
            <div className="hidden md:block">
              {rows.map(task => {
                const qa = deriveQA(task);
                const conf = deriveConfidence(task);
                const retry = (task as any).retry_count ?? 0;
                const isBlocked = task.blockers && task.blockers.length > 0;
                const isSplit = task.blocking && task.blocking.length > 0;

                return (
                  <button
                    key={task.id}
                    onClick={() => setSelected(task)}
                    className="grid w-full grid-cols-[2.5fr_1.2fr_0.9fr_0.8fr_0.6fr_0.6fr_0.6fr] gap-3 items-center border-b border-slate-700/40 px-5 py-3.5 text-left transition-colors hover:bg-slate-900/50"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-[11px] font-mono text-slate-600">#{task.id}</span>
                      </div>
                      <p className="text-sm font-medium text-white truncate">{task.title}</p>
                      {(task as any).sprint_name && (
                        <p className="text-xs text-slate-500 truncate mt-0.5">{(task as any).sprint_name}</p>
                      )}
                    </div>
                    <span className="text-xs text-slate-300 truncate">{task.agent_name ?? <span className="text-slate-600">Unassigned</span>}</span>
                    <span><Badge variant={qaVariant(qa)}>{qa}</Badge></span>
                    <div className="flex flex-wrap gap-1">
                      {retry > 0 && <span className="rounded-full border border-red-800/40 bg-red-900/20 px-1.5 py-0.5 text-[10px] text-red-300">×{retry}</span>}
                      {isSplit && <span className="rounded-full border border-violet-800/40 bg-violet-900/20 px-1.5 py-0.5 text-[10px] text-violet-300">split</span>}
                      {isBlocked && <span className="rounded-full border border-amber-800/40 bg-amber-900/20 px-1.5 py-0.5 text-[10px] text-amber-300">blocked</span>}
                      {!retry && !isSplit && !isBlocked && <span className="text-[10px] text-slate-600">—</span>}
                    </div>
                    <span className="text-xs text-slate-300">{cycleTime(task.created_at, task.updated_at)}</span>
                    <span className={`text-xs font-mono ${conf >= 0.8 ? 'text-green-300' : conf >= 0.6 ? 'text-amber-300' : 'text-red-300'}`}>
                      {conf.toFixed(2)}
                    </span>
                    <span className="flex items-center justify-between">
                      <Badge variant={task.priority === 'high' ? 'running' : task.priority === 'medium' ? 'info' : 'default'}>{task.priority}</Badge>
                      <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Mobile cards */}
          {!loading && rows.length > 0 && (
            <div className="space-y-3 p-4 md:hidden">
              {rows.map(task => {
                const qa = deriveQA(task);
                const conf = deriveConfidence(task);
                const retry = (task as any).retry_count ?? 0;
                const isBlocked = task.blockers && task.blockers.length > 0;
                const isSplit = task.blocking && task.blocking.length > 0;
                return (
                  <button
                    key={task.id}
                    onClick={() => setSelected(task)}
                    className="w-full rounded-2xl border border-slate-700 bg-slate-900/70 p-4 text-left"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs text-slate-600 font-mono mb-0.5">#{task.id}</p>
                        <p className="text-sm font-medium text-white">{task.title}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{task.agent_name ?? 'No agent assigned'}</p>
                      </div>
                      <ChevronRight className="mt-0.5 h-4 w-4 text-slate-600 shrink-0" />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <Badge variant={qaVariant(qa)}>{qa}</Badge>
                      <Badge variant={task.priority === 'high' ? 'running' : task.priority === 'medium' ? 'info' : 'default'}>{task.priority}</Badge>
                      {retry > 0 && <span className="rounded-full border border-red-800/40 bg-red-900/20 px-1.5 py-0.5 text-[10px] text-red-300">×{retry} reroute</span>}
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-slate-500">
                      <div>
                        <span className="block uppercase tracking-[0.12em]">Cycle</span>
                        <span className="mt-0.5 block text-sm text-slate-300">{cycleTime(task.created_at, task.updated_at)}</span>
                      </div>
                      <div>
                        <span className="block uppercase tracking-[0.12em]">Confidence</span>
                        <span className={`mt-0.5 block text-sm font-mono ${conf >= 0.8 ? 'text-green-300' : conf >= 0.6 ? 'text-amber-300' : 'text-red-300'}`}>{conf.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="block uppercase tracking-[0.12em]">Workflow</span>
                        <span className="mt-0.5 block text-sm text-slate-300 truncate">{(task as any).sprint_name ?? '—'}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      </section>

      {selected && <DetailDrawer task={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type ActiveTab = 'review' | 'schema';

function TelemetryPage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('review');
  const [projects, setProjects] = useState<Project[]>([]);
  const validProjectIds = useMemo(() => projects.map(project => project.id), [projects]);
  const [selectedProjectId, setSelectedProjectId] = useProjectFilterPreference({ validProjectIds });
  const selectedProject = useMemo(
    () => projects.find(project => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const selectedProjectName = selectedProject?.name ?? null;

  useEffect(() => {
    api.getProjects()
      .then(setProjects)
      .catch(console.error);
  }, []);

  const tabs: { id: ActiveTab; label: string; icon: React.ElementType; badge?: string }[] = [
    { id: 'review', label: 'Task Review', icon: BarChart3 },
    { id: 'schema', label: 'Schema Config', icon: Settings2, badge: 'Admin' },
  ];

  return (
    <div className="space-y-6 md:space-y-8">
      {/* Hero banner */}
      <section className="relative overflow-hidden rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-900 to-slate-950 px-5 py-6 shadow-2xl shadow-slate-950/30 md:px-7 md:py-7">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(99,102,241,0.15),_transparent_35%),radial-gradient(circle_at_left,_rgba(245,158,11,0.08),_transparent_25%)]" />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="mb-3 flex items-center gap-2">
              <Badge variant="workspace">Telemetry</Badge>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white md:text-3xl">Telemetry & Schema Config</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400 md:text-base">
              Inspect task quality, routing outcomes, and cycle times — or configure the metadata schema that drives telemetry collection.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              {selectedProjectName ? `Task telemetry is scoped to ${selectedProjectName}.` : 'Task telemetry is showing all projects. Schema configuration remains global.'}
            </p>
          </div>
          <label className="w-full space-y-1.5 lg:w-72">
            <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Project scope</span>
            <div className="relative">
              <select
                value={selectedProjectId ?? ''}
                onChange={event => setSelectedProjectId(event.target.value ? Number(event.target.value) : null)}
                className="w-full appearance-none rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 pr-9 text-sm text-slate-200 outline-none transition-colors focus:border-amber-500"
              >
                <option value="">All Projects</option>
                {projects.map(project => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-slate-500" />
            </div>
          </label>
        </div>
      </section>

      {/* Tab bar */}
      <div className="-mx-1 flex items-center gap-1 overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900/70 p-1.5 scrollbar-none">
        {tabs.map(({ id, label, icon: Icon, badge }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={`flex min-w-fit flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-medium transition-all ${
              activeTab === id
                ? 'bg-slate-800 text-white shadow-sm'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <Icon className={`h-4 w-4 ${activeTab === id ? 'text-amber-400' : ''}`} />
            {label}
            {badge && (
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${activeTab === id ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-700 text-slate-500'}`}>
                {badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'review' && <TaskReviewTab selectedProjectId={selectedProjectId} selectedProjectName={selectedProjectName} />}
      {activeTab === 'schema' && <SchemaConfigTab />}
    </div>
  );
}

export default TelemetryPage;
