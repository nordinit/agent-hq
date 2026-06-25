'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { api, apiFetch, type Project, type ProviderRecord, type Sprint, type SprintType } from '@/lib/api';
import { getAgentProviderOptions, PROVIDER_LABELS } from '@/lib/providerOptions';
import { formatSprintNumber } from '@/lib/sprintLabel';
import { useProjectFilterPreference } from '@/lib/projectFilterPreference';
import { Button } from '@/components/ui/button';
import { TableEnabledSwitch } from '@/components/TableEnabledSwitch';
import { ColumnHeaderLabel, ColumnHeaderTooltip } from '@/components/ui/table-column-help';
import {
  Cpu,
  Plus,
  Trash2,
  Check,
  X,
  RefreshCw,
  Pencil,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'adaptive';

interface ModelRoutingRule {
  id: number;
  label: string;
  max_points: number;
  model: string;
  fallback_model: string | null;
  max_turns: number | null;
  max_budget_usd: number | null;
  thinking_level: ThinkingLevel | null;
  fast_mode: boolean | null;
  enabled: boolean;
  provider: string | null;
  project_id: number | null;
  sprint_id: number | null;
  sprint_type: string | null;
  scope?: string;
  created_at: string;
  updated_at: string;
}

type RoutingScopeMode = 'sprint' | 'sprint_type' | 'project';

interface ProviderOption {
  value: string;
  label: string;
}

const TABLE_EDIT_ACTION_CLASS = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-700/60 hover:text-slate-100';
const TABLE_DELETE_ACTION_CLASS = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-red-400 transition-colors hover:bg-red-900/20 hover:text-red-300';
const SCOPE_CARD_CLASS = 'border-amber-500/20 bg-slate-900/80 p-5 shadow-sm shadow-amber-950/20';

const MODEL_ROUTING_COLUMN_HELP = {
  id: 'The canonical database ID for this model routing rule.',
  taskType: 'Model routing rules apply to every task type in the selected scope.',
  scope: 'Whether this model routing rule is a workflow override, workflow-type default, or project fallback.',
  label: 'The operator-friendly name for this model routing rule.',
  maxPoints: 'The largest story point estimate this model rule handles.',
  provider: 'The AI provider Agent HQ should prefer when this rule matches.',
  model: 'The primary model Agent HQ sends matching runs to.',
  thinkingLevel: 'How much reasoning effort the runtime should request for matching runs.',
  fastMode: 'Whether matching runs should prioritize lower latency over deeper runtime behavior.',
  enabled: 'Whether this model routing rule can match dispatched tasks.',
  maxTurns: 'The maximum number of agent turns allowed before the run should stop.',
  maxBudget: 'The spending limit for a matching run, in US dollars.',
  actions: 'Edit or remove this model routing rule.',
};

type ColumnFilterOption = { value: string; label: string };

function matchesColumnFilter(selected: string[], value: string): boolean {
  return selected.length === 0 || selected.includes(value);
}

function uniqueColumnOptions(options: ColumnFilterOption[]): ColumnFilterOption[] {
  const seen = new Map<string, string>();
  for (const option of options) {
    if (!seen.has(option.value)) seen.set(option.value, option.label);
  }
  return Array.from(seen, ([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

const THINKING_LEVEL_OPTIONS: Array<{ value: ThinkingLevel; label: string; description: string }> = [
  { value: 'off', label: 'Off', description: 'No extra reasoning effort' },
  { value: 'minimal', label: 'Minimal', description: 'Use the lightest reasoning pass' },
  { value: 'low', label: 'Low', description: 'Use a small amount of extra reasoning' },
  { value: 'medium', label: 'Medium', description: 'Balance speed and deeper reasoning' },
  { value: 'high', label: 'High', description: 'Favor deeper reasoning over speed' },
  { value: 'adaptive', label: 'Adaptive', description: 'Let the runtime adjust effort automatically' },
];

function formatThinkingLevel(level: ThinkingLevel | null | undefined) {
  return THINKING_LEVEL_OPTIONS.find(option => option.value === level)?.label ?? 'Default';
}

function formatFastMode(value: boolean | null | undefined) {
  if (value === true) return 'On';
  if (value === false) return 'Off';
  return 'Default';
}

function formatModelRoutingScope(scope: string | null | undefined) {
  switch (scope) {
    case 'project_sprint':
      return 'Workflow override';
    case 'project_sprint_type':
      return 'Project workflow-type default';
    case 'sprint_type':
      return 'All-project workflow-type default';
    case 'project':
      return 'Project fallback';
    case 'legacy_global':
      return 'Legacy global';
    default:
      return scope || 'Selected scope';
  }
}

function scopeForMode(scopeMode: RoutingScopeMode, projectId: number | null, sprintType: string | null) {
  if (scopeMode === 'sprint') return 'project_sprint';
  if (scopeMode === 'sprint_type') return projectId ? 'project_sprint_type' : 'sprint_type';
  if (scopeMode === 'project') return 'project';
  return sprintType ? 'sprint_type' : 'project';
}

function providerDisplayName(provider: ProviderRecord) {
  return provider.display_name || PROVIDER_LABELS[provider.slug] || provider.slug;
}

function buildProviderOptions(providers: ProviderRecord[]): ProviderOption[] {
  return getAgentProviderOptions(providers);
}

function formatProviderLabel(provider: string | null | undefined, providers: ProviderRecord[]) {
  if (!provider) return 'Any configured provider';
  const configured = providers.find(item => item.slug === provider);
  return configured ? providerDisplayName(configured) : provider;
}

function ProviderSelect({
  value,
  onChange,
  providers,
}: {
  value: string;
  onChange: (value: string) => void;
  providers: ProviderRecord[];
}) {
  const options = buildProviderOptions(providers);

  return (
    <select
      className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-amber-500 w-full min-w-[140px]"
      value={value}
      onChange={e => onChange(e.target.value)}
    >
      <option value="">Any configured provider</option>
      {options.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function TableColumnFilter({
  label,
  description,
  selected,
  options,
  onChange,
  align = 'left',
}: {
  label: string;
  description?: string;
  selected: string[];
  options: ColumnFilterOption[];
  onChange: (values: string[]) => void;
  align?: 'left' | 'right' | 'center';
}) {
  const [open, setOpen] = useState(false);
  const normalizedOptions = uniqueColumnOptions(options);
  const selectedSet = new Set(selected);
  const toggle = (value: string) => {
    onChange(selectedSet.has(value)
      ? selected.filter(item => item !== value)
      : [...selected, value]);
  };
  const menuAlignment = align === 'right'
    ? 'right-0'
    : align === 'center'
      ? 'left-1/2 -translate-x-1/2'
      : 'left-0';

  return (
    <div className={`relative inline-flex ${align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : ''}`}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-label={description ? `${label}: ${description}` : label}
        className={`group relative inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-semibold uppercase tracking-wider transition-colors ${selected.length > 0 ? 'text-amber-300' : 'text-slate-400 hover:text-slate-200'}`}
      >
        <span className="truncate">{label}</span>
        {selected.length > 0 && (
          <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] leading-none text-amber-300">{selected.length}</span>
        )}
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        {description && !open && <ColumnHeaderTooltip description={description} align={align} />}
      </button>
      {open && (
        <div className={`absolute top-6 z-30 min-w-[190px] rounded-lg border border-slate-700 bg-slate-950 p-2 shadow-xl ${menuAlignment}`}>
          <div className="mb-2 flex items-center justify-between gap-3 border-b border-slate-800 pb-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Filter</span>
            {selected.length > 0 && (
              <button type="button" onClick={() => onChange([])} className="text-xs text-amber-300 hover:text-amber-200">Clear</button>
            )}
          </div>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {normalizedOptions.length === 0 ? (
              <p className="px-1 py-2 text-xs text-slate-500">No values</p>
            ) : normalizedOptions.map(option => (
              <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
                <input
                  type="checkbox"
                  checked={selectedSet.has(option.value)}
                  onChange={() => toggle(option.value)}
                  className="h-3 w-3 rounded border-slate-600 bg-slate-900 text-amber-500"
                />
                <span className="truncate">{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Preview Legend ───────────────────────────────────────────
function PreviewLegend({ rules }: { rules: ModelRoutingRule[] }) {
  const sorted = rules.filter(rule => rule.enabled).sort((a, b) => a.max_points - b.max_points);

  if (sorted.length === 0) return null;

  const segments: { label: string; points: string; model: string; thinkingLevel: ThinkingLevel | null; fastMode: boolean | null }[] = [];
  let prev = 0;
  for (const rule of sorted) {
    const rangeStart = prev + 1;
    const rangeEnd = rule.max_points;
    segments.push({
      label: rule.label,
      points: rangeStart === rangeEnd ? `${rangeStart} pt` : `${rangeStart}–${rangeEnd} pts`,
      model: rule.model,
      thinkingLevel: rule.thinking_level,
      fastMode: rule.fast_mode,
    });
    prev = rule.max_points;
  }

  return (
    <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
        Routing Preview
      </h3>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {segments.map((seg, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200">
              <span className="text-slate-400">{seg.points}</span>
              <span className="mx-1.5 text-slate-600">→</span>
              <span className="text-amber-300 font-medium">{seg.label}</span>
              <span className="mx-1.5 text-slate-600">·</span>
              <span className="text-slate-400 font-mono">{seg.model}</span>
              <span className="mx-1.5 text-slate-600">·</span>
              <span className="text-slate-500">Thinking {formatThinkingLevel(seg.thinkingLevel)}</span>
              <span className="text-slate-500">Fast {formatFastMode(seg.fastMode)}</span>
            </span>
            {i < segments.length - 1 && (
              <ChevronRight className="w-3 h-3 text-slate-600 flex-shrink-0" />
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Add Rule Form ────────────────────────────────────────────
function AddRuleForm({
  onCreated,
  onCancel,
  providers,
  projectId,
  sprintId,
  scopeMode,
  sprintType,
}: {
  onCreated: () => void;
  onCancel: () => void;
  providers: ProviderRecord[];
  projectId: number | null;
  sprintId: number | null;
  scopeMode: RoutingScopeMode;
  sprintType: string | null;
}) {
  const defaultProvider: string = providers[0]?.slug ?? '';
  const [form, setForm] = useState({
    label: '',
    max_points: '',
    provider: defaultProvider,
    model: '',
    fallback_model: '',
    max_turns: '',
    max_budget_usd: '',
    thinking_level: '',
    fast_mode: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!form.label.trim() || !form.max_points || !form.model.trim()) {
      setError('Label, Max Points, and Model are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/api/v1/model-routing', {
        method: 'POST',
        body: JSON.stringify({
          label: form.label.trim(),
          max_points: Number(form.max_points),
          provider: form.provider || null,
          model: form.model.trim(),
          fallback_model: form.fallback_model.trim() || null,
          max_turns: form.max_turns ? Number(form.max_turns) : null,
          max_budget_usd: form.max_budget_usd ? Number(form.max_budget_usd) : null,
          thinking_level: form.thinking_level || null,
          fast_mode: form.fast_mode === '' ? null : form.fast_mode === 'true',
          enabled: true,
          project_id: projectId,
          workflow_id: scopeMode === 'sprint' ? sprintId : null,
          workflow_type: scopeMode === 'sprint_type' ? sprintType : null,
        }),
      });
      onCreated();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className="border-b border-amber-500/20 bg-amber-500/5">
      <td className="px-3 py-3 align-middle">
        <span className="font-mono text-[11px] text-slate-500">New</span>
      </td>
      <td className="px-3 py-3">
        <span className="text-xs text-slate-500">All task types</span>
      </td>
      <td className="px-3 py-3">
        <span className="inline-flex rounded-full border border-slate-600/60 bg-slate-700/50 px-2 py-0.5 text-xs text-slate-300">
          {formatModelRoutingScope(scopeForMode(scopeMode, projectId, sprintType))}
        </span>
      </td>
      <td className="px-3 py-3">
        <input
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-full focus:outline-none focus:border-amber-500 min-w-[100px]"
          placeholder="e.g. Small"
          value={form.label}
          onChange={e => setForm({ ...form, label: e.target.value })}
        />
      </td>
      <td className="px-3 py-3">
        <input
          type="number"
          min={1}
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-20 focus:outline-none focus:border-amber-500"
          placeholder="e.g. 2"
          value={form.max_points}
          onChange={e => setForm({ ...form, max_points: e.target.value })}
        />
      </td>
      <td className="px-3 py-3">
        <ProviderSelect
          value={form.provider}
          onChange={provider => setForm({ ...form, provider })}
          providers={providers}
        />
      </td>
      <td className="px-3 py-3">
        <input
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-full font-mono focus:outline-none focus:border-amber-500 min-w-[180px]"
          placeholder="e.g. anthropic/claude-haiku-4"
          value={form.model}
          onChange={e => setForm({ ...form, model: e.target.value })}
        />
      </td>
      <td className="px-3 py-3">
        <select
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-amber-500 w-full min-w-[140px]"
          value={form.thinking_level}
          onChange={e => setForm({ ...form, thinking_level: e.target.value })}
        >
          <option value="">Default runtime behavior</option>
          {THINKING_LEVEL_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-3">
        <input
          type="number"
          min={1}
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-20 focus:outline-none focus:border-amber-500"
          placeholder="—"
          value={form.max_turns}
          onChange={e => setForm({ ...form, max_turns: e.target.value })}
        />
      </td>
      <td className="px-3 py-3">
        <input
          type="number"
          min={0}
          step={0.01}
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-24 focus:outline-none focus:border-amber-500"
          placeholder="—"
          value={form.max_budget_usd}
          onChange={e => setForm({ ...form, max_budget_usd: e.target.value })}
        />
      </td>
      <td className="px-3 py-3">
        <select
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-amber-500 w-full min-w-[110px]"
          value={form.fast_mode}
          onChange={e => setForm({ ...form, fast_mode: e.target.value })}
        >
          <option value="">Default</option>
          <option value="true">On</option>
          <option value="false">Off</option>
        </select>
      </td>
      <td className="px-3 py-3 text-center">
        <TableEnabledSwitch checked label="New model routing rules are enabled by default" onChange={() => undefined} disabled />
      </td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-1 justify-end">
          <Button variant="primary" size="sm" onClick={handleCreate} loading={saving}>
            <Check className="w-3 h-3" /> Add
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <X className="w-3 h-3" />
          </Button>
        </div>
        {error && <p className="text-red-400 text-[10px] mt-1 text-right whitespace-nowrap">{error}</p>}
      </td>
    </tr>
  );
}

// ─── Rule Row ─────────────────────────────────────────────────
function RuleRow({
  rule,
  onSaved,
  onDeleted,
  providers,
  projectId,
  sprintId,
  scopeMode,
  sprintType,
}: {
  rule: ModelRoutingRule;
  onSaved: () => void;
  onDeleted: () => void;
  providers: ProviderRecord[];
  projectId: number | null;
  sprintId: number | null;
  scopeMode: RoutingScopeMode;
  sprintType: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    label: rule.label,
    max_points: String(rule.max_points),
    provider: rule.provider ?? '',
    model: rule.model,
    max_turns: rule.max_turns != null ? String(rule.max_turns) : '',
    max_budget_usd: rule.max_budget_usd != null ? String(rule.max_budget_usd) : '',
    thinking_level: rule.thinking_level ?? '',
    fast_mode: rule.fast_mode == null ? '' : String(rule.fast_mode),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleSave = async () => {
    if (!form.label.trim() || !form.max_points || !form.model.trim()) {
      setError('Label, Max Points, and Model are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/model-routing/${rule.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          label: form.label.trim(),
          max_points: Number(form.max_points),
          provider: form.provider || null,
          model: form.model.trim(),
          max_turns: form.max_turns ? Number(form.max_turns) : null,
          max_budget_usd: form.max_budget_usd ? Number(form.max_budget_usd) : null,
          thinking_level: form.thinking_level || null,
          fast_mode: form.fast_mode === '' ? null : form.fast_mode === 'true',
          project_id: projectId,
          workflow_id: scopeMode === 'sprint' ? sprintId : null,
          workflow_type: scopeMode === 'sprint_type' ? sprintType : null,
        }),
      });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setForm({
      label: rule.label,
      max_points: String(rule.max_points),
      provider: rule.provider ?? '',
      model: rule.model,
      max_turns: rule.max_turns != null ? String(rule.max_turns) : '',
      max_budget_usd: rule.max_budget_usd != null ? String(rule.max_budget_usd) : '',
      thinking_level: rule.thinking_level ?? '',
      fast_mode: rule.fast_mode == null ? '' : String(rule.fast_mode),
    });
    setEditing(false);
    setError(null);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiFetch(`/api/v1/model-routing/${rule.id}`, { method: 'DELETE' });
      onDeleted();
    } catch (e) {
      setError(String(e));
      setDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
  };

  const handleToggle = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/model-routing/${rule.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          enabled: !rule.enabled,
          project_id: projectId,
          workflow_id: scopeMode === 'sprint' ? sprintId : null,
          workflow_type: scopeMode === 'sprint_type' ? sprintType : null,
        }),
      });
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className="border-b border-slate-700/50 hover:bg-slate-800/30 transition-colors group">
      {/* ID */}
      <td className="px-3 py-3 align-middle">
        <span className="inline-flex rounded border border-slate-700/70 bg-slate-900/60 px-1.5 py-0.5 font-mono text-[11px] leading-5 text-slate-400">
          #{rule.id}
        </span>
      </td>

      {/* Task Type */}
      <td className="px-3 py-3">
        <span className="text-xs text-slate-500">All task types</span>
      </td>

      {/* Scope */}
      <td className="px-3 py-3">
        <span className="inline-flex rounded-full border border-slate-600/60 bg-slate-700/50 px-2 py-0.5 text-xs text-slate-300">
          {formatModelRoutingScope(rule.scope ?? scopeForMode(scopeMode, projectId, sprintType))}
        </span>
      </td>

      {/* Label */}
      <td className="px-3 py-3">
        {editing ? (
          <input
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-full focus:outline-none focus:border-amber-500 min-w-[100px]"
            value={form.label}
            onChange={e => setForm({ ...form, label: e.target.value })}
          />
        ) : (
          <span className="text-slate-200 text-sm font-medium">{rule.label}</span>
        )}
      </td>

      {/* Max Points */}
      <td className="px-3 py-3">
        {editing ? (
          <input
            type="number"
            min={1}
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-20 focus:outline-none focus:border-amber-500"
            value={form.max_points}
            onChange={e => setForm({ ...form, max_points: e.target.value })}
          />
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-mono">
            ≤ {rule.max_points}
          </span>
        )}
      </td>

      {/* Provider */}
      <td className="px-3 py-3">
        {editing ? (
          <ProviderSelect
            value={form.provider}
            onChange={provider => setForm({ ...form, provider })}
            providers={providers}
          />
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-700/50 border border-slate-600/50 text-slate-300 text-xs">
            {formatProviderLabel(rule.provider, providers)}
          </span>
        )}
      </td>

      {/* Model */}
      <td className="px-3 py-3">
        {editing ? (
          <input
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-full font-mono focus:outline-none focus:border-amber-500 min-w-[180px]"
            value={form.model}
            onChange={e => setForm({ ...form, model: e.target.value })}
          />
        ) : (
          <code className="text-slate-300 text-xs">{rule.model}</code>
        )}
      </td>

      {/* Thinking Level */}
      <td className="px-3 py-3">
        {editing ? (
          <select
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-amber-500 w-full min-w-[140px]"
            value={form.thinking_level}
            onChange={e => setForm({ ...form, thinking_level: e.target.value })}
          >
            <option value="">Default runtime behavior</option>
            {THINKING_LEVEL_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <div className="space-y-0.5">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-700/50 border border-slate-600/50 text-slate-300 text-xs">
              {formatThinkingLevel(rule.thinking_level)}
            </span>
            <p className="text-[10px] text-slate-500">
              {rule.thinking_level ? 'Overrides runtime reasoning effort' : 'Uses runtime default'}
            </p>
          </div>
        )}
      </td>

      {/* Max Turns */}
      <td className="px-3 py-3">
        {editing ? (
          <input
            type="number"
            min={1}
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-20 focus:outline-none focus:border-amber-500"
            value={form.max_turns}
            onChange={e => setForm({ ...form, max_turns: e.target.value })}
            placeholder="—"
          />
        ) : (
          <span className="text-slate-400 text-xs">
            {rule.max_turns != null ? rule.max_turns : <span className="text-slate-600">—</span>}
          </span>
        )}
      </td>

      {/* Max Budget */}
      <td className="px-3 py-3">
        {editing ? (
          <input
            type="number"
            min={0}
            step={0.01}
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs w-24 focus:outline-none focus:border-amber-500"
            value={form.max_budget_usd}
            onChange={e => setForm({ ...form, max_budget_usd: e.target.value })}
            placeholder="—"
          />
        ) : (
          <span className="text-slate-400 text-xs">
            {rule.max_budget_usd != null
              ? `$${Number(rule.max_budget_usd).toFixed(2)}`
              : <span className="text-slate-600">—</span>}
          </span>
        )}
      </td>

      {/* Fast Mode */}
      <td className="px-3 py-3">
        {editing ? (
          <select
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-amber-500 w-full min-w-[110px]"
            value={form.fast_mode}
            onChange={e => setForm({ ...form, fast_mode: e.target.value })}
          >
            <option value="">Default</option>
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-700/50 border border-slate-600/50 text-slate-300 text-xs">
            {formatFastMode(rule.fast_mode)}
          </span>
        )}
      </td>

      {/* Enabled */}
      <td className="px-3 py-3 text-center">
        <TableEnabledSwitch
          checked={Boolean(rule.enabled)}
          disabled={editing || saving}
          label={`${rule.enabled ? 'Disable' : 'Enable'} model routing rule #${rule.id}`}
          onChange={() => void handleToggle()}
        />
      </td>

      {/* Actions */}
      <td className="px-3 py-3">
        {deleteConfirm ? (
          <div className="flex items-center gap-1 justify-end">
            <span className="text-red-400 text-[10px] mr-1">Delete?</span>
            <Button
              variant="danger"
              size="sm"
              onClick={handleDelete}
              loading={deleting}
            >
              <Trash2 className="w-3 h-3" /> Yes
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDeleteConfirm(false)}>
              <X className="w-3 h-3" />
            </Button>
          </div>
        ) : editing ? (
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-1">
              <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
                <Check className="w-3 h-3" /> Save
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                <X className="w-3 h-3" />
              </Button>
            </div>
            {error && <p className="text-red-400 text-[10px]">{error}</p>}
          </div>
        ) : (
          <div className="flex items-center gap-1 justify-end">
            <button type="button" onClick={() => setEditing(true)} className={TABLE_EDIT_ACTION_CLASS} title="Edit model routing rule">
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => setDeleteConfirm(true)} className={TABLE_DELETE_ACTION_CLASS} title="Delete model routing rule">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

// ─── Main Page ────────────────────────────────────────────────
export default function ModelRoutingPage() {
  const [rules, setRules] = useState<ModelRoutingRule[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [sprintTypes, setSprintTypes] = useState<SprintType[]>([]);
  const validProjectIds = useMemo(() => projects.map(project => project.id), [projects]);
  const [selectedProjectId, setSelectedProjectId] = useProjectFilterPreference({ validProjectIds });
  const [selectedSprintId, setSelectedSprintId] = useState<number | null>(null);
  const [selectedSprintType, setSelectedSprintType] = useState<string | null>(null);
  const [scopeMode, setScopeMode] = useState<RoutingScopeMode>('sprint');
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [referenceLoading, setReferenceLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [filterLabels, setFilterLabels] = useState<string[]>([]);
  const [filterMaxPoints, setFilterMaxPoints] = useState<string[]>([]);
  const [filterProviders, setFilterProviders] = useState<string[]>([]);
  const [filterModels, setFilterModels] = useState<string[]>([]);
  const [filterThinkingLevels, setFilterThinkingLevels] = useState<string[]>([]);
  const [filterMaxTurns, setFilterMaxTurns] = useState<string[]>([]);
  const [filterMaxBudgets, setFilterMaxBudgets] = useState<string[]>([]);
  const [filterFastModes, setFilterFastModes] = useState<string[]>([]);
  const [filterScopes, setFilterScopes] = useState<string[]>([]);
  const [filterStates, setFilterStates] = useState<string[]>([]);
  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null;
  const selectedSprintTypeRecord = sprintTypes.find(type => type.key === selectedSprintType) ?? null;
  const filteredSprints = selectedProjectId
    ? sprints.filter(sprint => sprint.project_id === selectedProjectId)
    : [];
  const labelOptions = useMemo(() => rules.map(rule => ({ value: rule.label, label: rule.label })), [rules]);
  const maxPointOptions = useMemo(() => rules.map(rule => ({ value: String(rule.max_points), label: String(rule.max_points) })), [rules]);
  const providerOptions = useMemo(() => rules.map(rule => ({ value: rule.provider ?? '', label: formatProviderLabel(rule.provider, providers) })), [providers, rules]);
  const modelOptions = useMemo(() => rules.map(rule => ({ value: rule.model, label: rule.model })), [rules]);
  const thinkingOptions = useMemo(() => rules.map(rule => ({ value: rule.thinking_level ?? '', label: formatThinkingLevel(rule.thinking_level) })), [rules]);
  const maxTurnOptions = useMemo(() => rules.map(rule => ({ value: rule.max_turns != null ? String(rule.max_turns) : '', label: rule.max_turns != null ? String(rule.max_turns) : '—' })), [rules]);
  const maxBudgetOptions = useMemo(() => rules.map(rule => ({ value: rule.max_budget_usd != null ? String(rule.max_budget_usd) : '', label: rule.max_budget_usd != null ? `$${Number(rule.max_budget_usd).toFixed(2)}` : '—' })), [rules]);
  const fastModeOptions = useMemo(() => rules.map(rule => ({ value: rule.fast_mode == null ? '' : String(rule.fast_mode), label: formatFastMode(rule.fast_mode) })), [rules]);
  const scopeOptions = useMemo(() => rules.map(rule => {
    const value = rule.scope ?? scopeForMode(scopeMode, rule.project_id, rule.sprint_type);
    return { value, label: formatModelRoutingScope(value) };
  }), [rules, scopeMode]);
  const stateOptions = useMemo(() => ([
    { value: 'enabled', label: 'Enabled' },
    { value: 'disabled', label: 'Disabled' },
  ]), []);
  const filteredRules = useMemo(() => rules.filter(rule => (
    matchesColumnFilter(filterScopes, rule.scope ?? scopeForMode(scopeMode, rule.project_id, rule.sprint_type))
    && matchesColumnFilter(filterLabels, rule.label)
    && matchesColumnFilter(filterMaxPoints, String(rule.max_points))
    && matchesColumnFilter(filterProviders, rule.provider ?? '')
    && matchesColumnFilter(filterModels, rule.model)
    && matchesColumnFilter(filterThinkingLevels, rule.thinking_level ?? '')
    && matchesColumnFilter(filterMaxTurns, rule.max_turns != null ? String(rule.max_turns) : '')
    && matchesColumnFilter(filterMaxBudgets, rule.max_budget_usd != null ? String(rule.max_budget_usd) : '')
    && matchesColumnFilter(filterFastModes, rule.fast_mode == null ? '' : String(rule.fast_mode))
    && matchesColumnFilter(filterStates, rule.enabled ? 'enabled' : 'disabled')
  )), [filterFastModes, filterLabels, filterMaxBudgets, filterMaxPoints, filterMaxTurns, filterModels, filterProviders, filterScopes, filterStates, filterThinkingLevels, rules, scopeMode]);

  const loadReferenceData = useCallback(async () => {
    setReferenceLoading(true);
    setError(null);
    try {
      const [projectList, sprintList, sprintTypeList, providerResponse] = await Promise.all([
        api.getProjects(),
        api.getSprints(undefined, true),
        api.getSprintTypes(),
        api.getProviders(),
      ]);
      setProjects(projectList);
      setSprints(sprintList);
      setSprintTypes(sprintTypeList);
      setProviders(providerResponse.providers);
      setSelectedSprintId(current => {
        if (current && sprintList.some(sprint => sprint.id === current)) return current;
        return null;
      });
      setSelectedSprintType(current => {
        if (current && sprintTypeList.some(type => type.key === current)) return current;
        return sprintTypeList.find(type => type.key === 'dev')?.key ?? sprintTypeList[0]?.key ?? null;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setReferenceLoading(false);
    }
  }, []);

  const loadRules = useCallback(async () => {
    if ((scopeMode !== 'sprint_type' && !selectedProjectId) || (scopeMode === 'sprint' && !selectedSprintId) || (scopeMode === 'sprint_type' && !selectedSprintType)) {
      setRules([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (selectedProjectId) params.set('project_id', String(selectedProjectId));
      if (scopeMode === 'sprint') params.set('workflow_id', String(selectedSprintId));
      if (scopeMode === 'sprint_type' && selectedSprintType) params.set('workflow_type', selectedSprintType);
      const data = await apiFetch<ModelRoutingRule[]>(`/api/v1/model-routing?${params.toString()}`);
      const sorted = [...data].sort((a, b) => a.max_points - b.max_points);
      setRules(sorted);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [scopeMode, selectedProjectId, selectedSprintId, selectedSprintType]);

  useEffect(() => { loadReferenceData(); }, [loadReferenceData]);

  useEffect(() => {
    const scoped = selectedProjectId ? sprints.filter(sprint => sprint.project_id === selectedProjectId) : [];
    setSelectedSprintId(current => {
      if (current && scoped.some(sprint => sprint.id === current)) return current;
      return scoped.find(sprint => sprint.status !== 'closed')?.id ?? scoped[0]?.id ?? null;
    });
    setShowAdd(false);
  }, [selectedProjectId, sprints]);

  useEffect(() => {
    if (selectedProjectId || scopeMode === 'sprint_type') return;
    setScopeMode('sprint_type');
    setShowAdd(false);
  }, [scopeMode, selectedProjectId]);

  useEffect(() => {
    if (selectedSprintType && sprintTypes.some(type => type.key === selectedSprintType)) return;
    setSelectedSprintType(sprintTypes.find(type => type.key === 'dev')?.key ?? sprintTypes[0]?.key ?? null);
  }, [selectedSprintType, sprintTypes]);

  useEffect(() => { void loadRules(); }, [loadRules]);

  if (referenceLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-tour-target="model-routing-main">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Cpu className="w-5 h-5 text-amber-400" />
          <h1 className="text-2xl font-bold text-white">Model Routing</h1>
        </div>
        <p className="text-slate-400 text-sm">
          Configure which AI model runs tasks based on story point complexity for a workflow, workflow type, or project fallback.
        </p>
      </div>

      <div className={`rounded-xl border ${SCOPE_CARD_CLASS}`}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-300">Routing Scope</p>
            <p className="mt-1 text-base font-semibold text-white">Model policy can be edited per workflow, workflow type, or project.</p>
            <p className="mt-0.5 text-xs text-slate-500">Workflow rules win first, project workflow-type defaults apply next, all-project workflow-type defaults follow, then project rules are used.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[780px] lg:grid-cols-3">
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Project</p>
              <div className="relative">
                <select
                  className="appearance-none w-full bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-8 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-amber-500"
                  value={selectedProjectId ?? ''}
                  onChange={e => setSelectedProjectId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">All Projects</option>
                  {projects.map(project => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Scope</p>
              <div className="relative">
                <select
                  className="appearance-none w-full bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-8 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-amber-500"
                  value={scopeMode}
                  onChange={e => { setScopeMode(e.target.value as RoutingScopeMode); setShowAdd(false); }}
                >
                  <option value="sprint">Specific workflow override</option>
                  <option value="sprint_type">All workflows of a type</option>
                  <option value="project">Project fallback</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">{scopeMode === 'sprint_type' ? 'Workflow Type' : 'Workflow'}</p>
              <div className="relative">
                {scopeMode === 'sprint_type' ? (
                  <select
                    className="appearance-none w-full bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-8 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-amber-500 disabled:opacity-60"
                    value={selectedSprintType ?? ''}
                    onChange={e => setSelectedSprintType(e.target.value || null)}
                    disabled={sprintTypes.length === 0}
                  >
                    <option value="">Select workflow type...</option>
                    {sprintTypes.map(type => (
                      <option key={type.key} value={type.key}>{type.name || type.key} ({type.key})</option>
                    ))}
                  </select>
                ) : (
                  <select
                    className="appearance-none w-full bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-8 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-amber-500 disabled:opacity-60"
                    value={selectedSprintId ?? ''}
                    onChange={e => setSelectedSprintId(e.target.value ? Number(e.target.value) : null)}
                    disabled={scopeMode === 'project' || filteredSprints.length === 0}
                  >
                    <option value="">{scopeMode === 'project' ? 'All project workflows fallback' : (selectedProject ? 'Select workflow...' : 'Select project first...')}</option>
                    {scopeMode !== 'project' && filteredSprints.map(sprint => (
                      <option key={sprint.id} value={sprint.id}>
                        {formatSprintNumber(sprint.id)} · {sprint.name}
                      </option>
                    ))}
                  </select>
                )}
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Alert if no rules */}
      {!loading && rules.length === 0 && !error && (
        <div className="flex items-start gap-3 bg-amber-900/20 border border-amber-700/40 rounded-xl p-4">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
          <p className="text-amber-300 text-sm">
            No model routing rules configured for this {scopeMode === 'sprint_type' ? `workflow type${selectedSprintTypeRecord ? ` (${selectedSprintTypeRecord.name})` : ''}` : scopeMode === 'project' ? 'project fallback' : 'workflow'}. Dispatch will use the next lower-precedence matching scope when available.
          </p>
        </div>
      )}

      {/* Preview Legend */}
      {rules.length > 0 && <PreviewLegend rules={rules} />}

      {/* Controls */}
      <div className="flex items-center justify-between">
        <p className="text-slate-400 text-sm">
          {loading ? 'Loading…' : `${filteredRules.length} of ${rules.length} rule${rules.length !== 1 ? 's' : ''}`}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={loadRules} disabled={loading || (scopeMode !== 'sprint_type' && !selectedProjectId) || (scopeMode === 'sprint' && !selectedSprintId) || (scopeMode === 'sprint_type' && !selectedSprintType)}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowAdd(s => !s)}
            disabled={showAdd || loading || (scopeMode !== 'sprint_type' && !selectedProjectId) || (scopeMode === 'sprint' && !selectedSprintId) || (scopeMode === 'sprint_type' && !selectedSprintType)}
          >
            <Plus className="w-3.5 h-3.5" /> Add Rule
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px]">
            <thead>
              <tr className="border-b border-slate-700 text-left">
                <th className="w-20 px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  <ColumnHeaderLabel label="ID" description={MODEL_ROUTING_COLUMN_HELP.id} />
                </th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  <ColumnHeaderLabel label="Task Type" description={MODEL_ROUTING_COLUMN_HELP.taskType} />
                </th>
                <th className="px-3 py-2.5">
                  <TableColumnFilter label="Scope" description={MODEL_ROUTING_COLUMN_HELP.scope} selected={filterScopes} onChange={setFilterScopes} options={scopeOptions} />
                </th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Label" description={MODEL_ROUTING_COLUMN_HELP.label} selected={filterLabels} onChange={setFilterLabels} options={labelOptions} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Max Points" description={MODEL_ROUTING_COLUMN_HELP.maxPoints} selected={filterMaxPoints} onChange={setFilterMaxPoints} options={maxPointOptions} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Provider" description={MODEL_ROUTING_COLUMN_HELP.provider} selected={filterProviders} onChange={setFilterProviders} options={providerOptions} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Model" description={MODEL_ROUTING_COLUMN_HELP.model} selected={filterModels} onChange={setFilterModels} options={modelOptions} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Thinking Level" description={MODEL_ROUTING_COLUMN_HELP.thinkingLevel} selected={filterThinkingLevels} onChange={setFilterThinkingLevels} options={thinkingOptions} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Max Turns" description={MODEL_ROUTING_COLUMN_HELP.maxTurns} selected={filterMaxTurns} onChange={setFilterMaxTurns} options={maxTurnOptions} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Max Budget USD" description={MODEL_ROUTING_COLUMN_HELP.maxBudget} selected={filterMaxBudgets} onChange={setFilterMaxBudgets} options={maxBudgetOptions} /></th>
                <th className="px-3 py-2.5"><TableColumnFilter label="Fast Mode" description={MODEL_ROUTING_COLUMN_HELP.fastMode} selected={filterFastModes} onChange={setFilterFastModes} options={fastModeOptions} /></th>
                <th className="px-3 py-2.5 text-center"><TableColumnFilter label="Enabled" description={MODEL_ROUTING_COLUMN_HELP.enabled} selected={filterStates} onChange={setFilterStates} options={stateOptions} align="center" /></th>
                <th className="px-3 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider text-right">
                  <ColumnHeaderLabel label="Actions" description={MODEL_ROUTING_COLUMN_HELP.actions} align="right" />
                </th>
              </tr>
            </thead>
            <tbody>
              {showAdd && (
                <AddRuleForm
                  providers={providers}
                  projectId={selectedProjectId}
                  sprintId={selectedSprintId}
                  scopeMode={scopeMode}
                  sprintType={selectedSprintType}
                  onCreated={() => { setShowAdd(false); loadRules(); }}
                  onCancel={() => setShowAdd(false)}
                />
              )}
              {loading && rules.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-3 py-12 text-center">
                    <div className="flex items-center justify-center">
                      <div className="w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                    </div>
                  </td>
                </tr>
              ) : rules.length === 0 && !showAdd ? (
                <tr>
                  <td colSpan={13} className="px-3 py-12 text-center text-slate-500 text-sm">
                    No model routing rules yet. Click <strong>Add Rule</strong> to create one.
                  </td>
                </tr>
              ) : (
                filteredRules.map(rule => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    onSaved={loadRules}
                    onDeleted={loadRules}
                    providers={providers}
                    projectId={selectedProjectId}
                    sprintId={selectedSprintId}
                    scopeMode={scopeMode}
                    sprintType={selectedSprintType}
                  />
                ))
              )}
              {filteredRules.length === 0 && rules.length > 0 && !showAdd && (
                <tr>
                  <td colSpan={13} className="px-3 py-12 text-center text-slate-500 text-sm">
                    No model routing rules match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Info card */}
      <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4 text-xs text-slate-500 space-y-1">
        <p>
          <strong className="text-slate-400">How it works:</strong> When a task is dispatched, its story point estimate
          is compared against each rule&apos;s <code className="text-slate-400">max_points</code> threshold. The rule
          with the lowest <code className="text-slate-400">max_points</code> that is &ge; the task&apos;s points wins.
        </p>
        <p>
          Scoped rules for the task&apos;s workflow win first. If none match, dispatch falls back to project workflow-type rules, then all-project workflow-type rules, then project-level rules. Legacy global rows are ignored.
        </p>
        <p>
          <strong className="text-slate-400">Thinking level:</strong> Leave this unset to use the model runtime default,
          or choose an override when a rule should use more or less reasoning effort.
        </p>
        <p>
          <strong className="text-slate-400">Fast mode:</strong> Leave this unset to use the runtime default, or set it when a rule should explicitly prefer lower latency or deeper behavior.
        </p>
      </div>
    </div>
  );
}
