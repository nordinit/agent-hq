'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, Agent, GatewayRuntimeHint, GatewayStatus, ProviderSlug } from '@/lib/api';
import { findAtlasAgent } from '@/lib/atlas';
import { beginGettingStartedGuide } from '@/lib/gettingStarted';
import { getDefaultAgentModelForProvider } from '@/lib/providerOptions';
import ProviderSetupStep from '@/components/ProviderSetupStep';
import {
  Bot,
  CheckCircle2,
  X,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Sparkles,
  User,
  FolderOpen,
  Users,
  Github,
  Code2,
  FileText,
  Briefcase,
  UserCircle2,
  ShieldCheck,
  Rocket,
  ServerCog,
  RefreshCw,
  Save,
  TerminalSquare,
  AlertCircle,
} from 'lucide-react';

const ONBOARDED_KEY = 'agent-hq-onboarded';
export const USER_NAME_KEY = 'agent-hq-user-name';

export function markOnboarded() {
  if (typeof window !== 'undefined') {
    localStorage.setItem(ONBOARDED_KEY, '1');
  }
}

export function isOnboarded() {
  if (typeof window === 'undefined') return true; // SSR: don't show
  return !!localStorage.getItem(ONBOARDED_KEY);
}

export function getStoredUserName(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(USER_NAME_KEY) ?? '';
}

// ─── Step types ────────────────────────────────────────────────────────────────
// provider step is inserted between project-setup and agent (per spec §2.1)
type Step = 'personalize' | 'project-setup' | 'provider' | 'gateway' | 'agent' | 'done';
const STEPS: Step[] = ['personalize', 'project-setup', 'provider', 'gateway', 'agent', 'done'];
const STEP_LABELS = ['You', 'Project', 'Providers', 'Runtime', 'Agents', 'Done'];

// ─── Project types ─────────────────────────────────────────────────────────────
type ProjectType = 'software' | 'content' | 'business-ops';
interface AgentRole {
  id: string;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  alwaysChecked: boolean;
  checked: boolean;
}

interface AgentRolePreset {
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  checked: boolean;
}

function gatewayCommandBlock(): { title: string; lines: string[]; note: string } {
  return {
    title: 'First time installing OpenClaw?',
    lines: [
      'npm install -g openclaw',
      'openclaw onboard --install-daemon',
    ],
    note: 'If OpenClaw is already installed and running, you can skip this. Otherwise run these commands in another terminal, then come back here and re-check the gateway connection.',
  };
}

function gatewayRemotePairingBlock(): { title: string; lines: string[]; note: string } {
  return {
    title: 'Remote gateway approval',
    lines: [
      'openclaw devices list',
      'openclaw devices approve <requestId>',
    ],
    note: 'Remote gateways require a one-time device approval. Click Re-check gateway here to create the pending request, approve it on the remote machine, then click Re-check gateway again.',
  };
}

function getDefaultLocalRuntimeHint(): GatewayRuntimeHint {
  if (typeof navigator !== 'undefined') {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('mac')) return 'macos';
    if (userAgent.includes('linux')) return 'linux';
  }
  return 'powershell';
}

function isRemoteGatewayRuntime(runtimeHint: GatewayRuntimeHint): boolean {
  return runtimeHint === 'external';
}

function gatewayStatusTone(status: GatewayStatus | null, isRemoteGateway: boolean): { label: string; className: string } {
  if (!status) {
    return {
      label: 'Unknown',
      className: 'border-slate-700 bg-slate-800 text-slate-300',
    };
  }

  switch (status.state) {
    case 'ready':
      return {
        label: 'Ready',
        className: 'border-green-500/40 bg-green-500/10 text-green-300',
      };
    case 'pairing_required':
      return {
        label: isRemoteGateway ? 'Pairing Required' : 'Connection Required',
        className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
      };
    case 'auth_error':
      return {
        label: 'Auth Error',
        className: 'border-red-500/40 bg-red-500/10 text-red-300',
      };
    case 'timeout':
      return {
        label: 'Timeout',
        className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
      };
    default:
      return {
        label: 'Offline',
        className: 'border-slate-700 bg-slate-800 text-slate-300',
      };
  }
}

function isGatewayTokenMismatch(error: string | null | undefined): boolean {
  const normalized = (error ?? '').toLowerCase();
  return normalized.includes('gateway token mismatch') || normalized.includes('provide gateway auth token');
}

function gatewayStatusDetails(status: GatewayStatus | null, isRemoteGateway: boolean): string | null {
  if (!status) return null;
  if (isGatewayTokenMismatch(status.error)) {
    return 'Agent HQ could not connect because the saved gateway auth token did not match.';
  }
  if (status.state === 'pairing_required') {
    return isRemoteGateway
      ? 'The remote gateway is waiting for device approval. Run the approval commands on the remote machine, then re-check here.'
      : 'OpenClaw rejected the connection request. Restart OpenClaw and verify the gateway auth token, then try again.';
  }
  return status.error;
}

