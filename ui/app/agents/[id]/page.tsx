'use client';
import { formatDateTime, formatTime } from '@/lib/date';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { api, Agent, AgentRuntimeType, JobInstance, LogEntry, AgentDoc, ProvisionStatus, ClaudeMdResult, Tool, AgentToolAssignment, AgentMcpAssignment, ClaudeCodeRuntimeConfig, CodexRuntimeConfig, HermesRuntimeConfig, AgentRuntimeConfig, McpServer, ProviderConnectionRecord, ProviderRecord, AgentMcpPermissionPolicy, AgentMcpPermissionCapability, AgentMcpServerToolAllowlist, AgentMcpToolAllowlistPolicy, ProviderSlug, RuntimeDriverDiagnostic } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge, StatusDot } from '@/components/ui/badge';
import { getRunLifecycle, getRunStatusLabel } from '@/lib/runLifecycle';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft, Bot, Clock, Activity, FileText, Zap, CheckCircle, AlertCircle, Loader2,
  Link2, RefreshCw, Edit2, Save, X, Pencil, Trash2, Power, Settings, BookOpen,
  Wrench, Plus, Search, ChevronDown, ChevronRight, Server, Shield,
} from 'lucide-react';
import Link from 'next/link';
import { AgentTeamsCard } from '@/components/AgentTeamsCard';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DEFAULT_CLAUDE_ALLOWED_TOOLS, claudeRuntimeConfigToJson, defaultClaudeWorkspaceHint, serializeClaudeRuntimeConfig } from '@/lib/claudeRuntimeConfig';
import {
  getAgentModelLabel,
  getAgentModelOptionsForProvider,
  getAgentProviderOptions,
  isDynamicModelProvider,
  isProviderSupportedByRuntime,
  isProviderConnected,
  PROVIDER_LABELS,
} from '@/lib/providerOptions';

// ─── Edit form state ──────────────────────────────────────────────────────────

const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CODEX_REASONING_EFFORT_OPTIONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

const RUNTIME_TYPE_OPTIONS: Array<{ value: AgentRuntimeType; label: string }> = [
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'webhook', label: 'Webhook' },
];

interface EditFormState {
  // Core agent fields
  name: string;
  role: string;
  session_key: string;
  workspace_path: string;
  status: 'idle' | 'running' | 'blocked';
  model: string;
  preferred_provider: string;
  provider_connection_id: string;
  runtime_type: AgentRuntimeType;
  runtime_config: AgentRuntimeConfig;
  raw_json: string;
  raw_json_expanded: boolean;
  // Job / execution fields (T#619)
  job_instructions: string;
  skill_names: string; // comma-separated in the input; serialised to array on save
  timeout_seconds: string; // stored as string for the input
  startup_grace_seconds: string; // stored as string for the input; empty = use global default
  heartbeat_stale_seconds: string; // stored as string for the input; empty = use global default
}

const emptyClaudeRuntimeConfig: ClaudeCodeRuntimeConfig = {
  workingDirectory: '',
  model: '',
  effort: 'medium',
  allowedTools: [...DEFAULT_CLAUDE_ALLOWED_TOOLS],
  permissionMode: 'allowlist',
  allowDangerousBypass: false,
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

const emptyCodexRuntimeConfig: CodexRuntimeConfig = {
  codexBin: 'codex',
  workingDirectory: '',
  model: '',
  reasoningEffort: 'high',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'never',
  skipGitRepoCheck: false,
  codexHomeRoot: '',
  extraArgs: [],
  env: {},
};

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

function codexRuntimeConfigToJson(cfg: CodexRuntimeConfig): string {
  const out: Record<string, unknown> = {
    codexBin: cfg.codexBin?.trim() || 'codex',
    sandboxMode: cfg.sandboxMode ?? 'workspace-write',
    approvalPolicy: cfg.approvalPolicy ?? 'never',
  };
  if (cfg.workingDirectory) out.workingDirectory = cfg.workingDirectory;
  if (cfg.model) out.model = cfg.model;
  if (cfg.reasoningEffort) out.reasoningEffort = cfg.reasoningEffort;
  if (cfg.codexHomeRoot) out.codexHomeRoot = cfg.codexHomeRoot;
  if (cfg.codexHome) out.codexHome = cfg.codexHome;
  if (cfg.providerConnectionExternalRef) out.providerConnectionExternalRef = cfg.providerConnectionExternalRef;
  if (cfg.skipGitRepoCheck) out.skipGitRepoCheck = true;
  if (cfg.resumeSessionId) out.resumeSessionId = cfg.resumeSessionId;
  if (cfg.extraArgs?.length) out.extraArgs = cfg.extraArgs;
  if (cfg.env && Object.keys(cfg.env).length > 0) out.env = cfg.env;
  if (cfg.killGraceMs != null) out.killGraceMs = cfg.killGraceMs;
  if (cfg.allowDangerousFullAccess) out.allowDangerousFullAccess = true;
  return JSON.stringify(out, null, 2);
}

function agentToForm(agent: Agent, providers: ProviderRecord[] = []): EditFormState {
  const runtimeType = agent.runtime_type ?? 'openclaw';
  const rc = agent.runtime_config ?? (
    runtimeType === 'hermes'
      ? { ...emptyHermesRuntimeConfig }
      : runtimeType === 'codex'
        ? { ...emptyCodexRuntimeConfig }
        : { ...emptyClaudeRuntimeConfig }
  );
  const providerOptions = getAgentProviderOptions(providers);
  const savedProvider = agent.preferred_provider ?? '';
  const preferredProvider = providerOptions.some(option => option.value === savedProvider)
    ? savedProvider
    : providerOptions[0]?.value ?? '';
  const model = preferredProvider === savedProvider ? agent.model ?? '' : '';
  return {
    name: agent.name,
    role: agent.role ?? '',
    session_key: agent.session_key,
    workspace_path: agent.workspace_path,
    status: agent.status,
    model,
    preferred_provider: preferredProvider,
    provider_connection_id: agent.provider_connection_id ? String(agent.provider_connection_id) : '',
    runtime_type: runtimeType,
    runtime_config: {
      ...(runtimeType === 'hermes'
        ? {
            hermesBin: (rc as HermesRuntimeConfig).hermesBin ?? 'hermes',
            profile: (rc as HermesRuntimeConfig).profile ?? '',
            provider: (rc as HermesRuntimeConfig).provider ?? null,
            model: (rc as HermesRuntimeConfig).model ?? null,
            fastMode: (rc as HermesRuntimeConfig).fastMode ?? null,
            extraArgs: (rc as HermesRuntimeConfig).extraArgs ?? [],
            env: (rc as HermesRuntimeConfig).env ?? {},
            invocationMode: (rc as HermesRuntimeConfig).invocationMode ?? 'z',
            ignoreUserConfig: (rc as HermesRuntimeConfig).ignoreUserConfig ?? false,
            ignoreRules: (rc as HermesRuntimeConfig).ignoreRules ?? false,
            passSessionId: (rc as HermesRuntimeConfig).passSessionId ?? false,
          }
        : runtimeType === 'codex'
          ? {
              codexBin: (rc as CodexRuntimeConfig).codexBin ?? 'codex',
              workingDirectory: (rc as CodexRuntimeConfig).workingDirectory ?? '',
              model: (rc as CodexRuntimeConfig).model ?? '',
              reasoningEffort: (rc as CodexRuntimeConfig).reasoningEffort ?? 'high',
              sandboxMode: (rc as CodexRuntimeConfig).sandboxMode ?? 'workspace-write',
              approvalPolicy: (rc as CodexRuntimeConfig).approvalPolicy ?? 'never',
              allowDangerousFullAccess: (rc as CodexRuntimeConfig).allowDangerousFullAccess ?? false,
              skipGitRepoCheck: (rc as CodexRuntimeConfig).skipGitRepoCheck ?? false,
              codexHomeRoot: (rc as CodexRuntimeConfig).codexHomeRoot ?? '',
              codexHome: (rc as CodexRuntimeConfig).codexHome,
              providerConnectionExternalRef: (rc as CodexRuntimeConfig).providerConnectionExternalRef,
              resumeSessionId: (rc as CodexRuntimeConfig).resumeSessionId,
              extraArgs: (rc as CodexRuntimeConfig).extraArgs ?? [],
              env: (rc as CodexRuntimeConfig).env ?? {},
              killGraceMs: (rc as CodexRuntimeConfig).killGraceMs,
            }
          : {
            claudeBin: (rc as ClaudeCodeRuntimeConfig).claudeBin,
            workingDirectory: (rc as ClaudeCodeRuntimeConfig).workingDirectory ?? '',
            model: (rc as ClaudeCodeRuntimeConfig).model ?? '',
            effort: (rc as ClaudeCodeRuntimeConfig).effort ?? 'medium',
            allowedTools: (rc as ClaudeCodeRuntimeConfig).allowedTools ?? [...DEFAULT_CLAUDE_ALLOWED_TOOLS],
            disallowedTools: [...((rc as ClaudeCodeRuntimeConfig).disallowedTools ?? [])],
            permissionMode: (rc as ClaudeCodeRuntimeConfig).permissionMode ?? 'allowlist',
            allowDangerousBypass: (rc as ClaudeCodeRuntimeConfig).allowDangerousBypass ?? false,
            maxTurns: (rc as ClaudeCodeRuntimeConfig).maxTurns,
            maxBudgetUsd: (rc as ClaudeCodeRuntimeConfig).maxBudgetUsd,
            systemPromptSuffix: (rc as ClaudeCodeRuntimeConfig).systemPromptSuffix ?? '',
            extraArgs: [...((rc as ClaudeCodeRuntimeConfig).extraArgs ?? [])],
            env: { ...((rc as ClaudeCodeRuntimeConfig).env ?? {}) },
            killGraceMs: (rc as ClaudeCodeRuntimeConfig).killGraceMs,
            claudeConfigDir: (rc as ClaudeCodeRuntimeConfig).claudeConfigDir,
            providerConnectionExternalRef: (rc as ClaudeCodeRuntimeConfig).providerConnectionExternalRef,
          }),
    },
    raw_json: runtimeType === 'claude-code'
      ? claudeRuntimeConfigToJson(rc as ClaudeCodeRuntimeConfig)
      : runtimeType === 'codex'
        ? codexRuntimeConfigToJson(rc as CodexRuntimeConfig)
        : runtimeType === 'hermes'
          ? hermesRuntimeConfigToJson(rc as HermesRuntimeConfig)
          : '',
    raw_json_expanded: false,
    job_instructions: agent.job_instructions ?? '',
    skill_names: (agent.skill_names ?? []).join(', '),
    timeout_seconds: agent.timeout_seconds ? String(agent.timeout_seconds) : '900',
    startup_grace_seconds: agent.startup_grace_seconds ? String(agent.startup_grace_seconds) : '',
    heartbeat_stale_seconds: agent.heartbeat_stale_seconds ? String(agent.heartbeat_stale_seconds) : '',
  };
}

function formatMcpPolicyLabel(policy: AgentMcpPermissionPolicy | null): string {
  if (!policy) return 'Loading';
  if (policy.policy_mode === 'explicit') return 'Custom policy';
  return policy.default_policy === 'trusted_admin' ? 'Default trusted admin policy' : 'Default scoped runtime policy';
}

function groupMcpCapabilities(capabilities: AgentMcpPermissionCapability[]): Array<[string, AgentMcpPermissionCapability[]]> {
  const grouped = new Map<string, AgentMcpPermissionCapability[]>();
  for (const capability of capabilities) {
    const bucket = grouped.get(capability.group) ?? [];
    bucket.push(capability);
    grouped.set(capability.group, bucket);
  }
  return Array.from(grouped.entries());
}

// ─── Provision UI state ───────────────────────────────────────────────────────

type ProvisionUIState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'success'; session_key: string; workspace_path: string }
  | { phase: 'error'; message: string };

