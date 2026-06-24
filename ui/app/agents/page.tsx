'use client';
import { formatDateTime } from '@/lib/date';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, Agent, AgentRuntimeType, Project, ClaudeCodeRuntimeConfig, HermesRuntimeConfig, AgentRuntimeConfig, ProviderRecord, ProviderSlug } from '@/lib/api';
import { useProjectFilterPreference } from '@/lib/projectFilterPreference';
import { Card } from '@/components/ui/card';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Bot, Plus, Pencil, Trash2, X, Check, FolderOpen, ChevronDown, Zap, CheckCircle, AlertCircle, Loader2, ChevronRight, Power } from 'lucide-react';
import Link from 'next/link';
import { AgentDeleteNotice, buildAgentDeleteNotice, type AgentDeleteNoticeData } from '@/components/AgentDeleteNotice';
import {
  getAgentModelLabel,
  getAgentModelOptionsForProvider,
  getAgentProviderOptions,
  isLocalModelProvider,
  isDynamicModelProvider,
  isOpenClawOnlyProvider,
  isModelAllowedForProvider,
  isProviderConnected,
  PROVIDER_LABELS,
} from '@/lib/providerOptions';

const EFFORT_OPTIONS = ['low', 'medium', 'high', 'max'] as const;

const RUNTIME_TYPE_OPTIONS: Array<{ value: AgentRuntimeType; label: string }> = [
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'veri', label: 'Custom (Agent Runtime)' },
];

interface FormState {
  name: string;
  role: string;
  session_key: string;
  workspace_path: string;
  status: 'idle' | 'running' | 'blocked';
  model: string;
  preferred_provider: string;
  provision_openclaw: boolean;
  runtime_type: AgentRuntimeType;
  runtime_config: AgentRuntimeConfig | null;
  raw_json: string;
  raw_json_expanded: boolean;
}

type ProvisionState =
  | { phase: 'idle' }
  | { phase: 'pending'; agentId: number }
  | { phase: 'loading'; agentId: number }
  | { phase: 'success'; agentId: number; session_key: string; workspace_path: string }
  | { phase: 'error'; agentId: number; message: string };

const emptyClaudeRuntimeConfig: ClaudeCodeRuntimeConfig = {
  workingDirectory: '',
  model: '',
  effort: 'medium',
  allowedTools: [],
  maxTurns: undefined,
  maxBudgetUsd: undefined,
  systemPromptSuffix: '',
};

const emptyHermesRuntimeConfig: HermesRuntimeConfig = {
  hermesBin: 'hermes',
  profile: '',
  provider: null,
  model: null,
  fastMode: null,
  extraArgs: [],
  env: {},
  invocationMode: 'z',
  ignoreUserConfig: false,
  ignoreRules: false,
  passSessionId: false,
};

function normalizeClaudeRuntimeConfig(config: AgentRuntimeConfig | null | undefined): ClaudeCodeRuntimeConfig {
  const cfg = config && typeof config === 'object' ? config as Partial<ClaudeCodeRuntimeConfig> : {};
  return {
    ...emptyClaudeRuntimeConfig,
    ...cfg,
    workingDirectory: cfg.workingDirectory ?? '',
    model: cfg.model ?? '',
    effort: cfg.effort ?? 'medium',
    allowedTools: cfg.allowedTools ?? [],
    systemPromptSuffix: cfg.systemPromptSuffix ?? '',
  };
}

function normalizeHermesRuntimeConfig(config: AgentRuntimeConfig | null | undefined): HermesRuntimeConfig {
  const cfg = config && typeof config === 'object' ? config as Partial<HermesRuntimeConfig> : {};
  return {
    ...emptyHermesRuntimeConfig,
    ...cfg,
    hermesBin: cfg.hermesBin ?? 'hermes',
    profile: cfg.profile ?? '',
    provider: cfg.provider ?? null,
    model: cfg.model ?? null,
    fastMode: typeof cfg.fastMode === 'boolean' ? cfg.fastMode : null,
    extraArgs: cfg.extraArgs ?? [],
    env: cfg.env ?? {},
    invocationMode: cfg.invocationMode ?? 'z',
    ignoreUserConfig: cfg.ignoreUserConfig ?? false,
    ignoreRules: cfg.ignoreRules ?? false,
    passSessionId: cfg.passSessionId ?? false,
  };
}

const emptyForm: FormState = {
  name: '',
  role: '',
  session_key: '',
  workspace_path: '',
  status: 'idle',
  model: '',
  preferred_provider: '',
  provision_openclaw: false,
  // Default to OpenClaw, but keep runtime_config aligned with the selected runtime.
  runtime_type: 'openclaw',
  runtime_config: null,
  raw_json: '',
  raw_json_expanded: false,
};

function claudeRuntimeConfigToJson(cfg: ClaudeCodeRuntimeConfig): string {
  const out: Record<string, unknown> = { workingDirectory: cfg.workingDirectory };
  if (cfg.model) out.model = cfg.model;
  if (cfg.effort) out.effort = cfg.effort;
  if (cfg.allowedTools && cfg.allowedTools.length > 0) out.allowedTools = cfg.allowedTools;
  if (cfg.maxTurns) out.maxTurns = cfg.maxTurns;
  if (cfg.maxBudgetUsd) out.maxBudgetUsd = cfg.maxBudgetUsd;
  if (cfg.systemPromptSuffix) out.systemPromptSuffix = cfg.systemPromptSuffix;
  return JSON.stringify(out, null, 2);
}

function hermesRuntimeConfigToJson(cfg: HermesRuntimeConfig): string {
  const out: Record<string, unknown> = {};
  if (cfg.hermesBin) out.hermesBin = cfg.hermesBin;
  if (cfg.profile) out.profile = cfg.profile;
  if (cfg.provider) out.provider = cfg.provider;
  if (cfg.model) out.model = cfg.model;
  if (cfg.fastMode != null) out.fastMode = cfg.fastMode;
  if (cfg.extraArgs && cfg.extraArgs.length > 0) out.extraArgs = cfg.extraArgs;
  if (cfg.env && Object.keys(cfg.env).length > 0) out.env = cfg.env;
  if (cfg.invocationMode) out.invocationMode = cfg.invocationMode;
  if (cfg.ignoreUserConfig) out.ignoreUserConfig = cfg.ignoreUserConfig;
  if (cfg.ignoreRules) out.ignoreRules = cfg.ignoreRules;
  if (cfg.passSessionId) out.passSessionId = cfg.passSessionId;
  return JSON.stringify(out, null, 2);
}