function buildDefaultRoles(projectType: ProjectType, hasGithub: boolean): AgentRole[] {
  const rolePresets: Record<Exclude<AgentRole['id'], 'atlas'>, AgentRolePreset> = projectType === 'content'
    ? {
        dev: {
          label: 'Content Agent',
          desc: 'Drafts articles, scripts, marketing copy, and creative deliverables.',
          icon: FileText,
          checked: true,
        },
        qa: {
          label: 'Editorial Review Agent',
          desc: 'Reviews tone, accuracy, structure, and consistency before anything ships.',
          icon: ShieldCheck,
          checked: true,
        },
        ops: {
          label: 'Publishing Agent',
          desc: 'Handles calendars, asset handoff, publishing steps, and channel-specific packaging.',
          icon: Rocket,
          checked: false,
        },
      }
    : projectType === 'business-ops'
      ? {
          dev: {
            label: 'Automation Agent',
            desc: 'Builds workflows, automations, dashboards, and internal tooling.',
            icon: Briefcase,
            checked: true,
          },
          qa: {
            label: 'Analysis Agent',
            desc: 'Validates outputs, checks reporting quality, and catches process regressions.',
            icon: ShieldCheck,
            checked: true,
          },
          ops: {
            label: 'Operations Agent',
            desc: 'Owns rollouts, recurring processes, and operational follow-through across the business.',
            icon: Rocket,
            checked: true,
          },
        }
      : {
          dev: {
            label: 'Development Agent',
            desc: 'Builds features, fixes bugs, and handles implementation work.',
            icon: Code2,
            checked: true,
          },
          qa: {
            label: 'QA Agent',
            desc: 'Reviews work, runs tests, verifies quality.',
            icon: ShieldCheck,
          checked: hasGithub,
          },
          ops: {
            label: 'Operations Agent',
            desc: 'Handles releases, deployments, maintenance, and operational work.',
            icon: Rocket,
            checked: hasGithub,
          },
        };

  return [
    {
      id: 'atlas',
      label: 'Atlas',
      desc: 'Built-in assistant for chat, task routing, and coordination.',
      icon: Sparkles,
      alwaysChecked: true,
      checked: true,
    },
    {
      id: 'dev',
      label: rolePresets.dev.label,
      desc: rolePresets.dev.desc,
      icon: rolePresets.dev.icon,
      alwaysChecked: false,
      checked: rolePresets.dev.checked,
    },
    {
      id: 'qa',
      label: rolePresets.qa.label,
      desc: rolePresets.qa.desc,
      icon: rolePresets.qa.icon,
      alwaysChecked: false,
      checked: rolePresets.qa.checked,
    },
    {
      id: 'ops',
      label: rolePresets.ops.label,
      desc: rolePresets.ops.desc,
      icon: rolePresets.ops.icon,
      alwaysChecked: false,
      checked: rolePresets.ops.checked,
    },
  ];
}

interface Props {
  onClose: () => void;
}