// ─── Component ────────────────────────────────────────────────────────────────

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = Number(params.id);

  const [agent, setAgent] = useState<Agent | null>(null);
  const [instances, setInstances] = useState<JobInstance[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [docs, setDocs] = useState<AgentDoc[]>([]);
  const [activeDoc, setActiveDoc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [provisionStatus, setProvisionStatus] = useState<ProvisionStatus | null>(null);
  const [provisionUI, setProvisionUI] = useState<ProvisionUIState>({ phase: 'idle' });

  // Edit mode (T#619)
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState<EditFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [localMlxOnline, setLocalMlxOnline] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [providerConnections, setProviderConnections] = useState<ProviderConnectionRecord[]>([]);
  const [dynamicModels, setDynamicModels] = useState<Array<{ id: string; label: string }>>([]);
  const [dynamicModelsLoading, setDynamicModelsLoading] = useState(false);
  const [dynamicModelsError, setDynamicModelsError] = useState<string | null>(null);
  const [runtimeDiagnostic, setRuntimeDiagnostic] = useState<RuntimeDriverDiagnostic | null>(null);
  const [runtimeDiagnosticLoading, setRuntimeDiagnosticLoading] = useState(false);
  const [runtimeDiagnosticError, setRuntimeDiagnosticError] = useState<string | null>(null);

  // Capabilities (assigned tools)
  const [agentTools, setAgentTools] = useState<AgentToolAssignment[]>([]);
  const [allTools, setAllTools] = useState<Tool[]>([]);
  const [showAddTool, setShowAddTool] = useState(false);
  const [toolSearch, setToolSearch] = useState('');
  const [addingTool, setAddingTool] = useState<number | null>(null);
  const [removingTool, setRemovingTool] = useState<number | null>(null);

  // Capabilities (assigned MCP servers)
  const [agentMcpServers, setAgentMcpServers] = useState<AgentMcpAssignment[]>([]);
  const [allMcpServers, setAllMcpServers] = useState<McpServer[]>([]);
  const [showAddMcpServer, setShowAddMcpServer] = useState(false);
  const [mcpSearch, setMcpSearch] = useState('');
  const [addingMcpServer, setAddingMcpServer] = useState<number | null>(null);
  const [removingMcpServer, setRemovingMcpServer] = useState<number | null>(null);

  // Agent HQ MCP permissions
  const [mcpPermissionPolicy, setMcpPermissionPolicy] = useState<AgentMcpPermissionPolicy | null>(null);
  const [mcpPermissionDraft, setMcpPermissionDraft] = useState<AgentMcpPermissionCapability[]>([]);
  // Per-server MCP tool allowlists (separate from Agent HQ capability policy)
  const [mcpToolAllowlists, setMcpToolAllowlists] = useState<AgentMcpServerToolAllowlist[]>([]);
  const [mcpToolAllowlistDraft, setMcpToolAllowlistDraft] = useState<Record<number, string>>({});
  const [mcpToolAllowlistSavingId, setMcpToolAllowlistSavingId] = useState<number | null>(null);
  const [mcpToolAllowlistError, setMcpToolAllowlistError] = useState<string | null>(null);
  const [mcpPermissionSaving, setMcpPermissionSaving] = useState(false);
  const [mcpPermissionError, setMcpPermissionError] = useState<string | null>(null);

  // Capabilities (assigned skills)
  const [allSkills, setAllSkills] = useState<import('@/lib/api').SkillEntry[]>([]);
  const [showAddSkill, setShowAddSkill] = useState(false);
  const [skillSearch, setSkillSearch] = useState('');
  const [addingSkill, setAddingSkill] = useState<string | null>(null);
  const [removingSkill, setRemovingSkill] = useState<string | null>(null);

  // CLAUDE.md state
  const [claudeMd, setClaudeMd] = useState<ClaudeMdResult | null>(null);
  const [claudeMdLoading, setClaudeMdLoading] = useState(false);
  const [claudeMdError, setClaudeMdError] = useState<string | null>(null);
  const [claudeMdEditing, setClaudeMdEditing] = useState(false);
  const [claudeMdEditValue, setClaudeMdEditValue] = useState('');
  const [claudeMdSaving, setClaudeMdSaving] = useState(false);
  const [claudeMdSaveError, setClaudeMdSaveError] = useState<string | null>(null);
  const [claudeMdRegening, setClaudeMdRegening] = useState(false);
  const [claudeMdRegenError, setClaudeMdRegenError] = useState<string | null>(null);

  // Remote Gateway URL inline editor. Stored as hooks_url for compatibility.
  const [hooksUrlEditing, setHooksUrlEditing] = useState(false);
  const [hooksUrlValue, setHooksUrlValue] = useState('');
  const [hooksUrlSaving, setHooksUrlSaving] = useState(false);
  const [hooksUrlError, setHooksUrlError] = useState<string | null>(null);
  const hooksUrlInputRef = useRef<HTMLInputElement>(null);

  // Delete state
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // ── Loaders ─────────────────────────────────────────────────────────────────

  const loadProvisionStatus = () => {
    api.getProvisionStatus(id)
      .then(s => setProvisionStatus(s))
      .catch(() => setProvisionStatus(null));
  };

  const loadClaudeMd = (agentRuntimeType?: string) => {
    const rt = agentRuntimeType ?? agent?.runtime_type;
    if (rt !== 'claude-code') return;
    setClaudeMdLoading(true);
    setClaudeMdError(null);
    api.getClaudeMd(id)
      .then(r => setClaudeMd(r))
      .catch(e => {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('does not exist') || msg.includes('404')) {
          setClaudeMd({ exists: false, content: null, path: null, last_modified: null });
        } else {
          setClaudeMdError(msg);
        }
      })
      .finally(() => setClaudeMdLoading(false));
  };

  // ── Edit mode helpers ────────────────────────────────────────────────────────

  const enterEditMode = (a: Agent, availableProviders = providers) => {
    setEditForm(agentToForm(a, availableProviders));
    setSaveError(null);
    setEditMode(true);
    // Check local-mlx status
    fetch('/api/local-mlx-status', { signal: AbortSignal.timeout(5000) })
      .then(r => r.json()).then((d: { online: boolean }) => setLocalMlxOnline(d.online))
      .catch(() => setLocalMlxOnline(false));
  };

  const cancelEdit = () => {
    setEditMode(false);
    setEditForm(null);
    setSaveError(null);
    // Strip ?mode=edit from URL
    router.replace(`/agents/${id}`);
  };

  const buildSavePayload = (form: EditFormState) => {
    const base: Record<string, unknown> = {
      name: form.name,
      role: form.role,
      session_key: form.session_key,
      workspace_path: form.workspace_path,
      status: form.status,
      model: form.model.trim() || null,
      preferred_provider: form.preferred_provider || null,
      provider_connection_id: form.provider_connection_id ? Number(form.provider_connection_id) : null,
      runtime_type: form.runtime_type,
      runtime_config: null as AgentRuntimeConfig | null,
      job_instructions: form.job_instructions,
      skill_names: form.skill_names
        ? form.skill_names.split(',').map(s => s.trim()).filter(Boolean)
        : [],
      timeout_seconds: form.timeout_seconds ? Number(form.timeout_seconds) : 900,
      startup_grace_seconds: form.startup_grace_seconds ? Number(form.startup_grace_seconds) : null,
      heartbeat_stale_seconds: form.heartbeat_stale_seconds ? Number(form.heartbeat_stale_seconds) : null,
    };

    if (form.runtime_type === 'claude-code') {
      if (form.raw_json_expanded) {
        base.runtime_config = JSON.parse(form.raw_json) as ClaudeCodeRuntimeConfig;
      } else {
        const runtimeConfig = form.runtime_config as ClaudeCodeRuntimeConfig;
        base.runtime_config = serializeClaudeRuntimeConfig(runtimeConfig);
      }
    }

    if (form.runtime_type === 'codex') {
      if (form.raw_json_expanded) {
        base.runtime_config = JSON.parse(form.raw_json) as CodexRuntimeConfig;
      } else {
        const runtimeConfig = form.runtime_config as CodexRuntimeConfig;
        base.runtime_config = {
          ...runtimeConfig,
          codexBin: runtimeConfig.codexBin?.trim() || 'codex',
          workingDirectory: runtimeConfig.workingDirectory?.trim() || undefined,
          model: runtimeConfig.model?.trim() || undefined,
          codexHomeRoot: runtimeConfig.codexHomeRoot?.trim() || undefined,
        };
      }
    }

    if (form.runtime_type === 'hermes') {
      if (form.raw_json_expanded) {
        base.runtime_config = JSON.parse(form.raw_json) as HermesRuntimeConfig;
      } else {
        const runtimeConfig = form.runtime_config as HermesRuntimeConfig;
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
    if (!editForm) return;
    setSaving(true);
    setSaveError(null);
    try {
      const connectionAvailable = providerConnections.some(connection =>
        connection.id === Number(editForm.provider_connection_id)
        && connection.runtime_type === editForm.runtime_type
        && connection.provider_slug === editForm.preferred_provider
        && connection.status === 'connected'
      );
      if (!editForm.preferred_provider || (!isProviderConnected(providers, editForm.preferred_provider) && !connectionAvailable)) {
        setSaveError('Select a connected provider in Settings → Providers before saving this agent.');
        setSaving(false);
        return;
      }
      if (editForm.runtime_type === 'hermes' && !editForm.raw_json_expanded) {
        if (!((editForm.runtime_config as HermesRuntimeConfig).profile ?? '').trim()) {
          setSaveError('Hermes profile is required so the runtime stays isolated per agent.');
          setSaving(false);
          return;
        }
      }
      if ((editForm.runtime_type === 'claude-code' || editForm.runtime_type === 'codex' || editForm.runtime_type === 'hermes') && editForm.raw_json_expanded) {
        try {
          const parsed = JSON.parse(editForm.raw_json) as Record<string, unknown>;
          if (editForm.runtime_type === 'hermes' && !String(parsed.profile ?? '').trim()) {
            setSaveError('runtime_config.profile is required for hermes runtime.');
            setSaving(false);
            return;
          }
          if (editForm.runtime_type === 'codex' && parsed.sandboxMode === 'danger-full-access' && parsed.allowDangerousFullAccess !== true) {
            setSaveError('Codex danger-full-access requires allowDangerousFullAccess: true.');
            setSaving(false);
            return;
          }
        } catch {
          setSaveError('Invalid JSON in raw config editor.');
          setSaving(false);
          return;
        }
      }

      const payload = buildSavePayload(editForm);
      const updated = await api.updateAgent(id, payload as Partial<Agent>);
      setAgent(updated);
      setEditMode(false);
      setEditForm(null);
      router.replace(`/agents/${id}`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleMcpCapability = (key: string) => {
    setMcpPermissionDraft((current) => current.map((capability) => (
      capability.key === key ? { ...capability, enabled: !capability.enabled } : capability
    )));
  };

  const saveMcpPermissions = async () => {
    setMcpPermissionSaving(true);
    setMcpPermissionError(null);
    try {
      const updated = await api.updateAgentMcpPermissions(
        id,
        mcpPermissionDraft.filter((capability) => capability.enabled).map((capability) => capability.key),
      );
      setMcpPermissionPolicy(updated);
      setMcpPermissionDraft(updated.capabilities);
    } catch (e) {
      setMcpPermissionError(e instanceof Error ? e.message : String(e));
    } finally {
      setMcpPermissionSaving(false);
    }
  };

  const resetMcpPermissions = async () => {
    setMcpPermissionSaving(true);
    setMcpPermissionError(null);
    try {
      const updated = await api.resetAgentMcpPermissions(id);
      setMcpPermissionPolicy(updated);
      setMcpPermissionDraft(updated.capabilities);
    } catch (e) {
      setMcpPermissionError(e instanceof Error ? e.message : String(e));
    } finally {
      setMcpPermissionSaving(false);
    }
  };

  // ── CLAUDE.md helpers ────────────────────────────────────────────────────────

  const saveClaudeMd = async () => {
    setClaudeMdSaving(true);
    setClaudeMdSaveError(null);
    try {
      const updated = await api.updateClaudeMd(id, claudeMdEditValue);
      setClaudeMd(updated);
      setClaudeMdEditing(false);
    } catch (e) {
      setClaudeMdSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setClaudeMdSaving(false);
    }
  };

  const regenClaudeMd = async () => {
    if (!confirm('This will overwrite your manual edits. Continue?')) return;
    setClaudeMdRegening(true);
    setClaudeMdRegenError(null);
    try {
      const updated = await api.regenClaudeMd(id);
      setClaudeMd(updated);
      setClaudeMdEditing(false);
    } catch (e) {
      setClaudeMdRegenError(e instanceof Error ? e.message : String(e));
    } finally {
      setClaudeMdRegening(false);
    }
  };

  const startEditHooksUrl = () => {
    setHooksUrlValue(agent?.hooks_url ?? '');
    setHooksUrlError(null);
    setHooksUrlEditing(true);
    setTimeout(() => hooksUrlInputRef.current?.focus(), 50);
  };

  const saveHooksUrl = async () => {
    if (!agent) return;
    setHooksUrlSaving(true);
    setHooksUrlError(null);
    try {
      const trimmed = hooksUrlValue.trim();
      const updated = await api.updateAgent(id, { hooks_url: trimmed || null });
      setAgent(updated);
      setHooksUrlEditing(false);
    } catch (e) {
      setHooksUrlError(e instanceof Error ? e.message : String(e));
    } finally {
      setHooksUrlSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const result = await api.deleteAgent(id);
      const redirectParams = new URLSearchParams({
        deleted_agent: agent?.name ?? 'Agent',
      });
      if (result.archived) {
        redirectParams.set('deleted_agent_archived', '1');
      }
      router.push(`/agents?${redirectParams.toString()}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Failed to delete agent: ${msg}`);
      setDeleting(false);
      setDeleteConfirmOpen(false);
    }
  };

  // ── Effects ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    Promise.all([
      api.getAgent(id),
      api.getInstances().then(all => all.filter(i => i.agent_id === id).slice(0, 20)),
      api.getLogs({ agent_id: id, limit: 30 }),
      api.getAgentDocs(id),
      api.getAgentTools(id).catch(() => [] as AgentToolAssignment[]),
      api.getAgentMcpServers(id).catch(() => [] as AgentMcpAssignment[]),
      api.getAgentMcpPermissions(id).catch(() => null as AgentMcpPermissionPolicy | null),
      api.getAgentMcpToolAllowlists(id).catch(() => null as AgentMcpToolAllowlistPolicy | null),
      api.getTools().catch(() => [] as Tool[]),
      api.getMcpServers().catch(() => [] as McpServer[]),
      api.getProviders().catch(() => ({ providers: [] })),
      api.getProviderConnections().catch(() => ({ connections: [] as ProviderConnectionRecord[] })),
      api.getSkills().catch(() => [] as import('@/lib/api').SkillEntry[]),
    ])
      .then(([a, inst, lg, d, atools, amcp, permissionPolicy, toolAllowlistPolicy, tools, mcpServers, providerResponse, connectionResponse, skills]) => {
        setAgent(a);
        setInstances(inst);
        setLogs(lg);
        setDocs(d);
        setAgentTools(atools);
        setAgentMcpServers(amcp);
        setMcpPermissionPolicy(permissionPolicy);
        setMcpPermissionDraft(permissionPolicy?.capabilities ?? []);
        setMcpToolAllowlists(toolAllowlistPolicy?.servers ?? []);
        setMcpToolAllowlistDraft(Object.fromEntries(
          (toolAllowlistPolicy?.servers ?? []).map((server) => [server.mcp_server_id, server.tool_allowlist.join('\n')]),
        ));
        setAllTools(tools);
        setAllMcpServers(mcpServers);
        setAllSkills(skills);
        setProviders(providerResponse.providers);
        setProviderConnections(connectionResponse.connections);
        const firstExisting = d.find((doc: AgentDoc) => doc.exists);
        if (firstExisting) setActiveDoc(firstExisting.filename);
        if (a.runtime_type === 'claude-code') loadClaudeMd('claude-code');
        // Auto-enter edit mode if ?mode=edit is in the URL
        if (searchParams.get('mode') === 'edit') {
          enterEditMode(a, providerResponse.providers);
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));

    loadProvisionStatus();
  }, [id]);

  // Fetch dynamic models when MiniMax (or any dynamic-model provider) is selected in edit mode
  useEffect(() => {
    if (!editForm || !isDynamicModelProvider(editForm.preferred_provider)) {
      setDynamicModels([]);
      setDynamicModelsError(null);
      return;
    }
    setDynamicModelsLoading(true);
    setDynamicModelsError(null);
    api.getProviderModels(editForm.preferred_provider as ProviderSlug)
      .then(r => {
        setDynamicModels(r.models);
        setDynamicModelsLoading(false);
      })
      .catch(e => {
        setDynamicModelsError(e instanceof Error ? e.message : String(e));
        setDynamicModelsLoading(false);
      });
  }, [editForm?.preferred_provider]);

  const handleProvision = async () => {
    setProvisionUI({ phase: 'loading' });
    try {
      const result = await api.provisionAgent(id);
      setProvisionUI({
        phase: 'success',
        session_key: result.session_key,
        workspace_path: result.workspace_path,
      });
      setProvisionStatus({ provisioned: true, session_key: result.session_key, workspace_path: result.workspace_path });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setProvisionUI({ phase: 'error', message: msg });
    }
  };

  const handleRuntimeDiagnostic = async () => {
    setRuntimeDiagnosticLoading(true);
    setRuntimeDiagnosticError(null);
    try {
      setRuntimeDiagnostic(await api.diagnoseRuntimeDriver({ agent_id: id }));
    } catch (diagnosticError) {
      setRuntimeDiagnostic(null);
      setRuntimeDiagnosticError(diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError));
    } finally {
      setRuntimeDiagnosticLoading(false);
    }
  };

  // ── Guards ───────────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="bg-red-900/30 border border-red-700 rounded-xl p-6 text-red-300">{error}</div>
  );

  if (!agent) return null;

  const isProvisioned = provisionStatus?.provisioned || (provisionUI.phase === 'success');
  const resolvedSessionKey = provisionUI.phase === 'success'
    ? provisionUI.session_key
    : provisionStatus?.session_key ?? null;
  const resolvedWorkspacePath = provisionUI.phase === 'success'
    ? provisionUI.workspace_path
    : provisionStatus?.workspace_path ?? null;

  // ── Edit mode render ─────────────────────────────────────────────────────────

  if (editMode && editForm) {
    const setF = (patch: Partial<EditFormState>) => setEditForm(f => f ? { ...f, ...patch } : f);
    const eligibleConnections = providerConnections.filter(connection => connection.runtime_type === editForm.runtime_type && connection.status === 'connected');
    const configuredProviderOptions = getAgentProviderOptions(providers);
    const allProviderOptions = [
      ...configuredProviderOptions,
      ...Array.from(new Set(eligibleConnections.map(connection => connection.provider_slug)))
        .filter(slug => !configuredProviderOptions.some(option => option.value === slug))
        .map(slug => ({ value: slug, label: PROVIDER_LABELS[slug as keyof typeof PROVIDER_LABELS] ?? slug })),
    ];
    const providerOptions = allProviderOptions.filter(opt => isProviderSupportedByRuntime(opt.value, editForm.runtime_type));
    const matchingConnections = eligibleConnections.filter(connection => connection.provider_slug === editForm.preferred_provider);
    const modelOptions = getAgentModelOptionsForProvider(editForm.preferred_provider);
    const modelSuggestions = isDynamicModelProvider(editForm.preferred_provider)
      ? dynamicModels.map(model => ({ value: model.id, label: model.label }))
      : modelOptions;

    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={cancelEdit}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className="flex items-center gap-2">
              <Pencil className="w-4 h-4 text-amber-400" />
              <h1 className="text-2xl font-bold text-white">Edit Agent</h1>
              <span className="text-slate-500 text-lg">—</span>
              <span className="text-xl text-slate-300">{agent.name}</span>
              <span className="text-xs font-medium text-slate-300 bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded whitespace-nowrap">
                Agent #{agent.id}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={handleSave} loading={saving}>
              <Save className="w-4 h-4" /> Save Changes
            </Button>
            <Button variant="ghost" onClick={cancelEdit}>
              <X className="w-4 h-4" /> Cancel
            </Button>
          </div>
        </div>

        {saveError && (
          <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-4 text-red-300 text-sm">
            {saveError}
          </div>
        )}

        {/* Section 1: Core Identity */}
        <Card className="border-amber-500/20">
          <div className="flex items-center gap-2 mb-5">
            <Bot className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white">Core Identity</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-slate-400 text-xs mb-1 block">Name *</span>
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={editForm.name}
                onChange={e => setF({ name: e.target.value })}
                placeholder="Atlas"
              />
            </label>
            <label className="block md:col-span-2">
              <span className="text-slate-400 text-xs mb-1 block">Role</span>
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={editForm.role}
                onChange={e => setF({ role: e.target.value })}
                placeholder="General assistant — main session"
              />
            </label>

            {/* Runtime adapter — locked after creation */}
            <div className="block md:col-span-2">
              <span className="text-slate-400 text-xs mb-1 block">Runtime Adapter</span>
              <p className="text-slate-500 text-xs mb-1.5">
                Runtime type is locked after creation — changing it would break existing sessions and dispatch config.
              </p>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg">
                  <span className="text-white text-sm">
                    {RUNTIME_TYPE_OPTIONS.find(o => o.value === editForm.runtime_type)?.label ?? editForm.runtime_type}
                  </span>
                  <span className="text-xs text-slate-500 bg-slate-700 px-1.5 py-0.5 rounded">locked</span>
                </div>
              </div>
            </div>

            <label className="block">
              <span className="text-slate-400 text-xs mb-1 block">Preferred Provider</span>
              <p className="text-slate-500 text-xs mb-1.5">Only connected providers from Settings → Providers can be selected here.</p>
              <div className="relative">
                <select
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 appearance-none pr-8"
                  value={editForm.preferred_provider}
                  onChange={e => {
                    const provider = e.target.value;
                    const connection = eligibleConnections.find(item => item.provider_slug === provider);
                    setF({ preferred_provider: provider, provider_connection_id: connection ? String(connection.id) : '', model: '' });
                  }}
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
            {matchingConnections.length > 0 && (
              <label className="block">
                <span className="text-slate-400 text-xs mb-1 block">Runtime Credential</span>
                <p className="text-slate-500 text-xs mb-1.5">Select a credential owned by {editForm.runtime_type}.</p>
                <div className="relative">
                  <select
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 appearance-none pr-8"
                    value={editForm.provider_connection_id}
                    onChange={e => setF({ provider_connection_id: e.target.value })}
                  >
                    {isProviderConnected(providers, editForm.preferred_provider) && <option value="">Provider default / API key</option>}
                    {matchingConnections.map(connection => <option key={connection.id} value={connection.id}>{connection.display_name}</option>)}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                </div>
              </label>
            )}
            <label className="block">
              <span className="text-slate-400 text-xs mb-1 block">Model</span>
              <input
                type="text"
                value={editForm.model}
                onChange={e => setF({ model: e.target.value })}
                placeholder="e.g. openai-codex/gpt-5.4"
                list="agent-edit-model-suggestions"
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-amber-500"
              />
              <datalist id="agent-edit-model-suggestions">
                {modelSuggestions.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </datalist>
              {isDynamicModelProvider(editForm.preferred_provider) && dynamicModelsLoading && (
                <p className="text-slate-500 text-xs mt-1.5 flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Fetching model suggestions…
                </p>
              )}
              {isDynamicModelProvider(editForm.preferred_provider) && dynamicModelsError && (
                <p className="text-amber-400 text-xs mt-1.5">{dynamicModelsError}</p>
              )}
              <p className="text-slate-500 text-xs mt-1.5">Enter any provider-supported model identifier. Suggestions are optional.</p>
            </label>
            <label className="block">
              <span className="text-slate-400 text-xs mb-1 block">Status</span>
              <div className="relative">
                <select
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 appearance-none pr-8"
                  value={editForm.status}
                  onChange={e => setF({ status: e.target.value as EditFormState['status'] })}
                >
                  <option value="idle">Idle</option>
                  <option value="running">Running</option>
                  <option value="blocked">Blocked</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              </div>
            </label>
          </div>

          {/* OpenClaw adapter config — scoped to openclaw runtime */}
          {editForm.runtime_type === 'openclaw' && (
            <div className="mt-4 p-4 bg-amber-950/20 border border-amber-500/20 rounded-lg">
              <span className="text-xs font-semibold text-amber-300 uppercase tracking-wider block mb-3">OpenClaw Adapter Config</span>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">Session Key *</span>
                  <input
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 font-mono"
                    value={editForm.session_key}
                    onChange={e => setF({ session_key: e.target.value })}
                    placeholder="main"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">Workspace Path</span>
                  <input
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 font-mono"
                    value={editForm.workspace_path}
                    onChange={e => setF({ workspace_path: e.target.value })}
                    placeholder="/path/to/workspace"
                  />
                </label>
              </div>
            </div>
          )}


          {/* Claude Code runtime config */}
          {editForm.runtime_type === 'claude-code' && (
            <div className="mt-4 p-4 bg-purple-950/20 border border-purple-500/20 rounded-lg space-y-4">
              <span className="text-xs font-semibold text-purple-300 uppercase tracking-wider">Claude Code Config</span>
              {!editForm.raw_json_expanded && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label className="block md:col-span-2">
                    <span className="text-slate-400 text-xs mb-1 block">Working Directory <span className="text-slate-600">(optional — leave blank)</span></span>
                    <input
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 font-mono"
                      value={(editForm.runtime_config as ClaudeCodeRuntimeConfig).workingDirectory}
                      onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as ClaudeCodeRuntimeConfig), workingDirectory: e.target.value } })}
                      placeholder={editForm.workspace_path || defaultClaudeWorkspaceHint(editForm.name)}
                    />
                    <p className="text-slate-500 text-xs mt-1.5">
                      Left blank, the agent falls back to its workspace above. A workflow&apos;s repo or task worktree takes precedence over both.
                    </p>
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Model</span>
                    <input
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 font-mono"
                      value={(editForm.runtime_config as ClaudeCodeRuntimeConfig).model ?? ''}
                      onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as ClaudeCodeRuntimeConfig), model: e.target.value } })}
                      placeholder="claude-opus-5"
                    />
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Effort Level</span>
                    <div className="relative">
                      <select
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 appearance-none pr-8"
                        value={(editForm.runtime_config as ClaudeCodeRuntimeConfig).effort ?? 'medium'}
                        onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as ClaudeCodeRuntimeConfig), effort: e.target.value as ClaudeCodeRuntimeConfig['effort'] } })}
                      >
                        {EFFORT_OPTIONS.map(o => <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                    </div>
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Max Turns <span className="text-slate-600">(optional)</span></span>
                    <input
                      type="number"
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
                      value={(editForm.runtime_config as ClaudeCodeRuntimeConfig).maxTurns ?? ''}
                      onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as ClaudeCodeRuntimeConfig), maxTurns: e.target.value ? Number(e.target.value) : undefined } })}
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
                      value={(editForm.runtime_config as ClaudeCodeRuntimeConfig).maxBudgetUsd ?? ''}
                      onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as ClaudeCodeRuntimeConfig), maxBudgetUsd: e.target.value ? Number(e.target.value) : undefined } })}
                      placeholder="e.g. 5.00"
                    />
                  </label>
                  <label className="block md:col-span-2">
                    <span className="text-slate-400 text-xs mb-1 block">System Prompt Suffix <span className="text-slate-600">(optional)</span></span>
                    <textarea
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 resize-y min-h-[60px]"
                      value={(editForm.runtime_config as ClaudeCodeRuntimeConfig).systemPromptSuffix ?? ''}
                      onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as ClaudeCodeRuntimeConfig), systemPromptSuffix: e.target.value } })}
                      placeholder="Additional instructions appended to the system prompt…"
                    />
                  </label>
                  <label className="block md:col-span-2">
                    <span className="text-slate-400 text-xs mb-1 block">Allowed Tools <span className="text-slate-600">(comma-separated)</span></span>
                    <input
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 font-mono"
                      value={(((editForm.runtime_config as ClaudeCodeRuntimeConfig).allowedTools) ?? []).join(', ')}
                      onChange={e => setF({
                        runtime_config: {
                          ...(editForm.runtime_config as ClaudeCodeRuntimeConfig),
                          allowedTools: e.target.value ? e.target.value.split(',').map(t => t.trim()).filter(Boolean) : [],
                        }
                      })}
                      placeholder="Bash, Read, Write, Edit"
                    />
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Permission Posture</span>
                    <select
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
                      value={(editForm.runtime_config as ClaudeCodeRuntimeConfig).permissionMode ?? 'allowlist'}
                      onChange={e => setF({
                        runtime_config: {
                          ...(editForm.runtime_config as ClaudeCodeRuntimeConfig),
                          permissionMode: e.target.value as ClaudeCodeRuntimeConfig['permissionMode'],
                          ...(e.target.value === 'allowlist' ? { allowDangerousBypass: false } : {}),
                        },
                      })}
                    >
                      <option value="allowlist">Tool allowlist (recommended)</option>
                      <option value="bypass">Unrestricted bypass</option>
                    </select>
                  </label>
                  {(editForm.runtime_config as ClaudeCodeRuntimeConfig).permissionMode === 'bypass' && (
                    <label className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-950/20 p-3 text-xs text-red-200">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={(editForm.runtime_config as ClaudeCodeRuntimeConfig).allowDangerousBypass === true}
                        onChange={e => setF({
                          runtime_config: {
                            ...(editForm.runtime_config as ClaudeCodeRuntimeConfig),
                            allowDangerousBypass: e.target.checked,
                          },
                        })}
                      />
                      I understand this disables Claude Code permission checks and grants host-level tool access.
                    </label>
                  )}
                </div>
              )}
              <div className="border-t border-purple-500/10 pt-3">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-300 transition-colors"
                  onClick={() => {
                    if (!editForm.raw_json_expanded) {
                      setF({ raw_json: claudeRuntimeConfigToJson(editForm.runtime_config as ClaudeCodeRuntimeConfig), raw_json_expanded: true });
                    } else {
                      setF({ raw_json_expanded: false });
                    }
                  }}
                >
                  <ChevronRight className={`w-3.5 h-3.5 transition-transform ${editForm.raw_json_expanded ? 'rotate-90' : ''}`} />
                  Raw JSON editor {editForm.raw_json_expanded ? '(collapse)' : '(advanced)'}
                </button>
                {editForm.raw_json_expanded && (
                  <textarea
                    className="mt-2 w-full bg-slate-900 border border-purple-500/30 rounded-lg px-3 py-2 text-purple-200 text-xs font-mono focus:outline-none focus:border-purple-400 resize-y min-h-[140px]"
                    value={editForm.raw_json}
                    onChange={e => setF({ raw_json: e.target.value })}
                    spellCheck={false}
                  />
                )}
              </div>
            </div>
          )}

          {editForm.runtime_type === 'codex' && (
            <div className="mt-4 p-4 bg-sky-950/20 border border-sky-500/20 rounded-lg space-y-4">
              <div>
                <span className="text-xs font-semibold text-sky-300 uppercase tracking-wider">Codex Runtime Config</span>
                <p className="text-xs text-slate-400 mt-1">Defaults to a non-interactive workspace-write sandbox and an isolated per-agent CODEX_HOME.</p>
              </div>
              {!editForm.raw_json_expanded && (() => {
                const config = editForm.runtime_config as CodexRuntimeConfig;
                return (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <label className="block">
                      <span className="text-slate-400 text-xs mb-1 block">Codex Binary</span>
                      <input className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-sky-500" value={config.codexBin ?? 'codex'} onChange={e => setF({ runtime_config: { ...config, codexBin: e.target.value } })} />
                    </label>
                    <label className="block">
                      <span className="text-slate-400 text-xs mb-1 block">Model Override <span className="text-slate-600">(optional)</span></span>
                      <input className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-sky-500" value={config.model ?? ''} onChange={e => setF({ runtime_config: { ...config, model: e.target.value } })} placeholder="gpt-5.5" />
                    </label>
                    <label className="block md:col-span-2">
                      <span className="text-slate-400 text-xs mb-1 block">Working Directory <span className="text-slate-600">(optional workflow fallback)</span></span>
                      <input className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-sky-500" value={config.workingDirectory ?? ''} onChange={e => setF({ runtime_config: { ...config, workingDirectory: e.target.value } })} />
                    </label>
                    <label className="block">
                      <span className="text-slate-400 text-xs mb-1 block">Reasoning Effort</span>
                      <select className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-sky-500" value={config.reasoningEffort ?? 'high'} onChange={e => setF({ runtime_config: { ...config, reasoningEffort: e.target.value as CodexRuntimeConfig['reasoningEffort'] } })}>
                        {CODEX_REASONING_EFFORT_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-slate-400 text-xs mb-1 block">Approval Policy</span>
                      <select className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-sky-500" value={config.approvalPolicy ?? 'never'} onChange={e => setF({ runtime_config: { ...config, approvalPolicy: e.target.value as CodexRuntimeConfig['approvalPolicy'] } })}>
                        <option value="never">Never (non-interactive)</option>
                        <option value="on-request">On request</option>
                        <option value="untrusted">Untrusted commands</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-slate-400 text-xs mb-1 block">Sandbox</span>
                      <select className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-sky-500" value={config.sandboxMode ?? 'workspace-write'} onChange={e => setF({ runtime_config: { ...config, sandboxMode: e.target.value as CodexRuntimeConfig['sandboxMode'], allowDangerousFullAccess: e.target.value === 'danger-full-access' ? false : undefined } })}>
                        <option value="workspace-write">Workspace write (recommended)</option>
                        <option value="read-only">Read only</option>
                        <option value="danger-full-access">Danger: full host access</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-slate-400 text-xs mb-1 block">Codex Home Root <span className="text-slate-600">(optional)</span></span>
                      <input className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-sky-500" value={config.codexHomeRoot ?? ''} onChange={e => setF({ runtime_config: { ...config, codexHomeRoot: e.target.value } })} />
                    </label>
                    <label className="md:col-span-2 flex items-start gap-2 text-sm text-slate-300">
                      <input type="checkbox" className="mt-0.5" checked={Boolean(config.skipGitRepoCheck)} onChange={e => setF({ runtime_config: { ...config, skipGitRepoCheck: e.target.checked } })} />
                      <span><span className="font-medium text-white">Skip Git repository check</span><br /><span className="text-xs text-slate-500">Only enable for intentionally non-Git workflows.</span></span>
                    </label>
                    {config.sandboxMode === 'danger-full-access' && (
                      <label className="md:col-span-2 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-200">
                        <input type="checkbox" className="mt-0.5" checked={config.allowDangerousFullAccess === true} onChange={e => setF({ runtime_config: { ...config, allowDangerousFullAccess: e.target.checked } })} />
                        <span><span className="font-semibold">I understand this disables the Codex filesystem sandbox.</span><br /><span className="text-xs text-red-300/80">The run can modify files outside its worktree. This confirmation is required and never enabled automatically.</span></span>
                      </label>
                    )}
                  </div>
                );
              })()}
              <div className="border-t border-sky-500/10 pt-3">
                <button type="button" className="flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300" onClick={() => setF({ raw_json: !editForm.raw_json_expanded ? codexRuntimeConfigToJson(editForm.runtime_config as CodexRuntimeConfig) : editForm.raw_json, raw_json_expanded: !editForm.raw_json_expanded })}>
                  <ChevronRight className={`w-3.5 h-3.5 transition-transform ${editForm.raw_json_expanded ? 'rotate-90' : ''}`} /> Raw JSON editor {editForm.raw_json_expanded ? '(collapse)' : '(advanced)'}
                </button>
                {editForm.raw_json_expanded && <textarea className="mt-2 w-full bg-slate-900 border border-sky-500/30 rounded-lg px-3 py-2 text-sky-200 text-xs font-mono min-h-[180px]" value={editForm.raw_json} onChange={e => setF({ raw_json: e.target.value })} spellCheck={false} />}
              </div>
            </div>
          )}

          {editForm.runtime_type === 'hermes' && (
            <div className="mt-4 p-4 bg-fuchsia-950/20 border border-fuchsia-500/20 rounded-lg space-y-4">
              <span className="text-xs font-semibold text-fuchsia-300 uppercase tracking-wider">Hermes Runtime Config</span>
              <p className="text-xs text-slate-400">Hermes uses a local CLI-backed adapter. Profile is required for isolation. Provider and model overrides are optional. Lifecycle reporting is handled through Agent HQ MCP/capability tools.</p>

              {!editForm.raw_json_expanded && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Hermes Binary</span>
                    <input
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-fuchsia-500 font-mono"
                      value={(editForm.runtime_config as HermesRuntimeConfig).hermesBin ?? 'hermes'}
                      onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as HermesRuntimeConfig), hermesBin: e.target.value } })}
                      placeholder="hermes"
                    />
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Profile <span className="text-red-400">*</span></span>
                    <input
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-fuchsia-500"
                      value={(editForm.runtime_config as HermesRuntimeConfig).profile ?? ''}
                      onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as HermesRuntimeConfig), profile: e.target.value } })}
                      placeholder="agent-hq-hermes-prism"
                    />
                    <p className="text-xs text-slate-500 mt-1">Required. Each Hermes-backed agent should get its own profile.</p>
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Invocation Mode</span>
                    <div className="relative">
                      <select
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-fuchsia-500 appearance-none pr-8"
                        value={(editForm.runtime_config as HermesRuntimeConfig).invocationMode ?? 'z'}
                        onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as HermesRuntimeConfig), invocationMode: e.target.value as HermesRuntimeConfig['invocationMode'] } })}
                      >
                        <option value="z">One-shot (-z)</option>
                        <option value="chat-q">chat -q</option>
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                    </div>
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Lifecycle Mode</span>
                    <input className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-400 text-sm font-mono" value="proxy" readOnly />
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Hermes Provider Override <span className="text-slate-600">(optional)</span></span>
                    <input
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-fuchsia-500 font-mono"
                      value={(editForm.runtime_config as HermesRuntimeConfig).provider ?? ''}
                      onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as HermesRuntimeConfig), provider: e.target.value || null } })}
                      placeholder="anthropic"
                    />
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Hermes Model Override <span className="text-slate-600">(optional)</span></span>
                    <input
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-fuchsia-500 font-mono"
                      value={(editForm.runtime_config as HermesRuntimeConfig).model ?? ''}
                      onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as HermesRuntimeConfig), model: e.target.value || null } })}
                      placeholder="claude-opus-5"
                    />
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-xs mb-1 block">Fast Mode <span className="text-slate-600">(optional)</span></span>
                    <select
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-fuchsia-500"
                      value={(editForm.runtime_config as HermesRuntimeConfig).fastMode == null ? '' : String((editForm.runtime_config as HermesRuntimeConfig).fastMode)}
                      onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as HermesRuntimeConfig), fastMode: e.target.value === '' ? null : e.target.value === 'true' } })}
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
                      value={((editForm.runtime_config as HermesRuntimeConfig).extraArgs ?? []).join(', ')}
                      onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as HermesRuntimeConfig), extraArgs: e.target.value ? e.target.value.split(',').map(arg => arg.trim()).filter(Boolean) : [] } })}
                      placeholder="--ignore-user-config, --ignore-rules"
                    />
                  </label>
                  <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-3">
                    <label className="flex items-start gap-2 text-sm text-slate-300">
                      <input type="checkbox" className="mt-0.5" checked={Boolean((editForm.runtime_config as HermesRuntimeConfig).ignoreUserConfig)} onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as HermesRuntimeConfig), ignoreUserConfig: e.target.checked } })} />
                      <span><span className="font-medium text-white">Ignore user config</span><br /><span className="text-xs text-slate-500">Optional hardening when a shared machine has personal Hermes config.</span></span>
                    </label>
                    <label className="flex items-start gap-2 text-sm text-slate-300">
                      <input type="checkbox" className="mt-0.5" checked={Boolean((editForm.runtime_config as HermesRuntimeConfig).ignoreRules)} onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as HermesRuntimeConfig), ignoreRules: e.target.checked } })} />
                      <span><span className="font-medium text-white">Ignore rules</span><br /><span className="text-xs text-slate-500">Optional. Use only when inherited Hermes rules would make dispatch behavior misleading.</span></span>
                    </label>
                    <label className="flex items-start gap-2 text-sm text-slate-300">
                      <input type="checkbox" className="mt-0.5" checked={Boolean((editForm.runtime_config as HermesRuntimeConfig).passSessionId)} onChange={e => setF({ runtime_config: { ...(editForm.runtime_config as HermesRuntimeConfig), passSessionId: e.target.checked } })} />
                      <span><span className="font-medium text-white">Pass session id</span><br /><span className="text-xs text-slate-500">Optional. Only meaningful if the runtime adapter is wired to consume Agent HQ session ids.</span></span>
                    </label>
                  </div>
                </div>
              )}

              <div className="border-t border-fuchsia-500/10 pt-3">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-xs text-fuchsia-400 hover:text-fuchsia-300 transition-colors"
                  onClick={() => {
                    if (!editForm.raw_json_expanded) {
                      setF({ raw_json: hermesRuntimeConfigToJson(editForm.runtime_config as HermesRuntimeConfig), raw_json_expanded: true });
                    } else {
                      setF({ raw_json_expanded: false });
                    }
                  }}
                >
                  <ChevronRight className={`w-3.5 h-3.5 transition-transform ${editForm.raw_json_expanded ? 'rotate-90' : ''}`} />
                  Raw JSON editor {editForm.raw_json_expanded ? '(collapse)' : '(advanced)'}
                </button>
                {editForm.raw_json_expanded && (
                  <textarea
                    className="mt-2 w-full bg-slate-900 border border-fuchsia-500/30 rounded-lg px-3 py-2 text-fuchsia-200 text-xs font-mono focus:outline-none focus:border-fuchsia-400 resize-y min-h-[140px]"
                    value={editForm.raw_json}
                    onChange={e => setF({ raw_json: e.target.value })}
                    spellCheck={false}
                  />
                )}
              </div>
            </div>
          )}
        </Card>

        <AgentTeamsCard agentId={id} />

        {/* Section 2: Job & Execution */}
        <Card className="border-amber-500/20">
          <div className="flex items-center gap-2 mb-5">
            <Settings className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white">Job & Execution</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Timeouts sub-section */}
            <div className="md:col-span-2 border border-slate-700/60 rounded-lg p-4 bg-slate-800/40">
              <p className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-3">Timeouts</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">
                    Startup grace (seconds)
                    <span className="text-slate-600 ml-1">(default: 300 = 5 min)</span>
                  </span>
                  <input
                    type="number"
                    min={30}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                    value={editForm.startup_grace_seconds}
                    onChange={e => setF({ startup_grace_seconds: e.target.value })}
                    placeholder="300"
                  />
                  {editForm.startup_grace_seconds && Number(editForm.startup_grace_seconds) >= 30 && (
                    <p className="text-slate-600 text-xs mt-1">≈ {Math.round(Number(editForm.startup_grace_seconds) / 60)} min</p>
                  )}
                  <p className="text-slate-600 text-xs mt-1">How long the agent has to send its first check-in signal after dispatch before being auto-failed. Leave blank to use global default.</p>
                </label>
                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">
                    Heartbeat stale (seconds)
                    <span className="text-slate-600 ml-1">(default: 600 = 10 min)</span>
                  </span>
                  <input
                    type="number"
                    min={60}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                    value={editForm.heartbeat_stale_seconds}
                    onChange={e => setF({ heartbeat_stale_seconds: e.target.value })}
                    placeholder="600"
                  />
                  {editForm.heartbeat_stale_seconds && Number(editForm.heartbeat_stale_seconds) >= 60 && (
                    <p className="text-slate-600 text-xs mt-1">≈ {Math.round(Number(editForm.heartbeat_stale_seconds) / 60)} min</p>
                  )}
                  <p className="text-slate-600 text-xs mt-1">How long a running agent can go silent (no heartbeat or output) before being auto-failed. Leave blank to use global default.</p>
                </label>
                <label className="block">
                  <span className="text-slate-400 text-xs mb-1 block">
                    Execution timeout (seconds)
                    <span className="text-slate-600 ml-1">(default: 900 = 15 min)</span>
                  </span>
                  <input
                    type="number"
                    min={60}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                    value={editForm.timeout_seconds}
                    onChange={e => setF({ timeout_seconds: e.target.value })}
                    placeholder="900"
                  />
                  {editForm.timeout_seconds && Number(editForm.timeout_seconds) >= 60 && (
                    <p className="text-slate-600 text-xs mt-1">≈ {Math.round(Number(editForm.timeout_seconds) / 60)} min</p>
                  )}
                  <p className="text-slate-600 text-xs mt-1">Maximum total run time for a single agent session. The agent is killed if it exceeds this limit.</p>
                </label>
              </div>
            </div>
            <label className="block md:col-span-2">
              <span className="text-slate-400 text-xs mb-1 block">
                Capabilities / Skills
                <span className="text-slate-600 ml-1">(comma-separated skill names)</span>
              </span>
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
                value={editForm.skill_names}
                onChange={e => setF({ skill_names: e.target.value })}
                placeholder="coding-agent, github, weather"
              />
              <p className="text-slate-600 text-xs mt-1">
                These are the skill names the agent is allowed to use during task runs.
              </p>
            </label>
            <label className="block md:col-span-2">
              <span className="text-slate-400 text-xs mb-1 block">
                Job instructions
                <span className="text-slate-600 ml-1">(optional, prepended to every task dispatch)</span>
              </span>
              <textarea
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 resize-y min-h-[120px]"
                value={editForm.job_instructions}
                onChange={e => setF({ job_instructions: e.target.value })}
                placeholder="You are the Juno fullstack engineer for the Agency project…"
              />
            </label>
          </div>
        </Card>

        {/* Save/Cancel footer */}
        <div className="flex items-center justify-between gap-2 pb-4">
          {saveError && (
            <p className="text-red-400 text-sm">{saveError}</p>
          )}
          <div className="flex gap-2 ml-auto">
            <Button variant="primary" onClick={handleSave} loading={saving}>
              <Save className="w-4 h-4" /> Save Changes
            </Button>
            <Button variant="ghost" onClick={cancelEdit}>
              <X className="w-4 h-4" /> Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── View mode render ─────────────────────────────────────────────────────────

  async function saveMcpToolAllowlist(mcpServerId: number) {
    if (!agent) return;
    setMcpToolAllowlistSavingId(mcpServerId);
    setMcpToolAllowlistError(null);
    try {
      // One tool per line; blank clears the restriction so every tool is allowed.
      const tools = (mcpToolAllowlistDraft[mcpServerId] ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const updated = await api.updateAgentMcpToolAllowlist(agent.id, mcpServerId, tools);
      setMcpToolAllowlists(updated.servers);
      setMcpToolAllowlistDraft(Object.fromEntries(
        updated.servers.map((server) => [server.mcp_server_id, server.tool_allowlist.join('\n')]),
      ));
    } catch (err) {
      setMcpToolAllowlistError(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpToolAllowlistSavingId(null);
    }
  }

  const permissionGroups = groupMcpCapabilities(mcpPermissionDraft);
  const hasMcpPermissionChanges = JSON.stringify(mcpPermissionDraft.map((capability) => ({ key: capability.key, enabled: capability.enabled })))
    !== JSON.stringify((mcpPermissionPolicy?.capabilities ?? []).map((capability) => ({ key: capability.key, enabled: capability.enabled })));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => router.back()}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="flex items-center gap-2">
            <StatusDot status={agent.status} />
            <h1 className="text-2xl font-bold text-white">{agent.name}</h1>
            <span className="text-xs font-medium text-slate-300 bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded whitespace-nowrap">
              Agent #{agent.id}
            </span>
          </div>
          <Badge variant={agent.status}>{agent.status}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={handleRuntimeDiagnostic} loading={runtimeDiagnosticLoading}>
            <Activity className="w-3.5 h-3.5" /> Test Runtime
          </Button>
          <Button variant="secondary" size="sm" onClick={() => enterEditMode(agent)}>
            <Pencil className="w-3.5 h-3.5" /> Edit
          </Button>
          <Button variant="danger" size="sm" onClick={() => setDeleteConfirmOpen(true)}>
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </Button>
        </div>
      </div>

      {(runtimeDiagnostic || runtimeDiagnosticError) && (
        <Card className={runtimeDiagnostic?.ok ? 'border-emerald-500/30' : 'border-red-500/30'}>
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              {runtimeDiagnostic?.ok ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : <AlertCircle className="w-4 h-4 text-red-400" />}
              <h2 className="font-semibold text-white">Runtime Diagnostic</h2>
            </div>
            {runtimeDiagnostic?.version && <code className="text-xs text-slate-400">{runtimeDiagnostic.version}</code>}
          </div>
          {runtimeDiagnosticError ? (
            <p className="text-sm text-red-300">{runtimeDiagnosticError}</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {runtimeDiagnostic?.checks.map(check => (
                <div key={check.key} className="rounded-lg bg-slate-900/50 border border-slate-700 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-200">{check.label}</span>
                    <span className={`text-[10px] uppercase tracking-wide ${check.status === 'pass' ? 'text-emerald-400' : check.status === 'fail' ? 'text-red-400' : check.status === 'warn' ? 'text-amber-400' : 'text-slate-500'}`}>{check.status}</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">{check.message}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <Card className="max-w-md w-full mx-4 border-red-500/30">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-red-900/30 rounded-lg">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Delete Agent</h3>
                <p className="text-sm text-slate-400">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-slate-300 mb-6">
              Are you sure you want to delete <strong className="text-white">{agent.name}</strong>? Historical tasks and runs will be preserved.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDeleteConfirmOpen(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={handleDelete} loading={deleting}>
                <Trash2 className="w-3.5 h-3.5" /> Delete Agent
              </Button>
            </div>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Agent info */}
        <Card className="lg:col-span-1">
          <div className="flex items-center gap-2 mb-4">
            <Bot className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white">Agent Info</h2>
          </div>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-slate-500 text-xs mb-0.5">Session Key</dt>
              <dd><code className="text-amber-300">{agent.session_key}</code></dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs mb-0.5">Role</dt>
              <dd className="text-slate-300">{agent.role || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs mb-0.5">Provider</dt>
              <dd>
                {agent.preferred_provider
                  ? <span className="text-cyan-400 text-xs bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/20">
                      {PROVIDER_LABELS[agent.preferred_provider as keyof typeof PROVIDER_LABELS] ?? agent.preferred_provider}
                    </span>
                  : <span className="text-slate-500 text-xs">—</span>
                }
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs mb-0.5">Model</dt>
              <dd>
                {agent.model
                  ? <span className="text-indigo-400 font-mono text-xs bg-indigo-500/10 px-1.5 py-0.5 rounded border border-indigo-500/20">{getAgentModelLabel(agent.model)}</span>
                  : <span className="text-slate-500 text-xs">Default (inherited)</span>
                }
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs mb-0.5">Workspace</dt>
              <dd className="text-slate-400 font-mono text-xs break-all">{agent.workspace_path || '—'}</dd>
            </div>

            {/* Remote Gateway URL inline editor. Stored as hooks_url for compatibility. */}
            <div>
              <dt className="text-slate-500 text-xs mb-0.5 flex items-center gap-1">
                <Link2 className="w-3 h-3" /> Remote Gateway URL
                <span className="text-slate-600 font-normal">(remote)</span>
              </dt>
              <dd>
                {hooksUrlEditing ? (
                  <div className="space-y-1">
                    <input
                      ref={hooksUrlInputRef}
                      type="url"
                      value={hooksUrlValue}
                      onChange={e => setHooksUrlValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveHooksUrl(); if (e.key === 'Escape') setHooksUrlEditing(false); }}
                      placeholder="http://localhost:3701"
                      className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100 font-mono focus:outline-none focus:border-amber-400"
                    />
                    <div className="flex items-center gap-1.5">
                      <button onClick={saveHooksUrl} disabled={hooksUrlSaving} className="px-2 py-0.5 text-xs bg-amber-500 hover:bg-amber-400 text-slate-900 font-semibold rounded disabled:opacity-50">
                        {hooksUrlSaving ? 'Saving…' : 'Save'}
                      </button>
                      <button onClick={() => setHooksUrlEditing(false)} className="px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200">Cancel</button>
                    </div>
                    {hooksUrlError && <p className="text-xs text-red-400">{hooksUrlError}</p>}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    {agent.hooks_url ? (
                      <code className="text-emerald-300 bg-emerald-900/20 border border-emerald-600/20 px-1.5 py-0.5 rounded text-xs break-all">{agent.hooks_url}</code>
                    ) : (
                      <span className="text-slate-500 text-xs italic">Host gateway (default)</span>
                    )}
                    <button onClick={startEditHooksUrl} className="text-xs text-amber-400 hover:text-amber-300 underline shrink-0">
                      {agent.hooks_url ? 'Edit' : 'Set'}
                    </button>
                  </div>
                )}
              </dd>
            </div>

            <div>
              <dt className="text-slate-500 text-xs mb-0.5">Last Active</dt>
              <dd className="text-slate-400">{agent.last_active ? formatDateTime(agent.last_active) : 'Never'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs mb-0.5">Created</dt>
              <dd className="text-slate-400">{formatDateTime(agent.created_at)}</dd>
            </div>

            {/* Provision status — only shown for OpenClaw runtime agents */}
            {(agent.runtime_type === 'openclaw' || !agent.runtime_type) && (
              <div className="pt-2 border-t border-slate-700/50">
                <dt className="text-slate-500 text-xs mb-1.5">OpenClaw Provision</dt>
                <dd>
                  {provisionStatus === null ? (
                    <span className="text-xs text-slate-500 italic">Status unavailable</span>
                  ) : isProvisioned ? (
                    <div className="space-y-2">
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300 bg-emerald-900/30 border border-emerald-600/30 px-2 py-0.5 rounded-full">
                        <CheckCircle className="w-3 h-3" /> Provisioned
                      </span>
                      {resolvedSessionKey && (
                        <div className="text-xs text-slate-400 space-y-0.5">
                          <div>Session: <code className="text-amber-300 bg-slate-700 px-1 rounded">{resolvedSessionKey}</code></div>
                          {resolvedWorkspacePath && (
                            <div className="break-all">Workspace: <code className="text-slate-300 bg-slate-700 px-1 rounded">{resolvedWorkspacePath}</code></div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-400 bg-amber-900/20 border border-amber-600/30 px-2 py-0.5 rounded-full">
                        <AlertCircle className="w-3 h-3" /> Not provisioned
                      </span>
                      {provisionUI.phase === 'idle' && (
                        <Button variant="primary" onClick={handleProvision}>
                          <Zap className="w-3.5 h-3.5" /> Provision
                        </Button>
                      )}
                      {provisionUI.phase === 'loading' && (
                        <div className="flex items-center gap-1.5 text-xs text-amber-300">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Provisioning…
                        </div>
                      )}
                      {provisionUI.phase === 'error' && (
                        <div className="space-y-1">
                          <p className="text-xs text-red-400">{provisionUI.message}</p>
                          <Button variant="ghost" onClick={() => setProvisionUI({ phase: 'idle' })}>Retry</Button>
                        </div>
                      )}
                    </div>
                  )}
                </dd>
              </div>
            )}
          </dl>
        </Card>

        {/* Execution card */}
        <Card className="lg:col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <Settings className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white">Execution</h2>
            {agent.enabled != null && (
              <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border ml-auto ${
                agent.enabled ? 'text-emerald-300 bg-emerald-900/30 border-emerald-600/30' : 'text-slate-500 bg-slate-800 border-slate-700'
              }`}>
                <Power className="w-2.5 h-2.5" />
                {agent.enabled ? 'Enabled' : 'Disabled'}
              </span>
            )}
          </div>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div className="md:col-span-2 border border-slate-700/40 rounded-lg p-3 bg-slate-800/30">
                <dt className="text-slate-500 text-xs font-semibold uppercase tracking-wider mb-2">Timeouts</dt>
                <dd className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div>
                    <p className="text-slate-500 mb-0.5">Startup grace</p>
                    <p className="text-slate-300">
                      {agent.startup_grace_seconds
                        ? `${agent.startup_grace_seconds}s (${Math.round(agent.startup_grace_seconds / 60)}m)`
                        : <span className="text-slate-500">Global default (5 min)</span>
                      }
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500 mb-0.5">Heartbeat stale</p>
                    <p className="text-slate-300">
                      {agent.heartbeat_stale_seconds
                        ? `${agent.heartbeat_stale_seconds}s (${Math.round(agent.heartbeat_stale_seconds / 60)}m)`
                        : <span className="text-slate-500">Global default (10 min)</span>
                      }
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500 mb-0.5">Execution timeout</p>
                    <p className="text-slate-300">
                      {agent.timeout_seconds
                        ? `${agent.timeout_seconds}s (${Math.round(agent.timeout_seconds / 60)}m)`
                        : <span className="text-slate-500">Default (15 min)</span>
                      }
                    </p>
                  </div>
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 text-xs mb-0.5">Skills</dt>
                <dd>
                  {agent.skill_names && agent.skill_names.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {agent.skill_names.map((s: string) => (
                        <span key={s} className="text-xs text-violet-300 bg-violet-500/10 px-1.5 py-0.5 rounded border border-violet-500/20">
                          <BookOpen className="w-2.5 h-2.5 inline mr-0.5" />{s}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-slate-500 text-xs">None</span>
                  )}
                </dd>
              </div>
              {agent.job_instructions && (
                <div className="md:col-span-2">
                  <dt className="text-slate-500 text-xs mb-0.5">Job instructions</dt>
                  <dd>
                    <pre className="text-xs text-slate-300 bg-slate-900/60 border border-slate-700/50 rounded-lg p-3 whitespace-pre-wrap break-words max-h-[200px] overflow-auto">
                      {agent.job_instructions}
                    </pre>
                  </dd>
                </div>
              )}
            </dl>
        </Card>
      </div>

      <Card>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2"><Shield className="w-4 h-4 text-cyan-300" />Agent HQ MCP Access</h3>
              <p className="text-xs text-slate-400 mt-1 max-w-3xl">
                Control which Agent HQ MCP capability groups this agent can call with its API key. Denied calls return a scoped 403 with the required capability for debugging.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant={mcpPermissionPolicy?.policy_mode === 'explicit' ? 'warn' : 'info'}>
                {formatMcpPolicyLabel(mcpPermissionPolicy)}
              </Badge>
              {mcpPermissionPolicy?.updated_at ? (
                <span className="text-slate-500">Updated {formatDateTime(mcpPermissionPolicy.updated_at)}</span>
              ) : null}
            </div>
          </div>

          {mcpPermissionError ? (
            <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
              {mcpPermissionError}
            </div>
          ) : null}

          {mcpPermissionPolicy ? (
            <>
              {mcpPermissionPolicy.policy_mode === 'default' ? (
                <div className="text-xs text-slate-400 bg-slate-900/60 border border-slate-800 rounded-md px-3 py-2">
                  This agent is still using the rollout-safe default policy. Save a custom selection to make permissions explicit, or reset later to return to the default baseline.
                </div>
              ) : null}

              <div className="space-y-4">
                {permissionGroups.map(([group, capabilities]) => (
                  <div key={group} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">{group}</div>
                    <div className="space-y-3">
                      {capabilities.map((capability) => (
                        <label key={capability.key} className="flex gap-3 rounded-md border border-slate-800/80 bg-slate-900/50 px-3 py-3 hover:border-slate-700 cursor-pointer">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 rounded border-slate-700 bg-slate-950 text-cyan-400"
                            checked={capability.enabled}
                            disabled={mcpPermissionSaving}
                            onChange={() => toggleMcpCapability(capability.key)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium text-slate-100">{capability.label}</span>
                              <span className="text-[11px] text-slate-500">{capability.key}</span>
                              {capability.explicit_enabled === null ? (
                                <Badge variant="info">Default</Badge>
                              ) : (
                                <Badge variant="warn">Explicit</Badge>
                              )}
                            </div>
                            <p className="text-xs text-slate-400 mt-1">{capability.description}</p>
                            <div className="mt-2 text-[11px] text-slate-500 space-y-1">
                              {capability.endpoints.map((endpoint) => (
                                <div key={endpoint}>{endpoint}</div>
                              ))}
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={saveMcpPermissions}
                  disabled={mcpPermissionSaving || !hasMcpPermissionChanges}
                  className="h-8"
                >
                  {mcpPermissionSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  Save MCP Access
                </Button>
                <Button
                  variant="secondary"
                  onClick={resetMcpPermissions}
                  disabled={mcpPermissionSaving || mcpPermissionPolicy.policy_mode === 'default'}
                  className="h-8"
                >
                  <RefreshCw className="w-3 h-3" /> Reset to Default
                </Button>
              </div>
            </>
          ) : (
            <div className="text-xs text-slate-400">MCP permission policy is unavailable for this agent right now.</div>
          )}
        </div>
      </Card>

      {/* MCP tool allowlists — which tools each assigned MCP server exposes */}
      <Card>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Wrench className="w-4 h-4 text-emerald-400" />
                <h2 className="text-sm font-semibold text-slate-200">MCP tool allowlists</h2>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Limits which tools each assigned MCP server exposes to this agent. Separate from the Agent HQ
                capability policy above, which governs Agent HQ&apos;s own MCP routes. One tool name per line;
                leave blank to allow every tool on that server.
              </p>
            </div>
          </div>

          {mcpToolAllowlistError ? (
            <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
              {mcpToolAllowlistError}
            </div>
          ) : null}

          {mcpToolAllowlists.length === 0 ? (
            <div className="text-xs text-slate-400">No MCP servers are assigned to this agent.</div>
          ) : (
            <div className="space-y-3">
              {mcpToolAllowlists.map((server) => {
                const draft = mcpToolAllowlistDraft[server.mcp_server_id] ?? '';
                const dirty = draft !== server.tool_allowlist.join('\n');
                const draftCount = draft.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).length;
                return (
                  <div key={server.mcp_server_id} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-slate-200">{server.server_name ?? `MCP server #${server.mcp_server_id}`}</span>
                        {server.server_slug ? <span className="text-xs text-slate-500">{server.server_slug}</span> : null}
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        {!server.enabled ? <Badge variant="warn">Disabled</Badge> : null}
                        <Badge variant={draftCount === 0 ? 'warn' : 'info'}>
                          {draftCount === 0 ? 'All tools allowed' : `${draftCount} tool${draftCount === 1 ? '' : 's'}`}
                        </Badge>
                      </div>
                    </div>
                    <textarea
                      value={draft}
                      onChange={(event) => setMcpToolAllowlistDraft((current) => ({
                        ...current,
                        [server.mcp_server_id]: event.target.value,
                      }))}
                      rows={Math.min(14, Math.max(4, draftCount + 1))}
                      spellCheck={false}
                      placeholder="Leave blank to allow every tool on this server"
                      className="w-full rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs font-mono text-slate-200 focus:border-slate-600 focus:outline-none"
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => saveMcpToolAllowlist(server.mcp_server_id)}
                        disabled={mcpToolAllowlistSavingId === server.mcp_server_id || !dirty}
                      >
                        {mcpToolAllowlistSavingId === server.mcp_server_id
                          ? <Loader2 className="w-3 h-3 animate-spin" />
                          : <Save className="w-3 h-3" />}
                        Save allowlist
                      </Button>
                      {dirty ? <span className="text-xs text-amber-300">Unsaved changes</span> : null}
                    </div>
                  </div>
                );
              })}
              <p className="text-xs text-slate-500">
                Changes take effect for new agent sessions after an MCP sync, since allowlists are materialized
                into the runtime config rather than read live.
              </p>
            </div>
          )}
        </div>
      </Card>

      {/* Capabilities — Skills + Tools */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-white">Capabilities</h2>
          </div>
        </div>

        {/* Skills sub-section */}
        <div className="mb-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <BookOpen className="w-3.5 h-3.5 text-violet-400" />
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Skills</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => { setShowAddSkill(v => !v); setSkillSearch(''); }}>
              <Plus className="w-3 h-3" /> Add Skill
            </Button>
          </div>

          {showAddSkill && (
            <div className="mb-3 bg-slate-800/60 border border-slate-700 rounded-xl p-3 space-y-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                <input
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-8 pr-3 py-1.5 text-white text-xs focus:outline-none focus:border-violet-500"
                  placeholder="Search skills…"
                  value={skillSearch}
                  onChange={e => setSkillSearch(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {allSkills
                  .filter(s => {
                    const alreadyAssigned = (agent.skill_names ?? []).includes(s.name);
                    const matchSearch = !skillSearch ||
                      s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
                      s.description.toLowerCase().includes(skillSearch.toLowerCase());
                    return !alreadyAssigned && matchSearch;
                  })
                  .map(skill => (
                    <button
                      key={skill.name}
                      disabled={addingSkill === skill.name}
                      onClick={async () => {
                        setAddingSkill(skill.name);
                        try {
                          const updated = await api.assignSkillToAgent(id, agent.skill_names ?? [], skill.name);
                          setAgent(updated);
                          setShowAddSkill(false);
                        } catch (e) {
                          alert(`Failed to assign skill: ${e}`);
                        } finally {
                          setAddingSkill(null);
                        }
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-700 transition-colors text-left"
                    >
                      {addingSkill === skill.name
                        ? <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin shrink-0" />
                        : <BookOpen className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                      }
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white font-medium truncate">{skill.name}</p>
                        {skill.description && (
                          <p className="text-xs text-slate-500 truncate">{skill.description}</p>
                        )}
                      </div>
                    </button>
                  ))}
                {allSkills.filter(s =>
                  !(agent.skill_names ?? []).includes(s.name) &&
                  (!skillSearch || s.name.toLowerCase().includes(skillSearch.toLowerCase()) || s.description.toLowerCase().includes(skillSearch.toLowerCase()))
                ).length === 0 && (
                  <p className="text-xs text-slate-600 text-center py-2">No available skills</p>
                )}
              </div>
            </div>
          )}

          {agent.skill_names && agent.skill_names.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {agent.skill_names.map((s: string) => (
                <span key={s} className="inline-flex items-center gap-1 text-xs text-violet-300 bg-violet-500/10 px-2 py-1 rounded-lg border border-violet-500/20">
                  <Link href={`/skills/${encodeURIComponent(s)}`} className="flex items-center gap-1 hover:text-violet-200 transition-colors">
                    <BookOpen className="w-2.5 h-2.5" />{s}
                  </Link>
                  <button
                    disabled={removingSkill === s}
                    onClick={async () => {
                      setRemovingSkill(s);
                      try {
                        const updated = await api.removeSkillFromAgent(id, agent.skill_names ?? [], s);
                        setAgent(updated);
                      } catch (e) {
                        alert(`Failed to remove skill: ${e}`);
                      } finally {
                        setRemovingSkill(null);
                      }
                    }}
                    className="ml-0.5 text-slate-500 hover:text-red-400 transition-colors"
                  >
                    {removingSkill === s ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <X className="w-2.5 h-2.5" />}
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-slate-600 text-xs">No skills assigned</p>
          )}
        </div>

        {/* Tools sub-section */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Wrench className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Tools</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => { setShowAddTool(v => !v); setToolSearch(''); }}>
              <Plus className="w-3 h-3" /> Add Tool
            </Button>
          </div>

          {showAddTool && (
            <div className="mb-3 bg-slate-800/60 border border-slate-700 rounded-xl p-3 space-y-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                <input
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-8 pr-3 py-1.5 text-white text-xs focus:outline-none focus:border-amber-500"
                  placeholder="Search tools…"
                  value={toolSearch}
                  onChange={e => setToolSearch(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {allTools
                  .filter(t => {
                    const alreadyAssigned = agentTools.some(at => at.tool_id === t.id);
                    const matchSearch = !toolSearch ||
                      t.name.toLowerCase().includes(toolSearch.toLowerCase()) ||
                      t.slug.toLowerCase().includes(toolSearch.toLowerCase());
                    return !alreadyAssigned && matchSearch && t.enabled;
                  })
                  .map(tool => (
                    <button
                      key={tool.id}
                      disabled={addingTool === tool.id}
                      onClick={async () => {
                        setAddingTool(tool.id);
                        try {
                          const assignment = await api.assignToolToAgent(id, tool.id);
                          setAgentTools(prev => [...prev, assignment]);
                          setShowAddTool(false);
                        } catch (e) {
                          alert(`Failed to assign tool: ${e}`);
                        } finally {
                          setAddingTool(null);
                        }
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-700 transition-colors text-left"
                    >
                      {addingTool === tool.id
                        ? <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
                        : <Wrench className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      }
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white font-medium truncate">{tool.name}</p>
                        <p className="text-xs text-slate-500 truncate">{tool.slug}</p>
                      </div>
                    </button>
                  ))}
                {allTools.filter(t => !agentTools.some(at => at.tool_id === t.id) && t.enabled &&
                  (!toolSearch || t.name.toLowerCase().includes(toolSearch.toLowerCase()) || t.slug.toLowerCase().includes(toolSearch.toLowerCase()))
                ).length === 0 && (
                  <p className="text-xs text-slate-600 text-center py-2">No available tools</p>
                )}
              </div>
            </div>
          )}

          {agentTools.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {agentTools.map(at => (
                <span key={at.assignment_id} className="inline-flex items-center gap-1 text-xs text-amber-300 bg-amber-500/10 px-2 py-1 rounded-lg border border-amber-500/20">
                  <Wrench className="w-2.5 h-2.5" />
                  {at.name}
                  <button
                    disabled={removingTool === at.tool_id}
                    onClick={async () => {
                      setRemovingTool(at.tool_id);
                      try {
                        // DELETE /agents/:agentId/tools/:toolId expects the real tool id.
                        await api.removeToolFromAgent(id, at.tool_id);
                        setAgentTools(prev => prev.filter(t => t.assignment_id !== at.assignment_id));
                      } catch (e) {
                        alert(`Failed to remove tool: ${e}`);
                      } finally {
                        setRemovingTool(null);
                      }
                    }}
                    className="ml-0.5 text-slate-500 hover:text-red-400 transition-colors"
                  >
                    {removingTool === at.tool_id ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <X className="w-2.5 h-2.5" />}
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-slate-600 text-xs">No tools assigned</p>
          )}
        </div>

        {/* MCP sub-section */}
        <div className="mt-5 pt-5 border-t border-slate-800/80">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Server className="w-3.5 h-3.5 text-cyan-400" />
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">MCP Servers</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => { setShowAddMcpServer(v => !v); setMcpSearch(''); }}>
              <Plus className="w-3 h-3" /> Add MCP
            </Button>
          </div>

          {showAddMcpServer && (
            <div className="mb-3 bg-slate-800/60 border border-slate-700 rounded-xl p-3 space-y-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                <input
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-8 pr-3 py-1.5 text-white text-xs focus:outline-none focus:border-cyan-500"
                  placeholder="Search MCP servers…"
                  value={mcpSearch}
                  onChange={e => setMcpSearch(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {allMcpServers
                  .filter(server => {
                    const alreadyAssigned = agentMcpServers.some(as => as.mcp_server_id === server.id);
                    const matchSearch = !mcpSearch
                      || server.name.toLowerCase().includes(mcpSearch.toLowerCase())
                      || server.slug.toLowerCase().includes(mcpSearch.toLowerCase());
                    return !alreadyAssigned && matchSearch && !!server.enabled;
                  })
                  .map(server => (
                    <button
                      key={server.id}
                      disabled={addingMcpServer === server.id}
                      onClick={async () => {
                        setAddingMcpServer(server.id);
                        try {
                          const assignment = await api.assignMcpServerToAgent(id, server.id);
                          setAgentMcpServers(prev => [...prev, assignment]);
                          setShowAddMcpServer(false);
                        } catch (e) {
                          alert(`Failed to assign MCP server: ${e}`);
                        } finally {
                          setAddingMcpServer(null);
                        }
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-700 transition-colors text-left"
                    >
                      {addingMcpServer === server.id
                        ? <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin shrink-0" />
                        : <Server className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      }
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white font-medium truncate">{server.name}</p>
                        <p className="text-xs text-slate-500 truncate">{server.slug}</p>
                      </div>
                    </button>
                  ))}
                {allMcpServers.filter(server =>
                  !agentMcpServers.some(as => as.mcp_server_id === server.id)
                  && !!server.enabled
                  && (!mcpSearch || server.name.toLowerCase().includes(mcpSearch.toLowerCase()) || server.slug.toLowerCase().includes(mcpSearch.toLowerCase()))
                ).length === 0 && (
                  <p className="text-xs text-slate-600 text-center py-2">No available MCP servers</p>
                )}
              </div>
            </div>
          )}

          {agentMcpServers.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {agentMcpServers.map(server => (
                <span key={server.mcp_server_id} className="inline-flex items-center gap-1 text-xs text-cyan-300 bg-cyan-500/10 px-2 py-1 rounded-lg border border-cyan-500/20">
                  <Link href="/capabilities" className="flex items-center gap-1 hover:text-cyan-200 transition-colors">
                    <Server className="w-2.5 h-2.5" />{server.name}
                  </Link>
                  <button
                    disabled={removingMcpServer === server.mcp_server_id}
                    onClick={async () => {
                      setRemovingMcpServer(server.mcp_server_id);
                      try {
                        await api.removeMcpServerFromAgent(id, server.mcp_server_id);
                        setAgentMcpServers(prev => prev.filter(item => item.mcp_server_id !== server.mcp_server_id));
                      } catch (e) {
                        alert(`Failed to remove MCP server: ${e}`);
                      } finally {
                        setRemovingMcpServer(null);
                      }
                    }}
                    className="ml-0.5 text-slate-500 hover:text-red-400 transition-colors"
                  >
                    {removingMcpServer === server.mcp_server_id ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <X className="w-2.5 h-2.5" />}
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-slate-600 text-xs">No MCP servers assigned</p>
          )}
        </div>
      </Card>

      {/* Recent runs */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold text-white">Run History</h2>
        </div>
        {instances.length === 0 ? (
          <p className="text-slate-500 text-sm">No runs yet</p>
        ) : (
          <div className="space-y-2">
            {instances.map(inst => {
              const lifecycle = getRunLifecycle(inst);
              return (
                <div key={inst.id} className="flex items-center gap-3 py-2 border-b border-slate-700/50 last:border-0">
                  <Badge variant={lifecycle.displayStatus}>{getRunStatusLabel(lifecycle.displayStatus)}</Badge>
                  <span className="flex-1 text-sm text-slate-300 truncate">{inst.job_title ?? inst.agent_name ?? `Run #${inst.id}`}</span>
                  <span className="text-xs text-slate-500">{formatDateTime(inst.created_at)}</span>
                  <Link href={`/chat?agentId=${id}&instanceId=${inst.id}`} className="text-xs text-amber-400 hover:underline">View</Link>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Logs */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Clock className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold text-white">Recent Logs</h2>
        </div>
        {logs.length === 0 ? (
          <p className="text-slate-500 text-sm">No logs yet</p>
        ) : (
          <div className="space-y-1 font-mono text-xs">
            {logs.map(log => (
              <div key={log.id} className="flex gap-3 items-start">
                <span className="text-slate-600 shrink-0">{formatTime(log.created_at)}</span>
                <Badge variant={log.level}>{log.level}</Badge>
                <span className={`flex-1 ${log.level === 'error' ? 'text-red-300' : log.level === 'warn' ? 'text-amber-300' : 'text-slate-300'}`}>{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* CLAUDE.md — only for claude-code agents */}
      {agent.runtime_type === 'claude-code' && (
        <Card>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-purple-400" />
              <h2 className="font-semibold text-white">CLAUDE.md</h2>
              {claudeMd?.last_modified && (
                <span className="text-xs text-slate-500">Last updated: {formatDateTime(claudeMd.last_modified)}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {claudeMd?.exists && !claudeMdEditing && (
                <Button variant="ghost" size="sm" onClick={() => { setClaudeMdEditValue(claudeMd.content ?? ''); setClaudeMdSaveError(null); setClaudeMdEditing(true); }}>
                  <Edit2 className="w-3.5 h-3.5" /> Edit
                </Button>
              )}
              {claudeMdEditing && (
                <>
                  <Button variant="primary" size="sm" onClick={saveClaudeMd} loading={claudeMdSaving}>
                    <Save className="w-3.5 h-3.5" /> Save
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setClaudeMdEditing(false); setClaudeMdSaveError(null); }}>
                    <X className="w-3.5 h-3.5" /> Cancel
                  </Button>
                </>
              )}
              <Button variant="ghost" size="sm" onClick={regenClaudeMd} disabled={claudeMdRegening}>
                {claudeMdRegening ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Regenerate
              </Button>
            </div>
          </div>

          {claudeMdLoading && (
            <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading CLAUDE.md…
            </div>
          )}
          {claudeMdError && !claudeMdLoading && (
            <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-3 text-red-300 text-sm">{claudeMdError}</div>
          )}
          {claudeMdRegenError && (
            <div className="mb-3 bg-red-900/20 border border-red-700/40 rounded-lg p-3 text-red-300 text-sm">Regenerate failed: {claudeMdRegenError}</div>
          )}
          {!claudeMdLoading && !claudeMdError && claudeMd && !claudeMd.exists && (
            <div className="text-center py-8 text-slate-500 text-sm space-y-3">
              <FileText className="w-8 h-8 mx-auto text-slate-600" />
              <p>No CLAUDE.md found for this agent&apos;s workspace.</p>
              <p className="text-xs text-slate-600">Click Regenerate to create an auto-generated template.</p>
            </div>
          )}
          {!claudeMdLoading && !claudeMdError && claudeMdEditing && (
            <div className="space-y-2">
              <textarea
                className="w-full bg-slate-900 border border-purple-500/30 rounded-lg px-3 py-2 text-slate-100 text-xs font-mono focus:outline-none focus:border-purple-400 resize-y min-h-[300px]"
                value={claudeMdEditValue}
                onChange={e => setClaudeMdEditValue(e.target.value)}
                spellCheck={false}
              />
              {claudeMdSaveError && <p className="text-xs text-red-400">{claudeMdSaveError}</p>}
            </div>
          )}
          {!claudeMdLoading && !claudeMdError && claudeMd?.exists && !claudeMdEditing && (
            <pre className="bg-slate-900/60 border border-slate-700/50 rounded-lg p-4 text-xs font-mono text-slate-300 overflow-auto max-h-[500px] whitespace-pre-wrap break-words">
              {claudeMd.content}
            </pre>
          )}
        </Card>
      )}

      {/* Identity Documents */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <FileText className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold text-white">Identity Documents</h2>
        </div>
        {docs.filter(d => d.exists).length === 0 ? (
          <p className="text-slate-500 text-sm">No identity documents found for this workspace.</p>
        ) : (
          <>
            <div className="overflow-x-auto flex gap-1 pb-1 mb-4">
              {docs.filter(d => d.exists).map(doc => (
                <button
                  key={doc.filename}
                  onClick={() => setActiveDoc(doc.filename)}
                  className={`whitespace-nowrap px-3 py-1.5 rounded-md text-sm font-mono transition-colors ${
                    activeDoc === doc.filename
                      ? 'bg-amber-500 text-slate-900 font-semibold'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {doc.filename}
                </button>
              ))}
            </div>
            {activeDoc && (() => {
              const doc = docs.find(d => d.filename === activeDoc);
              if (!doc || !doc.content) return null;
              return (
                <div className="prose prose-invert max-w-none text-sm overflow-auto max-h-[600px] pr-2
                  [&_h1]:text-white [&_h1]:text-lg [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-2
                  [&_h2]:text-white [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1
                  [&_h3]:text-white [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1
                  [&_p]:text-slate-300 [&_p]:leading-relaxed [&_p]:mb-2
                  [&_li]:text-slate-300 [&_li]:leading-relaxed
                  [&_ul]:my-2 [&_ul]:ml-4 [&_ul]:list-disc
                  [&_ol]:my-2 [&_ol]:ml-4 [&_ol]:list-decimal
                  [&_code]:text-amber-200 [&_code]:bg-slate-700 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs
                  [&_pre]:bg-slate-700/80 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:my-3
                  [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-amber-200
                  [&_a]:text-amber-400 [&_a]:underline hover:[&_a]:text-amber-300
                  [&_blockquote]:border-l-2 [&_blockquote]:border-slate-600 [&_blockquote]:pl-3 [&_blockquote]:text-slate-400 [&_blockquote]:italic
                  [&_hr]:border-slate-700
                  [&_strong]:text-slate-100 [&_em]:text-slate-300">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
                </div>
              );
            })()}
          </>
        )}
      </Card>
    </div>
  );
}