function runtimeBadge(agent: Agent) {
  switch (agent.runtime_type) {
    case 'claude-code':
      return (
        <span className="inline-flex items-center text-xs font-medium text-purple-300 bg-purple-900/30 border border-purple-500/30 px-1.5 py-0.5 rounded-full whitespace-nowrap">
          Claude Code
        </span>
      );
    case 'veri':
      return (
        <span className="inline-flex items-center text-xs font-medium text-blue-300 bg-blue-900/30 border border-blue-500/30 px-1.5 py-0.5 rounded-full whitespace-nowrap">
          Custom
        </span>
      );
    case 'hermes':
      return (
        <span className="inline-flex items-center text-xs font-medium text-emerald-300 bg-emerald-900/30 border border-emerald-500/30 px-1.5 py-0.5 rounded-full whitespace-nowrap">
          Hermes
        </span>
      );
    case 'webhook':
      return (
        <span className="inline-flex items-center text-xs font-medium text-cyan-300 bg-cyan-900/30 border border-cyan-500/30 px-1.5 py-0.5 rounded-full whitespace-nowrap">
          Webhook
        </span>
      );
    case 'openclaw':
    default:
      return (
        <span className="inline-flex items-center text-xs font-medium text-amber-400 bg-amber-900/20 border border-amber-500/20 px-1.5 py-0.5 rounded-full whitespace-nowrap">
          OpenClaw
        </span>
      );
  }
}