// ─── Progress indicator ────────────────────────────────────────────────────────
function StepDots({ current }: { current: Step }) {
  const currentIdx = STEPS.indexOf(current);
  return (
    <div className="flex items-center gap-2 mb-8">
      {STEPS.map((s, i) => {
        const isPast = i < currentIdx;
        const isCurrent = i === currentIdx;
        return (
          <div key={s} className="flex items-center gap-2">
            <div className="flex flex-col items-center gap-1">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-200 ${
                  isCurrent
                    ? 'bg-amber-400 text-slate-900 ring-2 ring-amber-400/30'
                    : isPast
                    ? 'bg-green-500 text-white'
                    : 'bg-slate-700 text-slate-400'
                }`}
              >
                {isPast ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
              </div>
              <span
                className={`text-[10px] font-medium transition-colors ${
                  isCurrent ? 'text-amber-400' : isPast ? 'text-green-400' : 'text-slate-600'
                }`}
              >
                {STEP_LABELS[i]}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`h-px w-10 mb-4 transition-colors duration-300 ${
                  isPast ? 'bg-green-500/60' : 'bg-slate-700'
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Selectable card ──────────────────────────────────────────────────────────
function SelectCard<T extends string>({
  value,
  selected,
  onSelect,
  icon: Icon,
  iconColor,
  iconBg,
  label,
  desc,
}: {
  value: T;
  selected: T | null | undefined;
  onSelect: (v: T) => void;
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
  iconBg: string;
  label: string;
  desc: string;
}) {
  const isSelected = selected === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`w-full flex items-start gap-3 p-3.5 rounded-xl border text-left transition-all duration-150 ${
        isSelected
          ? 'border-amber-400 bg-amber-400/10 ring-1 ring-amber-400/30'
          : 'border-slate-700 bg-slate-800/60 hover:border-slate-500'
      }`}
    >
      <div className={`w-8 h-8 rounded-lg ${iconBg} flex items-center justify-center shrink-0 mt-0.5`}>
        <Icon className={`w-4 h-4 ${iconColor}`} />
      </div>
      <div>
        <p className={`text-sm font-semibold ${isSelected ? 'text-amber-300' : 'text-white'}`}>{label}</p>
        <p className="text-xs text-slate-500 mt-0.5 leading-snug">{desc}</p>
      </div>
      {isSelected && (
        <CheckCircle2 className="w-4 h-4 text-amber-400 ml-auto shrink-0 mt-0.5" />
      )}
    </button>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function OnboardingWizard({ onClose }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('personalize');
  const [showPersonalizeIntro, setShowPersonalizeIntro] = useState(true);

  // Step 1 — personalization
  const [userName, setUserName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectDesc, setProjectDesc] = useState('');
  const [personalizeError, setPersonalizeError] = useState<string | null>(null);
  const [personalizeLoading, setPersonalizeLoading] = useState(false);
  const [createdProjectId, setCreatedProjectId] = useState<number | null>(null);

  // Step 2 — project + team setup
  const [projectType, setProjectType] = useState<ProjectType | null>(null);
  const [hasGithub, setHasGithub] = useState<boolean | null>(null);
  const teamMode: 'solo' | 'team' = hasGithub === true ? 'team' : 'solo';
  const [projectSetupError, setProjectSetupError] = useState<string | null>(null);
  const [agentRoles, setAgentRoles] = useState<AgentRole[]>([]);
  const [gatewayWsUrl, setGatewayWsUrl] = useState('wss://127.0.0.1:18789');
  const [gatewayRuntimeHint, setGatewayRuntimeHint] = useState<GatewayRuntimeHint>(getDefaultLocalRuntimeHint);
  const [lastLocalGatewayRuntimeHint, setLastLocalGatewayRuntimeHint] = useState<GatewayRuntimeHint>(getDefaultLocalRuntimeHint);
  const [gatewayAuthToken, setGatewayAuthToken] = useState('');
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [gatewayLoading, setGatewayLoading] = useState(false);
  const [gatewayChecking, setGatewayChecking] = useState(false);
  const [gatewaySaving, setGatewaySaving] = useState(false);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [gatewaySuccess, setGatewaySuccess] = useState<string | null>(null);
  const [gatewayDetails, setGatewayDetails] = useState<string | null>(null);
  const [gatewayLoaded, setGatewayLoaded] = useState(false);

  // Step 3 — agent provisioning
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [provisionProgress, setProvisionProgress] = useState<
    { roleId: string; label: string; status: 'pending' | 'creating' | 'provisioning' | 'done' | 'error'; error?: string }[]
  >([]);
  const [projectCreating, setProjectCreating] = useState(false);
  const [projectCreated, setProjectCreated] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const gatewayGuide = useMemo(() => gatewayCommandBlock(), []);
  const gatewayRemoteGuide = useMemo(() => gatewayRemotePairingBlock(), []);
  const isRemoteGateway = isRemoteGatewayRuntime(gatewayRuntimeHint);
  const gatewayTone = gatewayStatusTone(gatewayStatus, isRemoteGateway);
  const gatewayNeedsToken = isGatewayTokenMismatch(gatewayStatus?.error);
  const gatewayRestartState: { phase: 'idle' | 'loading' | 'done' | 'error'; message?: string } = { phase: 'idle' };

  // ── Step 1: save name to localStorage + create project via API ──────────────
  async function handlePersonalizeNext() {
    if (!userName.trim()) {
      setPersonalizeError('Please tell me your name.');
      return;
    }
    if (!projectName.trim()) {
      setPersonalizeError('Project name is required.');
      return;
    }
    setPersonalizeLoading(true);
    setPersonalizeError(null);
    try {
      localStorage.setItem(USER_NAME_KEY, userName.trim());
      const project = await api.createProject({
        name: projectName.trim(),
        description: projectDesc.trim(),
      });
      setCreatedProjectId(project.id);
      setStep('project-setup');
    } catch (e) {
      setPersonalizeError(String(e));
    } finally {
      setPersonalizeLoading(false);
    }
  }

  // ── Step 2: validate selections, then go to provider step ─────────────────
  function handleProjectSetupNext() {
    if (!projectType) {
      setProjectSetupError('Please select a project type.');
      return;
    }
    if (hasGithub === null) {
      setProjectSetupError('Please answer the GitHub question.');
      return;
    }
    setProjectSetupError(null);
    const roles = buildDefaultRoles(projectType, hasGithub);
    setAgentRoles(roles);
    setStep('provider');
  }

  // ── Step 3: provider gate passed — advance to agents ──────────────────────
  async function loadGatewayStep(showSpinner = true) {
    if (showSpinner) setGatewayLoading(true);
    setGatewayError(null);
    setGatewaySuccess(null);
    try {
      const [config, status] = await Promise.all([
        api.getGatewayConfig(),
        api.getGatewayStatus(),
      ]);
      setGatewayWsUrl(config.ws_url);
      setGatewayRuntimeHint(config.runtime_hint);
      if (!isRemoteGatewayRuntime(config.runtime_hint)) {
        setLastLocalGatewayRuntimeHint(config.runtime_hint);
      }
      setGatewayAuthToken(config.auth_token ?? '');
      setGatewayStatus(status);
      setGatewayDetails(gatewayStatusDetails(status, isRemoteGatewayRuntime(config.runtime_hint)));
      setGatewayLoaded(true);
    } catch (err) {
      setGatewayError(err instanceof Error ? err.message : String(err));
    } finally {
      if (showSpinner) setGatewayLoading(false);
    }
  }

  async function persistGatewaySettings() {
    const config = await api.updateGatewayConfig({
      ws_url: gatewayWsUrl,
      runtime_hint: gatewayRuntimeHint,
      auth_token: gatewayAuthToken,
    });
    setGatewayWsUrl(config.ws_url);
    setGatewayRuntimeHint(config.runtime_hint);
    if (!isRemoteGatewayRuntime(config.runtime_hint)) {
      setLastLocalGatewayRuntimeHint(config.runtime_hint);
    }
    setGatewayAuthToken(config.auth_token ?? '');
    return config;
  }

  async function handleGatewaySave() {
    setGatewaySaving(true);
    setGatewayError(null);
    setGatewaySuccess(null);
    try {
      const config = await persistGatewaySettings();
      setGatewayWsUrl(config.ws_url);
      setGatewayRuntimeHint(config.runtime_hint);
      if (!isRemoteGatewayRuntime(config.runtime_hint)) {
        setLastLocalGatewayRuntimeHint(config.runtime_hint);
      }
      const status = await api.getGatewayStatus();
      setGatewayStatus(status);
      setGatewayDetails(gatewayStatusDetails(status, isRemoteGateway));
      setGatewaySuccess('Gateway settings saved.');
    } catch (err) {
      setGatewayError(err instanceof Error ? err.message : String(err));
    } finally {
      setGatewaySaving(false);
    }
  }

  async function handleGatewayCheck() {
    setGatewayChecking(true);
    setGatewayError(null);
    setGatewaySuccess(null);
    try {
      await persistGatewaySettings();
      const status = await api.getGatewayStatus();
      setGatewayStatus(status);
      setGatewayDetails(gatewayStatusDetails(status, isRemoteGateway));
      setGatewaySuccess(status.state === 'ready' ? 'Gateway is reachable.' : null);
    } catch (err) {
      setGatewayError(err instanceof Error ? err.message : String(err));
    } finally {
      setGatewayChecking(false);
    }
  }

  function handleGatewayNext() {
    if (gatewayStatus?.state !== 'ready') {
      setGatewayError(isRemoteGateway
        ? 'Approve the pending device request on the remote gateway, then re-check it here before continuing.'
        : 'Start OpenClaw and make sure the gateway shows Ready before continuing.');
      return;
    }
    setStep('agent');
  }

  function setGatewayLocation(mode: 'local' | 'remote') {
    if (mode === 'remote') {
      setGatewayRuntimeHint('external');
      return;
    }
    setGatewayRuntimeHint(lastLocalGatewayRuntimeHint);
  }

  function handleProviderGatePassed() {
    setStep('gateway');
  }

  useEffect(() => {
    if (step === 'gateway') {
      void loadGatewayStep(!gatewayLoaded);
    }
  }, [step]);

  function toggleRole(id: string) {
    setAgentRoles(prev =>
      prev.map(r => (r.id === id && !r.alwaysChecked ? { ...r, checked: !r.checked } : r))
    );
  }

  // ── Step 3: create project + provision agents with progress ──────────────
  async function handleCreateAgents() {
    const selected = agentRoles
      .filter(r => r.checked)
      .sort((a, b) => (a.id === 'atlas' ? -1 : b.id === 'atlas' ? 1 : 0));
    if (selected.length === 0) {
      setAgentError('Select at least one agent role.');
      return;
    }
    setAgentLoading(true);
    setAgentError(null);
    setProjectCreating(false);
    setProjectCreated(false);

    // Initialize progress state
    setProvisionProgress(
      selected.map(r => ({ roleId: r.id, label: r.label, status: 'pending' as const }))
    );

    try {
      const providerResponse = await api.getProviders();
      const connectedProviders = providerResponse.providers.filter((provider) => provider.status === 'connected');
      const preferredProvider = (connectedProviders[0]?.slug ?? null) as ProviderSlug | null;
      const preferredModel = getDefaultAgentModelForProvider(preferredProvider);
      if (!preferredProvider) {
        setAgentError('Connect at least one provider before creating agents.');
        return;
      }

      const existingAgents = await api.getAgents();
      const existingAtlas = findAtlasAgent(existingAgents);

      // The project was already created in step 1; just mark it done visually
      setProjectCreating(true);
      // Small delay for visual feedback
      await new Promise(r => setTimeout(r, 400));
      setProjectCreated(true);

      const successfulRoleIds = new Set<string>();

      // Create + provision each agent sequentially with progress
      for (let i = 0; i < selected.length; i++) {
        const role = selected[i];
        // Mark creating
        setProvisionProgress(prev =>
          prev.map(p => (p.roleId === role.id ? { ...p, status: 'creating' } : p))
        );

        try {
          let agent: Agent;

          if (role.id === 'atlas' && existingAtlas) {
            agent = await api.updateAgent(existingAtlas.id, {
              name: 'Atlas',
              role: role.desc,
              project_id: createdProjectId ?? undefined,
              preferred_provider: preferredProvider,
              model: preferredModel ?? undefined,
              system_role: 'atlas',
            });
          } else {
            agent = await api.createAgent({
              name: role.label,
              role: role.desc,
              project_id: createdProjectId ?? undefined,
              preferred_provider: preferredProvider,
              model: preferredModel ?? undefined,
              ...(role.id === 'atlas' ? { system_role: 'atlas' } : {}),
            } as Partial<Agent>);
          }

          // Mark provisioning
          setProvisionProgress(prev =>
            prev.map(p => (p.roleId === role.id ? { ...p, status: 'provisioning' } : p))
          );

          // Provision the agent (creates workspace, identity files, job template)
          try {
            await api.provisionAgent(agent.id, { restart_gateway: false });
          } catch (provisionError) {
            if (role.id === 'atlas') {
              throw provisionError;
            }
          }

          // Mark done
          setProvisionProgress(prev =>
            prev.map(p => (p.roleId === role.id ? { ...p, status: 'done' } : p))
          );
          successfulRoleIds.add(role.id);
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          setProvisionProgress(prev =>
            prev.map(p => (p.roleId === role.id ? { ...p, status: 'error', error: errorMessage } : p))
          );

          if (role.id === 'atlas') {
            setAgentError(`Atlas provisioning failed: ${errorMessage}`);
            return;
          }
        }
      }

      if (!successfulRoleIds.has('atlas')) {
        setAgentError('Atlas must be provisioned before setup can continue.');
        return;
      }

      // Brief pause to show completion
      await new Promise(r => setTimeout(r, 600));
      setStep('done');
    } catch (e) {
      setAgentError(String(e));
    } finally {
      setAgentLoading(false);
    }
  }

  async function handleFinish() {
    // Complete onboarding server-side (enforces provider gate)
    try {
      await api.completeOnboarding();
      setFinishError(null);
    } catch (err) {
      setFinishError(err instanceof Error ? err.message : String(err));
      return;
    }
    markOnboarded();
    beginGettingStartedGuide(0);
    onClose();
    router.push('/');
  }

  const displayName = userName.trim() || 'there';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-4 backdrop-blur-sm sm:items-center">
      <div className="relative max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-8 shadow-2xl">
        {/* Progress indicator */}
        <StepDots current={step} />

        {/* ══════════════════════════════════════════════════════════════════════
            STEP 1 — PERSONALIZATION
        ══════════════════════════════════════════════════════════════════════ */}
        {step === 'personalize' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold text-white leading-snug">
                  Hey — I&apos;m Atlas.
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-slate-400">
                  Set up your workspace and I&apos;ll handle the rest.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowPersonalizeIntro((value) => !value)}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
              >
                {showPersonalizeIntro ? 'Skip intro' : 'Show intro'}
              </button>
            </div>

            {showPersonalizeIntro && (
              <>
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-400/30 bg-amber-400/15">
                    <Sparkles className="h-5 w-5 text-amber-400" />
                  </div>
                  <div>
                    <p className="text-sm leading-relaxed text-slate-400">
                      I&apos;m your AI-powered headquarters for managing agents, tasks, and projects.
                      I coordinate the team so nothing falls through the cracks.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {[
                    { icon: Bot, color: 'text-blue-400', bg: 'bg-blue-400/10 border-blue-400/20', label: 'Agents', desc: 'AI workers that run your jobs' },
                    { icon: FolderOpen, color: 'text-amber-400', bg: 'bg-amber-400/10 border-amber-400/20', label: 'Projects', desc: 'Organise tasks + agents' },
                    { icon: CheckCircle2, color: 'text-green-400', bg: 'bg-green-400/10 border-green-400/20', label: 'Tasks', desc: 'Track progress end-to-end' },
                  ].map(({ icon: Icon, color, bg, label, desc }) => (
                    <div key={label} className={`rounded-xl border ${bg} p-3 flex flex-col gap-1.5`}>
                      <Icon className={`w-4 h-4 ${color}`} />
                      <p className="text-xs font-semibold text-white">{label}</p>
                      <p className="text-[11px] text-slate-500 leading-snug">{desc}</p>
                    </div>
                  ))}
                </div>

                <hr className="border-slate-700/60" />
              </>
            )}

            {/* User name */}
            <div className="space-y-4">
              <div>
                <label className="flex items-center gap-1.5 text-sm text-slate-300 mb-1.5">
                  <User className="w-3.5 h-3.5 text-slate-500" />
                  What should I call you?{' '}
                  <span className="text-red-400 ml-0.5">*</span>
                </label>
                <input
                  type="text"
                  value={userName}
                  onChange={e => setUserName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handlePersonalizeNext()}
                  placeholder="Your name"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                  autoFocus
                />
              </div>

              {/* Project */}
              <div>
                <label className="flex items-center gap-1.5 text-sm text-slate-300 mb-1.5">
                  <FolderOpen className="w-3.5 h-3.5 text-slate-500" />
                  What are we building together?{' '}
                  <span className="text-red-400 ml-0.5">*</span>
                </label>
                <input
                  type="text"
                  value={projectName}
                  onChange={e => setProjectName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handlePersonalizeNext()}
                  placeholder="Project name  (e.g. My Agency)"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                />
              </div>
              <div>
                <input
                  type="text"
                  value={projectDesc}
                  onChange={e => setProjectDesc(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handlePersonalizeNext()}
                  placeholder="Brief description  (optional)"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                />
              </div>

              {personalizeError && (
                <p className="text-sm text-red-400">{personalizeError}</p>
              )}
            </div>

            <button
              onClick={handlePersonalizeNext}
              disabled={personalizeLoading}
              className="w-full flex items-center justify-center gap-2 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-slate-900 font-semibold py-3 rounded-xl transition-colors"
            >
              {personalizeLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  Let&apos;s go <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            STEP 2 — PROJECT + TEAM SETUP
        ══════════════════════════════════════════════════════════════════════ */}
        {step === 'project-setup' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white mb-1">
                Tell me about{' '}
                <span className="text-amber-400">{projectName || 'your project'}</span>
              </h2>
              <p className="text-slate-400 text-sm leading-relaxed">
                A few quick answers let Atlas recommend the right agents for you.
              </p>
            </div>

            {/* Q1 — project type */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-300">
                What kind of project is this?
              </p>
              <div className="space-y-2">
                <SelectCard<ProjectType>
                  value="software"
                  selected={projectType}
                  onSelect={setProjectType}
                  icon={Code2}
                  iconColor="text-blue-400"
                  iconBg="bg-blue-400/10"
                  label="Software / Product"
                  desc="App, API, website, or technical system."
                />
                <SelectCard<ProjectType>
                  value="content"
                  selected={projectType}
                  onSelect={setProjectType}
                  icon={FileText}
                  iconColor="text-purple-400"
                  iconBg="bg-purple-400/10"
                  label="Content / Creative"
                  desc="Writing, marketing, media, or creative output."
                />
                <SelectCard<ProjectType>
                  value="business-ops"
                  selected={projectType}
                  onSelect={setProjectType}
                  icon={Briefcase}
                  iconColor="text-emerald-400"
                  iconBg="bg-emerald-400/10"
                  label="Business Operations"
                  desc="Workflows, automation, reporting, or internal tooling."
                />
              </div>
            </div>

            {/* Q2 — solo or team */}
            <div className="hidden">
              <p className="text-sm font-medium text-slate-300">
                Do you have a GitHub repo for this project?
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => undefined}
                  className={`flex items-center gap-2.5 p-3 rounded-xl border text-left transition-all ${
                    teamMode === 'solo'
                      ? 'border-amber-400 bg-amber-400/10 ring-1 ring-amber-400/30'
                      : 'border-slate-700 bg-slate-800/60 hover:border-slate-500'
                  }`}
                >
                  <UserCircle2 className={`w-5 h-5 shrink-0 ${teamMode === 'solo' ? 'text-amber-400' : 'text-slate-500'}`} />
                  <div>
                    <p className={`text-sm font-semibold ${teamMode === 'solo' ? 'text-amber-300' : 'text-white'}`}>Solo</p>
                    <p className="text-[11px] text-slate-500">Just me</p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => undefined}
                  className={`flex items-center gap-2.5 p-3 rounded-xl border text-left transition-all ${
                    teamMode === 'team'
                      ? 'border-amber-400 bg-amber-400/10 ring-1 ring-amber-400/30'
                      : 'border-slate-700 bg-slate-800/60 hover:border-slate-500'
                  }`}
                >
                  <Users className={`w-5 h-5 shrink-0 ${teamMode === 'team' ? 'text-amber-400' : 'text-slate-500'}`} />
                  <div>
                    <p className={`text-sm font-semibold ${teamMode === 'team' ? 'text-amber-300' : 'text-white'}`}>Team</p>
                    <p className="text-[11px] text-slate-500">Multiple people</p>
                  </div>
                </button>
              </div>
            </div>

            {/* Q3 — GitHub */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-300">
                Do you have a GitHub repo for this project?
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setHasGithub(true)}
                  className={`flex items-center gap-2.5 p-3 rounded-xl border text-left transition-all ${
                    hasGithub === true
                      ? 'border-amber-400 bg-amber-400/10 ring-1 ring-amber-400/30'
                      : 'border-slate-700 bg-slate-800/60 hover:border-slate-500'
                  }`}
                >
                  <Github className={`w-5 h-5 shrink-0 ${hasGithub === true ? 'text-amber-400' : 'text-slate-500'}`} />
                  <div>
                    <p className={`text-sm font-semibold ${hasGithub === true ? 'text-amber-300' : 'text-white'}`}>Yes</p>
                    <p className="text-[11px] text-slate-500">I have a repo</p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setHasGithub(false)}
                  className={`flex items-center gap-2.5 p-3 rounded-xl border text-left transition-all ${
                    hasGithub === false
                      ? 'border-amber-400 bg-amber-400/10 ring-1 ring-amber-400/30'
                      : 'border-slate-700 bg-slate-800/60 hover:border-slate-500'
                  }`}
                >
                  <X className={`w-5 h-5 shrink-0 ${hasGithub === false ? 'text-amber-400' : 'text-slate-500'}`} />
                  <div>
                    <p className={`text-sm font-semibold ${hasGithub === false ? 'text-amber-300' : 'text-white'}`}>Not yet</p>
                    <p className="text-[11px] text-slate-500">No repo / not sure</p>
                  </div>
                </button>
              </div>
            </div>

            {projectSetupError && (
              <p className="text-sm text-red-400">{projectSetupError}</p>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => setStep('personalize')}
                className="flex items-center gap-1.5 px-4 py-3 rounded-xl border border-slate-600 text-slate-300 hover:text-white hover:border-slate-500 text-sm font-medium transition-colors"
              >
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={handleProjectSetupNext}
                className="flex-1 flex items-center justify-center gap-2 bg-amber-400 hover:bg-amber-300 text-slate-900 font-semibold py-3 rounded-xl transition-colors"
              >
                See recommendations <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            STEP 3 — PROVIDER SETUP (gate: at least one connected provider)
        ══════════════════════════════════════════════════════════════════════ */}
        {step === 'provider' && (
          <ProviderSetupStep
            onGatePassed={handleProviderGatePassed}
            onBack={() => setStep('project-setup')}
          />
        )}

        {step === 'gateway' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold text-white mb-1">
                Connect OpenClaw
              </h2>
              <p className="text-slate-400 text-sm leading-relaxed">
                {isRemoteGateway
                  ? 'Agent HQ is pointed at a remote OpenClaw gateway. Re-check here to create the pending device request, approve it on the remote machine, then re-check again before continuing.'
                  : 'Agent HQ automatically checks the saved local gateway URL and token when this step opens. Start OpenClaw, then verify the gateway here before Agent HQ provisions anything against it.'}
              </p>
            </div>

            {gatewayError && (
              <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{gatewayError}</span>
              </div>
            )}

            {gatewaySuccess && (
              <div className="flex items-start gap-2 rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-300">
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{gatewaySuccess}</span>
              </div>
            )}

            <div className="grid gap-4">
              <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">Gateway connection</p>
                    <p className="text-xs text-slate-500 mt-1">
                      Agent HQ uses this WebSocket URL for Atlas and agent chat once the gateway is reachable.
                    </p>
                  </div>
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${gatewayTone.className}`}>
                    {gatewayTone.label}
                  </span>
                </div>

                <label className="block space-y-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Gateway location</span>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setGatewayLocation('local')}
                      className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        !isRemoteGateway
                          ? 'border-amber-400 bg-amber-500/10 text-amber-300'
                          : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500'
                      }`}
                    >
                      Local machine
                    </button>
                    <button
                      type="button"
                      onClick={() => setGatewayLocation('remote')}
                      className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        isRemoteGateway
                          ? 'border-amber-400 bg-amber-500/10 text-amber-300'
                          : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500'
                      }`}
                    >
                      Remote machine
                    </button>
                  </div>
                </label>

                <label className="block space-y-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Gateway URL</span>
                  <input
                    value={gatewayWsUrl}
                    onChange={(event) => setGatewayWsUrl(event.target.value)}
                    className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                    placeholder="wss://127.0.0.1:18789"
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Gateway Auth Token</span>
                  <input
                    type="password"
                    value={gatewayAuthToken}
                    onChange={(event) => setGatewayAuthToken(event.target.value)}
                    className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400 transition-colors"
                    placeholder="Paste the token from the dashboard URL if needed"
                  />
                  <p className="text-xs leading-5 text-slate-500">
                    {isRemoteGateway
                      ? 'Paste the remote gateway token here. If the check says the token does not match, run `openclaw dashboard --no-open` on the remote machine and copy the token from the URL.'
                      : 'Leave this alone unless the automatic check says the gateway token does not match.'}
                  </p>
                </label>

                {gatewayNeedsToken && (
                  <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-amber-300" />
                      <div>
                        <p className="text-sm font-semibold text-amber-200">Gateway token needed</p>
                        <p className="text-xs leading-5 text-amber-100/90">
                          The saved token did not match this OpenClaw gateway.
                        </p>
                      </div>
                    </div>
                    <pre className="overflow-x-auto rounded-lg border border-amber-400/30 bg-slate-950 p-3 text-xs leading-6 text-amber-100">
                      openclaw dashboard --no-open
                    </pre>
                    <p className="text-xs leading-5 text-amber-100/90">
                      Copy the token from the dashboard URL, paste it into the field above, then click Re-check gateway.
                    </p>
                  </div>
                )}

                {isRemoteGateway && (
                  <div className="rounded-xl border border-amber-400/30 bg-slate-900/80 p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-amber-400" />
                      <p className="text-sm font-semibold text-white">{gatewayRemoteGuide.title}</p>
                    </div>
                    <pre className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-950 p-4 text-xs leading-6 text-slate-200">
                      {gatewayRemoteGuide.lines.join('\n')}
                    </pre>
                    <p className="text-xs leading-5 text-slate-400">{gatewayRemoteGuide.note}</p>
                  </div>
                )}

                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={handleGatewaySave}
                    disabled={gatewaySaving || gatewayLoading}
                    className="inline-flex items-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-900 transition-colors hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {gatewaySaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Save settings
                  </button>
                  <button
                    type="button"
                    onClick={handleGatewayCheck}
                    disabled={gatewayChecking || gatewayLoading}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:border-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {gatewayChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    Re-check gateway
                  </button>
                </div>

                {gatewayDetails && (
                  <div className="rounded-lg border border-slate-700 bg-slate-900/80 p-3 text-xs leading-5 text-slate-400">
                    <div className="font-medium text-slate-300">Last check</div>
                    <div>{gatewayDetails}</div>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <TerminalSquare className="w-4 h-4 text-amber-400" />
                  <p className="text-sm font-semibold text-white">{gatewayGuide.title}</p>
                </div>
                <pre className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-950 p-4 text-xs leading-6 text-slate-200">
                  {gatewayGuide.lines.join('\n')}
                </pre>
                <p className="text-xs leading-5 text-slate-500">{gatewayGuide.note}</p>
                {gatewayLoading && (
                  <div className="flex items-center gap-2 text-sm text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Checking gateway connection...
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep('provider')}
                className="flex items-center gap-1.5 px-4 py-3 rounded-xl border border-slate-600 text-slate-300 hover:text-white hover:border-slate-500 text-sm font-medium transition-colors"
              >
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={handleGatewayNext}
                className="flex-1 flex items-center justify-center gap-2 bg-amber-400 hover:bg-amber-300 text-slate-900 font-semibold py-3 rounded-xl transition-colors"
              >
                Continue to agents <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            STEP 4 — SUMMARY + AGENT PROVISIONING
        ══════════════════════════════════════════════════════════════════════ */}
        {step === 'agent' && (
          <div className="space-y-6">
            {!agentLoading ? (
              /* ── Pre-confirm: summary + role selection ─────────────────────── */
              <>
                <div>
                  <h2 className="text-xl font-bold text-white mb-1">
                    Ready to launch 🚀
                  </h2>
                  <p className="text-slate-400 text-sm leading-relaxed">
                    Here&apos;s what we&apos;ll set up. Review and hit confirm to create everything.
                  </p>
                </div>

                {/* Summary card */}
                <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-amber-400" />
                    <span className="text-sm font-semibold text-white">{projectName || 'Untitled Project'}</span>
                    <span className="text-[10px] bg-green-500/15 text-green-400 border border-green-500/20 rounded px-1.5 py-0.5">
                      created
                    </span>
                  </div>
                  <div className="hidden">
                    <span className="text-slate-700">•</span>
                    <span>{projectType === 'software' ? 'Software' : projectType === 'content' ? 'Content' : 'Business Ops'}</span>
                    {hasGithub && (
                      <>
                        <span className="text-slate-700">•</span>
                        <Github className="w-3 h-3" />
                        <span>GitHub</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Agent roles */}
                <div className="space-y-2">
                  <p className="text-sm font-medium text-slate-300">Agents to provision:</p>
                  {agentRoles.map(role => {
                    const Icon = role.icon;
                    return (
                      <label
                        key={role.id}
                        className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-all ${
                          role.checked
                            ? 'border-slate-600 bg-slate-800/60'
                            : 'border-slate-700/60 bg-slate-800/30 opacity-60'
                        } ${role.alwaysChecked ? 'cursor-default' : 'hover:border-slate-500'}`}
                      >
                        <input
                          type="checkbox"
                          checked={role.checked}
                          disabled={role.alwaysChecked}
                          onChange={() => toggleRole(role.id)}
                          className="mt-0.5 w-4 h-4 rounded accent-amber-400 cursor-pointer disabled:cursor-default shrink-0"
                        />
                        <div className="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center shrink-0">
                          <Icon className="w-4 h-4 text-slate-300" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-white flex items-center gap-2">
                            {role.label}
                            {role.alwaysChecked && (
                              <span className="text-[10px] font-medium text-amber-400/70 bg-amber-400/10 border border-amber-400/20 rounded px-1.5 py-0.5">
                                required
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5 leading-snug">{role.desc}</p>
                        </div>
                      </label>
                    );
                  })}
                </div>

                {agentError && <p className="text-sm text-red-400">{agentError}</p>}

                <div className="flex gap-3">
                  <button
                    onClick={() => setStep('gateway')}
                    className="flex items-center gap-1.5 px-4 py-3 rounded-xl border border-slate-600 text-slate-300 hover:text-white hover:border-slate-500 text-sm font-medium transition-colors"
                  >
                    <ArrowLeft className="w-4 h-4" /> Back
                  </button>
                  <button
                    onClick={handleCreateAgents}
                    className="flex-1 flex items-center justify-center gap-2 bg-amber-400 hover:bg-amber-300 text-slate-900 font-semibold py-3 rounded-xl transition-colors"
                  >
                    <Rocket className="w-4 h-4" /> Confirm & set up
                  </button>
                </div>
              </>
            ) : (
              /* ── Provisioning in progress ──────────────────────────────────── */
              <>
                <div>
                  <h2 className="text-xl font-bold text-white mb-1">
                    Setting things up…
                  </h2>
                  <p className="text-slate-400 text-sm leading-relaxed">
                    Hang tight — Atlas is creating your project and provisioning agents.
                  </p>
                </div>

                <div className="space-y-3">
                  {/* Project row */}
                  <div className="flex items-center gap-3 p-3 rounded-xl border border-slate-700 bg-slate-800/40">
                    <div className="w-8 h-8 rounded-lg bg-amber-400/10 flex items-center justify-center shrink-0">
                      <FolderOpen className="w-4 h-4 text-amber-400" />
                    </div>
                    <span className="text-sm text-white font-medium flex-1">
                      {projectName || 'Project'}
                    </span>
                    {projectCreated ? (
                      <CheckCircle2 className="w-4 h-4 text-green-400" />
                    ) : projectCreating ? (
                      <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
                    ) : (
                      <div className="w-4 h-4 rounded-full border border-slate-600" />
                    )}
                  </div>

                  {/* Agent rows */}
                  {provisionProgress.map(p => {
                    const role = agentRoles.find(r => r.id === p.roleId);
                    const Icon = role?.icon ?? Bot;
                    return (
                      <div
                        key={p.roleId}
                        className="flex items-center gap-3 p-3 rounded-xl border border-slate-700 bg-slate-800/40"
                      >
                        <div className="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center shrink-0">
                          <Icon className="w-4 h-4 text-slate-300" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white font-medium">{p.label}</p>
                          <p className="text-[11px] text-slate-500">
                            {p.status === 'pending' && 'Waiting…'}
                            {p.status === 'creating' && 'Creating agent…'}
                            {p.status === 'provisioning' && 'Provisioning workspace…'}
                            {p.status === 'done' && 'Ready'}
                            {p.status === 'error' && (p.error || 'Failed')}
                          </p>
                        </div>
                        {p.status === 'done' ? (
                          <CheckCircle2 className="w-4 h-4 text-green-400" />
                        ) : p.status === 'error' ? (
                          <X className="w-4 h-4 text-red-400" />
                        ) : p.status === 'creating' || p.status === 'provisioning' ? (
                          <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
                        ) : (
                          <div className="w-4 h-4 rounded-full border border-slate-600" />
                        )}
                      </div>
                    );
                  })}

                  {gatewayRestartState.phase !== 'idle' && (
                    <div className="flex items-center gap-3 p-3 rounded-xl border border-slate-700 bg-slate-800/40">
                      <div className="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center shrink-0">
                        <ServerCog className="w-4 h-4 text-slate-300" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white font-medium">OpenClaw Gateway</p>
                        <p className="text-[11px] text-slate-500">
                          {gatewayRestartState.phase === 'loading' && 'Restarting gateway once for all agents…'}
                          {gatewayRestartState.phase === 'done' && 'Ready'}
                          {gatewayRestartState.phase === 'error' && (gatewayRestartState.message || 'Restart failed')}
                        </p>
                      </div>
                      {gatewayRestartState.phase === 'done' ? (
                        <CheckCircle2 className="w-4 h-4 text-green-400" />
                      ) : gatewayRestartState.phase === 'error' ? (
                        <X className="w-4 h-4 text-red-400" />
                      ) : (
                        <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
                      )}
                    </div>
                  )}
                </div>

                {agentError && <p className="text-sm text-red-400 mt-2">{agentError}</p>}
              </>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            STEP 4 — DONE
        ══════════════════════════════════════════════════════════════════════ */}
        {step === 'done' && (
          <div className="space-y-6 text-center">
            {/* Celebratory header */}
            <div className="flex justify-center">
              <div className="relative">
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-amber-400/20 to-green-500/20 border border-green-500/40 flex items-center justify-center">
                  <Sparkles className="w-10 h-10 text-amber-400" />
                </div>
                <div className="absolute -top-1 -right-1 w-7 h-7 rounded-full bg-green-500 border-2 border-slate-900 flex items-center justify-center">
                  <CheckCircle2 className="w-4 h-4 text-white" />
                </div>
              </div>
            </div>
            <div>
              <h2 className="text-2xl font-bold text-white mb-2">
                You&apos;re all set{userName.trim() ? `, ${userName.trim()}` : ''}! 🎉
              </h2>
              <p className="text-slate-400 text-sm leading-relaxed max-w-sm mx-auto">
                Your project is live and your agents are ready to work. Head to the
                Task Board to create your first task and start dispatching.
              </p>
            </div>

            {/* Quick recap */}
            <div className="rounded-xl border border-slate-700/60 bg-slate-800/30 p-4 text-left space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                <span className="text-slate-300">
                  Project <span className="text-white font-medium">{projectName}</span> created
                </span>
              </div>
              {provisionProgress
                .filter(progress => progress.status === 'done')
                .map(progress => {
                  const role = agentRoles.find(r => r.id === progress.roleId);
                  if (!role) return null;
                  return (
                    <div key={role.id} className="flex items-center gap-2 text-sm">
                      <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                      <span className="text-slate-300">
                        <span className="text-white font-medium">{role.label}</span> provisioned
                      </span>
                    </div>
                  );
                })}
            </div>

            <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4 text-left">
              <p className="text-sm font-medium text-green-200">Your runtime is ready</p>
              <p className="mt-1 text-sm leading-relaxed text-green-100/90">
                Your agents were provisioned and OpenClaw picked up the new configuration automatically.
              </p>
            </div>

            {finishError && <p className="text-sm text-red-400">{finishError}</p>}

            <button
              onClick={handleFinish}
              className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 text-slate-900 font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-amber-400/20"
            >
              Go to Task Board <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