export default function AgentsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const validProjectIds = useMemo(() => projects.map(project => project.id), [projects]);
  const [filterProjectId, setFilterProjectId] = useProjectFilterPreference({ validProjectIds });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [localMlxOnline, setLocalMlxOnline] = useState<boolean | null>(null);
  const [provision, setProvision] = useState<ProvisionState>({ phase: 'idle' });
  const [dynamicModels, setDynamicModels] = useState<Array<{ id: string; label: string }>>([]);
  const [dynamicModelsLoading, setDynamicModelsLoading] = useState(false);
  const [dynamicModelsError, setDynamicModelsError] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<AgentDeleteNoticeData | null>(null);
  const toSlug = (name: string) =>
    name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const load = (projectId?: number | null) => {
    Promise.all([
      api.getAgents(projectId),
      api.getProjects(),
      api.getProviders(),
    ])
      .then(([a, p, providerResponse]) => {
        setAgents(a);
        setProjects(p);
        setProviders(providerResponse.providers);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(filterProjectId); }, [filterProjectId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const deletedAgentName = params.get('deleted_agent');
    if (!deletedAgentName) return;
    const deletedAgentArchived = params.get('deleted_agent_archived') === '1';
    setDeleteNotice(buildAgentDeleteNotice(deletedAgentName, { archived: deletedAgentArchived }));
    router.replace('/agents', { scroll: false });
  }, [router]);

  // (Legacy ?edit=<id> param removed — edit flow now uses /agents/:id?mode=edit)

  // Auto-populate workspace path when provision_openclaw is on
  useEffect(() => {
    if (form.provision_openclaw && !editId) {
      const slug = toSlug(form.name);
      const path = slug
        ? `.openclaw/workspace-${slug}`
        : '';
      setForm(f => ({ ...f, workspace_path: path }));
    }
  }, [form.name, form.provision_openclaw, editId]);

  // Sync raw JSON when runtime_config changes (only when not expanded/edited manually)
  useEffect(() => {
    if (form.runtime_type === 'claude-code' && !form.raw_json_expanded) {
      setForm(f => ({ ...f, raw_json: claudeRuntimeConfigToJson(normalizeClaudeRuntimeConfig(f.runtime_config)) }));
    }
    if (form.runtime_type === 'hermes' && !form.raw_json_expanded) {
      setForm(f => ({ ...f, raw_json: hermesRuntimeConfigToJson(normalizeHermesRuntimeConfig(f.runtime_config)) }));
    }
  }, [form.runtime_config, form.runtime_type]);

  useEffect(() => {
    if (!form.preferred_provider) return;
    if (form.model && !isModelAllowedForProvider(form.model, form.preferred_provider)) {
      setForm(f => ({ ...f, model: '' }));
    }
  }, [form.preferred_provider, form.model]);

  // Fetch dynamic models when a dynamic-model provider is selected
  useEffect(() => {
    if (!isDynamicModelProvider(form.preferred_provider)) {
      setDynamicModels([]);
      setDynamicModelsError(null);
      return;
    }
    setDynamicModelsLoading(true);
    setDynamicModelsError(null);
    api.getProviderModels(form.preferred_provider as ProviderSlug)
      .then(r => {
        setDynamicModels(r.models);
        setDynamicModelsLoading(false);
      })
      .catch(e => {
        setDynamicModelsError(e instanceof Error ? e.message : String(e));
        setDynamicModelsLoading(false);
      });
  }, [form.preferred_provider]);

  // Check local-mlx status (fire-and-forget) when form opens
  const checkLocalMlx = () => {
    fetch('/api/local-mlx-status', { signal: AbortSignal.timeout(5000) })
      .then(r => r.json()).then((d: { online: boolean }) => setLocalMlxOnline(d.online))
      .catch(() => setLocalMlxOnline(false));
  };

  const openCreate = () => {
    const providerOptions = getAgentProviderOptions(providers);
    setForm({
      ...emptyForm,
      preferred_provider: providerOptions[0]?.value ?? '',
      runtime_type: 'openclaw',
      runtime_config: null,
      raw_json: '',
      raw_json_expanded: false,
    });
    setEditId(null);
    setFormError(null);
    setProvision({ phase: 'idle' });
    setShowForm(true);
    checkLocalMlx();
  };

  const openEdit = (agent: Agent) => {
    // Navigate to the agent detail page in edit mode instead of a top-of-page popup
    router.push(`/agents/${agent.id}?mode=edit`);
  };

  const buildUpdatePayload = () => {
    const base = {
      name: form.name,
      role: form.role,
      session_key: form.session_key,
      workspace_path: form.workspace_path,
      status: form.status,
      model: form.model || null,
      preferred_provider: form.preferred_provider || null,
      runtime_type: form.runtime_type,
      runtime_config: null as AgentRuntimeConfig | null,
    };

    if (form.runtime_type === 'claude-code') {
      if (form.raw_json_expanded) {
        base.runtime_config = JSON.parse(form.raw_json) as ClaudeCodeRuntimeConfig;
      } else {
        const runtimeConfig = normalizeClaudeRuntimeConfig(form.runtime_config);
        const cfg: ClaudeCodeRuntimeConfig = {
          workingDirectory: runtimeConfig.workingDirectory,
        };
        if (runtimeConfig.model) cfg.model = runtimeConfig.model;
        if (runtimeConfig.effort) cfg.effort = runtimeConfig.effort;
        if (runtimeConfig.allowedTools && runtimeConfig.allowedTools.length > 0) {
          cfg.allowedTools = runtimeConfig.allowedTools;
        }
        if (runtimeConfig.maxTurns) cfg.maxTurns = Number(runtimeConfig.maxTurns);
        if (runtimeConfig.maxBudgetUsd) cfg.maxBudgetUsd = Number(runtimeConfig.maxBudgetUsd);
        if (runtimeConfig.systemPromptSuffix) cfg.systemPromptSuffix = runtimeConfig.systemPromptSuffix;
        base.runtime_config = cfg;
      }
    }

    if (form.runtime_type === 'hermes') {
      if (form.raw_json_expanded) {
        base.runtime_config = JSON.parse(form.raw_json) as HermesRuntimeConfig;
      } else {
        const runtimeConfig = normalizeHermesRuntimeConfig(form.runtime_config);
        const cfg: HermesRuntimeConfig = {
          hermesBin: runtimeConfig.hermesBin?.trim() || 'hermes',
          profile: runtimeConfig.profile?.trim() || '',
          provider: runtimeConfig.provider?.trim() || null,
          model: runtimeConfig.model?.trim() || null,
          fastMode: runtimeConfig.fastMode ?? null,
          extraArgs: runtimeConfig.extraArgs?.filter(Boolean) ?? [],
          env: runtimeConfig.env ?? {},
          invocationMode: runtimeConfig.invocationMode ?? 'z',
          ignoreUserConfig: Boolean(runtimeConfig.ignoreUserConfig),
          ignoreRules: Boolean(runtimeConfig.ignoreRules),
          passSessionId: Boolean(runtimeConfig.passSessionId),
        };
        base.runtime_config = cfg;
      }
    }

    return base;
  };

  const handleSave = async () => {
    setSaving(true);
    setFormError(null);
    try {
      // Validate
      const nameConflict = agents.find(a =>
        a.name.trim().toLowerCase() === form.name.trim().toLowerCase() && a.id !== editId
      );
      if (nameConflict) {
        setFormError(`An agent named "${nameConflict.name}" already exists. Agent names must be unique.`);
        setSaving(false);
        return;
      }

      if (!form.preferred_provider || !isProviderConnected(providers, form.preferred_provider)) {
        setFormError('Select a connected provider in Settings → Providers before saving this agent.');
        setSaving(false);
        return;
      }

      if (form.model && !isModelAllowedForProvider(form.model, form.preferred_provider)) {
        setFormError('Selected model is not available for the chosen connected provider.');
        setSaving(false);
        return;
      }

      // Validate claude-code required fields client-side
      if (form.runtime_type === 'claude-code' && !form.raw_json_expanded) {
        if (!normalizeClaudeRuntimeConfig(form.runtime_config).workingDirectory.trim()) {
          setFormError('Working Directory is required for Claude Code runtime.');
          setSaving(false);
          return;
        }
      }

      if (form.runtime_type === 'hermes' && !form.raw_json_expanded) {
        const hermesConfig = normalizeHermesRuntimeConfig(form.runtime_config);
        if (!hermesConfig?.profile?.trim()) {
          setFormError('Hermes profile is required so the runtime stays isolated per agent.');
          setSaving(false);
          return;
        }
      }

      // Validate raw JSON if expanded
      if ((form.runtime_type === 'claude-code' || form.runtime_type === 'hermes') && form.raw_json_expanded) {
        try {
          const parsed = JSON.parse(form.raw_json) as Record<string, unknown>;
          if (form.runtime_type === 'claude-code' && !parsed.workingDirectory) {
            setFormError('runtime_config.workingDirectory is required for claude-code runtime.');
            setSaving(false);
            return;
          }
          if (form.runtime_type === 'hermes' && !String(parsed.profile ?? '').trim()) {
            setFormError('runtime_config.profile is required for hermes runtime.');
            setSaving(false);
            return;
          }
        } catch {
          setFormError('Invalid JSON in raw config editor.');
          setSaving(false);
          return;
        }
      }

      if (editId) {
        const payload = buildUpdatePayload();
        await api.updateAgent(editId, payload);
        setShowForm(false);
        load(filterProjectId);
      } else {
        const { provision_openclaw: _p, raw_json: _r, raw_json_expanded: _re, ...createData } = form;
        const payload = {
          ...createData,
          model: createData.model || null,
          provision_openclaw: form.provision_openclaw,
          // Only attach runtime_config when relevant to the selected runtime
          runtime_config: (form.runtime_type === 'claude-code' || form.runtime_type === 'hermes') ? buildUpdatePayload().runtime_config : null,
        };
        const created = await api.createAgent(payload);
        // Only offer OpenClaw provision when the runtime is openclaw
        if (form.runtime_type === 'openclaw') {
          setProvision({ phase: 'pending', agentId: created.id });
        } else {
          setShowForm(false);
        }
        load(filterProjectId);
      }
    } catch (e) {
      setFormError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleProvision = async (agentId: number) => {
    setProvision({ phase: 'loading', agentId });
    try {
      const result = await api.provisionAgent(agentId);
      setProvision({
        phase: 'success',
        agentId,
        session_key: result.session_key,
        workspace_path: result.workspace_path,
      });
      load(filterProjectId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setProvision({ phase: 'error', agentId, message: msg });
    }
  };

  const handleToggleEnabled = async (agent: Agent) => {
    try {
      await api.updateAgent(agent.id, { enabled: agent.enabled ? 0 : 1 });
      load(filterProjectId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Failed to toggle agent "${agent.name}": ${msg}`);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`Delete agent "${name}"? Historical tasks and runs will be preserved.`)) return;
    try {
      const result = await api.deleteAgent(id);
      setDeleteNotice(buildAgentDeleteNotice(name, result));
      load(filterProjectId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Failed to delete agent "${name}": ${msg}`);
    }
  };

  const allProviderOptions = getAgentProviderOptions(providers);
  // Filter out OpenClaw-only providers (e.g. MiniMax) if the runtime is not OpenClaw
  const providerOptions = form.runtime_type === 'openclaw'
    ? allProviderOptions
    : allProviderOptions.filter(opt => !isOpenClawOnlyProvider(opt.value));
  const claudeRuntimeConfig = normalizeClaudeRuntimeConfig(form.runtime_config);
  const hermesRuntimeConfig = normalizeHermesRuntimeConfig(form.runtime_config);
  const modelOptions = getAgentModelOptionsForProvider(form.preferred_provider);
  const currentModelUnavailable = !!form.model && !isModelAllowedForProvider(form.model, form.preferred_provider);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Agents</h1>
          <p className="text-slate-400 text-sm mt-1">Registered agents and their runtime adapters</p>
        </div>
        <Button variant="primary" onClick={openCreate}>
          <Plus className="w-4 h-4" /> New Agent
        </Button>
      </div>

      {deleteNotice && (
        <AgentDeleteNotice
          notice={deleteNotice}
          onDismiss={() => setDeleteNotice(null)}
        />
      )}

      {/* Project filter */}
      <div className="flex items-center gap-2">
        <FolderOpen className="w-4 h-4 text-slate-500 shrink-0" />
        <div className="relative">
          <select
            className="appearance-none bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-8 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-amber-500 cursor-pointer"
            value={filterProjectId ?? ''}
            onChange={e => setFilterProjectId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">All Projects</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
        </div>
        {filterProjectId && (
          <button
            onClick={() => setFilterProjectId(null)}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Form */}
      {showForm && (
        <Card className="border-amber-500/30">
          <h2 className="font-semibold text-white mb-4">{editId ? 'Edit Agent' : 'New Agent'}</h2>

          {/* Provision success / pending state — shown after create */}
          {provision.phase === 'pending' && (
            <div className="mb-4 p-4 bg-emerald-900/20 border border-emerald-600/30 rounded-lg flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-sm text-emerald-300">
                <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                Agent created successfully.
              </div>
              <Button
                variant="primary"
                onClick={() => handleProvision(provision.agentId)}
              >
                <Zap className="w-3.5 h-3.5" /> Provision OpenClaw Agent
              </Button>
            </div>
          )}

          {provision.phase === 'loading' && (
            <div className="mb-4 p-4 bg-amber-900/20 border border-amber-600/30 rounded-lg flex items-center gap-2 text-sm text-amber-300">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              Provisioning agent workspace and registering with OpenClaw…
            </div>
          )}

          {provision.phase === 'success' && (
            <div className="mb-4 p-4 bg-emerald-900/20 border border-emerald-500/40 rounded-lg space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-300">
                <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                Provisioned successfully
              </div>
              <div className="text-xs text-slate-400 space-y-0.5 pl-6">
                <div>Session: <code className="text-amber-300 bg-slate-700 px-1 rounded">{provision.session_key}</code></div>
                <div>Workspace: <code className="text-slate-300 bg-slate-700 px-1 rounded text-xs">{provision.workspace_path}</code></div>
              </div>
            </div>
          )}

          {provision.phase === 'error' && (
            <div className="mb-4 p-4 bg-red-900/20 border border-red-600/40 rounded-lg space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-medium text-red-300">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                Provisioning failed
              </div>
              <p className="text-xs text-red-400 pl-6">{provision.message}</p>
              <div className="pl-6">
                <Button variant="ghost" onClick={() => handleProvision(provision.agentId)}>
                  <Zap className="w-3.5 h-3.5" /> Retry
                </Button>
              </div>
            </div>
          )}

          {provision.phase === 'idle' && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">Name *</span>
                  <input
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Atlas"
                  />
                </label>
                <label className="block md:col-span-2">
                  <span className="text-slate-400 text-xs mb-1 block">Role</span>
                  <input
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                    value={form.role}
                    onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                    placeholder="General assistant — main session"
                  />
                </label>

                {/* Runtime type selector — first-class choice */}
                <label className="block md:col-span-2">
                  <span className="text-slate-400 text-xs mb-1 block">Runtime Adapter *</span>
                  <p className="text-slate-500 text-xs mb-1.5">Select the runtime that will execute this agent&apos;s tasks. Runtime-specific settings appear below.</p>
                  <div className="relative">
                    <select
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 appearance-none pr-8"
                      value={form.runtime_type}
                      onChange={e => {
                        const rt = e.target.value as FormState['runtime_type'];
                        setForm(f => {
                          const nextProvider = rt !== 'openclaw' && isOpenClawOnlyProvider(f.preferred_provider)
                            ? (allProviderOptions.find(opt => !isOpenClawOnlyProvider(opt.value))?.value ?? '')
                            : f.preferred_provider;
                          return {
                            ...f,
                            runtime_type: rt,
                            runtime_config: rt === 'claude-code'
                              ? normalizeClaudeRuntimeConfig(f.runtime_config)
                              : rt === 'hermes'
                                ? normalizeHermesRuntimeConfig(f.runtime_config)
                                : null,
                            preferred_provider: nextProvider,
                            model: nextProvider !== f.preferred_provider ? '' : f.model,
                            // Reset openclaw-specific provision toggle if switching away
                            provision_openclaw: rt === 'openclaw' ? f.provision_openclaw : false,
                            raw_json: rt === 'claude-code'
                              ? claudeRuntimeConfigToJson(normalizeClaudeRuntimeConfig(f.runtime_config))
                              : rt === 'hermes'
                                ? hermesRuntimeConfigToJson(normalizeHermesRuntimeConfig(f.runtime_config))
                                : '',
                            raw_json_expanded: false,
                          };
                        });
                      }}
                    >
                      {RUNTIME_TYPE_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                  </div>
                </label>

                {/* Preferred provider */}
                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">Preferred Provider</span>
                  <p className="text-slate-500 text-xs mb-1.5">Only connected providers from Settings → Providers can be selected here.</p>
                  <div className="relative">
                    <select
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 appearance-none pr-8"
                      value={form.preferred_provider}
                      onChange={e => setForm(f => ({ ...f, preferred_provider: e.target.value, model: '' }))}
                      disabled={providerOptions.length === 0}
                    >
                      {providerOptions.length === 0 ? (
                        <option value="">No connected providers</option>
                      ) : (
                        providerOptions.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))
                      )}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                  </div>
                </label>

                {/* Model picker constrained by provider */}
                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">Model</span>
                  {isLocalModelProvider(form.preferred_provider) ? (
                    <input
                      type="text"
                      value={form.model}
                      onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
                      placeholder="e.g. llama3.2 or mlx-community/Mistral-7B"
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-amber-500"
                    />
                  ) : isDynamicModelProvider(form.preferred_provider) ? (
                    <div className="relative">
                      {dynamicModelsLoading ? (
                        <div className="flex items-center gap-2 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-slate-400 text-sm">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Fetching models…
                        </div>
                      ) : dynamicModelsError ? (
                        <div className="px-3 py-2 bg-red-900/20 border border-red-600/40 rounded-lg text-red-300 text-xs">
                          {dynamicModelsError}
                        </div>
                      ) : (
                        <>
                          <select
                            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 appearance-none pr-8"
                            value={form.model}
                            onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
                            disabled={dynamicModels.length === 0}
                          >
                            <option value="">Default (inherit)</option>
                            {dynamicModels.map(m => (
                              <option key={m.id} value={m.id}>{m.label}</option>
                            ))}
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="relative">
                      <select
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 appearance-none pr-8"
                        value={currentModelUnavailable ? '' : form.model}
                        onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
                        disabled={!form.preferred_provider || modelOptions.length === 0}
                      >
                        <option value="">Default (inherit)</option>
                        {modelOptions.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                    </div>
                  )}
                  {currentModelUnavailable && (
                    <p className="text-amber-400 text-xs mt-1.5">Current saved model is no longer available for the selected connected provider. Pick a new one or use Default.</p>
                  )}
                </label>

                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">Status</span>
                  <select
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                    value={form.status}
                    onChange={e => setForm(f => ({ ...f, status: e.target.value as FormState['status'] }))}
                  >
                    <option value="idle">Idle</option>
                    <option value="running">Running</option>
                    <option value="blocked">Blocked</option>
                  </select>
                </label>
              </div>

              {/* OpenClaw adapter section — only shown when runtime_type = 'openclaw' */}
              {form.runtime_type === 'openclaw' && (
                <div className="mt-4 p-4 bg-amber-950/20 border border-amber-500/20 rounded-lg space-y-4">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-amber-300 uppercase tracking-wider">OpenClaw Adapter Config</span>
                  </div>

                  {/* OpenClaw provision toggle */}
                  {!editId && (
                    <label className="flex items-center gap-3 cursor-pointer group">
                      <div className="relative">
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={form.provision_openclaw}
                          onChange={e => setForm(f => ({ ...f, provision_openclaw: e.target.checked }))}
                        />
                        <div className={`w-10 h-5 rounded-full transition-colors ${form.provision_openclaw ? 'bg-amber-500' : 'bg-slate-600'}`} />
                        <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.provision_openclaw ? 'translate-x-5' : ''}`} />
                      </div>
                      <div>
                        <span className="text-sm font-medium text-white">Auto-provision OpenClaw workspace</span>
                        <p className="text-xs text-slate-500">Runs <code className="bg-slate-700 px-1 rounded">openclaw agents add</code> · auto-derives session key &amp; workspace</p>
                      </div>
                    </label>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <label className="block">
                      <span className="text-slate-400 text-xs mb-1 block">
                        Session Key
                        <span className="text-slate-600 ml-1">(auto: agent:&lt;project&gt;:&lt;agent&gt;:&lt;role&gt;:main)</span>
                      </span>
                      <input
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 disabled:opacity-40"
                        value={form.session_key}
                        onChange={e => setForm(f => ({ ...f, session_key: e.target.value }))}
                        placeholder="auto-generated if left blank"
                      />
                    </label>
                    <label className="block">
                      <span className="text-slate-400 text-xs mb-1 block">
                        Workspace Path
                        {form.provision_openclaw && <span className="text-amber-500/70 ml-1">(auto-generated)</span>}
                      </span>
                      <input
                        className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none transition-colors ${
                          form.provision_openclaw
                            ? 'bg-slate-800 border-slate-700 text-slate-500 cursor-not-allowed'
                            : 'bg-slate-700 border-slate-600 text-white focus:border-amber-500'
                        }`}
                        value={form.workspace_path}
                        onChange={e => !form.provision_openclaw && setForm(f => ({ ...f, workspace_path: e.target.value }))}
                        placeholder={form.provision_openclaw ? 'auto-generated from name' : '/path/to/workspace'}
                        readOnly={form.provision_openclaw}
                      />
                    </label>
                  </div>
                </div>
              )}

              {(form.runtime_type === 'openclaw' || form.runtime_type === 'claude-code' || form.runtime_type === 'hermes') && (
                <div className="mt-4 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-xs text-slate-400">
                  Repository settings now live on the project. Create or assign the agent first, then configure repo access from the project page.
                </div>
              )}

              {/* Claude Code runtime config section */}
              {form.runtime_type === 'claude-code' && (
                <div className="mt-4 p-4 bg-purple-950/20 border border-purple-500/20 rounded-lg space-y-4">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-purple-300 uppercase tracking-wider">Claude Code Config</span>
                  </div>

                  {!form.raw_json_expanded && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <label className="block md:col-span-2">
                        <span className="text-slate-400 text-xs mb-1 block">
                          Working Directory <span className="text-red-400">*</span>
                        </span>
                        <input
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
                          value={claudeRuntimeConfig.workingDirectory}
                          onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeClaudeRuntimeConfig(f.runtime_config), workingDirectory: e.target.value } }))}
                          placeholder=".openclaw/workspace-<agent-slug>"
                        />
                      </label>

                      <label className="block">
                        <span className="text-slate-400 text-xs mb-1 block">Model</span>
                        <input
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 font-mono"
                          value={claudeRuntimeConfig.model ?? ''}
                          onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeClaudeRuntimeConfig(f.runtime_config), model: e.target.value } }))}
                          placeholder="claude-sonnet-4-6"
                          list="cc-model-suggestions"
                        />
                        <datalist id="cc-model-suggestions">
                          <option value="claude-sonnet-4-6" />
                          <option value="claude-opus-4-6" />
                          <option value="claude-haiku-4-5" />
                        </datalist>
                      </label>

                      <label className="block">
                        <span className="text-slate-400 text-xs mb-1 block">Effort Level</span>
                        <div className="relative">
                          <select
                            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 appearance-none pr-8"
                            value={claudeRuntimeConfig.effort ?? 'medium'}
                            onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeClaudeRuntimeConfig(f.runtime_config), effort: e.target.value as ClaudeCodeRuntimeConfig['effort'] } }))}
                          >
                            {EFFORT_OPTIONS.map(o => (
                              <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>
                            ))}
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                        </div>
                      </label>

                      <label className="block">
                        <span className="text-slate-400 text-xs mb-1 block">Max Turns <span className="text-slate-600">(optional)</span></span>
                        <input
                          type="number"
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
                          value={claudeRuntimeConfig.maxTurns ?? ''}
                          onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeClaudeRuntimeConfig(f.runtime_config), maxTurns: e.target.value ? Number(e.target.value) : undefined } }))}
                          placeholder="e.g. 50"
                          min={1}
                        />
                      </label>

                      <label className="block">
                        <span className="text-slate-400 text-xs mb-1 block">Max Budget USD <span className="text-slate-600">(optional)</span></span>
                        <input
                          type="number"
                          step="0.01"
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
                          value={claudeRuntimeConfig.maxBudgetUsd ?? ''}
                          onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeClaudeRuntimeConfig(f.runtime_config), maxBudgetUsd: e.target.value ? Number(e.target.value) : undefined } }))}
                          placeholder="e.g. 5.00"
                          min={0}
                        />
                      </label>

                      <label className="block md:col-span-2">
                        <span className="text-slate-400 text-xs mb-1 block">System Prompt Suffix <span className="text-slate-600">(optional)</span></span>
                        <textarea
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 resize-y min-h-[60px]"
                          value={claudeRuntimeConfig.systemPromptSuffix ?? ''}
                          onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeClaudeRuntimeConfig(f.runtime_config), systemPromptSuffix: e.target.value } }))}
                          placeholder="Additional instructions appended to the system prompt…"
                        />
                      </label>

                      <label className="block md:col-span-2">
                        <span className="text-slate-400 text-xs mb-1 block">Allowed Tools <span className="text-slate-600">(comma-separated, optional)</span></span>
                        <input
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 font-mono"
                          value={((claudeRuntimeConfig.allowedTools) ?? []).join(', ')}
                          onChange={e => setForm(f => ({
                            ...f,
                            runtime_config: {
                              ...normalizeClaudeRuntimeConfig(f.runtime_config),
                              allowedTools: e.target.value ? e.target.value.split(',').map(t => t.trim()).filter(Boolean) : [],
                            }
                          }))}
                          placeholder="Bash, Read, Write, Edit"
                        />
                      </label>
                    </div>
                  )}

                  {/* Raw JSON fallback */}
                  <div className="border-t border-purple-500/10 pt-3">
                    <button
                      type="button"
                      className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-300 transition-colors"
                      onClick={() => {
                        if (!form.raw_json_expanded) {
                          // Sync form → json before opening
                          setForm(f => ({
                            ...f,
                            raw_json: claudeRuntimeConfigToJson(normalizeClaudeRuntimeConfig(f.runtime_config)),
                            raw_json_expanded: true,
                          }));
                        } else {
                          setForm(f => ({ ...f, raw_json_expanded: false }));
                        }
                      }}
                    >
                      <ChevronRight className={`w-3.5 h-3.5 transition-transform ${form.raw_json_expanded ? 'rotate-90' : ''}`} />
                      Raw JSON editor {form.raw_json_expanded ? '(collapse)' : '(advanced)'}
                    </button>
                    {form.raw_json_expanded && (
                      <div className="mt-2">
                        <textarea
                          className="w-full bg-slate-900 border border-purple-500/30 rounded-lg px-3 py-2 text-purple-200 text-xs font-mono focus:outline-none focus:border-purple-400 resize-y min-h-[140px]"
                          value={form.raw_json}
                          onChange={e => setForm(f => ({ ...f, raw_json: e.target.value }))}
                          spellCheck={false}
                        />
                        <p className="text-xs text-slate-500 mt-1">JSON is used as-is. <code>workingDirectory</code> is required.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {form.runtime_type === 'hermes' && (
                <div className="mt-4 p-4 bg-fuchsia-950/20 border border-fuchsia-500/20 rounded-lg space-y-4">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-fuchsia-300 uppercase tracking-wider">Hermes Runtime Config</span>
                  </div>
                  <p className="text-xs text-slate-400">Hermes runs as a local CLI-backed runtime. Profile is required for agent isolation. Provider and model are optional overrides, and Agent HQ keeps lifecycle ownership in proxy mode.</p>

                  {!form.raw_json_expanded && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <label className="block">
                        <span className="text-slate-400 text-xs mb-1 block">Hermes Binary</span>
                        <input
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-fuchsia-500 font-mono"
                          value={hermesRuntimeConfig.hermesBin ?? 'hermes'}
                          onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeHermesRuntimeConfig(f.runtime_config), hermesBin: e.target.value } }))}
                          placeholder="hermes"
                        />
                      </label>
                      <label className="block">
                        <span className="text-slate-400 text-xs mb-1 block">Profile <span className="text-red-400">*</span></span>
                        <input
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-fuchsia-500"
                          value={hermesRuntimeConfig.profile ?? ''}
                          onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeHermesRuntimeConfig(f.runtime_config), profile: e.target.value } }))}
                          placeholder="agent-hq-hermes-prism"
                        />
                        <p className="text-xs text-slate-500 mt-1">Required. Use a dedicated Hermes profile so sessions, memory, and auth do not bleed across agents.</p>
                      </label>
                      <label className="block">
                        <span className="text-slate-400 text-xs mb-1 block">Invocation Mode</span>
                        <div className="relative">
                          <select
                            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-fuchsia-500 appearance-none pr-8"
                            value={hermesRuntimeConfig.invocationMode ?? 'z'}
                            onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeHermesRuntimeConfig(f.runtime_config), invocationMode: e.target.value as HermesRuntimeConfig['invocationMode'] } }))}
                          >
                            <option value="z">One-shot (-z)</option>
                            <option value="chat-q">chat -q</option>
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                        </div>
                        <p className="text-xs text-slate-500 mt-1">Default to one-shot mode for deterministic task dispatch.</p>
                      </label>
                      <label className="block">
                        <span className="text-slate-400 text-xs mb-1 block">Lifecycle Mode</span>
                        <input
                          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-400 text-sm font-mono"
                          value="proxy"
                          readOnly
                        />
                        <p className="text-xs text-slate-500 mt-1">Fixed for now. Agent HQ remains the source of truth for start, progress, and completion.</p>
                      </label>
                      <label className="block">
                        <span className="text-slate-400 text-xs mb-1 block">Hermes Provider Override <span className="text-slate-600">(optional)</span></span>
                        <input
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-fuchsia-500 font-mono"
                          value={hermesRuntimeConfig.provider ?? ''}
                          onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeHermesRuntimeConfig(f.runtime_config), provider: e.target.value || null } }))}
                          placeholder="anthropic"
                        />
                      </label>
                      <label className="block">
                        <span className="text-slate-400 text-xs mb-1 block">Hermes Model Override <span className="text-slate-600">(optional)</span></span>
                        <input
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-fuchsia-500 font-mono"
                          value={hermesRuntimeConfig.model ?? ''}
                          onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeHermesRuntimeConfig(f.runtime_config), model: e.target.value || null } }))}
                          placeholder="claude-sonnet-4-6"
                        />
                      </label>
                      <label className="block">
                        <span className="text-slate-400 text-xs mb-1 block">Fast Mode <span className="text-slate-600">(optional)</span></span>
                        <select
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-fuchsia-500"
                          value={hermesRuntimeConfig.fastMode == null ? '' : String(hermesRuntimeConfig.fastMode)}
                          onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeHermesRuntimeConfig(f.runtime_config), fastMode: e.target.value === '' ? null : e.target.value === 'true' } }))}
                        >
                          <option value="">Runtime default</option>
                          <option value="true">On</option>
                          <option value="false">Off</option>
                        </select>
                      </label>
                      <label className="block md:col-span-2">
                        <span className="text-slate-400 text-xs mb-1 block">Extra Args <span className="text-slate-600">(comma-separated, optional)</span></span>
                        <input
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-fuchsia-500 font-mono"
                          value={(hermesRuntimeConfig.extraArgs ?? []).join(', ')}
                          onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeHermesRuntimeConfig(f.runtime_config), extraArgs: e.target.value ? e.target.value.split(',').map(arg => arg.trim()).filter(Boolean) : [] } }))}
                          placeholder="--ignore-user-config, --ignore-rules"
                        />
                      </label>
                      <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-3">
                        <label className="flex items-start gap-2 text-sm text-slate-300">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={Boolean(hermesRuntimeConfig.ignoreUserConfig)}
                            onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeHermesRuntimeConfig(f.runtime_config), ignoreUserConfig: e.target.checked } }))}
                          />
                          <span><span className="font-medium text-white">Ignore user config</span><br /><span className="text-xs text-slate-500">Optional hardening. Only enable when the operator wants Hermes to ignore host-level personal config.</span></span>
                        </label>
                        <label className="flex items-start gap-2 text-sm text-slate-300">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={Boolean(hermesRuntimeConfig.ignoreRules)}
                            onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeHermesRuntimeConfig(f.runtime_config), ignoreRules: e.target.checked } }))}
                          />
                          <span><span className="font-medium text-white">Ignore rules</span><br /><span className="text-xs text-slate-500">Optional. Suppresses ambient Hermes rules when a clean dispatch boundary matters more than inherited context.</span></span>
                        </label>
                        <label className="flex items-start gap-2 text-sm text-slate-300">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={Boolean(hermesRuntimeConfig.passSessionId)}
                            onChange={e => setForm(f => ({ ...f, runtime_config: { ...normalizeHermesRuntimeConfig(f.runtime_config), passSessionId: e.target.checked } }))}
                          />
                          <span><span className="font-medium text-white">Pass session id</span><br /><span className="text-xs text-slate-500">Optional. Only enable if the Hermes adapter is explicitly wired to consume Agent HQ session ids.</span></span>
                        </label>
                      </div>
                    </div>
                  )}

                  <div className="border-t border-fuchsia-500/10 pt-3">
                    <button
                      type="button"
                      className="flex items-center gap-1.5 text-xs text-fuchsia-400 hover:text-fuchsia-300 transition-colors"
                      onClick={() => {
                        if (!form.raw_json_expanded) {
                          setForm(f => ({
                            ...f,
                            raw_json: hermesRuntimeConfigToJson(normalizeHermesRuntimeConfig(f.runtime_config)),
                            raw_json_expanded: true,
                          }));
                        } else {
                          setForm(f => ({ ...f, raw_json_expanded: false }));
                        }
                      }}
                    >
                      <ChevronRight className={`w-3.5 h-3.5 transition-transform ${form.raw_json_expanded ? 'rotate-90' : ''}`} />
                      Raw JSON editor {form.raw_json_expanded ? '(collapse)' : '(advanced)'}
                    </button>
                    {form.raw_json_expanded && (
                      <div className="mt-2">
                        <textarea
                          className="w-full bg-slate-900 border border-fuchsia-500/30 rounded-lg px-3 py-2 text-fuchsia-200 text-xs font-mono focus:outline-none focus:border-fuchsia-400 resize-y min-h-[140px]"
                          value={form.raw_json}
                          onChange={e => setForm(f => ({ ...f, raw_json: e.target.value }))}
                          spellCheck={false}
                        />
                        <p className="text-xs text-slate-500 mt-1">JSON is used as-is. <code>profile</code> is required. Provider and model overrides are optional.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {formError && <p className="text-red-400 text-xs mt-3">{formError}</p>}
              <div className="flex gap-2 mt-4">
                <Button variant="primary" onClick={handleSave} loading={saving}>
                  <Check className="w-3.5 h-3.5" /> {editId ? 'Save' : 'Create'}
                </Button>
                <Button variant="ghost" onClick={() => setShowForm(false)}>
                  <X className="w-3.5 h-3.5" /> Cancel
                </Button>
              </div>
            </>
          )}

          {/* After create: done / close */}
          {(provision.phase === 'pending' || provision.phase === 'loading' || provision.phase === 'success' || provision.phase === 'error') && (
            <div className="mt-4 flex gap-2">
              <Button variant="ghost" onClick={() => { setShowForm(false); setProvision({ phase: 'idle' }); }}>
                <X className="w-3.5 h-3.5" /> Close
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* Agents list */}
      {agents.length === 0 ? (
        <Card data-tour-target="agents-list">
          <div className="text-center py-12">
            <Bot className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-400">No agents yet</p>
            <p className="text-slate-500 text-sm mt-1">Create your first agent to get started</p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-tour-target="agents-list">
          {agents.map(agent => (
            <Card key={agent.id} className="hover:border-slate-600 transition-colors">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusDot status={agent.status} />
                  <h3 className="font-semibold text-white">{agent.name}</h3>
                  <span className="text-xs font-medium text-slate-300 bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded whitespace-nowrap">
                    Agent #{agent.id}
                  </span>
                  {runtimeBadge(agent)}
                </div>
                <div className="flex gap-1 shrink-0">
                  <Link href={`/agents/${agent.id}?mode=edit`}><Button variant="ghost" size="sm"><Pencil className="w-3.5 h-3.5" /></Button></Link>
                  <Button variant="ghost" size="sm" onClick={() => handleDelete(agent.id, agent.name)}>
                    <Trash2 className="w-3.5 h-3.5 text-red-400" />
                  </Button>
                </div>
              </div>
              <p className="text-slate-400 text-sm mb-3 truncate">{agent.role || <span className="italic text-slate-600">No role set</span>}</p>

              {/* Enabled status */}
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                {agent.enabled != null && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggleEnabled(agent); }}
                    className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border cursor-pointer transition-colors ${
                      agent.enabled
                        ? 'text-emerald-300 bg-emerald-900/30 border-emerald-600/30 hover:bg-emerald-900/50'
                        : 'text-slate-500 bg-slate-800 border-slate-700 hover:bg-slate-700'
                    }`}
                    title={agent.enabled ? 'Click to disable' : 'Click to enable'}
                  >
                    <Power className="w-2.5 h-2.5" />
                    {agent.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={agent.status}>{agent.status}</Badge>
                <code className="text-xs text-slate-500 bg-slate-700/50 px-1.5 py-0.5 rounded">
                  {agent.session_key}
                </code>
                {agent.openclaw_agent_id && (
                  <span className="text-xs text-amber-500/70 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                    native
                  </span>
                )}
              </div>
              {(agent.model || agent.preferred_provider) && (
                <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                  {agent.preferred_provider && (
                    <span className="text-xs text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/20">
                      {PROVIDER_LABELS[agent.preferred_provider as keyof typeof PROVIDER_LABELS] ?? agent.preferred_provider}
                    </span>
                  )}
                  {agent.model && (
                    <span className="text-xs text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded border border-indigo-500/20 font-mono">
                      {getAgentModelLabel(agent.model)}
                    </span>
                  )}
                </div>
              )}
              {/* Claude Code runtime config summary */}
              {agent.runtime_type === 'claude-code' && agent.runtime_config && (
                <div className="mt-2 text-xs text-purple-300/70 font-mono bg-purple-950/20 border border-purple-500/10 rounded px-2 py-1 truncate">
                  📁 {(agent.runtime_config as ClaudeCodeRuntimeConfig).workingDirectory || '—'}
                </div>
              )}
              {agent.runtime_type === 'hermes' && agent.runtime_config && (
                <div className="mt-2 text-xs text-fuchsia-300/70 font-mono bg-fuchsia-950/20 border border-fuchsia-500/10 rounded px-2 py-1 truncate">
                  ϟ profile {(agent.runtime_config as HermesRuntimeConfig).profile || '—'}
                </div>
              )}
              {agent.last_active && (
                <p className="text-slate-600 text-xs mt-3">
                  Last active: {formatDateTime(agent.last_active)}
                </p>
              )}
              <div className="mt-3 pt-3 border-t border-slate-700/50 flex items-center justify-between">
                <Link href={`/agents/${agent.id}`} className="text-xs text-amber-400 hover:underline">
                  View details →
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
